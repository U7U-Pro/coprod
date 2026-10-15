// Slicer's audio engine: one audio buffer cut into slices, slice n on MIDI
// note ROOT + n. Each slice has its own gain, pan, pitch and direction; the
// whole sound can be fitted to the song's tempo (by resampling, like a
// turntable), shaped by an envelope and a resonant low-pass filter.

import { ParamEngine, panGains } from '../kit/engine.js';
import { TABLE, ROOT, SYNC_BEATS } from './params.js';

const MAX_VOICES = 32;
const EDGE = 64; // samples of fade at slice edges, so cuts never click

export class SlicerEngine extends ParamEngine {
  constructor(sampleRate) {
    super(sampleRate, TABLE);
    this.L = null;
    this.R = null;
    this.slices = []; // { start, end (samples), gain (linear), pan, pitch, rev }
    this.voices = Array.from({ length: MAX_VOICES }, () => ({ active: false, f: new Float64Array(4) }));
    this.age = 0;
  }

  handle(m) {
    if (m.type === 'buffer') this.setBuffer(m.L, m.R);
    else if (m.type === 'slices') this.setSlices(m.slices);
  }

  setBuffer(L, R) {
    for (const v of this.voices) v.active = false;
    this.L = L;
    this.R = R ?? L;
  }

  /** @param list [{ start, end (seconds), gain (dB), pan, pitch, rev }] */
  setSlices(list) {
    this.slices = list.map((s) => ({
      start: Math.max(0, Math.round(s.start * this.sr)),
      end: Math.max(0, Math.round(s.end * this.sr)),
      gain: 10 ** ((s.gain ?? 0) / 20),
      pan: s.pan ?? 0,
      pitch: s.pitch ?? 0,
      rev: !!s.rev,
    }));
  }

  noteOn(note, vel) {
    const s = this.slices[note - ROOT];
    if (!s || !this.L) return;
    const n = this.L.length;
    const start = Math.min(s.start, n);
    const end = Math.min(s.end, n);
    if (end - start < 2 * EDGE) return;
    if (this.p.choke === 0) for (const v of this.voices) if (v.active) v.choked = true;
    let v = this.voices.find((x) => !x.active);
    if (!v) v = this.voices.reduce((a, b) => (a.age < b.age ? a : b)); // steal the oldest
    const p = this.p;
    const [gl, gr] = panGains(s.pan);
    const amp = s.gain * (1 - p.vel + p.vel * (vel / 127) ** 1.5);
    Object.assign(v, {
      active: true,
      note,
      start,
      end,
      rev: s.rev,
      pos: s.rev ? end - 1 : start,
      pitch: s.pitch,
      gl: gl * amp,
      gr: gr * amp,
      env: p.attack > 0.0005 ? 0 : 1,
      stage: p.attack > 0.0005 ? 0 : 1, // 0 attack, 1 hold, 2 release
      choked: false,
      held: true,
      played: 0,
      slide: 0, // semitones, from the note's pitch slide
      age: ++this.age,
    });
    v.f.fill(0);
  }

  /** A note's pitch slide (cents) for the voices playing it. */
  notePitch(note, cents) {
    for (const v of this.voices) if (v.active && v.note === note && !v.choked) v.slide = cents / 100;
  }

  noteOff(note) {
    for (const v of this.voices) {
      if (!v.active || v.note !== note || !v.held) continue;
      v.held = false;
      if (this.p.mode === 1) v.stage = 2;
    }
  }

  allOff() {
    for (const v of this.voices) if (v.active) v.choked = true;
  }

  /** Playback speed from "fit to tempo": the whole file lasts that many beats. */
  syncRate() {
    const beats = SYNC_BEATS[this.p.sync] ?? 0;
    if (!beats || !this.L) return 1;
    return this.L.length / this.sr / ((beats * 60) / this.tempo);
  }

  render(outL, outR, off, frames) {
    if (!this.L) return;
    const p = this.p;
    const sr = this.sr;
    const n = this.L.length;
    const srcL = this.L;
    const srcR = this.R;
    const base = this.syncRate() * 2 ** ((p.pitch + this.bend) / 12);
    const attackInc = 1 / Math.max(1, p.attack * sr);
    const relMul = Math.exp(-6.9 / (Math.max(0.003, p.release) * sr));
    const chokeMul = Math.exp(-6.9 / (0.004 * sr));
    const master = 10 ** (p.gain / 20);
    // Low-pass (TPT state-variable filter), skipped when fully open.
    const filtered = p.cutoff < 19000 || p.reso > 0.01;
    const g = Math.tan((Math.PI * Math.min(p.cutoff, sr * 0.45)) / sr);
    const k = 1 / (0.707 + p.reso * 9);
    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    const a3 = g * a2;

    for (const v of this.voices) {
      if (!v.active) continue;
      const step = base * 2 ** ((v.pitch + v.slide) / 12) * (v.rev ? -1 : 1);
      const f = v.f;
      for (let i = 0; i < frames; i++) {
        if (v.choked) {
          v.env *= chokeMul;
          if (v.env < 1e-4) {
            v.active = false;
            break;
          }
        } else if (v.stage === 0) {
          v.env += attackInc;
          if (v.env >= 1) {
            v.env = 1;
            v.stage = 1;
          }
        } else if (v.stage === 2) {
          v.env *= relMul;
          if (v.env < 1e-4) {
            v.active = false;
            break;
          }
        }
        const remain = v.rev ? v.pos - v.start : v.end - 1 - v.pos;
        if (remain <= 0) {
          v.active = false;
          break;
        }
        const edge = Math.min(1, remain / EDGE, (v.played + 1) / EDGE);
        const i0 = Math.floor(v.pos);
        const fr = v.pos - i0;
        const i1 = i0 + 1 < n ? i0 + 1 : i0;
        let l = srcL[i0] + (srcL[i1] - srcL[i0]) * fr;
        let r = srcR[i0] + (srcR[i1] - srcR[i0]) * fr;
        if (filtered) {
          let v3 = l - f[1];
          let v1 = a1 * f[0] + a2 * v3;
          let v2 = f[1] + a2 * f[0] + a3 * v3;
          f[0] = 2 * v1 - f[0];
          f[1] = 2 * v2 - f[1];
          l = v2;
          v3 = r - f[3];
          v1 = a1 * f[2] + a2 * v3;
          v2 = f[3] + a2 * f[2] + a3 * v3;
          f[2] = 2 * v1 - f[2];
          f[3] = 2 * v2 - f[3];
          r = v2;
        }
        const a = v.env * edge * master;
        outL[off + i] += l * a * v.gl;
        outR[off + i] += r * a * v.gr;
        v.pos += step;
        v.played++;
      }
    }
  }

  status() {
    if (!this.L) return null;
    const playing = [];
    for (const v of this.voices) if (v.active && !v.choked) playing.push({ s: v.note - ROOT, x: v.pos / this.L.length });
    return { playing };
  }
}
