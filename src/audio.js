// Playback: a look-ahead scheduler on the Web Audio clock ("A Tale of Two
// Clocks"), so timing stays tight even when the UI thread is busy.
// Every listener renders the shared project locally; only edits travel over
// the network, never audio.

import { instruments } from './instruments.js';
import { STEPS_PER_BAR, INSTRUMENTS } from './shared/schema.js';

const LOOKAHEAD_S = 0.12;
const TICK_MS = 25;

export class Engine {
  constructor() {
    this.ctx = null;
    this.project = null;
    this.buses = new Map(); // channelId -> { gain, pan }
    this.solo = new Set(); // solo is per-listener, not shared
    this.playing = false;
    this.mode = 'pattern';
    this.patternId = null; // pattern to loop in pattern mode
    this.marks = []; // [{ time, patternId, step, songIndex }] for the playhead
  }

  /** Must be called from a user gesture the first time (browser autoplay rules). */
  async ensure() {
    if (!this.ctx) {
      const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -12;
      comp.ratio.value = 4;
      this.master = ctx.createGain();
      this.master.gain.value = 0.8;
      this.master.connect(comp).connect(ctx.destination);
      this.ctx = ctx;
      if (this.project) this.setProject(this.project);
    }
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  setProject(project) {
    this.project = project;
    for (const p of project.patterns) {
      p.byStep = new Map();
      for (const n of p.notes) {
        if (!p.byStep.has(n.s)) p.byStep.set(n.s, []);
        p.byStep.get(n.s).push(n);
      }
    }
    if (!this.ctx) return;
    const ids = new Set(project.channels.map((c) => c.id));
    for (const [id, bus] of this.buses) {
      if (!ids.has(id)) {
        bus.gain.disconnect();
        this.buses.delete(id);
      }
    }
    for (const c of project.channels) this.updateBus(c);
  }

  setSolo(channelId, on) {
    if (on) this.solo.add(channelId);
    else this.solo.delete(channelId);
    if (this.project) for (const c of this.project.channels) this.updateBus(c);
  }

  bus(channelId) {
    let b = this.buses.get(channelId);
    if (!b) {
      const gain = this.ctx.createGain();
      const pan = this.ctx.createStereoPanner();
      gain.connect(pan).connect(this.master);
      b = { gain, pan };
      this.buses.set(channelId, b);
    }
    return b;
  }

  updateBus(c) {
    const b = this.bus(c.id);
    const audible = !c.mute && (this.solo.size === 0 || this.solo.has(c.id));
    const now = this.ctx.currentTime;
    b.gain.gain.setTargetAtTime(audible ? c.vol * c.vol : 0, now, 0.01);
    b.pan.pan.setTargetAtTime(c.pan, now, 0.01);
  }

  /** Play one note right now (clicking a key or placing a note). */
  preview(channel, pitch = INSTRUMENTS[channel.inst]?.root ?? 60, dur = 0.3) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    instruments[channel.inst]?.(this.ctx, this.bus(channel.id).gain, this.ctx.currentTime + 0.005, {
      pitch,
      vel: 0.8,
      dur,
    });
  }

  // ---------------------------------------------------------------- transport

  async play({ mode = this.mode, patternId = this.patternId } = {}) {
    await this.ensure();
    this.mode = mode;
    this.patternId = patternId;
    this.cursor = { songIndex: 0, step: 0 };
    this.nextTime = this.ctx.currentTime + 0.05;
    this.marks = [];
    this.playing = true;
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  stop() {
    this.playing = false;
    clearInterval(this.timer);
    this.marks = [];
  }

  currentPattern() {
    const p = this.project;
    if (this.mode === 'song' && p.song.length) {
      const id = p.song[this.cursor.songIndex % p.song.length];
      return p.patterns.find((x) => x.id === id) ?? p.patterns[0];
    }
    return p.patterns.find((x) => x.id === this.patternId) ?? p.patterns[0];
  }

  tick() {
    if (!this.playing || !this.project) return;
    while (this.nextTime < this.ctx.currentTime + LOOKAHEAD_S) {
      const pattern = this.currentPattern();
      const length = pattern.bars * STEPS_PER_BAR;
      if (this.cursor.step >= length) this.cursor.step = 0; // pattern got shorter
      const stepDur = 60 / this.project.bpm / 4;
      this.scheduleStep(pattern, this.cursor.step, this.nextTime, stepDur);
      this.marks.push({ time: this.nextTime, patternId: pattern.id, step: this.cursor.step, songIndex: this.cursor.songIndex });
      if (this.marks.length > 64) this.marks.splice(0, this.marks.length - 64);

      this.nextTime += stepDur;
      this.cursor.step++;
      if (this.cursor.step >= length) {
        this.cursor.step = 0;
        if (this.mode === 'song' && this.project.song.length) {
          this.cursor.songIndex = (this.cursor.songIndex + 1) % this.project.song.length;
        }
      }
    }
  }

  scheduleStep(pattern, step, time, stepDur) {
    for (const c of this.project.channels) {
      const play = instruments[c.inst];
      if (!play) continue;
      const out = this.bus(c.id).gain;
      if (INSTRUMENTS[c.inst].kind === 'drum') {
        const vel = pattern.steps.get(`${c.id}:${step}`);
        if (vel) play(this.ctx, out, time, { pitch: 60, vel: vel / 127, dur: stepDur });
      }
    }
    for (const n of pattern.byStep?.get(step) ?? []) {
      const c = this.project.channels.find((x) => x.id === n.ch);
      if (!c) continue;
      instruments[c.inst]?.(this.ctx, this.bus(c.id).gain, time, { pitch: n.p, vel: n.v / 127, dur: n.l * stepDur });
    }
  }

  /** Where the playhead is right now, as heard (not as scheduled). */
  position() {
    if (!this.playing || !this.ctx) return null;
    const now = this.ctx.currentTime;
    let cur = null;
    for (const m of this.marks) {
      if (m.time <= now) cur = m;
      else break;
    }
    return cur;
  }
}
