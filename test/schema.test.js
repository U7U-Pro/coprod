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
  S.setPluginState(doc, id, { cutoff: 0.5, blob: 'x'.repeat(S.MAX_PLUGIN_STATE) });
  assert.deepEqual(c().pluginState, { cutoff: 0.5 }, 'an oversized key is dropped, the rest is shared');

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

test('plugin state syncs per key: a knob turn does not resend a big wavetable', () => {
  const [a, b] = peers();
  const id = S.addPluginChannel(a, { url: '/wam/vertex/index.js', name: 'Vertex' });
  const table = 'x'.repeat(90_000);
  S.setPluginState(a, id, { params: { cutoff: 0.5 }, tables: { a: table } });
  sync(a, b);
  const before = Y.encodeStateVector(b);
  S.setPluginState(a, id, { params: { cutoff: 0.6 }, tables: { a: table } });
  const update = Y.encodeStateAsUpdate(a, before);
  assert.ok(update.length < 500, `knob change sent ${update.length} bytes`);
  Y.applyUpdate(b, update, 'remote');
  const st = S.readProject(b).channels.find((c) => c.id === id).pluginState;
  assert.equal(st.params.cutoff, 0.6);
  assert.equal(st.tables.a.length, 90_000);
});

test('effect state is per key too, and removing an effect clears it', () => {
  const doc = new Y.Doc();
  S.seedProject(doc);
  const ch = S.readProject(doc).channels[0].id;
  const fx = S.addEffect(doc, ch, { url: '/wam/coprod-echo/index.js', name: 'Echo' });
  S.setEffect(doc, ch, fx, { state: { time: 2, mix: 0.4 } });
  assert.deepEqual(S.readProject(doc).channels[0].fx[0].state, { time: 2, mix: 0.4 });
  S.setEffect(doc, ch, fx, { state: { time: 3, mix: 0.4 } });
  assert.deepEqual(S.readProject(doc).channels[0].fx[0].state, { time: 3, mix: 0.4 });
  S.removeEffect(doc, ch, fx);
  assert.equal(doc.getArray('channels').get(0).get('fxstate').size, 0);
});

test('automation lanes: points, interpolation, merge, cleanup', () => {
  const [a, b] = peers();
  const p = S.readProject(a);
  const pid = p.patterns[0].id;
  const ch = p.channels[0].id;
  const lane = S.addLane(a, pid, ch, 'vol', 'Kick: Volume');
  assert.equal(S.addLane(a, pid, ch, 'vol'), lane, 'one lane per target');
  assert.equal(S.addLane(a, pid, ch, 'bad target!'), null);
  S.setPoint(a, pid, lane, null, { s: 0, v: 0 });
  const mid = S.setPoint(a, pid, lane, null, { s: 8, v: 1 });
  sync(a, b);
  // Both people add points at once; both survive.
  S.setPoint(a, pid, lane, null, { s: 4, v: 0.25 });
  S.setPoint(b, pid, lane, null, { s: 12, v: 0.5 });
  sync(a, b);
  same(a, b);
  const pts = S.readProject(a).patterns[0].lanes[0].points;
  assert.deepEqual(pts.map((x) => x.s), [0, 4, 8, 12]);
  assert.equal(S.laneValueAt(pts, 2), 0.125);
  assert.equal(S.laneValueAt(pts, 6), 0.625);
  assert.equal(S.laneValueAt(pts, 15), 0.5, 'held after the last point');
  assert.equal(S.laneValueAt([], 3), null);

  S.setPoint(a, pid, lane, mid, { s: 9, v: 2 });
  assert.equal(S.readProject(a).patterns[0].lanes[0].points.find((x) => x.id === mid).v, 1, 'clamped');

  const copy = S.clonePattern(a, pid);
  assert.equal(S.readProject(a).patterns.find((x) => x.id === copy).lanes[0].points.length, 4, 'clones keep automation');

  S.removeChannel(a, ch);
  assert.equal(S.readProject(a).patterns[0].lanes.length, 0, 'deleting the channel deletes its lanes');
  assert.equal(a.getArray('patterns').get(0).get('autoPts').size, 0);
});

test('pitch bend lanes carry a range', () => {
  const doc = new Y.Doc();
  S.seedProject(doc);
  const p = S.readProject(doc);
  const lane = S.addLane(doc, p.patterns[0].id, p.channels[4].id, 'bend', 'Pitch bend');
  const get = () => S.readProject(doc).patterns[0].lanes.find((l) => l.id === lane);
  assert.equal(get().range, 2, 'MIDI-standard ±2 semitones by default');
  S.setLane(doc, p.patterns[0].id, lane, { range: 12 });
  assert.equal(get().range, 12);
  S.setLane(doc, p.patterns[0].id, lane, { range: 13 });
  assert.equal(get().range, 12, 'only listed ranges');
});

test('automation curves: shapes, per-segment settings, moving keeps the curve', () => {
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  assert.ok(near(S.curveShape('single', 0, 0.5), 0.5), 'single at 0 is linear');
  assert.ok(S.curveShape('single', 0.5, 0.5) < 0.2, 'positive tension starts slow');
  assert.ok(S.curveShape('single', -0.5, 0.5) > 0.8, 'negative tension starts fast');
  assert.ok(near(S.curveShape('double', 0.7, 0.5), 0.5) && S.curveShape('double', 0.7, 0.25) < 0.1, 'S-curve');
  assert.deepEqual([0, 0.5, 0.99, 1].map((x) => S.curveShape('hold', 0, x)), [0, 0, 0, 1]);
  assert.deepEqual([0, 0.3, 0.6, 0.9].map((x) => +S.curveShape('stairs', 0, x).toFixed(3)), [0, 0.333, 0.667, 1]);
  assert.equal(S.curveCount(-1), 1);
  assert.equal(S.curveCount(0), 4);
  assert.equal(S.curveCount(1), 32);
  assert.deepEqual([0.1, 0.3].map((x) => S.curveShape('pulse', -1, x)).concat(S.curveShape('pulse', -1, 0.6)), [0, 0, 1]);
  assert.ok(near(S.curveShape('wave', -1, 0.5), 1) && near(S.curveShape('wave', -1, 0), 0));

  const doc = new Y.Doc();
  S.seedProject(doc);
  const p = S.readProject(doc);
  const pid = p.patterns[0].id;
  const lane = S.addLane(doc, pid, p.channels[0].id, 'vol');
  const a = S.setPoint(doc, pid, lane, null, { s: 0, v: 0 });
  S.setPoint(doc, pid, lane, null, { s: 8, v: 1 });
  S.setCurve(doc, pid, lane, a, { c: 'stairs', t: 0 });
  const pts = () => S.readProject(doc).patterns[0].lanes[0].points;
  assert.equal(pts()[0].c, 'stairs');
  assert.ok(near(S.laneValueAt(pts(), 3), 1 / 3), 'value follows the stairs');
  S.setPoint(doc, pid, lane, a, { s: 1, v: 0.1 });
  assert.equal(pts()[0].c, 'stairs', 'moving a point keeps its curve');
  S.setCurve(doc, pid, lane, a, { t: 5 });
  assert.equal(pts()[0].t, 1, 'amount clamped');
  S.setCurve(doc, pid, lane, a, { c: 'nope' });
  assert.equal(pts()[0].c, 'stairs', 'unknown curve types ignored');
  S.setCurve(doc, pid, lane, a, { c: 'single', t: 0 });
  assert.equal(pts()[0].c, 'single', 'back to linear');
  assert.equal(S.segmentAt(pts(), 0.5), -1);
  assert.equal(S.segmentAt(pts(), 4), 0);
  assert.equal(S.segmentAt(pts(), 9), 1);
});

test('notes carry an optional lyric; phonemes only with valid ARPAbet', () => {
  const doc = new Y.Doc();
  S.seedProject(doc);
  const pid = S.readProject(doc).patterns[0].id;
  const ch = S.addPluginChannel(doc, { url: '/wam/vocalist/index.js', name: 'Vocalist' });
  const id = S.addNote(doc, pid, { ch, p: 60, s: 0, l: 2, ly: '  hel\u0000lo  ', ph: 'HH  ah' });
  const note = () => S.readProject(doc).patterns[0].notes.find((n) => n.id === id);
  assert.equal(note().ly, 'hello');
  assert.equal(note().ph, 'hh ah');
  S.setLyric(doc, pid, id, 'x'.repeat(100), '<script>');
  assert.equal(note().ly.length, 32);
  assert.equal(note().ph, undefined);
  S.updateNote(doc, pid, id, { s: 4 }); // moving keeps the lyric
  assert.equal(note().ly.length, 32);
  S.setLyric(doc, pid, id, '');
  assert.equal(note().ly, undefined);
});

test('assignLyrics: one syllable per note in time order; splits long notes or adds notes', () => {
  const [a, b] = peers();
  const pid = S.readProject(a).patterns[0].id;
  const ch = S.addPluginChannel(a, { url: '/wam/vocalist/index.js', name: 'Vocalist' });
  const mine = (doc) => S.readProject(doc).patterns[0].notes.filter((n) => n.ch === ch).sort((x, y) => x.s - y.s);
  // Two half-bar notes, four syllables: each note is cut in two.
  S.addNote(a, pid, { ch, p: 64, s: 8, l: 8 });
  S.addNote(a, pid, { ch, p: 60, s: 0, l: 8 });
  const syl = ['twin', 'kle', 'lit', 'tle'].map((ly, i) => ({ ly, ph: ['t w ih ng', 'k ah l', 'l ih', 't ah l'][i] }));
  let r = S.assignLyrics(a, pid, ch, syl);
  assert.deepEqual(r, { assigned: 4, split: 2, added: 0, dropped: 0, cleared: 0 });
  assert.deepEqual(mine(a).map((n) => [n.s, n.l, n.p, n.ly, n.ph]), [
    [0, 4, 60, 'twin', 't w ih ng'],
    [4, 4, 60, 'kle', 'k ah l'],
    [8, 4, 64, 'lit', 'l ih'],
    [12, 4, 64, 'tle', 't ah l'],
  ]);
  sync(a, b);
  assert.deepEqual(mine(b).map((n) => n.ly), ['twin', 'kle', 'lit', 'tle']);

  // Fewer syllables: the extra notes lose their lyric.
  r = S.assignLyrics(a, pid, ch, [{ ly: 'oh' }, { ly: '-' }]);
  assert.equal(r.cleared, 2);
  assert.deepEqual(mine(a).map((n) => n.ly ?? null), ['oh', '-', null, null]);

  // "add" mode: new 2-step notes after the last one, growing the pattern.
  const many = Array.from({ length: 12 }, (_, i) => ({ ly: `s${i}` }));
  r = S.assignLyrics(a, pid, ch, many, { fill: 'add' });
  assert.equal(r.added, 8);
  assert.equal(S.readProject(a).patterns[0].bars, 2);
  assert.deepEqual(mine(a).slice(4).map((n) => [n.s, n.l, n.p]), [16, 18, 20, 22, 24, 26, 28, 30].map((s) => [s, 2, 64]));

  // A channel with no notes gets new ones from the start; patterns stop at 4 bars.
  const ch2 = S.addPluginChannel(a, { url: '/wam/vocalist/index.js', name: 'Vocalist 2' });
  r = S.assignLyrics(a, pid, ch2, Array.from({ length: 40 }, () => ({ ly: 'la' })));
  assert.equal(S.readProject(a).patterns[0].bars, 4);
  assert.deepEqual([r.added, r.dropped], [32, 8]);
});

test('assignLyrics: chords sing the top note first; split respects one step per syllable', () => {
  const doc = new Y.Doc();
  S.seedProject(doc);
  const pid = S.readProject(doc).patterns[0].id;
  const ch = S.addPluginChannel(doc, { url: '/wam/vocalist/index.js', name: 'V' });
  S.addNote(doc, pid, { ch, p: 60, s: 0, l: 1 });
  S.addNote(doc, pid, { ch, p: 67, s: 0, l: 1 });
  S.addNote(doc, pid, { ch, p: 62, s: 1, l: 3 });
  const r = S.assignLyrics(doc, pid, ch, ['a', 'b', 'c', 'd', 'e', 'f'].map((ly) => ({ ly })));
  const notes = S.readProject(doc).patterns[0].notes.filter((n) => n.ch === ch).sort((x, y) => x.s - y.s || y.p - x.p);
  assert.deepEqual(notes.map((n) => `${n.s}:${n.p}:${n.ly}`), ['0:67:a', '0:60:b', '1:62:c', '2:62:d', '3:62:e', '4:62:f']);
  assert.equal(r.split, 1); // the 3-step note became three 1-step notes
  assert.equal(r.added, 1); // the last syllable needed a new note
});
