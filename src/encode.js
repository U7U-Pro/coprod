// Turning rendered audio into a file: WAV, MP3 (LAME) or OGG Vorbis.
// Runs in a Web Worker during export (encode-worker.js), and in Node for tests.
// The MP3 and Vorbis encoders are the reference ones compiled to WebAssembly
// (the wasm-media-encoders package); their .wasm files load only when needed.

import { createEncoder } from 'wasm-media-encoders';
import { encodeWav } from './wav.js';
import { FORMATS } from './formats.js';

export { FORMATS };

const BLOCK = 16384; // frames per encoder call

// LAME writes MPEG-1 audio at 32, 44.1 or 48 kHz; anything else is resampled to one of those.
const mp3Rate = (sr) => ([32000, 44100, 48000].includes(sr) ? sr : sr > 48000 ? 48000 : 44100);

function encoderParams(format, quality, sampleRate) {
  if (format === 'mp3') {
    const common = { outputSampleRate: mp3Rate(sampleRate) };
    return { ...common, bitrate: Number(quality) || 320 };
  }
  return { vbrQuality: Number(quality) || 6 };
}

/**
 * @param {{ format: 'wav'|'mp3'|'ogg', quality: string, sampleRate: number, channels: Float32Array[] }} job
 * @param {{ wasm?: string|Uint8Array, onProgress?: (fraction: number) => void }} opts  wasm: the encoder's .wasm (URL or bytes)
 * @returns {Promise<Uint8Array>} the file
 */
export async function encodeAudio({ format, quality, sampleRate, channels }, { wasm, onProgress = () => {} } = {}) {
  const frames = channels[0].length;
  if (format === 'wav') {
    const bits = Number(quality) || 16;
    return new Uint8Array(encodeWav({ numberOfChannels: channels.length, sampleRate, length: frames, getChannelData: (c) => channels[c] }, bits));
  }
  const info = FORMATS[format];
  if (!info) throw new Error(`Unknown format: ${format}`);
  const encoder = await createEncoder(info.mime, wasm);
  encoder.configure({ sampleRate, channels: channels.length, ...encoderParams(format, quality, sampleRate) });

  const parts = [];
  let size = 0;
  const keep = (bytes) => {
    if (!bytes.length) return;
    parts.push(bytes.slice()); // the encoder reuses its output buffer
    size += bytes.length;
  };
  // Clip to full scale like the WAV export does (encoders wrap or distort past it).
  const block = channels.map(() => new Float32Array(BLOCK));
  let reported = 0;
  for (let at = 0; at < frames; at += BLOCK) {
    const n = Math.min(BLOCK, frames - at);
    const input = channels.map((ch, c) => {
      const out = block[c].subarray(0, n);
      for (let i = 0; i < n; i++) {
        const s = ch[at + i];
        out[i] = s > 1 ? 1 : s < -1 ? -1 : s;
      }
      return out;
    });
    keep(encoder.encode(input));
    const fraction = (at + n) / frames;
    if (fraction - reported >= 0.01) {
      reported = fraction;
      onProgress(fraction);
    }
  }
  keep(encoder.finalize());

  const file = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    file.set(p, at);
    at += p.length;
  }
  return file;
}
