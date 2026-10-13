// Grains GUI: the sound with the grain cloud drawn live over it (click or
// drag to move the position), and the controls.

import { css, h, fitCanvas, controls, panel, peaks, drawPeaks, fileBar } from '../kit/ui.js';

const STYLE = `${css('gr', '#3ad5ff')}
.gr .gr-panels{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px}
.gr .gr-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.gr .gr-hold{touch-action:none}
`;

export function createGui(node) {
  const root = h('div', 'gr');
  root.append(Object.assign(h('style'), { textContent: STYLE }));
  let pk = null;
  let pkKey = '';

  const wave = h('div', 'k-wave');
  const cv = h('canvas');
  wave.append(cv);
  const bar = fileBar(node, 'GRAINS', wave);

  // Click or drag on the sound to set where grains come from.
  let dragging = false;
  const setPos = (e) => {
    const r = cv.getBoundingClientRect();
    node.set('position', Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
  };
  cv.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    cv.setPointerCapture(e.pointerId);
    setPos(e);
  });
  cv.addEventListener('pointermove', (e) => dragging && setPos(e));
  cv.addEventListener('pointerup', () => (dragging = false));

  // Hold to hear it (C4) without leaving the panel.
  const hold = h('button', 'gr-hold', '▶ Hold to play');
  hold.title = 'Plays C4 while held';
  const press = (on) => {
    hold.classList.toggle('on', on);
    node.scheduleEvents({ type: 'wam-midi', time: node.context.currentTime + 0.005, data: { bytes: on ? [0x90, 60, 100] : [0x80, 60, 0] } });
  };
  hold.addEventListener('pointerdown', (e) => {
    hold.setPointerCapture(e.pointerId);
    press(true);
  });
  for (const t of ['pointerup', 'pointercancel']) hold.addEventListener(t, () => hold.classList.contains('on') && press(false));
  const tools = h('div', 'gr-tools');
  tools.append(hold, h('span', 'k-hint', 'Click or drag on the sound to choose where grains come from. Play notes for pitch.'));

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
    const pos = node.real('position');
    const spray = node.real('spray') / a.duration;
    const size = node.real('size') / a.duration;
    g.fillStyle = '#3ad5ff1c';
    g.fillRect((pos - spray) * w, 0, (2 * spray + size) * w, ht);
    drawPeaks(g, pk, w, ht, '#5b6476');
    const st = node.status;
    g.fillStyle = '#3ad5ffcc';
    for (const x of st?.grains ?? []) {
      const y = ((x * 9973) % 1) * (ht - 12 * dpr) + 6 * dpr; // stable scatter
      g.beginPath();
      g.arc(x * w, y, 2.2 * dpr, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#ffffff';
    for (const x of st?.heads ?? []) g.fillRect(x * w, 0, Math.max(1, dpr), ht);
    g.fillStyle = node.autoValues.has('position') ? '#ff9e3d' : '#3ad5ff';
    g.fillRect(pos * w - dpr, 0, 2 * dpr, ht);
  }

  const panels = h('div', 'gr-panels');
  panels.append(
    panel('SOURCE', controls(node, ['position', 'scan', 'spray'])),
    panel('GRAINS', controls(node, ['size', 'density', 'jitter', 'window'])),
    panel('PITCH', controls(node, ['pitch', 'detune', 'reverse', 'keytrack'])),
    panel('ENVELOPE', controls(node, ['attack', 'release'])),
    panel('OUTPUT', controls(node, ['spread', 'gain'])),
  );
  root.append(bar, tools, wave, panels);

  let frame = 0;
  const redraw = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      draw();
    });
  };
  const listener = (kind) => {
    if (kind !== 'status') {
      for (const el of root.querySelectorAll('.k-knob, .k-sel')) el.draw?.();
      bar.refresh();
    }
    redraw();
  };
  node.listeners.add(listener);
  const resize = new ResizeObserver(redraw);
  resize.observe(cv);
  redraw();
  root.cleanup = () => {
    node.listeners.delete(listener);
    resize.disconnect();
    cancelAnimationFrame(frame);
    if (hold.classList.contains('on')) press(false);
  };
  return root;
}
