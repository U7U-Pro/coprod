// WAV (RIFF) encoding for rendered audio: 16/24-bit PCM or 32-bit float.

/**
 * @param {{ numberOfChannels: number, sampleRate: number, length: number, getChannelData(c: number): Float32Array }} buffer
 * @param {16|24|32} bits  32 means 32-bit float
 * @returns {ArrayBuffer}
 */
export function encodeWav(buffer, bits = 16) {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const bytes = bits / 8;
  const float = bits === 32;
  const dataSize = frames * channels * bytes;
  const out = new ArrayBuffer(44 + dataSize);
  const v = new DataView(out);
  const text = (at, s) => [...s].forEach((ch, i) => v.setUint8(at + i, ch.charCodeAt(0)));
  text(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, float ? 3 : 1, true); // 3 = IEEE float, 1 = PCM
  v.setUint16(22, channels, true);
  v.setUint32(24, buffer.sampleRate, true);
  v.setUint32(28, buffer.sampleRate * channels * bytes, true);
  v.setUint16(32, channels * bytes, true);
  v.setUint16(34, bits, true);
  text(36, 'data');
  v.setUint32(40, dataSize, true);

  const data = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
  let at = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const s = Math.max(-1, Math.min(1, data[c][i]));
      if (float) v.setFloat32(at, data[c][i], true);
      else if (bits === 16) v.setInt16(at, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
      else {
        const x = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff);
        v.setUint8(at, x & 0xff);
        v.setUint8(at + 1, (x >> 8) & 0xff);
        v.setUint8(at + 2, (x >> 16) & 0xff);
      }
      at += bytes;
    }
  }
  return out;
}

/** Peak level of a buffer in dBFS (0 = full scale). */
export function peakDb(buffer) {
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}
