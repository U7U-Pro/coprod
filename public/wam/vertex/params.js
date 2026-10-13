// Every Vertex parameter, in one table shared by the engine (audio thread),
// the GUI and host automation. Values are stored normalized (0..1); each
// parameter maps that to real units. Modulation and automation also work in
// the normalized space, the same way Serum-style synths do.

const lin = (min, max) => (n) => min + n * (max - min);
const expo = (min, max) => (n) => min * (max / min) ** n;
const int = (min, max) => (n) => Math.round(min + n * (max - min));
const time = (max) => (n) => max * n * n * n; // seconds, finer control at short times
const norm = {
  lin: (min, max) => (v) => (v - min) / (max - min),
  expo: (min, max) => (v) => Math.log(v / min) / Math.log(max / min),
  time: (max) => (v) => Math.cbrt(v / max),
};

const fmtTime = (s) => (s < 1 ? `${Math.round(s * 1000)} ms` : `${s.toFixed(2)} s`);
const fmtHz = (hz) => (hz < 1000 ? `${hz < 10 ? hz.toFixed(2) : Math.round(hz)} Hz` : `${(hz / 1000).toFixed(1)} kHz`);
const fmtPct = (v) => `${Math.round(v * 100)}%`;
const fmtDb = (db) => `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;
const signed = (v) => `${v > 0 ? '+' : ''}${v}`;

export const WARPS = ['Off', 'Sync', 'Bend +', 'Bend −', 'PWM', 'Mirror', 'Quantize', 'FM', 'RM'];
export const FILTERS = ['LP 12', 'LP 24', 'HP 12', 'HP 24', 'BP 12', 'Notch'];
export const SUB_SHAPES = ['Sine', 'Triangle', 'Saw', 'Square'];
export const LFO_SHAPES = ['Sine', 'Triangle', 'Saw up', 'Saw down', 'Square', 'S&H', 'Smooth rnd', 'Custom'];
export const LFO_MODES = ['Trig', 'Free', 'Env'];
// Note divisions in beats (quarter notes).
export const DIVISIONS = [
  ['4 bars', 16], ['2 bars', 8], ['1 bar', 4], ['1/2', 2], ['1/4', 1], ['1/8', 0.5], ['1/16', 0.25], ['1/32', 0.125],
  ['1/4 T', 2 / 3], ['1/8 T', 1 / 3], ['1/16 T', 1 / 6], ['1/4 .', 1.5], ['1/8 .', 0.75], ['1/16 .', 0.375],
];
export const DIST_TYPES = ['Soft', 'Hard', 'Fold', 'Tube', 'Bitcrush', 'Downsample'];
export const COMP_MODES = ['Single', 'Multiband (OTT)'];
export const FX_KINDS = ['dist', 'chorus', 'flanger', 'phaser', 'delay', 'reverb', 'comp', 'eq'];
export const FX_LABELS = { dist: 'Distortion', chorus: 'Chorus', flanger: 'Flanger', phaser: 'Phaser', delay: 'Delay', reverb: 'Reverb', comp: 'Compressor', eq: 'EQ' };

const defs = [];
/**
 * Add a parameter.
 * @param {string} id
 * @param {string} label
 * @param {string} group   for GUI/automation grouping; also tells the engine
 *   whether it's per voice ('osc', 'voice') or global ('fx', 'global')
 * @param {object} o  { map, unmap, def (in real units), fmt, choices, kind }
 */
function P(id, label, group, o) {
  const p = { id, label, group, kind: o.kind ?? 'float', choices: o.choices ?? null, map: o.map, fmt: o.fmt ?? ((v) => String(v)) };
  p.unmap = o.unmap;
  p.def = o.unmap ? o.unmap(o.def) : o.def;
  defs.push(p);
}
const choice = (id, label, group, choices, def = 0) =>
  P(id, label, group, {
    kind: 'choice',
    choices,
    map: (n) => Math.min(choices.length - 1, Math.round(n * (choices.length - 1))),
    unmap: (i) => (choices.length > 1 ? i / (choices.length - 1) : 0),
    def,
    fmt: (i) => choices[i],
  });
const bool = (id, label, group, def) =>
  P(id, label, group, { kind: 'bool', map: (n) => n >= 0.5, unmap: (b) => (b ? 1 : 0), def, fmt: (b) => (b ? 'On' : 'Off') });
const pct = (id, label, group, def) => P(id, label, group, { map: lin(0, 1), unmap: norm.lin(0, 1), def, fmt: fmtPct });
const integer = (id, label, group, min, max, def, fmt = String) =>
  P(id, label, group, { kind: 'int', map: int(min, max), unmap: norm.lin(min, max), def, fmt });

// ---- global / voicing
P('vol', 'Volume', 'global', { map: lin(-60, 6), unmap: norm.lin(-60, 6), def: -6, fmt: fmtDb });
integer('poly', 'Voices', 'global', 1, 16, 8);
bool('legato', 'Legato', 'global', false);
P('glide', 'Glide', 'global', { map: time(2), unmap: norm.time(2), def: 0, fmt: fmtTime });
integer('bend', 'Bend range', 'global', 0, 24, 2, (v) => `${v} st`);

// ---- oscillators A and B
for (const o of ['a', 'b']) {
  const O = o.toUpperCase();
  const g = `osc${o}`;
  bool(`${o}_on`, `Osc ${O}`, g, o === 'a');
  pct(`${o}_pos`, `${O} WT pos`, g, 0);
  integer(`${o}_oct`, `${O} Octave`, g, -4, 4, 0, signed);
  integer(`${o}_semi`, `${O} Semi`, g, -12, 12, 0, signed);
  P(`${o}_fine`, `${O} Fine`, g, { map: lin(-100, 100), unmap: norm.lin(-100, 100), def: 0, fmt: (v) => `${signed(Math.round(v))} ct` });
  integer(`${o}_unison`, `${O} Unison`, g, 1, 16, 1);
  pct(`${o}_detune`, `${O} Detune`, g, 0.25);
  pct(`${o}_blend`, `${O} Blend`, g, 0.75);
  pct(`${o}_width`, `${O} Width`, g, 1);
  pct(`${o}_phase`, `${O} Phase`, g, 0);
  pct(`${o}_rand`, `${O} Rand phase`, g, 1);
  choice(`${o}_warp`, `${O} Warp`, g, WARPS, 0);
  pct(`${o}_warpamt`, `${O} Warp amount`, g, 0);
  pct(`${o}_level`, `${O} Level`, g, 0.75);
  P(`${o}_pan`, `${O} Pan`, g, { map: lin(-1, 1), unmap: norm.lin(-1, 1), def: 0, fmt: (v) => (Math.abs(v) < 0.01 ? 'C' : `${v < 0 ? 'L' : 'R'}${Math.round(Math.abs(v) * 100)}`) });
  bool(`${o}_flt`, `${O} → Filter`, g, true);
}

// ---- sub and noise
bool('sub_on', 'Sub', 'sub', false);
choice('sub_shape', 'Sub shape', 'sub', SUB_SHAPES, 0);
integer('sub_oct', 'Sub octave', 'sub', -2, 0, -1, signed);
pct('sub_level', 'Sub level', 'sub', 0.6);
P('sub_pan', 'Sub pan', 'sub', { map: lin(-1, 1), unmap: norm.lin(-1, 1), def: 0, fmt: (v) => v.toFixed(2) });
bool('sub_flt', 'Sub → Filter', 'sub', false);
bool('noise_on', 'Noise', 'noise', false);
choice('noise_type', 'Noise type', 'noise', ['White', 'Pink'], 0);
pct('noise_level', 'Noise level', 'noise', 0.3);
P('noise_pan', 'Noise pan', 'noise', { map: lin(-1, 1), unmap: norm.lin(-1, 1), def: 0, fmt: (v) => v.toFixed(2) });
bool('noise_flt', 'Noise → Filter', 'noise', true);

// ---- filter
bool('flt_on', 'Filter', 'filter', true);
choice('flt_type', 'Filter type', 'filter', FILTERS, 1);
P('flt_cutoff', 'Cutoff', 'filter', { map: expo(20, 20000), unmap: norm.expo(20, 20000), def: 8000, fmt: fmtHz });
pct('flt_res', 'Resonance', 'filter', 0.1);
pct('flt_drive', 'Drive', 'filter', 0);
pct('flt_mix', 'Filter mix', 'filter', 1);
pct('flt_key', 'Key track', 'filter', 0);

// ---- envelopes (Env 1 is the amplifier)
for (const n of [1, 2, 3]) {
  const g = `env${n}`;
  P(`env${n}_a`, `Env${n} attack`, g, { map: time(10), unmap: norm.time(10), def: 0.002, fmt: fmtTime });
  P(`env${n}_h`, `Env${n} hold`, g, { map: time(10), unmap: norm.time(10), def: 0, fmt: fmtTime });
  P(`env${n}_d`, `Env${n} decay`, g, { map: time(10), unmap: norm.time(10), def: n === 1 ? 1 : 0.4, fmt: fmtTime });
  pct(`env${n}_s`, `Env${n} sustain`, g, n === 1 ? 1 : 0);
  P(`env${n}_r`, `Env${n} release`, g, { map: time(10), unmap: norm.time(10), def: n === 1 ? 0.12 : 0.3, fmt: fmtTime });
}

// ---- LFOs
for (const n of [1, 2, 3, 4]) {
  const g = `lfo${n}`;
  P(`lfo${n}_rate`, `LFO${n} rate`, g, { map: expo(0.02, 40), unmap: norm.expo(0.02, 40), def: 1, fmt: fmtHz });
  bool(`lfo${n}_sync`, `LFO${n} sync`, g, true);
  choice(`lfo${n}_div`, `LFO${n} division`, g, DIVISIONS.map((d) => d[0]), 4);
  choice(`lfo${n}_mode`, `LFO${n} mode`, g, LFO_MODES, 0);
  choice(`lfo${n}_shape`, `LFO${n} shape`, g, LFO_SHAPES, 0);
  pct(`lfo${n}_phase`, `LFO${n} phase`, g, 0);
}

// ---- macros
for (const n of [1, 2, 3, 4]) pct(`macro${n}`, `Macro ${n}`, 'macro', 0);

// ---- effects
bool('dist_on', 'Distortion', 'fx', false);
choice('dist_type', 'Dist type', 'fx', DIST_TYPES, 0);
pct('dist_drive', 'Dist drive', 'fx', 0.3);
pct('dist_mix', 'Dist mix', 'fx', 1);

bool('chorus_on', 'Chorus', 'fx', false);
P('chorus_rate', 'Chorus rate', 'fx', { map: expo(0.05, 5), unmap: norm.expo(0.05, 5), def: 0.8, fmt: fmtHz });
pct('chorus_depth', 'Chorus depth', 'fx', 0.4);
pct('chorus_mix', 'Chorus mix', 'fx', 0.5);

bool('flanger_on', 'Flanger', 'fx', false);
P('flanger_rate', 'Flanger rate', 'fx', { map: expo(0.02, 5), unmap: norm.expo(0.02, 5), def: 0.2, fmt: fmtHz });
pct('flanger_depth', 'Flanger depth', 'fx', 0.6);
P('flanger_fb', 'Flanger feedback', 'fx', { map: lin(-0.95, 0.95), unmap: norm.lin(-0.95, 0.95), def: 0.5, fmt: (v) => fmtPct(v) });
pct('flanger_mix', 'Flanger mix', 'fx', 0.5);

bool('phaser_on', 'Phaser', 'fx', false);
P('phaser_rate', 'Phaser rate', 'fx', { map: expo(0.02, 5), unmap: norm.expo(0.02, 5), def: 0.3, fmt: fmtHz });
pct('phaser_depth', 'Phaser depth', 'fx', 0.7);
P('phaser_fb', 'Phaser feedback', 'fx', { map: lin(-0.9, 0.9), unmap: norm.lin(-0.9, 0.9), def: 0.4, fmt: (v) => fmtPct(v) });
pct('phaser_mix', 'Phaser mix', 'fx', 0.5);

bool('delay_on', 'Delay', 'fx', false);
bool('delay_sync', 'Delay sync', 'fx', true);
choice('delay_div', 'Delay division', 'fx', DIVISIONS.map((d) => d[0]), 12);
P('delay_time', 'Delay time', 'fx', { map: expo(0.01, 2), unmap: norm.expo(0.01, 2), def: 0.3, fmt: fmtTime });
P('delay_fb', 'Delay feedback', 'fx', { map: lin(0, 0.95), unmap: norm.lin(0, 0.95), def: 0.4, fmt: fmtPct });
bool('delay_pp', 'Ping-pong', 'fx', true);
P('delay_tone', 'Delay tone', 'fx', { map: expo(500, 20000), unmap: norm.expo(500, 20000), def: 6000, fmt: fmtHz });
pct('delay_mix', 'Delay mix', 'fx', 0.25);

bool('reverb_on', 'Reverb', 'fx', false);
pct('reverb_size', 'Reverb size', 'fx', 0.6);
pct('reverb_damp', 'Reverb damping', 'fx', 0.4);
pct('reverb_width', 'Reverb width', 'fx', 1);
pct('reverb_mix', 'Reverb mix', 'fx', 0.25);

bool('comp_on', 'Compressor', 'fx', false);
choice('comp_mode', 'Comp mode', 'fx', COMP_MODES, 0);
P('comp_thresh', 'Threshold', 'fx', { map: lin(-48, 0), unmap: norm.lin(-48, 0), def: -18, fmt: fmtDb });
P('comp_ratio', 'Ratio', 'fx', { map: expo(1, 20), unmap: norm.expo(1, 20), def: 4, fmt: (v) => `${v.toFixed(1)}:1` });
P('comp_attack', 'Attack', 'fx', { map: expo(0.0001, 0.1), unmap: norm.expo(0.0001, 0.1), def: 0.005, fmt: fmtTime });
P('comp_release', 'Release', 'fx', { map: expo(0.01, 1), unmap: norm.expo(0.01, 1), def: 0.12, fmt: fmtTime });
pct('comp_depth', 'OTT depth', 'fx', 0.5);
P('comp_gain', 'Makeup', 'fx', { map: lin(-12, 24), unmap: norm.lin(-12, 24), def: 0, fmt: fmtDb });

bool('eq_on', 'EQ', 'fx', false);
P('eq_lowf', 'Low freq', 'fx', { map: expo(20, 1000), unmap: norm.expo(20, 1000), def: 120, fmt: fmtHz });
P('eq_lowg', 'Low gain', 'fx', { map: lin(-24, 24), unmap: norm.lin(-24, 24), def: 0, fmt: fmtDb });
P('eq_midf', 'Mid freq', 'fx', { map: expo(100, 10000), unmap: norm.expo(100, 10000), def: 1000, fmt: fmtHz });
P('eq_midg', 'Mid gain', 'fx', { map: lin(-24, 24), unmap: norm.lin(-24, 24), def: 0, fmt: fmtDb });
P('eq_highf', 'High freq', 'fx', { map: expo(1000, 20000), unmap: norm.expo(1000, 20000), def: 8000, fmt: fmtHz });
P('eq_highg', 'High gain', 'fx', { map: lin(-24, 24), unmap: norm.lin(-24, 24), def: 0, fmt: fmtDb });

export const PARAMS = defs;
export const INDEX = Object.fromEntries(defs.map((p, i) => [p.id, i]));
export const DEFAULTS = Float32Array.from(defs.map((p) => p.def));

// ---- modulation sources
export const SOURCES = ['env1', 'env2', 'env3', 'lfo1', 'lfo2', 'lfo3', 'lfo4', 'vel', 'note', 'mod', 'rand', 'macro1', 'macro2', 'macro3', 'macro4'];
export const SOURCE_LABELS = {
  env1: 'Env 1', env2: 'Env 2', env3: 'Env 3', lfo1: 'LFO 1', lfo2: 'LFO 2', lfo3: 'LFO 3', lfo4: 'LFO 4',
  vel: 'Velocity', note: 'Note', mod: 'Mod wheel', rand: 'Random', macro1: 'Macro 1', macro2: 'Macro 2', macro3: 'Macro 3', macro4: 'Macro 4',
};
/** Groups whose parameters are computed per voice (all sources apply). */
export const VOICE_GROUPS = new Set(['osca', 'oscb', 'sub', 'noise', 'filter', 'env1', 'env2', 'env3', 'lfo1', 'lfo2', 'lfo3', 'lfo4']);

/** Real value of parameter `i` at normalized `n`. */
export const value = (i, n) => defs[i].map(Math.min(1, Math.max(0, n)));
export const format = (i, n) => defs[i].fmt(value(i, n));
