// Vertex: a wavetable synthesizer for coprod, packaged as a Web Audio Module.
// Two wavetable oscillators with unison and warp, sub + noise, a multimode
// filter, 3 envelopes, 4 LFOs, a modulation matrix and an 8-slot effects rack.
// Every parameter is exposed to the host for automation.

import { PARAMS, INDEX as I, DEFAULTS, FX_KINDS, SOURCES } from './params.js';
import { buildMips, framesFromSpec } from './wavetables.js';
import { PRESETS, presetState } from './presets.js';

const BASE = new URL('./', import.meta.url);

const DESCRIPTOR = {
  identifier: 'com.coprod.vertex',
  name: 'Vertex',
  vendor: 'coprod',
  version: '1.0.0',
  apiVersion: '2.0.0',
  description: 'Wavetable synthesizer with modulation matrix and effects rack.',
  keywords: ['synth', 'wavetable'],
  isInstrument: true,
  website: '',
  thumbnail: '',
  hasAudioInput: false,
  hasAudioOutput: true,
  hasMidiInput: true,
  hasMidiOutput: false,
  hasAutomationInput: true,
  hasAutomationOutput: false,
  hasMpeInput: false,
  hasMpeOutput: false,
  hasOscInput: false,
  hasOscOutput: false,
  hasSysexInput: false,
  hasSysexOutput: false,
};

// ------------------------------------------------------------------ tables

const tableCache = new Map(); // spec key -> Promise<mips>

function specKey(spec) {
  if (spec?.kind !== 'custom') return `builtin:${spec?.name}`;
  // cheap content hash for custom data
  let h = 2166136261;
  for (let i = 0; i < spec.data.length; i += 7) h = Math.imul(h ^ spec.data.charCodeAt(i), 16777619);
  return `custom:${spec.data.length}:${h >>> 0}`;
}

export function mipsFor(spec) {
  const key = specKey(spec);
  if (!tableCache.has(key)) {
    tableCache.set(
      key,
      new Promise((resolve) =>
        // let the GUI paint before the ~100 ms of FFT work
        setTimeout(() => {
          const { frames, count } = framesFromSpec(spec);
          resolve(buildMips(frames, count));
        }, 0),
      ),
    );
    if (tableCache.size > 24) tableCache.delete(tableCache.keys().next().value);
  }
  return tableCache.get(key);
}

const validSpec = (s) =>
  s && typeof s === 'object' && (s.kind === 'builtin' ? typeof s.name === 'string' : s.kind === 'custom' && typeof s.data === 'string')
    ? s
    : { kind: 'builtin', name: 'Basic Shapes' };

// ------------------------------------------------------------------ node

const workletLoaded = new WeakMap();
const round = (v) => Math.round(v * 1e5) / 1e5;

export class VertexNode extends AudioWorkletNode {
  constructor(module) {
    super(module.audioContext, 'coprod-vertex', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    this.module = module;
    this.values = Float32Array.from(DEFAULTS); // normalized, by param index
    this.routes = [];
    this.lfo = {}; // custom LFO points by number (1..4)
    this.tables = { a: { kind: 'builtin', name: 'Basic Shapes' }, b: { kind: 'builtin', name: 'Basic Shapes' } };
    this.fxOrder = [...FX_KINDS];
    this.name = 'Init';
    this.autoValues = new Map(); // id -> normalized value the host automated
    this.status = null;
    this.listeners = new Set();
    this.port.onmessage = ({ data }) => {
      if (data.type === 'status') {
        this.status = data;
        this.emit('status');
      }
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

  emit(kind, detail) {
    for (const fn of this.listeners) fn(kind, detail);
  }

  // ---- parameters

  get(id) {
    return this.values[I[id]];
  }
  /** What the GUI should show: the automated value while automation runs. */
  shown(id) {
    return this.autoValues.get(id) ?? this.values[I[id]];
  }
  set(id, n) {
    const i = I[id];
    if (i === undefined) return;
    this.values[i] = Math.min(1, Math.max(0, n));
    this.autoValues.delete(id);
    this.port.postMessage({ type: 'param', i, v: this.values[i] });
    this.emit('param', id);
  }

  setRoutes(routes) {
    this.routes = routes
      .filter((r) => SOURCES.includes(r.src) && I[r.dst] !== undefined)
      .map((r) => ({ src: r.src, dst: r.dst, amt: round(Math.max(-1, Math.min(1, +r.amt || 0))), bi: !!r.bi }))
      .slice(0, 64);
    this.port.postMessage({ type: 'routes', routes: this.routes });
    this.emit('routes');
  }
  addRoute(src, dst, amt = 0.5) {
    const existing = this.routes.find((r) => r.src === src && r.dst === dst);
    if (existing) return;
    this.setRoutes([...this.routes, { src, dst, amt, bi: false }]);
  }

  setLfoShape(n, points) {
    if (points) this.lfo[n] = points.map(([x, y]) => [round(x), round(y)]);
    else delete this.lfo[n];
    this.port.postMessage({ type: 'lfo', n: n - 1, points: this.lfo[n] ?? null });
    this.emit('lfo', n);
  }

  async setTable(osc, spec) {
    spec = validSpec(spec);
    this.tables[osc] = spec;
    (this.sentTables ??= {})[osc] = spec;
    this.emit('tables', osc);
    const mips = await mipsFor(spec);
    if (this.tables[osc] !== spec) return; // changed again meanwhile
    const data = mips.data.slice();
    this.port.postMessage({ type: 'table', osc: osc === 'a' ? 0 : 1, data, frames: mips.frames, levels: mips.levels, row: mips.row }, [data.buffer]);
  }

  setFxOrder(order) {
    const valid = (order ?? []).filter((k) => FX_KINDS.includes(k));
    this.fxOrder = [...new Set([...valid, ...FX_KINDS])];
    this.port.postMessage({ type: 'fxorder', order: this.fxOrder });
    this.emit('fx');
  }

  setName(name) {
    this.name = String(name).slice(0, 40);
    this.emit('all');
  }

  loadPreset(preset) {
    return this.setState(presetState(preset));
  }

  // ---- WAM events

  scheduleEvents(...events) {
    const out = [];
    for (const e of events) {
      const time = e.time ?? 0;
      if (e.type === 'wam-midi') out.push({ kind: 'midi', time, bytes: e.data.bytes });
      else if (e.type === 'wam-automation') {
        const i = I[e.data.id];
        if (i === undefined) continue;
        // every Vertex parameter is published as 0..1, so values are already normalized
        const v = Math.min(1, Math.max(0, +e.data.value || 0));
        this.autoValues.set(e.data.id, v);
        out.push({ kind: 'auto', time, i, v });
      } else if (e.type === 'wam-transport') {
        out.push({ kind: 'transport', time, tempo: e.data.tempo, playing: e.data.playing });
        if (e.data.playing === false && this.autoValues.size) {
          this.autoValues.clear();
          this.emit('param');
        }
      }
    }
    if (out.length) this.port.postMessage({ type: 'events', events: out });
    if (events.some((e) => e.type === 'wam-automation')) this.emit('automation');
  }

  clearEvents() {
    this.port.postMessage({ type: 'clear' });
  }

  async getParameterInfo(...ids) {
    const list = ids.length ? ids : PARAMS.map((p) => p.id);
    const out = {};
    for (const id of list) {
      const p = PARAMS[I[id]];
      if (!p) continue;
      out[id] = {
        id,
        label: p.label,
        type: p.kind === 'choice' || p.kind === 'int' || p.kind === 'bool' ? 'choice' : 'float',
        defaultValue: p.def,
        minValue: 0,
        maxValue: 1,
        discreteStep: p.kind === 'choice' ? 1 / Math.max(1, p.choices.length - 1) : 0,
        group: p.group,
      };
    }
    return out;
  }

  async getParameterValues(_normalized, ...ids) {
    const list = ids.length ? ids : PARAMS.map((p) => p.id);
    return Object.fromEntries(list.filter((id) => I[id] !== undefined).map((id) => [id, { id, value: this.shown(id), normalized: true }]));
  }

  async setParameterValues(values) {
    for (const [id, v] of Object.entries(values)) this.set(id, v.value);
  }

  // ---- state (what coprod shares between collaborators)

  async getState() {
    const params = {};
    PARAMS.forEach((p, i) => {
      if (Math.abs(this.values[i] - p.def) > 1e-6) params[p.id] = round(this.values[i]);
    });
    return {
      v: 1,
      name: this.name,
      params,
      routes: this.routes.map((r) => ({ ...r })),
      lfo: JSON.parse(JSON.stringify(this.lfo)),
      tables: { a: this.tables.a, b: this.tables.b },
      fxOrder: this.fxOrder.join() === FX_KINDS.join() ? null : [...this.fxOrder],
    };
  }

  /** Apply a state, touching only the parts that differ (knob turns from a
   *  collaborator arrive as whole states, and wavetables are expensive). */
  async setState(s) {
    if (!s || typeof s !== 'object') return;
    this.name = typeof s.name === 'string' ? s.name.slice(0, 40) : 'Untitled';
    const values = Float32Array.from(DEFAULTS);
    for (const [id, v] of Object.entries(s.params ?? {})) {
      if (I[id] !== undefined && Number.isFinite(v)) values[I[id]] = Math.min(1, Math.max(0, v));
    }
    if (values.some((v, i) => v !== this.values[i])) {
      this.values = values;
      this.port.postMessage({ type: 'params', values: values.slice() });
    }
    const routes = Array.isArray(s.routes) ? s.routes : [];
    if (JSON.stringify(routes) !== JSON.stringify(this.routes)) this.setRoutes(routes);
    for (let n = 1; n <= 4; n++) {
      const pts = s.lfo?.[n];
      const next = Array.isArray(pts) && pts.length >= 2 && pts.length <= 64 ? pts : null;
      if (JSON.stringify(next) !== JSON.stringify(this.lfo[n] ?? null)) this.setLfoShape(n, next);
    }
    const order = s.fxOrder ?? FX_KINDS;
    if (order.join() !== this.fxOrder.join()) this.setFxOrder(order);
    const jobs = [];
    for (const o of ['a', 'b']) {
      const next = validSpec(s.tables?.[o]);
      if (!this.sentTables?.[o] || specKey(next) !== specKey(this.sentTables[o])) {
        (this.sentTables ??= {})[o] = next;
        jobs.push(this.setTable(o, next));
      }
    }
    await Promise.all(jobs);
    this.emit('all');
  }

  destroy() {
    this.port.postMessage({ type: 'panic' });
    this.disconnect();
  }
}

// ------------------------------------------------------------------ module

export default class VertexModule {
  static isWebAudioModuleConstructor = true;

  static async createInstance(groupId, audioContext, initialState) {
    return new VertexModule(groupId, audioContext).initialize(initialState);
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
    await workletLoaded.get(ctx);
    this.audioNode = new VertexNode(this);
    await this.audioNode.setState(state && typeof state === 'object' && state.v ? state : presetState(PRESETS[0]));
    this.initialized = true;
    return this;
  }

  async createGui() {
    const { createGui } = await import('./gui.js');
    return createGui(this.audioNode);
  }

  destroyGui(el) {
    el.cleanup?.();
    el.remove();
  }
}
