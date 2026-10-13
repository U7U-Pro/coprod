// Base for the sample plugins' audio engines: parameter values (normalized),
// host automation that temporarily overrides them, tempo and pitch bend.
// Engines are plain classes so tests can render them offline in Node.

export class ParamEngine {
  constructor(sampleRate, table) {
    this.sr = sampleRate;
    this.table = table;
    this.values = Float32Array.from(table.DEFAULTS);
    this.auto = new Float32Array(table.PARAMS.length).fill(NaN);
    this.p = {}; // real values by id, after automation
    this.tempo = 120;
    this.bend = 0; // semitones, ±2
    this.refresh();
  }

  refresh() {
    this.table.PARAMS.forEach((p, i) => {
      const n = Number.isNaN(this.auto[i]) ? this.values[i] : this.auto[i];
      this.p[p.id] = p.map(n);
    });
  }

  setParams(values) {
    this.values.set(values);
    this.refresh();
  }

  setParam(i, v) {
    this.values[i] = v;
    this.refresh();
  }

  setAutomation(i, v) {
    this.auto[i] = v == null ? NaN : v;
    this.refresh();
  }

  clearAutomation() {
    this.auto.fill(NaN);
    this.refresh();
  }

  setTempo(bpm) {
    if (bpm > 0) this.tempo = bpm;
  }

  pitchBend(v14) {
    this.bend = ((v14 - 8192) / 8192) * 2;
  }

  cc(n) {
    if (n === 120 || n === 123) this.allOff();
  }

  allOff() {}
}

/** Small fast PRNG (xorshift32); deterministic for a given seed. */
export function rng(seed = 0x9e3779b9) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

/** Equal-power pan gains for -1..1, scaled so the center is unity. */
export function panGains(pan) {
  const a = ((Math.max(-1, Math.min(1, pan)) + 1) * Math.PI) / 4;
  return [Math.cos(a) * Math.SQRT2, Math.sin(a) * Math.SQRT2];
}
