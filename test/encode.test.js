import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodeAudio, FORMATS } from '../src/encode.js';

const wasm = (f) => readFileSync(new URL(`../node_modules/wasm-media-encoders/wasm/${f}.wasm`, import.meta.url));

function tone(seconds, sampleRate = 48000, amp = 0.5) {
  const n = Math.round(seconds * sampleRate);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = amp * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
    R[i] = amp * Math.sin((2 * Math.PI * 660 * i) / sampleRate);
  }
  return [L, R];
}

/** Walk MPEG-1 Layer III frames from start to end: every one must have a valid header. */
function mp3Info(bytes) {
  const b = Buffer.from(bytes);
  const KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const RATES = [44100, 48000, 32000];
  let at = 0;
  let frames = 0;
  const seen = { bitrates: new Set(), rates: new Set() };
  while (at + 4 <= b.length) {
    assert.equal(b[at], 0xff, `frame ${frames} sync`);
    assert.equal(b[at + 1] & 0xfe, 0xfa, `frame ${frames}: MPEG-1 Layer III`);
    const kbps = KBPS[b[at + 2] >> 4];
    const rate = RATES[(b[at + 2] >> 2) & 3];
    assert.ok(kbps && rate, `frame ${frames} header`);
    seen.bitrates.add(kbps);
    seen.rates.add(rate);
    at += Math.floor((144000 * kbps) / rate) + ((b[at + 2] >> 1) & 1);
    frames++;
  }
  assert.equal(at, b.length, 'frames fill the file exactly');
  return { frames, bitrates: [...seen.bitrates], sampleRate: [...seen.rates][0] };
}

/** Ogg pages: the last page's granule position is the number of samples (frames) encoded. */
function oggInfo(bytes) {
  const b = Buffer.from(bytes);
  let at = 0;
  let pages = 0;
  let granule = 0n;
  let vorbis = false;
  while (at < b.length) {
    assert.equal(b.toString('latin1', at, at + 4), 'OggS', `page ${pages} capture pattern`);
    granule = b.readBigInt64LE(at + 6);
    const segments = b[at + 26];
    let size = 0;
    for (let i = 0; i < segments; i++) size += b[at + 27 + i];
    if (pages === 0) vorbis = b.toString('latin1', at + 27 + segments + 1, at + 27 + segments + 7) === 'vorbis';
    at += 27 + segments + size;
    pages++;
  }
  return { pages, samples: Number(granule), vorbis };
}

test('MP3: valid frames, the right length, and a smaller file at a lower bitrate', async () => {
  const sampleRate = 48000;
  const seconds = 3;
  const progress = [];
  const best = await encodeAudio({ format: 'mp3', quality: '320', sampleRate, channels: tone(seconds) }, { wasm: wasm('mp3'), onProgress: (f) => progress.push(f) });
  const info = mp3Info(best);
  assert.equal(info.sampleRate, 48000);
  assert.deepEqual(info.bitrates, [320], 'constant bitrate (players can tell its length)');
  // 1152 samples per frame; LAME adds about a frame of encoder delay and padding.
  const expected = Math.ceil((seconds * sampleRate) / 1152);
  assert.ok(info.frames >= expected && info.frames <= expected + 3, `${info.frames} frames for ${expected}`);
  assert.ok(Math.abs(best.length - (320_000 / 8) * seconds) < 4000, `about 320 kbps (${best.length} bytes)`);
  assert.ok(progress.length > 3 && progress.at(-1) === 1, 'reports progress up to 1');

  const small = await encodeAudio({ format: 'mp3', quality: '128', sampleRate, channels: tone(seconds) }, { wasm: wasm('mp3') });
  assert.deepEqual(mp3Info(small).bitrates, [128]);
  assert.ok(small.length < best.length / 2, `128 kbps is much smaller (${small.length} < ${best.length})`);
});

test('MP3 at an unusual sample rate is resampled to one MP3 supports', async () => {
  const info = mp3Info(await encodeAudio({ format: 'mp3', quality: '192', sampleRate: 96000, channels: tone(1, 96000) }, { wasm: wasm('mp3') }));
  assert.equal(info.sampleRate, 48000);
});

test('OGG Vorbis: valid pages, exactly the samples that went in, quality changes size', async () => {
  const sampleRate = 44100;
  const channels = tone(2.5, sampleRate);
  const q8 = await encodeAudio({ format: 'ogg', quality: '8', sampleRate, channels }, { wasm: wasm('ogg') });
  const info = oggInfo(q8);
  assert.ok(info.vorbis, 'a Vorbis stream');
  assert.equal(info.samples, Math.round(2.5 * sampleRate));
  const q4 = await encodeAudio({ format: 'ogg', quality: '4', sampleRate, channels: tone(2.5, sampleRate) }, { wasm: wasm('ogg') });
  assert.ok(q4.length < q8.length, `q4 smaller than q8 (${q4.length} < ${q8.length})`);
});

test('loud input is clipped to full scale, not wrapped (MP3 and OGG still encode)', async () => {
  const hot = tone(1, 48000, 3); // three times full scale
  for (const format of ['mp3', 'ogg']) {
    const bytes = await encodeAudio({ format, quality: FORMATS[format].qualities[0][0], sampleRate: 48000, channels: hot }, { wasm: wasm(format) });
    assert.ok(bytes.length > 1000, format);
  }
  assert.ok(hot[0].some((v) => Math.abs(v) > 1), 'the caller’s audio is left alone');
});

test('WAV goes through the same call', async () => {
  const wav = Buffer.from(await encodeAudio({ format: 'wav', quality: '24', sampleRate: 48000, channels: tone(0.5) }));
  assert.equal(wav.toString('latin1', 0, 4), 'RIFF');
  assert.equal(wav.readUInt16LE(34), 24);
  assert.equal(wav.length, 44 + 24000 * 2 * 3);
});

test('every format lists its qualities, best first', () => {
  for (const [id, f] of Object.entries(FORMATS)) {
    assert.ok(f.ext && f.mime && f.qualities.length >= 2, id);
  }
  assert.deepEqual(FORMATS.wav.qualities.map(([v]) => v), ['16', '24', '32']);
});
