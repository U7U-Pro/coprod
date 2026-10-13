// Vertex's effects rack. Each effect processes a stereo block in place.
// Plain JS DSP, no allocation in process().

const TAU = Math.PI * 2;

class DelayLine {
  constructor(maxSamples) {
    this.buf = new Float32Array(maxSamples + 2);
    this.size = this.buf.length;
    this.w = 0;
  }
  write(v) {
    this.buf[this.w] = v;
    this.w = (this.w + 1) % this.size;
  }
  /** Read `d` samples behind the write head (fractional, linear interpolation). */
  read(d) {
    let r = this.w - 1 - d;
    while (r < 0) r += this.size;
    const i = r | 0;
    const f = r - i;
    const a = this.buf[i];
    const b = this.buf[(i + 1) % this.size];
    return a + (b - a) * f;
  }
  clear() {
    this.buf.fill(0);
  }
}

// ------------------------------------------------------------------ distortion

export class Distortion {
  constructor(sr) {
    this.sr = sr;
    this.hold = [0, 0];
    this.count = 0;
  }
  process(L, R, n, p) {
    const drive = p.drive;
    const mix = p.mix;
    const type = p.type;
    const g = 1 + drive * 30;
    const bits = Math.max(1, 16 - drive * 14.5);
    const q = 2 ** bits;
    const every = 1 + Math.floor(drive * 40);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 2; c++) {
        const ch = c ? R : L;
        const x = ch[i];
        let y;
        switch (type) {
          case 0: // soft
            y = Math.tanh(x * g) / Math.tanh(Math.min(g, 3));
            break;
          case 1: // hard
            y = Math.max(-1, Math.min(1, x * g)) * 0.8;
            break;
          case 2: // fold
            y = Math.sin(x * g * 1.3);
            break;
          case 3: {
            // tube: asymmetric soft clip
            const v = x * g;
            y = v >= 0 ? 1 - Math.exp(-v) : -0.7 * (1 - Math.exp(v / 0.7));
            break;
          }
          case 4: // bitcrush
            y = Math.round(x * q) / q;
            break;
          default: // downsample
            if (this.count % every === 0) this.hold[c] = x;
            y = this.hold[c];
        }
        ch[i] = x + (y - x) * mix;
      }
      this.count++;
    }
  }
}

// ------------------------------------------------------------------ chorus / flanger

export class Chorus {
  constructor(sr) {
    this.sr = sr;
    this.l = new DelayLine(Math.ceil(sr * 0.05));
    this.r = new DelayLine(Math.ceil(sr * 0.05));
    this.phase = 0;
  }
  process(L, R, n, p) {
    const inc = p.rate / this.sr;
    const base = 0.012 * this.sr;
    const depth = p.depth * 0.008 * this.sr;
    for (let i = 0; i < n; i++) {
      this.phase += inc;
      if (this.phase >= 1) this.phase -= 1;
      const dl = base + depth * (0.5 + 0.5 * Math.sin(TAU * this.phase));
      const dr = base + depth * (0.5 + 0.5 * Math.cos(TAU * this.phase));
      this.l.write(L[i]);
      this.r.write(R[i]);
      const wl = this.l.read(dl);
      const wr = this.r.read(dr);
      L[i] += (wl - L[i]) * p.mix * 0.5 + wr * p.mix * 0.25;
      R[i] += (wr - R[i]) * p.mix * 0.5 + wl * p.mix * 0.25;
    }
  }
}

export class Flanger {
  constructor(sr) {
    this.sr = sr;
    this.l = new DelayLine(Math.ceil(sr * 0.02));
    this.r = new DelayLine(Math.ceil(sr * 0.02));
    this.phase = 0;
    this.fl = 0;
    this.fr = 0;
  }
  process(L, R, n, p) {
    const inc = p.rate / this.sr;
    const base = 0.0008 * this.sr;
    const depth = p.depth * 0.006 * this.sr;
    for (let i = 0; i < n; i++) {
      this.phase += inc;
      if (this.phase >= 1) this.phase -= 1;
      const m = 0.5 - 0.5 * Math.cos(TAU * this.phase);
      const m2 = 0.5 - 0.5 * Math.cos(TAU * (this.phase + 0.25));
      this.l.write(L[i] + this.fl * p.fb);
      this.r.write(R[i] + this.fr * p.fb);
      this.fl = this.l.read(base + depth * m);
      this.fr = this.r.read(base + depth * m2);
      L[i] = L[i] * (1 - p.mix * 0.5) + this.fl * p.mix * 0.5;
      R[i] = R[i] * (1 - p.mix * 0.5) + this.fr * p.mix * 0.5;
    }
  }
}

// ------------------------------------------------------------------ phaser

export class Phaser {
  constructor(sr) {
    this.sr = sr;
    this.phase = 0;
    this.z = [new Float64Array(6), new Float64Array(6)];
    this.fb = [0, 0];
  }
  process(L, R, n, p) {
    const inc = p.rate / this.sr;
    for (let i = 0; i < n; i++) {
      this.phase += inc;
      if (this.phase >= 1) this.phase -= 1;
      for (let c = 0; c < 2; c++) {
        const ch = c ? R : L;
        const lfo = 0.5 - 0.5 * Math.cos(TAU * (this.phase + c * 0.25));
        const f = 200 * 2 ** (lfo * p.depth * 4.3); // 200 Hz .. ~4 kHz
        const t = Math.tan((Math.PI * Math.min(f, this.sr * 0.45)) / this.sr);
        const a = (t - 1) / (t + 1);
        const z = this.z[c];
        let x = ch[i] + this.fb[c] * p.fb;
        for (let s = 0; s < 6; s++) {
          const y = a * x + z[s];
          z[s] = x - a * y;
          x = y;
        }
        this.fb[c] = x;
        ch[i] = ch[i] * (1 - p.mix * 0.5) + x * p.mix * 0.5;
      }
    }
  }
}

// ------------------------------------------------------------------ delay

export class Delay {
  constructor(sr) {
    this.sr = sr;
    this.l = new DelayLine(Math.ceil(sr * 4.1));
    this.r = new DelayLine(Math.ceil(sr * 4.1));
    this.lpL = 0;
    this.lpR = 0;
    this.d = sr * 0.3;
  }
  process(L, R, n, p) {
    const target = Math.min(4 * this.sr, Math.max(1, p.seconds * this.sr));
    const a = Math.exp((-TAU * p.tone) / this.sr);
    for (let i = 0; i < n; i++) {
      this.d += (target - this.d) * 0.0005; // glide time changes instead of clicking
      const wl = this.l.read(this.d);
      const wr = this.r.read(this.d);
      this.lpL = wl + (this.lpL - wl) * a;
      this.lpR = wr + (this.lpR - wr) * a;
      if (p.pingpong) {
        // left input feeds the left line, which feeds back into the right one
        this.l.write((L[i] + R[i]) * 0.5 + this.lpR * p.fb);
        this.r.write(this.lpL * p.fb);
      } else {
        this.l.write(L[i] + this.lpL * p.fb);
        this.r.write(R[i] + this.lpR * p.fb);
      }
      L[i] += wl * p.mix;
      R[i] += wr * p.mix;
    }
  }
}

// ------------------------------------------------------------------ reverb (Freeverb)

class Comb {
  constructor(n) {
    this.buf = new Float32Array(n);
    this.i = 0;
    this.store = 0;
  }
  process(x, fb, damp) {
    const out = this.buf[this.i];
    this.store = out * (1 - damp) + this.store * damp;
    this.buf[this.i] = x + this.store * fb;
    if (++this.i >= this.buf.length) this.i = 0;
    return out;
  }
}
class Allpass {
  constructor(n) {
    this.buf = new Float32Array(n);
    this.i = 0;
  }
  process(x) {
    const b = this.buf[this.i];
    this.buf[this.i] = x + b * 0.5;
    if (++this.i >= this.buf.length) this.i = 0;
    return b - x;
  }
}

export class Reverb {
  constructor(sr) {
    const s = sr / 44100;
    const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
    const aps = [556, 441, 341, 225];
    this.cl = combs.map((c) => new Comb(Math.round(c * s)));
    this.cr = combs.map((c) => new Comb(Math.round((c + 23) * s)));
    this.al = aps.map((a) => new Allpass(Math.round(a * s)));
    this.ar = aps.map((a) => new Allpass(Math.round((a + 23) * s)));
  }
  process(L, R, n, p) {
    const fb = 0.7 + p.size * 0.28;
    const damp = p.damp * 0.4;
    const wet1 = (p.width / 2 + 0.5) * p.mix;
    const wet2 = ((1 - p.width) / 2) * p.mix;
    for (let i = 0; i < n; i++) {
      const input = (L[i] + R[i]) * 0.015;
      let ol = 0;
      let or = 0;
      for (let k = 0; k < 8; k++) {
        ol += this.cl[k].process(input, fb, damp);
        or += this.cr[k].process(input, fb, damp);
      }
      for (let k = 0; k < 4; k++) {
        ol = this.al[k].process(ol);
        or = this.ar[k].process(or);
      }
      L[i] = L[i] * (1 - p.mix * 0.5) + ol * wet1 + or * wet2;
      R[i] = R[i] * (1 - p.mix * 0.5) + or * wet1 + ol * wet2;
    }
  }
}

// ------------------------------------------------------------------ compressor / OTT

const dbToGain = (db) => 10 ** (db / 20);
const gainToDb = (g) => 20 * Math.log10(Math.max(1e-9, g));

export class Compressor {
  constructor(sr) {
    this.sr = sr;
    this.env = [-90, -90, -90]; // per band, in dB
    this.lp1 = [0, 0];
    this.lp2 = [0, 0];
  }
  coeff(seconds) {
    return Math.exp(-1 / (Math.max(0.0001, seconds) * this.sr));
  }
  process(L, R, n, p) {
    const atk = this.coeff(p.attack);
    const rel = this.coeff(p.release);
    const makeup = dbToGain(p.gain);
    if (p.mode === 0) {
      for (let i = 0; i < n; i++) {
        const lvl = gainToDb(Math.max(Math.abs(L[i]), Math.abs(R[i])));
        const e = this.env[0];
        this.env[0] = lvl > e ? lvl + (e - lvl) * atk : lvl + (e - lvl) * rel;
        const over = this.env[0] - p.thresh;
        const g = over > 0 ? dbToGain(-over * (1 - 1 / p.ratio)) * makeup : makeup;
        L[i] *= g;
        R[i] *= g;
      }
      return;
    }
    // "OTT": split into 3 bands; each gets pulled down above -20 dB and
    // pushed up below -40 dB, scaled by depth. Bands use simple one-pole
    // splits (not phase-perfect, but cheap and characterful).
    const aLow = Math.exp((-TAU * 120) / this.sr);
    const aHigh = Math.exp((-TAU * 2500) / this.sr);
    const depth = p.depth;
    const bandsL = (this.bandsL ??= [0, 0, 0]);
    const bandsR = (this.bandsR ??= [0, 0, 0]);
    for (let i = 0; i < n; i++) {
      let outL = 0;
      let outR = 0;
      for (let c = 0; c < 2; c++) {
        const x = c ? R[i] : L[i];
        this.lp1[c] = x + (this.lp1[c] - x) * aLow;
        this.lp2[c] = x + (this.lp2[c] - x) * aHigh;
        const low = this.lp1[c];
        const high = x - this.lp2[c];
        const mid = x - low - high;
        const b = c ? bandsR : bandsL;
        b[0] = low;
        b[1] = mid;
        b[2] = high;
      }
      for (let k = 0; k < 3; k++) {
        const lvl = gainToDb(Math.max(Math.abs(bandsL[k]), Math.abs(bandsR[k])));
        const e = this.env[k];
        this.env[k] = lvl > e ? lvl + (e - lvl) * atk : lvl + (e - lvl) * rel;
        let gdb = 0;
        if (this.env[k] > -20) gdb -= (this.env[k] + 20) * (1 - 1 / 8);
        else if (this.env[k] < -40 && this.env[k] > -80) gdb += Math.min(24, (-40 - this.env[k]) * (1 - 1 / 3));
        const g = dbToGain(gdb * depth);
        outL += bandsL[k] * g;
        outR += bandsR[k] * g;
      }
      L[i] = outL * makeup;
      R[i] = outR * makeup;
    }
  }
}

// ------------------------------------------------------------------ EQ

class Biquad {
  constructor() {
    this.b0 = 1;
    this.b1 = this.b2 = this.a1 = this.a2 = 0;
    this.z = [
      [0, 0],
      [0, 0],
    ];
  }
  /** RBJ cookbook: 'low' shelf, 'high' shelf or 'peak'. */
  set(type, sr, f, db, q = 0.8) {
    const A = 10 ** (db / 40);
    const w = (TAU * Math.min(f, sr * 0.45)) / sr;
    const cs = Math.cos(w);
    const sn = Math.sin(w);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'peak') {
      const alpha = sn / (2 * q);
      b0 = 1 + alpha * A;
      b1 = -2 * cs;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cs;
      a2 = 1 - alpha / A;
    } else {
      const alpha = (sn / 2) * Math.SQRT2;
      const sq = 2 * Math.sqrt(A) * alpha;
      if (type === 'low') {
        b0 = A * (A + 1 - (A - 1) * cs + sq);
        b1 = 2 * A * (A - 1 - (A + 1) * cs);
        b2 = A * (A + 1 - (A - 1) * cs - sq);
        a0 = A + 1 + (A - 1) * cs + sq;
        a1 = -2 * (A - 1 + (A + 1) * cs);
        a2 = A + 1 + (A - 1) * cs - sq;
      } else {
        b0 = A * (A + 1 + (A - 1) * cs + sq);
        b1 = -2 * A * (A - 1 + (A + 1) * cs);
        b2 = A * (A + 1 + (A - 1) * cs - sq);
        a0 = A + 1 - (A - 1) * cs + sq;
        a1 = 2 * (A - 1 - (A + 1) * cs);
        a2 = A + 1 - (A - 1) * cs - sq;
      }
    }
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
  }
  run(x, c) {
    const z = this.z[c];
    const y = this.b0 * x + z[0];
    z[0] = this.b1 * x - this.a1 * y + z[1];
    z[1] = this.b2 * x - this.a2 * y;
    return y;
  }
}

export class EQ {
  constructor(sr) {
    this.sr = sr;
    this.bands = [new Biquad(), new Biquad(), new Biquad()];
    this.key = '';
  }
  process(L, R, n, p) {
    const key = `${p.lowf}|${p.lowg}|${p.midf}|${p.midg}|${p.highf}|${p.highg}`;
    if (key !== this.key) {
      this.bands[0].set('low', this.sr, p.lowf, p.lowg);
      this.bands[1].set('peak', this.sr, p.midf, p.midg, 0.9);
      this.bands[2].set('high', this.sr, p.highf, p.highg);
      this.key = key;
    }
    for (let i = 0; i < n; i++) {
      let l = L[i];
      let r = R[i];
      for (const b of this.bands) {
        l = b.run(l, 0);
        r = b.run(r, 1);
      }
      L[i] = l;
      R[i] = r;
    }
  }
}
