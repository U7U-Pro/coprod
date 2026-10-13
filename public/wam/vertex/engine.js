// Vertex synthesis engine. Pure JS, no DOM: runs in an AudioWorklet and in
// Node (tests render audio offline with it).
//
// Per voice: 2 wavetable oscillators (up to 16 unison voices each, with warp),
// a sub oscillator, noise, a multimode filter, 3 envelopes and 4 LFOs.
// Modulation is computed every BLOCK samples; audio runs per sample.

import { PARAMS, INDEX as I, DEFAULTS, SOURCES, VOICE_GROUPS, DIVISIONS, FX_KINDS } from './params.js';
import { SIZE, LEVELS } from './wavetables.js';
import { Distortion, Chorus, Flanger, Phaser, Delay, Reverb, Compressor, EQ } from './fx.js';

export const BLOCK = 32;
const MAX_VOICES = 16;
const MAX_UNISON = 16;
const NP = PARAMS.length;
const SRC = Object.fromEntries(SOURCES.map((s, i) => [s, i]));
const TAU = Math.PI * 2;
const fract = (v) => v - Math.floor(v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mtof = (n) => 440 * 2 ** ((n - 69) / 12);

const map = (i, n) => PARAMS[i].map(clamp01(n));

// Parameter indexes, resolved once (string lookups in the audio loop are slow).
const OSC = ['a', 'b'].map((o) =>
  Object.fromEntries(
    ['on', 'pos', 'oct', 'semi', 'fine', 'unison', 'detune', 'blend', 'width', 'phase', 'rand', 'warp', 'warpamt', 'level', 'pan', 'flt'].map((k) => [k, I[`${o}_${k}`]]),
  ),
);
const ENV = [1, 2, 3].map((n) => Object.fromEntries(['a', 'h', 'd', 's', 'r'].map((k) => [k, I[`env${n}_${k}`]])));
const LFO = [1, 2, 3, 4].map((n) => Object.fromEntries(['rate', 'sync', 'div', 'mode', 'shape', 'phase'].map((k) => [k, I[`lfo${n}_${k}`]])));
const MACRO = [1, 2, 3, 4].map((n) => I[`macro${n}`]);
const FX_ON = Object.fromEntries(FX_KINDS.map((k) => [k, I[`${k}_on`]]));

// ------------------------------------------------------------------ envelopes

class Env {
  constructor() {
    this.stage = 0; // 0 idle, 1 attack, 2 hold, 3 decay, 4 sustain, 5 release
    this.v = 0;
    this.t = 0;
    this.from = 0;
  }
  gate(on) {
    if (on) {
      this.stage = 1;
      this.t = 0;
      this.from = this.v;
    } else if (this.stage && this.stage !== 5) {
      this.stage = 5;
      this.t = 0;
      this.from = this.v;
    }
  }
  /** Advance by dt seconds with times a, h, d, r and sustain level s. */
  step(dt, a, h, d, s, r) {
    this.t += dt;
    switch (this.stage) {
      case 1:
        if (this.t >= a) {
          this.stage = 2;
          this.t = 0;
          this.v = 1;
        } else this.v = this.from + (1 - this.from) * (this.t / a);
        break;
      case 2:
        this.v = 1;
        if (this.t >= h) {
          this.stage = 3;
          this.t = 0;
        }
        break;
      case 3:
        if (this.t >= d) {
          this.stage = 4;
          this.v = s;
        } else {
          const k = 1 - this.t / d;
          this.v = s + (1 - s) * k * k * k;
        }
        break;
      case 4:
        this.v = s;
        break;
      case 5:
        if (this.t >= r) {
          this.stage = 0;
          this.v = 0;
        } else {
          const k = 1 - this.t / r;
          this.v = this.from * k * k * k;
        }
        break;
    }
    return this.v;
  }
}

// ------------------------------------------------------------------ LFO shapes

function lfoShape(shape, p, st, custom) {
  switch (shape) {
    case 0:
      return 0.5 + 0.5 * Math.sin(TAU * p);
    case 1:
      return p < 0.5 ? p * 2 : 2 - p * 2;
    case 2:
      return p;
    case 3:
      return 1 - p;
    case 4:
      return p < 0.5 ? 1 : 0;
    case 5:
      return st.sh;
    case 6: {
      const t = 0.5 - 0.5 * Math.cos(Math.PI * p);
      return st.prev + (st.sh - st.prev) * t;
    }
    default: {
      // custom points [[x, y], ...], linear between points
      if (!custom || custom.length < 2) return 0;
      let k = 1;
      while (k < custom.length - 1 && custom[k][0] < p) k++;
      const [x0, y0] = custom[k - 1];
      const [x1, y1] = custom[k];
      return x1 > x0 ? y0 + ((y1 - y0) * (p - x0)) / (x1 - x0) : y1;
    }
  }
}

class Lfo {
  constructor() {
    this.phase = 0;
    this.sh = Math.random();
    this.prev = this.sh;
    this.value = 0;
    this.done = false;
  }
  reset(phase) {
    this.phase = phase;
    this.done = false;
  }
  /** Advance by `cycles` of the LFO and return its value (0..1). */
  advance(cycles, shape, mode, custom) {
    if (!this.done) {
      this.phase += cycles;
      if (this.phase >= 1) {
        if (mode === 2) {
          this.phase = 1;
          this.done = true; // envelope mode: one shot
        } else {
          this.phase -= Math.floor(this.phase);
          this.prev = this.sh;
          this.sh = Math.random();
        }
      }
    }
    this.value = lfoShape(shape, this.done ? 0.999999 : this.phase, this, custom);
    return this.value;
  }
}

// ------------------------------------------------------------------ voice

class Osc {
  constructor() {
    this.phases = new Float64Array(MAX_UNISON);
    this.incs = new Float64Array(MAX_UNISON);
    this.gl = new Float32Array(MAX_UNISON);
    this.gr = new Float32Array(MAX_UNISON);
    this.n = 1;
  }
  start(phase, rand) {
    for (let k = 0; k < MAX_UNISON; k++) this.phases[k] = fract(phase + rand * Math.random());
  }
}

class Svf {
  constructor() {
    this.s1 = 0;
    this.s2 = 0;
  }
  reset() {
    this.s1 = this.s2 = 0;
  }
}

class Voice {
  constructor() {
    this.active = false;
    this.gate = false;
    this.note = 60;
    this.vel = 0;
    this.age = 0;
    this.pitch = 60; // current (gliding) pitch
    this.sustained = false;
    this.rand = 0;
    this.envs = [new Env(), new Env(), new Env()];
    this.lfos = [new Lfo(), new Lfo(), new Lfo(), new Lfo()];
    this.osc = [new Osc(), new Osc()];
    this.subPhase = 0;
    this.pink = new Float64Array(7);
    this.f = [new Svf(), new Svf(), new Svf(), new Svf()]; // stage1 L/R, stage2 L/R
    this.p = new Float32Array(NP); // effective normalized params this block
    this.lastA = 0;
  }
}

// ------------------------------------------------------------------ engine

export class VertexEngine {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.base = Float32Array.from(DEFAULTS);
    this.auto = new Float32Array(NP).fill(NaN); // host automation overrides
    this.eff = new Float32Array(NP); // base with automation applied
    this.g = new Float32Array(NP); // global effective params (eff + global mods)
    this.voices = Array.from({ length: MAX_VOICES }, () => new Voice());
    this.routes = []; // [{ src, dst, amt, bi }]
    this.custom = [null, null, null, null]; // custom LFO points
    this.tables = [null, null];
    this.tempo = 120;
    this.modWheel = 0;
    this.bendValue = 0; // -1..1
    this.sustain = false;
    this.lastNote = 60;
    this.lastVel = 0;
    this.lastRand = 0;
    this.heldNotes = []; // for mono mode
    this.counter = 0;
    this.glfo = [new Lfo(), new Lfo(), new Lfo(), new Lfo()]; // free-running copies for global targets
    this.fx = {
      dist: new Distortion(sampleRate),
      chorus: new Chorus(sampleRate),
      flanger: new Flanger(sampleRate),
      phaser: new Phaser(sampleRate),
      delay: new Delay(sampleRate),
      reverb: new Reverb(sampleRate),
      comp: new Compressor(sampleRate),
      eq: new EQ(sampleRate),
    };
    this.fxOrder = [...FX_KINDS];
    this.bufL = new Float32Array(BLOCK);
    this.bufR = new Float32Array(BLOCK);
    this.srcVals = new Float32Array(SOURCES.length);
    this.voiceRoutes = [];
    this.globalRoutes = [];
    this.fxp = {};
  }

  // ---------------------------------------------------------------- configuration

  setParam(i, n) {
    this.base[i] = clamp01(n);
  }
  setParams(values) {
    this.base.set(values);
  }
  setAutomation(i, n) {
    this.auto[i] = n === null ? NaN : clamp01(n);
  }
  clearAutomation() {
    this.auto.fill(NaN);
  }
  setRoutes(routes) {
    this.routes = routes
      .map((r) => ({ src: SRC[r.src], dst: I[r.dst], amt: Math.max(-1, Math.min(1, +r.amt || 0)), bi: !!r.bi }))
      .filter((r) => r.src !== undefined && r.dst !== undefined);
    this.voiceRoutes = this.routes.filter((r) => VOICE_GROUPS.has(PARAMS[r.dst].group));
    this.globalRoutes = this.routes.filter((r) => !VOICE_GROUPS.has(PARAMS[r.dst].group));
  }
  setLfoShape(n, points) {
    this.custom[n] = Array.isArray(points) && points.length >= 2 ? points.map(([x, y]) => [clamp01(x), clamp01(y)]).sort((a, b) => a[0] - b[0]) : null;
  }
  /** table = { data, frames, levels, row } from buildMips(). */
  setTable(osc, table) {
    this.tables[osc] = table;
  }
  setFxOrder(order) {
    const valid = order.filter((k) => FX_KINDS.includes(k));
    this.fxOrder = [...new Set([...valid, ...FX_KINDS])];
  }
  setTempo(bpm) {
    if (bpm > 0) this.tempo = bpm;
  }

  // ---------------------------------------------------------------- MIDI

  noteOn(note, vel) {
    if (vel <= 0) return this.noteOff(note);
    const v = vel / 127;
    this.lastNote = note;
    this.lastVel = v;
    this.lastRand = Math.random();
    const poly = map(I.poly, this.base[I.poly]);
    const legato = this.base[I.legato] >= 0.5;
    const glide = map(I.glide, this.base[I.glide]);
    const prevPitch = this.lastPitch ?? note;
    this.lastPitch = note;

    if (poly === 1) {
      this.heldNotes = this.heldNotes.filter((n) => n !== note);
      this.heldNotes.push(note);
      const voice = this.voices[0];
      const wasGated = voice.active && voice.gate;
      voice.note = note;
      voice.vel = v;
      voice.gate = true;
      voice.sustained = false;
      if (!(legato && wasGated)) this.trigger(voice, note, v, glide > 0 ? voice.active ? voice.pitch : prevPitch : note);
      return;
    }
    // Poly: a free voice, else steal the oldest (released ones first).
    let best = null;
    for (let k = 0; k < poly; k++) {
      const vc = this.voices[k];
      if (!vc.active) {
        best = vc;
        break;
      }
      if (!best || (best.gate && !vc.gate) || (best.gate === vc.gate && vc.age < best.age)) best = vc;
    }
    best.note = note;
    best.vel = v;
    best.gate = true;
    best.sustained = false;
    this.trigger(best, note, v, glide > 0 ? prevPitch : note);
  }

  trigger(voice, note, vel, fromPitch) {
    const wasActive = voice.active;
    voice.active = true;
    voice.age = this.counter++;
    voice.pitch = fromPitch;
    voice.rand = Math.random();
    for (const e of voice.envs) e.gate(true);
    for (let n = 0; n < 4; n++) {
      if (map(LFO[n].mode, this.base[LFO[n].mode]) !== 1) voice.lfos[n].reset(this.base[LFO[n].phase]);
    }
    if (!wasActive) {
      for (let o = 0; o < 2; o++) voice.osc[o].start(this.base[OSC[o].phase], this.base[OSC[o].rand]);
      voice.subPhase = 0;
      for (const f of voice.f) f.reset();
    }
  }

  noteOff(note) {
    const poly = map(I.poly, this.base[I.poly]);
    if (poly === 1) {
      this.heldNotes = this.heldNotes.filter((n) => n !== note);
      const voice = this.voices[0];
      if (!voice.gate || voice.note !== note) return;
      if (this.heldNotes.length) {
        // fall back to the previous held key, legato style
        const back = this.heldNotes.at(-1);
        voice.note = back;
        this.lastPitch = back;
        if (this.base[I.legato] < 0.5) this.trigger(voice, back, voice.vel, voice.pitch);
        return;
      }
      if (this.sustain) voice.sustained = true;
      else this.release(voice);
      return;
    }
    for (const v of this.voices) {
      if (v.active && v.gate && v.note === note) {
        if (this.sustain) v.sustained = true;
        else this.release(v);
      }
    }
  }

  release(v) {
    v.gate = false;
    v.sustained = false;
    for (const e of v.envs) e.gate(false);
  }

  cc(num, value) {
    if (num === 1) this.modWheel = value / 127;
    else if (num === 64) {
      this.sustain = value >= 64;
      if (!this.sustain) for (const v of this.voices) if (v.sustained) this.release(v);
    } else if (num === 120 || num === 123) {
      this.heldNotes = [];
      for (const v of this.voices) if (v.active) this.release(v);
      if (num === 120) for (const v of this.voices) v.active = false;
    }
  }

  pitchBend(v14) {
    this.bendValue = (v14 - 8192) / 8192;
  }

  allOff() {
    this.cc(120, 0);
  }

  activeVoices() {
    let n = 0;
    for (const v of this.voices) if (v.active) n++;
    return n;
  }

  // ---------------------------------------------------------------- modulation

  lfoRate(n, p) {
    const L = LFO[n];
    if (p[L.sync] >= 0.5) return this.tempo / 60 / DIVISIONS[map(L.div, p[L.div])][1];
    return map(L.rate, p[L.rate]);
  }

  /** Global params: base + automation + modulation from global sources. */
  updateGlobal(dt) {
    const eff = this.eff;
    for (let i = 0; i < NP; i++) eff[i] = Number.isNaN(this.auto[i]) ? this.base[i] : this.auto[i];
    const s = this.srcVals;
    s.fill(0);
    for (let n = 0; n < 4; n++) {
      s[SRC.lfo1 + n] = this.glfo[n].advance(this.lfoRate(n, eff) * dt, map(LFO[n].shape, eff[LFO[n].shape]), 1, this.custom[n]);
    }
    s[SRC.vel] = this.lastVel;
    s[SRC.note] = this.lastNote / 127;
    s[SRC.mod] = this.modWheel;
    s[SRC.rand] = this.lastRand;
    for (let m = 0; m < 4; m++) s[SRC.macro1 + m] = eff[MACRO[m]];
    this.g.set(eff);
    for (const r of this.globalRoutes) {
      const sv = s[r.src];
      this.g[r.dst] = clamp01(this.g[r.dst] + (r.bi ? sv * 2 - 1 : sv) * r.amt);
    }
  }

  /** Per-voice params for this block. */
  updateVoice(v, dt) {
    const p = v.p;
    p.set(this.eff);
    const s = this.srcVals;
    // envelopes 2 and 3 run at block rate; env 1 runs per sample in render()
    s[SRC.env1] = v.envs[0].v;
    for (let n = 1; n < 3; n++) {
      const E = ENV[n];
      s[SRC.env1 + n] = v.envs[n].step(dt, map(E.a, p[E.a]), map(E.h, p[E.h]), map(E.d, p[E.d]), p[E.s], map(E.r, p[E.r]));
    }
    for (let n = 0; n < 4; n++) {
      const L = LFO[n];
      const mode = map(L.mode, p[L.mode]);
      s[SRC.lfo1 + n] = mode === 1 ? this.glfo[n].value : v.lfos[n].advance(this.lfoRate(n, p) * dt, map(L.shape, p[L.shape]), mode, this.custom[n]);
    }
    s[SRC.vel] = v.vel;
    s[SRC.note] = v.note / 127;
    s[SRC.rand] = v.rand;
    for (const r of this.voiceRoutes) {
      const sv = s[r.src];
      p[r.dst] = clamp01(p[r.dst] + (r.bi ? sv * 2 - 1 : sv) * r.amt);
    }
  }

  // ---------------------------------------------------------------- audio

  /** Render `n` (<= BLOCK) stereo samples into outL/outR at `offset`. */
  render(outL, outR, offset, n) {
    const dt = n / this.sr;
    this.updateGlobal(dt);
    const L = this.bufL;
    const R = this.bufR;
    L.fill(0, 0, n);
    R.fill(0, 0, n);
    for (const v of this.voices) if (v.active) this.renderVoice(v, L, R, n, dt);
    this.runFx(L, R, n);
    const vol = 10 ** (map(I.vol, this.g[I.vol]) / 20);
    for (let i = 0; i < n; i++) {
      outL[offset + i] = L[i] * vol;
      outR[offset + i] = R[i] * vol;
    }
  }

  renderVoice(v, L, R, n, dt) {
    this.updateVoice(v, dt);
    const p = v.p;
    const sr = this.sr;

    // pitch with glide and bend
    const glide = map(I.glide, p[I.glide]);
    if (glide > 0) v.pitch += (v.note - v.pitch) * (1 - Math.exp(-dt / (glide / 4)));
    else v.pitch = v.note;
    const pitch = v.pitch + this.bendValue * map(I.bend, p[I.bend]);

    // oscillator setup for this block
    const oscOn = [false, false];
    const T = this.tables;
    const os = [null, null];
    for (let o = 0; o < 2; o++) {
      const X = OSC[o];
      const tbl = T[o];
      if (p[X.on] < 0.5 || !tbl) continue;
      oscOn[o] = true;
      const osc = v.osc[o];
      const n_ = map(X.unison, p[X.unison]);
      const det = p[X.detune] * 50; // cents to the outermost voice
      const blend = p[X.blend];
      const width = p[X.width];
      const pan = map(X.pan, p[X.pan]);
      const level = p[X.level];
      const semis = pitch + map(X.oct, p[X.oct]) * 12 + map(X.semi, p[X.semi]) + map(X.fine, p[X.fine]) / 100;
      const f0 = mtof(semis);
      const warp = map(X.warp, p[X.warp]);
      const wamt = p[X.warpamt];
      let maxF = 0;
      const norm = 1 / Math.sqrt(n_);
      for (let k = 0; k < n_; k++) {
        const x = n_ > 1 ? (k / (n_ - 1)) * 2 - 1 : 0; // -1..1 across the stack
        const f = f0 * 2 ** ((x * det) / 1200);
        osc.incs[k] = f / sr;
        maxF = Math.max(maxF, f);
        // the middle voice (or middle two, for even counts) is the "center"
        const isCenter = n_ <= 2 || Math.abs(x) <= 1 / (n_ - 1) + 1e-9;
        const g = (isCenter ? 1 : blend) * level * norm;
        const pp = Math.max(-1, Math.min(1, pan + x * width));
        osc.gl[k] = g * Math.cos(((pp + 1) * Math.PI) / 4) * Math.SQRT2;
        osc.gr[k] = g * Math.sin(((pp + 1) * Math.PI) / 4) * Math.SQRT2;
      }
      osc.n = n_;
      // Warps that add harmonics need a more filtered mip level.
      const mult = warp === 1 ? 1 + wamt * 7 : warp === 7 ? 1 + wamt * 4 : 1;
      const harm = Math.max(1, Math.floor(sr / 2 / (maxF * mult * 1.02)));
      const level_ = Math.max(0, Math.min(LEVELS - 1, Math.ceil(Math.log2(1024 / harm))));
      const fpos = p[X.pos] * (tbl.frames - 1);
      const f0i = Math.min(tbl.frames - 1, Math.floor(fpos));
      const f1i = Math.min(tbl.frames - 1, f0i + 1);
      os[o] = {
        osc,
        data: tbl.data,
        r0: (level_ * tbl.frames + f0i) * tbl.row,
        r1: (level_ * tbl.frames + f1i) * tbl.row,
        ff: fpos - f0i,
        warp,
        wamt,
        flt: p[X.flt] >= 0.5,
      };
    }

    // sub, noise
    const subOn = p[I.sub_on] >= 0.5;
    const subInc = mtof(pitch + map(I.sub_oct, p[I.sub_oct]) * 12) / sr;
    const subShape = map(I.sub_shape, p[I.sub_shape]);
    const subLvl = p[I.sub_level];
    const subPan = map(I.sub_pan, p[I.sub_pan]);
    const subL = subLvl * Math.cos(((subPan + 1) * Math.PI) / 4) * Math.SQRT2;
    const subR = subLvl * Math.sin(((subPan + 1) * Math.PI) / 4) * Math.SQRT2;
    const subFlt = p[I.sub_flt] >= 0.5;
    const noiseOn = p[I.noise_on] >= 0.5;
    const pink = map(I.noise_type, p[I.noise_type]) === 1;
    const nLvl = p[I.noise_level] * 0.5;
    const nPan = map(I.noise_pan, p[I.noise_pan]);
    const nL = nLvl * Math.cos(((nPan + 1) * Math.PI) / 4) * Math.SQRT2;
    const nR = nLvl * Math.sin(((nPan + 1) * Math.PI) / 4) * Math.SQRT2;
    const nFlt = p[I.noise_flt] >= 0.5;

    // filter
    const fOn = p[I.flt_on] >= 0.5;
    const ftype = map(I.flt_type, p[I.flt_type]);
    const key = p[I.flt_key];
    const fc = Math.min(sr * 0.45, map(I.flt_cutoff, p[I.flt_cutoff]) * 2 ** (((pitch - 60) / 12) * key));
    const res = p[I.flt_res];
    const drive = p[I.flt_drive];
    const fmix = p[I.flt_mix];
    const gg = Math.tan((Math.PI * fc) / sr);
    const k2 = 2 - 1.96 * res; // resonant stage
    const k1 = ftype === 1 || ftype === 3 ? 1.4142 : k2; // 24 dB: a flat first stage
    const a1 = 1 / (1 + gg * (gg + k1));
    const b1 = 1 / (1 + gg * (gg + k2));
    const twoStage = ftype === 1 || ftype === 3;
    const dg = 1 + drive * 8;
    const dn = drive > 0 ? 1 / Math.tanh(dg) : 1;

    // env 1 (amp)
    const env = v.envs[0];
    const ea = map(I.env1_a, p[I.env1_a]);
    const eh = map(I.env1_h, p[I.env1_h]);
    const ed = map(I.env1_d, p[I.env1_d]);
    const es = p[I.env1_s];
    const er = map(I.env1_r, p[I.env1_r]);
    // Amp envelope at block rate, ramped linearly across the block.
    const e0 = env.v;
    const e1 = env.step(dt, ea, eh, ed, es, er);
    const eInc = (e1 - e0) / n;

    // Oscillators run one unison voice at a time across the block (fast in
    // JS); B first so A's FM/RM warps can read it.
    const oL = this.oscL ?? (this.oscL = new Float32Array(BLOCK));
    const oR = this.oscR ?? (this.oscR = new Float32Array(BLOCK));
    const dL = this.dirL ?? (this.dirL = new Float32Array(BLOCK));
    const dR = this.dirR ?? (this.dirR = new Float32Array(BLOCK));
    const bMono = this.bMono ?? (this.bMono = new Float32Array(BLOCK));
    oL.fill(0, 0, n);
    oR.fill(0, 0, n);
    dL.fill(0, 0, n);
    dR.fill(0, 0, n);
    bMono.fill(0, 0, n);
    let lastA = v.lastA;
    if (os[1]) renderOsc(os[1], n, os[1].flt ? oL : dL, os[1].flt ? oR : dR, bMono, null, lastA);
    if (os[0]) lastA = renderOsc(os[0], n, os[0].flt ? oL : dL, os[0].flt ? oR : dR, null, bMono, 0);
    const fs = v.f;
    for (let i = 0; i < n; i++) {
      let fl = oL[i]; // into the filter
      let fr = oR[i];
      let dl = dL[i]; // straight to the output
      let dr = dR[i];
      if (subOn) {
        v.subPhase += subInc;
        if (v.subPhase >= 1) v.subPhase -= 1;
        const ph = v.subPhase;
        let s;
        if (subShape === 0) s = Math.sin(TAU * ph);
        else if (subShape === 1) s = 1 - 4 * Math.abs(ph - 0.5);
        else if (subShape === 2) s = 2 * ph - 1 - polyBlep(ph, subInc);
        else s = (ph < 0.5 ? 1 : -1) + polyBlep(ph, subInc) - polyBlep(fract(ph + 0.5), subInc);
        if (subFlt) {
          fl += s * subL;
          fr += s * subR;
        } else {
          dl += s * subL;
          dr += s * subR;
        }
      }
      if (noiseOn) {
        let s = Math.random() * 2 - 1;
        if (pink) s = pinkStep(v.pink, s);
        if (nFlt) {
          fl += s * nL;
          fr += s * nR;
        } else {
          dl += s * nL;
          dr += s * nR;
        }
      }
      // filter (TPT state-variable, Simper)
      if (fOn) {
        let xl = fl;
        let xr = fr;
        if (drive > 0) {
          xl = Math.tanh(xl * dg) * dn;
          xr = Math.tanh(xr * dg) * dn;
        }
        let yl = svf(fs[0], xl, gg, k1, a1, ftype);
        let yr = svf(fs[1], xr, gg, k1, a1, ftype);
        if (twoStage) {
          yl = svf(fs[2], yl, gg, k2, b1, ftype);
          yr = svf(fs[3], yr, gg, k2, b1, ftype);
        }
        fl = fl + (yl - fl) * fmix;
        fr = fr + (yr - fr) * fmix;
      }
      const amp = e0 + eInc * (i + 1);
      L[i] += (fl + dl) * amp;
      R[i] += (fr + dr) * amp;
    }
    v.lastA = lastA;
    if (env.stage === 0) v.active = false;
  }

  runFx(L, R, n) {
    const g = this.g;
    const val = (id) => map(I[id], g[I[id]]);
    for (const kind of this.fxOrder) {
      if (g[FX_ON[kind]] < 0.5) continue;
      const fx = this.fx[kind];
      switch (kind) {
        case 'dist':
          fx.process(L, R, n, { type: val('dist_type'), drive: g[I.dist_drive], mix: g[I.dist_mix] });
          break;
        case 'chorus':
          fx.process(L, R, n, { rate: val('chorus_rate'), depth: g[I.chorus_depth], mix: g[I.chorus_mix] });
          break;
        case 'flanger':
          fx.process(L, R, n, { rate: val('flanger_rate'), depth: g[I.flanger_depth], fb: val('flanger_fb'), mix: g[I.flanger_mix] });
          break;
        case 'phaser':
          fx.process(L, R, n, { rate: val('phaser_rate'), depth: g[I.phaser_depth], fb: val('phaser_fb'), mix: g[I.phaser_mix] });
          break;
        case 'delay': {
          const seconds = g[I.delay_sync] >= 0.5 ? (60 / this.tempo) * DIVISIONS[val('delay_div')][1] : val('delay_time');
          fx.process(L, R, n, { seconds, fb: val('delay_fb'), pingpong: g[I.delay_pp] >= 0.5, tone: val('delay_tone'), mix: g[I.delay_mix] });
          break;
        }
        case 'reverb':
          fx.process(L, R, n, { size: g[I.reverb_size], damp: g[I.reverb_damp], width: g[I.reverb_width], mix: g[I.reverb_mix] });
          break;
        case 'comp':
          fx.process(L, R, n, {
            mode: val('comp_mode'),
            thresh: val('comp_thresh'),
            ratio: val('comp_ratio'),
            attack: val('comp_attack'),
            release: val('comp_release'),
            depth: g[I.comp_depth],
            gain: val('comp_gain'),
          });
          break;
        case 'eq':
          fx.process(L, R, n, { lowf: val('eq_lowf'), lowg: val('eq_lowg'), midf: val('eq_midf'), midg: val('eq_midg'), highf: val('eq_highf'), highg: val('eq_highg') });
          break;
      }
    }
  }

  /** Render any number of frames (used by the worklet and tests). */
  process(outL, outR, frames) {
    for (let off = 0; off < frames; off += BLOCK) this.render(outL, outR, off, Math.min(BLOCK, frames - off));
  }
}

/**
 * One oscillator (all unison voices) for a block. Adds to outL/outR, writes
 * its mono signal to `mono` if given, and reads `mod` (the other oscillator)
 * for the FM and RM warps. Returns the last mono sample.
 */
function renderOsc(O, n, outL, outR, mono, mod, modConst) {
  const osc = O.osc;
  const data = O.data;
  const r0 = O.r0;
  const r1 = O.r1;
  const ff = O.ff;
  const warp = O.warp;
  const w = O.wamt;
  const phases = osc.phases;
  const count = osc.n;
  let last = 0;
  for (let k = 0; k < count; k++) {
    let ph = phases[k];
    const inc = osc.incs[k];
    const gl = osc.gl[k];
    const gr = osc.gr[k];
    for (let i = 0; i < n; i++) {
      ph += inc;
      if (ph >= 1) ph -= 1;
      let q = ph;
      if (warp !== 0) {
        switch (warp) {
          case 1: // sync
            q = fract(ph * (1 + w * 7));
            break;
          case 2: // bend +
            q = q < 0.5 ? 0.5 * (2 * q) ** (1 / (1 + w * 3)) : 1 - 0.5 * (2 - 2 * q) ** (1 / (1 + w * 3));
            break;
          case 3: // bend -
            q = q < 0.5 ? 0.5 * (2 * q) ** (1 + w * 3) : 1 - 0.5 * (2 - 2 * q) ** (1 + w * 3);
            break;
          case 4: {
            // PWM: squeeze the first half of the cycle
            const d = 0.5 - w * 0.49;
            q = q < d ? (q * 0.5) / d : 0.5 + ((q - d) * 0.5) / (1 - d);
            break;
          }
          case 5: // mirror: blend toward reading the table forward then backward
            q += ((q < 0.5 ? 2 * q : 2 - 2 * q) - q) * w;
            break;
          case 6: {
            const steps = 2 ** (10 - w * 8);
            q = Math.floor(q * steps) / steps;
            break;
          }
          case 7: // FM from the other oscillator
            q = fract(q + w * 0.5 * (mod ? mod[i] : modConst));
            break;
        }
      }
      const x = q * SIZE;
      const xi = x | 0;
      const xf = x - xi;
      const i0 = r0 + xi;
      const i1 = r1 + xi;
      const s0 = data[i0] + (data[i0 + 1] - data[i0]) * xf;
      const s1 = data[i1] + (data[i1 + 1] - data[i1]) * xf;
      let s = s0 + (s1 - s0) * ff;
      if (warp === 8) s *= 1 - w + w * (mod ? mod[i] : modConst); // ring mod
      outL[i] += s * gl;
      outR[i] += s * gr;
      if (mono) mono[i] += s / count;
      if (k === count - 1) last = s;
    }
    phases[k] = ph;
  }
  return last;
}

function svf(st, x, g, k, a1, type) {
  // one TPT SVF step; returns the mode's output
  const a2 = g * a1;
  const a3 = g * a2;
  const v3 = x - st.s2;
  const v1 = a1 * st.s1 + a2 * v3;
  const v2 = st.s2 + a2 * st.s1 + a3 * v3;
  st.s1 = 2 * v1 - st.s1;
  st.s2 = 2 * v2 - st.s2;
  switch (type) {
    case 0:
    case 1:
      return v2; // low
    case 2:
    case 3:
      return x - k * v1 - v2; // high
    case 4:
      return v1 * k; // band (normalized)
    default:
      return x - k * v1; // notch
  }
}

function polyBlep(t, dt) {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

function pinkStep(b, white) {
  // Paul Kellet's refined pink noise filter
  b[0] = 0.99886 * b[0] + white * 0.0555179;
  b[1] = 0.99332 * b[1] + white * 0.0750759;
  b[2] = 0.969 * b[2] + white * 0.153852;
  b[3] = 0.8665 * b[3] + white * 0.3104856;
  b[4] = 0.55 * b[4] + white * 0.5329522;
  b[5] = -0.7616 * b[5] - white * 0.016898;
  const out = b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + b[6] + white * 0.5362;
  b[6] = white * 0.115926;
  return out * 0.11;
}
