// Vocalist's parameters (all automatable) and voice presets.

import { defineParams, lin, int, time, fmtDb, fmtSemi, fmtTime, fmtPct } from '../kit/params.js';

const fmtCents = (c) => `${Math.round(c)} ct`;
const fmtSt = (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} st`;

export const TABLE = defineParams([
  // Voice
  ['pitch', 'Pitch', 'Voice', int(-12, 12), 0, fmtSemi],
  ['formant', 'Formant', 'Voice', lin(-6, 6), 2, fmtSt],
  ['breath', 'Breathiness', 'Voice', lin(0, 1), 0.2, fmtPct],
  ['light', 'Lightness', 'Voice', lin(0, 1), 0.45, fmtPct],
  ['tension', 'Tension', 'Voice', lin(0, 1), 0.4, fmtPct],
  ['opening', 'Opening', 'Voice', lin(0, 1), 0.5, fmtPct],
  // Expression
  ['vibDepth', 'Vibrato', 'Expression', lin(0, 100), 25, fmtCents],
  ['vibRate', 'Vib rate', 'Expression', lin(3, 8), 5.6, (v) => `${v.toFixed(1)} Hz`],
  ['vibDelay', 'Vib delay', 'Expression', time(1.5), 0.3, fmtTime],
  ['glide', 'Glide', 'Expression', time(0.4), 0.07, fmtTime],
  ['scoop', 'Scoop', 'Expression', lin(0, 200), 40, fmtCents],
  ['rough', 'Rough', 'Expression', lin(0, 1), 0.1, fmtPct],
  // Articulation
  ['consonants', 'Consonants', 'Articulation', lin(0, 1), 0.6, fmtPct],
  ['attack', 'Attack', 'Articulation', time(0.5), 0.03, fmtTime],
  ['release', 'Release', 'Articulation', time(1), 0.1, fmtTime],
  // Output
  ['gain', 'Gain', 'Output', lin(-24, 12), 0, fmtDb],
]);

/** Voice presets: real-unit settings (anything left out keeps its default). */
export const VOICES = [
  { name: 'Pop (default)', set: {} },
  { name: 'Soprano', set: { formant: 2.5, light: 0.62, breath: 0.15, tension: 0.55, opening: 0.62, vibDepth: 45, vibRate: 5.8, vibDelay: 0.25, scoop: 25 } },
  { name: 'Alto', set: { formant: 1.2, light: 0.4, breath: 0.25, tension: 0.4, vibDepth: 30, vibRate: 5.4 } },
  { name: 'Tenor', set: { formant: 0, light: 0.3, breath: 0.12, tension: 0.6, opening: 0.55, vibDepth: 35, vibRate: 5.5 } },
  { name: 'Baritone', set: { formant: -1.5, light: 0.18, breath: 0.1, tension: 0.45, vibDepth: 28, vibRate: 5.2 } },
  { name: 'Child', set: { formant: 4.5, light: 0.55, breath: 0.25, tension: 0.35, vibDepth: 10, scoop: 30 } },
  { name: 'Breathy', set: { breath: 0.65, light: 0.7, tension: 0.2, vibDepth: 15, attack: 0.08 } },
  { name: 'Whisper', set: { breath: 1, light: 0.8, tension: 0.15, vibDepth: 0, scoop: 0, rough: 0 } },
  { name: 'Belt', set: { light: 0.08, tension: 0.9, breath: 0.05, opening: 0.75, vibDepth: 40, vibDelay: 0.45, rough: 0.2 } },
  { name: 'Robot', set: { vibDepth: 0, scoop: 0, glide: 0, rough: 0, breath: 0, light: 0.25, tension: 0.7, attack: 0.01 } },
  { name: 'Growl', set: { rough: 0.85, light: 0.12, tension: 0.75, breath: 0.15, formant: -1, vibDepth: 15 } },
];
