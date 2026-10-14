// English words -> ARPAbet phonemes.
//   1. the built-in dictionary (lexicon.js),
//   2. a dictionary word plus a regular suffix (dreaming = dream + ing),
//   3. letter-to-sound rules in the style of the NRL rules (Elovitz et al.,
//      1976): for each letter, the first rule whose text and left/right
//      context match wins.
// Context symbols in rules:
//   #  one or more vowels            :  zero or more consonants
//   ^  one consonant                 .  one voiced consonant (B D G J L M N R V W Z)
//   +  a front vowel (E I Y)         %  a suffix (ER E ES ED ING ELY), right context only
//   &  S C G Z X J CH SH             @  T S R D L Z N J TH CH SH
//   space  the start or end of the word

import { LEXICON } from './lexicon.js';

const VOWELS = 'AEIOUY';
const isVowel = (c) => VOWELS.includes(c);
const isConsonant = (c) => c >= 'A' && c <= 'Z' && !isVowel(c);
const VOICED = 'BDGJLMNRVWZ';
const FRONT = 'EIY';
const SUFFIXES = ['ELY', 'ING', 'ER', 'ES', 'ED', 'E'];

// [left context, letters, right context, phonemes]
const R = {
  A: [
    ['', 'A', ' ', 'ah'],
    [' ', 'ARE', ' ', 'aa r'],
    [' ', 'AR', 'O', 'ah r'],
    ['', 'AR', '#', 'eh r'],
    ['^', 'AS', '#', 'ey s'],
    ['', 'A', 'WA', 'ah'],
    ['', 'AW', '', 'ao'],
    [' :', 'ANY', '', 'eh n iy'],
    ['', 'A', '^+#', 'ey'],
    ['#:', 'ALLY', '', 'ah l iy'],
    [' ', 'AL', '#', 'ah l'],
    ['', 'AGAIN', '', 'ah g eh n'],
    ['#:', 'AG', 'E', 'ih jh'],
    ['', 'A', '^+:#', 'ae'],
    [' :', 'A', '^+ ', 'ey'],
    ['', 'A', '^%', 'ey'],
    [' ', 'ARR', '', 'ah r'],
    ['', 'ARR', '', 'ae r'],
    [' :', 'AR', ' ', 'aa r'],
    ['', 'AR', ' ', 'er'],
    ['', 'AR', '', 'aa r'],
    ['', 'AIR', '', 'eh r'],
    ['', 'AI', '', 'ey'],
    ['', 'AY', '', 'ey'],
    ['', 'AU', '', 'ao'],
    ['#:', 'AL', ' ', 'ah l'],
    ['#:', 'ALS', ' ', 'ah l z'],
    ['', 'ALK', '', 'ao k'],
    ['', 'AL', '^', 'ao l'],
    [' :', 'ABLE', '', 'ey b ah l'],
    ['', 'ABLE', '', 'ah b ah l'],
    ['', 'ANG', '+', 'ey n jh'],
    ['', 'ATION', '', 'ey sh ah n'],
    ['', 'A', '', 'ae'],
  ],
  B: [
    [' ', 'BE', '^#', 'b ih'],
    ['', 'BEING', '', 'b iy ih ng'],
    [' ', 'BOTH', ' ', 'b ow th'],
    [' ', 'BUS', '#', 'b ih z'],
    ['', 'BUIL', '', 'b ih l'],
    ['M', 'B', ' ', ''],
    ['', 'BB', '', 'b'],
    ['', 'B', '', 'b'],
  ],
  C: [
    [' ', 'CH', '^', 'k'],
    ['^E', 'CH', '', 'k'],
    ['', 'CH', '', 'ch'],
    [' S', 'CI', '#', 's ay'],
    ['', 'CI', 'A', 'sh'],
    ['', 'CI', 'O', 'sh'],
    ['', 'CI', 'EN', 'sh'],
    ['', 'C', '+', 's'],
    ['', 'CK', '', 'k'],
    ['', 'COM', '%', 'k ah m'],
    ['', 'CC', '+', 'k s'],
    ['', 'CC', '', 'k'],
    ['', 'C', '', 'k'],
  ],
  D: [
    ['#:', 'DED', ' ', 'd ih d'],
    ['.E', 'D', ' ', 'd'],
    ['#^:E', 'D', ' ', 't'],
    [' ', 'DE', '^#', 'd ih'],
    [' ', 'DO', ' ', 'd uw'],
    [' ', 'DOES', '', 'd ah z'],
    [' ', 'DOING', '', 'd uw ih ng'],
    [' ', 'DOW', '', 'd aw'],
    ['', 'DU', 'A', 'jh uw'],
    ['', 'DD', '', 'd'],
    ['', 'DGE', '', 'jh'],
    ['', 'D', '', 'd'],
  ],
  E: [
    ['#:', 'E', ' ', ''],
    [' :', 'E', ' ', 'iy'],
    ['#', 'ED', ' ', 'd'],
    ['#:', 'E', 'D ', ''],
    ['', 'EV', 'ER', 'eh v'],
    ['', 'E', '^%', 'iy'],
    ['', 'ERI', '#', 'iy r iy'],
    ['', 'ERI', '', 'eh r ih'],
    ['#:', 'ER', '#', 'er'],
    ['', 'ER', '#', 'eh r'],
    ['', 'ER', '', 'er'],
    [' ', 'EVEN', '', 'iy v ah n'],
    ['@', 'EW', '', 'uw'],
    ['', 'EW', '', 'y uw'],
    ['', 'E', 'O', 'iy'],
    ['#:&', 'ES', ' ', 'ih z'],
    ['#:', 'E', 'S ', ''],
    ['#:', 'ELY', ' ', 'l iy'],
    ['#:', 'EMENT', '', 'm ah n t'],
    ['', 'EFUL', '', 'f ah l'],
    ['', 'EE', '', 'iy'],
    ['', 'EARN', '', 'er n'],
    [' ', 'EAR', '^', 'er'],
    ['', 'EAD', '', 'eh d'],
    ['#:', 'EA', ' ', 'iy ah'],
    ['', 'EA', 'SU', 'eh'],
    ['', 'EAR', '', 'ih r'],
    ['', 'EA', '', 'iy'],
    ['', 'EIGH', '', 'ey'],
    ['', 'EI', '', 'iy'],
    [' ', 'EYE', '', 'ay'],
    ['', 'EY', '', 'iy'],
    ['', 'EU', '', 'y uw'],
    ['', 'E', '', 'eh'],
  ],
  F: [
    ['', 'FUL', '', 'f ah l'],
    ['', 'FF', '', 'f'],
    ['', 'F', '', 'f'],
  ],
  G: [
    ['', 'GIV', '', 'g ih v'],
    [' ', 'G', 'I^', 'g'],
    ['', 'GE', 'T', 'g eh'],
    ['SU', 'GGES', '', 'g jh eh s'],
    ['', 'GG', '', 'g'],
    [' B#', 'G', '', 'g'],
    ['', 'G', '+', 'jh'],
    ['', 'GREAT', '', 'g r ey t'],
    ['#', 'GH', '', ''],
    [' ', 'GN', '', 'n'],
    ['', 'GN', ' ', 'n'],
    ['', 'G', '', 'g'],
  ],
  H: [
    [' ', 'HAV', '', 'hh ae v'],
    [' ', 'HERE', '', 'hh ih r'],
    [' ', 'HOUR', '', 'aw er'],
    ['', 'HOW', '', 'hh aw'],
    ['', 'H', '#', 'hh'],
    ['', 'H', '', ''],
  ],
  I: [
    [' ', 'IN', '', 'ih n'],
    [' ', 'I', ' ', 'ay'],
    ['', 'IN', 'D ', 'ay n'],
    ['', 'IER', '', 'iy er'],
    ['#:R', 'IED', '', 'iy d'],
    ['', 'IED', ' ', 'ay d'],
    ['', 'IEN', '', 'iy eh n'],
    ['', 'IE', 'T', 'ay eh'],
    [' :', 'I', '%', 'ay'],
    ['', 'I', '%', 'iy'],
    ['', 'IE', '', 'iy'],
    ['', 'I', '^+:#', 'ih'],
    ['', 'IR', '#', 'ay r'],
    ['', 'IZ', '%', 'ay z'],
    ['', 'IS', '%', 'ay z'],
    ['', 'I', 'D%', 'ay'],
    ['+^', 'I', '^+', 'ih'],
    ['', 'I', 'T%', 'ay'],
    ['#:^', 'I', '^+', 'ih'],
    ['', 'I', '^E', 'ay'],
    ['', 'IR', '', 'er'],
    ['', 'IGH', '', 'ay'],
    ['', 'ILD', '', 'ay l d'],
    ['', 'IGN', ' ', 'ay n'],
    ['', 'IGN', '^', 'ay n'],
    ['', 'IGN', '%', 'ay n'],
    ['', 'IQUE', '', 'iy k'],
    ['', 'ION', '', 'y ah n'],
    ['', 'I', '', 'ih'],
  ],
  J: [['', 'J', '', 'jh']],
  K: [
    [' ', 'K', 'N', ''],
    ['', 'K', '', 'k'],
  ],
  L: [
    ['', 'LO', 'C#', 'l ow'],
    ['L', 'L', '', ''],
    ['#:^', 'L', '%', 'ah l'],
    ['', 'LEAD', '', 'l iy d'],
    ['^', 'LE', ' ', 'ah l'],
    ['', 'L', '', 'l'],
  ],
  M: [
    ['', 'MOV', '', 'm uw v'],
    ['', 'MM', '', 'm'],
    ['', 'M', '', 'm'],
  ],
  N: [
    ['E', 'NG', '+', 'n jh'],
    ['', 'NG', 'R', 'ng g'],
    ['', 'NG', '#', 'ng g'],
    ['', 'NGL', '%', 'ng g ah l'],
    ['', 'NG', '', 'ng'],
    ['', 'NK', '', 'ng k'],
    [' ', 'NOW', ' ', 'n aw'],
    ['', 'NN', '', 'n'],
    ['', 'N', '', 'n'],
  ],
  O: [
    ['', 'OF', ' ', 'ah v'],
    ['', 'OROUGH', '', 'er ow'],
    ['#:', 'OR', ' ', 'er'],
    ['#:', 'ORS', ' ', 'er z'],
    ['', 'OR', '', 'ao r'],
    [' ', 'ONE', '', 'w ah n'],
    ['', 'OWER', '', 'aw er'],
    ['', 'OWD', '', 'aw d'],
    ['', 'OW', '', 'ow'],
    [' ', 'OVER', '', 'ow v er'],
    ['', 'OV', '', 'ah v'],
    ['', 'O', '^%', 'ow'],
    ['', 'O', '^EN', 'ow'],
    ['', 'O', '^I#', 'ow'],
    ['', 'OL', 'D', 'ow l'],
    ['', 'OUGHT', '', 'ao t'],
    ['', 'OUGH', '', 'ah f'],
    [' ', 'OU', '', 'aw'],
    ['H', 'OU', 'S#', 'aw'],
    ['', 'OUS', '', 'ah s'],
    ['', 'OUR', '', 'ao r'],
    ['', 'OULD', '', 'uh d'],
    ['^', 'OU', '^L', 'ah'],
    ['', 'OUP', '', 'uw p'],
    ['', 'OU', '', 'aw'],
    ['', 'OY', '', 'oy'],
    ['', 'OING', '', 'ow ih ng'],
    ['', 'OI', '', 'oy'],
    ['', 'OOR', '', 'ao r'],
    ['', 'OOK', '', 'uh k'],
    ['', 'OOD', '', 'uh d'],
    ['', 'OO', '', 'uw'],
    ['', 'O', 'E', 'ow'],
    ['', 'O', ' ', 'ow'],
    ['', 'OA', '', 'ow'],
    [' ', 'ONLY', '', 'ow n l iy'],
    [' ', 'ONCE', '', 'w ah n s'],
    ['', "ON'T", '', 'ow n t'],
    ['C', 'O', 'N', 'aa'],
    ['', 'O', 'NG', 'ao'],
    [' :^', 'O', 'N', 'ah'],
    ['I', 'ON', '', 'ah n'],
    ['#:', 'ON', ' ', 'ah n'],
    ['#^', 'ON', '', 'ah n'],
    ['', 'O', 'ST ', 'ow'],
    ['', 'OF', '^', 'ao f'],
    ['', 'OTHER', '', 'ah dh er'],
    ['', 'OSS', ' ', 'ao s'],
    ['#:^', 'OM', '', 'ah m'],
    ['#:^', 'O', '^Y', 'ah'],
    ['', 'O', '^E ', 'ow'],
    ['', 'O', '', 'aa'],
  ],
  P: [
    ['', 'PH', '', 'f'],
    ['', 'PEOP', '', 'p iy p'],
    ['', 'POW', '', 'p aw'],
    ['', 'PUT', ' ', 'p uh t'],
    ['', 'PP', '', 'p'],
    ['', 'P', '', 'p'],
  ],
  Q: [
    ['', 'QUAR', '', 'k w ao r'],
    ['', 'QU', '', 'k w'],
    ['', 'Q', '', 'k'],
  ],
  R: [
    [' ', 'RE', '^#', 'r iy'],
    ['', 'RR', '', 'r'],
    ['', 'R', '', 'r'],
  ],
  S: [
    ['', 'SH', '', 'sh'],
    ['#', 'SION', '', 'zh ah n'],
    ['', 'SOME', '', 's ah m'],
    ['#', 'SUR', '#', 'zh er'],
    ['', 'SUR', '#', 'sh er'],
    ['#', 'SU', '#', 'zh uw'],
    ['#', 'SSU', '#', 'sh uw'],
    ['#', 'SED', ' ', 'z d'],
    ['', 'SSION', '', 'sh ah n'],
    ['^', 'SION', '', 'sh ah n'],
    ['#', 'S', '#', 'z'],
    ['', 'SAID', '', 's eh d'],
    ['', 'S', 'S', ''],
    ['.', 'S', ' ', 'z'],
    ['#:.E', 'S', ' ', 'z'],
    ['#:^##', 'S', ' ', 'z'],
    ['#:^#', 'S', ' ', 's'],
    ['U', 'S', ' ', 's'],
    [' :#', 'S', ' ', 'z'],
    [' ', 'SCH', '', 's k'],
    ['', 'S', 'C+', ''],
    ['#', 'SM', '', 'z m'],
    ['#', 'SN', "'", 'z ah n'],
    ['', 'S', '', 's'],
  ],
  T: [
    [' ', 'THE', ' ', 'dh ah'],
    ['', 'TO', ' ', 't uw'],
    ['', 'THAT', ' ', 'dh ae t'],
    [' ', 'THIS', ' ', 'dh ih s'],
    [' ', 'THEY', '', 'dh ey'],
    [' ', 'THERE', '', 'dh eh r'],
    ['', 'THER', '', 'dh er'],
    ['', 'THEIR', '', 'dh eh r'],
    [' ', 'THAN', ' ', 'dh ae n'],
    [' ', 'THEM', ' ', 'dh eh m'],
    ['', 'THESE', ' ', 'dh iy z'],
    [' ', 'THEN', '', 'dh eh n'],
    ['', 'THROUGH', '', 'th r uw'],
    ['', 'THOSE', '', 'dh ow z'],
    ['', 'THOUGH', ' ', 'dh ow'],
    [' ', 'THUS', '', 'dh ah s'],
    ['', 'TH', '', 'th'],
    ['#:', 'TED', ' ', 't ih d'],
    ['S', 'TI', '#N', 'ch'],
    ['', 'TI', 'O', 'sh'],
    ['', 'TI', 'A', 'sh'],
    ['', 'TIEN', '', 'sh ah n'],
    ['', 'TUR', '#', 'ch er'],
    ['', 'TU', 'A', 'ch uw'],
    [' ', 'TWO', '', 't uw'],
    ['', 'TCH', '', 'ch'],
    ['', 'TT', '', 't'],
    ['', 'T', '', 't'],
  ],
  U: [
    [' ', 'UN', 'I', 'y uw n'],
    [' ', 'UN', '', 'ah n'],
    [' ', 'UPON', '', 'ah p aa n'],
    ['@', 'UR', '#', 'uh r'],
    ['', 'UR', '#', 'y uh r'],
    ['', 'UR', '', 'er'],
    ['', 'U', '^ ', 'ah'],
    ['', 'U', '^^', 'ah'],
    ['', 'UY', '', 'ay'],
    [' G', 'U', '#', ''],
    ['G', 'U', '%', ''],
    ['G', 'U', '#', 'w'],
    ['#N', 'U', '', 'y uw'],
    ['@', 'U', '', 'uw'],
    ['', 'U', '', 'y uw'],
  ],
  V: [
    ['', 'VIEW', '', 'v y uw'],
    ['', 'V', '', 'v'],
  ],
  W: [
    [' ', 'WERE', '', 'w er'],
    ['', 'WA', 'S', 'w aa'],
    ['', 'WA', 'T', 'w aa'],
    ['', 'WHERE', '', 'w eh r'],
    ['', 'WHAT', '', 'w ah t'],
    ['', 'WHOL', '', 'hh ow l'],
    ['', 'WHO', '', 'hh uw'],
    ['', 'WH', '', 'w'],
    ['', 'WAR', '', 'w ao r'],
    ['', 'WOR', '^', 'w er'],
    ['', 'WR', '', 'r'],
    ['', 'W', '', 'w'],
  ],
  X: [
    [' ', 'X', '', 'z'],
    ['', 'X', '', 'k s'],
  ],
  Y: [
    ['', 'YOUNG', '', 'y ah ng'],
    [' ', 'YOU', '', 'y uw'],
    [' ', 'YES', '', 'y eh s'],
    [' ', 'Y', '', 'y'],
    ['#:^', 'Y', ' ', 'iy'],
    ['#:^', 'Y', 'I', 'iy'],
    [' :', 'Y', ' ', 'ay'],
    [' :', 'Y', '#', 'ay'],
    [' :', 'Y', '^+:#', 'ih'],
    [' :', 'Y', '^#', 'ay'],
    ['', 'Y', '', 'ih'],
  ],
  Z: [
    ['', 'ZZ', '', 'z'],
    ['', 'Z', '', 'z'],
  ],
};

/** Does `pattern` match the text to the right of position j? Returns true/false. */
function matchRight(pattern, text, j) {
  return right(pattern, 0, text, j);
}

function right(p, k, t, j) {
  if (k === p.length) return true;
  const c = p[k];
  const ch = t[j] ?? ' ';
  switch (c) {
    case '#': {
      if (!isVowel(ch)) return false;
      let n = j;
      while (isVowel(t[n] ?? ' ')) n++;
      // greedy, then back off
      for (let m = n; m > j; m--) if (right(p, k + 1, t, m)) return true;
      return false;
    }
    case ':': {
      let n = j;
      while (isConsonant(t[n] ?? ' ')) n++;
      for (let m = n; m >= j; m--) if (right(p, k + 1, t, m)) return true;
      return false;
    }
    case '^':
      return isConsonant(ch) && right(p, k + 1, t, j + 1);
    case '.':
      return VOICED.includes(ch) && ch !== ' ' && right(p, k + 1, t, j + 1);
    case '+':
      return FRONT.includes(ch) && ch !== ' ' && right(p, k + 1, t, j + 1);
    case '%':
      return SUFFIXES.some((s) => t.startsWith(s, j) && right(p, k + 1, t, j + s.length));
    case '&':
      if (t.startsWith('CH', j) || t.startsWith('SH', j)) return right(p, k + 1, t, j + 2);
      return 'SCGZXJ'.includes(ch) && ch !== ' ' && right(p, k + 1, t, j + 1);
    case '@':
      if (t.startsWith('TH', j) || t.startsWith('CH', j) || t.startsWith('SH', j)) return right(p, k + 1, t, j + 2);
      return 'TSRDLZNJ'.includes(ch) && ch !== ' ' && right(p, k + 1, t, j + 1);
    case ' ':
      return ch === ' ' && right(p, k + 1, t, j + 1);
    default:
      return ch === c && right(p, k + 1, t, j + 1);
  }
}

/** Does `pattern` match the text to the left of position i (read right to left)? */
function matchLeft(pattern, text, i) {
  return left(pattern, pattern.length - 1, text, i - 1);
}

function left(p, k, t, j) {
  if (k < 0) return true;
  const c = p[k];
  const ch = j >= 0 ? t[j] : ' ';
  switch (c) {
    case '#': {
      if (!isVowel(ch)) return false;
      let n = j;
      while (n >= 0 && isVowel(t[n])) n--;
      for (let m = n; m < j; m++) if (left(p, k - 1, t, m)) return true;
      return false;
    }
    case ':': {
      let n = j;
      while (n >= 0 && isConsonant(t[n])) n--;
      for (let m = n; m <= j; m++) if (left(p, k - 1, t, m)) return true;
      return false;
    }
    case '^':
      return isConsonant(ch) && left(p, k - 1, t, j - 1);
    case '.':
      return VOICED.includes(ch) && ch !== ' ' && left(p, k - 1, t, j - 1);
    case '+':
      return FRONT.includes(ch) && ch !== ' ' && left(p, k - 1, t, j - 1);
    case '&':
      if (j >= 1 && ['CH', 'SH'].includes(t.slice(j - 1, j + 1))) return left(p, k - 1, t, j - 2);
      return 'SCGZXJ'.includes(ch) && ch !== ' ' && left(p, k - 1, t, j - 1);
    case '@':
      if (j >= 1 && ['TH', 'CH', 'SH'].includes(t.slice(j - 1, j + 1))) return left(p, k - 1, t, j - 2);
      return 'TSRDLZNJ'.includes(ch) && ch !== ' ' && left(p, k - 1, t, j - 1);
    case ' ':
      return ch === ' ' && left(p, k - 1, t, j - 1);
    default:
      return ch === c && left(p, k - 1, t, j - 1);
  }
}

/** Letter-to-sound rules on one word (letters and apostrophes). */
export function rulesToPhonemes(word) {
  const t = ` ${word.toUpperCase().replace(/[^A-Z']/g, '')} `;
  const out = [];
  let i = 1;
  while (i < t.length - 1) {
    const ch = t[i];
    const rules = R[ch];
    if (!rules) {
      i++; // apostrophes and anything else are silent
      continue;
    }
    let done = false;
    for (const [l, m, r, ph] of rules) {
      if (!t.startsWith(m, i) || !matchLeft(l, t, i) || !matchRight(r, t, i + m.length)) continue;
      if (ph) out.push(...ph.split(' '));
      i += m.length;
      done = true;
      break;
    }
    if (!done) i++;
  }
  // Doubled letters can produce the same consonant twice: say it once.
  return out.filter((p, k) => k === 0 || p !== out[k - 1] || VOWEL_PH.has(p));
}

export const VOWEL_PH = new Set(['aa', 'ae', 'ah', 'ao', 'aw', 'ay', 'eh', 'er', 'ey', 'ih', 'iy', 'ow', 'oy', 'uh', 'uw']);
const VOICELESS = new Set(['p', 't', 'k', 'f', 'th', 's', 'sh', 'ch', 'hh']);
const SIBILANT = new Set(['s', 'z', 'sh', 'zh', 'ch', 'jh']);

// Regular suffixes on a dictionary stem: [suffix, stem candidates, phonemes after the stem].
const SUFFIX_RULES = [
  ["'s", (w) => [w], (ph) => plural(ph)],
  ["s'", (w) => [w], (ph) => plural(ph)],
  ['ies', (w) => [`${w}y`], (ph) => [...ph, 'z']],
  ['es', (w) => [w, `${w}e`], (ph) => plural(ph)],
  ['s', (w) => [w], (ph) => plural(ph)],
  ['ied', (w) => [`${w}y`], (ph) => [...ph, 'd']],
  ['ed', (w) => [w, `${w}e`, undouble(w)], (ph) => past(ph)],
  ['d', (w) => [w], (ph) => past(ph)],
  ['ing', (w) => [w, `${w}e`, undouble(w)], (ph) => [...ph, 'ih', 'ng']],
  ['in\'', (w) => [w, `${w}e`, undouble(w)], (ph) => [...ph, 'ih', 'n']],
  ['ly', (w) => [w, `${w}le`], (ph) => [...ph, 'l', 'iy']],
  ['ily', (w) => [`${w}y`], (ph) => [...ph.slice(0, -1), 'ah', 'l', 'iy']],
  ['er', (w) => [w, `${w}e`, undouble(w)], (ph) => [...ph, 'er']],
  ['est', (w) => [w, `${w}e`, undouble(w)], (ph) => [...ph, 'ah', 's', 't']],
  ['ness', (w) => [w], (ph) => [...ph, 'n', 'ah', 's']],
  ['ful', (w) => [w], (ph) => [...ph, 'f', 'ah', 'l']],
  ['less', (w) => [w], (ph) => [...ph, 'l', 'ah', 's']],
  ['y', (w) => [w, `${w}e`, undouble(w)], (ph) => [...ph, 'iy']],
];

function undouble(w) {
  return w.length > 2 && w.at(-1) === w.at(-2) ? w.slice(0, -1) : w;
}
function plural(ph) {
  const last = ph.at(-1);
  if (SIBILANT.has(last)) return [...ph, 'ih', 'z'];
  return [...ph, VOICELESS.has(last) ? 's' : 'z'];
}
function past(ph) {
  const last = ph.at(-1);
  if (last === 't' || last === 'd') return [...ph, 'ih', 'd'];
  return [...ph, VOICELESS.has(last) ? 't' : 'd'];
}

const NUMBERS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/** Clean a word for lookup: lower case letters, digits and apostrophes (curly quotes and accents straightened). */
export function cleanWord(word) {
  return String(word)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’‘`]/g, "'")
    .toLowerCase()
    .replace(/[^a-z0-9']/g, '');
}

/** Phonemes for one word, as an array. */
export function wordToPhonemes(raw) {
  let w = cleanWord(raw);
  if (/^\d+$/.test(w)) w = NUMBERS[+w] ?? w.split('').map((d) => NUMBERS[+d]).join(' ');
  if (w.includes(' ')) return w.split(' ').flatMap(wordToPhonemes);
  if (!w) return [];
  const hit = LEXICON.get(w) ?? LEXICON.get(w.replace(/'/g, ''));
  if (hit) return hit.split(' ');
  for (const [suf, stems, add] of SUFFIX_RULES) {
    if (!w.endsWith(suf) || w.length - suf.length < 2) continue;
    const base = w.slice(0, -suf.length);
    for (const stem of stems(base)) {
      const ph = LEXICON.get(stem);
      if (ph) return add(ph.split(' '));
    }
  }
  // Suffixes that never change the stem's sound: rules on the stem, then the suffix.
  for (const [suf, ph] of SAFE_SUFFIXES) {
    if (w.endsWith(suf) && w.length - suf.length >= 3) return [...wordToPhonemes(w.slice(0, -suf.length)), ...ph];
  }
  return rulesToPhonemes(w);
}

const SAFE_SUFFIXES = [
  ['ness', ['n', 'ah', 's']],
  ['less', ['l', 'ah', 's']],
  ['ful', ['f', 'ah', 'l']],
  ['ment', ['m', 'ah', 'n', 't']],
];
