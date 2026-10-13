// Dexed (WebAssembly build) running on the audio thread.
// Part of the coprod Dexed port: GPL-3.0-or-later, see LICENSE in this folder.

const BLOCK = 64; // the engine renders in blocks of 64 samples

class DexedProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.events = []; // { time, bytes } sorted by time
    this.pending = []; // messages that arrived before the engine was ready
    this.e = null;
    this.port.onmessage = (m) => (this.e ? this.handle(m.data) : this.pending.push(m.data));
    const wasi = { fd_close: () => 0, fd_seek: () => 0, fd_write: () => 0 };
    WebAssembly.instantiate(options.processorOptions.wasm, { wasi_snapshot_preview1: wasi }).then(({ instance }) => {
      const e = instance.exports;
      e._initialize();
      e.dexed_init(sampleRate);
      this.e = e;
      for (const msg of this.pending.splice(0)) this.handle(msg);
      this.port.postMessage({ type: 'ready' });
    });
  }

  handle(msg) {
    const e = this.e;
    switch (msg.type) {
      case 'events':
        for (const ev of msg.events) this.events.push(ev);
        this.events.sort((a, b) => a.time - b.time);
        break;
      case 'clear':
        this.events.length = 0;
        break;
      case 'program':
        new Uint8Array(e.memory.buffer, e.dexed_program(), 156).set(msg.program);
        e.dexed_program_changed();
        break;
      case 'voice': {
        // A packed 128-byte DX7 voice: unpack it and report the result back.
        new Uint8Array(e.memory.buffer, e.dexed_scratch(), 128).set(msg.packed);
        e.dexed_unpack(0);
        e.dexed_program_changed();
        const program = Array.from(new Uint8Array(e.memory.buffer, e.dexed_program(), 156));
        this.port.postMessage({ type: 'program', program, id: msg.id });
        break;
      }
      case 'param':
        new Uint8Array(e.memory.buffer, e.dexed_program(), 156)[msg.offset] = msg.value;
        e.dexed_program_changed();
        break;
      case 'filter':
        e.dexed_set_filter(msg.cutoff, msg.reso, msg.gain);
        break;
      case 'engine':
        e.dexed_set_engine(msg.engine);
        break;
      case 'panic':
        e.dexed_panic();
        break;
    }
  }

  midi([status, a, b]) {
    const e = this.e;
    switch (status & 0xf0) {
      case 0x90:
        if (b > 0) e.dexed_note_on(a, b);
        else e.dexed_note_off(a);
        break;
      case 0x80:
        e.dexed_note_off(a);
        break;
      case 0xb0:
        e.dexed_cc(a, b);
        break;
      case 0xe0:
        e.dexed_pitchbend((b << 7) | a);
        break;
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const e = this.e;
    if (!e || !out.length) return true;
    const frames = out[0].length;
    for (let i = 0; i < frames; i += BLOCK) {
      // Play every event due before the end of this 64-sample block.
      const until = currentTime + (i + BLOCK) / sampleRate;
      while (this.events.length && this.events[0].time < until) this.midi(this.events.shift().bytes);
      e.dexed_render(BLOCK);
      const buf = new Float32Array(e.memory.buffer, e.dexed_output(), BLOCK);
      for (const ch of out) ch.set(buf, i);
    }
    return true;
  }
}

registerProcessor('coprod-dexed', DexedProcessor);
