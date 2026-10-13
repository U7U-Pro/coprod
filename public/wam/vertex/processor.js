// Vertex on the audio thread: wraps the engine, applies scheduled MIDI,
// automation and transport events at 32-sample resolution.

import { VertexEngine, BLOCK } from './engine.js';

class VertexProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.engine = new VertexEngine(sampleRate);
    this.events = []; // sorted by time
    this.statusAt = 0;
    this.port.onmessage = ({ data }) => this.handle(data);
  }

  handle(m) {
    const e = this.engine;
    switch (m.type) {
      case 'params':
        e.setParams(m.values);
        break;
      case 'param':
        e.setParam(m.i, m.v);
        e.setAutomation(m.i, null); // touching a knob takes it back from automation
        break;
      case 'routes':
        e.setRoutes(m.routes);
        break;
      case 'lfo':
        e.setLfoShape(m.n, m.points);
        break;
      case 'table':
        e.setTable(m.osc, { data: m.data, frames: m.frames, levels: m.levels, row: m.row });
        break;
      case 'fxorder':
        e.setFxOrder(m.order);
        break;
      case 'events':
        for (const ev of m.events) this.events.push(ev);
        this.events.sort((a, b) => a.time - b.time);
        break;
      case 'clear':
        this.events.length = 0;
        break;
      case 'panic':
        this.events.length = 0;
        e.allOff();
        break;
    }
  }

  apply(ev) {
    const e = this.engine;
    if (ev.kind === 'midi') {
      const [status, a, b] = ev.bytes;
      const cmd = status & 0xf0;
      if (cmd === 0x90) e.noteOn(a, b);
      else if (cmd === 0x80) e.noteOff(a);
      else if (cmd === 0xb0) e.cc(a, b);
      else if (cmd === 0xe0) e.pitchBend((b << 7) | a);
    } else if (ev.kind === 'auto') {
      e.setAutomation(ev.i, ev.v);
    } else if (ev.kind === 'transport') {
      if (ev.tempo) e.setTempo(ev.tempo);
      if (ev.playing === false) e.clearAutomation();
    }
  }

  process(_in, outputs) {
    const out = outputs[0];
    if (!out?.length) return true;
    const L = out[0];
    const R = out[1] ?? out[0];
    const frames = L.length;
    for (let off = 0; off < frames; off += BLOCK) {
      const until = currentTime + (off + BLOCK) / sampleRate;
      while (this.events.length && this.events[0].time < until) this.apply(this.events.shift());
      this.engine.render(L, R, off, Math.min(BLOCK, frames - off));
    }
    // ~20 times a second, tell the GUI what's happening (voices, LFOs).
    if (currentTime >= this.statusAt) {
      this.statusAt = currentTime + 0.05;
      const e = this.engine;
      const v = e.voices.find((x) => x.active);
      this.port.postMessage({
        type: 'status',
        voices: e.activeVoices(),
        lfo: e.glfo.map((l) => l.phase),
        vlfo: v ? v.lfos.map((l) => l.phase) : null,
      });
    }
    return true;
  }
}

registerProcessor('coprod-vertex', VertexProcessor);
