// Yjs sync rooms over WebSocket: each room is one shared Y.Doc that every
// connected browser edits. Speaks the standard y-websocket protocol, so the
// stock `y-websocket` client connects to it directly.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
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

export const ROOM_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export class RoomManager {
  /** @param {{ dataDir?: string|null, saveDelayMs?: number, idleCloseMs?: number }} opts */
  constructor({ dataDir = null, saveDelayMs = 1000, idleCloseMs = 30_000 } = {}) {
    this.dataDir = dataDir;
    this.saveDelayMs = saveDelayMs;
    this.idleCloseMs = idleCloseMs;
    this.rooms = new Map(); // name -> Promise<Room>
  }

  get(name) {
    if (!this.rooms.has(name)) this.rooms.set(name, this.open(name));
    return this.rooms.get(name);
  }

  async open(name) {
    const room = new Room(name, this);
    if (this.dataDir) {
      try {
        Y.applyUpdate(room.doc, await readFile(this.file(name)), 'disk');
      } catch (err) {
        if (err.code !== 'ENOENT') console.error(`room ${name}: could not load`, err);
      }
    }
    // New rooms start with a starter beat. Seeding here, on the server, means
    // two people opening a fresh link at once can't both seed it.
    seedProject(room.doc);
    room.listen();
    return room;
  }

  file(name) {
    return join(this.dataDir, `${name}.ydoc`);
  }

  async save(room) {
    if (!this.dataDir) return;
    await mkdir(this.dataDir, { recursive: true });
    const tmp = `${this.file(room.name)}.tmp`;
    await writeFile(tmp, Y.encodeStateAsUpdate(room.doc));
    await rename(tmp, this.file(room.name));
  }

  /** Handle one WebSocket connection for `name`. */
  async connect(ws, name) {
    // The client starts talking immediately; hold its messages while the
    // room loads from disk so the opening sync request isn't lost.
    const early = [];
    const hold = (data) => early.push(data);
    ws.on('message', hold);
    const room = await this.get(name);
    ws.off('message', hold);
    if (ws.readyState !== 1) return; // gave up while we were loading
    room.add(ws);
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
    this.conns = new Map(); // ws -> Set of awareness client ids it controls
    this.saveTimer = null;
    this.idleTimer = null;
  }

  listen() {
    this.doc.on('update', (update) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.broadcast(encoding.toUint8Array(encoder));
      this.scheduleSave();
    });
    this.awareness.on('update', ({ added, updated, removed }, origin) => {
      const ids = this.conns.get(origin);
      if (ids) {
        for (const id of added) ids.add(id);
        for (const id of removed) ids.delete(id);
      }
      const changed = [...added, ...updated, ...removed];
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_AWARENESS);
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
      this.broadcast(encoding.toUint8Array(encoder));
    });
  }

  add(ws) {
    clearTimeout(this.idleTimer);
    this.conns.set(ws, new Set());
    ws.binaryType = 'arraybuffer';
    ws.on('message', (data) => this.onMessage(ws, data));
    ws.on('close', () => this.remove(ws));
    ws.on('error', () => this.remove(ws));

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
      }
    } catch (err) {
      console.error(`room ${this.name}: bad message`, err.message);
      ws.close(1003, 'bad message');
    }
  }

  sendAwareness(ws) {
    const states = this.awareness.getStates();
    if (!states.size) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_AWARENESS);
    encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...states.keys()]));
    this.send(ws, encoding.toUint8Array(encoder));
  }

  remove(ws) {
    const ids = this.conns.get(ws);
    if (!ids) return;
    clearInterval(ws.pingTimer);
    this.conns.delete(ws);
    // Their cursor and name disappear for everyone else.
    awarenessProtocol.removeAwarenessStates(this.awareness, [...ids], null);
    if (this.conns.size === 0) {
      this.idleTimer = setTimeout(() => this.close(), this.manager.idleCloseMs).unref();
    }
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
    }
    await this.save();
    if (this.conns.size === 0) {
      this.manager.rooms.delete(this.name);
      this.doc.destroy(); // also stops the awareness heartbeat
    }
  }
}
