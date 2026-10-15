// The shared project document and every edit that can be made to it.
// Used by the browser (edits) and the server (seeding new rooms).
//
// Layout of the Y.Doc:
//   meta      Y.Map    { version, title, bpm }
//   channels  Y.Array  of Y.Map { id, name, inst, vol, pan, mute, color,
//                                  sample?, plugin?, pluginState?, fx: Y.Map }
//               sample:  { id: sha256 of the uploaded file, name }
//               plugin:  { url, name } of a Web Audio Module instrument
//               pstate:  Y.Map, the plugin's state, one entry per top-level key
//               fx:      fxId -> { url, name, order, on }  (insert effects)
//               fxstate: Y.Map, "fxId/key" -> each effect's state, per key
//
// Plugin state is stored per top-level key so that turning one knob only
// sends that part (e.g. a synth's `params`), not its whole state, which can
// include large things like custom wavetables.
//   patterns  Y.Array  of Y.Map { id, name, bars, steps: Y.Map, notes: Y.Map }
//               steps: "channelId:stepIndex" -> velocity (missing = off)
//               notes: noteId -> { ch, p, s, l, v, ly?, ph?, pb? }
//                        pitch, start and length in steps (to 1/24 of a step),
//                        velocity, lyric, phonemes, and a pitch slide
//                        pb: [[x 0..1 along the note, semitones], ...]
//               auto:    laneId -> { ch, target, label }   automation lanes
//               autoPts: "laneId/pointId" -> { s, v }     their points (step, 0..1)
//   clips     Y.Map    clipId -> { p, t, s, l? }  the arrangement (Song mode):
//               pattern id, track, start step, length in steps (default:
//               the pattern's length; longer loops the pattern)
//   song      Y.Array  of pattern ids: the old left-to-right song, converted
//               to clips the first time anyone edits the arrangement
//
// Steps are keyed map entries rather than array slots so that two people
// toggling the same step at once can't shift or duplicate anything: the map
// simply keeps one of the two values.

import * as Y from 'yjs';

export const SCHEMA_VERSION = 1;
export const STEPS_PER_BAR = 16;
export const MIN_PITCH = 24; // C1
export const MAX_PITCH = 96; // C7
export const MAX_BARS = 64; // per pattern
export const TICKS = 24; // note positions are kept to 1/24 of a step (96 per beat, like FL Studio's default)
export const SLIDE_RANGE = 24; // a note's pitch slide reaches ± this many semitones
export const MAX_TRACKS = 32; // arrangement tracks
export const MAX_SONG_STEPS = 999 * STEPS_PER_BAR;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
/** Round a position or length (in steps) to the note grid. */
export const tick = (x) => Math.round(x * TICKS) / TICKS;

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

export const MAX_PLUGIN_STATE = 256_000; // bytes of JSON per top-level state key

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

/** JSON-safe copy of a value, or undefined if it's too big to share. */
function cleanState(state) {
  if (state === undefined) return undefined;
  const json = JSON.stringify(state);
  if (json === undefined || json.length > MAX_PLUGIN_STATE) return undefined;
  return JSON.parse(json);
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Write `state` into Y.Map `map`, key by key, touching only keys whose value
 * changed. `prefix` namespaces keys when several states share one map.
 */
function writeState(map, state, prefix = '') {
  for (const [k, v] of Object.entries(state)) {
    const clean = cleanState(v);
    if (clean === undefined) continue; // too big: keep the old value
    const key = prefix + k;
    if (JSON.stringify(map.get(key)) !== JSON.stringify(clean)) map.set(key, clean);
  }
  for (const key of [...map.keys()]) {
    if (key.startsWith(prefix) && !Object.hasOwn(state, key.slice(prefix.length))) map.delete(key);
  }
}

/** Get (creating if needed) a nested Y.Map field on a Y.Map. */
function childMap(parent, field) {
  if (!(parent.get(field) instanceof Y.Map)) parent.set(field, new Y.Map());
  return parent.get(field);
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
const clips = (doc) => doc.getMap('clips');

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
  if (!c) return;
  doc.transact(() => {
    if (isPlainObject(state)) {
      writeState(childMap(c, 'pstate'), state);
      if (c.has('pluginState')) c.delete('pluginState');
    } else {
      const clean = cleanState(state);
      if (clean !== undefined) c.set('pluginState', clean);
    }
  });
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
  const c = findChannel(doc, channelId);
  const fx = c?.get('fx');
  const cur = fx?.get(fxId);
  if (!cur) return;
  doc.transact(() => {
    if ('on' in patch && !!patch.on !== cur.on) fx.set(fxId, { ...cur, on: !!patch.on });
    if ('state' in patch) {
      if (isPlainObject(patch.state)) writeState(childMap(c, 'fxstate'), patch.state, `${fxId}/`);
      else {
        const clean = cleanState(patch.state);
        if (clean !== undefined) fx.set(fxId, { ...fx.get(fxId), state: clean });
      }
    }
  });
}

export function removeEffect(doc, channelId, fxId) {
  const c = findChannel(doc, channelId);
  if (!c) return;
  doc.transact(() => {
    c.get('fx')?.delete(fxId);
    const fs = c.get('fxstate');
    if (fs) for (const key of [...fs.keys()]) if (key.startsWith(`${fxId}/`)) fs.delete(key);
  });
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
      const auto = p.get('auto');
      if (auto) for (const [lid, lane] of [...auto.entries()]) if (lane.ch === id) removeLaneIn(p, lid);
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

// A note can carry a lyric for singing plugins: `ly`, the syllable shown on the
// note, and optionally `ph`, its phonemes (ARPAbet, e.g. "l ah v").
const LYRIC_MAX = 32;
const PHONEMES_RE = /^[a-z]{1,2}( [a-z]{1,2}){0,23}$/;

export function cleanLyric(ly) {
  return typeof ly === 'string'
    ? ly
        .normalize('NFC')
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, LYRIC_MAX)
    : '';
}

export function cleanPhonemes(ph) {
  const s = typeof ph === 'string' ? ph.trim().toLowerCase().replace(/\s+/g, ' ') : '';
  return PHONEMES_RE.test(s) ? s : '';
}

/**
 * A note's pitch slide: points [x (0..1 along the note), semitones], sorted,
 * at most 64; null when it doesn't bend at all.
 */
export function cleanSlide(pb) {
  if (!Array.isArray(pb)) return null;
  const pts = pb
    .filter((pt) => Array.isArray(pt) && Number.isFinite(+pt[0]) && Number.isFinite(+pt[1]))
    .map(([x, v]) => [Math.round(clamp(+x, 0, 1) * 1000) / 1000, Math.round(clamp(+v, -SLIDE_RANGE, SLIDE_RANGE) * 100) / 100])
    .sort((a, b) => a[0] - b[0])
    .slice(0, 64);
  return pts.length && pts.some((p) => p[1] !== 0) ? pts : null;
}

/** Semitones a slide adds at x (0..1 along the note): linear between points, held at the ends. */
export function slideAt(pb, x) {
  if (!pb?.length) return 0;
  if (x <= pb[0][0]) return pb[0][1];
  for (let i = 1; i < pb.length; i++) {
    const [x1, v1] = pb[i];
    if (x <= x1) {
      const [x0, v0] = pb[i - 1];
      return x1 > x0 ? v0 + ((v1 - v0) * (x - x0)) / (x1 - x0) : v1;
    }
  }
  return pb.at(-1)[1];
}

const cleanNote = (n, maxStep) => {
  const s = clamp(tick(+n.s || 0), 0, maxStep - 1 / TICKS);
  const out = {
    ch: String(n.ch),
    p: clamp(Math.round(n.p), MIN_PITCH, MAX_PITCH),
    s,
    l: clamp(tick(n.l ?? 1), 1 / TICKS, maxStep - s),
    v: clamp(Math.round(n.v ?? 100), 1, 127),
  };
  const ly = cleanLyric(n.ly);
  if (ly) {
    out.ly = ly;
    const ph = cleanPhonemes(n.ph);
    if (ph) out.ph = ph;
  }
  const pb = cleanSlide(n.pb);
  if (pb) out.pb = pb;
  return out;
};

/** Make a pattern at least long enough to hold `end` steps (whole bars, up to MAX_BARS). */
function growTo(p, end) {
  const bars = Math.min(MAX_BARS, Math.ceil(end / STEPS_PER_BAR - 1e-9));
  if (bars > p.get('bars')) p.set('bars', bars);
}

const maxStepOf = (p) => p.get('bars') * STEPS_PER_BAR;

/** Add a note; writing past the end of the pattern makes it longer. */
export function addNote(doc, patternId, note) {
  return addNotes(doc, patternId, [note])[0] ?? null;
}

/** Add several notes at once (one undo step). Returns their ids. */
export function addNotes(doc, patternId, notes) {
  const p = findPattern(doc, patternId);
  if (!p) return [];
  const ids = [];
  doc.transact(() => {
    growTo(p, Math.max(0, ...notes.map((n) => tick(+n.s || 0) + tick(n.l ?? 1))));
    for (const n of notes) {
      const id = newId();
      p.get('notes').set(id, cleanNote(n, maxStepOf(p)));
      ids.push(id);
    }
  });
  return ids;
}

export function updateNote(doc, patternId, noteId, patch) {
  updateNotes(doc, patternId, [{ id: noteId, ...patch }]);
}

/** Change several notes at once: [{ id, ...fields }] (one undo step). */
export function updateNotes(doc, patternId, patches) {
  const p = findPattern(doc, patternId);
  if (!p) return;
  const notes = p.get('notes');
  doc.transact(() => {
    const next = patches.map(({ id, ...patch }) => notes.get(id) && { id, n: { ...notes.get(id), ...patch } }).filter(Boolean);
    growTo(p, Math.max(0, ...next.map(({ n }) => tick(+n.s || 0) + tick(n.l ?? 1))));
    for (const { id, n } of next) notes.set(id, cleanNote(n, maxStepOf(p)));
  });
}

export function removeNote(doc, patternId, noteId) {
  removeNotes(doc, patternId, [noteId]);
}

export function removeNotes(doc, patternId, ids) {
  const notes = findPattern(doc, patternId)?.get('notes');
  if (notes) doc.transact(() => ids.forEach((id) => notes.delete(id)));
}

/** Set (or with '' clear) one note's lyric; phonemes are dropped unless given. */
export function setLyric(doc, patternId, noteId, ly, ph = '') {
  updateNote(doc, patternId, noteId, { ly, ph });
}

/**
 * Put syllables ([{ ly, ph }]) on a channel's notes in a pattern, one per note
 * in time order (highest note first in a chord). With more syllables than
 * notes, `fill: 'split'` divides notes, and either way notes are added after
 * the last one (2 steps each), growing the pattern (up to MAX_BARS). Notes
 * left over lose their lyric.
 * Returns { assigned, split, added, dropped, cleared }.
 */
export function assignLyrics(doc, patternId, channelId, syllables, { fill = 'split' } = {}) {
  const p = findPattern(doc, patternId);
  const result = { assigned: 0, split: 0, added: 0, dropped: 0, cleared: 0 };
  if (!p) return result;
  const want = syllables.map((x) => ({ ly: cleanLyric(x.ly), ph: cleanPhonemes(x.ph) })).filter((x) => x.ly);
  doc.transact(() => {
    const notes = p.get('notes');
    const mine = () =>
      [...notes.entries()]
        .filter(([, n]) => n.ch === channelId)
        .map(([id, n]) => ({ id, ...n }))
        .sort((a, b) => a.s - b.s || b.p - a.p);
    let list = mine();
    if (fill === 'split' && list.length && list.length < want.length) {
      // Each note gets a share of the syllables in proportion to its length
      // (at most one per step), then is cut into that many equal parts.
      // Notes are cut in whole steps where possible, else in ticks.
      const unit = (n) => (Number.isInteger(n.l) ? 1 : 1 / TICKS);
      const units = (n) => Math.round(n.l / unit(n));
      const total = list.reduce((a, n) => a + n.l, 0);
      const ideal = list.map((n) => (n.l / total) * want.length);
      const parts = list.map((n, i) => Math.max(1, Math.min(units(n), Math.floor(ideal[i]))));
      for (let have = parts.reduce((a, b) => a + b, 0); have < want.length; have++) {
        let best = -1;
        list.forEach((n, i) => {
          if (parts[i] < units(n) && (best < 0 || ideal[i] - parts[i] > ideal[best] - parts[best])) best = i;
        });
        if (best < 0) break;
        parts[best]++;
      }
      const max = p.get('bars') * STEPS_PER_BAR;
      list.forEach((n, i) => {
        if (parts[i] < 2) return;
        const { id, ...rest } = n;
        const u = units(n);
        const base = Math.floor(u / parts[i]);
        let s = n.s;
        for (let k = 0; k < parts[i]; k++) {
          const l = (base + (k < u % parts[i] ? 1 : 0)) * unit(n);
          notes.set(k === 0 ? id : newId(), cleanNote({ ...rest, s, l, pb: null }, max));
          s += l;
        }
        result.split++;
      });
      list = mine();
    }
    if (list.length < want.length) {
      const last = list.reduce((a, n) => (n.s + n.l > a.s + a.l ? n : a), list[0] ?? { s: 0, l: 0, p: 60 });
      let s = last.s + last.l;
      growTo(p, s + 2 * (want.length - list.length));
      const max = p.get('bars') * STEPS_PER_BAR;
      while (list.length + result.added < want.length && s + 1 <= max) {
        notes.set(newId(), cleanNote({ ch: channelId, p: last.p, s, l: Math.min(2, max - s), v: 100 }, max));
        result.added++;
        s += 2;
      }
      list = mine();
    }
    const max = p.get('bars') * STEPS_PER_BAR;
    list.forEach((n, i) => {
      const { ly: _ly, ph: _ph, id, ...rest } = n;
      if (i < want.length) {
        notes.set(id, cleanNote({ ...rest, ...want[i] }, max));
        result.assigned++;
      } else if (_ly) {
        notes.set(id, cleanNote(rest, max));
        result.cleared++;
      }
    });
    result.dropped = Math.max(0, want.length - result.assigned);
  });
  return result;
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
    if (src.get('auto')?.size) {
      const lanes = childMap(p, 'auto');
      const pts = childMap(p, 'autoPts');
      for (const [k, v] of src.get('auto').entries()) lanes.set(k, { ...v });
      for (const [k, v] of src.get('autoPts').entries()) pts.set(k, { ...v });
    }
  });
  return p.get('id');
}

export function removePattern(doc, id) {
  if (patterns(doc).length <= 1) return false;
  doc.transact(() => {
    migrateSong(doc);
    const i = findIndex(patterns(doc), id);
    if (i >= 0) patterns(doc).delete(i, 1);
    for (const [cid, c] of [...clips(doc).entries()]) if (c.p === id) clips(doc).delete(cid);
  });
  return true;
}

export function setPattern(doc, id, patch) {
  const p = findPattern(doc, id);
  if (!p) return;
  doc.transact(() => {
    if (typeof patch.name === 'string') p.set('name', patch.name.slice(0, 32) || p.get('name'));
    if (Number.isInteger(patch.bars) && patch.bars >= 1 && patch.bars <= MAX_BARS) {
      p.set('bars', patch.bars);
      // Drop anything that no longer fits.
      const max = patch.bars * STEPS_PER_BAR;
      for (const key of [...p.get('steps').keys()]) if (+key.split(':')[1] >= max) p.get('steps').delete(key);
      for (const [nid, n] of [...p.get('notes').entries()]) {
        if (n.s >= max) p.get('notes').delete(nid);
        else if (n.s + n.l > max) p.get('notes').set(nid, { ...n, l: max - n.s });
      }
      const pts = p.get('autoPts');
      if (pts) for (const [k, pt] of [...pts.entries()]) if (pt.s > max) pts.set(k, { ...pt, s: max });
    }
  });
}

// ------------------------------------------------------------------ automation

/**
 * Automation targets: 'vol' and 'pan' (the channel's mixer), 'bend' (pitch
 * bend, 0.5 = none; `range` semitones for built-in sounds), 'p:<paramId>'
 * (a parameter of the channel's plugin instrument), or 'fx:<fxId>:<paramId>'
 * (a parameter of one of its plugin effects). Values are normalized 0..1.
 */
const TARGET = /^(vol|pan|bend|p:[\w.-]{1,64}|fx:\w{1,16}:[\w.-]{1,64})$/;
export const BEND_RANGES = [1, 2, 3, 5, 7, 12, 24];

export function addLane(doc, patternId, channelId, target, label) {
  const p = findPattern(doc, patternId);
  if (!p || !TARGET.test(target)) return null;
  let id = null;
  doc.transact(() => {
    const lanes = childMap(p, 'auto');
    childMap(p, 'autoPts');
    for (const [k, l] of lanes.entries()) if (l.ch === channelId && l.target === target) id = k;
    if (id) return;
    id = newId();
    const lane = { ch: String(channelId), target, label: String(label ?? target).slice(0, 48) };
    if (target === 'bend') lane.range = 2;
    lanes.set(id, lane);
  });
  return id;
}

/** Change a lane's settings (currently: a bend lane's range in semitones). */
export function setLane(doc, patternId, laneId, patch) {
  const lanes = findPattern(doc, patternId)?.get('auto');
  const lane = lanes?.get(laneId);
  if (!lane) return;
  if (lane.target === 'bend' && BEND_RANGES.includes(patch.range)) lanes.set(laneId, { ...lane, range: patch.range });
}

function removeLaneIn(p, laneId) {
  p.get('auto')?.delete(laneId);
  const pts = p.get('autoPts');
  if (pts) for (const k of [...pts.keys()]) if (k.startsWith(`${laneId}/`)) pts.delete(k);
}

export function removeLane(doc, patternId, laneId) {
  const p = findPattern(doc, patternId);
  if (p) doc.transact(() => removeLaneIn(p, laneId));
}

/** Add (pointId omitted) or move a point. `s` is in steps, `v` 0..1. */
export function setPoint(doc, patternId, laneId, pointId, { s, v }) {
  const p = findPattern(doc, patternId);
  if (!p?.get('auto')?.has(laneId)) return null;
  const max = p.get('bars') * STEPS_PER_BAR;
  const id = pointId ?? newId();
  const pts = childMap(p, 'autoPts');
  const key = `${laneId}/${id}`;
  pts.set(key, {
    ...pts.get(key), // keep the point's curve settings when it moves
    s: Math.round(Math.max(0, Math.min(max, +s || 0)) * 1000) / 1000,
    v: Math.round(Math.max(0, Math.min(1, +v || 0)) * 1000) / 1000,
  });
  return id;
}

/**
 * Curve shapes for the segment that starts at a point, like FL Studio's
 * automation clips. `t` (-1..1, "amount") bends the curve, or for the
 * repeating shapes sets how many steps/cycles fit in the segment.
 */
export const CURVES = {
  single: { label: 'Single curve', amount: 'Tension' },
  double: { label: 'Double curve', amount: 'Tension' },
  hold: { label: 'Hold', amount: null },
  stairs: { label: 'Stairs', amount: 'Steps' },
  smooth: { label: 'Smooth stairs', amount: 'Steps' },
  pulse: { label: 'Pulse', amount: 'Cycles' },
  wave: { label: 'Wave', amount: 'Cycles' },
};
/** Steps or cycles for the repeating shapes: 2..32, 4 at amount 0. */
export const curveCount = (t) => Math.max(1, Math.round(2 ** (2 + 3 * t)));

/** Progress from the segment's start value (0) to its end value (1) at x (0..1). */
export function curveShape(c, t = 0, x) {
  t = Math.max(-1, Math.min(1, +t || 0));
  x = Math.max(0, Math.min(1, x));
  const pw = 1 + 7 * Math.abs(t);
  switch (c) {
    case 'double':
      // S-curve (t > 0: slow-fast-slow), or its inverse (t < 0)
      if (t >= 0) return x < 0.5 ? 0.5 * (2 * x) ** pw : 1 - 0.5 * (2 - 2 * x) ** pw;
      return x < 0.5 ? 0.5 * (1 - (1 - 2 * x) ** pw) : 0.5 + 0.5 * (2 * x - 1) ** pw;
    case 'hold':
      return x < 1 ? 0 : 1;
    case 'stairs': {
      const n = Math.max(2, curveCount(t));
      return Math.min(1, Math.floor(x * n) / (n - 1));
    }
    case 'smooth': {
      // stairs with rounded corners: hold each level, then ease into the next
      const n = Math.max(2, curveCount(t));
      const k = Math.min(n - 1, Math.floor(x * n));
      const f = x * n - k;
      if (k === n - 1 || f < 0.6) return k / (n - 1);
      const e = (f - 0.6) / 0.4;
      return (k + e * e * (3 - 2 * e)) / (n - 1);
    }
    case 'pulse':
      return Math.floor(x * curveCount(t) * 2) % 2 === 0 ? 0 : 1;
    case 'wave':
      return 0.5 - 0.5 * Math.cos(2 * Math.PI * curveCount(t) * x);
    default:
      // single curve: t > 0 eases in (starts slow), t < 0 eases out
      return t >= 0 ? x ** pw : 1 - (1 - x) ** pw;
  }
}

/** Shapes with sudden jumps: the engine steps to them instead of ramping. */
export const STEPPED_CURVES = new Set(['hold', 'stairs', 'pulse']);

/** Set the curve of the segment starting at a point. */
export function setCurve(doc, patternId, laneId, pointId, { c, t }) {
  const pts = findPattern(doc, patternId)?.get('autoPts');
  const key = `${laneId}/${pointId}`;
  const cur = pts?.get(key);
  if (!cur) return;
  const next = { ...cur };
  if (c !== undefined && Object.hasOwn(CURVES, c)) next.c = c;
  if (t !== undefined) next.t = Math.round(Math.max(-1, Math.min(1, +t || 0)) * 1000) / 1000;
  if (next.c === 'single' && !next.t) {
    delete next.c; // plain linear: store nothing
    delete next.t;
  }
  pts.set(key, next);
}

export function removePoint(doc, patternId, laneId, pointId) {
  removePoints(doc, patternId, laneId, [pointId]);
}

export function removePoints(doc, patternId, laneId, ids) {
  const pts = findPattern(doc, patternId)?.get('autoPts');
  if (pts) doc.transact(() => ids.forEach((id) => pts.delete(`${laneId}/${id}`)));
}

/** Move several points at once: [{ id, s, v }] (one undo step). */
export function updatePoints(doc, patternId, laneId, patches) {
  doc.transact(() => {
    for (const { id, s, v } of patches) setPoint(doc, patternId, laneId, id, { s, v });
  });
}

/**
 * Paste points ([{ s, v, c?, t? }]) into a lane, replacing the lane's points
 * between the first and last pasted one. Returns the new ids.
 */
export function pastePoints(doc, patternId, laneId, points) {
  const p = findPattern(doc, patternId);
  if (!p?.get('auto')?.has(laneId) || !points.length) return [];
  const ids = [];
  doc.transact(() => {
    const pts = childMap(p, 'autoPts');
    const lo = Math.min(...points.map((x) => x.s));
    const hi = Math.max(...points.map((x) => x.s));
    for (const [k, pt] of [...pts.entries()]) if (k.startsWith(`${laneId}/`) && pt.s >= lo && pt.s <= hi) pts.delete(k);
    for (const pt of points) {
      const id = setPoint(doc, patternId, laneId, null, pt);
      if (pt.c && pt.c !== 'single') setCurve(doc, patternId, laneId, id, { c: pt.c, t: pt.t ?? 0 });
      else if (pt.t) setCurve(doc, patternId, laneId, id, { t: pt.t });
      ids.push(id);
    }
  });
  return ids;
}

/** Index of the point whose segment contains `pos` (-1 before the first point). */
export function segmentAt(points, pos) {
  let i = -1;
  while (i + 1 < points.length && points[i + 1].s <= pos) i++;
  return i;
}

/**
 * Value of a lane at position `pos` (steps): each segment follows its curve
 * (linear unless set otherwise); held flat before the first and after the
 * last point.
 */
export function laneValueAt(points, pos) {
  if (!points.length) return null;
  if (pos <= points[0].s) return points[0].v;
  const i = segmentAt(points, pos);
  if (i >= points.length - 1) return points.at(-1).v;
  const a = points[i];
  const b = points[i + 1];
  if (b.s <= a.s) return b.v;
  return a.v + (b.v - a.v) * curveShape(a.c, a.t, (pos - a.s) / (b.s - a.s));
}

function readLanes(p) {
  const lanes = p.get('auto');
  if (!lanes?.size) return [];
  const byLane = new Map();
  for (const [k, pt] of p.get('autoPts')?.entries() ?? []) {
    const [lid, pid] = k.split('/');
    if (!byLane.has(lid)) byLane.set(lid, []);
    byLane.get(lid).push({ id: pid, s: pt.s, v: pt.v, c: pt.c ?? 'single', t: pt.t ?? 0 });
  }
  return [...lanes.entries()].map(([id, l]) => ({
    id,
    ...l,
    points: (byLane.get(id) ?? []).sort((a, b) => a.s - b.s || (a.id < b.id ? -1 : 1)),
  }));
}

// ------------------------------------------------------------------ arrangement

const patternSteps = (doc, id) => (findPattern(doc, id)?.get('bars') ?? 1) * STEPS_PER_BAR;

/**
 * Rooms from before the arrangement had a left-to-right `song` list. The
 * first arrangement edit turns it into clips on track 1. Ids are derived from
 * the position, so two people converting at once write the same clips.
 */
function migrateSong(doc) {
  const old = song(doc);
  if (!old.length) return;
  if (clips(doc).size === 0) {
    let s = 0;
    old.toArray().forEach((pid, i) => {
      if (!findPattern(doc, pid)) return;
      clips(doc).set(`song${i}`, { p: pid, t: 0, s });
      s += patternSteps(doc, pid);
    });
  }
  old.delete(0, old.length);
}

function cleanClip(doc, c) {
  if (!findPattern(doc, c.p)) return null;
  const out = {
    p: String(c.p),
    t: clamp(Math.round(+c.t || 0), 0, MAX_TRACKS - 1),
    s: clamp(Math.round(+c.s || 0), 0, MAX_SONG_STEPS - 1),
  };
  if (c.l != null && Number.isFinite(+c.l)) out.l = clamp(Math.round(+c.l), 1, MAX_SONG_STEPS - out.s);
  return out;
}

/** Place clips ({ p, t, s, l? }) in the arrangement. Returns their ids. */
export function addClips(doc, list) {
  const ids = [];
  doc.transact(() => {
    migrateSong(doc);
    for (const c of list) {
      const clean = cleanClip(doc, c);
      if (!clean) continue;
      const id = newId();
      clips(doc).set(id, clean);
      ids.push(id);
    }
  });
  return ids;
}

export function addClip(doc, clip) {
  return addClips(doc, [clip])[0] ?? null;
}

/** Move or resize clips: [{ id, t?, s?, l? }] (l: null = back to the pattern's length). */
export function updateClips(doc, patches) {
  doc.transact(() => {
    migrateSong(doc);
    for (const { id, ...patch } of patches) {
      const cur = clips(doc).get(id);
      if (!cur) continue;
      const next = { ...cur, ...patch };
      if (patch.l === null) delete next.l;
      const clean = cleanClip(doc, next);
      if (clean) clips(doc).set(id, clean);
    }
  });
}

export function removeClips(doc, ids) {
  doc.transact(() => {
    migrateSong(doc);
    for (const id of ids) clips(doc).delete(id);
  });
}

/** Add a pattern after the last clip on the first track. */
export function appendClip(doc, patternId) {
  migrateSong(doc);
  const end = Math.max(0, ...[...clips(doc).values()].filter((c) => c.t === 0).map((c) => c.s + (c.l ?? patternSteps(doc, c.p))));
  return addClip(doc, { p: patternId, t: 0, s: end });
}

/** A clip's length in steps (its own, or its pattern's). */
export function clipLength(clip, patternsById) {
  return clip.l ?? (patternsById.get(clip.p)?.bars ?? 1) * STEPS_PER_BAR;
}

/** Where the arrangement ends (steps), 0 if it's empty. */
export function songLength(project) {
  const byId = new Map(project.patterns.map((p) => [p.id, p]));
  return Math.max(0, ...project.clips.map((c) => c.s + clipLength(c, byId)));
}

/** Clips sounding at song step `step`, with the step inside each one's pattern. */
export function clipsAt(project, step) {
  const out = [];
  const byId = project.patternsById ?? new Map(project.patterns.map((p) => [p.id, p]));
  for (const c of project.clips) {
    const len = clipLength(c, byId);
    if (step < c.s || step >= c.s + len) continue;
    const pattern = byId.get(c.p);
    if (!pattern) continue;
    out.push({ clip: c, pattern, step: (step - c.s) % (pattern.bars * STEPS_PER_BAR) });
  }
  return out;
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
    clips(doc).set(newId(), { p: p.get('id'), t: 0, s: 0 });
  });
  return true;
}

/** The arrangement as stored, or (rooms not yet converted) the old song laid out on track 1. */
function readClips(doc) {
  if (clips(doc).size || !song(doc).length) return [...clips(doc).entries()].map(([id, c]) => ({ id, ...c }));
  const out = [];
  let s = 0;
  song(doc)
    .toArray()
    .forEach((pid, i) => {
      if (!findPattern(doc, pid)) return;
      out.push({ id: `song${i}`, p: pid, t: 0, s });
      s += patternSteps(doc, pid);
    });
  return out;
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
        const fxState = {};
        for (const [k, v] of Object.entries(json.fxstate ?? {})) {
          const cut = k.indexOf('/');
          (fxState[k.slice(0, cut)] ??= {})[k.slice(cut + 1)] = v;
        }
        const fx = Object.entries(json.fx ?? {})
          .map(([id, f]) => ({ id, ...f, state: fxState[id] ?? f.state }))
          .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
        const { pstate, fxstate, ...rest } = json;
        return { ...rest, pluginState: pstate ?? json.pluginState, fx };
      }),
    patterns: patterns(doc)
      .toArray()
      .map((p) => ({
        id: p.get('id'),
        name: p.get('name'),
        bars: p.get('bars'),
        steps: new Map(p.get('steps').entries()),
        notes: [...p.get('notes').entries()].map(([id, n]) => ({ id, ...n })),
        lanes: readLanes(p),
      })),
    clips: readClips(doc),
  };
}

/** The Y types an UndoManager should watch. */
export const undoScope = (doc) => [meta(doc), channels(doc), patterns(doc), song(doc), clips(doc)];
