// Vocalist GUI: the lyrics box (split into syllables as you type), buttons to
// put the syllables on the channel's notes or hear them, voice presets, and
// the voice knobs.

import { css, h, changed, controls, panel, noteName } from '../kit/ui.js';
import { VOICES } from './params.js';
import { lyricsToSyllables } from './lyrics.js';

const STYLE = `${css('vo', '#ff6bb5')}
.vo textarea{width:100%;min-height:64px;resize:vertical;background:#0c0f14;border:1px solid var(--line);border-radius:8px;padding:8px 10px;font:13px/1.45 Inter,system-ui,sans-serif;color:var(--txt);user-select:text}
.vo textarea:focus{outline:1px solid var(--acc);border-color:var(--acc)}
.vo .vo-syl{display:flex;flex-wrap:wrap;gap:4px;max-height:96px;overflow:auto}
.vo .vo-syl button{padding:2px 7px;border-radius:999px;font-size:11px}
.vo .vo-syl button.hold{color:var(--mut)}
.vo .vo-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.vo .vo-row .grow{flex:1}
.vo .vo-now{min-width:70px;color:var(--acc);font-weight:700;font-size:12px}
.vo .vo-panels{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:8px}
.vo .k-knob{width:68px}
.vo .k-knob span{max-width:72px}
.vo details summary{cursor:pointer;color:var(--mut)}
.vo .vo-ph{display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:2px 10px;margin-top:6px;color:var(--mut)}
.vo .vo-ph b{color:var(--txt);display:inline-block;min-width:22px}
`;

const PHONEME_HELP = [
  ['aa', 'father'], ['ae', 'cat'], ['ah', 'cut'], ['ao', 'law'], ['aw', 'cow'], ['ay', 'my'], ['eh', 'red'], ['er', 'bird'],
  ['ey', 'day'], ['ih', 'sit'], ['iy', 'see'], ['ow', 'go'], ['oy', 'boy'], ['uh', 'book'], ['uw', 'blue'],
  ['b', 'bee'], ['ch', 'chin'], ['d', 'day'], ['dh', 'the'], ['f', 'fun'], ['g', 'go'], ['hh', 'hat'], ['jh', 'joy'],
  ['k', 'key'], ['l', 'love'], ['m', 'me'], ['n', 'no'], ['ng', 'sing'], ['p', 'pay'], ['r', 'red'], ['s', 'sun'],
  ['sh', 'she'], ['t', 'tea'], ['th', 'thin'], ['v', 'very'], ['w', 'we'], ['y', 'yes'], ['z', 'zoo'], ['zh', 'vision'],
];

export function createGui(node) {
  const root = h('div', 'vo');
  root.append(Object.assign(h('style'), { textContent: STYLE }));

  // ---- top: name, voice presets, what's being sung
  const voice = h('select');
  voice.append(Object.assign(h('option', '', 'Voice preset…'), { value: '' }));
  VOICES.forEach((v, i) => voice.append(Object.assign(h('option', '', v.name), { value: i })));
  voice.onchange = () => {
    if (voice.value === '') return;
    node.applyVoice(+voice.value);
    voice.value = '';
    changed(voice);
  };
  const now = h('span', 'vo-now');
  const top = h('div', 'k-top');
  top.append(h('span', 'k-logo', 'VOCALIST'), h('span', 'grow'), now, voice);
  top.querySelector('.grow').style.flex = '1';

  // ---- lyrics
  const text = h('textarea');
  text.placeholder = 'Type lyrics here, e.g.\nHel-lo dar-kness my old friend';
  text.spellcheck = false;
  text.value = node.text;
  const chips = h('div', 'vo-syl');
  let syllables = [];
  const split = () => {
    syllables = lyricsToSyllables(text.value);
    chips.replaceChildren(
      ...syllables.slice(0, 400).map((s, i) => {
        const b = h('button', s.ly === '-' ? 'hold' : '', s.ly);
        b.title = s.ph ? `${s.ph}  (click to hear)` : 'Holds the previous syllable over this note';
        b.onclick = () => s.ph && node.singNote(s, 60 + [0, 2, 4, 7][i % 4]);
        return b;
      }),
    );
    count.textContent = syllables.length ? `${syllables.length} syllable${syllables.length === 1 ? '' : 's'}` : '';
  };
  const count = h('span', 'k-hint');
  let typing = 0;
  text.addEventListener('input', () => {
    node.text = text.value.slice(0, 4000);
    clearTimeout(typing);
    typing = setTimeout(split, 150);
  });

  const fill = h('select');
  fill.title = 'When there are more syllables than notes';
  fill.append(
    Object.assign(h('option', '', 'Extra syllables: split long notes'), { value: 'split' }),
    Object.assign(h('option', '', 'Extra syllables: add notes after'), { value: 'add' }),
  );
  fill.value = node.fill;
  fill.onchange = () => (node.fill = fill.value);
  const put = h('button', 'on', 'Put lyrics on notes');
  put.title = "Give each of this channel's notes in the current pattern one syllable, in time order";
  const msg = h('span', 'k-hint');
  put.onclick = () => {
    split();
    if (!syllables.length) {
      msg.textContent = 'Type some lyrics first.';
      return;
    }
    const ev = new CustomEvent('coprod:lyrics', { bubbles: true, cancelable: true, detail: { syllables, fill: node.fill } });
    root.dispatchEvent(ev);
    const r = ev.detail.result;
    if (!ev.defaultPrevented) msg.textContent = 'This host can’t write lyrics to notes; use “Sing it” to hear them.';
    else if (r) {
      const parts = [`${r.assigned} syllable${r.assigned === 1 ? '' : 's'} on notes`];
      if (r.split) parts.push(`split ${r.split} note${r.split === 1 ? '' : 's'}`);
      if (r.added) parts.push(`added ${r.added} note${r.added === 1 ? '' : 's'}`);
      if (r.dropped) parts.push(`${r.dropped} didn’t fit (patterns hold up to 4 bars)`);
      if (r.cleared) parts.push(`cleared ${r.cleared} extra note${r.cleared === 1 ? '' : 's'}`);
      msg.textContent = `${parts.join(' · ')}. Press play!`;
    }
  };
  const singBtn = h('button', '', '▶ Sing it');
  let singing = 0;
  singBtn.onclick = () => {
    if (singing) {
      clearTimeout(singing);
      singing = 0;
      node.stopSinging();
      singBtn.textContent = '▶ Sing it';
      return;
    }
    split();
    if (!syllables.length) return;
    const secs = node.sing(syllables);
    singBtn.textContent = '■ Stop';
    singing = setTimeout(() => {
      singing = 0;
      singBtn.textContent = '▶ Sing it';
    }, secs * 1000 + 400);
  };
  const actions = h('div', 'vo-row');
  actions.append(put, singBtn, fill, h('span', 'grow'), count);

  const help = h('details');
  const phs = h('div', 'vo-ph');
  for (const [p, ex] of PHONEME_HELP) {
    const d = h('span');
    d.append(h('b', '', p), ` ${ex}`);
    phs.append(d);
  }
  help.append(
    h('summary', '', 'How to write lyrics'),
    h('p', 'k-hint', 'Each syllable gets one note, in time order. Words are split automatically; add hyphens to choose (to-mor-row). A lone - holds the previous syllable over the next note. Write exact sounds in brackets: [n ow]. To change one note, turn on ✎ Lyrics in the piano roll (or Alt+click a note) and type.'),
    phs,
  );

  const lyricsPanel = h('div', 'k-p');
  const head = h('header');
  head.append(h('span', '', 'LYRICS'));
  lyricsPanel.append(head, text, chips, actions, msg, help);

  // ---- knobs
  const panels = h('div', 'vo-panels');
  panels.append(
    panel('VOICE', controls(node, ['pitch', 'formant', 'breath', 'light', 'tension', 'opening'])),
    panel('EXPRESSION', controls(node, ['vibDepth', 'vibRate', 'vibDelay', 'glide', 'scoop', 'rough'])),
    panel('ARTICULATION', controls(node, ['consonants', 'attack', 'release'])),
    panel('OUTPUT', controls(node, ['gain'])),
  );

  root.append(top, lyricsPanel, panels);

  // ---- updates
  const listener = (kind) => {
    if (kind === 'status') {
      const s = node.status;
      now.textContent = s?.ph ? `♪ ${s.ph}${s.note != null ? ` · ${noteName(s.note)}` : ''}` : '';
      return;
    }
    for (const el of root.querySelectorAll('.k-knob, .k-sel')) el.draw?.();
    if (kind === 'all') {
      if (document.activeElement !== text && text.value !== node.text) {
        text.value = node.text;
        split();
      }
      fill.value = node.fill;
    }
  };
  node.listeners.add(listener);
  split();
  root.cleanup = () => {
    node.listeners.delete(listener);
    clearTimeout(typing);
    clearTimeout(singing);
  };
  return root;
}
