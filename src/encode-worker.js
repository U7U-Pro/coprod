// Encodes an export off the main thread, so the page stays responsive and can
// show progress. Message in: { format, quality, sampleRate, channels }. Out:
// { type: 'progress', fraction } ..., then { type: 'done', bytes } or { type: 'error', message }.

import mp3Wasm from 'wasm-media-encoders/wasm/mp3?url';
import oggWasm from 'wasm-media-encoders/wasm/ogg?url';
import { encodeAudio } from './encode.js';

// Fetched as bytes rather than compiled from the response, so a server that
// labels .wasm files wrongly (some static hosts do) still works.
async function wasmBytes(format) {
  const url = { mp3: mp3Wasm, ogg: oggWasm }[format];
  if (!url) return undefined;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn’t load the ${format.toUpperCase()} encoder (HTTP ${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

self.onmessage = async ({ data }) => {
  try {
    const bytes = await encodeAudio(data, {
      wasm: await wasmBytes(data.format),
      onProgress: (fraction) => self.postMessage({ type: 'progress', fraction }),
    });
    self.postMessage({ type: 'done', bytes }, [bytes.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message || String(err) });
  }
};
