// Main-thread side of coprod's own worklet plugins: a WAM 2.0 audio node with
// normalized parameters and host automation (ParamNode), optionally playing an
// audio file that every collaborator loads from coprod's sample store
// (SampleNode, /samples/<sha256>).

const workletLoaded = new WeakMap(); // AudioContext -> Map(url -> Promise)
const round = (v) => Math.round(v * 1e5) / 1e5;

// ------------------------------------------------------------------ samples

const fetched = new Map(); // id -> Promise<ArrayBuffer>
const decoded = new WeakMap(); // BaseAudioContext -> Map(id -> Promise<AudioBuffer>)
const SAMPLE_ID = /^[a-f0-9]{64}$/;

/** A sample reference from state, or null if it isn't one. */
export function cleanSampleRef(ref) {
  if (!ref || typeof ref !== 'object' || !SAMPLE_ID.test(ref.id)) return null;
  return { id: ref.id, name: String(ref.name ?? 'Sample').slice(0, 64) };
}

function decodeSample(ctx, id) {
  if (!decoded.has(ctx)) decoded.set(ctx, new Map());
  const cache = decoded.get(ctx);
  if (!cache.has(id)) {
    if (!fetched.has(id)) {
      fetched.set(
        id,
        fetch(new URL(`/samples/${id}`, import.meta.url)).then((res) => {
          if (!res.ok) throw new Error(res.status === 404 ? 'sample not found on this server' : `sample download failed (${res.status})`);
          return res.arrayBuffer();
        }),
      );
      fetched.get(id).catch(() => fetched.delete(id)); // allow a retry
    }
    const job = fetched.get(id).then((bytes) => ctx.decodeAudioData(bytes.slice(0)));
    job.catch(() => cache.delete(id));
    cache.set(id, job);
  }
  return cache.get(id);
}

/** Upload an audio file to coprod's sample store; returns a sample reference. */
export async function uploadSample(file) {
  const res = await fetch(new URL('/api/samples', import.meta.url), {
    method: 'POST',
    body: file,
    headers: { 'content-type': file.type || 'application/octet-stream' },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `upload failed (${res.status})`);
  return { id: body.id, name: String(file.name ?? 'Sample').replace(/\.[a-z0-9]+$/i, '').slice(0, 64) };
}

const AUDIO_FILE = /\.(wav|mp3|ogg|flac|m4a|aiff?)$/i;
export const isAudioFile = (f) => f && (f.type?.startsWith('audio/') || AUDIO_FILE.test(f.name ?? ''));

// ------------------------------------------------------------------ node

/** A WAM 2.0 audio node with normalized, automatable parameters. */
export class ParamNode extends AudioWorkletNode {
  /**
   * @param module   the WAM module
   * @param name     registered processor name
   * @param table    { PARAMS, INDEX, DEFAULTS } from defineParams
   */
  constructor(module, name, table) {
    super(module.audioContext, name, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    this.module = module;
    this.table = table;
    this.values = Float32Array.from(table.DEFAULTS);
    this.autoValues = new Map(); // id -> normalized value the host automated
    this.listeners = new Set();
    this.status = null;
    this.tempo = 120;
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

  param(id) {
    return this.table.PARAMS[this.table.INDEX[id]];
  }
  get(id) {
    return this.values[this.table.INDEX[id]];
  }
  /** What the GUI should show: the automated value while automation runs. */
  shown(id) {
    return this.autoValues.get(id) ?? this.get(id);
  }
  /** Real units (seconds, semitones, choice index…) as currently heard. */
  real(id) {
    return this.param(id).map(this.shown(id));
  }
  set(id, n) {
    const i = this.table.INDEX[id];
    if (i === undefined) return;
    this.values[i] = Math.min(1, Math.max(0, n));
    this.autoValues.delete(id);
    this.port.postMessage({ type: 'param', i, v: this.values[i] });
    this.emit('param', id);
  }

  // ---- WAM events

  scheduleEvents(...events) {
    const out = [];
    const { INDEX } = this.table;
    for (const e of events) {
      const time = e.time ?? 0;
      if (e.type === 'wam-midi') out.push({ kind: 'midi', time, bytes: e.data.bytes });
      else if (e.type === 'wam-automation') {
        const i = INDEX[e.data.id];
        if (i === undefined) continue;
        const v = Math.min(1, Math.max(0, +e.data.value || 0)); // published as 0..1
        this.autoValues.set(e.data.id, v);
        out.push({ kind: 'auto', time, i, v });
      } else if (e.type === 'wam-transport') {
        if (e.data.tempo) this.tempo = e.data.tempo;
        out.push({ kind: 'transport', time, tempo: e.data.tempo, playing: e.data.playing });
        if (e.data.playing === false && this.autoValues.size) {
          this.autoValues.clear();
          this.emit('param');
        }
      } else {
        const own = this.translateEvent?.(e, time); // subclasses: other event types
        if (own) out.push(own);
      }
    }
    if (out.length) this.port.postMessage({ type: 'events', events: out });
    if (events.some((e) => e.type === 'wam-automation')) this.emit('automation');
  }

  /** Play a note right now (auditioning from the GUI). */
  audition(note, seconds = 0.4) {
    const t = this.context.currentTime + 0.01;
    this.scheduleEvents(
      { type: 'wam-midi', time: t, data: { bytes: [0x90, note, 100] } },
      { type: 'wam-midi', time: t + seconds, data: { bytes: [0x80, note, 0] } },
    );
  }

  clearEvents() {
    this.port.postMessage({ type: 'clear' });
  }

  async getParameterInfo(...ids) {
    const { PARAMS, INDEX } = this.table;
    const list = ids.length ? ids : PARAMS.map((p) => p.id);
    const out = {};
    for (const id of list) {
      const p = PARAMS[INDEX[id]];
      if (!p) continue;
      out[id] = {
        id,
        label: p.label,
        type: p.kind === 'choice' ? 'choice' : 'float',
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
    const { PARAMS, INDEX } = this.table;
    const list = ids.length ? ids : PARAMS.map((p) => p.id);
    return Object.fromEntries(list.filter((id) => INDEX[id] !== undefined).map((id) => [id, { id, value: this.shown(id), normalized: true }]));
  }

  async setParameterValues(values) {
    for (const [id, v] of Object.entries(values)) this.set(id, v.value);
  }

  // ---- state (what coprod shares between collaborators)

  /** Parameters that differ from their defaults. */
  paramState() {
    const out = {};
    this.table.PARAMS.forEach((p, i) => {
      if (Math.abs(this.values[i] - p.def) > 1e-6) out[p.id] = round(this.values[i]);
    });
    return out;
  }

  applyParamState(params) {
    const { INDEX, DEFAULTS } = this.table;
    const values = Float32Array.from(DEFAULTS);
    for (const [id, v] of Object.entries(params ?? {})) {
      if (INDEX[id] !== undefined && Number.isFinite(v)) values[INDEX[id]] = Math.min(1, Math.max(0, v));
    }
    if (values.some((v, i) => v !== this.values[i])) {
      this.values = values;
      this.port.postMessage({ type: 'params', values: values.slice() });
      this.emit('param');
    }
  }

  destroy() {
    this.port.postMessage({ type: 'panic' });
    this.disconnect();
  }
}

/** A ParamNode that plays an audio file every collaborator loads from coprod's sample store. */
export class SampleNode extends ParamNode {
  /** @param demo  (sampleRate) => { L, R, name } used when no file is loaded */
  constructor(module, name, table, demo) {
    super(module, name, table);
    this.demo = demo;
    this.sample = null; // { id, name } or null for the demo sound
    this.audio = null; // { L, R, sr, duration, name } as loaded
    this.sampleError = null;
    this.loadedKey = undefined;
  }

  /** Load a sample reference (or null for the demo) and send it to the audio thread. */
  async setSample(ref) {
    ref = cleanSampleRef(ref);
    const key = ref?.id ?? 'demo';
    if (key === this.loadedKey) return false;
    this.loadedKey = key;
    this.sample = ref;
    this.sampleError = null;
    this.emit('loading');
    const ctx = this.context;
    let audio;
    try {
      if (ref) {
        const buf = await decodeSample(ctx, ref.id);
        audio = { L: buf.getChannelData(0), R: buf.getChannelData(buf.numberOfChannels > 1 ? 1 : 0), name: ref.name };
      } else {
        audio = this.demo(ctx.sampleRate);
      }
    } catch (err) {
      if (this.loadedKey !== key) return false;
      this.sampleError = err.message || String(err);
      this.emit('sample');
      return false;
    }
    if (this.loadedKey !== key) return false; // replaced meanwhile
    this.audio = { ...audio, sr: ctx.sampleRate, duration: audio.L.length / ctx.sampleRate };
    const L = audio.L.slice();
    const R = audio.R === audio.L ? L : audio.R.slice();
    this.port.postMessage({ type: 'buffer', L, R }, R === L ? [L.buffer] : [L.buffer, R.buffer]);
    this.emit('sample');
    return true;
  }

  /** Upload a file, then use it. Returns true when a new sound loaded. */
  async loadFile(file) {
    this.uploading = file.name;
    this.emit('loading');
    try {
      const ref = await uploadSample(file);
      return await this.setSample(ref);
    } catch (err) {
      this.sampleError = err.message || String(err);
      this.emit('sample');
      return false;
    } finally {
      this.uploading = null;
    }
  }
}

/**
 * A WAM module class around a ParamNode subclass.
 * @param descriptor  WAM descriptor
 * @param processor   URL of the AudioWorklet module (registers the processor)
 * @param Node        class (module) => ParamNode
 * @param gui         () => import of a module exporting createGui(node)
 */
export function sampleModule(descriptor, processor, Node, gui) {
  return class {
    static isWebAudioModuleConstructor = true;

    static async createInstance(groupId, audioContext, initialState) {
      return new this(groupId, audioContext).initialize(initialState);
    }

    constructor(groupId, audioContext) {
      this.groupId = groupId;
      this.audioContext = audioContext;
      this.instanceId = `${descriptor.identifier}-${Math.random().toString(36).slice(2)}`;
    }

    get isWebAudioModule() {
      return true;
    }
    get descriptor() {
      return descriptor;
    }
    get moduleId() {
      return descriptor.identifier;
    }
    get name() {
      return descriptor.name;
    }
    get vendor() {
      return descriptor.vendor;
    }

    async initialize(state) {
      const ctx = this.audioContext;
      if (!workletLoaded.has(ctx)) workletLoaded.set(ctx, new Map());
      const loaded = workletLoaded.get(ctx);
      if (!loaded.has(processor)) loaded.set(processor, ctx.audioWorklet.addModule(processor));
      await loaded.get(processor);
      this.audioNode = new Node(this);
      await this.audioNode.setState(state && typeof state === 'object' ? state : {});
      this.initialized = true;
      return this;
    }

    async createGui() {
      return (await gui()).createGui(this.audioNode);
    }

    destroyGui(el) {
      el.cleanup?.();
      el.remove();
    }
  };
}

export const descriptor = (fields) => ({
  vendor: 'coprod',
  version: '1.0.0',
  apiVersion: '2.0.0',
  website: '',
  thumbnail: '',
  isInstrument: true,
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
  ...fields,
});
