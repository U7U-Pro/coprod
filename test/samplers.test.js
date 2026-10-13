// Slicer and Grains engines, rendered offline and measured.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SlicerEngine } from '../public/wam/slicer/engine.js';
import { TABLE as SL, SYNC_BEATS } from '../public/wam/slicer/params.js';
import { GrainsEngine } from '../public/wam/grains/engine.js';
import { TABLE as GR } from '../public/wam/grains/params.js';
import { detectOnsets, demoBreak, demoTexture, gridSlices } from '../public/wam/kit/dsp.js';

const SR = 48000;

function set(engine, table, values) {
  for (const [id, v] of Object.entries(values)) {
    const p = table.PARAMS[table.INDEX[id]];
    engine.setParam(table.INDEX[id], p.unmap(v));
  }
}

function render(e, seconds, events = []) {
  const n = Math.round(seconds * SR);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const queue = [...events].sort((a, b) => a.at - b.at);
  for (let off = 0; off < n; off += 32) {
    while (queue.length && queue[0].at * SR < off + 32) queue.shift().run(e);
    e.render(L, R, off, Math.min(32, n - off));
  }
  return { L, R };
}

const rms = (a, from = 0, to = a.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, to - from));
};
const on = (at, note, vel = 127) => ({ at, run: (e) => e.noteOn(note, vel) });
const off = (at, note) => ({ at, run: (e) => e.noteOff(note) });

// ------------------------------------------------------------------ helpers

test('demo sounds are deterministic, so every collaborator hears the same', () => {
  const a = demoBreak(SR);
  const b = demoBreak(SR);
  assert.deepEqual(a.L.slice(0, 5000), b.L.slice(0, 5000));
  assert.equal(a.L.length, 4 * SR); // 2 bars at 120 BPM
  assert.equal(a.hits[0], 0);
  const t = demoTexture(SR);
  assert.ok(rms(t.L) > 0.05);
});

test('hit detection finds the demo break’s hits', () => {
  const d = demoBreak(SR);
  const found = detectOnsets(d.L, d.R, SR, 0.6);
  assert.equal(found[0], 0);
  // Every loud hit (kicks and snares) is found within 12 ms.
  const loud = [0, 7, 10, 16, 26, 30, 4, 12, 20, 28].map((s) => s * 0.125);
  for (const t of loud) assert.ok(found.some((f) => Math.abs(f - t) < 0.012), `hit at ${t}s not found in ${found.map((f) => f.toFixed(3))}`);
  // Low sensitivity finds fewer.
  assert.ok(detectOnsets(d.L, d.R, SR, 0).length <= found.length);
  assert.ok(detectOnsets(d.L, d.R, SR, 1, 8).length <= 8);
});

test('grid slices are equal', () => {
  assert.deepEqual(gridSlices(2, 4), [0, 0.5, 1, 1.5]);
});

// ------------------------------------------------------------------ slicer

/** A buffer of 4 tones (one per half second) so slices are recognizable. */
function tones() {
  const L = new Float32Array(2 * SR);
  const freqs = [200, 400, 800, 1600];
  for (let i = 0; i < L.length; i++) L[i] = 0.5 * Math.sin((2 * Math.PI * freqs[Math.floor(i / (SR / 2))] * i) / SR);
  return L;
}
const quarters = (extra = {}) => [0, 0.5, 1, 1.5].map((start) => ({ start, end: start + 0.5, ...extra }));

/** Zero crossings per second ≈ 2 × frequency. */
function freq(a, from, to) {
  let z = 0;
  for (let i = from + 1; i < to; i++) if (a[i - 1] <= 0 && a[i] > 0) z++;
  return (z * SR) / (to - from);
}

function slicer(values = {}) {
  const e = new SlicerEngine(SR);
  const L = tones();
  e.setBuffer(L, L);
  e.setSlices(quarters());
  set(e, SL, values);
  return e;
}

test('slicer: each note plays its own slice, from C4 up', () => {
  for (const [i, f] of [200, 400, 800, 1600].entries()) {
    const { L } = render(slicer(), 0.4, [on(0, 60 + i)]);
    assert.ok(Math.abs(freq(L, 1000, 18000) - f) < f * 0.03, `slice ${i}: ${freq(L, 1000, 18000)} Hz`);
  }
  // Below C4, or past the last slice: nothing.
  assert.equal(rms(render(slicer(), 0.2, [on(0, 59)]).L), 0);
  assert.equal(rms(render(slicer(), 0.2, [on(0, 64)]).L), 0);
});

test('slicer: a slice stops at its end (no bleed into the next)', () => {
  const { L } = render(slicer(), 1, [on(0, 60)]);
  assert.ok(rms(L, 1000, 20000) > 0.2);
  assert.equal(rms(L, Math.round(0.52 * SR), SR), 0);
});

test('slicer: pitch, reverse and fit-to-tempo change playback speed', () => {
  const up = render(slicer({ pitch: 12 }), 0.2, [on(0, 60)]).L;
  assert.ok(Math.abs(freq(up, 500, 9000) - 400) < 15);

  const e = slicer();
  e.setSlices(quarters({ rev: true }));
  const rev = render(e, 0.4, [on(0, 61)]).L;
  assert.ok(Math.abs(freq(rev, 1000, 18000) - 400) < 15);

  // 2 s of audio fitted to 2 beats at 120 BPM (1 s) plays twice as fast.
  const fit = slicer({ sync: SYNC_BEATS.indexOf(2) });
  fit.setTempo(120);
  assert.ok(Math.abs(freq(render(fit, 0.2, [on(0, 60)]).L, 500, 9000) - 400) < 15);
});

test('slicer: a new slice cuts the previous one, unless set to let it ring', () => {
  const cut = render(slicer(), 0.4, [on(0, 60), on(0.1, 62)]).L;
  // After the cut only slice 3 (800 Hz) is heard.
  assert.ok(Math.abs(freq(cut, 0.15 * SR, 0.35 * SR) - 800) < 20);
  const ring = render(slicer({ choke: 1 }), 0.4, [on(0, 60), on(0.1, 62)]).L;
  assert.ok(rms(ring, 0.15 * SR, 0.35 * SR) > rms(cut, 0.15 * SR, 0.35 * SR) * 1.2);
});

test('slicer: "stop on note off" releases the slice', () => {
  const whole = render(slicer(), 0.5, [on(0, 60), off(0.1, 60)]).L;
  const gate = render(slicer({ mode: 1, release: 0.01 }), 0.5, [on(0, 60), off(0.1, 60)]).L;
  assert.ok(rms(whole, 0.25 * SR, 0.45 * SR) > 0.2);
  assert.ok(rms(gate, 0.25 * SR, 0.45 * SR) < 0.001);
});

test('slicer: per-slice gain and pan', () => {
  const e = slicer();
  e.setSlices(quarters({ gain: -12, pan: -1 }));
  const { L, R } = render(e, 0.3, [on(0, 60)]);
  const ref = render(slicer(), 0.3, [on(0, 60)]);
  assert.ok(rms(R, 1000, 10000) < 1e-4); // hard left
  // -12 dB, and the pan law puts all of it on the left (+3 dB)
  const ratio = rms(L, 1000, 10000) / rms(ref.L, 1000, 10000);
  assert.ok(Math.abs(20 * Math.log10(ratio) - (-12 + 3.01)) < 0.5, `${20 * Math.log10(ratio)} dB`);
});

test('slicer: no clicks at slice edges', () => {
  const { L } = render(slicer(), 0.6, [on(0, 63)]);
  let jump = 0;
  for (let i = 1; i < L.length; i++) jump = Math.max(jump, Math.abs(L[i] - L[i - 1]));
  // A 1600 Hz sine at 0.5 moves at most ~0.105 per sample; no step should exceed that.
  assert.ok(jump < 0.12, `largest step ${jump}`);
});

// ------------------------------------------------------------------ grains

function grains(values = {}, buffer) {
  const e = new GrainsEngine(SR, 42);
  const t = buffer ?? demoTexture(SR);
  e.setBuffer(t.L, t.R);
  set(e, GR, values);
  return e;
}

test('grains: sound while a note is held, silence after release', () => {
  const { L } = render(grains({ release: 0.05 }), 1.5, [on(0, 60), off(0.8, 60)]);
  assert.ok(rms(L, 0.2 * SR, 0.8 * SR) > 0.02);
  assert.ok(rms(L, 1.3 * SR, 1.5 * SR) < 1e-4);
});

test('grains: grains come from around the position', () => {
  // Sound only in the second half of the buffer.
  const L = new Float32Array(2 * SR);
  for (let i = SR; i < L.length; i++) L[i] = Math.sin((2 * Math.PI * 300 * i) / SR) * 0.5;
  const buf = { L, R: L };
  const quiet = render(grains({ position: 0.2, spray: 0, scan: 0 }, buf), 0.5, [on(0, 60)]).L;
  const loud = render(grains({ position: 0.7, spray: 0, scan: 0 }, buf), 0.5, [on(0, 60)]).L;
  assert.ok(rms(quiet) < 1e-6);
  assert.ok(rms(loud, 0.1 * SR) > 0.05);
});

test('grains: notes change pitch (unless fixed)', () => {
  const L = new Float32Array(SR);
  for (let i = 0; i < L.length; i++) L[i] = Math.sin((2 * Math.PI * 300 * i) / SR) * 0.5;
  const buf = { L, R: L };
  const opts = { size: 0.3, density: 20, window: 2, jitter: 0, spread: 0, spray: 0 };
  const octave = render(grains(opts, buf), 0.6, [on(0, 72)]).L;
  assert.ok(Math.abs(freq(octave, 0.2 * SR, 0.6 * SR) - 600) < 40, `${freq(octave, 0.2 * SR, 0.6 * SR)} Hz`);
  const fixed = render(grains({ ...opts, keytrack: 1 }, buf), 0.6, [on(0, 72)]).L;
  assert.ok(Math.abs(freq(fixed, 0.2 * SR, 0.6 * SR) - 300) < 25);
});

test('grains: level stays similar from sparse to dense clouds', () => {
  const level = (density) => rms(render(grains({ density, size: 0.1 }), 1, [on(0, 60)]).L, 0.3 * SR);
  const sparse = level(10);
  const dense = level(150);
  assert.ok(dense / sparse < 3 && sparse / dense < 3, `sparse ${sparse}, dense ${dense}`);
});

test('grains: output stays finite and bounded with everything maxed', () => {
  const e = grains({ density: 200, size: 1, detune: 12, reverse: 1, spread: 1, scan: 2, gain: 12 });
  const { L, R } = render(e, 1, [60, 64, 67, 71, 74, 77, 81, 84, 88].map((n) => on(0, n)));
  for (let i = 0; i < L.length; i++) assert.ok(Number.isFinite(L[i]) && Number.isFinite(R[i]));
  assert.ok(Math.max(...L.map(Math.abs)) < 20);
});
