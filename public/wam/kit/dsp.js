// Offline helpers for the sample plugins: transient detection, and the demo
// sounds they start with. Demo sounds are synthesized deterministically, so
// every collaborator (and every export) gets exactly the same audio without
// shipping any audio files.

import { rng } from './engine.js';

/**
 * Where the hits are: times in seconds, always starting at 0.
 * Compares each 5 ms frame's high-passed loudness with the frames before it.
 * @param sensitivity 0..1: higher finds quieter hits, closer together
 */
export function detectOnsets(L, R, sr, sensitivity = 0.5, max = 36) {
  const hop = Math.max(32, Math.round(sr * 0.005));
  const frames = Math.floor(L.length / hop);
  if (frames < 4) return [0];
  const le = new Float32Array(frames);
  let prev = 0;
  let peak = -Infinity;
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let i = f * hop, end = i + hop; i < end; i++) {
      const x = R ? (L[i] + R[i]) * 0.5 : L[i];
      const d = x - prev; // first difference: emphasizes the attack, not the boom
      prev = x;
      e += d * d + 0.1 * x * x;
    }
    le[f] = 10 * Math.log10(e / hop + 1e-12);
    if (le[f] > peak) peak = le[f];
  }
  const odf = new Float32Array(frames);
  for (let f = 3; f < frames; f++) odf[f] = Math.max(0, le[f] - (le[f - 1] + le[f - 2] + le[f - 3]) / 3);

  const jump = 14 - 11 * sensitivity; // dB rise that counts as a hit
  const floor = peak - (30 + 25 * sensitivity); // ignore hiss far below the loudest part
  const gap = Math.round((0.12 - 0.08 * sensitivity) / 0.005); // frames between hits
  const hits = [];
  for (let f = 3; f < frames; f++) {
    if (odf[f] < jump || le[f] < floor) continue;
    let isPeak = true;
    for (let k = Math.max(0, f - 3); k <= Math.min(frames - 1, f + 3); k++) if (odf[k] > odf[f]) isPeak = false;
    if (!isPeak) continue;
    const last = hits.at(-1);
    if (last && f - last.f < gap) {
      if (odf[f] > last.s) hits[hits.length - 1] = { f, s: odf[f] };
      continue;
    }
    hits.push({ f, s: odf[f] });
  }
  // Too many: keep the strongest.
  let keep = hits;
  if (hits.length > max - 1) keep = [...hits].sort((a, b) => b.s - a.s).slice(0, max - 1).sort((a, b) => a.f - b.f);
  const times = keep.map((h) => Math.max(0, (h.f - 1) * hop) / sr).filter((t) => t > 0.01);
  return [0, ...times];
}

/** n equal slices. */
export function gridSlices(duration, n) {
  return Array.from({ length: n }, (_, i) => (i * duration) / n);
}

// ------------------------------------------------------------------ demo loop

const BREAK = {
  bpm: 120,
  sixteenths: 32, // 2 bars
  kick: [0, 7, 10, 16, 26, 30],
  snare: [4, 12, 20, 28],
  ghost: [15, 23],
  hat: [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30],
};

/** A 2-bar breakbeat at 120 BPM, plus the times of its hits (its natural slices). */
export function demoBreak(sr) {
  const step = 60 / BREAK.bpm / 4;
  const n = Math.round(BREAK.sixteenths * step * sr);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const rand = rng(1234);
  const add = (at, len, fn, pan = 0) => {
    const start = Math.round(at * sr);
    const gl = 1 - Math.max(0, pan);
    const gr = 1 + Math.min(0, pan);
    for (let i = 0; i < len && start + i < n; i++) {
      const v = fn(i / sr);
      L[start + i] += v * gl;
      R[start + i] += v * gr;
    }
  };
  for (const s of BREAK.kick) {
    let ph = 0;
    add(s * step, Math.round(0.45 * sr), (t) => {
      ph += (2 * Math.PI * (45 + 110 * Math.exp(-t * 30))) / sr;
      return Math.sin(ph) * Math.exp(-t * 7) * 0.9 + (t < 0.002 ? (rand() - 0.5) * 0.6 : 0);
    });
  }
  const snare = (gain) => {
    let lp = 0;
    return (t) => {
      const noise = rand() * 2 - 1;
      lp += (noise - lp) * 0.35;
      return ((noise - lp) * Math.exp(-t * 18) * 0.7 + Math.sin(2 * Math.PI * 185 * t) * Math.exp(-t * 30) * 0.5) * gain;
    };
  };
  for (const s of BREAK.snare) add(s * step, Math.round(0.3 * sr), snare(1));
  for (const s of BREAK.ghost) add(s * step, Math.round(0.15 * sr), snare(0.3));
  for (const s of BREAK.hat) {
    let x1 = 0;
    const open = s % 8 === 6;
    add(
      s * step,
      Math.round((open ? 0.25 : 0.06) * sr),
      (t) => {
        const x = rand() * 2 - 1;
        const hp = x - x1;
        x1 = x;
        return hp * Math.exp(-t * (open ? 14 : 70)) * 0.22;
      },
      0.35,
    );
  }
  normalize(L, R, 0.9);
  const hits = [...new Set([...BREAK.kick, ...BREAK.snare, ...BREAK.ghost, ...BREAK.hat])].sort((a, b) => a - b).map((s) => s * step);
  return { L, R, name: 'Demo break (120 BPM)', beats: BREAK.sixteenths / 4, hits };
}

// ------------------------------------------------------------------ demo texture

/** A few seconds of a slowly evolving chord: something to granulate. */
export function demoTexture(sr) {
  const seconds = 6;
  const n = Math.round(seconds * sr);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  // One band-limited saw cycle (24 harmonics) to read from.
  const T = 2048;
  const saw = new Float32Array(T + 1);
  for (let i = 0; i <= T; i++) for (let k = 1; k <= 24; k++) saw[i] += Math.sin((2 * Math.PI * k * i) / T) / k;
  const notes = [110, 164.81, 220, 261.63, 329.63, 392, 493.88, 659.25];
  const rand = rng(77);
  const voices = notes.flatMap((f, i) =>
    [-1, 1].map((side) => ({ f: f * 2 ** ((side * (4 + i)) / 1200), ph: rand(), pan: side * 0.6, rate: 0.13 + rand() * 0.4, off: rand() * 6.28, amp: 1 / (1 + i * 0.35) })),
  );
  let lpL = 0;
  let lpR = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let l = 0;
    let r = 0;
    for (const v of voices) {
      v.ph += v.f / sr;
      v.ph -= Math.floor(v.ph);
      const x = v.ph * T;
      const j = x | 0;
      const s = saw[j] + (saw[j + 1] - saw[j]) * (x - j);
      const a = v.amp * (0.55 + 0.45 * Math.sin(t * v.rate * 2 * Math.PI + v.off));
      l += s * a * (1 - v.pan);
      r += s * a * (1 + v.pan);
    }
    // A filter that opens and closes, so different spots sound different.
    const c = 0.02 + 0.18 * (0.5 + 0.5 * Math.sin((t / seconds) * 2 * Math.PI * 1.5 - 1.2)) ** 2;
    lpL += (l - lpL) * c;
    lpR += (r - lpR) * c;
    const fade = Math.min(1, t / 0.05, (seconds - t) / 0.05);
    L[i] = lpL * fade;
    R[i] = lpR * fade;
  }
  normalize(L, R, 0.8);
  return { L, R, name: 'Demo texture' };
}

function normalize(L, R, target) {
  let peak = 0;
  for (let i = 0; i < L.length; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  if (!peak) return;
  const g = target / peak;
  for (let i = 0; i < L.length; i++) {
    L[i] *= g;
    R[i] *= g;
  }
}
