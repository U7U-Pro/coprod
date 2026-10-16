import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { startServer } from '../server/index.js';
import { MSG_CHAT, cleanChat } from '../server/rooms.js';
import { cleanUsername, cleanName, hashPassword, checkPassword, Limiter } from '../server/auth.js';
import { until, account, guest, api, client, withCookie } from './helpers.js';

const fast = { roomOptions: { leaveGraceMs: 50, saveDelayMs: 20 } };

/** The /live notification socket, collecting what it receives. */
async function liveSocket(port, cookie) {
  const ws = new WebSocket(`ws://localhost:${port}/live`, { headers: { cookie } });
  const got = [];
  ws.on('message', (d) => got.push(JSON.parse(d)));
  await new Promise((r, j) => (ws.once('open', r), ws.once('error', j)));
  return { ws, got, close: () => ws.close() };
}

/** Room chat on a y-websocket client: say hello, collect messages, say things. */
function chat(c) {
  const got = [];
  c.provider.messageHandlers[MSG_CHAT] = (encoder, decoder) => got.push(JSON.parse(decoding.readVarString(decoder)));
  const send = (msg) => {
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MSG_CHAT);
    encoding.writeVarString(e, JSON.stringify(msg));
    c.provider.ws.send(encoding.toUint8Array(e));
  };
  const hello = () => send({ type: 'hello' });
  if (c.provider.wsconnected) hello();
  c.provider.on('status', ({ status }) => status === 'connected' && hello());
  return { got, say: (text, extra = {}) => send({ type: 'say', text, ...extra }), messages: () => got.filter((m) => m.type === 'message').map((m) => m.message) };
}

test('input rules: usernames, names', () => {
  assert.equal(cleanUsername(' @Ana_99 '), 'ana_99');
  for (const bad of ['ab', 'a'.repeat(21), 'ana!', 'an a']) assert.equal(cleanUsername(bad), null, bad);
  assert.equal(cleanName('  Ana   María  '), 'Ana María');
  assert.equal(cleanName('‮evil\u0007'), 'evil', 'no bidi overrides or control characters');
  assert.equal([...cleanName('🎹'.repeat(40))].length, 32, 'cut by characters, not UTF-16 units');
  assert.equal(cleanName('   '), null);
  assert.equal(cleanChat('  hi\u0000\r\n\n\n\nthere  '), 'hi\n\nthere');
});

test('passwords are salted scrypt hashes', async () => {
  const a = await hashPassword('correct horse');
  const b = await hashPassword('correct horse');
  assert.notEqual(a, b, 'salted');
  assert.match(a, /^scrypt\$16384\$8\$1\$/);
  assert.ok(await checkPassword('correct horse', a));
  assert.ok(!(await checkPassword('correct horsf', a)));
  assert.ok(!(await checkPassword('x', 'garbage')));
});

test('rate limiter', () => {
  const l = new Limiter(2, 60_000);
  assert.ok(l.allow('a') && l.allow('a'));
  assert.ok(!l.allow('a'));
  assert.ok(l.allow('b'));
});

test('sign up, sign in, sessions, profile edits, password change', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'coprod-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let srv = await startServer({ port: 0, dataDir });
  const anon = api(srv.port);

  // Validation, one field at a time. No email anywhere: a username and a password.
  const signup = (body) => anon('POST', '/api/auth/signup', { password: 'correct horse', name: 'Ana', username: 'ana', ...body });
  assert.equal((await signup({ password: 'short' })).body.field, 'password');
  assert.equal((await signup({ name: ' ' })).body.field, 'name');
  assert.equal((await signup({ username: 'x' })).body.field, 'username');
  assert.match((await signup({ username: 'guest_ana' })).body.error, /kept for guests/);
  assert.deepEqual((await anon('GET', '/api/me')).body, { user: null });

  const made = await signup({ name: 'Ana Lucía Fernández-Okafor', username: '@Ana', color: '#5ce1a3' });
  assert.equal(made.status, 201);
  assert.equal(made.body.user.name, 'Ana Lucía Fernández-Okafor');
  assert.equal(made.body.user.username, 'ana');
  assert.equal(made.body.user.guest, undefined);
  assert.equal(made.body.user.pass, undefined, 'the hash never leaves the server');
  const cookie = made.headers.get('set-cookie');
  assert.match(cookie, /coprod_session=[\w-]{40,}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000/);
  const ana = api(srv.port, cookie.split(';')[0]);

  // A taken username (any case).
  const taken = await signup({ username: 'ANA' });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.field, 'username');

  // Signing in, with the username however it's typed.
  const login = (username, password) => anon('POST', '/api/auth/login', { username, password });
  assert.equal((await login('ana', 'wrong password')).status, 401);
  assert.equal((await login('nobody', 'correct horse')).body.error, 'Wrong username or password', 'same answer for unknown usernames');
  const second = await login(' @ANA ', 'correct horse');
  assert.equal(second.status, 200);
  const other = api(srv.port, second.headers.get('set-cookie').split(';')[0]);
  assert.equal((await ana('GET', '/api/me')).body.user.username, 'ana');

  // Profile edits are checked too.
  assert.equal((await ana('PATCH', '/api/me', { username: 'no way!' })).body.field, 'username');
  assert.equal((await ana('PATCH', '/api/me', { color: 'red' })).body.field, 'color');
  const edited = await ana('PATCH', '/api/me', { bio: 'Makes drums.\nLikes 808s.', username: 'ana_beats' });
  assert.equal(edited.body.user.bio, 'Makes drums.\nLikes 808s.');
  assert.equal(edited.body.user.username, 'ana_beats');

  // Changing the password needs the old one and signs out every other session.
  assert.equal((await ana('POST', '/api/me/password', { current: 'nope', password: 'battery staple' })).body.field, 'current');
  assert.equal((await ana('POST', '/api/me/password', { current: 'correct horse', password: 'battery staple' })).status, 200);
  assert.equal((await other('GET', '/api/me')).body.user, null, 'the other session ended');
  assert.equal((await other('GET', '/api/friends')).status, 401);
  assert.equal((await ana('GET', '/api/me')).body.user.username, 'ana_beats', 'this one stays');
  assert.equal((await login('ana_beats', 'battery staple')).status, 200);
  assert.equal((await login('ana', 'battery staple')).status, 401, 'the old username is free again');

  // A request from another site's page is refused even with the cookie.
  const csrf = await fetch(`http://localhost:${srv.port}/api/me`, {
    method: 'PATCH',
    headers: { cookie: cookie.split(';')[0], 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ name: 'pwned' }),
  });
  assert.equal(csrf.status, 403);

  // Accounts and sessions survive a restart; signing out ends the session.
  await srv.close();
  const saved = JSON.parse(await readFile(join(dataDir, 'coprod.json'), 'utf8'));
  assert.ok(!JSON.stringify(saved).includes('battery staple'), 'no plain passwords on disk');
  assert.ok(!JSON.stringify(saved).includes(cookie.split(';')[0].split('=')[1]), 'no raw session tokens on disk');
  srv = await startServer({ port: 0, dataDir });
  const again = api(srv.port, cookie.split(';')[0]);
  assert.equal((await again('GET', '/api/me')).body.user.name, 'Ana Lucía Fernández-Okafor');
  assert.equal((await again('POST', '/api/auth/logout')).status, 200);
  assert.equal((await again('GET', '/api/me')).body.user, null);
  assert.equal((await again('GET', '/api/projects')).status, 401);
  await srv.close();
});

test('rooms need a signed-in session, from coprod itself', async () => {
  const srv = await startServer({ port: 0, dataDir: null });
  const { cookie } = await account(srv.port, 'Ana');
  const tryOpen = (headers) =>
    new Promise((r) => {
      const ws = new WebSocket(`ws://localhost:${srv.port}/ws/some-room`, { headers });
      ws.on('open', () => (ws.close(), r('open')));
      ws.on('unexpected-response', (req, res) => r(res.statusCode));
      ws.on('error', () => r('error'));
    });
  assert.equal(await tryOpen({}), 401);
  assert.equal(await tryOpen({ cookie: 'coprod_session=made-up' }), 401);
  assert.equal(await tryOpen({ cookie, origin: 'https://evil.example' }), 403);
  assert.equal(await tryOpen({ cookie, origin: `http://localhost:${srv.port}` }), 'open');
  await srv.close();
});

test('friends: requests, live notifications, presence in sessions, profiles, invites', async () => {
  const srv = await startServer({ port: 0, dataDir: null, ...fast });
  const ana = await account(srv.port, 'Ana');
  const ben = await account(srv.port, 'Ben', { name: 'Benjamin Okonkwo-Fairweather' });
  const cara = await account(srv.port, 'Cara');
  const benLive = await liveSocket(srv.port, ben.cookie);
  const anaLive = await liveSocket(srv.port, ana.cookie);
  assert.equal(benLive.got[0].type, 'hello');

  // Search: by username, name, or any word of the name; never yourself.
  assert.deepEqual((await ana.call('GET', '/api/users?q=ben')).body.users.map((u) => u.user.username), ['ben']);
  assert.deepEqual((await ana.call('GET', '/api/users?q=okon')).body.users.map((u) => u.user.username), ['ben']);
  assert.deepEqual((await ana.call('GET', '/api/users?q=@car')).body.users.map((u) => u.user.username), ['cara']);
  assert.deepEqual((await ana.call('GET', '/api/users?q=ana')).body.users, []);

  // Ana asks Ben (by username); Ben hears about it live.
  assert.equal((await ana.call('POST', '/api/friends', { username: 'nobody' })).status, 404);
  const asked = await ana.call('POST', '/api/friends', { username: '@Ben' });
  assert.equal(asked.body.relation, 'requested');
  await until(() => benLive.got.some((m) => m.type === 'request' && m.from.username === 'ana'));
  assert.equal((await ana.call('POST', '/api/friends', { id: ben.user.id })).body.relation, 'requested', 'asking twice is harmless');
  const benFriends = (await ben.call('GET', '/api/friends')).body;
  assert.deepEqual(benFriends.incoming.map((r) => r.user.username), ['ana']);
  assert.deepEqual((await ana.call('GET', '/api/friends')).body.outgoing.map((r) => r.user.username), ['ben']);

  // Profiles show the relationship from each side.
  assert.equal((await ben.call('GET', `/api/users/${ana.user.id}`)).body.relation, 'incoming');
  assert.equal((await ana.call('GET', `/api/users/${ben.user.id}`)).body.relation, 'requested');
  assert.equal((await ana.call('GET', `/api/users/${ben.user.id}`)).body.status, undefined, 'no presence before you are friends');

  // Ben accepts; Ana hears.
  assert.equal((await ben.call('POST', `/api/friends/${ana.user.id}/accept`)).body.relation, 'friends');
  await until(() => anaLive.got.some((m) => m.type === 'accepted' && m.by.username === 'ben'));
  const prof = (await ana.call('GET', `/api/users/${ben.user.id}`)).body;
  assert.equal(prof.relation, 'friends');
  assert.equal(prof.user.name, 'Benjamin Okonkwo-Fairweather');
  assert.equal(prof.status, 'online');

  // Ben opens a project: Ana's list shows him in a session (with its title), and she's told to refresh.
  const project = (await ben.call('POST', '/api/projects')).body.id;
  anaLive.got.length = 0;
  const b = client(srv.port, project, ben.cookie);
  await until(() => b.provider.synced);
  b.doc.getMap('meta').set('title', 'Night drive');
  await until(async () => (await ana.call('GET', '/api/friends')).body.friends[0]?.status === 'session');
  const entry = (await ana.call('GET', '/api/friends')).body.friends[0];
  assert.equal(entry.session.room, project);
  assert.equal(entry.session.title, 'Night drive');
  assert.ok(anaLive.got.some((m) => m.type === 'friends'));

  // Invites: friends only, to projects you're in.
  assert.equal((await ben.call('POST', '/api/invites', { to: cara.user.id, room: project })).status, 403, 'not friends');
  assert.equal((await ben.call('POST', '/api/invites', { to: ana.user.id, room: 'not-his-room' })).status, 403);
  assert.equal((await ben.call('POST', '/api/invites', { to: ana.user.id, room: project })).body.delivered, true);
  await until(() => anaLive.got.some((m) => m.type === 'invite' && m.room === project && m.title === 'Night drive'));

  // Ana joins too: they've now been in one project together.
  const a = client(srv.port, project, ana.cookie);
  await until(() => a.provider.synced);
  assert.equal((await ana.call('GET', `/api/users/${ben.user.id}`)).body.together, 1);
  const list = (await ana.call('GET', '/api/projects')).body.projects;
  assert.equal(list[0].id, project);
  assert.equal(list[0].title, 'Night drive');
  assert.deepEqual(list[0].here.map((u) => u.username).sort(), ['ana', 'ben']);
  assert.equal(list[0].owner.username, 'ben');

  // Ben leaves (after the grace period) and closes coprod: offline, with a last-seen time.
  b.close();
  benLive.close();
  await until(async () => (await ana.call('GET', '/api/friends')).body.friends[0]?.status === 'offline');
  assert.ok((await ana.call('GET', '/api/friends')).body.friends[0].seen > Date.now() - 5000);

  // Unfriending ends it both ways.
  assert.equal((await ana.call('DELETE', `/api/friends/${ben.user.id}`)).body.relation, 'none');
  assert.deepEqual((await ben.call('GET', '/api/friends')).body.friends, []);

  // Asking someone who already asked you makes you friends.
  await cara.call('POST', '/api/friends', { id: ana.user.id });
  assert.equal((await ana.call('POST', '/api/friends', { id: cara.user.id })).body.relation, 'friends');
  // Declining clears a request.
  await ben.call('POST', '/api/friends', { id: cara.user.id });
  assert.equal((await cara.call('POST', `/api/friends/${ben.user.id}/decline`)).body.relation, 'none');
  assert.deepEqual((await ben.call('GET', '/api/friends')).body.outgoing, []);

  a.close();
  anaLive.close();
  await srv.close();
});

test('project list: new projects, titles, removing from the list', async () => {
  const srv = await startServer({ port: 0, dataDir: null, ...fast });
  const ana = await account(srv.port, 'Ana');
  const one = (await ana.call('POST', '/api/projects')).body.id;
  const two = (await ana.call('POST', '/api/projects')).body.id;
  assert.match(one, /^jam-[A-Za-z0-9]{12}$/);
  let list = (await ana.call('GET', '/api/projects')).body.projects;
  assert.deepEqual(list.map((p) => p.id).sort(), [one, two].sort());
  assert.equal(list[0].owner, 'you');

  // Opening one moves it to the top and picks up its title.
  const c = client(srv.port, one, ana.cookie);
  await until(() => c.provider.synced);
  list = (await ana.call('GET', '/api/projects')).body.projects;
  assert.equal(list[0].id, one);
  assert.equal(list[0].title, 'Untitled jam');

  // Removing hides it for you only; opening it again brings it back.
  await ana.call('DELETE', `/api/projects/${one}`);
  assert.deepEqual((await ana.call('GET', '/api/projects')).body.projects.map((p) => p.id), [two]);
  c.close();
  const again = client(srv.port, one, ana.cookie);
  await until(async () => (await ana.call('GET', '/api/projects')).body.projects.length === 2);
  again.close();
  assert.equal((await ana.call('DELETE', '/api/projects/jam-not-mine')).status, 404);
  await srv.close();
});

test('room chat: authors come from the account, history persists, spam is slowed', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'coprod-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let srv = await startServer({ port: 0, dataDir, ...fast });
  const ana = await account(srv.port, 'Ana');
  const ben = await account(srv.port, 'Ben');
  const a = client(srv.port, 'chat-room', ana.cookie);
  const b = client(srv.port, 'chat-room', ben.cookie);
  const ac = chat(a);
  const bc = chat(b);
  await until(() => ac.got.some((m) => m.type === 'history') && bc.got.some((m) => m.type === 'history'));

  ac.say('  hey @ben, check the bassline  ', { user: { name: 'Ben' } });
  await until(() => bc.messages().length === 1);
  const m = bc.messages()[0];
  assert.equal(m.text, 'hey @ben, check the bassline');
  assert.deepEqual(m.user, { id: ana.user.id, name: 'Ana', username: 'ana', color: ana.user.color }, 'the claimed author is ignored');
  assert.equal(ac.messages().length, 1, 'the sender gets it back too');
  ac.say('   ');
  ac.say('x'.repeat(5000));
  await until(() => bc.messages().length === 2);
  assert.equal(bc.messages()[1].text.length, 1000, 'long messages are cut');

  // Join and leave notices.
  const c = client(srv.port, 'chat-room', (await account(srv.port, 'Cara')).cookie);
  await until(() => ac.got.some((x) => x.type === 'notice' && x.notice.kind === 'join' && x.notice.user.username === 'cara'));
  c.close();
  await until(() => ac.got.some((x) => x.type === 'notice' && x.notice.kind === 'leave' && x.notice.user.username === 'cara'));

  // Eight messages per ten seconds.
  for (let i = 0; i < 9; i++) bc.say(`msg ${i}`);
  await until(() => bc.got.some((x) => x.type === 'error'));
  assert.equal(bc.messages().filter((x) => x.user.username === 'ben').length, 8);

  // A plain y-websocket client that never says hello gets no chat traffic (and no errors).
  const plain = client(srv.port, 'chat-room', ana.cookie);
  const unknown = [];
  plain.provider.messageHandlers[MSG_CHAT] = () => unknown.push(1);
  await until(() => plain.provider.synced);
  ac.say('after plain joined');
  await until(() => bc.messages().some((x) => x.text === 'after plain joined'));
  assert.equal(unknown.length, 0);

  // History survives a restart.
  for (const x of [a, b, plain]) x.close();
  await srv.close();
  srv = await startServer({ port: 0, dataDir, ...fast });
  const d = client(srv.port, 'chat-room', (await account(srv.port, 'Ana')).cookie);
  const dc = chat(d);
  await until(() => dc.got.some((x) => x.type === 'history'));
  const history = dc.got.find((x) => x.type === 'history').messages;
  assert.equal(history[0].text, 'hey @ben, check the bassline');
  assert.equal(history.at(-1).text, 'after plain joined');
  d.close();
  await srv.close();
});

test('the live socket needs a session too', async () => {
  const srv = await startServer({ port: 0, dataDir: null });
  const status = await new Promise((r) => {
    const ws = new WebSocket(`ws://localhost:${srv.port}/live`);
    ws.on('unexpected-response', (req, res) => r(res.statusCode));
    ws.on('open', () => r('open'));
  });
  assert.equal(status, 401);
  const { cookie } = await account(srv.port, 'Ana');
  const ws = new (withCookie(cookie))(`ws://localhost:${srv.port}/live`);
  const hello = await new Promise((r) => ws.once('message', (d) => r(JSON.parse(d))));
  assert.equal(hello.user.username, 'ana');
  ws.close();
  await srv.close();
});

test('guests: no password, can join and chat, can’t add friends, can become an account, gone when they sign out', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'coprod-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let srv = await startServer({ port: 0, dataDir, ...fast });
  const anon = api(srv.port);
  const ana = await account(srv.port, 'Ana');
  const cara = await guest(srv.port, '  Cara  ');
  assert.equal(cara.user.guest, true);
  assert.equal(cara.user.name, 'Cara');
  assert.match(cara.user.username, /^guest_[a-z0-9]{6}$/);
  assert.match((await guest(srv.port)).user.name, /^Guest \d{4}$/, 'a name is optional');
  assert.equal((await cara.call('GET', '/api/me')).body.user.guest, true);

  // Nobody can sign in as a guest: there's no password to guess.
  for (const password of ['', 'null', 'correct horse']) {
    assert.ok([400, 401].includes((await anon('POST', '/api/auth/login', { username: cara.user.username, password })).status));
  }

  // A guest joins a project, shows up and chats as themselves (marked as a guest).
  const room = (await ana.call('POST', '/api/projects')).body.id;
  const a = client(srv.port, room, ana.cookie);
  const c = client(srv.port, room, cara.cookie);
  const ac = chat(a);
  const cc = chat(c);
  await until(() => ac.got.some((m) => m.type === 'history') && cc.got.some((m) => m.type === 'history'));
  c.provider.awareness.setLocalStateField('user', { name: 'Ana' });
  await until(() => [...a.provider.awareness.getStates().values()].some((s) => s.user?.username === cara.user.username));
  const seen = [...a.provider.awareness.getStates().values()].find((s) => s.user?.username === cara.user.username).user;
  assert.deepEqual(seen, { id: cara.user.id, name: 'Cara', username: cara.user.username, color: cara.user.color, guest: true });
  cc.say('hi from a guest');
  await until(() => ac.messages().length === 1);
  assert.equal(ac.messages()[0].user.name, 'Cara');
  assert.equal(ac.messages()[0].user.guest, true);
  assert.equal((await cara.call('GET', '/api/projects')).body.projects[0].id, room, 'on the guest’s own list');

  // Friends: not with guests, either way; guests aren't in search.
  assert.match((await cara.call('POST', '/api/friends', { id: ana.user.id })).body.error, /Guests can’t add friends/);
  assert.match((await ana.call('POST', '/api/friends', { id: cara.user.id })).body.error, /is a guest/);
  assert.deepEqual((await ana.call('GET', '/api/users?q=cara')).body.users, []);
  assert.equal((await ana.call('GET', `/api/users/${cara.user.id}`)).body.user.guest, true);
  assert.deepEqual((await cara.call('GET', '/api/friends')).body, { friends: [], incoming: [], outgoing: [] });

  // A guest can rename themselves, but has no password to change and keeps their guest_ username.
  assert.equal((await cara.call('PATCH', '/api/me', { name: 'Cara M.' })).body.user.name, 'Cara M.');
  assert.equal((await cara.call('PATCH', '/api/me', { username: 'cara' })).body.field, 'username');
  assert.equal((await cara.call('POST', '/api/me/password', { current: '', password: 'whatever123' })).status, 400);

  // Creating an account: same person, same projects, now with a username and password.
  assert.equal((await cara.call('POST', '/api/auth/upgrade', { username: 'guest_cara', password: 'battery staple' })).body.field, 'username');
  assert.equal((await cara.call('POST', '/api/auth/upgrade', { username: 'ana', password: 'battery staple' })).status, 409);
  assert.equal((await cara.call('POST', '/api/auth/upgrade', { username: 'cara', password: 'short' })).body.field, 'password');
  const up = await cara.call('POST', '/api/auth/upgrade', { username: 'Cara', password: 'battery staple' });
  assert.equal(up.status, 200);
  assert.equal(up.body.user.username, 'cara');
  assert.equal(up.body.user.guest, undefined);
  assert.equal(up.body.user.id, cara.user.id, 'the same account');
  assert.equal((await cara.call('GET', '/api/projects')).body.projects[0].id, room, 'projects come along');
  assert.equal((await anon('POST', '/api/auth/login', { username: 'cara', password: 'battery staple' })).status, 200);
  assert.equal((await ana.call('POST', '/api/friends', { id: cara.user.id })).body.relation, 'requested', 'now she can be added');
  assert.equal((await cara.call('POST', '/api/auth/upgrade', { username: 'cara2', password: 'battery staple' })).status, 400, 'only once');
  c.provider.awareness.setLocalStateField('user', { name: 'Cara M.' });
  await until(() => [...a.provider.awareness.getStates().values()].some((s) => s.user?.username === 'cara' && !s.user.guest));

  // A guest who signs out is gone: their account, session, and place in projects.
  const dee = await guest(srv.port, 'Dee');
  const d = client(srv.port, room, dee.cookie);
  await until(async () => (await ana.call('GET', '/api/projects')).body.projects[0].with.some((u) => u.name === 'Dee'));
  d.close();
  assert.equal((await dee.call('POST', '/api/auth/logout')).status, 200);
  assert.equal(srv.db.user(dee.user.id), null);
  assert.equal((await dee.call('GET', '/api/me')).body.user, null);
  assert.ok(!(await ana.call('GET', '/api/projects')).body.projects[0].with.some((u) => u.name === 'Dee'));

  // Guests whose session ran out are cleared away (also when the server starts).
  const old = await guest(srv.port, 'Old');
  for (const s of srv.db.sessions.values()) if (s.user === old.user.id) s.expires = Date.now() - 1;
  assert.equal(srv.db.pruneGuests(), 1);
  assert.equal(srv.db.user(old.user.id), null);

  // The rest survives a restart: the account Cara made, and guests still signed in.
  a.close();
  c.close();
  const keep = await guest(srv.port, 'Still here');
  await srv.close();
  srv = await startServer({ port: 0, dataDir, ...fast });
  assert.equal((await api(srv.port, cara.cookie)('GET', '/api/me')).body.user.username, 'cara');
  assert.equal((await api(srv.port, keep.cookie)('GET', '/api/me')).body.user.name, 'Still here');
  await srv.close();
});

test('accounts saved by the email version still sign in, by username, and lose the email', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'coprod-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const pass = await hashPassword('correct horse');
  const { writeFile } = await import('node:fs/promises');
  const old = { version: 1, users: [{ id: 'uold', email: 'ana@example.com', username: 'ana', name: 'Ana', color: '#ff8a3d', bio: '', pass, created: 1, seen: 1 }], sessions: [], friends: [], requests: [], projects: [] };
  await writeFile(join(dataDir, 'coprod.json'), JSON.stringify(old));
  const srv = await startServer({ port: 0, dataDir });
  const res = await api(srv.port)('POST', '/api/auth/login', { username: 'ana', password: 'correct horse' });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.id, 'uold');
  await srv.close();
  assert.ok(!(await readFile(join(dataDir, 'coprod.json'), 'utf8')).includes('ana@example.com'));
});
