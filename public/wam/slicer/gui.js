// Slicer GUI: the waveform with its slices (drag, add, remove), slicing
// tools, settings for the selected slice, and the global controls.

import { css, h, fitCanvas, changed, knob, controls, panel, peaks, drawPeaks, fileBar, noteName } from '../kit/ui.js';
import { ROOT, MAX_SLICES } from './params.js';

const STYLE = `${css('sl', '#ffb23f')}
.sl .sl-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sl .sl-tools input[type=range]{width:90px;accent-color:var(--acc)}
.sl .sl-tools label{display:flex;align-items:center;gap:6px;color:var(--mut)}
.sl .sl-grow{flex:1}
.sl .sl-panels{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px}
`;

const SLICE_COLORS = ['#ffb23f', '#3ad5ff', '#5ce1a3', '#ff6bb5', '#8f7bff', '#ff8a3d', '#b8f35d', '#4f8bff'];
const HANDLE = 6; // px either side of a slice line that grabs it

export function createGui(node) {
  const root = h('div', 'sl');
  root.append(Object.assign(h('style'), { textContent: STYLE }));
  let selected = 0;
  let pk = null; // cached peaks
  let pkKey = '';

  // ---- waveform
  const wave = h('div', 'k-wave');
  const cv = h('canvas');
  wave.append(cv);
  const bar = fileBar(node, 'SLICER', wave, () => {
    node.freshSound();
    selected = 0;
  });

  const tAt = (e) => {
    const r = cv.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * (node.audio?.duration ?? 0);
  };
  const markAt = (e) => {
    const a = node.audio;
    if (!a) return -1;
    const r = cv.getBoundingClientRect();
    let best = -1;
    let dist = HANDLE + 1;
    node.marks.forEach((m, i) => {
      const d = Math.abs((m.t / a.duration) * r.width - (e.clientX - r.left));
      if (i > 0 && d < dist) {
        best = i;
        dist = d;
      }
    });
    return best;
  };
  const sliceAt = (t) => Math.max(0, node.marks.findLastIndex((m) => m.t <= t));

  let drag = null;
  cv.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !node.audio) return;
    const m = markAt(e);
    if (m > 0) {
      drag = m;
      cv.setPointerCapture(e.pointerId);
      return;
    }
    selected = sliceAt(tAt(e));
    const s = node.slices()[selected];
    node.audition(ROOT + selected, Math.min(4, Math.max(0.05, s.end - s.t)));
    buildSlicePanel();
    draw();
  });
  cv.addEventListener('pointermove', (e) => {
    if (drag !== null) {
      node.moveMark(drag, tAt(e));
      return;
    }
    cv.style.cursor = markAt(e) > 0 ? 'ew-resize' : 'pointer';
  });
  cv.addEventListener('pointerup', () => (drag = null));
  cv.addEventListener('dblclick', (e) => {
    if (!node.audio || markAt(e) > 0) return;
    if (!node.addMark(tAt(e))) hint.textContent = `At most ${MAX_SLICES} slices.`;
    selected = sliceAt(tAt(e));
    buildSlicePanel();
    changed(cv);
  });
  cv.addEventListener('contextmenu', (e) => {
    const m = markAt(e);
    if (m <= 0) return;
    e.preventDefault();
    node.removeMark(m);
    selected = Math.min(selected, node.marks.length - 1);
    buildSlicePanel();
    changed(cv);
  });

  function draw() {
    const a = node.audio;
    const { w, h: ht, dpr } = fitCanvas(cv);
    const g = cv.getContext('2d');
    g.clearRect(0, 0, w, ht);
    if (!a) return;
    const key = `${a.name}:${a.L.length}:${w}`;
    if (key !== pkKey) {
      pk = peaks(a.L, a.R, w);
      pkKey = key;
    }
    const slices = node.slices();
    const x = (t) => (t / a.duration) * w;
    slices.forEach((s, i) => {
      const color = SLICE_COLORS[i % SLICE_COLORS.length];
      g.fillStyle = i === selected ? `${color}38` : i % 2 ? '#ffffff08' : '#00000000';
      g.fillRect(x(s.t), 0, x(s.end) - x(s.t), ht);
    });
    drawPeaks(g, pk, w, ht, '#8b93a5');
    g.font = `${10 * dpr}px Inter,system-ui,sans-serif`;
    slices.forEach((s, i) => {
      const color = SLICE_COLORS[i % SLICE_COLORS.length];
      const x0 = x(s.t);
      g.fillStyle = color;
      g.fillRect(x0, 0, Math.max(1, dpr), ht);
      g.fillRect(x0, 0, 6 * dpr, 6 * dpr);
      if (x(s.end) - x0 > 26 * dpr) {
        g.fillStyle = i === selected ? '#fff' : color;
        g.fillText(`${i + 1}${s.rev ? '◂' : ''}`, x0 + 4 * dpr, ht - 16 * dpr);
        g.fillStyle = '#8b93a5';
        g.fillText(noteName(ROOT + i), x0 + 4 * dpr, ht - 4 * dpr);
      }
    });
    for (const p of node.status?.playing ?? []) {
      g.fillStyle = '#ffffff';
      g.fillRect(p.x * w, 0, Math.max(1, dpr), ht);
    }
  }

  // ---- slicing tools
  const sens = Object.assign(h('input'), { type: 'range', min: 0, max: 1, step: 0.01, value: 0.5 });
  const byHits = h('button', '', 'Slice at hits');
  byHits.title = 'Find the hits (kicks, snares…) and cut there. Move the slider right to find quieter hits.';
  byHits.onclick = () => {
    node.autoSlice('transients', +sens.value);
    selected = 0;
    buildSlicePanel();
    changed(byHits);
  };
  const grid = h('select');
  grid.append(Object.assign(h('option', '', 'Equal slices…'), { value: '' }));
  for (const n of [2, 4, 8, 16, 32]) grid.append(Object.assign(h('option', '', `${n} slices`), { value: n }));
  grid.onchange = () => {
    if (!grid.value) return;
    node.autoSlice('grid', +grid.value);
    grid.value = '';
    selected = 0;
    buildSlicePanel();
    changed(grid);
  };
  const toRoll = h('button', '', 'To piano roll');
  toRoll.title = "Write notes into this pattern that play the slices in order (replaces this channel's notes in the pattern)";
  const hint = h('span', 'k-hint', 'Click a slice to hear it · double-click to cut · drag a line to move it · right-click a line to remove it');
  toRoll.onclick = () => {
    const notes = node.toNotes();
    const ev = new CustomEvent('coprod:notes', { bubbles: true, cancelable: true, detail: { notes } });
    root.dispatchEvent(ev);
    hint.textContent = ev.defaultPrevented ? `Wrote ${notes.length} notes: press play to hear the loop.` : 'This host can’t receive notes; play slices from C4 upward.';
  };
  const tools = h('div', 'sl-tools');
  const sensLabel = h('label', '', 'Sensitivity');
  sensLabel.append(sens);
  tools.append(byHits, sensLabel, grid, h('span', 'sl-grow'), toRoll);

  // ---- panels
  const panels = h('div', 'sl-panels');
  const slicePanelBox = h('div');
  const globals = [
    panel('PLAYBACK', controls(node, ['pitch', 'sync', 'mode', 'choke'])),
    panel('ENVELOPE', controls(node, ['attack', 'release', 'vel'])),
    panel('FILTER', controls(node, ['cutoff', 'reso'])),
    panel('OUTPUT', controls(node, ['gain'])),
  ];
  panels.append(slicePanelBox, ...globals);

  function buildSlicePanel() {
    const i = Math.min(selected, node.marks.length - 1);
    const m = () => node.marks[i] ?? node.marks[0];
    const custom = (label, key, lo, hi, def, fmt, step = 0) => ({
      label,
      def: (def - lo) / (hi - lo),
      get: () => (m()[key] - lo) / (hi - lo),
      set: (n) => {
        let v = lo + n * (hi - lo);
        if (step) v = Math.round(v / step) * step;
        node.setSlice(i, { [key]: v });
      },
      format: (n) => fmt(lo + n * (hi - lo)),
    });
    const rev = h('button', m().rev ? 'on' : '', 'Reverse');
    rev.onclick = () => {
      node.setSlice(i, { rev: !m().rev });
      rev.classList.toggle('on', m().rev);
      changed(rev);
    };
    const play = h('button', '', '▶');
    play.title = 'Play this slice';
    play.onclick = () => {
      const s = node.slices()[i];
      node.audition(ROOT + i, Math.min(4, Math.max(0.05, s.end - s.t)));
    };
    slicePanelBox.replaceChildren(
      panel(
        `SLICE ${i + 1} · ${noteName(ROOT + i)}`,
        [
          knob(node, custom('Gain', 'g', -36, 12, 0, (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`)),
          knob(node, custom('Pan', 'pan', -1, 1, 0, (v) => (Math.abs(v) < 0.02 ? 'C' : `${Math.round(Math.abs(v) * 100)}${v < 0 ? 'L' : 'R'}`))),
          knob(node, custom('Pitch', 'pt', -24, 24, 0, (v) => `${Math.round(v) > 0 ? '+' : ''}${Math.round(v)} st`, 1)),
          rev,
        ],
        [play],
      ),
    );
  }

  root.append(bar, tools, wave, hint, panels);

  // ---- updates
  let frame = 0;
  const redraw = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      draw();
    });
  };
  const redrawControls = () => {
    for (const el of root.querySelectorAll('.k-knob, .k-sel')) el.draw?.();
  };
  const listener = (kind) => {
    if (kind === 'status') return redraw();
    if (kind === 'param' || kind === 'automation') return redrawControls();
    if (kind === 'slices' || kind === 'all' || kind === 'sample') {
      if (selected >= node.marks.length) selected = 0;
      if (kind !== 'slices') buildSlicePanel();
      redrawControls();
    }
    bar.refresh();
    redraw();
  };
  node.listeners.add(listener);
  const resize = new ResizeObserver(redraw);
  resize.observe(cv);
  buildSlicePanel();
  redraw();
  root.cleanup = () => {
    node.listeners.delete(listener);
    resize.disconnect();
    cancelAnimationFrame(frame);
  };
  return root;
}
