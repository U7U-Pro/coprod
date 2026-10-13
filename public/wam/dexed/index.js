// Dexed for the web: the Dexed DX7 emulator (https://github.com/asb2m10/dexed)
// compiled to WebAssembly and packaged as a Web Audio Module (WAM 2.0).
//
// GPL-3.0-or-later, like Dexed. Engine source and build script: plugins/dexed
// in the coprod repository. See LICENSE and README.md in this folder.

const BASE = new URL('./', import.meta.url);
const BANKS = ['Dexed_01', ...Array.from({ length: 32 }, (_, i) => `SynprezFM_${String(i + 1).padStart(2, '0')}`)];
const ENGINES = ['Modern', 'Mark I', 'OPL'];
const LFO_WAVES = ['Triangle', 'Saw down', 'Saw up', 'Square', 'Sine', 'S&H'];

const DESCRIPTOR = {
  identifier: 'com.coprod.dexed',
  name: 'Dexed',
  vendor: 'Digital Suburban (port: coprod)',
  version: '1.1.0-web',
  apiVersion: '2.0.0',
  description: 'DX7 FM synthesizer emulation. Dexed compiled to WebAssembly.',
  keywords: ['synth', 'fm', 'dx7'],
  isInstrument: true,
  website: 'https://github.com/asb2m10/dexed',
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

// ------------------------------------------------------------------ assets

let wasmBytes = null;
const workletLoaded = new WeakMap(); // AudioContext -> Promise
const banks = new Map(); // name -> Promise<{ names, voices }>

async function wasm() {
  wasmBytes ??= fetch(new URL('dexed.wasm', BASE)).then((r) => {
    if (!r.ok) throw new Error(`dexed.wasm: HTTP ${r.status}`);
    return r.arrayBuffer();
  });
  return wasmBytes;
}

/** A DX7 32-voice bulk dump: 6-byte header, 32 x 128-byte voices, checksum, F7. */
export function loadBank(name) {
  if (!banks.has(name)) {
    banks.set(
      name,
      fetch(new URL(`banks/${name}.syx`, BASE))
        .then((r) => r.arrayBuffer())
        .then((buf) => {
          const data = new Uint8Array(buf);
          const voices = [];
          const names = [];
          for (let v = 0; v < 32; v++) {
            const packed = data.slice(6 + v * 128, 6 + (v + 1) * 128);
            voices.push(packed);
            names.push(voiceName(packed, 118));
          }
          return { voices, names };
        }),
    );
  }
  return banks.get(name);
}

const voiceName = (bytes, at) =>
  String.fromCharCode(...Array.from(bytes.slice(at, at + 10), (c) => (c >= 32 && c < 127 ? c : 32))).trimEnd();

// ------------------------------------------------------------------ node

class DexedNode extends AudioWorkletNode {
  constructor(module, bytes) {
    super(module.audioContext, 'coprod-dexed', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { wasm: bytes },
    });
    this.module = module;
    this.state = { bank: 'Dexed_01', voice: 0, program: null, cutoff: 1, reso: 0, gain: 1, engine: 1 };
    this.listeners = new Set();
    this.waiting = new Map();
    this.nextId = 1;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'program') this.waiting.get(data.id)?.(data.program);
    };
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

  changed() {
    for (const fn of this.listeners) fn(this.state);
  }

  scheduleEvents(...events) {
    const midi = events.filter((e) => e.type === 'wam-midi').map((e) => ({ time: e.time ?? 0, bytes: e.data.bytes }));
    if (midi.length) this.port.postMessage({ type: 'events', events: midi });
  }

  clearEvents() {
    this.port.postMessage({ type: 'clear' });
  }

  async loadVoice(bank, voice) {
    const b = await loadBank(bank);
    const id = this.nextId++;
    const program = await new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.port.postMessage({ type: 'voice', packed: b.voices[voice], id });
    });
    this.waiting.delete(id);
    Object.assign(this.state, { bank, voice, program });
    this.changed();
  }

  setParam(offset, value) {
    if (!this.state.program) return;
    this.state.program[offset] = value;
    this.port.postMessage({ type: 'param', offset, value });
  }

  setFilter(patch) {
    Object.assign(this.state, patch);
    const { cutoff, reso, gain } = this.state;
    this.port.postMessage({ type: 'filter', cutoff, reso, gain });
  }

  setEngine(engine) {
    this.state.engine = engine;
    this.port.postMessage({ type: 'engine', engine });
  }

  async getState() {
    return { ...this.state, program: this.state.program ? [...this.state.program] : null };
  }

  async setState(s) {
    if (!s) return;
    if (Array.isArray(s.program) && s.program.length === 156) {
      this.state.program = s.program.map((v) => v & 0x7f);
      this.port.postMessage({ type: 'program', program: this.state.program });
      if (BANKS.includes(s.bank)) this.state.bank = s.bank;
      if (Number.isInteger(s.voice)) this.state.voice = s.voice;
    } else if (BANKS.includes(s.bank) && Number.isInteger(s.voice)) {
      await this.loadVoice(s.bank, s.voice);
    }
    const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    this.setFilter({ cutoff: num(s.cutoff, this.state.cutoff), reso: num(s.reso, this.state.reso), gain: num(s.gain, this.state.gain) });
    if ([0, 1, 2].includes(s.engine)) this.setEngine(s.engine);
    this.changed();
  }

  destroy() {
    this.port.postMessage({ type: 'panic' });
    this.disconnect();
  }
}

// ------------------------------------------------------------------ module

export default class DexedModule {
  static isWebAudioModuleConstructor = true;

  static async createInstance(groupId, audioContext, initialState) {
    return new DexedModule(groupId, audioContext).initialize(initialState);
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
    const ctx = this.audioContext;
    if (!workletLoaded.has(ctx)) workletLoaded.set(ctx, ctx.audioWorklet.addModule(new URL('processor.js', BASE)));
    const [bytes] = await Promise.all([wasm(), workletLoaded.get(ctx)]);
    this.audioNode = new DexedNode(this, bytes);
    if (state?.program || state?.bank) await this.audioNode.setState(state);
    else await this.audioNode.loadVoice('Dexed_01', 0);
    this.initialized = true;
    return this;
  }

  async createGui() {
    return createGui(this.audioNode);
  }

  destroyGui(el) {
    el.cleanup?.();
    el.remove();
  }
}

// ------------------------------------------------------------------ GUI

const CSS = `
.dx{--bg:#191512;--panel:#231d18;--line:#3a3029;--lcd:#0c231c;--lcdt:#8ef0c8;--acc:#e0613f;--txt:#efe6dc;--mut:#a3968a;
  font:12px/1.3 system-ui,sans-serif;color:var(--txt);background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:12px;min-width:0}
.dx *{box-sizing:border-box}
.dx-top{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.dx-logo{font-weight:800;letter-spacing:.18em;color:var(--acc);font-size:14px}
.dx-lcd{flex:1;min-width:190px;background:var(--lcd);color:var(--lcdt);font:600 14px/1.2 ui-monospace,Menlo,monospace;border-radius:6px;padding:7px 10px;box-shadow:inset 0 0 0 1px #000,inset 0 0 18px #0006;white-space:pre;overflow:hidden;text-overflow:ellipsis}
.dx button,.dx select{font:inherit;color:inherit;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:5px 8px;cursor:pointer}
.dx button.on{background:var(--acc);border-color:var(--acc);color:#1b0c06}
.dx-voices{display:grid;grid-template-columns:repeat(auto-fill,minmax(98px,1fr));gap:4px}
.dx-voices button{text-align:left;font:11px ui-monospace,Menlo,monospace;padding:4px 6px;white-space:nowrap;overflow:hidden}
.dx-voices button b{color:var(--mut);font-weight:400;margin-right:4px}
.dx-voices button.on b{color:#5a2112}
.dx-row{display:flex;flex-wrap:wrap;gap:10px 14px;align-items:flex-end}
.dx-f{display:flex;flex-direction:column;gap:3px;min-width:64px}
.dx-f span{color:var(--mut);font-size:10px;text-transform:uppercase;letter-spacing:.06em}
.dx-f output{font-variant-numeric:tabular-nums;color:var(--txt);font-size:11px}
.dx input[type=range]{width:78px;accent-color:var(--acc)}
.dx-ops{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:8px}
.dx-op{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:6px}
.dx-op.off{opacity:.45}
.dx-op header{display:flex;align-items:center;justify-content:space-between;font-weight:700;letter-spacing:.08em}
.dx-op header small{font-weight:400;color:var(--mut);letter-spacing:0}
.dx-op .dx-row{gap:6px 10px}
.dx-op input[type=range]{width:64px}
.dx-eg{width:100%;height:42px;background:#120f0d;border-radius:4px}
.dx-egs{display:grid;grid-template-columns:repeat(4,1fr);gap:2px 6px}
.dx-egs label{display:flex;flex-direction:column;font-size:9px;color:var(--mut)}
.dx-egs input[type=range]{width:100%}
.dx-h{margin:0;font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:var(--mut)}
`;

function createGui(node) {
  const root = document.createElement('div');
  root.className = 'dx';
  root.innerHTML = `<style>${CSS}</style>`;
  const h = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const refreshers = [];

  // A slider bound to a program byte (or to any getter/setter pair).
  function field(label, min, max, get, set, fmt = (v) => v) {
    const f = h('label', 'dx-f');
    const input = h('input');
    Object.assign(input, { type: 'range', min, max, step: 1 });
    const out = h('output');
    input.oninput = () => {
      set(+input.value);
      out.textContent = fmt(+input.value);
      redraw();
    };
    f.append(h('span', '', label), input, out);
    refreshers.push(() => {
      const v = get();
      if (v === undefined) return;
      input.value = v;
      out.textContent = fmt(v);
    });
    return f;
  }
  const P = (offset, label, min, max, fmt) =>
    field(label, min, max, () => node.state.program?.[offset], (v) => node.setParam(offset, v), fmt);

  // ---- header: LCD, bank, voice stepping
  const top = h('div', 'dx-top');
  const lcd = h('div', 'dx-lcd');
  const bankSel = h('select');
  for (const b of BANKS) bankSel.append(new Option(b.replace('_', ' '), b));
  const prev = h('button', '', '◀');
  const next = h('button', '', '▶');
  const voicesBtn = h('button', 'on', 'Voices');
  top.append(h('span', 'dx-logo', 'DEXED'), lcd, prev, next, bankSel, voicesBtn);

  const voiceGrid = h('div', 'dx-voices');
  let gridBank = null;
  async function showBank(name) {
    const b = await loadBank(name);
    gridBank = name;
    voiceGrid.replaceChildren(
      ...b.names.map((n, i) => {
        const btn = h('button');
        btn.append(h('b', '', String(i + 1).padStart(2, '0')), n);
        btn.onclick = () => node.loadVoice(name, i);
        return btn;
      }),
    );
    markVoice();
  }
  const markVoice = () =>
    [...voiceGrid.children].forEach((b, i) => b.classList.toggle('on', gridBank === node.state.bank && i === node.state.voice));
  bankSel.onchange = () => showBank(bankSel.value);
  prev.onclick = () => node.loadVoice(node.state.bank, (node.state.voice + 31) % 32);
  next.onclick = () => node.loadVoice(node.state.bank, (node.state.voice + 1) % 32);
  voicesBtn.onclick = () => {
    voiceGrid.hidden = !voiceGrid.hidden;
    voicesBtn.classList.toggle('on', !voiceGrid.hidden);
  };

  // ---- global voice parameters
  const glob = h('div', 'dx-row');
  const engineSel = h('select');
  ENGINES.forEach((n, i) => engineSel.append(new Option(n, i)));
  engineSel.onchange = () => node.setEngine(+engineSel.value);
  const engineF = h('label', 'dx-f');
  engineF.append(h('span', '', 'Engine'), engineSel);
  refreshers.push(() => (engineSel.value = node.state.engine));
  const keySync = h('button', '', 'Key sync');
  keySync.onclick = () => {
    node.setParam(136, node.state.program[136] ? 0 : 1);
    refresh();
  };
  refreshers.push(() => keySync.classList.toggle('on', !!node.state.program?.[136]));
  const pct = (v) => `${Math.round(v)}%`;
  glob.append(
    P(134, 'Algorithm', 0, 31, (v) => v + 1),
    P(135, 'Feedback', 0, 7),
    P(144, 'Transpose', 0, 48, (v) => `${v - 24 > 0 ? '+' : ''}${v - 24} st`),
    P(142, 'LFO wave', 0, 5, (v) => LFO_WAVES[v]),
    P(137, 'LFO speed', 0, 99),
    P(138, 'LFO delay', 0, 99),
    P(139, 'Pitch mod', 0, 99),
    P(140, 'Amp mod', 0, 99),
    P(143, 'P mod sens', 0, 7),
    field('Cutoff', 0, 100, () => Math.round(node.state.cutoff * 100), (v) => node.setFilter({ cutoff: v / 100 }), pct),
    field('Reso', 0, 100, () => Math.round(node.state.reso * 100), (v) => node.setFilter({ reso: v / 100 }), pct),
    field('Output', 0, 200, () => Math.round(node.state.gain * 100), (v) => node.setFilter({ gain: v / 100 }), pct),
    engineF,
    keySync,
  );

  // ---- operators, shown OP1..OP6 (stored in the patch as OP6..OP1)
  const ops = h('div', 'dx-ops');
  const egCanvases = [];
  for (let n = 1; n <= 6; n++) {
    const base = (6 - n) * 21;
    const bit = 6 - n;
    const card = h('div', 'dx-op');
    const head = h('header');
    const ratio = h('small');
    const onBtn = h('button', '', `OP${n}`);
    onBtn.onclick = () => {
      node.setParam(155, node.state.program[155] ^ (1 << bit));
      refresh();
    };
    head.append(onBtn, ratio);
    const fixed = h('button', '', 'Ratio');
    fixed.onclick = () => {
      node.setParam(base + 17, node.state.program[base + 17] ? 0 : 1);
      refresh();
    };
    const row = h('div', 'dx-row');
    row.append(
      P(base + 16, 'Level', 0, 99),
      P(base + 18, 'Coarse', 0, 31),
      P(base + 19, 'Fine', 0, 99),
      P(base + 20, 'Detune', 0, 14, (v) => v - 7),
      P(base + 15, 'Velocity', 0, 7),
      P(base + 14, 'Amp mod', 0, 3),
    );
    const eg = h('canvas', 'dx-eg');
    egCanvases.push({ eg, base });
    const egs = h('div', 'dx-egs');
    for (let k = 0; k < 4; k++) egs.append(egSlider(`R${k + 1}`, base + k));
    for (let k = 0; k < 4; k++) egs.append(egSlider(`L${k + 1}`, base + 4 + k));
    card.append(head, row, fixed, h('p', 'dx-h', 'Envelope'), eg, egs);
    refreshers.push(() => {
      const p = node.state.program;
      if (!p) return;
      const on = !!(p[155] & (1 << bit));
      card.classList.toggle('off', !on);
      onBtn.classList.toggle('on', on);
      fixed.textContent = p[base + 17] ? 'Fixed freq' : 'Ratio';
      ratio.textContent = freqLabel(p[base + 17], p[base + 18], p[base + 19]);
    });
    ops.append(card);
  }
  function egSlider(label, offset) {
    const l = h('label');
    const input = h('input');
    Object.assign(input, { type: 'range', min: 0, max: 99, step: 1 });
    input.oninput = () => {
      node.setParam(offset, +input.value);
      redraw();
    };
    l.append(label, input);
    refreshers.push(() => {
      const v = node.state.program?.[offset];
      if (v !== undefined) input.value = v;
    });
    return l;
  }

  function freqLabel(fixed, coarse, fine) {
    if (fixed) return `${(10 ** (coarse & 3) * Math.exp(Math.log(10) * (fine / 100))).toFixed(2)} Hz`;
    return `× ${((coarse || 0.5) * (1 + fine / 100)).toFixed(2)}`;
  }

  function drawEg({ eg, base }) {
    const p = node.state.program;
    if (!p) return;
    const w = (eg.width = eg.clientWidth * devicePixelRatio || 300);
    const ht = (eg.height = eg.clientHeight * devicePixelRatio || 80);
    const g = eg.getContext('2d');
    const rates = [0, 1, 2, 3].map((k) => p[base + k]);
    const levels = [0, 1, 2, 3].map((k) => p[base + 4 + k]);
    // Segment lengths shrink as rates rise; the sustain hold gets a fixed span.
    const seg = rates.map((r) => 0.15 + (99 - r) / 99);
    const total = seg[0] + seg[1] + seg[2] + 0.8 + seg[3];
    const X = (t) => (t / total) * (w - 8) + 4;
    const Y = (l) => ht - 4 - (l / 99) * (ht - 8);
    let t = 0;
    g.strokeStyle = '#e0613f';
    g.lineWidth = 2 * devicePixelRatio;
    g.beginPath();
    g.moveTo(X(0), Y(levels[3]));
    for (let k = 0; k < 3; k++) {
      t += seg[k];
      g.lineTo(X(t), Y(levels[k]));
    }
    t += 0.8;
    g.lineTo(X(t), Y(levels[2]));
    t += seg[3];
    g.lineTo(X(t), Y(levels[3]));
    g.stroke();
  }

  const redraw = () => egCanvases.forEach(drawEg);
  function refresh() {
    const p = node.state.program;
    lcd.textContent = p
      ? `${String(node.state.voice + 1).padStart(2, '0')} ${voiceName(Uint8Array.from(p), 145)}   ALG ${p[134] + 1}`
      : 'loading…';
    if (bankSel.value !== node.state.bank) bankSel.value = node.state.bank;
    if (gridBank !== node.state.bank) showBank(node.state.bank);
    else markVoice();
    for (const r of refreshers) r();
    redraw();
  }

  root.append(top, voiceGrid, h('p', 'dx-h', 'Voice'), glob, h('p', 'dx-h', 'Operators'), ops);
  node.listeners.add(refresh);
  root.cleanup = () => node.listeners.delete(refresh);
  requestAnimationFrame(refresh);
  return root;
}
