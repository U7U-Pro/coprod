// Lyrics -> syllables (one per note), and the small wire format that carries
// a note's lyric from the host to the synth.
//
// In typed lyrics:
//   hel-lo      a hyphen splits a word where you want (otherwise it's automatic)
//   -           on its own: hold the previous syllable over the next note (melisma)
//   [n ow]      exact phonemes (ARPAbet) for one note
//
// A note's lyric travels as MIDI SysEx just before its note-on:
//   F0 7D 4C 59 <note> <ASCII text> F7      (7D = non-commercial ID, "LY")
// The text is either words ("love") or "/" followed by phonemes ("/l ah v").

import { wordToPhonemes, VOWEL_PH, cleanWord } from './g2p.js';

export const CONSONANTS = ['b', 'ch', 'd', 'dh', 'f', 'g', 'hh', 'jh', 'k', 'l', 'm', 'n', 'ng', 'p', 'r', 's', 'sh', 't', 'th', 'v', 'w', 'y', 'z', 'zh'];
export const PHONEMES = new Set([...VOWEL_PH, ...CONSONANTS]);
export const isVowel = (p) => VOWEL_PH.has(p);

const ONSETS = new Set(
  [
    'p l', 'p r', 'b l', 'b r', 't r', 'd r', 'k l', 'k r', 'g l', 'g r', 'f l', 'f r', 'th r', 'sh r',
    's p', 's t', 's k', 's m', 's n', 's l', 's w', 's f', 't w', 'd w', 'k w', 'g w', 'th w',
    'p y', 'b y', 'f y', 'v y', 'm y', 'k y', 'g y', 'hh y', 'n y', 'l y',
    's p l', 's p r', 's t r', 's k r', 's k w', 's p y', 's k y', 's m y',
  ],
);
const legalOnset = (c) => c.length === 0 || (c.length === 1 ? c[0] !== 'ng' : ONSETS.has(c.join(' ')));

/** Split a word's phonemes into syllables (arrays), giving each vowel as long an onset as English allows. */
export function syllabify(ph) {
  const vowels = ph.map((p, i) => (isVowel(p) ? i : -1)).filter((i) => i >= 0);
  if (vowels.length <= 1) return ph.length ? [ph] : [];
  const out = [];
  let start = 0;
  for (let k = 0; k < vowels.length - 1; k++) {
    const a = vowels[k];
    const b = vowels[k + 1];
    const cluster = ph.slice(a + 1, b);
    let cut = 0;
    while (cut < cluster.length && !legalOnset(cluster.slice(cut))) cut++;
    const end = a + 1 + cut;
    out.push(ph.slice(start, end));
    start = end;
  }
  out.push(ph.slice(start));
  return out;
}

const DIGRAPH_LEFT = ['ck', 'ng', 'gh'];
const DIGRAPH = ['ch', 'sh', 'th', 'ph', 'wh', 'qu'];

/** Split a written word into n pieces for display ("beautiful", 3 -> beau|ti|ful). */
export function spellingSplit(word, n) {
  if (n <= 1 || word.length < 2) return [word];
  const low = word.toLowerCase();
  const vowelAt = (i) => 'aeiou'.includes(low[i]) || (low[i] === 'y' && i > 0 && !'aeiou'.includes(low[i + 1] ?? ''));
  // "-le" after a consonant is a syllable of its own (lit-tle, ta-ble)
  if (n >= 2 && /[^aeiouy]le$/.test(low) && word.length > 3) {
    const head = spellingSplit(word.slice(0, -3), n - 1);
    if (head.length === n - 1) return [...head, word.slice(-3)];
  }
  const groups = [];
  for (let i = 0; i < low.length; i++) {
    if (!vowelAt(i)) continue;
    const s = i;
    while (i + 1 < low.length && vowelAt(i + 1)) i++;
    groups.push([s, i + 1]);
  }
  // A final "e" (or "es"/"ed") after a consonant is usually silent.
  const last = groups.at(-1);
  if (groups.length > 1 && last && low.slice(last[0]).match(/^e[sd]?$/) && !vowelAt(last[0] - 1)) groups.pop();
  if (groups.length === n) {
    const cuts = [];
    for (let k = 0; k < n - 1; k++) {
      const from = groups[k][1];
      const to = groups[k + 1][0];
      const cl = low.slice(from, to);
      if (cl.length <= 1) cuts.push(from);
      else if (cl.length === 2 && DIGRAPH_LEFT.includes(cl)) cuts.push(to);
      else if (DIGRAPH.includes(cl.slice(0, 2)) && cl.length === 2) cuts.push(from);
      else if (DIGRAPH.includes(cl.slice(-2))) cuts.push(to - 2);
      else cuts.push(from + 1);
    }
    const pieces = [];
    let at = 0;
    for (const c of cuts) {
      pieces.push(word.slice(at, c));
      at = c;
    }
    pieces.push(word.slice(at));
    if (pieces.every(Boolean)) return pieces;
  }
  // Fallback: even pieces.
  const pieces = [];
  for (let k = 0; k < n; k++) pieces.push(word.slice(Math.round((k * word.length) / n), Math.round(((k + 1) * word.length) / n)));
  return pieces.filter(Boolean).length === n ? pieces : [word, ...Array(n - 1).fill('·')];
}

/** Valid phonemes from "[...]" text. */
export function parsePhonemes(text) {
  return String(text)
    .toLowerCase()
    .replace(/[0-9]/g, '') // CMU stress digits
    .split(/[\s,]+/)
    .filter((p) => PHONEMES.has(p));
}

const isHold = (t) => /^[-+~_]$/.test(t);

/**
 * Typed lyrics -> one entry per note: { ly (text shown on the note), ph (phonemes, may be '') }.
 * A held syllable (melisma) is { ly: '-', ph: '' }.
 */
export function lyricsToSyllables(text) {
  const out = [];
  for (const token of String(text).match(/\[[^\]]*\]|[^\s]+/g) ?? []) {
    if (isHold(token)) {
      out.push({ ly: '-', ph: '' });
      continue;
    }
    if (token.startsWith('[')) {
      const ph = parsePhonemes(token.slice(1, -1));
      if (ph.length) out.push({ ly: ph.join('').slice(0, 24), ph: ph.join(' ') });
      continue;
    }
    // Keep letters, digits, apostrophes and hyphens; drop other punctuation.
    const word = token.replace(/[^\p{L}\p{N}'’-]/gu, '').replace(/^[-']+|[-']+$/g, (m) => (m === "'" ? m : ''));
    if (!cleanWord(word)) continue;
    const pieces = word.split('-').filter((p) => cleanWord(p));
    if (pieces.length > 1) {
      const sylls = syllabify(wordToPhonemes(pieces.join('')));
      if (sylls.length === pieces.length) pieces.forEach((p, i) => out.push({ ly: p, ph: sylls[i].join(' ') }));
      else for (const p of pieces) out.push({ ly: p, ph: wordToPhonemes(p).join(' ') });
      continue;
    }
    const sylls = syllabify(wordToPhonemes(word));
    if (!sylls.length) continue;
    const spelled = spellingSplit(word, sylls.length);
    sylls.forEach((s, i) => out.push({ ly: spelled[i] ?? '·', ph: s.join(' ') }));
  }
  return out;
}

// ------------------------------------------------------------------ wire format

const ascii = (s) =>
  String(s)
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .slice(0, 120);

/** What to send for a note: its phonemes if known, else its text. Null when it has no lyric. */
export function noteLyric(n) {
  if (n?.ph) return `/${n.ph}`;
  return n?.ly ? n.ly : null;
}

export function lyricSysex(text, note) {
  const body = [...ascii(text)].map((c) => c.charCodeAt(0));
  return [0xf0, 0x7d, 0x4c, 0x59, note & 0x7f, ...body, 0xf7];
}

export function parseLyricSysex(bytes) {
  if (!bytes || bytes[0] !== 0xf0 || bytes[1] !== 0x7d || bytes[2] !== 0x4c || bytes[3] !== 0x59) return null;
  const end = bytes.indexOf(0xf7);
  const text = String.fromCharCode(...bytes.slice(5, end < 0 ? undefined : end));
  return { note: bytes[4], text };
}

// ------------------------------------------------------------------ for the synth

// Consonants that can carry a syllable on their own ("mmm", "shh"), best first.
const SUSTAIN = ['m', 'n', 'ng', 'l', 'r', 'z', 'v', 'zh', 's', 'sh', 'f', 'th'];

/**
 * A note's lyric as the synth sings it: null (no lyric), { hold: true } for a
 * melisma, or a list of syllables { on: [...], nuc: phoneme, co: [...] }.
 */
export function singable(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  if (isHold(t)) return { hold: true };
  const groups = t.startsWith('/')
    ? syllabify(parsePhonemes(t.slice(1)))
    : t
        .split(/\s+/)
        .flatMap((w) => (w.includes('-') ? w.split('-') : [w]))
        .flatMap((w) => syllabify(wordToPhonemes(w)));
  const out = [];
  for (const g of groups) {
    let v = g.findIndex(isVowel);
    if (v < 0) {
      // No vowel: hum or hiss the most sustainable consonant.
      const best = SUSTAIN.find((p) => g.includes(p));
      if (!best) {
        g.push('ah');
        v = g.length - 1;
      } else v = g.lastIndexOf(best);
    }
    out.push({ on: g.slice(0, v), nuc: g[v], co: g.slice(v + 1) });
  }
  return out.length ? out : null;
}
