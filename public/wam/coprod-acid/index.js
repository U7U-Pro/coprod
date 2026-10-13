// "Acid": a small squelchy mono-ish synth packaged as a Web Audio Module
// (WAM 2.0). It's self-contained on purpose: it implements the WAM
// interface directly, exactly the surface a host like coprod relies on:
//   static createInstance(groupId, audioContext, state) -> module
//   module.audioNode  (connectable; scheduleEvents/getState/setState)
//   module.createGui() -> HTMLElement

const DESCRIPTOR = {
  identifier: 'com.coprod.acid',
  name: 'Acid',
  vendor: 'coprod',
  version: '1.0.0',
  apiVersion: '2.0.0',
  description: 'Saw/square synth with a resonant, envelope-swept filter.',
  keywords: ['synth', 'bass', 'acid'],
  isInstrument: true,
  website: '',
  thumbnail: '',
  hasAudioInput: false,
  hasAudioOutput: true,
  hasMidiInput: true,
  hasMidiOutput: false,
  hasAutomationInput: false,
  hasAutomationOutput: false,
  hasMpeInput: false,
  hasMpeOutput: false,
  hasOscInput: false,
  hasOscOutput: false,
  hasSysexInput: false,
  hasSysexOutput: false,
};

const PARAMS = {
  wave: { label: 'Wave', min: 0, max: 1, step: 1, default: 0, format: (v) => (v ? 'Square' : 'Saw') },
  cutoff: { label: 'Cutoff', min: 0, max: 1, step: 0.01, default: 0.35, format: (v) => `${Math.round(cutoffHz(v))} Hz` },
  res: { label: 'Reso', min: 0, max: 1, step: 0.01, default: 0.6, format: (v) => `${Math.round(v * 100)}%` },
  env: { label: 'Env mod', min: 0, max: 1, step: 0.01, default: 0.6, format: (v) => `${Math.round(v * 100)}%` },
  decay: { label: 'Decay', min: 0, max: 1, step: 0.01, default: 0.3, format: (v) => `${Math.round(decayS(v) * 1000)} ms` },
  vol: { label: 'Volume', min: 0, max: 1, step: 0.01, default: 0.7, format: (v) => `${Math.round(v * 100)}%` },
};

const cutoffHz = (v) => 60 * 2 ** (v * 7.5); // 60 Hz .. ~10 kHz
const decayS = (v) => 0.04 + v * v * 1.2;
const hz = (n) => 440 * 2 ** ((n - 69) / 12);

class AcidNode extends GainNode {
  constructor(module) {
    super(module.audioContext, { gain: 1 });
    this.module = module;
    this.params = Object.fromEntries(Object.entries(PARAMS).map(([k, p]) => [k, p.default]));
    this.voices = new Map(); // note -> [voice]
    this.listeners = new Set();
    this.auto = {}; // host automation overrides while the song plays
    this.bend = 0; // cents, from MIDI pitch bend (±2 semitones)
  }

  get groupId() {
    return this.module.groupId;
  }
  get moduleId() {
    return this.module.moduleId;
  }
  get instanceId() {
    return this.module.instanceId;
  }

  scheduleEvents(...events) {
    for (const e of events) {
      if (e.type === 'wam-automation') {
        const p = PARAMS[e.data.id];
        if (p) this.auto[e.data.id] = e.data.normalized ? p.min + e.data.value * (p.max - p.min) : e.data.value;
        continue;
      }
      if (e.type === 'wam-transport' && e.data?.playing === false) this.auto = {};
      if (e.type !== 'wam-midi') continue;
      const [status, note, vel] = e.data.bytes;
      const time = Math.max(e.time ?? 0, this.context.currentTime);
      const cmd = status & 0xf0;
      if (cmd === 0x90 && vel > 0) this.noteOn(note, vel / 127, time);
      else if (cmd === 0x80 || (cmd === 0x90 && vel === 0)) this.noteOff(note, time);
      else if (cmd === 0xb0 && (note === 123 || note === 120)) this.allOff(time);
      else if (cmd === 0xe0) this.pitchBend((((vel << 7) | note) - 8192) / 8192 * 200, time);
    }
  }

  noteOn(note, vel, t) {
    const ctx = this.context;
    const p = { ...this.params, ...this.auto };
    const osc = ctx.createOscillator();
    osc.type = p.wave >= 0.5 ? 'square' : 'sawtooth';
    osc.frequency.value = hz(note);
    osc.detune.value = this.bend;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 0.7 + p.res * 22;
    const base = cutoffHz(p.cutoff);
    const peak = Math.min(18000, base * (1 + p.env * 14));
    filter.frequency.setValueAtTime(peak, t);
    filter.frequency.setTargetAtTime(base, t, decayS(p.decay) / 3);
    const vca = ctx.createGain();
    vca.gain.setValueAtTime(0, t);
    vca.gain.linearRampToValueAtTime(0.32 * vel * p.vol, t + 0.004);
    osc.connect(filter).connect(vca).connect(this);
    osc.start(t);
    const voice = { osc, vca };
    if (!this.voices.has(note)) this.voices.set(note, []);
    this.voices.get(note).push(voice);
    osc.onended = () => {
      vca.disconnect();
      const list = this.voices.get(note);
      const i = list ? list.indexOf(voice) : -1;
      if (i >= 0) list.splice(i, 1);
    };
  }

  pitchBend(cents, t) {
    this.bend = cents;
    for (const list of this.voices.values()) for (const v of list) v.osc.detune.setTargetAtTime(cents, t, 0.005);
  }

  noteOff(note, t) {
    const voice = this.voices.get(note)?.find((v) => !v.released);
    if (!voice) return;
    voice.released = true;
    voice.vca.gain.setTargetAtTime(0, t, 0.015);
    voice.osc.stop(t + 0.12);
  }

  allOff(t) {
    for (const list of this.voices.values()) for (const v of list) {
      if (v.released) continue;
      v.released = true;
      v.vca.gain.cancelScheduledValues(t);
      v.vca.gain.setTargetAtTime(0, t, 0.01);
      v.osc.stop(t + 0.08);
    }
  }

  clearEvents() {
    this.allOff(this.context.currentTime);
  }

  async getState() {
    return { ...this.params };
  }

  async setState(state) {
    for (const k of Object.keys(PARAMS)) if (typeof state?.[k] === 'number') this.params[k] = state[k];
    for (const fn of this.listeners) fn();
  }

  async getParameterInfo() {
    return Object.fromEntries(
      Object.entries(PARAMS).map(([id, p]) => [id, { id, label: p.label, type: 'float', minValue: p.min, maxValue: p.max, defaultValue: p.default }]),
    );
  }

  async getParameterValues() {
    return Object.fromEntries(Object.entries(this.params).map(([id, value]) => [id, { id, value, normalized: false }]));
  }

  async setParameterValues(values) {
    for (const [id, v] of Object.entries(values)) if (id in PARAMS) this.params[id] = v.value;
    for (const fn of this.listeners) fn();
  }

  destroy() {
    this.allOff(this.context.currentTime);
    this.disconnect();
  }
}

export default class AcidModule {
  static isWebAudioModuleConstructor = true;

  static async createInstance(groupId, audioContext, initialState) {
    return new AcidModule(groupId, audioContext).initialize(initialState);
  }

  constructor(groupId, audioContext) {
    this.groupId = groupId;
    this.audioContext = audioContext;
    this.instanceId = `${DESCRIPTOR.identifier}-${Math.random().toString(36).slice(2)}`;
    this.initialized = false;
  }

  get isWebAudioModule() {
    return true;
  }
  get descriptor() {
    return DESCRIPTOR;
  }
  get moduleId() {
    return DESCRIPTOR.identifier;
  }
  get name() {
    return DESCRIPTOR.name;
  }
  get vendor() {
    return DESCRIPTOR.vendor;
  }

  async initialize(state) {
    this.audioNode = new AcidNode(this);
    if (state) await this.audioNode.setState(state);
    this.initialized = true;
    return this;
  }

  async createGui() {
    return knobPanel(this.audioNode, PARAMS, 'Acid', '#b8f35d');
  }

  destroyGui(el) {
    el.remove();
  }
}

/** Plain-DOM GUI: a row of labeled sliders. Shared look with the Echo plugin. */
function knobPanel(node, params, title, accent) {
  const root = document.createElement('div');
  root.className = 'wam-coprod';
  root.innerHTML = `<style>
    .wam-coprod{font:12px/1.3 system-ui,sans-serif;color:#e9ecf3;background:#101216;border:1px solid #2c313c;border-radius:10px;padding:10px 12px;display:flex;gap:14px;align-items:flex-end;flex-wrap:wrap}
    .wam-coprod h4{margin:0 8px 0 0;font-size:13px;letter-spacing:.04em;color:${accent};align-self:center}
    .wam-coprod label{display:flex;flex-direction:column;gap:4px;min-width:74px}
    .wam-coprod input{accent-color:${accent};width:90px}
    .wam-coprod output{color:#8b92a5;font-variant-numeric:tabular-nums}
  </style><h4>${title}</h4>`;
  const inputs = {};
  for (const [id, p] of Object.entries(params)) {
    const label = document.createElement('label');
    label.innerHTML = `<span>${p.label}</span>`;
    const input = document.createElement('input');
    Object.assign(input, { type: 'range', min: p.min, max: p.max, step: p.step });
    input.dataset.param = id;
    const out = document.createElement('output');
    input.addEventListener('input', () => {
      node.params[id] = +input.value;
      out.textContent = p.format(+input.value);
    });
    label.append(input, out);
    root.append(label);
    inputs[id] = { input, out, p };
  }
  const sync = () => {
    for (const [id, { input, out, p }] of Object.entries(inputs)) {
      input.value = node.params[id];
      out.textContent = p.format(node.params[id]);
    }
  };
  node.listeners.add(sync);
  sync();
  return root;
}
