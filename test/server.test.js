import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import { startServer } from '../server/index.js';
import * as S from '../src/shared/schema.js';

const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

function client(port, room) {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(`ws://localhost:${port}/ws`, room, doc, {
    WebSocketPolyfill: WebSocket,
    disableBc: true,
  });
  return { doc, provider };
}

test('two clients sync edits and presence through the server, and rooms persist', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'coprod-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let srv = await startServer({ port: 0, dataDir });

  const a = client(srv.port, 'test-room');
  const b = client(srv.port, 'test-room');
  await until(() => a.provider.synced && b.provider.synced);

  // The server seeded the room; both see the same starter project.
  const pa = S.readProject(a.doc);
  assert.equal(pa.channels.length, 6);
  assert.deepEqual(S.readProject(b.doc).channels.map((c) => c.id), pa.channels.map((c) => c.id));

  // An edit on A shows up on B.
  const pid = pa.patterns[0].id;
  S.setStep(a.doc, pid, pa.channels[0].id, 7, 100);
  await until(() => S.readProject(b.doc).patterns[0].steps.has(`${pa.channels[0].id}:7`));

  // Presence: B sees A's name.
  a.provider.awareness.setLocalStateField('user', { name: 'Ana', color: '#f80' });
  await until(() => [...b.provider.awareness.getStates().values()].some((s) => s.user?.name === 'Ana'));

  // When A leaves, A's presence disappears for B.
  a.provider.destroy();
  a.doc.destroy();
  await until(() => ![...b.provider.awareness.getStates().values()].some((s) => s.user?.name === 'Ana'));

  b.provider.destroy();
  b.doc.destroy();
  await srv.close();

  // Restart: the room comes back from disk with the edit.
  srv = await startServer({ port: 0, dataDir });
  const c = client(srv.port, 'test-room');
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

  const up = await fetch(`${base}/api/samples`, { method: 'POST', body: wav });
  assert.equal(up.status, 200);
  const { id, type } = await up.json();
  assert.match(id, /^[a-f0-9]{64}$/);
  assert.equal(type, 'audio/wav');

  const again = await (await fetch(`${base}/api/samples`, { method: 'POST', body: wav })).json();
  assert.equal(again.id, id, 'same file, same id');

  const got = await fetch(`${base}/samples/${id}`);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'audio/wav');
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), wav);

  const bad = await fetch(`${base}/api/samples`, { method: 'POST', body: '<script>alert(1)</script>' });
  assert.equal(bad.status, 415);
  assert.equal((await fetch(`${base}/samples/${'0'.repeat(64)}`)).status, 404);
  await srv.close();
});
