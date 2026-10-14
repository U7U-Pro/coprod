// Vocalist: words -> phonemes -> syllables, and the singing engine, rendered
// offline and measured.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wordToPhonemes, rulesToPhonemes } from '../public/wam/vocalist/g2p.js';
import { syllabify, spellingSplit, lyricsToSyllables, singable, lyricSysex, parseLyricSysex, noteLyric } from '../public/wam/vocalist/lyrics.js';
import { VocalEngine } from '../public/wam/vocalist/engine.js';
import { TABLE } from '../public/wam/vocalist/params.js';
import { lfPeriod } from '../public/wam/vocalist/glottal.js';
import { fft } from '../public/wam/vertex/wavetables.js';

const SR = 48000;
const ph = (w) => wordToPhonemes(w).join(' ');

// ------------------------------------------------------------------ words

test('dictionary words, including irregular ones', () => {
  assert.equal(ph('love'), 'l ah v');
  assert.equal(ph('Heart'), 'hh aa r t');
  assert.equal(ph('one'), 'w ah n');
  assert.equal(ph('through'), 'th r uw');
  assert.equal(ph('I’m'), 'ay m');
  assert.equal(ph('7'), 's eh v ah n');
});

test('regular suffixes reuse the dictionary stem', () => {
  assert.equal(ph('dreaming'), 'd r iy m ih ng');
  assert.equal(ph('loved'), 'l ah v d');
  assert.equal(ph('kissed'), 'k ih s t');
  assert.equal(ph('waited'), 'w ey t ih d');
  assert.equal(ph('wishes'), 'w ih sh ih z');
  assert.equal(ph('cries'), 'k r ay z');
  assert.equal(ph('happily'), 'hh ae p ah l iy');
  assert.equal(ph('running'), 'r ah n ih ng');
  assert.equal(ph('heartless'), 'hh aa r t l ah s');
});

test('letter-to-sound rules for everything else', () => {
  const rule = (w) => rulesToPhonemes(w).join(' ');
  assert.equal(rule('make'), 'm ey k');
  assert.equal(rule('night'), 'n ay t');
  assert.equal(rule('phone'), 'f ow n');
  assert.equal(rule('nation'), 'n ey sh ah n');
  assert.equal(rule('city'), 's ih t iy');
  assert.equal(rule('window'), 'w ih n d ow');
  assert.equal(rule('spring'), 's p r ih ng');
  assert.equal(rule('cute'), 'k y uw t');
  assert.equal(rule('rule'), 'r uw l');
  assert.equal(rule('played'), 'p l ey d');
  assert.equal(rule('hoped'), 'hh ow p t');
  assert.equal(rule('melody'), 'm eh l ah d iy');
});

test('syllables follow English onsets; spelling is split to match', () => {
  assert.deepEqual(syllabify('b y uw t ah f ah l'.split(' ')), [['b', 'y', 'uw'], ['t', 'ah'], ['f', 'ah', 'l']]);
  assert.deepEqual(syllabify('eh k s t r ah'.split(' ')), [['eh', 'k'], ['s', 't', 'r', 'ah']]);
  assert.deepEqual(syllabify('hh ah l ow'.split(' ')), [['hh', 'ah'], ['l', 'ow']]);
  assert.deepEqual(syllabify(['m']), [['m']]);
  assert.deepEqual(spellingSplit('beautiful', 3), ['beau', 'ti', 'ful']);
  assert.deepEqual(spellingSplit('little', 2), ['lit', 'tle']);
  assert.deepEqual(spellingSplit('hello', 2), ['hel', 'lo']);
  assert.deepEqual(spellingSplit('singer', 2), ['sing', 'er']);
});

test('typed lyrics become one entry per note: hyphens, holds, [phonemes], punctuation', () => {
  const s = lyricsToSyllables('Hel-lo, world! I’m dream-ing - [s t aa r]');
  assert.deepEqual(
    s.map((x) => x.ly),
    ['Hel', 'lo', 'world', 'I’m', 'dream', 'ing', '-', 'staar'],
  );
  assert.equal(s[2].ph, 'w er l d');
  assert.equal(s[6].ph, '');
  assert.equal(s[7].ph, 's t aa r');
  // Without hyphens, words are split automatically.
  assert.deepEqual(lyricsToSyllables('beautiful').map((x) => x.ly), ['beau', 'ti', 'ful']);
  assert.deepEqual(lyricsToSyllables('  ...  ').length, 0);
});

test('what the synth sings for a note: syllables, holds, hums', () => {
  assert.deepEqual(singable('/s t aa r'), [{ on: ['s', 't'], nuc: 'aa', co: ['r'] }]);
  assert.deepEqual(singable('-'), { hold: true });
  assert.deepEqual(singable('mmm'), [{ on: [], nuc: 'm', co: [] }]);
  assert.equal(singable('beautiful').length, 3);
  assert.equal(singable(''), null);
});

test('lyric SysEx round-trips (and stays 7-bit)', () => {
  const bytes = lyricSysex('/l ah v', 64);
  assert.ok(bytes.every((b, i) => b < 0x80 || i === 0 || i === bytes.length - 1));
  assert.deepEqual(parseLyricSysex(bytes), { note: 64, text: '/l ah v' });
  assert.equal(parseLyricSysex(lyricSysex('café', 60)).text, 'cafe');
  assert.equal(noteLyric({ ly: 'love', ph: 'l ah v' }), '/l ah v');
  assert.equal(noteLyric({ ly: 'love' }), 'love');
  assert.equal(parseLyricSysex([0xf0, 0x43, 1, 0xf7]), null);
});

// ------------------------------------------------------------------ engine

test('the LF source gets breathier (weaker harmonics) as Rd rises', () => {
  const h12 = (Rd) => {
    const w = lfPeriod(Rd).wave;
    const re = Float64Array.from(w);
    const im = new Float64Array(w.length);
    fft(re, im);
    return 20 * Math.log10(Math.hypot(re[1], im[1]) / Math.hypot(re[2], im[2]));
  };
  assert.ok(h12(0.5) < 0 && h12(1.0) > 0 && h12(2.5) > 12, `${h12(0.5)} ${h12(1)} ${h12(2.5)}`);
});

function voice(set = {}) {
  const e = new VocalEngine(SR, 5);
  for (const [id, v] of Object.entries({ vibDepth: 0, scoop: 0, ...set })) {
    const p = TABLE.PARAMS[TABLE.INDEX[id]];
    e.setParam(TABLE.INDEX[id], p.unmap(v));
  }
  return e;
}

/** notes: [{ t, len, p, text }]; events are given to the engine ~0.1 s ahead, like the host does. */
function sing(e, notes, seconds) {
  const n = Math.round(seconds * SR);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const queue = [...notes].sort((a, b) => a.t - b.t);
  for (let off = 0; off < n; off += 32) {
    while (queue.length && queue[0].t - 0.1 <= off / SR) {
      const x = queue.shift();
      if (x.text != null) e.enqueue({ kind: 'lyric', time: x.t, note: x.p, text: x.text });
      e.enqueue({ kind: 'midi', time: x.t, bytes: [0x90, x.p, x.vel ?? 100] });
      if (x.len) e.enqueue({ kind: 'midi', time: x.t + x.len, bytes: [0x80, x.p, 0] });
    }
    e.render(L, R, off, Math.min(32, n - off), off);
  }
  return L;
}

const rms = (a, from, to) => {
  let s = 0;
  const i0 = Math.round(from * SR);
  const i1 = Math.round(to * SR);
  for (let i = i0; i < i1; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, i1 - i0));
};

/** Energy in a frequency band over a time window. */
function band(a, from, lo, hi, N = 8192) {
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const i0 = Math.round(from * SR);
  for (let i = 0; i < N; i++) re[i] = (a[i0 + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  fft(re, im);
  let s = 0;
  for (let k = Math.floor((lo * N) / SR); k < Math.ceil((hi * N) / SR); k++) s += re[k] * re[k] + im[k] * im[k];
  return s;
}

/** Pitch by autocorrelation: the first strong peak (later peaks are whole multiples of the period). */
function pitchOf(a, from) {
  const i0 = Math.round(from * SR);
  const ac = [];
  for (let l = 0; l < 800; l++) {
    let s = 0;
    for (let i = 0; i < 6000; i++) s += a[i0 + i] * a[i0 + i + l];
    ac.push(s);
  }
  const max = Math.max(...ac.slice(40));
  for (let l = 41; l < 799; l++) if (ac[l] > 0.85 * max && ac[l] >= ac[l - 1] && ac[l] >= ac[l + 1]) return SR / l;
  return 0;
}

test('sings in tune, and the Pitch knob transposes', () => {
  const a = sing(voice(), [{ t: 0.1, len: 1.2, p: 57, text: '/aa' }], 1.5);
  assert.ok(Math.abs(pitchOf(a, 0.6) - 220) < 2, `${pitchOf(a, 0.6)} Hz`);
  const b = sing(voice({ pitch: 12 }), [{ t: 0.1, len: 1.2, p: 45, text: '/aa' }], 1.5);
  assert.ok(Math.abs(pitchOf(b, 0.6) - 220) < 2);
});

test('vowels have their formants: "ee" high F2, "ah" high F1, "oo" both low', () => {
  const db = (x) => 10 * Math.log10(x);
  const regions = (v) => {
    const a = sing(voice({ formant: 0 }), [{ t: 0.1, len: 1.2, p: 48, text: `/${v}` }], 1.5);
    return {
      f1lo: db(band(a, 0.5, 200, 420)),
      f1hi: db(band(a, 0.5, 600, 900)),
      f2lo: db(band(a, 0.5, 800, 1300)),
      f2hi: db(band(a, 0.5, 2000, 2600)),
    };
  };
  const iy = regions('iy');
  const aa = regions('aa');
  const uw = regions('uw');
  assert.ok(iy.f2hi - iy.f2lo > 10 && iy.f1lo - iy.f1hi > 20, `ee ${JSON.stringify(iy)}`);
  assert.ok(aa.f2lo - aa.f2hi > 10 && aa.f1hi > aa.f1lo, `ah ${JSON.stringify(aa)}`);
  assert.ok(uw.f2lo - uw.f2hi > 15 && uw.f1lo - uw.f1hi > 15, `oo ${JSON.stringify(uw)}`);
});

test('Formant shifts the spectrum up; Breathiness adds noise between harmonics', () => {
  const centroid = (a) => {
    let num = 0;
    let den = 0;
    for (let f = 200; f < 5000; f += 100) {
      const e = band(a, 0.5, f, f + 100);
      num += e * (f + 50);
      den += e;
    }
    return num / den;
  };
  const low = sing(voice({ formant: -4 }), [{ t: 0.1, len: 1.2, p: 52, text: '/ae' }], 1.5);
  const high = sing(voice({ formant: 4 }), [{ t: 0.1, len: 1.2, p: 52, text: '/ae' }], 1.5);
  assert.ok(centroid(high) > centroid(low) * 1.25, `${centroid(low)} -> ${centroid(high)}`);

  // Noise floor between harmonics at 2-4 kHz (f0 = 110 Hz, so measure midway between).
  const between = (a) => {
    let s = 0;
    for (let h = 18; h < 36; h++) s += band(a, 0.5, h * 110 + 40, h * 110 + 70, 32768);
    let t = 0;
    for (let h = 18; h < 36; h++) t += band(a, 0.5, h * 110 - 8, h * 110 + 8, 32768);
    return s / t;
  };
  const clean = sing(voice({ breath: 0 }), [{ t: 0.1, len: 1.2, p: 45, text: '/aa' }], 1.5);
  const airy = sing(voice({ breath: 0.9 }), [{ t: 0.1, len: 1.2, p: 45, text: '/aa' }], 1.5);
  assert.ok(between(airy) > between(clean) * 4, `${between(clean)} -> ${between(airy)}`);
});

test('consonants come before the beat so the vowel lands on it', () => {
  const a = sing(voice(), [{ t: 0.5, len: 0.6, p: 57, text: '/s aa' }], 1.4);
  // "s": hiss (5-9 kHz) just before 0.5 s, little low-frequency energy.
  const hissBefore = band(a, 0.43, 5000, 9000, 2048);
  const hissAfter = band(a, 0.65, 5000, 9000, 2048);
  assert.ok(hissBefore > hissAfter * 5, `${hissBefore} vs ${hissAfter}`);
  // The vowel is fully on within ~40 ms of the beat, and not before ~20 ms ahead of it.
  assert.ok(rms(a, 0.52, 0.56) > 0.6 * rms(a, 0.7, 0.9));
  assert.ok(rms(a, 0.35, 0.4) < 0.01);
});

test('final consonants end the note; a "-" note holds the vowel with no gap', () => {
  const a = sing(voice({ release: 0.02 }), [{ t: 0.2, len: 0.6, p: 57, text: '/k ae t' }], 1.3);
  assert.ok(rms(a, 0.4, 0.6) > 0.02);
  assert.ok(rms(a, 0.95, 1.2) < 0.002, 'silent after the final t');

  const held = sing(voice(), [
    { t: 0.2, len: 0.5, p: 57, text: '/l aa' },
    { t: 0.7, len: 0.5, p: 60, text: '-' },
  ], 1.5);
  const mean = rms(held, 0.35, 1.1);
  for (let t = 0.6; t < 0.8; t += 0.01) assert.ok(rms(held, t, t + 0.01) > 0.6 * mean, `dip at ${t.toFixed(2)}`);
  assert.ok(Math.abs(pitchOf(held, 0.95) - 261.6) < 3, 'second note at C4');
});

test('notes without a lyric sing "ah"; stopping drops queued notes', () => {
  const e = voice();
  const a = sing(e, [{ t: 0.1, len: 0.4, p: 60 }], 0.8);
  assert.ok(rms(a, 0.2, 0.4) > 0.02);

  const f = voice({ release: 0.02 });
  const n = Math.round(1.5 * SR);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  f.enqueue({ kind: 'midi', time: 0.1, bytes: [0x90, 60, 100] });
  f.enqueue({ kind: 'midi', time: 1.0, bytes: [0x90, 64, 100] });
  for (let off = 0; off < n; off += 32) {
    if (off === Math.round(0.5 * SR / 32) * 32) f.clear();
    f.render(L, R, off, 32, off);
  }
  assert.ok(rms(L, 0.3, 0.45) > 0.02);
  assert.ok(rms(L, 0.7, 1.4) < 0.001, 'nothing after stop');
});

test('stays finite and bounded with extreme settings and odd lyrics', () => {
  const e = voice({ formant: 6, breath: 1, rough: 1, tension: 1, light: 0, opening: 1, gain: 12, vibDepth: 100, consonants: 1 });
  const words = ['/s t r ih ng z', 'mmm', '-', 'shh', '', 'xyzzy', '/', 'strengths', '[q]'];
  const a = sing(
    e,
    words.map((text, i) => ({ t: 0.1 + i * 0.07, len: 0.05 + (i % 3) * 0.1, p: 30 + i * 9, text })),
    1.5,
  );
  let peak = 0;
  for (const v of a) {
    assert.ok(Number.isFinite(v));
    peak = Math.max(peak, Math.abs(v));
  }
  assert.ok(peak <= 1);
});

test('renders well faster than real time', () => {
  const t0 = performance.now();
  sing(voice(), Array.from({ length: 16 }, (_, i) => ({ t: 0.1 + i * 0.25, len: 0.25, p: 60 + (i % 5), text: 'hello' })), 4.5);
  const ms = performance.now() - t0;
  assert.ok(ms < 1500, `${ms} ms for 4.5 s`);
});
