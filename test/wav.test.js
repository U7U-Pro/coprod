import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav, peakDb } from '../src/wav.js';

const fake = (L, R, sampleRate = 48000) => ({
  numberOfChannels: 2,
  sampleRate,
  length: L.length,
  getChannelData: (c) => (c ? R : L),
});

test('16-bit WAV: header and interleaved samples', () => {
  const L = Float32Array.from([0, 0.5, -1, 1.5]); // 1.5 clips
  const R = Float32Array.from([0.25, -0.5, 1, -2]);
  const wav = new DataView(encodeWav(fake(L, R), 16));
  const str = (at, n) => String.fromCharCode(...new Uint8Array(wav.buffer, at, n));
  assert.equal(str(0, 4), 'RIFF');
  assert.equal(str(8, 4), 'WAVE');
  assert.equal(wav.getUint16(20, true), 1, 'PCM');
  assert.equal(wav.getUint16(22, true), 2, 'stereo');
  assert.equal(wav.getUint32(24, true), 48000);
  assert.equal(wav.getUint16(34, true), 16);
  assert.equal(wav.getUint32(40, true), 4 * 2 * 2);
  const s = (i) => wav.getInt16(44 + i * 2, true);
  assert.deepEqual([s(0), s(1), s(2), s(3), s(4), s(5), s(6), s(7)], [0, 8192, 16384, -16384, -32768, 32767, 32767, -32768]);
});

test('24-bit and 32-bit float', () => {
  const L = Float32Array.from([0.5, -0.25]);
  const R = Float32Array.from([-1, 2]);
  const w24 = new DataView(encodeWav(fake(L, R), 24));
  assert.equal(w24.getUint16(34, true), 24);
  const s24 = (i) => {
    const x = w24.getUint8(44 + i * 3) | (w24.getUint8(45 + i * 3) << 8) | (w24.getInt8(46 + i * 3) << 16);
    return x;
  };
  assert.equal(s24(0), Math.round(0.5 * 0x7fffff));
  assert.equal(s24(2), -Math.round(0.25 * 0x800000));
  const w32 = new DataView(encodeWav(fake(L, R), 32));
  assert.equal(w32.getUint16(20, true), 3, 'IEEE float');
  assert.equal(w32.getFloat32(44 + 12, true), 2, 'float keeps overs');
});

test('peak level', () => {
  assert.equal(Math.round(peakDb(fake(Float32Array.from([0.5]), Float32Array.from([-0.25])))), -6);
  assert.equal(peakDb(fake(new Float32Array(4), new Float32Array(4))), -Infinity);
});
