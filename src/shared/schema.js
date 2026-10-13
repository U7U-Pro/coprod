// The shared project document and every edit that can be made to it.
// Used by the browser (edits) and the server (seeding new rooms).
//
// Layout of the Y.Doc:
//   meta      Y.Map    { version, title, bpm }
//   channels  Y.Array  of Y.Map { id, name, inst, vol, pan, mute, color,
//                                  sample?, plugin?, pluginState?, fx: Y.Map }
//               sample:  { id: sha256 of the uploaded file, name }
//               plugin:  { url, name } of a Web Audio Module instrument
//               fx:      fxId -> { url, name, order, on, state }  (insert effects)
//   patterns  Y.Array  of Y.Map { id, name, bars, steps: Y.Map, notes: Y.Map }
//               steps: "channelId:stepIndex" -> velocity (missing = off)
//               notes: noteId -> { ch, p, s, l, v }  (pitch, start step, length, velocity)
//   song      Y.Array  of pattern ids, played in order in Song mode
//
// Steps are keyed map entries rather than array slots so that two people
// toggling the same step at once can't shift or duplicate anything: the map
// simply keeps one of the two values.

import * as Y from 'yjs';

export const SCHEMA_VERSION = 1;
export const STEPS_PER_BAR = 16;
export const MIN_PITCH = 24; // C1
export const MAX_PITCH = 96; // C7

export const INSTRUMENTS = {
  kick: { label: 'Kick', kind: 'drum' },
  snare: { label: 'Snare', kind: 'drum' },
  clap: { label: 'Clap', kind: 'drum' },
  hat: { label: 'Hi-hat', kind: 'drum' },
  openhat: { label: 'Open hat', kind: 'drum' },
  perc: { label: 'Perc', kind: 'drum' },
  bass: { label: 'Bass', kind: 'synth', root: 36 },
  lead: { label: 'Lead', kind: 'synth', root: 60 },
  pluck: { label: 'Pluck', kind: 'synth', root: 60 },
  keys: { label: 'Keys', kind: 'synth', root: 60 },
  pad: { label: 'Pad', kind: 'synth', root: 48 },
  // Uploaded audio: one-shots on the step grid, or pitched in the piano roll.
  sample: { label: 'Sample (steps)', kind: 'drum', needs: 'sample' },
  samplekeys: { label: 'Sample (keys)', kind: 'synth', root: 60, needs: 'sample' },
  // A Web Audio Module plugin instrument, played from the piano roll.
  wam: { label: 'Plugin', kind: 'synth', root: 60, needs: 'plugin' },
};

/** Instruments that need nothing but the browser. */
export const BUILT_IN = Object.keys(INSTRUMENTS).filter((k) => !INSTRUMENTS[k].needs);

export const MAX_PLUGIN_STATE = 100_000; // bytes of JSON per plugin

/** Plugin URLs must be same-origin paths or http(s) URLs. */
export function cleanPluginUrl(url) {
  const u = String(url ?? '').trim();
  // Same-site path. "//x" and "/\x" would resolve to another website.
  if (/^\/[^/\\]/.test(u)) return u;
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch {
    return null;
  }
}

/** JSON-safe copy of a plugin state, or undefined if it's too big to share. */
function cleanState(state) {
  if (state === undefined || state === null) return undefined;
  const json = JSON.stringify(state);
  if (json === undefined || json.length > MAX_PLUGIN_STATE) return undefined;
  return JSON.parse(json);
}

export const COLORS = ['#ff8a3d', '#ffd23f', '#5ce1a3', '#3ad5ff', '#8f7bff', '#ff5fa2', '#ff6b6b', '#b8f35d'];

export const isSynth = (inst) => INSTRUMENTS[inst]?.kind === 'synth';

export function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}

const meta = (doc) => doc.getMap('meta');
const channels = (doc) => doc.getArray('channels');
const patterns = (doc) => doc.getArray('patterns');
const song = (doc) => doc.getArray('song');

function findIndex(yarray, id) {
  const arr = yarray.toArray();
  for (let i = 0; i < arr.length; i++) if (arr[i].get('id') === id) return i;
  return -1;
}

const findChannel = (doc, id) => channels(doc).toArray().find((c) => c.get('id') === id);
const findPattern = (doc, id) => patterns(doc).toArray().find((p) => p.get('id') === id);

// ------------------------------------------------------------------ channels

function makeChannel(inst, name, color, extra = {}) {
  const c = new Y.Map();
  c.set('id', newId());
  c.set('name', name ?? INSTRUMENTS[inst]?.label ?? inst);
  c.set('inst', inst);
  c.set('vol', 0.8);
  c.set('pan', 0);
  c.set('mute', false);
  c.set('color', color);
  c.set('fx', new Y.Map());
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) c.set(k, v);
  return c;
}

const nextColor = (doc) => COLORS[channels(doc).length % COLORS.length];

export function addChannel(doc, inst) {
  if (!BUILT_IN.includes(inst)) throw new Error(`unknown instrument ${inst}`);
  const c = makeChannel(inst, undefined, nextColor(doc));
  channels(doc).push([c]);
  return c.get('id');
}

const cleanSample = (s) => ({ id: String(s.id), name: String(s.name ?? 'Sample').slice(0, 64) });

/** A channel playing an uploaded sample (`sample` = { id, name } from the server). */
export function addSampleChannel(doc, sample, { keys = false } = {}) {
  const smp = cleanSample(sample);
  const name = smp.name.replace(/\.[a-z0-9]{2,4}$/i, '').slice(0, 32) || 'Sample';
  const c = makeChannel(keys ? 'samplekeys' : 'sample', name, nextColor(doc), { sample: smp });
  channels(doc).push([c]);
  return c.get('id');
}

export function setChannelSample(doc, id, sample) {
  const c = findChannel(doc, id);
  if (!c) return;
  doc.transact(() => {
    c.set('sample', cleanSample(sample));
    if (!INSTRUMENTS[c.get('inst')].needs) c.set('inst', 'sample');
  });
}

/** A channel driven by a Web Audio Module instrument plugin. */
export function addPluginChannel(doc, plugin) {
  const url = cleanPluginUrl(plugin.url);
  if (!url) throw new Error('bad plugin url');
  const name = String(plugin.name ?? 'Plugin').slice(0, 32);
  const c = makeChannel('wam', name, nextColor(doc), { plugin: { url, name } });
  channels(doc).push([c]);
  return c.get('id');
}

export function setPluginState(doc, channelId, state) {
  const c = findChannel(doc, channelId);
  const clean = cleanState(state);
  if (c && clean !== undefined) c.set('pluginState', clean);
}

// ------------------------------------------------------------------ effects

export function addEffect(doc, channelId, plugin) {
  const c = findChannel(doc, channelId);
  const url = cleanPluginUrl(plugin.url);
  if (!c || !url) return null;
  if (!c.get('fx')) c.set('fx', new Y.Map()); // channels from before effects existed
  const fx = c.get('fx');
  const order = Math.max(0, ...[...fx.values()].map((f) => f.order)) + 1;
  const id = newId();
  fx.set(id, { url, name: String(plugin.name ?? 'Effect').slice(0, 32), order, on: true });
  return id;
}

export function setEffect(doc, channelId, fxId, patch) {
  const fx = findChannel(doc, channelId)?.get('fx');
  const cur = fx?.get(fxId);
  if (!cur) return;
  const next = { ...cur };
  if ('on' in patch) next.on = !!patch.on;
  if ('state' in patch) {
    const clean = cleanState(patch.state);
    if (clean === undefined) return;
    next.state = clean;
  }
  fx.set(fxId, next);
}

export function removeEffect(doc, channelId, fxId) {
  findChannel(doc, channelId)?.get('fx')?.delete(fxId);
}

export function setChannel(doc, id, patch) {
  const c = findChannel(doc, id);
  if (!c) return;
  doc.transact(() => {
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'vol') c.set(k, Math.min(1, Math.max(0, +v)));
      else if (k === 'pan') c.set(k, Math.min(1, Math.max(-1, +v)));
      else if (k === 'mute') c.set(k, !!v);
      else if (k === 'name') c.set(k, String(v).slice(0, 32));
      else if (k === 'inst' && INSTRUMENTS[v]) {
        // Sample and plugin instruments only make sense with their data attached.
        const needs = INSTRUMENTS[v].needs;
        if (!needs || c.get(needs)) c.set(k, v);
      }
    }
  });
}

export function removeChannel(doc, id) {
  doc.transact(() => {
    const i = findIndex(channels(doc), id);
    if (i >= 0) channels(doc).delete(i, 1);
    for (const p of patterns(doc)) {
      const steps = p.get('steps');
      for (const key of [...steps.keys()]) if (key.startsWith(`${id}:`)) steps.delete(key);
      const notes = p.get('notes');
      for (const [nid, n] of [...notes.entries()]) if (n.ch === id) notes.delete(nid);
    }
  });
}

// ------------------------------------------------------------------ steps

export function setStep(doc, patternId, channelId, step, velocity) {
  const p = findPattern(doc, patternId);
  if (!p) return;
  const key = `${channelId}:${step}`;
  if (velocity) p.get('steps').set(key, velocity);
  else p.get('steps').delete(key);
}

export function toggleStep(doc, patternId, channelId, step) {
  const p = findPattern(doc, patternId);
  if (!p) return false;
  const on = !p.get('steps').has(`${channelId}:${step}`);
  setStep(doc, patternId, channelId, step, on ? 100 : 0);
  return on;
}

// ------------------------------------------------------------------ notes

const cleanNote = (n, maxStep) => {
  const s = Math.max(0, Math.min(maxStep - 1, Math.round(n.s)));
  return {
    ch: String(n.ch),
    p: Math.max(MIN_PITCH, Math.min(MAX_PITCH, Math.round(n.p))),
    s,
    l: Math.max(1, Math.min(maxStep - s, Math.round(n.l ?? 1))),
    v: Math.max(1, Math.min(127, Math.round(n.v ?? 100))),
  };
};

export function addNote(doc, patternId, note) {
  const p = findPattern(doc, patternId);
  if (!p) return null;
  const id = newId();
  p.get('notes').set(id, cleanNote(note, p.get('bars') * STEPS_PER_BAR));
  return id;
}

export function updateNote(doc, patternId, noteId, patch) {
  const p = findPattern(doc, patternId);
  const cur = p?.get('notes').get(noteId);
  if (!cur) return;
  p.get('notes').set(noteId, cleanNote({ ...cur, ...patch }, p.get('bars') * STEPS_PER_BAR));
}

export function removeNote(doc, patternId, noteId) {
  findPattern(doc, patternId)?.get('notes').delete(noteId);
}

// ------------------------------------------------------------------ patterns

function makePattern(name, bars = 1) {
  const p = new Y.Map();
  p.set('id', newId());
  p.set('name', name);
  p.set('bars', bars);
  p.set('steps', new Y.Map());
  p.set('notes', new Y.Map());
  return p;
}

function nextPatternName(doc) {
  const used = new Set(patterns(doc).toArray().map((p) => p.get('name')));
  for (let i = 1; ; i++) if (!used.has(`Pattern ${i}`)) return `Pattern ${i}`;
}

export function addPattern(doc) {
  const p = makePattern(nextPatternName(doc));
  patterns(doc).push([p]);
  return p.get('id');
}

export function clonePattern(doc, id) {
  const src = findPattern(doc, id);
  if (!src) return null;
  const p = makePattern(nextPatternName(doc), src.get('bars'));
  doc.transact(() => {
    // Nested Y types can only be read back once they're in the document.
    patterns(doc).insert(findIndex(patterns(doc), id) + 1, [p]);
    for (const [k, v] of src.get('steps').entries()) p.get('steps').set(k, v);
    for (const n of src.get('notes').values()) p.get('notes').set(newId(), { ...n });
  });
  return p.get('id');
}

export function removePattern(doc, id) {
  if (patterns(doc).length <= 1) return false;
  doc.transact(() => {
    const i = findIndex(patterns(doc), id);
    if (i >= 0) patterns(doc).delete(i, 1);
    const s = song(doc);
    for (let j = s.length - 1; j >= 0; j--) if (s.get(j) === id) s.delete(j, 1);
  });
  return true;
}

export function setPattern(doc, id, patch) {
  const p = findPattern(doc, id);
  if (!p) return;
  doc.transact(() => {
    if (typeof patch.name === 'string') p.set('name', patch.name.slice(0, 32) || p.get('name'));
    if ([1, 2, 4].includes(patch.bars)) {
      p.set('bars', patch.bars);
      // Drop anything that no longer fits.
      const max = patch.bars * STEPS_PER_BAR;
      for (const key of [...p.get('steps').keys()]) if (+key.split(':')[1] >= max) p.get('steps').delete(key);
      for (const [nid, n] of [...p.get('notes').entries()]) {
        if (n.s >= max) p.get('notes').delete(nid);
        else if (n.s + n.l > max) p.get('notes').set(nid, { ...n, l: max - n.s });
      }
    }
  });
}

// ------------------------------------------------------------------ song + meta

export function songAppend(doc, patternId) {
  if (findPattern(doc, patternId)) song(doc).push([patternId]);
}

export function songRemove(doc, index) {
  if (index >= 0 && index < song(doc).length) song(doc).delete(index, 1);
}

export function setMeta(doc, patch) {
  doc.transact(() => {
    if ('bpm' in patch) meta(doc).set('bpm', Math.min(300, Math.max(40, Math.round(+patch.bpm) || 120)));
    if (typeof patch.title === 'string') meta(doc).set('title', patch.title.slice(0, 60));
  });
}

// ------------------------------------------------------------------ seed + read

/** Fill a brand-new room with a small starter beat. No-op if already set up. */
export function seedProject(doc) {
  if (meta(doc).get('version')) return false;
  doc.transact(() => {
    meta(doc).set('version', SCHEMA_VERSION);
    meta(doc).set('title', 'Untitled jam');
    meta(doc).set('bpm', 124);
    const kick = makeChannel('kick', 'Kick', COLORS[0]);
    const clap = makeChannel('clap', 'Clap', COLORS[1]);
    const hat = makeChannel('hat', 'Hi-hat', COLORS[2]);
    const openhat = makeChannel('openhat', 'Open hat', COLORS[3]);
    const bass = makeChannel('bass', 'Bass', COLORS[4]);
    const keys = makeChannel('keys', 'Keys', COLORS[5]);
    channels(doc).push([kick, clap, hat, openhat, bass, keys]);

    const p = makePattern('Pattern 1', 1);
    patterns(doc).push([p]);
    const steps = p.get('steps');
    const id = (c) => c.get('id');
    for (const i of [0, 4, 8, 12]) steps.set(`${id(kick)}:${i}`, 110);
    for (const i of [4, 12]) steps.set(`${id(clap)}:${i}`, 100);
    for (const i of [2, 6, 10, 14]) steps.set(`${id(hat)}:${i}`, 90);
    steps.set(`${id(openhat)}:14`, 70);
    const notes = p.get('notes');
    // A two-chord bass line in A minor.
    for (const [s, l, pitch] of [
      [0, 2, 33],
      [3, 1, 33],
      [6, 2, 45],
      [8, 2, 29],
      [11, 1, 29],
      [14, 2, 41],
    ])
      notes.set(newId(), { ch: id(bass), p: pitch, s, l, v: 100 });
    song(doc).push([p.get('id')]);
  });
  return true;
}

/** Plain-object snapshot for rendering and playback. */
export function readProject(doc) {
  return {
    title: meta(doc).get('title') ?? 'Untitled',
    bpm: meta(doc).get('bpm') ?? 120,
    channels: channels(doc)
      .toArray()
      .map((c) => {
        const json = c.toJSON();
        const fx = Object.entries(json.fx ?? {})
          .map(([id, f]) => ({ id, ...f }))
          .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
        return { ...json, fx };
      }),
    patterns: patterns(doc)
      .toArray()
      .map((p) => ({
        id: p.get('id'),
        name: p.get('name'),
        bars: p.get('bars'),
        steps: new Map(p.get('steps').entries()),
        notes: [...p.get('notes').entries()].map(([id, n]) => ({ id, ...n })),
      })),
    song: song(doc).toArray(),
  };
}

/** The Y types an UndoManager should watch. */
export const undoScope = (doc) => [meta(doc), channels(doc), patterns(doc), song(doc)];
