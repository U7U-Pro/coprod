// Wavetables: generating them, editing helpers, and turning them into
// band-limited mipmaps the oscillator can play without aliasing.
// Pure functions, no DOM: used by the GUI, the audio thread and the tests.

export const SIZE = 2048; // samples per frame as played
export const EDIT_SIZE = 512; // samples per frame as stored/edited (up to 256 harmonics)
export const MAX_FRAMES = 64;
export const LEVELS = 11; // mip levels: 1024, 512, ... 1 harmonics

// ------------------------------------------------------------------ FFT

/** In-place radix-2 complex FFT. `inverse` computes the unscaled inverse. */
export function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** Resample one periodic frame to `size` samples through its spectrum. */
export function resampleFrame(src, size) {
  const n = src.length;
  const re = Float64Array.from(src);
  const im = new Float64Array(n);
  fft(re, im);
  const ore = new Float64Array(size);
  const oim = new Float64Array(size);
  const half = Math.min(n, size) / 2;
  for (let k = 1; k < half; k++) {
    // keep harmonics both sizes can represent; drop DC
    ore[k] = re[k];
    oim[k] = im[k];
    ore[size - k] = re[n - k];
    oim[size - k] = im[n - k];
  }
  fft(ore, oim, true);
  const out = new Float32Array(size);
  for (let i = 0; i < size; i++) out[i] = ore[i] / n;
  return out;
}

/**
 * Band-limited mipmaps for every frame: level L keeps harmonics up to
 * 1024 >> L. Layout: data[(L * frames + f) * (SIZE + 1) + i], with one guard
 * sample per row so interpolation never needs to wrap.
 */
export function buildMips(frames, count) {
  const row = SIZE + 1;
  const data = new Float32Array(LEVELS * count * row);
  const re = new Float64Array(SIZE);
  const im = new Float64Array(SIZE);
  const bre = new Float64Array(SIZE);
  const bim = new Float64Array(SIZE);
  for (let f = 0; f < count; f++) {
    for (let i = 0; i < SIZE; i++) {
      re[i] = frames[f * SIZE + i];
      im[i] = 0;
    }
    fft(re, im);
    for (let L = 0; L < LEVELS; L++) {
      const maxH = Math.max(1, (SIZE / 2) >> L);
      bre.fill(0);
      bim.fill(0);
      for (let k = 1; k <= maxH && k < SIZE / 2; k++) {
        bre[k] = re[k];
        bim[k] = im[k];
        bre[SIZE - k] = re[SIZE - k];
        bim[SIZE - k] = im[SIZE - k];
      }
      fft(bre, bim, true);
      const off = (L * count + f) * row;
      for (let i = 0; i < SIZE; i++) data[off + i] = bre[i] / SIZE;
      data[off + SIZE] = data[off];
    }
  }
  return { data, frames: count, levels: LEVELS, row };
}

/** Scale all frames together so the loudest peak is 1 (keeps relative levels). */
export function normalize(frames) {
  let peak = 0;
  for (let i = 0; i < frames.length; i++) peak = Math.max(peak, Math.abs(frames[i]));
  if (peak > 1e-9) for (let i = 0; i < frames.length; i++) frames[i] /= peak;
  return frames;
}

/** Remove each frame's DC offset. */
export function removeDC(frames, size) {
  for (let f = 0; f < frames.length / size; f++) {
    let s = 0;
    for (let i = 0; i < size; i++) s += frames[f * size + i];
    s /= size;
    for (let i = 0; i < size; i++) frames[f * size + i] -= s;
  }
  return frames;
}

// ------------------------------------------------------------------ built-in tables

const TAU = Math.PI * 2;

/** Additive synthesis: amp(h, y) for harmonic h at frame position y. */
function additive(count, amp, maxH = 256, phaseFn = () => 0) {
  const out = new Float32Array(count * SIZE);
  for (let f = 0; f < count; f++) {
    const y = count > 1 ? f / (count - 1) : 0;
    const re = new Float64Array(SIZE);
    const im = new Float64Array(SIZE);
    for (let h = 1; h <= maxH; h++) {
      const a = amp(h, y);
      if (!a) continue;
      const ph = phaseFn(h, y);
      // sine partial: spectrum of a*sin(h x + ph)
      re[h] = (a / 2) * Math.sin(ph) * SIZE;
      im[h] = (-a / 2) * Math.cos(ph) * SIZE;
      re[SIZE - h] = re[h];
      im[SIZE - h] = -im[h];
    }
    fft(re, im, true);
    for (let i = 0; i < SIZE; i++) out[f * SIZE + i] = re[i] / SIZE;
  }
  return normalize(out);
}

function sampled(count, fn) {
  const out = new Float32Array(count * SIZE);
  for (let f = 0; f < count; f++) {
    const y = count > 1 ? f / (count - 1) : 0;
    for (let i = 0; i < SIZE; i++) out[f * SIZE + i] = fn(i / SIZE, y);
  }
  return normalize(removeDC(out, SIZE));
}

const saw = (h) => (h % 2 ? 1 : -1) / h; // Fourier series of a saw
const square = (h) => (h % 2 ? 1 / h : 0);
const tri = (h) => (h % 2 ? (((h - 1) / 2) % 2 ? -1 : 1) / (h * h) : 0);

export const BUILTIN = {
  'Basic Shapes': () =>
    additive(64, (h, y) => {
      // sine -> triangle -> saw -> square across the table
      const seg = y * 3;
      const shapes = [(k) => (k === 1 ? 1 : 0), tri, saw, square];
      const i = Math.min(2, Math.floor(seg));
      const t = seg - i;
      return shapes[i](h) * (1 - t) + shapes[i + 1](h) * t;
    }),
  'Saw Sweep': () => additive(64, (h, y) => (h <= 1 + y * y * 255 ? saw(h) : 0)),
  PWM: () =>
    sampled(64, (x, y) => {
      const w = 0.5 - y * 0.47;
      return x < w ? 1 : -1;
    }),
  'Formant Vox': () => {
    // A E I O U: formant pairs, as harmonic peaks on a 110 Hz voice
    const vowels = [[800, 1150], [400, 2100], [300, 2600], [450, 800], [325, 700]];
    return additive(64, (h, y) => {
      const seg = y * (vowels.length - 1);
      const i = Math.min(vowels.length - 2, Math.floor(seg));
      const t = seg - i;
      const f1 = vowels[i][0] * (1 - t) + vowels[i + 1][0] * t;
      const f2 = vowels[i][1] * (1 - t) + vowels[i + 1][1] * t;
      const hz = h * 110;
      const peak = (f, bw) => Math.exp(-(((hz - f) / bw) ** 2));
      return (peak(f1, 120) + 0.6 * peak(f2, 180) + 0.05) / Math.sqrt(h);
    }, 128);
  },
  'Digital FM': () => sampled(64, (x, y) => Math.sin(TAU * x + y * 7 * Math.sin(TAU * x))),
  'Sync Sweep': () =>
    sampled(64, (x, y) => {
      const ratio = 1 + y * 7;
      return 2 * ((x * ratio) % 1) - 1;
    }),
  Wavefold: () =>
    sampled(64, (x, y) => {
      const g = 1 + y * 9;
      return Math.sin(g * Math.sin(TAU * x));
    }),
  'Organ Bars': () =>
    additive(64, (h, y) => {
      const bars = { 1: 1, 2: 0.5 + y * 0.5, 3: y, 4: 0.6 * y, 6: 0.4 * y * y, 8: 0.5 * y * y };
      return bars[h] ?? 0;
    }),
  Growl: () =>
    additive(64, (h, y) => {
      // a resonant peak sweeping up through the harmonics, over a saw
      const center = 2 + y * 40;
      return saw(h) * 0.35 + Math.exp(-(((h - center) / (2 + y * 4)) ** 2)) / Math.sqrt(h);
    }),
};

// ------------------------------------------------------------------ table specs

/**
 * A table is described by a small spec, which is what gets saved and shared:
 *   { kind: 'builtin', name }
 *   { kind: 'custom', name, frames, data }  data = base64 of Int16 samples,
 *     frames x EDIT_SIZE, edited by drawing, formulas or audio import.
 */
export function framesFromSpec(spec) {
  if (spec?.kind === 'custom' && spec.data) {
    const pcm = decodeInt16(spec.data);
    const count = Math.max(1, Math.min(MAX_FRAMES, Math.floor(pcm.length / EDIT_SIZE)));
    const out = new Float32Array(count * SIZE);
    for (let f = 0; f < count; f++) {
      const src = new Float32Array(EDIT_SIZE);
      for (let i = 0; i < EDIT_SIZE; i++) src[i] = pcm[f * EDIT_SIZE + i] / 32767;
      out.set(resampleFrame(src, SIZE), f * SIZE);
    }
    return { frames: out, count };
  }
  const gen = BUILTIN[spec?.name] ?? BUILTIN['Basic Shapes'];
  const frames = gen();
  return { frames, count: frames.length / SIZE };
}

/** Frames at edit resolution (for the editor), from any spec. */
export function editFramesFromSpec(spec) {
  if (spec?.kind === 'custom' && spec.data) {
    const pcm = decodeInt16(spec.data);
    const count = Math.max(1, Math.min(MAX_FRAMES, Math.floor(pcm.length / EDIT_SIZE)));
    return { frames: Float32Array.from(pcm.subarray(0, count * EDIT_SIZE), (v) => v / 32767), count };
  }
  const { frames, count } = framesFromSpec(spec);
  const out = new Float32Array(count * EDIT_SIZE);
  for (let f = 0; f < count; f++) out.set(resampleFrame(frames.subarray(f * SIZE, (f + 1) * SIZE), EDIT_SIZE), f * EDIT_SIZE);
  return { frames: out, count };
}

export function customSpec(name, frames, count) {
  const pcm = new Int16Array(count * EDIT_SIZE);
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(Math.max(-1, Math.min(1, frames[i])) * 32767);
  return { kind: 'custom', name: String(name).slice(0, 40), frames: count, data: encodeInt16(pcm) };
}

function encodeInt16(pcm) {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function decodeInt16(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length & ~1);
  for (let i = 0; i < bytes.length; i++) bytes[i] = s.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

// ------------------------------------------------------------------ editing helpers

/** Fill frames between the first and last by crossfading them. */
export function morphFill(frames, count, size = EDIT_SIZE) {
  for (let f = 1; f < count - 1; f++) {
    const t = f / (count - 1);
    for (let i = 0; i < size; i++) frames[f * size + i] = frames[i] * (1 - t) + frames[(count - 1) * size + i] * t;
  }
  return frames;
}

/** Same, but crossfading harmonic magnitudes (a smoother, "spectral" morph). */
export function spectralMorphFill(frames, count, size = EDIT_SIZE) {
  const spec = (f) => {
    const re = Float64Array.from(frames.subarray(f * size, (f + 1) * size));
    const im = new Float64Array(size);
    fft(re, im);
    return { re, im };
  };
  const a = spec(0);
  const b = spec(count - 1);
  for (let f = 1; f < count - 1; f++) {
    const t = f / (count - 1);
    const re = new Float64Array(size);
    const im = new Float64Array(size);
    for (let k = 1; k < size / 2; k++) {
      const ma = Math.hypot(a.re[k], a.im[k]);
      const mb = Math.hypot(b.re[k], b.im[k]);
      const pa = Math.atan2(a.im[k], a.re[k]);
      const pb = Math.atan2(b.im[k], b.re[k]);
      const m = ma * (1 - t) + mb * t;
      const p = (t < 0.5 ? pa : pb);
      re[k] = m * Math.cos(p);
      im[k] = m * Math.sin(p);
      re[size - k] = re[k];
      im[size - k] = -im[k];
    }
    fft(re, im, true);
    for (let i = 0; i < size; i++) frames[f * size + i] = re[i] / size;
  }
  return frames;
}

/**
 * Slice audio into wavetable frames. `mode` 'split' spreads `count` frames
 * evenly through the file; each frame is one EDIT_SIZE window, so the result
 * keeps the sound's timbre changing over the table.
 */
export function framesFromAudio(samples, count, mode = 'split') {
  count = Math.max(1, Math.min(MAX_FRAMES, count | 0));
  const out = new Float32Array(count * EDIT_SIZE);
  if (mode === 'single') {
    // the whole file is one cycle: resample it to a single frame
    out.set(resampleFrame(fitPow2(samples), EDIT_SIZE));
    return { frames: normalize(removeDC(out.subarray(0, EDIT_SIZE), EDIT_SIZE)), count: 1 };
  }
  const span = Math.max(EDIT_SIZE, samples.length - EDIT_SIZE);
  for (let f = 0; f < count; f++) {
    const start = Math.floor((f / Math.max(1, count - 1)) * (span - EDIT_SIZE));
    for (let i = 0; i < EDIT_SIZE; i++) out[f * EDIT_SIZE + i] = samples[start + i] ?? 0;
  }
  // Each window is treated as one cycle: taper the ends so the loop point doesn't click.
  for (let f = 0; f < count; f++) {
    for (let i = 0; i < 32; i++) {
      const w = i / 32;
      out[f * EDIT_SIZE + i] *= w;
      out[f * EDIT_SIZE + EDIT_SIZE - 1 - i] *= w;
    }
  }
  return { frames: normalize(removeDC(out, EDIT_SIZE)), count };
}

function fitPow2(samples) {
  let n = 1;
  while (n < samples.length && n < 1 << 16) n <<= 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / n) * samples.length;
    const k = Math.floor(x);
    out[i] = (samples[k] ?? 0) * (1 - (x - k)) + (samples[k + 1] ?? samples[0] ?? 0) * (x - k);
  }
  return out;
}

// ------------------------------------------------------------------ formulas

/**
 * Safe math expressions for generating frames, like Serum's formula parser.
 * Variables: x (phase 0..1), y (frame position 0..1), w (x as -1..1 ramp).
 * This is a real parser, not eval: a formula someone shares can only compute
 * numbers, never run code.
 */
const FUNCS = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, abs: Math.abs, sqrt: (v) => Math.sqrt(Math.max(0, v)),
  exp: Math.exp, log: (v) => Math.log(Math.max(1e-9, v)), floor: Math.floor, ceil: Math.ceil, round: Math.round,
  sign: Math.sign, tanh: Math.tanh, atan: Math.atan, min: Math.min, max: Math.max, pow: Math.pow,
  clamp: (v, lo = -1, hi = 1) => Math.min(hi, Math.max(lo, v)), fract: (v) => v - Math.floor(v),
  saw: (v) => 2 * (v - Math.floor(v + 0.5)), sq: (v) => (v - Math.floor(v) < 0.5 ? 1 : -1),
  tri: (v) => 1 - 4 * Math.abs(v - Math.floor(v + 0.5)), rand: (v) => fract(Math.sin(v * 12.9898) * 43758.5453) * 2 - 1,
};
const fract = (v) => v - Math.floor(v);
const CONSTS = { pi: Math.PI, tau: TAU, e: Math.E };

export function compileFormula(src) {
  const text = String(src);
  if (text.length > 400) throw new Error('Formula is too long');
  const tokens = text.match(/\d*\.?\d+(?:e[+-]?\d+)?|[a-z_]\w*|\*\*|[-+*/%^(),<>]|\S/gi) ?? [];
  let pos = 0;
  const peek = () => tokens[pos];
  const take = (t) => {
    if (t && tokens[pos] !== t) throw new Error(`Expected "${t}" near "${tokens[pos] ?? 'end'}"`);
    return tokens[pos++];
  };
  // Grammar: compare -> sum (< > sum)?; sum -> term ((+|-) term)*;
  // term -> power ((*|/|%) power)*; power -> unary (^ power)?; unary -> -unary | atom
  const compare = () => {
    let a = sum();
    while (peek() === '<' || peek() === '>') {
      const op = take();
      const b = sum();
      const l = a;
      a = op === '<' ? (v) => (l(v) < b(v) ? 1 : 0) : (v) => (l(v) > b(v) ? 1 : 0);
    }
    return a;
  };
  const sum = () => {
    let a = term();
    while (peek() === '+' || peek() === '-') {
      const op = take();
      const b = term();
      const l = a;
      a = op === '+' ? (v) => l(v) + b(v) : (v) => l(v) - b(v);
    }
    return a;
  };
  const term = () => {
    let a = power();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = take();
      const b = power();
      const l = a;
      a = op === '*' ? (v) => l(v) * b(v) : op === '/' ? (v) => l(v) / b(v) : (v) => l(v) % b(v);
    }
    return a;
  };
  const power = () => {
    const a = unary();
    if (peek() === '^' || peek() === '**') {
      take();
      const b = power();
      return (v) => a(v) ** b(v);
    }
    return a;
  };
  const unary = () => {
    if (peek() === '-') {
      take();
      const a = unary();
      return (v) => -a(v);
    }
    if (peek() === '+') {
      take();
      return unary();
    }
    return atom();
  };
  const atom = () => {
    const t = take();
    if (t === undefined) throw new Error('Formula ended too soon');
    if (t === '(') {
      const a = compare();
      take(')');
      return a;
    }
    if (/^\d|^\./.test(t)) {
      const n = Number(t);
      return () => n;
    }
    const name = t.toLowerCase();
    if (name === 'x') return (v) => v.x;
    if (name === 'y') return (v) => v.y;
    if (name === 'w') return (v) => v.x * 2 - 1;
    if (Object.hasOwn(CONSTS, name)) {
      const c = CONSTS[name];
      return () => c;
    }
    if (Object.hasOwn(FUNCS, name)) {
      const fn = FUNCS[name];
      take('(');
      const args = [];
      if (peek() !== ')') {
        args.push(compare());
        while (peek() === ',') {
          take(',');
          args.push(compare());
        }
      }
      take(')');
      return (v) => fn(...args.map((a) => a(v)));
    }
    throw new Error(`Unknown name "${t}"`);
  };
  const expr = compare();
  if (pos < tokens.length) throw new Error(`Unexpected "${tokens[pos]}"`);
  return (x, y) => {
    const r = expr({ x, y });
    return Number.isFinite(r) ? r : 0;
  };
}

export function framesFromFormula(src, count) {
  const fn = compileFormula(src);
  count = Math.max(1, Math.min(MAX_FRAMES, count | 0));
  const out = new Float32Array(count * EDIT_SIZE);
  for (let f = 0; f < count; f++) {
    const y = count > 1 ? f / (count - 1) : 0;
    for (let i = 0; i < EDIT_SIZE; i++) out[f * EDIT_SIZE + i] = fn(i / EDIT_SIZE, y);
  }
  return { frames: normalize(removeDC(out, EDIT_SIZE)), count };
}
