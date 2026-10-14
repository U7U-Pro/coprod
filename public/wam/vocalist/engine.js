// Vocalist's audio engine: a formant singing synthesizer (Klatt-style).
//
//   LF glottal pulse (+ breath noise) -> nasal pole/zero -> 5 formant resonators -+-> out
//   frication noise -> two band-passes + flat ------------------------------------+
//
// Notes arrive ahead of time (enqueue) with their lyrics, so each syllable's
// consonants can start before the beat and the vowel lands on it, the way
// singers (and Vocaloid's "pre-utterance") do. A note's final consonants go
// just before it ends, or just before the next note's consonants.

import { ParamEngine, rng } from '../kit/engine.js';
import { TABLE } from './params.js';
import { glottalTables, RD_MIN, RD_MAX, FRAMES } from './glottal.js';
import { vowelTarget, vowelEnd, isDiphthong, consonantSegments, sustainTarget, SILENCE, VOWELS } from './phonemes.js';
import { singable } from './lyrics.js';

const PRE_MAX = 0.09; // seconds of consonants allowed before the beat (the host schedules ~0.1 s ahead)
const LEGATO_GAP = 0.03; // a shorter gap between notes still counts as connected
const PRE_SHARE = 0.4; // pre-utterance may take at most this much of the previous note
const VOWEL_SHARE = 0.55; // vowels keep at least this much of a note's own time
const DEFAULT_SYLLABLE = singable('/aa'); // notes without a lyric sing "ah"
const SOURCE_GAIN = 0.32;
const FRIC_GAIN = 0.55;
const OUT_GAIN = 0.16;
const AMP_KEYS = ['av', 'ah', 'af', 'g1', 'g2', 'flat'];
const FORMANT_KEYS = ['f1', 'f2', 'f3', 'b1', 'b2', 'b3', 'fc1', 'bw1', 'fc2', 'bw2', 'nas'];

export class VocalEngine extends ParamEngine {
  constructor(sampleRate, seed = 7) {
    super(sampleRate, TABLE);
    this.gt = glottalTables();
    this.rand = rng(seed);
    this.notes = []; // sorted by onsetStart
    this.lyrics = []; // lyric events waiting for their note-on
    this.frame = 0;
    this.ci = -1; // index of the note being sung
    this.cur = { ...SILENCE };
    this.semis = 60;
    this.pitchTau = 0.05;
    this.sungNote = null;
    this.vibPhase = 0;
    this.drift = 0;
    this.driftV = 0;
    this.phase = 0;
    this.jit = 1;
    this.shim = 1;
    this.odd = false;
    this.lp = 0; // aspiration noise high-pass state
    this.s = new Float64Array(32); // filter states
    this.dc = [0, 0];
    this.seg = null;
    this.coef = new Float64Array(15);
  }

  // ---------------------------------------------------------------- notes in

  /** A note on/off or lyric event, as soon as the host sends it. */
  enqueue(ev) {
    const at = Math.max(this.frame, Math.round(ev.time * this.sr));
    if (ev.kind === 'lyric') {
      this.lyrics.push({ at, note: ev.note, text: ev.text });
      if (this.lyrics.length > 64) this.lyrics.shift();
      return;
    }
    const [status, a, b] = ev.bytes;
    if ((status & 0xf0) === 0x90 && b > 0) this.noteOn(a, b, at);
    else this.noteOff(a, at);
  }

  noteOn(pitch, vel, at = this.frame) {
    const li = this.lyrics.findIndex((l) => l.note === pitch && Math.abs(l.at - at) <= 2);
    const text = li >= 0 ? this.lyrics.splice(li, 1)[0].text : null;
    let syl = singable(text) ?? DEFAULT_SYLLABLE;
    const prev = this.lastNoteBefore(at);
    const note = { pitch, vel: vel / 127, start: at, end: Infinity, cut: Infinity, plan: null, planKey: '' };
    if (syl.hold) {
      // Melisma: carry on the previous syllable's vowel; its final consonants move here.
      const last = prev?.syl.at(-1);
      if (last) {
        syl = [{ on: [], nuc: isDiphthong(last.nuc) ? `${last.nuc}:end` : last.nuc, co: last.co }];
        prev.noCoda = true;
        prev.plan = null;
      } else syl = DEFAULT_SYLLABLE;
    }
    note.syl = syl;

    // Pre-utterance: as much of the first onset as fits before the beat,
    // without taking too much of the previous note (or more than the rest before).
    const first = syl[0];
    const onset = consonantSegments(first.on, this.nucleusStart(first.nuc), true, this.p.consonants);
    const pre = (onset.reduce((s, x) => s + x.ms, 0) / 1000) * this.sr;
    const prevEnd = prev ? Math.min(prev.end, prev.cut) : -Infinity;
    const room = Math.max(0, Math.min(PRE_MAX * this.sr, at - this.frame, prev ? Math.max(at - prevEnd, (at - prev.start) * PRE_SHARE) : Infinity));
    note.onsetScale = pre > room ? Math.max(0.5, room / pre) : 1;
    note.onsetStart = at - Math.min(pre * note.onsetScale, room);

    if (prev) {
      note.legato = prevEnd >= note.onsetStart - LEGATO_GAP * this.sr;
      if (prevEnd > note.onsetStart) {
        prev.cut = Math.max(prev.start + 1, note.onsetStart);
        prev.plan = null;
      }
    }
    let i = this.notes.length;
    while (i > 0 && this.notes[i - 1].onsetStart > note.onsetStart) i--;
    this.notes.splice(i, 0, note);
    if (i <= this.ci) this.ci++;
  }

  noteOff(pitch, at = this.frame) {
    for (let i = this.notes.length - 1; i >= 0; i--) {
      const n = this.notes[i];
      if (n.pitch === pitch && n.end === Infinity && n.start <= at) {
        n.end = Math.max(at, n.start + 1);
        n.plan = null;
        return;
      }
    }
  }

  lastNoteBefore(at) {
    for (let i = this.notes.length - 1; i >= 0; i--) if (this.notes[i].start <= at) return this.notes[i];
    return null;
  }

  /** Stop: forget notes that haven't started; end the one that's sounding. */
  clear() {
    this.notes = this.notes.filter((n) => n.onsetStart <= this.frame);
    this.ci = Math.min(this.ci, this.notes.length - 1);
    this.lyrics.length = 0;
    this.allOff();
  }

  allOff() {
    for (const n of this.notes) if (Math.min(n.end, n.cut) > this.frame) {
      n.cut = Math.max(n.start + 1, this.frame);
      n.noCoda = true;
      n.plan = null;
    }
  }

  // ---------------------------------------------------------------- timeline

  nucleusStart(p) {
    if (p.endsWith(':end')) return vowelEnd(p.slice(0, -4));
    return VOWELS[p] ? vowelTarget(p) : sustainTarget(p) ?? VOWELS.ah;
  }

  /** The segments of a note: [{ t0, t1, t (target), label }], in frames. */
  planOf(note) {
    const end = Math.min(note.end, note.cut);
    const amount = this.p.consonants;
    const key = `${end}|${note.noCoda ? 1 : 0}|${amount.toFixed(2)}`;
    if (note.plan && note.planKey === key) return note.plan;
    const sr = this.sr / 1000; // frames per ms
    const segs = [];
    let t = note.onsetStart;
    const push = (target, frames, label, kind) => {
      if (frames <= 0) return;
      segs.push({ t0: t, t1: t + frames, t: target, label, kind });
      t += frames;
    };
    const syl = note.syl;
    const first = syl[0];
    for (const s of consonantSegments(first.on, this.nucleusStart(first.nuc), true, amount)) push(s.t, s.ms * sr * note.onsetScale, s.label, 'onset');
    const vowelsFrom = t;
    // Consonants inside the note: between syllables, and the final coda.
    const between = [];
    for (let i = 0; i < syl.length - 1; i++) {
      between.push([
        ...consonantSegments(syl[i].co, null, false, amount),
        ...consonantSegments(syl[i + 1].on, this.nucleusStart(syl[i + 1].nuc), true, amount),
      ]);
    }
    const coda = note.noCoda || end === Infinity ? [] : consonantSegments(syl.at(-1).co, null, false, amount);
    const fixedMs = [...between.flat(), ...coda].reduce((s, x) => s + x.ms, 0);
    let squeeze = 1;
    let vowelFrames;
    if (end === Infinity) vowelFrames = syl.map((_, i) => (i < syl.length - 1 ? 250 * sr : Infinity));
    else {
      const avail = Math.max(1, end - vowelsFrom);
      let vowelTotal = avail - fixedMs * sr;
      if (vowelTotal < VOWEL_SHARE * avail) {
        squeeze = fixedMs ? ((1 - VOWEL_SHARE) * avail) / (fixedMs * sr) : 1;
        vowelTotal = VOWEL_SHARE * avail;
      }
      vowelFrames = syl.map(() => vowelTotal / syl.length);
    }
    syl.forEach((s, i) => {
      const len = vowelFrames[i];
      const name = s.nuc.replace(':end', '');
      if (s.nuc.endsWith(':end') || !isDiphthong(s.nuc)) {
        const target = s.nuc.endsWith(':end') ? vowelEnd(name) : this.nucleusStart(s.nuc);
        push({ ...target, tf: 22 }, len, name, 'vowel');
      } else if (len === Infinity) {
        push({ ...vowelTarget(name), tf: 22 }, Infinity, name, 'vowel');
      } else {
        push({ ...vowelTarget(name), tf: 22 }, len * 0.62, name, 'vowel');
        push({ ...vowelEnd(name), tf: 40 }, len * 0.38, name, 'vowel');
      }
      const after = i < syl.length - 1 ? between[i] : coda;
      for (const c of after) push(c.t, c.ms * sr * squeeze, c.label, 'coda');
    });
    note.plan = segs;
    note.planKey = key;
    return segs;
  }

  /** What to sing at frame t: { target, note, seg } (target is silence between notes). */
  targetAt(t) {
    while (this.ci + 1 < this.notes.length && this.notes[this.ci + 1].onsetStart <= t) this.ci++;
    // Drop notes long finished.
    if (this.ci > 4) {
      this.notes.splice(0, this.ci - 2);
      this.ci = 2;
    }
    const note = this.notes[this.ci];
    if (!note || t < note.onsetStart) return { target: SILENCE, note: null };
    const plan = this.planOf(note);
    for (const seg of plan) if (t >= seg.t0 && t < seg.t1) return { target: seg.t, note, seg };
    return { target: SILENCE, note, seg: null, ended: true };
  }

  // ---------------------------------------------------------------- sound out

  render(outL, outR, off, frames, frame = this.frame) {
    this.frame = frame;
    const sr = this.sr;
    const p = this.p;
    const { target, note, seg, ended } = this.targetAt(frame + frames / 2);
    this.seg = seg;

    // ---- smooth the articulation toward the target (per block)
    const cur = this.cur;
    const silent = cur.av < 0.01 && cur.ah < 0.01 && cur.af < 0.01;
    const blockMs = (frames / sr) * 1000;
    const kF = 1 - Math.exp(-blockMs / Math.max(0.5, target.tf));
    let taA = target.ta;
    if (target === SILENCE) taA = ended ? Math.max(4, (p.release * 1000) / 3) : 8;
    else if (cur.av < 0.05 && target.av > cur.av && seg?.kind === 'vowel') taA = Math.max(target.ta, (p.attack * 1000) / 3);
    const kA = 1 - Math.exp(-blockMs / Math.max(0.3, taA));
    for (const key of FORMANT_KEYS) {
      if (target === SILENCE) continue; // keep the last shape while fading out
      cur[key] = silent ? target[key] : cur[key] + (target[key] - cur[key]) * kF;
    }
    for (const key of AMP_KEYS) cur[key] += (target[key] - cur[key]) * kA;

    // ---- pitch
    if (note && note !== this.sungNote) {
      const to = note.pitch + p.pitch + this.bend;
      if (note.legato && this.sungNote) this.pitchTau = Math.max(0.005, p.glide / 3);
      else {
        this.semis = to - p.scoop / 100;
        this.pitchTau = 0.05;
      }
      this.sungNote = note;
      this.vel = note.vel;
    }
    const sung = this.sungNote;
    if (sung) {
      const to = sung.pitch + p.pitch + this.bend;
      this.semis += (to - this.semis) * (1 - Math.exp(-frames / (this.pitchTau * sr)));
    }
    this.vibPhase = (this.vibPhase + (2 * Math.PI * p.vibRate * frames) / sr) % (2 * Math.PI);
    let vib = 0;
    if (sung) {
      const since = (frame - sung.start) / sr - p.vibDelay;
      if (since > 0) vib = p.vibDepth * Math.min(1, since / 0.35) * Math.sin(this.vibPhase);
    }
    // Natural drift: a slow random wander, more of it when rough.
    this.driftV = this.driftV * 0.97 + (this.rand() * 2 - 1) * 0.3;
    this.drift = this.drift * 0.995 + this.driftV * 0.02 * (0.3 + p.rough);
    const f0 = 440 * 2 ** ((this.semis + (vib + this.drift * 6) / 100 - 69) / 12);

    // ---- voice quality
    const vel = this.vel ?? 0.8;
    const rd = Math.min(RD_MAX, Math.max(RD_MIN, 0.55 + 1.9 * p.light + 0.7 * p.breath - 0.45 * (vel - 0.7) - 0.25 * p.tension));
    const fpos = ((rd - RD_MIN) / (RD_MAX - RD_MIN)) * (FRAMES - 1);
    const fa = Math.min(FRAMES - 2, Math.floor(fpos));
    const ff = fpos - fa;
    const gt = this.gt;
    const level = Math.max(0, Math.min(gt.levels - 1, Math.ceil(Math.log2((1024 * f0) / (0.46 * sr)))));
    const rowA = (level * gt.frames + fa) * gt.row;
    const rowB = rowA + gt.row;
    const te = gt.te[fa] + (gt.te[fa + 1] - gt.te[fa]) * ff;
    const size = gt.size;
    const data = gt.data;
    const breath = p.breath;
    const avAmp = cur.av * (1 - 0.65 * breath ** 1.5) * SOURCE_GAIN * (0.35 + 0.65 * vel);
    const breathAsp = breath * 0.5 * cur.av * (0.35 + 0.65 * vel);
    const segAsp = cur.ah * (0.35 + 0.65 * vel);
    const afAmp = cur.af * FRIC_GAIN * (0.5 + 0.5 * vel);
    const voicedFric = cur.av > 0.2;

    // ---- vocal tract filters (per block)
    const k = 2 ** (p.formant / 12);
    const bwMul = 1.25 - 0.5 * p.tension;
    const nyq = sr * 0.45;
    let f1 = cur.f1 * k * (0.85 + 0.3 * p.opening);
    if (cur.av > 0.1) f1 = Math.max(f1, f0 * 1.08); // singers open F1 up to the pitch on high notes
    const F = [f1, cur.f2 * k, cur.f3 * k, 3300 * k, 3850 * k];
    const B = [cur.b1 * bwMul, cur.b2 * bwMul, cur.b3 * bwMul, 250 * bwMul, 300 * bwMul];
    const coef = this.coef;
    for (let i = 0; i < 5; i++) {
      const fr = Math.min(F[i], nyq);
      const r = Math.exp((-Math.PI * B[i]) / sr);
      const c = -r * r;
      const b = 2 * r * Math.cos((2 * Math.PI * fr) / sr);
      coef[i * 3] = 1 - b - c;
      coef[i * 3 + 1] = b;
      coef[i * 3 + 2] = c;
    }
    // Nasal pole (270 Hz) and zero (moves 270 -> 450 Hz as the nose opens).
    const nasal = cur.nas > 0.01;
    const np = reson(270, 100, sr);
    const nz = reson(270 + cur.nas * 180, 100, sr);
    // Frication band-passes (RBJ, 0 dB peak) and the singer's formant (peaking EQ).
    const bp1 = bandpass(Math.min(cur.fc1 * Math.sqrt(k), nyq), cur.bw1, sr);
    const bp2 = bandpass(Math.min(cur.fc2 * Math.sqrt(k), nyq), cur.bw2, sr);
    const ring = peaking(Math.min(2900 * k, nyq), 1.4, 10 * p.tension, sr);
    const g1 = cur.g1;
    const g2 = cur.g2;
    const flat = cur.flat;
    const master = 10 ** (p.gain / 20) * OUT_GAIN;
    const rough = p.rough;
    const s = this.s;

    for (let i = 0; i < frames; i++) {
      // Source: one LF period per cycle, with per-cycle jitter/shimmer.
      this.phase += (f0 * this.jit) / sr;
      if (this.phase >= 1) {
        this.phase -= 1;
        this.jit = 1 + (this.rand() - 0.5) * 0.004 * (0.2 + rough * 4);
        this.shim = 1 + (this.rand() - 0.5) * 0.06 * (0.2 + rough * 4);
        this.odd = !this.odd;
      }
      const x = this.phase * size;
      const xi = x | 0;
      const xf = x - xi;
      const a0 = data[rowA + xi] + (data[rowA + xi + 1] - data[rowA + xi]) * xf;
      const b0 = data[rowB + xi] + (data[rowB + xi + 1] - data[rowB + xi]) * xf;
      let glottal = (a0 + (b0 - a0) * ff) * this.shim;
      if (rough > 0.55 && this.odd) glottal *= 1 - (rough - 0.55) * 1.4; // period doubling: growl
      const noise = this.rand() * 2 - 1;
      const hp = noise - this.lp;
      this.lp += (noise - this.lp) * 0.08;
      const open = this.phase < te ? 1 : 0.3;
      let src = glottal * avAmp + hp * (breathAsp * open + segAsp);

      // Nasal pole/zero pair.
      if (nasal) {
        const y = np.a * src + np.b * s[0] + np.c * s[1];
        s[1] = s[0];
        s[0] = y;
        const z = (y - nz.b * s[2] - nz.c * s[3]) / nz.a;
        s[3] = s[2];
        s[2] = y;
        src = z;
      }
      // Cascade of formant resonators.
      let v = src;
      for (let r = 0, j = 4; r < 5; r++, j += 2) {
        const y = coef[r * 3] * v + coef[r * 3 + 1] * s[j] + coef[r * 3 + 2] * s[j + 1];
        s[j + 1] = s[j];
        s[j] = y;
        v = y;
      }
      // Singer's formant ring.
      const ry = ring.b0 * v + ring.b1 * s[14] + ring.b2 * s[15] - ring.a1 * s[16] - ring.a2 * s[17];
      s[15] = s[14];
      s[14] = v;
      s[17] = s[16];
      s[16] = ry;
      v = ry;
      // Frication branch.
      if (afAmp > 1e-4) {
        const n2 = voicedFric ? noise * open : noise;
        const y1 = bp1.b0 * n2 + bp1.b2 * s[19] - bp1.a1 * s[20] - bp1.a2 * s[21];
        s[19] = s[18];
        s[18] = n2;
        s[21] = s[20];
        s[20] = y1;
        const y2 = bp2.b0 * n2 + bp2.b2 * s[23] - bp2.a1 * s[24] - bp2.a2 * s[25];
        s[23] = s[22];
        s[22] = n2;
        s[25] = s[24];
        s[24] = y2;
        v += (y1 * g1 + y2 * g2 + hp * flat) * afAmp * 4;
      }
      // DC block, gain, gentle limiter.
      let o = v * master;
      const d = o - this.dc[0] + 0.995 * this.dc[1];
      this.dc[0] = o;
      this.dc[1] = d;
      o = d;
      const ab = Math.abs(o);
      if (ab > 0.8) o = Math.sign(o) * (0.8 + 0.2 * Math.tanh((ab - 0.8) / 0.2));
      outL[off + i] += o;
      outR[off + i] += o;
    }
    this.frame = frame + frames;
  }

  status() {
    return {
      ph: this.seg && this.cur.av + this.cur.af + this.cur.ah > 0.05 ? this.seg.label : null,
      note: this.sungNote && this.seg ? this.sungNote.pitch : null,
    };
  }
}

/** Two-pole resonator with unity gain at DC. */
function reson(f, bw, sr) {
  const r = Math.exp((-Math.PI * bw) / sr);
  const c = -r * r;
  const b = 2 * r * Math.cos((2 * Math.PI * f) / sr);
  return { a: 1 - b - c, b, c };
}

function bandpass(fc, bw, sr) {
  const w = (2 * Math.PI * fc) / sr;
  const q = Math.max(0.3, fc / Math.max(1, bw));
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  return { b0: alpha / a0, b2: -alpha / a0, a1: (-2 * Math.cos(w)) / a0, a2: (1 - alpha) / a0 };
}

function peaking(fc, q, db, sr) {
  const A = 10 ** (db / 40);
  const w = (2 * Math.PI * fc) / sr;
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha / A;
  return {
    b0: (1 + alpha * A) / a0,
    b1: (-2 * Math.cos(w)) / a0,
    b2: (1 - alpha * A) / a0,
    a1: (-2 * Math.cos(w)) / a0,
    a2: (1 - alpha / A) / a0,
  };
}
