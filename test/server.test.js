import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startServer } from '../server/index.js';
import * as S from '../src/shared/schema.js';
import { until, account, client } from './helpers.js';

test('two clients sync edits and presence through the server, and rooms persist', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'coprod-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let srv = await startServer({ port: 0, dataDir });
  const ana = await account(srv.port, 'Ana');
  const ben = await account(srv.port, 'Ben');

  const a = client(srv.port, 'test-room', ana.cookie);
  const b = client(srv.port, 'test-room', ben.cookie);
  await until(() => a.provider.synced && b.provider.synced);

  // The server seeded the room; both see the same starter project.
  const pa = S.readProject(a.doc);
  assert.equal(pa.channels.length, 6);
  assert.deepEqual(S.readProject(b.doc).channels.map((c) => c.id), pa.channels.map((c) => c.id));

  // An edit on A shows up on B.
  const pid = pa.patterns[0].id;
  S.setStep(a.doc, pid, pa.channels[0].id, 7, 100);
  await until(() => S.readProject(b.doc).patterns[0].steps.has(`${pa.channels[0].id}:7`));

  // Presence: B sees A's name, from A's account, whatever A claims to be.
  a.provider.awareness.setLocalStateField('user', { name: 'Not Ana', color: '#f80' });
  await until(() => [...b.provider.awareness.getStates().values()].some((s) => s.user?.name === 'Ana'));
  const seen = [...b.provider.awareness.getStates().values()].find((s) => s.user?.name === 'Ana').user;
  assert.deepEqual(seen, { id: ana.user.id, name: 'Ana', username: 'ana', color: ana.user.color });

  // When A leaves, A's presence disappears for B.
  a.provider.destroy();
  a.doc.destroy();
  await until(() => ![...b.provider.awareness.getStates().values()].some((s) => s.user?.name === 'Ana'));

  b.provider.destroy();
  b.doc.destroy();
  await srv.close();

  // Restart: the room (and Ana's account) come back from disk with the edit.
  srv = await startServer({ port: 0, dataDir });
  const c = client(srv.port, 'test-room', (await account(srv.port, 'Ana')).cookie);
  await until(() => c.provider.synced);
  const pc = S.readProject(c.doc);
  assert.ok(pc.patterns[0].steps.has(`${pa.channels[0].id}:7`));
  assert.equal(pc.channels.length, 6, 'not seeded twice');
  c.provider.destroy();
  c.doc.destroy();
  await srv.close();
});

test('rejects invalid room names', async () => {
  const srv = await startServer({ port: 0, dataDir: null });
  const ws = new WebSocket(`ws://localhost:${srv.port}/ws/..%2Fetc`);
  const result = await new Promise((r) => {
    ws.on('open', () => r('open'));
    ws.on('error', () => r('error'));
  });
  assert.equal(result, 'error');
  await srv.close();
});

test('sample upload: stores by content hash, rejects non-audio, serves back', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'coprod-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const srv = await startServer({ port: 0, dataDir });
  const base = `http://localhost:${srv.port}`;
  const { cookie } = await account(srv.port, 'Ana');

  // A tiny valid WAV header + a few samples.
  const wav = Buffer.alloc(52);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(44, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(8, 40);

  assert.equal((await fetch(`${base}/api/samples`, { method: 'POST', body: wav })).status, 401, 'signed-in people only');
  const up = await fetch(`${base}/api/samples`, { method: 'POST', body: wav, headers: { cookie } });
  assert.equal(up.status, 200);
  const { id, type } = await up.json();
  assert.match(id, /^[a-f0-9]{64}$/);
  assert.equal(type, 'audio/wav');

  const again = await (await fetch(`${base}/api/samples`, { method: 'POST', body: wav, headers: { cookie } })).json();
  assert.equal(again.id, id, 'same file, same id');

  const got = await fetch(`${base}/samples/${id}`);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'audio/wav');
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), wav);

  const bad = await fetch(`${base}/api/samples`, { method: 'POST', body: '<script>alert(1)</script>', headers: { cookie } });
  assert.equal(bad.status, 415);
  assert.equal((await fetch(`${base}/samples/${'0'.repeat(64)}`)).status, 404);
  await srv.close();
});
