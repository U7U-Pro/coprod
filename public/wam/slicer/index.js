// Slicer: a Slicex-style beat slicer for coprod, packaged as a Web Audio
// Module. Drop in a loop; it's cut at the hits (or on a grid), slice 1 plays
// on C4, slice 2 on C#4 and so on. Slices can be moved, added, removed,
// reversed and individually pitched/panned, and "To piano roll" writes the
// notes that play the loop back in order.

import { SampleNode, sampleModule, descriptor } from '../kit/node.js';
import { detectOnsets, gridSlices, demoBreak } from '../kit/dsp.js';
import { TABLE, ROOT, MAX_SLICES, SYNC_BEATS } from './params.js';

const round = (v, d = 1e5) => Math.round(v * d) / d;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** A slice from state: { t (start, seconds), g (dB), pan, pt (semitones), rev }. */
function cleanSlice(s) {
  return {
    t: Math.max(0, +s?.t || 0),
    g: clamp(+s?.g || 0, -36, 12),
    pan: clamp(+s?.pan || 0, -1, 1),
    pt: clamp(Math.round(+s?.pt || 0), -24, 24),
    rev: !!s?.rev,
  };
}

class SlicerNode extends SampleNode {
  constructor(module) {
    super(module, 'coprod-slicer', TABLE, demoBreak);
    this.marks = [cleanSlice({ t: 0 })];
  }

  // ---- slices

  /** Slices with their end times, as played. */
  slices() {
    const dur = this.audio?.duration ?? 0;
    return this.marks.map((m, i) => ({ ...m, end: i + 1 < this.marks.length ? this.marks[i + 1].t : dur }));
  }

  setMarks(marks) {
    const dur = this.audio?.duration ?? Infinity;
    const list = marks
      .map(cleanSlice)
      .filter((m) => m.t < dur - 0.005)
      .sort((a, b) => a.t - b.t)
      .filter((m, i, a) => i === 0 || m.t - a[i - 1].t > 0.004);
    if (!list.length || list[0].t > 0) list.unshift(cleanSlice({ t: 0 }));
    list[0].t = 0;
    this.marks = list.slice(0, MAX_SLICES);
    this.port.postMessage({
      type: 'slices',
      slices: this.slices().map((s) => ({ start: s.t, end: s.end, gain: s.g, pan: s.pan, pitch: s.pt, rev: s.rev })),
    });
    this.emit('slices');
  }

  /** Re-cut the whole sound: by its hits, or into n equal parts. */
  autoSlice(how, amount) {
    const a = this.audio;
    if (!a) return;
    const times = how === 'grid' ? gridSlices(a.duration, amount) : detectOnsets(a.L, a.R, a.sr, amount, MAX_SLICES);
    this.setMarks(times.map((t) => ({ t })));
  }

  addMark(t) {
    if (this.marks.length >= MAX_SLICES) return false;
    // The new slice inherits the settings of the one it splits.
    const host = [...this.marks].reverse().find((m) => m.t <= t) ?? this.marks[0];
    this.setMarks([...this.marks, { ...host, t }]);
    return true;
  }

  moveMark(i, t) {
    if (i <= 0 || i >= this.marks.length) return;
    const lo = this.marks[i - 1].t + 0.005;
    const hi = (this.marks[i + 1]?.t ?? this.audio?.duration ?? t) - 0.005;
    this.setMarks(this.marks.map((m, j) => (j === i ? { ...m, t: clamp(t, lo, hi) } : m)));
  }

  removeMark(i) {
    if (i <= 0) return;
    this.setMarks(this.marks.filter((_, j) => j !== i));
  }

  setSlice(i, patch) {
    this.setMarks(this.marks.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  }

  /** Guess how long the loop is in beats at the song's tempo; pick that sync setting (or Off). */
  guessSync() {
    const beats = ((this.audio?.duration ?? 0) * this.tempo) / 60;
    let best = 0;
    for (let i = 1; i < SYNC_BEATS.length; i++) if (Math.abs(beats / SYNC_BEATS[i] - 1) < 0.06) best = i;
    this.set('sync', TABLE.PARAMS[TABLE.INDEX.sync].unmap(best));
  }

  /** After the user loads a new sound: cut it at its hits and fit it to the tempo. */
  freshSound() {
    if (this.sample) {
      this.autoSlice('transients', 0.5);
      this.guessSync();
    } else this.demoSlices();
  }

  demoSlices() {
    this.setMarks(this.audio.hits.map((t) => ({ t })));
    this.set('sync', TABLE.PARAMS[TABLE.INDEX.sync].unmap(SYNC_BEATS.indexOf(this.audio.beats)));
  }

  /**
   * Piano-roll notes that play the slices back in order, at the song's tempo:
   * [{ p, s (16th-note step), l }].
   */
  toNotes() {
    const a = this.audio;
    if (!a) return [];
    const beats = SYNC_BEATS[this.real('sync')] || (a.duration * this.tempo) / 60 / 2 ** (this.real('pitch') / 12);
    const stepOf = (t) => Math.round((t / a.duration) * beats * 4);
    const total = Math.round(beats * 4);
    return this.slices()
      .map((s, i) => ({ p: ROOT + i, s: stepOf(s.t), l: stepOf(s.end) - stepOf(s.t) }))
      .filter((n) => n.l > 0 && n.s < total);
  }

  // ---- state

  async getState() {
    return {
      v: 1,
      sample: this.sample,
      slices: this.marks.map((m) => {
        const out = { t: round(m.t) };
        if (m.g) out.g = round(m.g, 100);
        if (m.pan) out.pan = round(m.pan, 1000);
        if (m.pt) out.pt = m.pt;
        if (m.rev) out.rev = true;
        return out;
      }),
      params: this.paramState(),
    };
  }

  async setState(s) {
    if (!s || typeof s !== 'object') return;
    const fresh = !s.v; // a brand-new instance: start on the demo, fitted to tempo
    this.applyParamState(s.params);
    const changed = await this.setSample(s.sample ?? null);
    if (Array.isArray(s.slices) && s.slices.length) {
      const next = s.slices.slice(0, MAX_SLICES).map(cleanSlice);
      if (changed || JSON.stringify(next) !== JSON.stringify(this.marks)) this.setMarks(next);
    } else if (changed || fresh) {
      if (this.sample) this.autoSlice('transients', 0.5);
      else this.demoSlices();
    }
    this.emit('all');
  }
}

const DESCRIPTOR = descriptor({
  identifier: 'com.coprod.slicer',
  name: 'Slicer',
  description: 'Beat slicer: cuts a loop at its hits and plays slices from MIDI notes.',
  keywords: ['sampler', 'slicer', 'loop', 'break'],
});

export default sampleModule(DESCRIPTOR, new URL('processor.js', import.meta.url).href, SlicerNode, () => import('./gui.js'));
