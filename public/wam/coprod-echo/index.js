// "Echo": a tempo-synced feedback delay packaged as a Web Audio Module
// (WAM 2.0) audio effect. Self-contained, like the Acid example.

const DESCRIPTOR = {
  identifier: 'com.coprod.echo',
  name: 'Echo',
  vendor: 'coprod',
  version: '1.0.0',
  apiVersion: '2.0.0',
  description: 'Feedback delay that follows the project tempo.',
  keywords: ['delay', 'echo', 'effect'],
  isInstrument: false,
  website: '',
  thumbnail: '',
  hasAudioInput: true,
  hasAudioOutput: true,
  hasMidiInput: false,
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

const DIVISIONS = [
  ['1/16', 0.25],
  ['1/8', 0.5],
  ['1/8.', 0.75],
  ['1/4', 1],
  ['1/2', 2],
];

const PARAMS = {
  time: { label: 'Time', min: 0, max: DIVISIONS.length - 1, step: 1, default: 2, format: (v) => DIVISIONS[v][0] },
  feedback: { label: 'Feedback', min: 0, max: 0.9, step: 0.01, default: 0.4, format: (v) => `${Math.round(v * 100)}%` },
  tone: { label: 'Tone', min: 0, max: 1, step: 0.01, default: 0.6, format: (v) => `${Math.round(500 * 2 ** (v * 5))} Hz` },
  mix: { label: 'Mix', min: 0, max: 1, step: 0.01, default: 0.3, format: (v) => `${Math.round(v * 100)}%` },
};

// A composite node: the GainNode itself is the input; connect()/disconnect()
// are redirected to the internal output, so the host can treat it like any node.
class EchoNode extends GainNode {
  constructor(module) {
    const ctx = module.audioContext;
    super(ctx, { gain: 1 });
    this.module = module;
    this.tempo = 120;
    this.params = Object.fromEntries(Object.entries(PARAMS).map(([k, p]) => [k, p.default]));
    this.listeners = new Set();
    this.out = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.delay = ctx.createDelay(4);
    this.fb = ctx.createGain();
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    super.connect(this.dry).connect(this.out);
    super.connect(this.delay);
    this.delay.connect(this.lp).connect(this.fb).connect(this.delay);
    this.lp.connect(this.wet).connect(this.out);
    this.apply();
  }

  connect(...args) {
    return this.out.connect(...args);
  }
  disconnect(...args) {
    return this.out.disconnect(...args);
  }

  apply() {
    const p = this.params;
    const now = this.context.currentTime;
    const beat = 60 / this.tempo;
    this.delay.delayTime.setTargetAtTime(Math.min(3.9, beat * DIVISIONS[p.time][1]), now, 0.02);
    this.fb.gain.setTargetAtTime(p.feedback, now, 0.02);
    this.lp.frequency.setTargetAtTime(500 * 2 ** (p.tone * 5), now, 0.02);
    this.wet.gain.setTargetAtTime(p.mix, now, 0.02);
    this.dry.gain.setTargetAtTime(1 - p.mix * 0.5, now, 0.02);
  }

  scheduleEvents(...events) {
    for (const e of events) {
      if (e.type === 'wam-transport' && e.data?.tempo) {
        this.tempo = e.data.tempo;
        this.apply();
      }
    }
  }

  clearEvents() {}

  async getState() {
    return { ...this.params };
  }

  async setState(state) {
    for (const k of Object.keys(PARAMS)) if (typeof state?.[k] === 'number') this.params[k] = state[k];
    this.apply();
    for (const fn of this.listeners) fn();
  }

  destroy() {
    this.out.disconnect();
  }
}

export default class EchoModule {
  static isWebAudioModuleConstructor = true;

  static async createInstance(groupId, audioContext, initialState) {
    return new EchoModule(groupId, audioContext).initialize(initialState);
  }

  constructor(groupId, audioContext) {
    this.groupId = groupId;
    this.audioContext = audioContext;
    this.instanceId = `${DESCRIPTOR.identifier}-${Math.random().toString(36).slice(2)}`;
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
    this.audioNode = new EchoNode(this);
    if (state) await this.audioNode.setState(state);
    this.initialized = true;
    return this;
  }

  async createGui() {
    const node = this.audioNode;
    const root = document.createElement('div');
    root.className = 'wam-coprod-echo';
    root.innerHTML = `<style>
      .wam-coprod-echo{font:12px/1.3 system-ui,sans-serif;color:#e9ecf3;background:#101216;border:1px solid #2c313c;border-radius:10px;padding:10px 12px;display:flex;gap:14px;align-items:flex-end;flex-wrap:wrap}
      .wam-coprod-echo h4{margin:0 8px 0 0;font-size:13px;letter-spacing:.04em;color:#3ad5ff;align-self:center}
      .wam-coprod-echo label{display:flex;flex-direction:column;gap:4px;min-width:74px}
      .wam-coprod-echo input{accent-color:#3ad5ff;width:90px}
      .wam-coprod-echo output{color:#8b92a5}
    </style><h4>Echo</h4>`;
    const rows = [];
    for (const [id, p] of Object.entries(PARAMS)) {
      const label = document.createElement('label');
      label.innerHTML = `<span>${p.label}</span>`;
      const input = document.createElement('input');
      Object.assign(input, { type: 'range', min: p.min, max: p.max, step: p.step });
      input.dataset.param = id;
      const out = document.createElement('output');
      input.addEventListener('input', () => {
        node.params[id] = +input.value;
        node.apply();
        out.textContent = p.format(+input.value);
      });
      label.append(input, out);
      root.append(label);
      rows.push([id, input, out, p]);
    }
    const sync = () => {
      for (const [id, input, out, p] of rows) {
        input.value = node.params[id];
        out.textContent = p.format(node.params[id]);
      }
    };
    node.listeners.add(sync);
    sync();
    return root;
  }

  destroyGui(el) {
    el.remove();
  }
}
