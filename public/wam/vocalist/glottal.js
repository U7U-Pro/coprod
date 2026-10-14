// The voice source: one period of the Liljencrants-Fant (LF) glottal flow
// derivative, for a range of voice qualities from pressed to breathy (Fant's
// Rd parameter), as band-limited wavetables (Vertex's mipmaps) so high notes
// don't alias.

import { SIZE, buildMips } from '../vertex/wavetables.js';

export const RD_MIN = 0.4;
export const RD_MAX = 2.8;
export const FRAMES = 16;

/** One period (n samples) of the LF flow derivative for shape Rd, normalized to unit RMS. */
export function lfPeriod(Rd, n = SIZE) {
  const Ra = (-1 + 4.8 * Rd) / 100;
  const Rk = (22.4 + 11.8 * Rd) / 100;
  const Rg = Rk / (4 * ((0.11 * Rd) / (0.5 + 1.2 * Rk) - Ra));
  const tp = 1 / (2 * Rg);
  const te = Math.min(0.97, tp * (1 + Rk));
  const ta = Math.max(0.003, Ra);
  // Return phase: eps * ta = 1 - exp(-eps * (1 - te))
  let eps = 1 / ta;
  for (let i = 0; i < 40; i++) {
    const ex = Math.exp(-eps * (1 - te));
    eps -= (eps * ta - 1 + ex) / (ta - (1 - te) * ex);
  }
  const wg = Math.PI / tp;
  const tr = 1 - te;
  const ex = Math.exp(-eps * tr);
  const returnArea = -((1 - ex) / eps - tr * ex) / (eps * ta);
  // Open phase E0 e^(a t) sin(wg t), scaled so E(te) = -1; choose a for zero net flow.
  const openArea = (a) => {
    const E0 = -1 / (Math.exp(a * te) * Math.sin(wg * te));
    const F = (t) => (Math.exp(a * t) * (a * Math.sin(wg * t) - wg * Math.cos(wg * t))) / (a * a + wg * wg);
    return E0 * (F(te) - F(0));
  };
  const f = (a) => openArea(a) + returnArea;
  let lo = -40;
  let hi = 120;
  for (let a = lo, prev = f(lo); a < hi; a += 0.5) {
    const v = f(a + 0.5);
    if (Math.sign(v) !== Math.sign(prev)) {
      lo = a;
      hi = a + 0.5;
      break;
    }
    prev = v;
  }
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (Math.sign(f(mid)) === Math.sign(f(lo))) lo = mid;
    else hi = mid;
  }
  const a = (lo + hi) / 2;
  const E0 = -1 / (Math.exp(a * te) * Math.sin(wg * te));
  const out = new Float32Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    out[i] = t <= te ? E0 * Math.exp(a * t) * Math.sin(wg * t) : -(Math.exp(-eps * (t - te)) - ex) / (eps * ta);
    mean += out[i];
  }
  mean /= n;
  let rms = 0;
  for (let i = 0; i < n; i++) {
    out[i] -= mean;
    rms += out[i] * out[i];
  }
  rms = Math.sqrt(rms / n) || 1;
  for (let i = 0; i < n; i++) out[i] /= rms;
  return { wave: out, te };
}

let cached = null;

/** Mipmapped tables for FRAMES voice qualities, plus each one's open phase length. */
export function glottalTables() {
  if (cached) return cached;
  const frames = new Float32Array(FRAMES * SIZE);
  const te = new Float32Array(FRAMES);
  for (let f = 0; f < FRAMES; f++) {
    const p = lfPeriod(RD_MIN + ((RD_MAX - RD_MIN) * f) / (FRAMES - 1));
    frames.set(p.wave, f * SIZE);
    te[f] = p.te;
  }
  cached = { ...buildMips(frames, FRAMES), size: SIZE, te };
  return cached;
}
