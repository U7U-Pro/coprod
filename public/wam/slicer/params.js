// Slicer's parameters (all automatable) and constants shared with the GUI.

import { defineParams, lin, int, time, expo, choice, fmtDb, fmtSemi, fmtTime, fmtPct, fmtHz } from '../kit/params.js';

export const ROOT = 60; // slice 1 plays on C4, the note coprod's step grid sends
export const MAX_SLICES = 36; // C4..B6: fits the piano roll
export const SYNC_BEATS = [0, 1, 2, 4, 8, 16, 32];

export const TABLE = defineParams([
  ['gain', 'Gain', 'Output', lin(-36, 12), 0, fmtDb],
  ['pitch', 'Pitch', 'Playback', int(-24, 24), 0, fmtSemi],
  ['sync', 'Fit to tempo', 'Playback', choice(['Off', '1 beat', '2 beats', '1 bar', '2 bars', '4 bars', '8 bars']), 0],
  ['mode', 'Notes', 'Playback', choice(['Play whole slice', 'Stop on note off']), 0],
  ['choke', 'Overlap', 'Playback', choice(['Cut previous', 'Let ring']), 0],
  ['attack', 'Attack', 'Envelope', time(1), 0, fmtTime],
  ['release', 'Release', 'Envelope', time(2), 0.03, fmtTime],
  ['vel', 'Velocity', 'Envelope', lin(0, 1), 0.6, fmtPct],
  ['cutoff', 'Cutoff', 'Filter', expo(60, 20000), 20000, fmtHz],
  ['reso', 'Reso', 'Filter', lin(0, 1), 0, fmtPct],
]);
