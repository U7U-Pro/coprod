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
import { cleanEmail, cleanUsername, cleanName, hashPassword, checkPassword, Limiter } from '../server/auth.js';
import { until, account, api, client, withCookie } from './helpers.js';

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

test('input rules: emails, usernames, names', () => {
  assert.equal(cleanEmail('  Ana@Example.COM '), 'ana@example.com');
  for (const bad of ['ana', 'ana@', '@x.com', 'a b@x.com', 'ana@x', `${'a'.repeat(250)}@x.com`]) assert.equal(cleanEmail(bad), null, bad);
  assert.equal(cleanUsername('@Ana_99'), 'ana_99');
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

  // Validation, one field at a time.
  const signup = (body) => anon('POST', '/api/auth/signup', { email: 'ana@example.com', password: 'correct horse', name: 'Ana', username: 'ana', ...body });
  assert.equal((await signup({ email: 'nope' })).body.field, 'email');
  assert.equal((await signup({ password: 'short' })).body.field, 'password');
  assert.equal((await signup({ name: ' ' })).body.field, 'name');
  assert.equal((await signup({ username: 'x' })).body.field, 'username');
  assert.deepEqual((await anon('GET', '/api/me')).body, { user: null });

  const made = await signup({ name: 'Ana Lucía Fernández-Okafor', color: '#5ce1a3' });
  assert.equal(made.status, 201);
  assert.equal(made.body.user.name, 'Ana Lucía Fernández-Okafor');
  assert.equal(made.body.user.email, 'ana@example.com');
  assert.equal(made.body.user.pass, undefined, 'the hash never leaves the server');
  const cookie = made.headers.get('set-cookie');
  assert.match(cookie, /coprod_session=[\w-]{40,}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000/);
  const ana = api(srv.port, cookie.split(';')[0]);

  // Taken email (any case) and username.
  assert.equal((await signup({ email: 'ANA@example.com', username: 'other' })).status, 409);
  assert.equal((await signup({ email: 'other@example.com' })).body.field, 'username');

  // Signing in.
  const login = (email, password) => anon('POST', '/api/auth/login', { email, password });
  assert.equal((await login('ana@example.com', 'wrong password')).status, 401);
  assert.equal((await login('nobody@example.com', 'correct horse')).body.error, 'Wrong email or password', 'same answer for unknown emails');
  const second = await login(' Ana@Example.com ', 'correct horse');
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
  assert.equal((await login('ana@example.com', 'battery staple')).status, 200);

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

  // Search: by username or name prefix, or exact email; never yourself.
  assert.deepEqual((await ana.call('GET', '/api/users?q=ben')).body.users.map((u) => u.user.username), ['ben']);
  assert.deepEqual((await ana.call('GET', '/api/users?q=okon')).body.users.map((u) => u.user.username), ['ben']);
  assert.deepEqual((await ana.call('GET', '/api/users?q=cara@example.com')).body.users.map((u) => u.user.username), ['cara']);
  assert.deepEqual((await ana.call('GET', '/api/users?q=ana')).body.users, []);

  // Ana asks Ben (by username); Ben hears about it live.
  assert.equal((await ana.call('POST', '/api/friends', { username: 'nobody' })).status, 404);
  const asked = await ana.call('POST', '/api/friends', { username: '@Ben' });
  assert.equal(asked.body.relation, 'requested');
  await until(() => benLive.got.some((m) => m.type === 'request' && m.from.username === 'ana'));
  assert.equal(benLive.got.find((m) => m.type === 'request').from.email, undefined, 'no emails in notifications');
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
