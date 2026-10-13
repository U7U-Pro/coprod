// Vertex synth engine, rendered offline and measured.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VertexEngine } from '../public/wam/vertex/engine.js';
import { INDEX as I, PARAMS } from '../public/wam/vertex/params.js';
import * as WT from '../public/wam/vertex/wavetables.js';

const SR = 48000;
const tables = new Map();
function table(name) {
  if (!tables.has(name)) {
    const { frames, count } = WT.framesFromSpec({ kind: 'builtin', name });
    tables.set(name, WT.buildMips(frames, count));
  }
  return tables.get(name);
}

/** A fresh engine; `set` takes real parameter values (unmapped for you). */
function synth(set = {}, tableName = 'Basic Shapes') {
  const e = new VertexEngine(SR);
  e.setTable(0, table(tableName));
  e.setTable(1, table(tableName));
  for (const [id, v] of Object.entries(set)) {
    const p = PARAMS[I[id]];
    e.setParam(I[id], p.unmap ? p.unmap(v) : v);
  }
  return e;
}

function render(e, seconds) {
  const n = Math.round(SR * seconds);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  e.process(L, R, n);
  return { L, R };
}

const rms = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / Math.max(1, a.length));

/** Magnitude of frequency `f` in signal `a` (Goertzel). */
function mag(a, f) {
  const w = (2 * Math.PI * f) / SR;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < a.length; i++) {
    const s0 = a[i] + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2) / (a.length / 2);
}

function zeroCrossHz(a) {
  let c = 0;
  for (let i = 1; i < a.length; i++) if (a[i - 1] < 0 && a[i] >= 0) c++;
  return c / (a.length / SR);
}

/** Level of harmonics 10-20 of `f0` relative to the fundamental. */
function brightness(a, f0) {
  let hi = 0;
  for (let h = 10; h <= 20; h++) hi += mag(a, h * f0) ** 2;
  return Math.sqrt(hi) / mag(a, f0);
}

/** Energy above `f` Hz relative to total, via a crude one-pole high-pass. */
function highShare(a, f) {
  const k = Math.exp((-2 * Math.PI * f) / SR);
  let lp = 0;
  let hi = 0;
  let all = 0;
  for (const x of a) {
    lp = x + (lp - x) * k;
    const h = x - lp;
    hi += h * h;
    all += x * x;
  }
  return hi / Math.max(1e-12, all);
}

test('plays a sine at the right pitch, and octave/semitone shifts work', () => {
  const e = synth({ a_pos: 0, flt_on: false });
  e.noteOn(69, 100);
  const a = render(e, 0.5).L.slice(SR * 0.1);
  assert.ok(Math.abs(zeroCrossHz(a) - 440) < 3, `A4 measured ${zeroCrossHz(a)} Hz`);

  const up = synth({ a_pos: 0, flt_on: false, a_oct: 1, a_semi: 7 });
  up.noteOn(57, 100); // A3 + 1 octave + 7 semitones = E5
  const b = render(up, 0.5).L.slice(SR * 0.1);
  assert.ok(Math.abs(zeroCrossHz(b) - 659.26) < 4, `E5 measured ${zeroCrossHz(b)} Hz`);
});

test('wavetable position morphs the timbre (sine -> square)', () => {
  const sine = synth({ a_pos: 0, flt_on: false });
  sine.noteOn(57, 100);
  const s = render(sine, 0.4).L.slice(SR * 0.1);
  const square = synth({ a_pos: 1, flt_on: false });
  square.noteOn(57, 100);
  const q = render(square, 0.4).L.slice(SR * 0.1);
  const third = (a) => mag(a, 660) / mag(a, 220);
  assert.ok(third(s) < 0.02, `sine has no 3rd harmonic (${third(s).toFixed(3)})`);
  assert.ok(Math.abs(third(q) - 1 / 3) < 0.05, `square's 3rd harmonic is ~1/3 (${third(q).toFixed(3)})`);
});

test('high notes are band-limited (no aliasing)', () => {
  // A saw at ~3.5 kHz: real harmonics are multiples of f0; aliases would land between them.
  const e = synth({ a_pos: 2 / 3, flt_on: false });
  e.noteOn(105, 100);
  const a = render(e, 0.3).L.slice(SR * 0.05);
  const f0 = 440 * 2 ** ((105 - 69) / 12);
  const harmonic = [1, 2, 3, 4, 5, 6].reduce((s, h) => (h * f0 < SR / 2 ? s + mag(a, h * f0) ** 2 : s), 0);
  let alias = 0;
  for (let f = 300; f < SR / 2; f += 137) {
    const nearest = Math.round(f / f0) * f0;
    if (Math.abs(f - nearest) > 200) alias += mag(a, f) ** 2;
  }
  assert.ok(alias / harmonic < 0.001, `alias energy ratio ${(alias / harmonic).toExponential(2)}`);
});

test('unison detune spreads the fundamental', () => {
  const one = synth({ a_pos: 0, flt_on: false, a_unison: 1 });
  one.noteOn(69, 100);
  const a = render(one, 1).L.slice(SR * 0.2);
  const many = synth({ a_pos: 0, flt_on: false, a_unison: 7, a_detune: 1 });
  many.noteOn(69, 100);
  const b = render(many, 1).L.slice(SR * 0.2);
  const centerShare = (x) => mag(x, 440) / rms(x);
  assert.ok(centerShare(b) < centerShare(a) * 0.6, 'energy moves away from exactly 440 Hz');
  assert.ok(rms(b) > 0.05, 'still audible');
});

test('the low-pass filter removes highs; resonance boosts the cutoff', () => {
  const open = synth({ a_pos: 2 / 3, flt_on: false });
  open.noteOn(45, 100);
  const a = render(open, 0.5).L.slice(SR * 0.1);
  const closed = synth({ a_pos: 2 / 3, flt_type: 1, flt_cutoff: 400, flt_res: 0 });
  closed.noteOn(45, 100);
  const b = render(closed, 0.5).L.slice(SR * 0.1);
  assert.ok(brightness(b, 110) < brightness(a, 110) / 10, `at least 20 dB less treble (${brightness(a, 110).toFixed(3)} -> ${brightness(b, 110).toExponential(1)})`);

  const reso = synth({ a_pos: 2 / 3, flt_type: 0, flt_cutoff: 990, flt_res: 0.95 });
  reso.noteOn(45, 100); // 110 Hz saw: the 9th harmonic sits at the cutoff
  const c = render(reso, 0.5).L.slice(SR * 0.1);
  assert.ok(mag(c, 990) / mag(c, 110) > mag(a, 990) / mag(a, 110) * 3, 'resonant peak at the cutoff');
});

test('envelope: slow attack, sustain, release frees the voice', () => {
  const e = synth({ a_pos: 0, flt_on: false, env1_a: 0.4, env1_s: 0.5, env1_d: 0.1, env1_r: 0.2 });
  e.noteOn(60, 100);
  const on = render(e, 1).L;
  const early = rms(on.slice(0, SR * 0.05));
  const sustain = rms(on.slice(SR * 0.7, SR * 0.9));
  assert.ok(early < sustain * 0.3, 'quiet at the start of the attack');
  e.noteOff(60);
  const off = render(e, 0.5).L;
  assert.ok(rms(off.slice(SR * 0.3)) < 1e-4, 'silent after the release');
  assert.equal(e.activeVoices(), 0);
});

test('an LFO routed to cutoff makes the brightness move', () => {
  const e = synth({ a_pos: 2 / 3, a_rand: 0, flt_type: 1, flt_cutoff: 300, lfo1_sync: false, lfo1_rate: 2 });
  e.setRoutes([{ src: 'lfo1', dst: 'flt_cutoff', amt: 0.6 }]);
  e.noteOn(45, 100);
  const a = render(e, 1).L;
  const chunks = [];
  for (let t = 0; t < 1; t += 1 / 64) chunks.push(brightness(a.slice(SR * t, SR * (t + 1 / 64)), 110));
  assert.ok(Math.max(...chunks) > Math.min(...chunks) * 5, `brightness varies over the LFO cycle (${Math.min(...chunks).toExponential(1)}..${Math.max(...chunks).toExponential(1)})`);
});

test('mono legato with glide slides between notes', () => {
  const e = synth({ a_pos: 0, flt_on: false, poly: 1, legato: true, glide: 0.3 });
  e.noteOn(57, 100); // 220 Hz
  render(e, 0.3);
  e.noteOn(69, 100); // 440 Hz, legato
  const a = render(e, 1).L;
  const start = zeroCrossHz(a.slice(0, SR * 0.03));
  const end = zeroCrossHz(a.slice(SR * 0.8));
  assert.ok(start < 330, `starts low (${start} Hz)`);
  assert.ok(Math.abs(end - 440) < 5, `arrives at 440 (${end} Hz)`);
  assert.equal(e.activeVoices(), 1);
});

test('polyphony limit', () => {
  const e = synth({ poly: 2 });
  for (const n of [60, 64, 67, 72]) e.noteOn(n, 100);
  render(e, 0.05);
  assert.equal(e.activeVoices(), 2);
  const f = synth({ poly: 8 });
  for (const n of [60, 64, 67, 72]) f.noteOn(n, 100);
  render(f, 0.05);
  assert.equal(f.activeVoices(), 4);
});

test('effects: delay echoes, reverb has a tail, distortion adds harmonics', () => {
  const pluck = { a_pos: 0, flt_on: false, env1_a: 0, env1_d: 0.05, env1_s: 0, env1_r: 0.02 };
  const dry = synth(pluck);
  dry.noteOn(69, 100);
  const d = render(dry, 1).L;
  const wet = synth({ ...pluck, delay_on: true, delay_sync: false, delay_time: 0.3, delay_mix: 0.5, delay_pp: false });
  wet.noteOn(69, 100);
  const w = render(wet, 1).L;
  const at = (a, t) => rms(a.slice(SR * t, SR * (t + 0.03)));
  assert.ok(at(w, 0.3) > at(d, 0.3) * 20, 'an echo 300 ms later');

  const verb = synth({ ...pluck, reverb_on: true, reverb_mix: 0.5, reverb_size: 0.8 });
  verb.noteOn(69, 100);
  const v = render(verb, 1.5).L;
  assert.ok(rms(v.slice(SR * 0.8, SR * 1.2)) > 1e-3 && rms(d.slice(SR * 0.8)) < 1e-5, 'reverb tail after the note');

  const clean = synth({ a_pos: 0, flt_on: false });
  clean.noteOn(57, 100);
  const c = render(clean, 0.3).L.slice(SR * 0.1);
  const dirty = synth({ a_pos: 0, flt_on: false, dist_on: true, dist_drive: 0.6 });
  dirty.noteOn(57, 100);
  const x = render(dirty, 0.3).L.slice(SR * 0.1);
  assert.ok(mag(x, 660) / mag(x, 220) > 10 * (mag(c, 660) / mag(c, 220) + 1e-4), 'odd harmonics from soft clipping');
});

test('effects: EQ cuts, compressor tames peaks, all effects stay finite', () => {
  const base = { a_pos: 2 / 3, flt_on: false };
  const plain = synth(base);
  plain.noteOn(40, 100);
  const p = render(plain, 0.5).L.slice(SR * 0.1);
  const cut = synth({ ...base, eq_on: true, eq_lowg: -24, eq_lowf: 300 });
  cut.noteOn(40, 100);
  const c = render(cut, 0.5).L.slice(SR * 0.1);
  assert.ok(mag(c, 82.4) < mag(p, 82.4) / 4, 'low shelf cut');

  const comp = synth({ ...base, comp_on: true, comp_thresh: -30, comp_ratio: 10 });
  comp.noteOn(40, 100);
  const k = render(comp, 0.5).L.slice(SR * 0.2);
  assert.ok(rms(k) < rms(p) * 0.6, 'compressed');

  const all = synth({ ...base, a_unison: 5, b_on: true, sub_on: true, noise_on: true, dist_on: true, chorus_on: true, flanger_on: true, phaser_on: true, delay_on: true, reverb_on: true, comp_on: true, comp_mode: 1, eq_on: true });
  for (const n of [48, 55, 60, 64]) all.noteOn(n, 120);
  const out = render(all, 1);
  assert.ok(out.L.every(Number.isFinite) && out.R.every(Number.isFinite));
  assert.ok(rms(out.L) > 0.01 && rms(out.L) < 2);
});

test('host automation overrides a parameter until cleared', () => {
  const e = synth({ a_pos: 2 / 3, flt_type: 1, flt_cutoff: 20000 });
  e.noteOn(45, 100);
  const open = render(e, 0.3).L.slice(SR * 0.1);
  e.setAutomation(I.flt_cutoff, PARAMS[I.flt_cutoff].unmap(300));
  render(e, 0.05);
  const closed = render(e, 0.3).L.slice(SR * 0.1);
  assert.ok(brightness(closed, 110) < brightness(open, 110) / 10, 'automation closed the filter');
  e.clearAutomation();
  render(e, 0.05);
  const back = render(e, 0.3).L.slice(SR * 0.1);
  assert.ok(brightness(back, 110) > brightness(closed, 110) * 10, 'and it opens again when cleared');
});

test('wavetable formulas: real parser, no code execution', () => {
  const f = WT.compileFormula('sin(2*pi*x) * (1 - y) + saw(x) * y');
  assert.ok(Math.abs(f(0.25, 0) - 1) < 1e-9);
  for (const bad of ['alert(1)', 'constructor', 'x.constructor', 'this', '(()=>1)()', 'process', 'sin(x', '1 +']) {
    assert.throws(() => WT.compileFormula(bad), undefined, bad);
  }
  const { frames, count } = WT.framesFromFormula('sq(x * (1 + y * 3))', 8);
  assert.equal(count, 8);
  assert.equal(frames.length, 8 * WT.EDIT_SIZE);
});

test('custom tables round-trip through their compact saved form', () => {
  const { frames, count } = WT.framesFromFormula('sin(2*pi*x) + 0.3*sin(6*pi*x*(1+y))', 16);
  const spec = WT.customSpec('test', frames, count);
  assert.ok(spec.data.length < 30000, `${spec.data.length} chars for 16 frames`);
  const back = WT.editFramesFromSpec(spec);
  let err = 0;
  for (let i = 0; i < frames.length; i++) err = Math.max(err, Math.abs(back.frames[i] - frames[i]));
  assert.ok(err < 1e-3, `max error ${err}`);
  const played = WT.framesFromSpec(spec);
  assert.equal(played.count, 16);
  assert.equal(played.frames.length, 16 * WT.SIZE);
});

test('audio import slices a sound into frames', () => {
  const samples = new Float32Array(48000).map((_, i) => Math.sin((2 * Math.PI * 220 * i) / 48000) * (i / 48000));
  const { frames, count } = WT.framesFromAudio(samples, 32);
  assert.equal(count, 32);
  assert.ok(frames.every(Number.isFinite));
});

test('every factory preset makes sound and stays finite', async () => {
  const { PRESETS, presetState } = await import('../public/wam/vertex/presets.js');
  const { DEFAULTS } = await import('../public/wam/vertex/params.js');
  for (const preset of PRESETS) {
    const s = presetState(preset);
    const e = new VertexEngine(SR);
    const values = Float32Array.from(DEFAULTS);
    for (const [id, v] of Object.entries(s.params)) values[I[id]] = v;
    e.setParams(values);
    e.setRoutes(s.routes);
    e.setTable(0, table(s.tables.a.name));
    e.setTable(1, table(s.tables.b.name));
    for (const n of [48, 55, 60]) e.noteOn(n, 100);
    const out = render(e, 1.5);
    assert.ok(out.L.every(Number.isFinite) && out.R.every(Number.isFinite), `${preset.name}: finite`);
    const level = rms(out.L.slice(SR * 0.5));
    assert.ok(level > 0.005 && level < 1.5, `${preset.name}: level ${level.toFixed(3)}`);
  }
});

test('user presets: save, overwrite, delete, export/import', async () => {
  const P = await import('../public/wam/vertex/presets.js');
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const state = { v: 1, name: 'x', params: { flt_cutoff: 0.3 }, routes: [], lfo: {}, tables: {}, fxOrder: null };
  assert.equal(P.saveUserPreset('  ', state, storage).ok, false, 'needs a name');
  assert.ok(P.saveUserPreset('My Bass', state, storage).ok);
  assert.ok(P.saveUserPreset('A Lead', { ...state, params: { a_pos: 1 } }, storage).ok);
  assert.ok(P.saveUserPreset('My Bass', { ...state, params: { flt_cutoff: 0.9 } }, storage).ok, 'overwrite');
  const list = P.userPresets(storage);
  assert.deepEqual(list.map((p) => p.name), ['A Lead', 'My Bass']);
  assert.equal(list[1].state.params.flt_cutoff, 0.9);
  assert.equal(list[1].state.name, 'My Bass');
  P.deleteUserPreset('A Lead', storage);
  assert.deepEqual(P.userPresets(storage).map((p) => p.name), ['My Bass']);

  const file = P.presetFile(list[1].state);
  const back = P.parsePresetFile(file);
  assert.equal(back.name, 'My Bass');
  assert.equal(back.params.flt_cutoff, 0.9);
  assert.throws(() => P.parsePresetFile('{"hello":1}'), /not a Vertex preset/);
  assert.throws(() => P.parsePresetFile('not json'), /not a Vertex preset/);

  const full = { getItem: () => '[]', setItem: () => { throw new Error('QuotaExceededError'); } };
  assert.match(P.saveUserPreset('x', state, full).error, /storage is full/);
});
