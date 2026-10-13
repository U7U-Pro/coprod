import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import * as S from '../src/shared/schema.js';

/** Two peers that start from the same seeded project. */
function peers() {
  const a = new Y.Doc();
  S.seedProject(a);
  const b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  return [a, b];
}

/** Exchange everything both ways, like a reconnect after offline edits. */
// Remote updates carry an origin, as the websocket provider's do, so undo
// managers can tell them apart from local edits.
function sync(a, b) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)), 'remote');
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)), 'remote');
}

const dump = (doc) => S.undoScope(doc).map((t) => t.toJSON());
const same = (a, b) => assert.deepEqual(dump(a), dump(b));

test('seeding creates a playable starter project exactly once', () => {
  const doc = new Y.Doc();
  assert.equal(S.seedProject(doc), true);
  assert.equal(S.seedProject(doc), false);
  const p = S.readProject(doc);
  assert.equal(p.channels.length, 6);
  assert.equal(p.patterns.length, 1);
  assert.deepEqual(p.song, [p.patterns[0].id]);
  assert.ok(p.patterns[0].steps.size > 0);
  assert.ok(p.patterns[0].notes.length > 0);
});

test('concurrent toggles of the same and different steps converge', () => {
  const [a, b] = peers();
  const pa = S.readProject(a);
  const pid = pa.patterns[0].id;
  const [kick, clap] = pa.channels;
  // Both add the same step, and each adds a different one, while "offline".
  S.toggleStep(a, pid, clap.id, 0);
  S.toggleStep(b, pid, clap.id, 0);
  S.toggleStep(a, pid, kick.id, 3);
  S.toggleStep(b, pid, kick.id, 5);
  sync(a, b);
  same(a, b);
  const steps = S.readProject(a).patterns[0].steps;
  assert.ok(steps.has(`${clap.id}:0`));
  assert.ok(steps.has(`${kick.id}:3`));
  assert.ok(steps.has(`${kick.id}:5`));
});

test('one person deletes a channel while another writes notes on it', () => {
  const [a, b] = peers();
  const p = S.readProject(a);
  const pid = p.patterns[0].id;
  const keys = p.channels.find((c) => c.inst === 'keys');
  S.removeChannel(a, keys.id);
  S.addNote(b, pid, { ch: keys.id, p: 60, s: 0, l: 4 });
  sync(a, b);
  same(a, b);
  const after = S.readProject(a);
  assert.ok(!after.channels.some((c) => c.id === keys.id));
  // The orphan note survives the merge but plays nothing; the UI ignores it.
  assert.equal(after.patterns[0].notes.filter((n) => n.ch === keys.id).length, 1);
});

test('concurrent note edits: last writer wins per note, no duplicates', () => {
  const [a, b] = peers();
  const pid = S.readProject(a).patterns[0].id;
  const bass = S.readProject(a).channels.find((c) => c.inst === 'bass');
  const nid = S.addNote(a, pid, { ch: bass.id, p: 40, s: 2, l: 1 });
  sync(a, b);
  S.updateNote(a, pid, nid, { p: 41 });
  S.updateNote(b, pid, nid, { l: 3 });
  sync(a, b);
  same(a, b);
  const notes = S.readProject(a).patterns[0].notes.filter((n) => n.id === nid);
  assert.equal(notes.length, 1);
});

test('notes are clamped to the pattern and pitch range', () => {
  const doc = new Y.Doc();
  S.seedProject(doc);
  const pid = S.readProject(doc).patterns[0].id;
  const nid = S.addNote(doc, pid, { ch: 'x', p: 500, s: 14, l: 10 });
  const n = S.readProject(doc).patterns[0].notes.find((x) => x.id === nid);
  assert.equal(n.p, S.MAX_PITCH);
  assert.equal(n.s + n.l, 16);
});

test('patterns: add, clone, shrink, remove (and the song follows)', () => {
  const doc = new Y.Doc();
  S.seedProject(doc);
  const first = S.readProject(doc).patterns[0];
  const copy = S.clonePattern(doc, first.id);
  let p = S.readProject(doc);
  assert.equal(p.patterns.length, 2);
  assert.equal(p.patterns[1].id, copy);
  assert.equal(p.patterns[1].steps.size, first.steps.size);
  assert.equal(p.patterns[1].notes.length, first.notes.length);

  S.setPattern(doc, copy, { bars: 2 });
  S.addNote(doc, copy, { ch: 'x', p: 60, s: 20, l: 8 });
  S.setPattern(doc, copy, { bars: 1 });
  assert.ok(S.readProject(doc).patterns[1].notes.every((n) => n.s + n.l <= 16));

  S.songAppend(doc, copy);
  S.songAppend(doc, first.id);
  assert.equal(S.readProject(doc).song.length, 3);
  S.removePattern(doc, copy);
  p = S.readProject(doc);
  assert.deepEqual(p.song, [first.id, first.id]);
  assert.equal(S.removePattern(doc, first.id), false, 'the last pattern stays');
});

test('undo only reverts your own edits', () => {
  const [a, b] = peers();
  const undo = new Y.UndoManager(S.undoScope(a));
  const pid = S.readProject(a).patterns[0].id;
  const ch = S.readProject(a).channels[0].id;
  S.setStep(a, pid, ch, 1, 100); // mine
  S.setStep(b, pid, ch, 2, 100); // theirs
  sync(a, b);
  undo.undo();
  const steps = S.readProject(a).patterns[0].steps;
  assert.ok(!steps.has(`${ch}:1`), 'my step is undone');
  assert.ok(steps.has(`${ch}:2`), "their step is untouched");
});

test('meta values are validated', () => {
  const doc = new Y.Doc();
  S.seedProject(doc);
  S.setMeta(doc, { bpm: 9999, title: 'x'.repeat(200) });
  const p = S.readProject(doc);
  assert.equal(p.bpm, 300);
  assert.equal(p.title.length, 60);
});

test('sample channels: add, replace, and switch between steps and keys', () => {
  const doc = new Y.Doc();
  S.seedProject(doc);
  const id = S.addSampleChannel(doc, { id: 'a'.repeat(64), name: '808 Boom.wav' });
  let c = S.readProject(doc).channels.find((x) => x.id === id);
  assert.equal(c.inst, 'sample');
  assert.equal(c.name, '808 Boom');
  assert.equal(c.sample.id, 'a'.repeat(64));
  S.setChannel(doc, id, { inst: 'samplekeys' });
  assert.equal(S.readProject(doc).channels.find((x) => x.id === id).inst, 'samplekeys');

  // A built-in channel can't be switched to a sample instrument without a sample...
  const kick = S.readProject(doc).channels[0].id;
  S.setChannel(doc, kick, { inst: 'sample' });
  assert.equal(S.readProject(doc).channels[0].inst, 'kick');
  // ...but dropping a sample on it does.
  S.setChannelSample(doc, kick, { id: 'b'.repeat(64), name: 'kick2.wav' });
  c = S.readProject(doc).channels[0];
  assert.equal(c.inst, 'sample');
  assert.equal(c.sample.name, 'kick2.wav');
});

test('plugin channels and effects', () => {
  const doc = new Y.Doc();
  S.seedProject(doc);
  assert.throws(() => S.addPluginChannel(doc, { url: 'javascript:alert(1)', name: 'x' }));
  assert.equal(S.cleanPluginUrl('//evil.example/x.js'), null);
  assert.equal(S.cleanPluginUrl('/\\evil.example/x.js'), null, 'browsers treat /\\ like //');
  const id = S.addPluginChannel(doc, { url: '/wam/coprod-acid/index.js', name: 'Acid' });
  const c = () => S.readProject(doc).channels.find((x) => x.id === id);
  assert.equal(c().inst, 'wam');
  assert.ok(S.isSynth('wam'));

  S.setPluginState(doc, id, { cutoff: 0.4 });
  assert.deepEqual(c().pluginState, { cutoff: 0.4 });
  S.setPluginState(doc, id, { blob: 'x'.repeat(S.MAX_PLUGIN_STATE) });
  assert.deepEqual(c().pluginState, { cutoff: 0.4 }, 'oversized states are not shared');

  const a = S.addEffect(doc, id, { url: '/wam/coprod-echo/index.js', name: 'Echo' });
  const b = S.addEffect(doc, id, { url: 'https://example.com/fx/index.js', name: 'Fuzz' });
  assert.deepEqual(c().fx.map((f) => f.name), ['Echo', 'Fuzz']);
  S.setEffect(doc, id, a, { on: false, state: { time: 0.3 } });
  assert.equal(c().fx[0].on, false);
  assert.deepEqual(c().fx[0].state, { time: 0.3 });
  S.removeEffect(doc, id, b);
  assert.deepEqual(c().fx.map((f) => f.id), [a]);
  assert.equal(S.addEffect(doc, id, { url: 'ftp://x/y' }), null);
});

test('two people adding effects at once keeps both', () => {
  const [a, b] = peers();
  const ch = S.readProject(a).channels[0].id;
  S.addEffect(a, ch, { url: '/wam/coprod-echo/index.js', name: 'Echo' });
  S.addEffect(b, ch, { url: '/wam/x/index.js', name: 'Other' });
  sync(a, b);
  same(a, b);
  assert.equal(S.readProject(a).channels[0].fx.length, 2);
});
