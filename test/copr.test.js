import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import * as Y from 'yjs';
import { startServer } from '../server/index.js';
import { zip, unzip, crc32, samplesUsed, unpackProject, coprFileName } from '../server/copr.js';
import * as S from '../src/shared/schema.js';
import { until, account, client } from './helpers.js';

function wav(freq = 440) {
  const n = 400;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(8000, 24);
  buf.writeUInt32LE(16000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((i * freq) / 1270) * 20000), 44 + i * 2);
  return buf;
}

test('zip: round trip, stored and deflated, CRCs checked', async () => {
  const files = [
    { name: 'a.json', data: Buffer.from('{"x":1}'.repeat(200)) }, // compresses
    { name: 'samples/ü.bin', data: Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 97) & 255)) },
    { name: 'empty', data: Buffer.alloc(0) },
  ];
  const z = await zip(files);
  const back = await unzip(z);
  assert.deepEqual([...back.keys()], files.map((f) => f.name));
  for (const f of files) assert.deepEqual(back.get(f.name), f.data);
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);

  // A flipped byte inside a file is caught.
  const broken = Buffer.from(z);
  broken[60] ^= 0xff;
  await assert.rejects(unzip(broken), /damaged/);
  await assert.rejects(unzip(Buffer.from('not a zip at all, sorry')), /isn’t a \.copr/);
  await assert.rejects(unzip(z.subarray(0, z.length - 30)), /isn’t a \.copr|damaged/);
});

test('zip: readable by the standard unzip tool', async (t) => {
  let hasUnzip = true;
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
  } catch {
    hasUnzip = false;
  }
  if (!hasUnzip) return t.skip('no unzip on this machine');
  const dir = await mkdtemp(join(tmpdir(), 'coprod-zip-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'x.copr'), await zip([{ name: 'manifest.json', data: Buffer.from('{"hello":"world"}') }]));
  assert.equal(execFileSync('unzip', ['-p', join(dir, 'x.copr'), 'manifest.json']).toString(), '{"hello":"world"}');
  execFileSync('unzip', ['-tq', join(dir, 'x.copr')]); // integrity test passes
});

test('zip: an entry that inflates past its declared size is refused (zip bombs)', async () => {
  const big = Buffer.alloc(1_000_000, 0);
  const z = await zip([{ name: 'bomb', data: big }]);
  // Lie in the central directory: claim it's tiny.
  const cd = z.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  z.writeUInt32LE(10, cd + 24);
  await assert.rejects(unzip(z), /damaged/);
  assert.ok(zlib.deflateRawSync(big).length < 2000, '(it really is a tiny file that inflates to 1 MB)');
});

test('samplesUsed finds channel samples and samples inside plugin settings', () => {
  const a = 'a'.repeat(64);
  const b = 'b'.repeat(64);
  const found = samplesUsed({
    channels: [
      { sample: { id: a, name: 'kick.wav' } },
      { pluginState: { sample: { id: b, name: 'loop.wav' }, params: { cutoff: 0.5 } } },
      { name: 'no samples', fx: [{ state: { note: 'ffff' } }] },
    ],
  });
  assert.deepEqual([...found], [[a, 'kick.wav'], [b, 'loop.wav']]);
});

test('coprFileName is safe on every OS', () => {
  assert.equal(coprFileName('Night drive'), 'Night drive.copr');
  assert.equal(coprFileName('a/b\\c:d*e?"f<g>h|'), 'a_b_c_d_e_f_g_h_.copr');
  assert.equal(coprFileName('...'), 'coprod project.copr');
  assert.equal(coprFileName(''), 'coprod project.copr');
});

test('.copr export from one server, import into another: same project, samples included', async (t) => {
  const dirA = await mkdtemp(join(tmpdir(), 'coprod-'));
  const dirB = await mkdtemp(join(tmpdir(), 'coprod-'));
  t.after(() => Promise.all([rm(dirA, { recursive: true, force: true }), rm(dirB, { recursive: true, force: true })]));
  const fast = { roomOptions: { saveDelayMs: 20 } };
  const one = await startServer({ port: 0, dataDir: dirA, ...fast });
  const ana = await account(one.port, 'Ana');
  const cara = await account(one.port, 'Cara');

  // Ana makes a project with an uploaded sample, a plugin that keeps a sample in its settings, and notes.
  const kick = wav(110);
  const loop = wav(660);
  const upload = async (buf) =>
    (await fetch(`http://localhost:${one.port}/api/samples`, { method: 'POST', body: buf, headers: { cookie: ana.cookie } })).json();
  const kickId = (await upload(kick)).id;
  const loopId = (await upload(loop)).id;
  const room = (await ana.call('POST', '/api/projects')).body.id;
  const c = client(one.port, room, ana.cookie);
  await until(() => c.provider.synced);
  S.setMeta(c.doc, { title: 'Night drive', bpm: 92 });
  S.addSampleChannel(c.doc, { id: kickId, name: 'kick.wav' });
  const slicer = S.addPluginChannel(c.doc, { url: '/wam/slicer/index.js', name: 'Slicer' });
  S.setPluginState(c.doc, slicer, { v: 1, sample: { id: loopId, name: 'loop.wav' }, params: { gain: 0.7 } });
  const before = S.readProject(c.doc);
  S.addNote(c.doc, before.patterns[0].id, { ch: before.channels[4].id, p: 60, s: 3.5, l: 2, v: 90 });
  await until(async () => (await ana.call('GET', '/api/projects')).body.projects[0]?.title === 'Night drive');

  // Only people who've been in it can download it.
  assert.equal((await cara.call('GET', `/api/projects/${room}/export`)).status, 404);
  const res = await ana.call('GET', `/api/projects/${room}/export`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/vnd.coprod.project');
  assert.match(res.headers.get('content-disposition'), /attachment; filename="Night drive\.copr"/);
  const file = res.body;

  const inside = await unzip(file);
  const manifest = JSON.parse(inside.get('manifest.json'));
  assert.equal(manifest.format, 'coprod-project');
  assert.equal(manifest.title, 'Night drive');
  assert.equal(manifest.bpm, 92);
  assert.deepEqual(manifest.samples.map((s) => [s.name, s.path]).sort(), [
    ['kick.wav', `samples/${kickId}.wav`],
    ['loop.wav', `samples/${loopId}.wav`],
  ]);
  assert.deepEqual(inside.get(`samples/${kickId}.wav`), kick);
  const unpacked = await unpackProject(file);
  assert.equal(unpacked.title, 'Night drive');
  c.close();
  await one.close();

  // A different server that has never seen these samples.
  const two = await startServer({ port: 0, dataDir: dirB, ...fast });
  const ben = await account(two.port, 'Ben');
  const importFile = (body) =>
    fetch(`http://localhost:${two.port}/api/projects/import`, { method: 'POST', body, headers: { cookie: ben.cookie, 'content-type': 'application/octet-stream' } });
  assert.equal((await importFile(Buffer.from('garbage'))).status, 400);
  const notOurs = await zip([{ name: 'manifest.json', data: Buffer.from('{"format":"something-else"}') }]);
  assert.match((await (await importFile(notOurs)).json()).error, /isn’t a coprod project/);
  const newer = await zip([{ name: 'manifest.json', data: Buffer.from('{"format":"coprod-project","version":99}') }]);
  assert.match((await (await importFile(newer)).json()).error, /newer version/);

  const imported = await importFile(file);
  assert.equal(imported.status, 201);
  const { id, title, samples } = await imported.json();
  assert.notEqual(id, room, 'opening a file always makes a new project');
  assert.equal(title, 'Night drive');
  assert.equal(samples, 2);
  assert.equal((await ben.call('GET', '/api/projects')).body.projects[0].id, id, 'it is on Ben’s list, owned by him');

  const d = client(two.port, id, ben.cookie);
  await until(() => d.provider.synced);
  const after = S.readProject(d.doc);
  assert.equal(after.title, 'Night drive');
  assert.equal(after.bpm, 92);
  assert.deepEqual(after.channels.map((ch) => ch.name), before.channels.map((ch) => ch.name));
  assert.deepEqual(after.channels.find((ch) => ch.id === slicer).pluginState.sample, { id: loopId, name: 'loop.wav' });
  assert.deepEqual(after.patterns[0].notes.find((n) => n.s === 3.5), { ...after.patterns[0].notes.find((n) => n.s === 3.5), p: 60, l: 2, v: 90 });
  assert.equal(after.channels.length, before.channels.length, 'not seeded on top');
  const served = await fetch(`http://localhost:${two.port}/samples/${kickId}`);
  assert.equal(served.status, 200);
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), kick, 'the sample came along');

  // Editing the copy doesn't touch the original file's project, and the copy survives a restart.
  S.setMeta(d.doc, { title: 'Night drive (Ben’s version)' });
  await until(async () => (await ben.call('GET', '/api/projects')).body.projects[0].title === 'Night drive (Ben’s version)');
  d.close();
  await two.close();
  const three = await startServer({ port: 0, dataDir: dirB });
  const ben2 = await account(three.port, 'Ben');
  const e = client(three.port, id, ben2.cookie);
  await until(() => e.provider.synced);
  assert.equal(S.readProject(e.doc).title, 'Night drive (Ben’s version)');
  e.close();
  await three.close();
});

test('an imported project keeps working as a normal shared room', async () => {
  const srv = await startServer({ port: 0, dataDir: null });
  const ana = await account(srv.port, 'Ana');
  const src = new Y.Doc();
  S.seedProject(src);
  S.setMeta(src, { title: 'From a file' });
  const { packProject } = await import('../server/copr.js');
  const file = await packProject(Y.encodeStateAsUpdate(src), { get: async () => null });
  const res = await fetch(`http://localhost:${srv.port}/api/projects/import`, { method: 'POST', body: file, headers: { cookie: ana.cookie } });
  const { id } = await res.json();
  const a = client(srv.port, id, ana.cookie);
  const b = client(srv.port, id, (await account(srv.port, 'Ben')).cookie);
  await until(() => a.provider.synced && b.provider.synced);
  S.setMeta(a.doc, { bpm: 150 });
  await until(() => S.readProject(b.doc).bpm === 150);
  assert.equal(S.readProject(b.doc).title, 'From a file');
  a.close();
  b.close();
  await srv.close();
});
