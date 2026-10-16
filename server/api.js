// The /api routes (accounts, friends, projects, samples, .copr files) and the
// /live socket, which tells each signed-in tab about friend requests, invites
// and friends coming and going.
//
// Where friends are comes from the rooms themselves: a person is "in a
// session" while they have a connection open to a room, and "online" while
// any coprod tab of theirs is open.

import { randomBytes } from 'node:crypto';
import { ROOM_NAME } from './rooms.js';
import { publicUser, privateUser, SESSION_DAYS } from './db.js';
import { readBody, MAX_SAMPLE_BYTES } from './samples.js';
import { packProject, unpackProject, coprFileName, MAX_COPR_BYTES } from './copr.js';
import {
  hashPassword,
  checkPassword,
  wastePasswordCheck,
  cleanEmail,
  cleanUsername,
  cleanName,
  cleanBio,
  cleanColor,
  randomColor,
  readCookie,
  sessionCookie,
  sameOrigin,
  Limiter,
  PASSWORD_MIN,
  PASSWORD_MAX,
  USERNAME_RULE,
} from './auth.js';

const fail = (status, message, field) => Object.assign(new Error(message), { status, field });
const SESSION_SECONDS = SESSION_DAYS * 86_400;

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) throw fail(415, 'Send JSON');
  try {
    return JSON.parse((await readBody(req, 16 * 1024)).toString('utf8')) ?? {};
  } catch (err) {
    throw err.status === 413 ? fail(413, 'Too much data') : fail(400, 'That request wasn’t valid JSON');
  }
}

function checkPasswordRules(password) {
  if (typeof password !== 'string' || [...password].length < PASSWORD_MIN) throw fail(400, `Use at least ${PASSWORD_MIN} characters`, 'password');
  if (password.length > PASSWORD_MAX) throw fail(400, 'That password is too long', 'password');
}

export function createApi({ db, rooms, samples }) {
  const live = new Map(); // userId -> Set of /live sockets
  const where = new Map(); // userId -> Map(room -> joined at), from room connections

  // Limits on guessing and spam. Login failures count per address+email and
  // per email, so one person can't lock everyone out from behind a shared proxy.
  const loginFails = new Limiter(10, 15 * 60_000);
  const emailFails = new Limiter(50, 15 * 60_000);
  const signups = new Limiter(30, 60 * 60_000);
  const friendAsks = new Limiter(40, 60 * 60_000);
  const invites = new Limiter(30, 10 * 60_000);
  const imports = new Limiter(20, 10 * 60_000);

  // ---------------------------------------------------------------- presence

  function send(userId, msg) {
    const text = JSON.stringify(msg);
    for (const ws of live.get(userId) ?? []) if (ws.readyState === 1) ws.send(text);
  }

  /** Tell someone's friends to refresh their list (they came online, joined a session, left...). */
  function friendsChanged(userId) {
    for (const id of db.friendIds(userId)) send(id, { type: 'friends' });
  }

  const isOnline = (id) => !!live.get(id)?.size || !!where.get(id)?.size;

  function wentOffline(id) {
    if (isOnline(id)) return;
    const u = db.user(id);
    if (u) db.updateUser(id, { seen: Date.now() });
  }

  /** Where a person is, as their friends see it. */
  function presence(id) {
    const sessions = where.get(id);
    if (sessions?.size) {
      const [room] = [...sessions].sort((a, b) => b[1] - a[1])[0]; // the one they joined last
      const people = rooms.peopleIn(room);
      return {
        status: 'session',
        session: {
          room,
          title: rooms.titleOf(room) ?? (db.project(room)?.title || 'Untitled jam'),
          people: people.length,
          with: people.filter((u) => u.id !== id).slice(0, 4).map(publicUser),
        },
      };
    }
    if (live.get(id)?.size) return { status: 'online' };
    return { status: 'offline', seen: db.user(id)?.seen ?? null };
  }

  rooms.on('visit', (room, user) => {
    db.touchProject(room.name, user.id);
    db.projectEdited(room.name, { title: room.title });
  });
  rooms.on('join', (room, user) => {
    if (!where.has(user.id)) where.set(user.id, new Map());
    where.get(user.id).set(room.name, Date.now());
    friendsChanged(user.id);
    // Friends who are in this room see one more person there.
    for (const other of rooms.peopleIn(room.name)) if (other.id !== user.id) friendsChanged(other.id);
  });
  rooms.on('leave', (room, user) => {
    where.get(user.id)?.delete(room.name);
    if (!where.get(user.id)?.size) where.delete(user.id);
    wentOffline(user.id);
    friendsChanged(user.id);
    for (const other of rooms.peopleIn(room.name)) friendsChanged(other.id);
  });
  rooms.on('saved', (room, { edited }) => db.projectEdited(room.name, { title: room.title, edited }));

  /** One signed-in tab's notification socket. */
  function addLive(ws, user) {
    const wasOnline = isOnline(user.id);
    if (!live.has(user.id)) live.set(user.id, new Set());
    live.get(user.id).add(ws);
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    ws.pingTimer = setInterval(() => {
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    }, 30_000).unref();
    const drop = () => {
      clearInterval(ws.pingTimer);
      const set = live.get(user.id);
      if (!set?.delete(ws)) return;
      if (!set.size) live.delete(user.id);
      if (!isOnline(user.id)) {
        wentOffline(user.id);
        friendsChanged(user.id);
      }
    };
    ws.on('close', drop);
    ws.on('error', drop);
    ws.on('message', () => {}); // nothing to say yet; the socket only listens
    ws.send(JSON.stringify({ type: 'hello', user: privateUser(user) }));
    if (!wasOnline) friendsChanged(user.id);
  }

  // ---------------------------------------------------------------- helpers

  const userOf = (req) => db.sessionUser(readCookie(req));

  function signIn(req, res, user, status = 200) {
    const token = db.createSession(user.id);
    json(res, status, { user: privateUser(user) }, { 'set-cookie': sessionCookie(req, token, SESSION_SECONDS) });
  }

  function friendEntry(me, id) {
    const u = db.user(id);
    return u && { user: publicUser(u), since: db.friendsSince(me, id), ...presence(id) };
  }

  /** Everything the person viewing a profile may know about `id`. */
  function profile(me, id) {
    const u = db.user(id);
    if (!u) throw fail(404, 'No such person');
    const relation = db.relation(me.id, id);
    const out = { user: publicUser(u), relation, together: db.together(me.id, id), mutual: db.mutualFriends(me.id, id) };
    if (relation === 'friends') out.since = db.friendsSince(me.id, id);
    if (relation === 'friends' || relation === 'self') Object.assign(out, presence(id));
    return out;
  }

  /** Ask, accept, decline, cancel or unfriend, and tell the other person. */
  function changeFriendship(me, otherId, action) {
    const other = db.user(otherId);
    if (!other) throw fail(404, 'No such person');
    const before = db.relation(me.id, otherId);
    let relation;
    if (action === 'request') {
      if (before === 'none' && !friendAsks.allow(me.id)) throw fail(429, 'That’s a lot of friend requests. Try again later.');
      relation = db.request(me.id, otherId);
    } else if (action === 'accept') relation = db.accept(me.id, otherId);
    else relation = db.unlink(me.id, otherId);

    if (relation === 'requested' && before === 'none') send(otherId, { type: 'request', from: publicUser(me) });
    if (relation === 'friends' && before !== 'friends') send(otherId, { type: 'accepted', by: publicUser(me) });
    if (relation !== before) {
      send(otherId, { type: 'friends' });
      send(me.id, { type: 'friends' }); // other tabs of mine
    }
    return { relation, profile: profile(me, otherId) };
  }

  function projectEntry(me, p) {
    const others = [...p.members.keys()].filter((id) => id !== me.id);
    return {
      id: p.id,
      title: rooms.titleOf(p.id) ?? (p.title || 'Untitled jam'), // an open room knows its latest title
      owner: p.owner === me.id ? 'you' : publicUser(db.user(p.owner)) ?? null,
      created: p.created,
      updated: p.updated,
      opened: p.members.get(me.id).opened,
      members: others.length,
      with: others.map((id) => db.user(id)).filter(Boolean).slice(0, 6).map(publicUser),
      here: rooms.peopleIn(p.id).map(publicUser),
    };
  }

  // ---------------------------------------------------------------- routes

  // [method, pattern, handler(req, res, ctx), { auth = true }]
  const routes = [
    [
      'POST',
      /^\/api\/auth\/signup$/,
      async (req, res, { ip }) => {
        const body = await readJson(req);
        const email = cleanEmail(body.email);
        if (!email) throw fail(400, 'Enter a valid email address', 'email');
        checkPasswordRules(body.password);
        const name = cleanName(body.name);
        if (!name) throw fail(400, 'Tell people what to call you', 'name');
        const username = cleanUsername(body.username);
        if (!username) throw fail(400, USERNAME_RULE, 'username');
        if (db.userByEmail(email)) throw fail(409, 'There is already an account with that email. Sign in instead?', 'email');
        if (db.userByUsername(username)) throw fail(409, 'That username is taken', 'username');
        if (!signups.allow(ip)) throw fail(429, 'Too many new accounts from here. Try again later.');
        const pass = await hashPassword(body.password);
        const user = db.createUser({ email, username, name, color: cleanColor(body.color) ?? randomColor(), pass });
        signIn(req, res, user, 201);
      },
      { auth: false },
    ],
    [
      'POST',
      /^\/api\/auth\/login$/,
      async (req, res, { ip }) => {
        const body = await readJson(req);
        const email = cleanEmail(body.email);
        const password = String(body.password ?? '');
        if (!email || !password) throw fail(400, 'Enter your email and password');
        const key = `${ip}|${email}`;
        if (loginFails.blocked(key) || emailFails.blocked(email)) throw fail(429, 'Too many tries. Wait a few minutes, then try again.');
        const user = db.userByEmail(email);
        const ok = user ? await checkPassword(password, user.pass) : (await wastePasswordCheck(password), false);
        if (!ok) {
          loginFails.hit(key);
          emailFails.hit(email);
          throw fail(401, 'Wrong email or password');
        }
        signIn(req, res, user);
      },
      { auth: false },
    ],
    [
      'POST',
      /^\/api\/auth\/logout$/,
      async (req, res) => {
        db.endSession(readCookie(req));
        json(res, 200, { ok: true }, { 'set-cookie': sessionCookie(req, '', 0) });
      },
      { auth: false },
    ],
    [
      'GET',
      /^\/api\/me$/,
      // Signed out is an answer here ({ user: null }), not an error. A signed-in
      // person's cookie is renewed, so someone who keeps using coprod stays signed in.
      async (req, res) => {
        const me = userOf(req);
        if (!me) return json(res, 200, { user: null });
        json(res, 200, { user: privateUser(me) }, { 'set-cookie': sessionCookie(req, readCookie(req), SESSION_SECONDS) });
      },
      { auth: false },
    ],
    [
      'PATCH',
      /^\/api\/me$/,
      async (req, res, { me }) => {
        const body = await readJson(req);
        const patch = {};
        const take = (field, value, problem) => {
          if (!(field in body)) return;
          if (value === null) throw fail(400, problem, field);
          patch[field] = value;
        };
        take('name', cleanName(body.name), 'Tell people what to call you');
        take('username', cleanUsername(body.username), USERNAME_RULE);
        take('color', cleanColor(body.color), 'Pick one of the colors');
        take('bio', cleanBio(body.bio));
        db.updateUser(me.id, patch);
        friendsChanged(me.id);
        json(res, 200, { user: privateUser(me) });
      },
    ],
    [
      'POST',
      /^\/api\/me\/password$/,
      async (req, res, { me, ip }) => {
        const body = await readJson(req);
        const key = `${ip}|${me.email}`;
        if (loginFails.blocked(key)) throw fail(429, 'Too many tries. Wait a few minutes, then try again.');
        if (!(await checkPassword(String(body.current ?? ''), me.pass))) {
          loginFails.hit(key);
          throw fail(401, 'Your current password isn’t right', 'current');
        }
        checkPasswordRules(body.password);
        db.updateUser(me.id, { pass: await hashPassword(body.password) });
        db.endSessions(me.id, { keep: readCookie(req) }); // sign out everywhere else
        json(res, 200, { ok: true });
      },
    ],
    [
      'GET',
      /^\/api\/users$/,
      async (req, res, { me, query }) => {
        const users = db.search(query.get('q') ?? '', { except: me.id });
        json(res, 200, { users: users.map((u) => ({ user: publicUser(u), relation: db.relation(me.id, u.id) })) });
      },
    ],
    ['GET', /^\/api\/users\/([\w-]+)$/, async (req, res, { me, params: [id] }) => json(res, 200, profile(me, id))],
    [
      'GET',
      /^\/api\/friends$/,
      async (req, res, { me }) => {
        const order = { session: 0, online: 1, offline: 2 };
        const friends = db
          .friendIds(me.id)
          .map((id) => friendEntry(me.id, id))
          .filter(Boolean)
          .sort((a, b) => order[a.status] - order[b.status] || (b.seen ?? 0) - (a.seen ?? 0) || a.user.name.localeCompare(b.user.name));
        const people = (list) => list.map(({ id, at }) => ({ user: publicUser(db.user(id)), at })).filter((x) => x.user);
        json(res, 200, { friends, incoming: people(db.incoming(me.id)), outgoing: people(db.outgoing(me.id)) });
      },
    ],
    [
      'POST',
      /^\/api\/friends$/,
      async (req, res, { me }) => {
        const body = await readJson(req);
        const target = body.id ? db.user(String(body.id)) : db.userByUsername(cleanUsername(body.username));
        if (!target) throw fail(404, 'There’s nobody with that username');
        json(res, 200, changeFriendship(me, target.id, 'request'));
      },
    ],
    ['POST', /^\/api\/friends\/([\w-]+)\/accept$/, async (req, res, { me, params: [id] }) => json(res, 200, changeFriendship(me, id, 'accept'))],
    ['POST', /^\/api\/friends\/([\w-]+)\/decline$/, async (req, res, { me, params: [id] }) => json(res, 200, changeFriendship(me, id, 'remove'))],
    ['DELETE', /^\/api\/friends\/([\w-]+)$/, async (req, res, { me, params: [id] }) => json(res, 200, changeFriendship(me, id, 'remove'))],
    [
      'POST',
      /^\/api\/invites$/,
      async (req, res, { me }) => {
        const body = await readJson(req);
        const to = String(body.to ?? '');
        const room = String(body.room ?? '');
        if (db.relation(me.id, to) !== 'friends') throw fail(403, 'You can invite friends');
        if (!ROOM_NAME.test(room) || !db.isMember(room, me.id)) throw fail(403, 'You can only invite people to projects you’re in');
        if (!invites.allow(me.id)) throw fail(429, 'That’s a lot of invites. Try again in a few minutes.');
        const title = rooms.titleOf(room) ?? (db.project(room)?.title || 'Untitled jam');
        send(to, { type: 'invite', from: publicUser(me), room, title });
        json(res, 200, { delivered: !!live.get(to)?.size });
      },
    ],
    ['GET', /^\/api\/projects$/, async (req, res, { me }) => json(res, 200, { projects: db.projectsOf(me.id).map((p) => projectEntry(me, p)) })],
    [
      'POST',
      /^\/api\/projects$/,
      async (req, res, { me }) => {
        const id = `jam-${randomBytes(9).toString('base64url').replace(/[-_]/g, 'x')}`;
        db.touchProject(id, me.id);
        json(res, 201, { id });
      },
    ],
    [
      'DELETE',
      /^\/api\/projects\/([\w-]+)$/,
      async (req, res, { me, params: [id] }) => {
        db.hideProject(id, me.id);
        json(res, 200, { ok: true });
      },
    ],
    [
      'GET',
      /^\/api\/projects\/([\w-]+)\/export$/,
      async (req, res, { me, params: [id] }) => {
        if (!ROOM_NAME.test(id) || !db.isMember(id, me.id)) throw fail(404, 'That project isn’t one of yours');
        const update = await rooms.encode(id);
        if (!update) throw fail(404, 'That project has nothing in it yet');
        const file = await packProject(update, samples);
        const name = coprFileName(rooms.titleOf(id) ?? db.project(id)?.title);
        res.writeHead(200, {
          'content-type': 'application/vnd.coprod.project',
          'content-length': file.length,
          'content-disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
          'cache-control': 'no-store',
        });
        res.end(file);
      },
    ],
    [
      'POST',
      /^\/api\/projects\/import$/,
      async (req, res, { me }) => {
        if (!imports.allow(me.id)) throw fail(429, 'Too many projects opened, try again in a few minutes');
        const body = await readBody(req, MAX_COPR_BYTES).catch((err) => {
          throw err.status === 413 ? fail(413, 'That file is too big (max 200 MB)') : err;
        });
        const project = await unpackProject(body);
        let skipped = 0;
        for (const buf of project.samples) {
          if (buf.length > MAX_SAMPLE_BYTES) skipped++;
          else await samples.put(buf).catch(() => skipped++);
        }
        const id = `jam-${randomBytes(9).toString('base64url').replace(/[-_]/g, 'x')}`;
        await rooms.create(id, project.update);
        db.touchProject(id, me.id);
        db.projectEdited(id, { title: project.title });
        json(res, 201, { id, title: project.title, samples: project.samples.length - skipped, skipped });
      },
    ],
    [
      'POST',
      /^\/api\/samples$/,
      async (req, res, { me }) => {
        if (!samples.allow(me.id, Number(req.headers['content-length']) || 0)) {
          throw fail(429, 'Too many uploads, try again in a few minutes');
        }
        const body = await readBody(req, MAX_SAMPLE_BYTES);
        json(res, 200, await samples.put(body));
      },
    ],
  ];

  async function handle(req, res, path) {
    const ctx = { ip: req.socket.remoteAddress, query: new URL(req.url, 'http://x').searchParams };
    try {
      let allowed = null;
      for (const [method, pattern, fn, { auth = true } = {}] of routes) {
        const m = path.match(pattern);
        if (!m) continue;
        allowed = method;
        if (method !== req.method) continue;
        if (method !== 'GET' && !sameOrigin(req)) throw fail(403, 'Requests must come from coprod itself');
        if (auth) {
          ctx.me = userOf(req);
          if (!ctx.me) throw fail(401, 'Sign in first');
        }
        ctx.params = m.slice(1);
        return await fn(req, res, ctx);
      }
      throw allowed ? fail(405, 'Method not allowed') : fail(404, 'No such endpoint');
    } catch (err) {
      if (!err.status) console.error(`${req.method} ${path}:`, err);
      if (res.headersSent) return res.destroy();
      json(res, err.status ?? 500, { error: err.status ? err.message : 'Something went wrong on the server', field: err.field });
    }
  }

  return {
    handle,
    userOf,
    addLive,
    presence,
    close() {
      for (const set of live.values()) for (const ws of set) clearInterval(ws.pingTimer);
      live.clear();
    },
  };
}
