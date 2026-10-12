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
