// What each phoneme sounds like, as targets for the formant synthesizer, and
// how a syllable's consonants are laid out in time.
//
// A target holds: formants f1..f3 with bandwidths b1..b3 (Hz, adult male
// reference; the Formant knob scales them), voicing `av`, aspiration through
// the vocal tract `ah`, frication noise `af` with its spectrum (two bands
// fc/bw/g plus a flat part), nasal coupling `nas`, and how fast formants (tf)
// and amplitudes (ta) move toward it, in ms.

const base = { f1: 500, f2: 1500, f3: 2500, b1: 80, b2: 90, b3: 130, av: 0, ah: 0, af: 0, fc1: 3000, bw1: 1500, g1: 0, fc2: 6000, bw2: 2000, g2: 0, flat: 0, nas: 0, tf: 18, ta: 6 };
const T = (fields) => ({ ...base, ...fields });

const V = (f1, f2, f3, b1 = 80, b2 = 90, b3 = 130) => T({ f1, f2, f3, b1, b2, b3, av: 1 });

/** Vowels; diphthongs are [start, end]. */
export const VOWELS = {
  aa: V(730, 1090, 2440),
  ae: V(660, 1720, 2410),
  ah: V(640, 1190, 2390),
  ao: V(570, 840, 2410),
  eh: V(530, 1840, 2480),
  er: V(490, 1350, 1690, 80, 90, 110),
  ih: V(390, 1990, 2550, 60),
  iy: V(280, 2290, 3010, 50, 90, 160),
  uh: V(440, 1020, 2240, 70),
  uw: V(310, 870, 2240, 60, 80),
  ey: [V(500, 1840, 2480), V(330, 2200, 2700, 60)],
  ay: [V(730, 1150, 2450), V(380, 1980, 2550, 60)],
  aw: [V(700, 1200, 2450), V(420, 900, 2300, 60)],
  ow: [V(560, 950, 2400), V(400, 850, 2300, 60)],
  oy: [V(570, 840, 2410), V(360, 1900, 2550, 60)],
};

// Frication spectra: [fc1, bw1, g1, fc2, bw2, g2, flat]
const S_FRIC = [5800, 2200, 1, 8200, 3000, 0.55, 0.04];
const SH_FRIC = [2700, 900, 1, 4300, 1800, 0.5, 0.04];
const F_FRIC = [7000, 6000, 0.35, 3500, 3000, 0.15, 0.3];
const TH_FRIC = [6500, 5000, 0.4, 3000, 3000, 0.1, 0.22];
const fric = ([fc1, bw1, g1, fc2, bw2, g2, flat]) => ({ fc1, bw1, g1, fc2, bw2, g2, flat });

// Loci: where formants sit at each place of articulation.
const LABIAL = { f1: 250, f2: 900, f3: 2100 };
const DENTAL = { f1: 280, f2: 1400, f3: 2600 };
const ALVEOLAR = { f1: 260, f2: 1700, f3: 2600 };
const POSTALV = { f1: 280, f2: 1900, f3: 2700 };
const VELAR = { f1: 260, f2: 1900, f3: 2500 };

const STOP_BURST = {
  p: { place: LABIAL, fric: fric([1200, 1500, 0.6, 3500, 3000, 0.2, 0.25]), amp: 0.45, ms: 6 },
  b: { place: LABIAL, fric: fric([1200, 1500, 0.6, 3500, 3000, 0.2, 0.25]), amp: 0.25, ms: 5 },
  t: { place: ALVEOLAR, fric: fric([4500, 2500, 1, 7500, 3000, 0.6, 0.05]), amp: 0.55, ms: 10 },
  d: { place: ALVEOLAR, fric: fric([4500, 2500, 1, 7500, 3000, 0.6, 0.05]), amp: 0.3, ms: 7 },
  k: { place: VELAR, fric: fric([2400, 1000, 1, 4000, 2000, 0.3, 0.05]), amp: 0.5, ms: 14 },
  g: { place: VELAR, fric: fric([2400, 1000, 1, 4000, 2000, 0.3, 0.05]), amp: 0.3, ms: 10 },
};

/** Consonants that are a single steady sound. */
const STEADY = {
  m: { ...T({ f1: 260, f2: 1100, f3: 2200, b1: 60, b2: 300, b3: 300, av: 0.55, nas: 1 }), ms: 50 },
  n: { ...T({ f1: 260, f2: 1600, f3: 2600, b1: 60, b2: 300, b3: 300, av: 0.55, nas: 1 }), ms: 48 },
  ng: { ...T({ f1: 260, f2: 2000, f3: 2700, b1: 60, b2: 300, b3: 300, av: 0.5, nas: 1 }), ms: 50 },
  l: { ...T({ f1: 350, f2: 1050, f3: 2880, b1: 60, b2: 120, b3: 200, av: 0.75 }), ms: 45 },
  r: { ...T({ f1: 330, f2: 1100, f3: 1500, b1: 70, b2: 120, b3: 150, av: 0.75 }), ms: 50 },
  w: { ...T({ f1: 300, f2: 650, f3: 2150, b1: 60, b2: 90, b3: 150, av: 0.7 }), ms: 42 },
  y: { ...T({ f1: 270, f2: 2100, f3: 3000, b1: 50, b2: 120, b3: 200, av: 0.7 }), ms: 38 },
  s: { ...T({ ...ALVEOLAR, af: 0.55, ...fric(S_FRIC), ta: 5 }), ms: 75 },
  z: { ...T({ ...ALVEOLAR, af: 0.32, av: 0.4, ...fric(S_FRIC), ta: 5 }), ms: 60 },
  sh: { ...T({ ...POSTALV, af: 0.6, ...fric(SH_FRIC), ta: 5 }), ms: 80 },
  zh: { ...T({ ...POSTALV, af: 0.35, av: 0.4, ...fric(SH_FRIC), ta: 5 }), ms: 60 },
  f: { ...T({ ...LABIAL, af: 0.45, ...fric(F_FRIC), ta: 5 }), ms: 65 },
  v: { ...T({ ...LABIAL, af: 0.22, av: 0.5, ...fric(F_FRIC), ta: 5 }), ms: 45 },
  th: { ...T({ ...DENTAL, af: 0.35, ...fric(TH_FRIC), ta: 5 }), ms: 60 },
  dh: { ...T({ ...DENTAL, af: 0.14, av: 0.55, ...fric(TH_FRIC), ta: 5 }), ms: 35 },
};

export const SILENCE = T({ av: 0, ta: 12 });

/** Formant targets for a vowel (the start of a diphthong). */
export const vowelTarget = (p) => (Array.isArray(VOWELS[p]) ? VOWELS[p][0] : VOWELS[p] ?? VOWELS.ah);
/** The end of a vowel (a diphthong's glide, else the vowel). */
export const vowelEnd = (p) => (Array.isArray(VOWELS[p]) ? VOWELS[p][1] : VOWELS[p] ?? VOWELS.ah);
export const isDiphthong = (p) => Array.isArray(VOWELS[p]);

/** Can this consonant carry a held note on its own (a hummed "mmm")? */
export const sustainTarget = (p) => (STEADY[p] ? { ...STEADY[p], av: Math.max(STEADY[p].av, STEADY[p].af ? 0 : 0.7) } : null);

/**
 * A consonant cluster as timed segments: [{ t: target, ms }].
 * @param list      consonant phonemes
 * @param next      the vowel target after them (formants for h/aspiration/k), or null
 * @param onset     true before a vowel (stops are released and maybe aspirated)
 * @param amount    the Consonants knob, 0..1
 */
export function consonantSegments(list, next, onset, amount) {
  const dur = 0.7 + 0.5 * amount;
  const amp = 0.5 + 0.9 * amount;
  const out = [];
  const nextF = next ? { f1: next.f1, f2: next.f2, f3: next.f3, b1: next.b1, b2: next.b2, b3: next.b3 } : {};
  list.forEach((p, i) => {
    const prev = list[i - 1];
    const at = out.length;
    if (STEADY[p]) {
      const s = STEADY[p];
      out.push({ t: { ...s, af: s.af * amp }, ms: s.ms * dur });
    } else if (p === 'hh') {
      out.push({ t: T({ ...nextF, ah: 0.75 * amp, tf: 10, ta: 5 }), ms: 45 * dur });
    } else if (STOP_BURST[p] || p === 'ch' || p === 'jh') {
      const stop = p === 'ch' ? 't' : p === 'jh' ? 'd' : p;
      const b = STOP_BURST[stop];
      const voiced = 'bdg'.includes(stop);
      let place = b.place;
      // Before front vowels, k/g move forward (a higher F2).
      if (stop === 'k' || stop === 'g') place = { ...place, f2: Math.max(place.f2, (next?.f2 ?? 0) * 1.05) };
      const burstFric = stop === 'k' || stop === 'g' ? { ...b.fric, fc1: Math.max(1800, place.f2 * 1.15) } : b.fric;
      out.push({ t: T({ ...place, av: voiced ? 0.1 : 0, ta: 4, tf: 8 }), ms: (voiced ? 30 : 38) * dur });
      out.push({ t: T({ ...place, ...burstFric, af: b.amp * amp * (onset ? 1 : 0.6), av: voiced ? 0.15 : 0, ta: 0.7, tf: 8 }), ms: b.ms });
      if (p === 'ch') out.push({ t: { ...STEADY.sh, af: STEADY.sh.af * amp }, ms: 60 * dur });
      else if (p === 'jh') out.push({ t: { ...STEADY.zh, af: STEADY.zh.af * amp }, ms: 55 * dur });
      else if (onset && !voiced && prev !== 's' && next) {
        // Aspiration: breath through the opening vocal tract, formants already moving to the vowel.
        out.push({ t: T({ ...nextF, ah: 0.6 * amp, tf: 14, ta: 3 }), ms: 35 * dur });
      }
    }
    for (let j = at; j < out.length; j++) out[j].label = p;
  });
  return out;
}
