// Factory presets. Written in real units and converted to Vertex's
// normalized state, so they read like a patch sheet.

import { PARAMS, INDEX } from './params.js';

/** Real values -> the normalized params object stored in state. */
function params(values) {
  const out = {};
  for (const [id, v] of Object.entries(values)) {
    const p = PARAMS[INDEX[id]];
    if (!p) throw new Error(`unknown param ${id}`);
    out[id] = p.unmap ? p.unmap(v) : v;
  }
  return out;
}

const saw = 2 / 3; // Basic Shapes: 0 sine, 1/3 triangle, 2/3 saw, 1 square
const tables = (a, b = a) => ({ a: { kind: 'builtin', name: a }, b: { kind: 'builtin', name: b } });
const route = (src, dst, amt, bi = false) => ({ src, dst, amt, bi });

export const PRESETS = [
  {
    name: 'Init',
    category: 'Init',
    tables: tables('Basic Shapes'),
    params: params({ a_pos: saw }),
    routes: [],
  },
  {
    name: 'Supersaw Lead',
    category: 'Lead',
    tables: tables('Basic Shapes'),
    params: params({
      a_pos: saw, a_unison: 7, a_detune: 0.35, a_blend: 0.8,
      b_on: true, b_pos: saw, b_oct: 1, b_unison: 5, b_detune: 0.25, b_level: 0.4,
      flt_type: 1, flt_cutoff: 6000, flt_res: 0.15,
      env1_a: 0.005, env1_d: 0.5, env1_s: 0.85, env1_r: 0.35,
      delay_on: true, delay_div: 12, delay_mix: 0.18, delay_fb: 0.35,
      reverb_on: true, reverb_mix: 0.2, reverb_size: 0.7,
    }),
    routes: [route('vel', 'flt_cutoff', 0.15)],
  },
  {
    name: 'Reese Bass',
    category: 'Bass',
    tables: tables('Basic Shapes'),
    params: params({
      poly: 1, legato: true, glide: 0.06,
      a_pos: saw, a_unison: 2, a_detune: 0.12, a_width: 0.2,
      b_on: true, b_pos: saw, b_unison: 2, b_detune: 0.22, b_fine: 7, b_level: 0.6, b_width: 0.2,
      sub_on: true, sub_level: 0.5,
      flt_type: 1, flt_cutoff: 520, flt_res: 0.2, flt_drive: 0.3,
      env1_r: 0.1,
      dist_on: true, dist_drive: 0.25, dist_mix: 0.6,
      comp_on: true, comp_mode: 1, comp_depth: 0.4,
    }),
    routes: [route('lfo1', 'a_detune', 0.08)],
    extra: params({ lfo1_sync: true, lfo1_div: 1, lfo1_mode: 1 }),
  },
  {
    name: 'Wobble Bass',
    category: 'Bass',
    tables: tables('Growl', 'Basic Shapes'),
    params: params({
      poly: 1, legato: true, glide: 0.04,
      a_pos: 0.3, a_unison: 3, a_detune: 0.1,
      sub_on: true, sub_level: 0.55,
      flt_type: 1, flt_cutoff: 250, flt_res: 0.45, flt_drive: 0.4,
      lfo1_sync: true, lfo1_div: 5, lfo1_shape: 0,
      dist_on: true, dist_drive: 0.35, dist_mix: 0.7,
      comp_on: true, comp_mode: 1, comp_depth: 0.6,
    }),
    routes: [route('lfo1', 'flt_cutoff', 0.55), route('lfo1', 'a_pos', 0.5)],
  },
  {
    name: 'Pluck',
    category: 'Pluck',
    tables: tables('Basic Shapes'),
    params: params({
      a_pos: saw, a_unison: 3, a_detune: 0.15,
      flt_type: 1, flt_cutoff: 300, flt_res: 0.25,
      env1_a: 0, env1_d: 0.6, env1_s: 0, env1_r: 0.3,
      env2_a: 0, env2_d: 0.25, env2_s: 0, env2_r: 0.2,
      delay_on: true, delay_div: 12, delay_mix: 0.25,
      reverb_on: true, reverb_mix: 0.25,
    }),
    routes: [route('env2', 'flt_cutoff', 0.55), route('vel', 'flt_cutoff', 0.15)],
  },
  {
    name: 'Warm Pad',
    category: 'Pad',
    tables: tables('Organ Bars', 'Basic Shapes'),
    params: params({
      a_pos: 0.4, a_unison: 5, a_detune: 0.2,
      b_on: true, b_pos: 1 / 3, b_unison: 3, b_level: 0.5, b_oct: -1,
      flt_type: 0, flt_cutoff: 2500, flt_res: 0.1,
      env1_a: 1.2, env1_d: 1, env1_s: 0.9, env1_r: 2,
      lfo1_sync: false, lfo1_rate: 0.15, lfo1_mode: 1,
      lfo2_sync: false, lfo2_rate: 0.3, lfo2_mode: 1, lfo2_shape: 1,
      chorus_on: true, chorus_mix: 0.5,
      reverb_on: true, reverb_mix: 0.4, reverb_size: 0.9,
    }),
    routes: [route('lfo1', 'a_pos', 0.4), route('lfo2', 'flt_cutoff', 0.1)],
  },
  {
    name: 'Vox Lead',
    category: 'Lead',
    tables: tables('Formant Vox'),
    params: params({
      poly: 1, legato: true, glide: 0.08,
      a_pos: 0.2, a_unison: 3, a_detune: 0.12,
      flt_type: 0, flt_cutoff: 5000,
      lfo1_sync: true, lfo1_div: 4, lfo1_shape: 1,
      delay_on: true, delay_div: 4, delay_mix: 0.2,
      reverb_on: true, reverb_mix: 0.2,
    }),
    routes: [route('lfo1', 'a_pos', 0.6), route('mod', 'a_pos', 0.3)],
  },
  {
    name: 'FM Keys',
    category: 'Keys',
    tables: tables('Digital FM', 'Basic Shapes'),
    params: params({
      a_pos: 0.05,
      b_on: true, b_pos: 0, b_level: 0.4,
      flt_on: false,
      env1_a: 0.002, env1_d: 1.5, env1_s: 0.3, env1_r: 0.5,
      env2_a: 0, env2_d: 0.6, env2_s: 0.1,
      chorus_on: true, chorus_mix: 0.35,
      reverb_on: true, reverb_mix: 0.2,
    }),
    routes: [route('env2', 'a_pos', 0.5), route('vel', 'a_pos', 0.3)],
  },
  {
    name: 'Sub Bass',
    category: 'Bass',
    tables: tables('Basic Shapes'),
    params: params({
      poly: 1, glide: 0.03,
      a_pos: 0, a_level: 0.85,
      flt_type: 1, flt_cutoff: 400,
      env1_r: 0.08,
      dist_on: true, dist_drive: 0.15, dist_mix: 0.4,
    }),
    routes: [],
  },
  {
    name: 'Hard Sync Lead',
    category: 'Lead',
    tables: tables('Basic Shapes'),
    params: params({
      a_pos: saw, a_warp: 1, a_warpamt: 0.3, a_unison: 2, a_detune: 0.1,
      flt_type: 0, flt_cutoff: 8000,
      env2_a: 0, env2_d: 0.5, env2_s: 0.2,
      dist_on: true, dist_type: 1, dist_drive: 0.2, dist_mix: 0.3,
      delay_on: true, delay_div: 12, delay_mix: 0.2,
    }),
    routes: [route('env2', 'a_warpamt', 0.5)],
  },
  {
    name: 'Riser FX',
    category: 'FX',
    tables: tables('Saw Sweep'),
    params: params({
      a_pos: 0,
      noise_on: true, noise_type: 1, noise_level: 0.5,
      flt_type: 0, flt_cutoff: 200,
      env1_a: 0.05, env1_r: 1.5,
      lfo1_sync: true, lfo1_div: 0, lfo1_mode: 2, lfo1_shape: 2,
      flanger_on: true, flanger_mix: 0.4,
      reverb_on: true, reverb_mix: 0.4, reverb_size: 0.85,
    }),
    routes: [route('lfo1', 'a_pos', 1), route('lfo1', 'flt_cutoff', 0.7), route('lfo1', 'a_semi', 0.5)],
  },
  {
    name: 'Growl Bass',
    category: 'Bass',
    tables: tables('Wavefold', 'Growl'),
    params: params({
      poly: 1, legato: true,
      a_pos: 0.2,
      b_on: true, b_pos: 0.4, b_unison: 2, b_detune: 0.1, b_level: 0.5,
      sub_on: true, sub_level: 0.5,
      flt_type: 4, flt_cutoff: 900, flt_res: 0.35, flt_mix: 0.8,
      lfo1_sync: true, lfo1_div: 6, lfo1_shape: 1,
      dist_on: true, dist_type: 2, dist_drive: 0.2, dist_mix: 0.5,
      comp_on: true, comp_mode: 1, comp_depth: 0.7,
    }),
    routes: [route('lfo1', 'a_pos', 0.6), route('lfo1', 'flt_cutoff', 0.3), route('lfo1', 'b_pos', 0.4)],
  },
  {
    name: 'PWM Strings',
    category: 'Pad',
    tables: tables('PWM'),
    params: params({
      a_pos: 0.2, a_unison: 4, a_detune: 0.2,
      flt_type: 0, flt_cutoff: 3500,
      env1_a: 0.3, env1_r: 0.8,
      lfo1_sync: false, lfo1_rate: 0.4, lfo1_mode: 1, lfo1_shape: 1,
      chorus_on: true, chorus_mix: 0.4,
      reverb_on: true, reverb_mix: 0.3,
    }),
    routes: [route('lfo1', 'a_pos', 0.5)],
  },
];

/** A preset as a full Vertex state. */
export function presetState(preset) {
  return {
    v: 1,
    name: preset.name,
    params: { ...preset.params, ...(preset.extra ?? {}) },
    routes: preset.routes,
    lfo: {},
    tables: preset.tables,
    fxOrder: null,
  };
}

// ------------------------------------------------------------------ user presets

// Your own presets live in this browser (available in every project) and can
// be exported/imported as files to move them between devices or people.
const KEY = 'vertex:user-presets';
const store = () => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

/** [{ name, state, saved }] sorted by name. */
export function userPresets(storage = store()) {
  try {
    const list = JSON.parse(storage?.getItem(KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((p) => p && typeof p.name === 'string' && p.state) : [];
  } catch {
    return [];
  }
}

export function saveUserPreset(name, state, storage = store()) {
  name = String(name ?? '').trim().slice(0, 40);
  if (!name) return { ok: false, error: 'Give the preset a name' };
  if (!storage) return { ok: false, error: 'This browser does not allow saving' };
  const list = userPresets(storage).filter((p) => p.name !== name);
  list.push({ name, state: { ...state, name }, saved: Date.now() });
  list.sort((a, b) => a.name.localeCompare(b.name));
  try {
    storage.setItem(KEY, JSON.stringify(list));
    return { ok: true };
  } catch {
    return { ok: false, error: 'Browser storage is full: delete or export some presets' };
  }
}

export function deleteUserPreset(name, storage = store()) {
  try {
    storage?.setItem(KEY, JSON.stringify(userPresets(storage).filter((p) => p.name !== name)));
  } catch {}
}

/** A preset as a shareable file. */
export function presetFile(state) {
  return JSON.stringify({ format: 'vertex-preset', version: 1, name: state.name, state }, null, 1);
}

/** Read a preset file; throws a readable error if it isn't one. */
export function parsePresetFile(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('That file is not a Vertex preset');
  }
  if (data?.format !== 'vertex-preset' || !data.state || typeof data.state.params !== 'object') {
    throw new Error('That file is not a Vertex preset');
  }
  return { ...data.state, name: String(data.name ?? data.state.name ?? 'Imported').slice(0, 40) };
}
