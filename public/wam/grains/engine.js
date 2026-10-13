// Grains' audio engine: each held note sprays short, windowed, pitched
// "grains" read from around a position in the sound. Position, spray, size,
// density, pitch randomness, reverse probability and stereo spread shape the
// cloud; scan moves the position while a note is held.

import { ParamEngine, rng, panGains } from '../kit/engine.js';
import { TABLE } from './params.js';

const MAX_GRAINS = 256;
const MAX_VOICES = 8;
const WIN = 1024;
const SCRATCH = 128;

// Window shapes, as lookup tables (index = position through the grain).
const WINDOWS = [
  (x) => 0.5 - 0.5 * Math.cos(2 * Math.PI * x), // smooth (Hann)
  (x) => 1 - Math.abs(2 * x - 1), // triangle
  (x) => Math.min(1, x / 0.1, (1 - x) / 0.1), // flat top
  (x) => Math.min(x / 0.02, 1) * Math.exp(-4 * Math.max(0, x - 0.02)) * Math.min(1, (1 - x) / 0.05), // percussive
  (x) => Math.min(1, (1 - x) / 0.04) * x * x, // swell
].map((fn) => Float32Array.from({ length: WIN + 1 }, (_, i) => Math.max(0, fn(i / WIN))));

export class GrainsEngine extends ParamEngine {
  constructor(sampleRate, seed = 1) {
    super(sampleRate, TABLE);
    this.L = null;
    this.R = null;
    this.rand = rng(seed);
    this.grains = Array.from({ length: MAX_GRAINS }, () => ({ active: false }));
    this.voices = Array.from({ length: MAX_VOICES }, () => ({ active: false, bufL: new Float32Array(SCRATCH), bufR: new Float32Array(SCRATCH) }));
    this.age = 0;
  }

  handle(m) {
    if (m.type === 'buffer') this.setBuffer(m.L, m.R);
  }

  setBuffer(L, R) {
    for (const g of this.grains) g.active = false;
    this.L = L;
    this.R = R ?? L;
  }

  noteOn(note, vel) {
    let v = this.voices.find((x) => !x.active);
    if (!v) {
      v = this.voices.reduce((a, b) => (a.age < b.age ? a : b)); // steal the oldest
      this.dropGrains(v);
    }
    Object.assign(v, {
      active: true,
      note,
      vel: (vel / 127) ** 1.3,
      env: 0,
      stage: 0, // 0 attack, 1 hold, 2 release
      held: true,
      scan: 0, // seconds the playhead has moved since the note started
      next: 0, // samples until the next grain
      age: ++this.age,
    });
  }

  noteOff(note) {
    for (const v of this.voices) if (v.active && v.note === note && v.held) {
      v.held = false;
      v.stage = 2;
    }
  }

  allOff() {
    for (const v of this.voices) if (v.active) v.stage = 2;
  }

  dropGrains(v) {
    for (const g of this.grains) if (g.voice === v) g.active = false;
  }

  spawn(v, delay) {
    const g = this.grains.find((x) => !x.active);
    if (!g) return;
    const p = this.p;
    const n = this.L.length;
    const dur = n / this.sr;
    const r = this.rand;
    let start = p.position * dur + v.scan + (r() * 2 - 1) * p.spray;
    start = (((start % dur) + dur) % dur) * this.sr;
    const semis = p.pitch + (p.keytrack === 0 ? v.note - 60 : 0) + (r() * 2 - 1) * p.detune + this.bend;
    const rate = 2 ** (semis / 12);
    const len = Math.max(16, Math.round(p.size * this.sr));
    const [gl, gr] = panGains((r() * 2 - 1) * p.spread);
    // Keep the level steady however many grains overlap.
    const amp = 0.8 / Math.sqrt(Math.max(1, p.density * p.size));
    Object.assign(g, {
      active: true,
      voice: v,
      pos: start,
      step: r() < p.reverse ? -rate : rate,
      idx: 0,
      len,
      inc: WIN / len,
      win: WINDOWS[p.window] ?? WINDOWS[0],
      gl: gl * amp,
      gr: gr * amp,
      delay,
    });
  }

  render(outL, outR, off, frames) {
    if (!this.L) return;
    const p = this.p;
    const sr = this.sr;
    const n = this.L.length;
    const dur = n / sr;
    const srcL = this.L;
    const srcR = this.R;
    const interval = sr / p.density;
    const attackInc = 1 / Math.max(1, p.attack * sr);
    const relMul = Math.exp(-6.9 / (Math.max(0.005, p.release) * sr));
    const master = 10 ** (p.gain / 20);

    for (const v of this.voices) {
      if (!v.active) continue;
      v.bufL.fill(0, 0, frames);
      v.bufR.fill(0, 0, frames);
      while (v.next < frames) {
        this.spawn(v, Math.floor(v.next));
        v.next += interval * (1 + p.jitter * (this.rand() * 2 - 1) * 0.9);
      }
      v.next -= frames;
      v.scan = (v.scan + (p.scan * frames) / sr) % dur;
    }

    for (const g of this.grains) {
      if (!g.active) continue;
      const bl = g.voice.bufL;
      const br = g.voice.bufR;
      const win = g.win;
      for (let i = g.delay; i < frames; i++) {
        if (g.idx >= g.len) {
          g.active = false;
          break;
        }
        const wx = g.idx * g.inc;
        const wi = wx | 0;
        const w = win[wi] + (win[wi + 1] - win[wi]) * (wx - wi);
        let x = g.pos % n;
        if (x < 0) x += n;
        const i0 = x | 0;
        const fr = x - i0;
        const i1 = i0 + 1 < n ? i0 + 1 : 0;
        bl[i] += (srcL[i0] + (srcL[i1] - srcL[i0]) * fr) * w * g.gl;
        br[i] += (srcR[i0] + (srcR[i1] - srcR[i0]) * fr) * w * g.gr;
        g.pos += g.step;
        g.idx++;
      }
      g.delay = 0;
    }

    for (const v of this.voices) {
      if (!v.active) continue;
      const a = v.vel * master;
      for (let i = 0; i < frames; i++) {
        if (v.stage === 0) {
          v.env += attackInc;
          if (v.env >= 1) {
            v.env = 1;
            v.stage = 1;
          }
        } else if (v.stage === 2) {
          v.env *= relMul;
          if (v.env < 1e-4) {
            v.active = false;
            this.dropGrains(v);
            break;
          }
        }
        outL[off + i] += v.bufL[i] * v.env * a;
        outR[off + i] += v.bufR[i] * v.env * a;
      }
    }
  }

  status() {
    if (!this.L) return null;
    const n = this.L.length;
    const dur = n / this.sr;
    const grains = [];
    for (const g of this.grains) {
      if (!g.active || grains.length >= 96) continue;
      let x = g.pos % n;
      if (x < 0) x += n;
      grains.push(Math.round((x / n) * 1000) / 1000);
    }
    const heads = [];
    for (const v of this.voices) {
      if (!v.active) continue;
      const t = (((this.p.position * dur + v.scan) % dur) + dur) % dur;
      heads.push(t / dur);
    }
    return { grains, heads };
  }
}
