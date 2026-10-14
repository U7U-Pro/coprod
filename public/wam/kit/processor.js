// The audio-thread side of coprod's worklet plugins: applies scheduled MIDI,
// automation and transport events at 32-sample resolution, then lets the
// engine render. Engine-specific messages (sample data, slices) go to
// engine.handle().
//
// An engine that needs to see notes ahead of time (Vocalist starts consonants
// before the beat) defines enqueue(event): it then gets note on/off and lyric
// events as soon as they arrive, with their times, and schedules them itself.

const BLOCK = 32;
const isNote = (ev) => ev.kind === 'lyric' || (ev.kind === 'midi' && (ev.bytes[0] & 0xe0) === 0x80);

export function registerEngine(name, Engine) {
  class Processor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.engine = new Engine(sampleRate);
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
        case 'events':
          for (const ev of m.events) {
            if (e.enqueue && isNote(ev)) e.enqueue(ev);
            else this.events.push(ev);
          }
          this.events.sort((a, b) => a.time - b.time);
          break;
        case 'clear':
          this.events.length = 0;
          e.clear?.();
          break;
        case 'panic':
          this.events.length = 0;
          e.clear?.();
          e.allOff();
          break;
        default:
          e.handle?.(m);
      }
    }

    apply(ev) {
      const e = this.engine;
      if (ev.kind === 'midi') {
        const [status, a, b] = ev.bytes;
        const cmd = status & 0xf0;
        if (cmd === 0x90 && b > 0) e.noteOn(a, b);
        else if (cmd === 0x80 || cmd === 0x90) e.noteOff(a);
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
        this.engine.render(L, R, off, Math.min(BLOCK, frames - off), currentFrame + off);
      }
      // ~30 times a second, tell the GUI what's playing.
      if (currentTime >= this.statusAt) {
        this.statusAt = currentTime + 1 / 30;
        const status = this.engine.status?.();
        if (status) this.port.postMessage({ type: 'status', ...status });
      }
      return true;
    }
  }
  registerProcessor(name, Processor);
}
