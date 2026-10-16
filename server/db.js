// Accounts, sign-in sessions, friends, and each person's list of projects.
//
// Everything is kept in memory and written to one JSON file
// (<dataDir>/coprod.json) shortly after each change: first to a temp file,
// then renamed over the old one, so a crash never leaves half a file. That's
// plenty for a few thousand people; past that, put a real database behind
// these same methods.
//
// The project documents themselves aren't here: they stay in rooms/<id>.ydoc.
// This only records who has been in which project, so it can be listed.
//
// Guests are accounts too (guest: true, no password), so the server can still
// say who wrote each chat message. A guest who signs out, or whose session
// runs out, is gone for good: pruneGuests() removes them.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const DAY = 86_400_000;
export const SESSION_DAYS = 30;

const fail = (status, message, field) => Object.assign(new Error(message), { status, field });
export const hashToken = (token) => createHash('sha256').update(String(token)).digest('base64url');
const newId = (prefix) => `${prefix}${randomBytes(9).toString('base64url').replace(/[-_]/g, 'x')}`;

/** What anyone signed in may see about a person. */
export const publicUser = (u) =>
  u && { id: u.id, username: u.username, name: u.name, color: u.color, bio: u.bio, created: u.created, ...(u.guest ? { guest: true } : {}) };
/** What a person sees about themselves (the same, for now; private details like billing would go here). */
export const privateUser = (u) => u && publicUser(u);

export class Db {
  /** @param {string|null} file  null keeps everything in memory (tests). */
  constructor(file = null, { saveDelayMs = 200 } = {}) {
    this.file = file;
    this.saveDelayMs = saveDelayMs;
    this.users = new Map(); // id -> { id, username, name, color, bio, pass (null for guests), guest?, created, seen }
    this.byUsername = new Map();
    this.sessions = new Map(); // sha256(token) -> { user, created, expires }; the token itself is never stored
    this.friends = new Map(); // userId -> Map(friendId -> since), kept both ways
    this.requests = new Map(); // to -> Map(from -> at)
    this.projects = new Map(); // room -> { id, title, owner, created, updated, members: Map(userId -> { joined, opened, hidden? }) }
    this.timer = null;
    this.writing = Promise.resolve();
  }

  static async open(file, opts) {
    const db = new Db(file, opts);
    if (file) {
      let text = null;
      try {
        text = await readFile(file, 'utf8');
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      // A damaged file stops the server instead of being overwritten with an empty one.
      if (text !== null) db.load(JSON.parse(text));
    }
    db.pruneGuests();
    return db;
  }

  load(data) {
    const now = Date.now();
    for (const u of data.users ?? []) {
      delete u.email; // accounts from before sign-in went username-only
      this.index(u);
    }
    for (const [hash, s] of data.sessions ?? []) if (s.expires > now && this.users.has(s.user)) this.sessions.set(hash, s);
    for (const [a, b, since] of data.friends ?? []) this.link(a, b, since);
    for (const [from, to, at] of data.requests ?? []) this.inbox(to).set(from, at);
    for (const p of data.projects ?? []) this.projects.set(p.id, { ...p, members: new Map(p.members) });
  }

  toJSON() {
    const friends = [];
    for (const [a, m] of this.friends) for (const [b, since] of m) if (a < b) friends.push([a, b, since]);
    const requests = [];
    for (const [to, m] of this.requests) for (const [from, at] of m) requests.push([from, to, at]);
    return {
      version: 1,
      users: [...this.users.values()],
      sessions: [...this.sessions],
      friends,
      requests,
      projects: [...this.projects.values()].map((p) => ({ ...p, members: [...p.members] })),
    };
  }

  changed() {
    if (!this.file) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.saveDelayMs).unref();
  }

  /** Write now (one write at a time; each writes the latest state). */
  flush() {
    clearTimeout(this.timer);
    if (!this.file) return Promise.resolve();
    this.writing = this.writing.then(async () => {
      try {
        await mkdir(dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        await writeFile(tmp, JSON.stringify(this.toJSON()));
        await rename(tmp, this.file);
      } catch (err) {
        console.error('accounts: save failed', err);
      }
    });
    return this.writing;
  }

  // ---------------------------------------------------------------- users

  index(u) {
    this.users.set(u.id, u);
    this.byUsername.set(u.username, u.id);
  }

  user(id) {
    return this.users.get(id) ?? null;
  }

  userByUsername(username) {
    return this.user(this.byUsername.get(username));
  }

  createUser({ username, name, color, pass, guest = false }) {
    if (this.byUsername.has(username)) throw fail(409, 'That username is taken', 'username');
    const now = Date.now();
    const u = { id: newId('u'), username, name, color, bio: '', pass, created: now, seen: now, ...(guest ? { guest: true } : {}) };
    this.index(u);
    this.changed();
    return u;
  }

  /** A guest account: a "guest_xxxxxx" username and no password. */
  createGuest({ name, color }) {
    let username;
    do username = `guest_${randomBytes(6).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6).padEnd(6, '0')}`;
    while (this.byUsername.has(username));
    return this.createUser({ username, name, color, pass: null, guest: true });
  }

  /** A guest picks a username and password and becomes a full account, keeping their projects. */
  upgradeGuest(id, { username, pass, name }) {
    const u = this.users.get(id);
    if (!u?.guest) throw fail(400, 'You already have an account');
    if (this.byUsername.has(username)) throw fail(409, 'That username is taken', 'username');
    this.byUsername.delete(u.username);
    this.byUsername.set(username, id);
    Object.assign(u, { username, pass, created: Date.now() }, name ? { name } : {});
    delete u.guest;
    this.changed();
    return u;
  }

  /** Remove an account and every trace of it: sessions, friends, requests, project memberships. */
  deleteUser(id) {
    const u = this.users.get(id);
    if (!u) return;
    this.users.delete(id);
    this.byUsername.delete(u.username);
    for (const [hash, s] of this.sessions) if (s.user === id) this.sessions.delete(hash);
    for (const friend of this.friendIds(id)) this.friends.get(friend)?.delete(id);
    this.friends.delete(id);
    this.requests.delete(id);
    for (const inbox of this.requests.values()) inbox.delete(id);
    for (const [room, p] of this.projects) {
      p.members.delete(id);
      if (!p.members.size) this.projects.delete(room); // (the room itself stays on disk; its link still works)
    }
    this.changed();
  }

  /** Drop expired sessions, then guests with no session left (nobody can ever sign in as them again). */
  pruneGuests(now = Date.now()) {
    for (const [hash, s] of this.sessions) if (s.expires <= now) this.sessions.delete(hash);
    const signedIn = new Set([...this.sessions.values()].map((s) => s.user));
    let removed = 0;
    for (const u of [...this.users.values()]) {
      if (u.guest && !signedIn.has(u.id)) {
        this.deleteUser(u.id);
        removed++;
      }
    }
    return removed;
  }

  /** Changes the user object in place, so anyone holding it (open connections) sees the change. */
  updateUser(id, patch) {
    const u = this.users.get(id);
    if (!u) throw fail(404, 'No such account');
    if (patch.username && patch.username !== u.username) {
      if (this.byUsername.has(patch.username)) throw fail(409, 'That username is taken', 'username');
      this.byUsername.delete(u.username);
      this.byUsername.set(patch.username, id);
    }
    Object.assign(u, patch);
    this.changed();
    return u;
  }

  /** Up to `limit` people (not guests) whose username, name, or a word of their name starts with `q`. */
  search(q, { limit = 8, except = null } = {}) {
    q = String(q).trim().toLowerCase().replace(/^@/, '');
    if (q.length < 2) return [];
    const out = [];
    for (const u of this.users.values()) {
      if (u.id === except || u.guest) continue;
      const words = u.name.toLowerCase().split(/\s+/);
      if (u.username.startsWith(q) || u.name.toLowerCase().startsWith(q) || words.some((w) => w.startsWith(q))) out.push(u);
    }
    // Exact username first, then shorter (closer) usernames.
    out.sort((a, b) => (b.username === q) - (a.username === q) || a.username.length - b.username.length || (a.username < b.username ? -1 : 1));
    return out.slice(0, limit);
  }

  // ---------------------------------------------------------------- sessions

  createSession(userId) {
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    this.sessions.set(hashToken(token), { user: userId, created: now, expires: now + SESSION_DAYS * DAY });
    this.changed();
    return token;
  }

  /** The signed-in user for a session token, or null. Sessions renew as they're used (at most one write a day). */
  sessionUser(token) {
    if (!token) return null;
    const hash = hashToken(token);
    const s = this.sessions.get(hash);
    if (!s) return null;
    const now = Date.now();
    if (s.expires <= now || !this.users.has(s.user)) {
      this.sessions.delete(hash);
      this.changed();
      return null;
    }
    if (s.expires - now < (SESSION_DAYS - 1) * DAY) {
      s.expires = now + SESSION_DAYS * DAY;
      this.changed();
    }
    return this.users.get(s.user);
  }

  endSession(token) {
    if (token && this.sessions.delete(hashToken(token))) this.changed();
  }

  /** Sign a person out everywhere, except (optionally) the session `keep`. */
  endSessions(userId, { keep = null } = {}) {
    const keepHash = keep && hashToken(keep);
    for (const [hash, s] of this.sessions) if (s.user === userId && hash !== keepHash) this.sessions.delete(hash);
    this.changed();
  }

  // ---------------------------------------------------------------- friends

  inbox(to) {
    if (!this.requests.has(to)) this.requests.set(to, new Map());
    return this.requests.get(to);
  }

  link(a, b, since = Date.now()) {
    for (const [x, y] of [[a, b], [b, a]]) {
      if (!this.friends.has(x)) this.friends.set(x, new Map());
      this.friends.get(x).set(y, since);
    }
  }

  /** How `b` relates to `a`: 'self', 'friends', 'requested' (a asked b), 'incoming' (b asked a) or 'none'. */
  relation(a, b) {
    if (a === b) return 'self';
    if (this.friends.get(a)?.has(b)) return 'friends';
    if (this.requests.get(b)?.has(a)) return 'requested';
    if (this.requests.get(a)?.has(b)) return 'incoming';
    return 'none';
  }

  friendsSince(a, b) {
    return this.friends.get(a)?.get(b) ?? null;
  }

  /** Ask to be friends. If they had already asked you, you're now friends. Returns the new relation. */
  request(from, to) {
    if (!this.users.has(to)) throw fail(404, 'No such person');
    const rel = this.relation(from, to);
    if (rel === 'self') throw fail(400, 'That’s you');
    if (rel === 'incoming') return this.accept(from, to);
    if (rel === 'none') {
      this.inbox(to).set(from, Date.now());
      this.changed();
    }
    return this.relation(from, to);
  }

  accept(me, from) {
    if (!this.requests.get(me)?.delete(from)) throw fail(404, 'There’s no friend request from them');
    this.link(me, from);
    this.changed();
    return 'friends';
  }

  /** Unfriend, cancel a request you sent, or decline one you got: whatever is between you ends. */
  unlink(a, b) {
    this.friends.get(a)?.delete(b);
    this.friends.get(b)?.delete(a);
    this.requests.get(a)?.delete(b);
    this.requests.get(b)?.delete(a);
    this.changed();
    return 'none';
  }

  friendIds(id) {
    return [...(this.friends.get(id)?.keys() ?? [])];
  }

  incoming(id) {
    return [...(this.requests.get(id) ?? [])].map(([from, at]) => ({ id: from, at }));
  }

  outgoing(id) {
    const out = [];
    for (const [to, m] of this.requests) if (m.has(id)) out.push({ id: to, at: m.get(id) });
    return out;
  }

  mutualFriends(a, b) {
    const theirs = this.friends.get(b);
    return theirs ? this.friendIds(a).filter((id) => theirs.has(id)).length : 0;
  }

  // ---------------------------------------------------------------- projects

  project(room) {
    return this.projects.get(room) ?? null;
  }

  /** `userId` opened this project: it goes (back) to the top of their list. The first person in owns it. */
  touchProject(room, userId) {
    const now = Date.now();
    let p = this.projects.get(room);
    if (!p) {
      p = { id: room, title: '', owner: userId, created: now, updated: now, members: new Map() };
      this.projects.set(room, p);
    }
    const m = p.members.get(userId);
    if (m) {
      m.opened = now;
      delete m.hidden;
    } else p.members.set(userId, { joined: now, opened: now });
    this.changed();
    return p;
  }

  /** Keep the listed title and "last edited" time current (the time at most once a minute, to spare the disk). */
  projectEdited(room, { title, edited = false }) {
    const p = this.projects.get(room);
    if (!p) return;
    const now = Date.now();
    let dirty = false;
    if (typeof title === 'string' && title !== p.title) {
      p.title = title;
      dirty = true;
    }
    if (edited && now - p.updated > 60_000) {
      p.updated = now;
      dirty = true;
    }
    if (dirty) this.changed();
  }

  isMember(room, userId) {
    return !!this.projects.get(room)?.members.has(userId);
  }

  /** Take a project off your list (it isn't deleted: others may still be using it). Opening it again brings it back. */
  hideProject(room, userId) {
    const m = this.projects.get(room)?.members.get(userId);
    if (!m) throw fail(404, 'That project isn’t on your list');
    m.hidden = true;
    this.changed();
  }

  projectsOf(userId) {
    const out = [];
    for (const p of this.projects.values()) {
      const m = p.members.get(userId);
      if (m && !m.hidden) out.push(p);
    }
    return out.sort((a, b) => b.members.get(userId).opened - a.members.get(userId).opened);
  }

  /** How many projects both people have been in. */
  together(a, b) {
    let n = 0;
    for (const p of this.projects.values()) if (p.members.has(a) && p.members.has(b)) n++;
    return n;
  }
}
