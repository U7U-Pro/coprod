// Parameter tables shared by coprod's sample plugins (Slicer, Grains).
// Like Vertex, every parameter is stored and automated normalized (0..1) and
// maps that to real units, so the audio thread, the GUI and host automation
// all speak the same language.

export const lin = (min, max) => ({ map: (n) => min + n * (max - min), unmap: (v) => (v - min) / (max - min) });
export const expo = (min, max) => ({ map: (n) => min * (max / min) ** n, unmap: (v) => Math.log(v / min) / Math.log(max / min) });
export const int = (min, max) => ({ map: (n) => Math.round(min + n * (max - min)), unmap: (v) => (v - min) / (max - min) });
/** Seconds, with finer control at short times. */
export const time = (max) => ({ map: (n) => max * n * n * n, unmap: (v) => Math.cbrt(v / max) });
export const choice = (choices) => ({ choices, map: (n) => Math.round(n * (choices.length - 1)), unmap: (i) => i / Math.max(1, choices.length - 1) });

export const fmtTime = (s) => (s < 1 ? `${Math.round(s * 1000)} ms` : `${s.toFixed(2)} s`);
export const fmtPct = (v) => `${Math.round(v * 100)}%`;
export const fmtDb = (db) => (db <= -60 ? '−∞' : `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`);
export const fmtSemi = (v) => `${v > 0 ? '+' : ''}${v} st`;
export const fmtHz = (hz) => (hz < 1000 ? `${Math.round(hz)} Hz` : `${(hz / 1000).toFixed(1)} kHz`);

/**
 * Build a table from [id, label, group, scale, default (real units), format].
 * Choices format themselves.
 */
export function defineParams(rows) {
  const PARAMS = rows.map(([id, label, group, scale, def, fmt]) => {
    const n = Math.min(1, Math.max(0, scale.unmap(def)));
    return {
      id,
      label,
      group,
      kind: scale.choices ? 'choice' : 'float',
      choices: scale.choices,
      map: scale.map,
      unmap: scale.unmap,
      def: n,
      format: scale.choices ? (i) => scale.choices[i] : fmt,
    };
  });
  const INDEX = Object.fromEntries(PARAMS.map((p, i) => [p.id, i]));
  const DEFAULTS = PARAMS.map((p) => p.def);
  return { PARAMS, INDEX, DEFAULTS };
}
