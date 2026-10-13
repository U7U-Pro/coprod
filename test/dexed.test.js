// The Dexed engine compiled to WebAssembly, tested directly in Node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const WASM = new URL('../public/wam/dexed/dexed.wasm', import.meta.url);
const BANK = new URL('../public/wam/dexed/banks/Dexed_01.syx', import.meta.url);
const RATE = 48000;

async function engine() {
  const wasi = { fd_close: () => 0, fd_seek: () => 0, fd_write: () => 0 };
  const { instance } = await WebAssembly.instantiate(readFileSync(WASM), { wasi_snapshot_preview1: wasi });
  const e = instance.exports;
  e._initialize();
  e.dexed_init(RATE);
  return e;
}

function render(e, seconds) {
  const out = new Float32Array(Math.floor((RATE * seconds) / 128) * 128);
  for (let i = 0; i < out.length; i += 128) {
    e.dexed_render(128);
    out.set(new Float32Array(e.memory.buffer, e.dexed_output(), 128), i);
  }
  return out;
}

const rms = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);

/** Fundamental frequency: the first strong autocorrelation peak. */
function pitch(a) {
  const r = (lag) => {
    let s = 0;
    for (let i = 0; i < 8192; i++) s += a[i] * a[i + lag];
    return s;
  };
  const r0 = r(0);
  let lag = 1;
  while (lag < 2000 && r(lag) > 0) lag++; // past the first zero crossing
  for (; lag < 2000; lag++) {
    const here = r(lag);
    if (here > 0.8 * r0 && here >= r(lag - 1) && here >= r(lag + 1)) {
      // Refine between samples with a parabola through the peak.
      const y0 = r(lag - 1);
      const y2 = r(lag + 1);
      return RATE / (lag + (0.5 * (y0 - y2)) / (y0 - 2 * here + y2));
    }
  }
  return 0;
}

/** A patch that is just operator 1 as a sine at the played pitch. */
function sinePatch(e) {
  const p = new Uint8Array(e.memory.buffer, e.dexed_program(), 156);
  p.fill(0);
  for (let op = 0; op < 6; op++) {
    const o = op * 21;
    p.set([99, 99, 99, 99, 99, 99, 99, 0], o); // EG rates and levels
    p[o + 15] = 0; // velocity sensitivity
    p[o + 16] = op === 5 ? 99 : 0; // only OP1 (stored last) is audible
    p[o + 18] = 1; // coarse ratio 1
    p[o + 20] = 7; // detune centered
  }
  p.set([99, 99, 99, 99, 50, 50, 50, 50], 126); // flat pitch envelope
  p[134] = 31; // algorithm 32: six parallel carriers
  p[144] = 24; // no transpose
  p[155] = 0x3f; // all operators on
  e.dexed_program_changed();
}

test('a single-operator patch plays a sine at the right pitch', async () => {
  const e = await engine();
  sinePatch(e);
  e.dexed_note_on(69, 100); // A4
  const a4 = render(e, 0.5).slice(RATE * 0.2);
  assert.ok(rms(a4) > 0.05, `audible (rms ${rms(a4)})`);
  assert.ok(Math.abs(pitch(a4) - 440) < 3, `A4 is ${pitch(a4).toFixed(1)} Hz`);

  e.dexed_note_off(69);
  render(e, 0.5);
  e.dexed_note_on(81, 100); // A5
  const a5 = render(e, 0.5).slice(RATE * 0.2);
  assert.ok(Math.abs(pitch(a5) - 880) < 6, `A5 is ${pitch(a5).toFixed(1)} Hz`);
});

test('note off releases the voice', async () => {
  const e = await engine();
  sinePatch(e);
  e.dexed_note_on(60, 100);
  render(e, 0.2);
  assert.equal(e.dexed_active_voices(), 1);
  e.dexed_note_off(60);
  const tail = render(e, 1).slice(-4096);
  assert.ok(rms(tail) < 0.001, 'silent after release');
});

test('every voice in the factory bank makes sound', async () => {
  const bank = readFileSync(BANK);
  assert.equal(bank.length, 4104);
  const silent = [];
  for (let v = 0; v < 32; v++) {
    const e = await engine();
    new Uint8Array(e.memory.buffer, e.dexed_scratch(), 4104).set(bank);
    e.dexed_unpack(6 + v * 128);
    e.dexed_program_changed();
    const name = String.fromCharCode(...new Uint8Array(e.memory.buffer, e.dexed_program() + 145, 10)).trim();
    e.dexed_note_on(60, 100);
    e.dexed_note_on(64, 100);
    const a = render(e, 0.6);
    if (!(rms(a) > 0.001)) silent.push(name);
    assert.ok(a.every(Number.isFinite), `${name}: finite samples`);
  }
  assert.deepEqual(silent, []);
});

test('polyphony and sustain pedal', async () => {
  const e = await engine();
  sinePatch(e);
  for (const n of [60, 64, 67, 72]) e.dexed_note_on(n, 100);
  render(e, 0.1);
  assert.equal(e.dexed_active_voices(), 4);
  e.dexed_cc(64, 127); // pedal down
  for (const n of [60, 64, 67, 72]) e.dexed_note_off(n);
  render(e, 0.3);
  assert.equal(e.dexed_active_voices(), 4, 'held by the pedal');
  e.dexed_cc(64, 0);
  render(e, 1);
  assert.equal(e.dexed_active_voices(), 0);
});
