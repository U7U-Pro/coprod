// Playback: a look-ahead scheduler on the Web Audio clock ("A Tale of Two
// Clocks"), so timing stays tight even when the UI thread is busy.
// Every listener renders the shared project locally; only edits travel over
// the network, never audio.
//
// Signal flow per channel:
//   instrument (built-in synth | sample | WAM plugin)
//     -> bus.gain (volume/mute/solo) -> bus.autoGain (volume automation)
//     -> [WAM effects...] -> bus.pan -> bus.autoPan (pan automation) -> master

import { instruments, setBend } from './instruments.js';
import { STEPS_PER_BAR, INSTRUMENTS, laneValueAt } from './shared/schema.js';
import { PluginHost, isTrusted, sendEvents } from './plugins.js';

const LOOKAHEAD_S = 0.12;
const TICK_MS = 25;
const json = (v) => JSON.stringify(v ?? null);

export class Engine {
  /** Pass `context` to render somewhere other than the speakers (WAV export). */
  constructor({ context = null } = {}) {
    this.ctx = null;
    this.project = null;
    this.buses = new Map(); // channelId -> { gain, pan, chain: [], chainKey }
    this.solo = new Set(); // solo is per-listener, not shared
    this.playing = false;
    this.mode = 'pattern';
    this.patternId = null; // pattern to loop in pattern mode
    this.marks = []; // [{ time, patternId, step, songIndex }] for the playhead
    this.host = new PluginHost();
    this.samples = new Map(); // sample id -> { status, buffer?, error? }
    this.slots = new Map(); // "ch" or "ch/fx" -> plugin slot
    this.onChange = () => {}; // loading/blocked/error status changed
    if (context) this.attach(context);
  }

  attach(ctx) {
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.ratio.value = 4;
    this.master = ctx.createGain();
    this.master.gain.value = 0.8;
    this.master.connect(comp).connect(ctx.destination);
    this.ctx = ctx;
    if (this.project) this.setProject(this.project);
  }

  /** Must be called from a user gesture the first time (browser autoplay rules). */
  async ensure() {
    if (!this.ctx) this.attach(new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' }));
    if (this.ctx.state !== 'running' && this.ctx.resume && !(this.ctx instanceof OfflineAudioContext)) await this.ctx.resume();
  }

  /** Resolves when every sample and plugin has finished loading (or failed). */
  async ready() {
    const pending = [...[...this.samples.values()].map((s) => s.promise), ...[...this.slots.values()].map((s) => s.promise)];
    await Promise.allSettled(pending.filter(Boolean));
  }

  setProject(project) {
    const tempoChanged = this.project && this.project.bpm !== project.bpm;
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
        bus.autoGain.disconnect();
        bus.pan.disconnect();
        bus.autoPan.disconnect();
        bus.bend.stop();
        this.buses.delete(id);
      }
    }
    for (const c of project.channels) {
      this.updateBus(c);
      if (c.sample && INSTRUMENTS[c.inst]?.needs === 'sample') this.loadSample(c.sample.id);
    }
    this.reconcileSlots(project);
    if (tempoChanged) this.sendTransport();
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
      const autoGain = this.ctx.createGain();
      const pan = this.ctx.createStereoPanner();
      const autoPan = this.ctx.createStereoPanner();
      // Pitch bend for built-in sounds: a signal (in cents) every note's
      // oscillators are connected to while they play.
      const bend = this.ctx.createConstantSource();
      bend.offset.value = 0;
      bend.start();
      gain.connect(autoGain);
      autoGain.connect(pan);
      pan.connect(autoPan).connect(this.master);
      b = { gain, autoGain, pan, autoPan, bend, chain: [], chainKey: '' };
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

  // ---------------------------------------------------------------- samples

  loadSample(id) {
    if (this.samples.has(id)) return;
    const entry = { status: 'loading' };
    this.samples.set(id, entry);
    entry.promise = fetch(`/samples/${id}`)
      .then((r) => {
        if (!r.ok) throw new Error(r.status === 404 ? 'sample missing on server' : `HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then((data) => this.ctx.decodeAudioData(data))
      .then((buffer) => Object.assign(entry, { status: 'ready', buffer }))
      .catch((err) => Object.assign(entry, { status: 'error', error: err.message || 'could not decode audio' }))
      .finally(() => this.onChange());
  }

  sampleStatus(id) {
    return this.samples.get(id) ?? { status: this.ctx ? 'loading' : 'idle' };
  }

  playSample(c, out, t, { pitch, vel, dur }) {
    const s = this.samples.get(c.sample?.id);
    if (s?.status !== 'ready') return;
    const src = this.ctx.createBufferSource();
    src.buffer = s.buffer;
    const bend = this.bus(c.id).bend;
    bend.connect(src.detune);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vel, t);
    src.connect(g).connect(out);
    if (c.inst === 'samplekeys') {
      // Pitched like a keyboard: the file plays at its own pitch on C4.
      src.playbackRate.value = 2 ** ((pitch - 60) / 12);
      g.gain.setValueAtTime(vel, t + dur);
      g.gain.linearRampToValueAtTime(0, t + dur + 0.03);
      src.start(t);
      src.stop(t + dur + 0.04);
    } else {
      src.start(t); // one-shot: let it ring out
    }
    src.onended = () => {
      g.disconnect();
      try {
        bend.disconnect(src.detune);
      } catch {}
    };
  }

  // ---------------------------------------------------------------- plugins

  reconcileSlots(project) {
    const want = new Map();
    for (const c of project.channels) {
      if (c.inst === 'wam' && c.plugin) want.set(c.id, { channel: c.id, kind: 'inst', url: c.plugin.url, state: c.pluginState });
      for (const f of c.fx ?? []) want.set(`${c.id}/${f.id}`, { channel: c.id, kind: 'fx', url: f.url, state: f.state, on: f.on });
    }
    for (const [key, slot] of this.slots) {
      const w = want.get(key);
      if (!w || w.url !== slot.url) this.dropSlot(key);
    }
    for (const [key, w] of want) {
      let slot = this.slots.get(key);
      if (!slot) {
        slot = { key, ...w, status: 'loading', docJson: json(w.state), lastJson: null, queue: Promise.resolve() };
        this.slots.set(key, slot);
        slot.promise = this.loadSlot(slot);
        continue;
      }
      slot.on = w.on;
      if (slot.status === 'ready' && json(w.state) !== slot.docJson) this.applyState(slot, w.state);
      else if (slot.status !== 'ready') slot.state = w.state;
    }
    for (const c of project.channels) this.rewire(c);
  }

  async loadSlot(slot) {
    if (!isTrusted(slot.url)) {
      slot.status = 'blocked';
      return this.onChange();
    }
    try {
      const instance = await this.host.create(this.ctx, slot.url, slot.state);
      if (this.slots.get(slot.key) !== slot) return instance.audioNode?.destroy?.(); // removed meanwhile
      slot.instance = instance;
      slot.node = instance.audioNode;
      slot.descriptor = instance.descriptor;
      slot.status = 'ready';
      slot.docJson = json(slot.state);
      slot.lastJson = slot.node.getState ? json(await slot.node.getState()) : null;
      if (slot.kind === 'inst') slot.node.connect(this.bus(slot.channel).gain);
      const c = this.project.channels.find((x) => x.id === slot.channel);
      if (c) this.rewire(c);
      this.sendTransport(slot);
    } catch (err) {
      slot.status = err.message === 'blocked' ? 'blocked' : 'error';
      slot.error = err.message || String(err);
      console.warn(`plugin ${slot.url} failed:`, err);
    }
    this.onChange();
  }

  /** Re-try plugins after the user allowed a new origin. */
  retryBlocked() {
    for (const slot of this.slots.values()) if (slot.status === 'blocked') {
      slot.status = 'loading';
      slot.promise = this.loadSlot(slot);
    }
    this.onChange();
  }

  dropSlot(key) {
    const slot = this.slots.get(key);
    this.slots.delete(key);
    if (!slot?.node) return;
    try {
      slot.node.disconnect();
      slot.node.destroy?.();
    } catch {}
    const bus = this.buses.get(slot.channel);
    if (bus) bus.chainKey = null; // force a rewire
  }

  /** Someone else changed the plugin's settings: load them into ours. */
  applyState(slot, state) {
    slot.docJson = json(state);
    slot.queue = slot.queue.then(async () => {
      if (!slot.node?.setState || state == null) return;
      await slot.node.setState(state);
      slot.lastJson = json(await slot.node.getState());
    });
  }

  /** Our plugin GUI may have changed: return the new state to share, or null. */
  async captureState(key) {
    const slot = this.slots.get(key);
    if (slot?.status !== 'ready' || !slot.node.getState) return null;
    await slot.queue;
    const state = await slot.node.getState();
    const j = json(state);
    if (j === slot.lastJson) return null;
    slot.lastJson = j;
    slot.docJson = j; // the doc will echo this back; don't re-apply it
    return state;
  }

  rewire(c) {
    const bus = this.bus(c.id);
    const chain = (c.fx ?? [])
      .map((f) => ({ f, slot: this.slots.get(`${c.id}/${f.id}`) }))
      .filter(({ f, slot }) => f.on && slot?.status === 'ready');
    const key = chain.map(({ f }) => f.id).join(',');
    if (key === bus.chainKey) return;
    bus.autoGain.disconnect();
    for (const node of bus.chain) {
      try {
        node.disconnect();
      } catch {}
    }
    let prev = bus.autoGain;
    for (const { slot } of chain) {
      prev.connect(slot.node);
      prev = slot.node;
    }
    prev.connect(bus.pan);
    bus.chain = chain.map(({ slot }) => slot.node);
    bus.chainKey = key;
  }

  slotStatus(key) {
    const s = this.slots.get(key);
    return s ? { status: s.status, error: s.error, url: s.url } : { status: this.ctx ? 'loading' : 'idle' };
  }

  sendTransport(only) {
    if (!this.ctx || !this.project) return;
    const event = {
      type: 'wam-transport',
      time: this.ctx.currentTime,
      data: {
        currentBar: 0,
        currentBarStarted: this.ctx.currentTime,
        tempo: this.project.bpm,
        timeSigNumerator: 4,
        timeSigDenominator: 4,
        playing: this.playing,
      },
    };
    for (const slot of only ? [only] : this.slots.values()) if (slot.status === 'ready') sendEvents(slot.node, event);
  }

  // ---------------------------------------------------------------- voices

  /** Make channel `c` sound at time `t`. */
  voice(c, t, opts) {
    const bus = this.bus(c.id);
    const out = bus.gain;
    if (instruments[c.inst]) {
      setBend(bus.bend);
      try {
        return instruments[c.inst](this.ctx, out, t, opts);
      } finally {
        setBend(null);
      }
    }
    if (c.inst === 'sample' || c.inst === 'samplekeys') return this.playSample(c, out, t, opts);
    if (c.inst === 'wam') {
      const slot = this.slots.get(c.id);
      if (slot?.status !== 'ready') return;
      const vel = Math.max(1, Math.min(127, Math.round(opts.vel * 127)));
      sendEvents(
        slot.node,
        { type: 'wam-midi', time: t, data: { bytes: [0x90, opts.pitch, vel] } },
        { type: 'wam-midi', time: t + opts.dur, data: { bytes: [0x80, opts.pitch, 0] } },
      );
    }
  }

  /** Play one note right now (clicking a key or placing a note). */
  preview(channel, pitch = INSTRUMENTS[channel.inst]?.root ?? 60, dur = 0.3) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    this.voice(channel, this.ctx.currentTime + 0.005, { pitch, vel: 0.8, dur });
  }

  // ---------------------------------------------------------------- transport

  async play({ mode = this.mode, patternId = this.patternId } = {}) {
    await this.ensure();
    this.mode = mode;
    this.patternId = patternId;
    this.cursor = { songIndex: 0, step: 0 };
    this.laneLast = new Map();
    this.nextTime = this.ctx.currentTime + 0.05;
    this.marks = [];
    this.playing = true;
    this.sendTransport();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  stop() {
    this.playing = false;
    clearInterval(this.timer);
    this.marks = [];
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    // Automation only applies while playing: back to the mixer settings.
    for (const bus of this.buses.values()) {
      bus.autoGain.gain.cancelScheduledValues(now);
      bus.autoGain.gain.setTargetAtTime(1, now, 0.02);
      bus.autoPan.pan.cancelScheduledValues(now);
      bus.autoPan.pan.setTargetAtTime(0, now, 0.02);
      bus.bend.offset.cancelScheduledValues(now);
      bus.bend.offset.setTargetAtTime(0, now, 0.02);
    }
    this.laneLast = new Map();
    for (const slot of this.slots.values()) {
      if (slot.status !== 'ready' || slot.kind !== 'inst') continue;
      slot.node.clearEvents?.();
      sendEvents(slot.node, { type: 'wam-midi', time: now, data: { bytes: [0xb0, 123, 0] } }); // all notes off
      sendEvents(slot.node, { type: 'wam-midi', time: now, data: { bytes: [0xe0, 0, 64] } }); // bend back to center
    }
    this.sendTransport();
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
      if (INSTRUMENTS[c.inst]?.kind !== 'drum') continue;
      const vel = pattern.steps.get(`${c.id}:${step}`);
      if (vel) this.voice(c, time, { pitch: 60, vel: vel / 127, dur: stepDur });
    }
    for (const n of pattern.byStep?.get(step) ?? []) {
      const c = this.project.channels.find((x) => x.id === n.ch);
      if (c) this.voice(c, time, { pitch: n.p, vel: n.v / 127, dur: n.l * stepDur });
    }
    this.scheduleAutomation(pattern, step, time, stepDur);
  }

  /** Play automation lanes: 4 points per step, only when the value changes. */
  scheduleAutomation(pattern, step, time, stepDur) {
    this.laneLast ??= new Map();
    for (const lane of pattern.lanes ?? []) {
      if (!lane.points.length) continue;
      const bus = this.buses.get(lane.ch);
      if (!bus) continue;
      for (let k = 0; k < 4; k++) {
        const v = laneValueAt(lane.points, step + k / 4);
        const t = time + (k * stepDur) / 4;
        const key = lane.id;
        const first = !this.laneLast.has(key);
        if (this.laneLast.get(key) === v) continue;
        this.laneLast.set(key, v);
        // The first value jumps into place; after that, ramp between points.
        const set = (param, value) => (first ? param.setValueAtTime(value, t) : param.linearRampToValueAtTime(value, t));
        if (lane.target === 'vol') set(bus.autoGain.gain, v * v);
        else if (lane.target === 'pan') set(bus.autoPan.pan, v * 2 - 1);
        else if (lane.target === 'bend') {
          const c = this.project.channels.find((x) => x.id === lane.ch);
          if (c?.inst === 'wam') {
            // Plugins get MIDI pitch bend; their own setting decides the range.
            const slot = this.slots.get(c.id);
            const v14 = Math.round(v * 16383);
            if (slot?.status === 'ready') sendEvents(slot.node, { type: 'wam-midi', time: t, data: { bytes: [0xe0, v14 & 0x7f, v14 >> 7] } });
          } else set(bus.bend.offset, (v * 2 - 1) * (lane.range ?? 2) * 100);
        }
        else {
          const [kind, a, b] = lane.target.split(':');
          const slot = this.slots.get(kind === 'p' ? lane.ch : `${lane.ch}/${a}`);
          if (slot?.status !== 'ready') continue;
          sendEvents(slot.node, { type: 'wam-automation', time: t, data: { id: kind === 'p' ? a : b, value: v, normalized: true } });
        }
      }
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
