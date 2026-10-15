// Built-in instruments, synthesized with the Web Audio API. Everyone in a
// room hears exactly the same sound because nothing depends on plugins or
// samples someone else might not have.
//
// Each instrument: (ctx, out, time, { pitch, vel, dur }) => void
// (pitch bend and a note's slide reach the oscillators through play()).

const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);

let noiseBuffer = null;
function noise(ctx) {
  if (!noiseBuffer || noiseBuffer.sampleRate !== ctx.sampleRate) {
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuffer.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  return src;
}

/** Gain node with an attack/decay envelope that ends at `end`. */
function env(ctx, time, peak, attack, end) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(peak, time + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, end);
  return g;
}

/** Envelope that holds for `dur`, then releases (for sustained notes). */
function adsr(ctx, time, peak, { a = 0.005, d = 0.1, s = 0.7, r = 0.1 }, dur) {
  const g = ctx.createGain();
  const p = g.gain;
  p.setValueAtTime(0, time);
  p.linearRampToValueAtTime(peak, time + a);
  p.setTargetAtTime(peak * s, time + a, d / 3);
  p.setValueAtTime(peak * s, time + Math.max(dur, a));
  p.setTargetAtTime(0, time + Math.max(dur, a), r / 4);
  return g;
}

// The engine sets these around each note so its oscillators (and noise
// players) follow the channel's pitch-bend signal, in cents, and the note's
// own pitch slide: [[time, cents], ...] ramped between.
let bend = null;
let slide = null;
export function setBend(node) {
  bend = node;
}
export function setSlide(points) {
  slide = points;
}

/** Ramp an AudioParam (in cents, on top of its current value) along a slide. */
export function applySlide(param, points) {
  if (!points?.length) return;
  const base = param.value;
  param.setValueAtTime(base + points[0][1], points[0][0]);
  for (let i = 1; i < points.length; i++) param.linearRampToValueAtTime(base + points[i][1], points[i][0]);
}

function play(src, time, stopAt) {
  if (bend && src.detune) {
    const b = bend;
    b.connect(src.detune);
    src.addEventListener('ended', () => {
      try {
        b.disconnect(src.detune);
      } catch {}
    });
  }
  if (slide && src.detune) applySlide(src.detune, slide);
  src.start(time);
  src.stop(stopAt);
}

export const instruments = {
  kick(ctx, out, t, { vel }) {
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    const g = env(ctx, t, vel, 0.002, t + 0.45);
    o.connect(g).connect(out);
    play(o, t, t + 0.5);
  },

  snare(ctx, out, t, { vel }) {
    const n = noise(ctx);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1200;
    n.connect(hp).connect(env(ctx, t, vel * 0.7, 0.001, t + 0.2)).connect(out);
    play(n, t, t + 0.25);
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(220, t);
    o.frequency.exponentialRampToValueAtTime(160, t + 0.08);
    o.connect(env(ctx, t, vel * 0.6, 0.001, t + 0.12)).connect(out);
    play(o, t, t + 0.15);
  },

  clap(ctx, out, t, { vel }) {
    const n = noise(ctx);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1400;
    bp.Q.value = 0.9;
    const g = ctx.createGain();
    // Three quick slaps and a tail: the classic drum-machine clap.
    g.gain.setValueAtTime(0, t);
    for (const k of [0, 0.011, 0.022]) {
      g.gain.setValueAtTime(vel, t + k);
      g.gain.exponentialRampToValueAtTime(0.05, t + k + 0.009);
    }
    g.gain.setValueAtTime(vel * 0.8, t + 0.033);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    n.connect(bp).connect(g).connect(out);
    play(n, t, t + 0.3);
  },

  hat(ctx, out, t, { vel }) {
    const n = noise(ctx);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7500;
    n.connect(hp).connect(env(ctx, t, vel * 0.45, 0.001, t + 0.05)).connect(out);
    play(n, t, t + 0.07);
  },

  openhat(ctx, out, t, { vel }) {
    const n = noise(ctx);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 6500;
    n.connect(hp).connect(env(ctx, t, vel * 0.4, 0.002, t + 0.32)).connect(out);
    play(n, t, t + 0.35);
  },

  perc(ctx, out, t, { vel }) {
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(520, t);
    o.frequency.exponentialRampToValueAtTime(280, t + 0.06);
    o.connect(env(ctx, t, vel * 0.7, 0.001, t + 0.14)).connect(out);
    play(o, t, t + 0.16);
  },

  bass(ctx, out, t, { pitch, vel, dur }) {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = hz(pitch);
    const sub = ctx.createOscillator();
    sub.type = 'square';
    sub.frequency.value = hz(pitch - 12);
    const subGain = ctx.createGain();
    subGain.gain.value = 0.35;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 7;
    lp.frequency.setValueAtTime(1600, t);
    lp.frequency.setTargetAtTime(220, t, 0.08);
    const g = adsr(ctx, t, vel * 0.5, { a: 0.004, d: 0.15, s: 0.75, r: 0.06 }, dur);
    o.connect(lp);
    sub.connect(subGain).connect(lp);
    lp.connect(g).connect(out);
    play(o, t, t + dur + 0.2);
    play(sub, t, t + dur + 0.2);
  },

  lead(ctx, out, t, { pitch, vel, dur }) {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3200;
    lp.Q.value = 2;
    const g = adsr(ctx, t, vel * 0.22, { a: 0.01, d: 0.2, s: 0.8, r: 0.15 }, dur);
    for (const cents of [-8, 8]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = hz(pitch);
      o.detune.value = cents;
      o.connect(lp);
      play(o, t, t + dur + 0.3);
    }
    lp.connect(g).connect(out);
  },

  pluck(ctx, out, t, { pitch, vel, dur }) {
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = hz(pitch);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(5000, t);
    lp.frequency.setTargetAtTime(300, t, 0.05);
    const end = t + Math.min(dur, 0.6) + 0.25;
    o.connect(lp).connect(env(ctx, t, vel * 0.3, 0.002, end)).connect(out);
    play(o, t, end + 0.05);
  },

  keys(ctx, out, t, { pitch, vel, dur }) {
    const g = adsr(ctx, t, vel * 0.3, { a: 0.003, d: 0.6, s: 0.35, r: 0.3 }, dur);
    const tine = ctx.createOscillator();
    tine.type = 'sine';
    tine.frequency.value = hz(pitch + 12);
    const tineGain = env(ctx, t, 0.25, 0.002, t + 0.25);
    const body = ctx.createOscillator();
    body.type = 'triangle';
    body.frequency.value = hz(pitch);
    body.connect(g);
    tine.connect(tineGain).connect(g);
    g.connect(out);
    play(body, t, t + dur + 0.6);
    play(tine, t, t + 0.3);
  },

  pad(ctx, out, t, { pitch, vel, dur }) {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1400;
    const g = adsr(ctx, t, vel * 0.14, { a: 0.35, d: 0.4, s: 0.9, r: 0.8 }, dur);
    for (const [cents, oct] of [
      [-10, 0],
      [10, 0],
      [0, 12],
    ]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = hz(pitch + oct);
      o.detune.value = cents;
      o.connect(lp);
      play(o, t, t + dur + 1);
    }
    lp.connect(g).connect(out);
  },
};
