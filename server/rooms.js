// Yjs sync rooms over WebSocket: each room is one shared Y.Doc that every
// connected browser edits. Speaks the standard y-websocket protocol, so the
// stock `y-websocket` client connects to it directly.
//
// On top of that, each room has a chat. It uses its own message type on the
// same socket (MSG_CHAT), so whoever is in the room is in the chat. The server
// writes each message's author from the signed-in account, never from what
// the client says. A client only gets chat messages after it says hello, so
// plain y-websocket clients never see a message type they don't know.
//
// Events (RoomManager is an EventEmitter):
//   'visit' (room, user)  a person opened a connection (every time, even a reconnect)
//   'join'  (room, user)  a person's first connection to the room opened
//   'leave' (room, user)  their last one closed (after a short grace period,
//                         so a dropped connection that comes right back isn't a leave)
//   'saved' (room, { edited })  the room was written to disk

import { EventEmitter } from 'node:events';
import { readFile, writeFile, rename, mkdir, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { seedProject } from '../src/shared/schema.js';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const MSG_QUERY_AWARENESS = 3;
export const MSG_CHAT = 100; // coprod's own: room chat, JSON both ways

export const ROOM_NAME = /^[A-Za-z0-9_-]{1,64}$/;
export const CHAT_KEEP = 300; // messages kept per room
export const CHAT_MAX = 1000; // characters per message

/** How a person appears to others in the room: in presence and on chat messages. */
export const badge = (u) => ({ id: u.id, name: u.name, username: u.username, color: u.color, ...(u.guest ? { guest: true } : {}) });

export function cleanChat(text) {
  const t = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\p{Cc}‪-‮⁦-⁩]/gu, (c) => (c === '\n' ? c : ''))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return [...t].slice(0, CHAT_MAX).join('');
}

export class RoomManager extends EventEmitter {
  /** @param {{ dataDir?: string|null, saveDelayMs?: number, idleCloseMs?: number, leaveGraceMs?: number }} opts */
  constructor({ dataDir = null, saveDelayMs = 1000, idleCloseMs = 30_000, leaveGraceMs = 4000 } = {}) {
    super();
    this.dataDir = dataDir;
    this.saveDelayMs = saveDelayMs;
    this.idleCloseMs = idleCloseMs;
    this.leaveGraceMs = leaveGraceMs;
    this.rooms = new Map(); // name -> Promise<Room>
    this.open_ = new Map(); // name -> Room, once loaded
  }

  get(name) {
    if (!this.rooms.has(name)) this.rooms.set(name, this.open(name));
    return this.rooms.get(name);
  }

  async open(name, initial = null) {
    const room = new Room(name, this);
    if (initial) Y.applyUpdate(room.doc, initial, 'disk');
    else if (this.dataDir) {
      try {
        Y.applyUpdate(room.doc, await readFile(this.file(name)), 'disk');
      } catch (err) {
        if (err.code !== 'ENOENT') console.error(`room ${name}: could not load`, err);
      }
      try {
        const chat = JSON.parse(await readFile(this.chatFile(name), 'utf8'));
        if (Array.isArray(chat)) room.chat = chat.slice(-CHAT_KEEP);
      } catch (err) {
        if (err.code !== 'ENOENT') console.error(`room ${name}: could not load chat`, err.message);
      }
    }
    // New rooms start with a starter beat. Seeding here, on the server, means
    // two people opening a fresh link at once can't both seed it.
    seedProject(room.doc);
    room.listen();
    this.open_.set(name, room);
    return room;
  }

  /** A new room holding `update` (an imported project). Refuses a name that's in use. */
  async create(name, update) {
    if (await this.exists(name)) throw Object.assign(new Error('That project already exists'), { status: 409 });
    const p = this.open(name, update);
    this.rooms.set(name, p);
    const room = await p;
    await room.save();
    room.armIdle(); // closes again if nobody comes
    return room;
  }

  async exists(name) {
    if (this.rooms.has(name)) return true;
    if (!this.dataDir) return false;
    try {
      await stat(this.file(name));
      return true;
    } catch {
      return false;
    }
  }

  /** The room's whole document as one Yjs update, or null if there's no such room. */
  async encode(name) {
    if (this.rooms.has(name)) return Y.encodeStateAsUpdate((await this.rooms.get(name)).doc);
    if (!this.dataDir) return null;
    try {
      return new Uint8Array(await readFile(this.file(name)));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  /** People connected to a room right now (empty if it isn't open). */
  peopleIn(name) {
    return [...(this.open_.get(name)?.people.values() ?? [])].filter((p) => p.count > 0).map((p) => p.user);
  }

  /** The title of an open room, else null. */
  titleOf(name) {
    return this.open_.get(name)?.title ?? null;
  }

  file(name) {
    return join(this.dataDir, `${name}.ydoc`);
  }

  chatFile(name) {
    return join(this.dataDir, `${name}.chat.json`);
  }

  async save(room) {
    if (!this.dataDir) return;
    await mkdir(this.dataDir, { recursive: true });
    const write = async (file, data) => {
      await writeFile(`${file}.tmp`, data);
      await rename(`${file}.tmp`, file);
    };
    await write(this.file(room.name), Y.encodeStateAsUpdate(room.doc));
    if (room.chatDirty) {
      room.chatDirty = false;
      await write(this.chatFile(room.name), JSON.stringify(room.chat));
    }
  }

  /** Handle one WebSocket connection for `name`, from the signed-in `user`. */
  async connect(ws, name, user = null) {
    // The client starts talking immediately; hold its messages while the
    // room loads from disk so the opening sync request isn't lost.
    const early = [];
    const hold = (data) => early.push(data);
    ws.on('message', hold);
    const room = await this.get(name);
    ws.off('message', hold);
    if (ws.readyState !== 1) return; // gave up while we were loading
    room.add(ws, user);
    for (const data of early) room.onMessage(ws, data);
  }

  /** Server shutdown: save every room and free it, connected or not. */
  async closeAll() {
    for (const p of this.rooms.values()) {
      const room = await p;
      await room.close({ force: true });
    }
    this.rooms.clear();
  }
}

class Room {
  constructor(name, manager) {
    this.name = name;
    this.manager = manager;
    this.doc = new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.awareness.setLocalState(null); // the server itself isn't a participant
    this.conns = new Map(); // ws -> { ids: Set of awareness client ids it controls, user, chat: bool }
    this.people = new Map(); // userId -> { user, count: open connections, leaving: timer, said: [times] }
    this.chat = []; // [{ id, at, user, text }], oldest first
    this.chatDirty = false;
    this.edited = false;
    this.saveTimer = null;
    this.idleTimer = null;
  }

  get title() {
    return this.doc.getMap('meta').get('title') ?? 'Untitled jam';
  }

  listen() {
    this.doc.on('update', (update) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.broadcast(encoding.toUint8Array(encoder));
      this.edited = true;
      this.scheduleSave();
    });
    this.awareness.on('update', ({ added, updated, removed }, origin) => {
      const conn = this.conns.get(origin);
      if (conn) {
        for (const id of added) conn.ids.add(id);
        for (const id of removed) conn.ids.delete(id);
        // You are who you signed in as: whatever name a client puts in its
        // presence, everyone else sees its account.
        if (conn.user) {
          for (const id of [...added, ...updated]) {
            const state = this.awareness.getStates().get(id);
            if (state) state.user = badge(conn.user);
          }
        }
      }
      const changed = [...added, ...updated, ...removed];
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_AWARENESS);
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
      this.broadcast(encoding.toUint8Array(encoder));
    });
  }

  add(ws, user) {
    clearTimeout(this.idleTimer);
    this.conns.set(ws, { ids: new Set(), user, chat: false });
    ws.binaryType = 'arraybuffer';
    ws.on('message', (data) => this.onMessage(ws, data));
    ws.on('close', () => this.remove(ws));
    ws.on('error', () => this.remove(ws));
    if (user) {
      this.manager.emit('visit', this, user);
      this.arrive(user);
    }

    // Keep idle connections alive through proxies and notice dead ones.
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    ws.pingTimer = setInterval(() => {
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    }, 30_000).unref();

    // Start the handshake: send our state vector so the client sends what we lack.
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);
    syncProtocol.writeSyncStep1(encoder, this.doc);
    this.send(ws, encoding.toUint8Array(encoder));
    this.sendAwareness(ws);
  }

  arrive(user) {
    const p = this.people.get(user.id);
    if (p) {
      p.count++;
      clearTimeout(p.leaving); // back within the grace period: they never left
      p.leaving = null;
      return;
    }
    this.people.set(user.id, { user, count: 1, leaving: null, said: [] });
    this.notice('join', user);
    this.manager.emit('join', this, user);
  }

  depart(user) {
    const p = this.people.get(user.id);
    if (!p || --p.count > 0) return;
    p.leaving = setTimeout(() => this.gone(user.id), this.manager.leaveGraceMs).unref();
  }

  gone(id) {
    const p = this.people.get(id);
    if (!p || p.count > 0) return;
    clearTimeout(p.leaving);
    this.people.delete(id);
    this.notice('leave', p.user);
    this.manager.emit('leave', this, p.user);
  }

  onMessage(ws, data) {
    try {
      const decoder = decoding.createDecoder(new Uint8Array(data));
      const encoder = encoding.createEncoder();
      switch (decoding.readVarUint(decoder)) {
        case MSG_SYNC:
          encoding.writeVarUint(encoder, MSG_SYNC);
          syncProtocol.readSyncMessage(decoder, encoder, this.doc, ws);
          if (encoding.length(encoder) > 1) this.send(ws, encoding.toUint8Array(encoder));
          break;
        case MSG_AWARENESS:
          awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), ws);
          break;
        case MSG_QUERY_AWARENESS:
          this.sendAwareness(ws);
          break;
        case MSG_CHAT:
          this.onChat(ws, JSON.parse(decoding.readVarString(decoder)));
          break;
      }
    } catch (err) {
      console.error(`room ${this.name}: bad message`, err.message);
      ws.close(1003, 'bad message');
    }
  }

  // ---------------------------------------------------------------- chat

  onChat(ws, msg) {
    const conn = this.conns.get(ws);
    if (!conn?.user || !msg || typeof msg !== 'object') return;
    if (msg.type === 'hello') {
      conn.chat = true;
      this.sendChat(ws, { type: 'history', messages: this.chat });
    } else if (msg.type === 'say') {
      const text = cleanChat(msg.text);
      if (!text) return;
      const p = this.people.get(conn.user.id);
      const now = Date.now();
      p.said = p.said.filter((t) => now - t < 10_000);
      if (p.said.length >= 8) return this.sendChat(ws, { type: 'error', error: 'Slow down a little: at most 8 messages in 10 seconds' });
      p.said.push(now);
      const message = { id: randomBytes(8).toString('hex'), at: now, user: badge(conn.user), text };
      this.chat.push(message);
      if (this.chat.length > CHAT_KEEP) this.chat.splice(0, this.chat.length - CHAT_KEEP);
      this.chatDirty = true;
      this.scheduleSave();
      this.broadcastChat({ type: 'message', message });
    }
  }

  /** "Ana joined" / "Ana left": shown live, not kept in the history. */
  notice(kind, user) {
    this.broadcastChat({ type: 'notice', notice: { kind, at: Date.now(), user: badge(user) } });
  }

  sendChat(ws, msg) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_CHAT);
    encoding.writeVarString(encoder, JSON.stringify(msg));
    this.send(ws, encoding.toUint8Array(encoder));
  }

  broadcastChat(msg) {
    for (const [ws, conn] of this.conns) if (conn.chat) this.sendChat(ws, msg);
  }

  // ---------------------------------------------------------------- plumbing

  sendAwareness(ws) {
    const states = this.awareness.getStates();
    if (!states.size) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_AWARENESS);
    encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...states.keys()]));
    this.send(ws, encoding.toUint8Array(encoder));
  }

  remove(ws) {
    const conn = this.conns.get(ws);
    if (!conn) return;
    clearInterval(ws.pingTimer);
    this.conns.delete(ws);
    // Their cursor and name disappear for everyone else.
    awarenessProtocol.removeAwarenessStates(this.awareness, [...conn.ids], null);
    if (conn.user) this.depart(conn.user);
    if (this.conns.size === 0) this.armIdle();
  }

  armIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), this.manager.idleCloseMs).unref();
  }

  send(ws, msg) {
    if (ws.readyState !== 1) return this.remove(ws);
    ws.send(msg, (err) => err && this.remove(ws));
  }

  broadcast(msg) {
    for (const ws of this.conns.keys()) this.send(ws, msg);
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), this.manager.saveDelayMs).unref();
  }

  async save() {
    clearTimeout(this.saveTimer);
    try {
      await this.manager.save(this);
      this.manager.emit('saved', this, { edited: this.edited });
      this.edited = false;
    } catch (err) {
      console.error(`room ${this.name}: save failed`, err);
    }
  }

  /** Save and drop from memory once nobody is connected (or on shutdown). */
  async close({ force = false } = {}) {
    clearTimeout(this.idleTimer);
    if (force) {
      for (const ws of this.conns.keys()) {
        clearInterval(ws.pingTimer);
        ws.terminate();
      }
      this.conns.clear();
      for (const p of this.people.values()) p.count = 0;
    }
    await this.save();
    if (this.conns.size === 0) {
      for (const id of [...this.people.keys()]) this.gone(id);
      this.manager.rooms.delete(this.name);
      this.manager.open_.delete(this.name);
      this.doc.destroy(); // also stops the awareness heartbeat
    }
  }
}
