// Grains' parameters (all automatable).

import { defineParams, lin, int, time, expo, choice, fmtDb, fmtSemi, fmtTime, fmtPct } from '../kit/params.js';

export const WINDOWS = ['Smooth', 'Triangle', 'Flat', 'Percussive', 'Swell'];

export const TABLE = defineParams([
  ['position', 'Position', 'Source', lin(0, 1), 0.3, fmtPct],
  ['scan', 'Scan', 'Source', lin(-2, 2), 0, (v) => (Math.abs(v) < 0.005 ? 'Frozen' : `${v > 0 ? '' : '−'}${Math.abs(v).toFixed(2)}×`)],
  ['spray', 'Spray', 'Source', time(2), 0.05, fmtTime],
  ['size', 'Size', 'Grains', expo(0.005, 1), 0.12, fmtTime],
  ['density', 'Density', 'Grains', expo(1, 200), 24, (v) => `${v < 10 ? v.toFixed(1) : Math.round(v)}/s`],
  ['jitter', 'Jitter', 'Grains', lin(0, 1), 0.3, fmtPct],
  ['window', 'Shape', 'Grains', choice(WINDOWS), 0],
  ['pitch', 'Pitch', 'Pitch', int(-24, 24), 0, fmtSemi],
  ['detune', 'Random', 'Pitch', lin(0, 12), 0, (v) => (v < 0.05 ? 'Off' : `±${v.toFixed(1)} st`)],
  ['keytrack', 'Notes', 'Pitch', choice(['Change pitch', 'Fixed pitch']), 0],
  ['reverse', 'Reverse', 'Pitch', lin(0, 1), 0, fmtPct],
  ['spread', 'Stereo', 'Output', lin(0, 1), 0.6, fmtPct],
  ['attack', 'Attack', 'Envelope', time(4), 0.02, fmtTime],
  ['release', 'Release', 'Envelope', time(8), 0.6, fmtTime],
  ['gain', 'Gain', 'Output', lin(-36, 12), 0, fmtDb],
]);
