// Shared GUI pieces for the sample plugins: plain DOM + canvas, no framework.
// Every edit ends in a DOM event inside the GUI (pointerup, change, …) so the
// host notices and shares the plugin's new state.

import { isAudioFile } from './node.js';

export const css = (prefix, accent) => `
.${prefix}{--bg:#12151b;--panel:#1a1e26;--panel2:#212631;--line:#2b313d;--txt:#e6e9f0;--mut:#8b93a5;--acc:${accent};
  font:11px/1.3 Inter,system-ui,sans-serif;color:var(--txt);background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:10px;
  display:flex;flex-direction:column;gap:10px;user-select:none;min-width:0}
.${prefix} *{box-sizing:border-box}
.${prefix} button,.${prefix} select,.${prefix} input{font:inherit;color:inherit}
.${prefix} button{background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:4px 9px;cursor:pointer}
.${prefix} button:hover{border-color:var(--acc)}
.${prefix} button.on{background:var(--acc);border-color:var(--acc);color:#111}
.${prefix} select{background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:3px 6px}
.${prefix} .k-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.${prefix} .k-logo{font-weight:800;letter-spacing:.2em;font-size:13px;color:var(--acc)}
.${prefix} .k-file{flex:1;min-width:120px;color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.${prefix} .k-file b{color:var(--txt)}
.${prefix} .k-err{color:#ff6b6b}
.${prefix} .k-wave{position:relative;background:#0c0f14;border-radius:8px;border:1px solid var(--line)}
.${prefix} .k-wave canvas{display:block;width:100%;height:150px;touch-action:none}
.${prefix} .k-wave.drop{outline:2px dashed var(--acc);outline-offset:-2px}
.${prefix} .k-hint{color:var(--mut);font-size:10px}
.${prefix} .k-row{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start}
.${prefix} .k-p{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:8px;display:flex;flex-direction:column;gap:6px;min-width:0}
.${prefix} .k-p header{display:flex;align-items:center;gap:6px;letter-spacing:.12em;font-size:10px;color:var(--mut);font-weight:700}
.${prefix} .k-p header .grow{flex:1}
.${prefix} .k-knobs{display:flex;flex-wrap:wrap;gap:4px 6px;align-items:flex-start}
.${prefix} .k-knob{display:flex;flex-direction:column;align-items:center;width:54px;gap:1px;cursor:ns-resize;touch-action:none;border-radius:6px}
.${prefix} .k-knob canvas{width:40px;height:40px}
.${prefix} .k-knob span,.${prefix} .k-sel span{font-size:9px;color:var(--mut);text-transform:uppercase;letter-spacing:.05em;white-space:nowrap;overflow:hidden;max-width:64px;text-overflow:ellipsis}
.${prefix} .k-knob output{font-size:9px;font-variant-numeric:tabular-nums;white-space:nowrap}
.${prefix} .k-knob.auto output{color:#ff9e3d}
.${prefix} .k-sel{display:flex;flex-direction:column;gap:3px;padding-top:2px}
`;

export const h = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export function fitCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(c.clientWidth * dpr));
  const ht = Math.max(1, Math.round(c.clientHeight * dpr));
  if (c.width !== w || c.height !== ht) {
    c.width = w;
    c.height = ht;
  }
  return { w, h: ht, dpr };
}

/** Tell the host this GUI changed the plugin's settings. */
export const changed = (el) => el.dispatchEvent(new Event('change', { bubbles: true }));

/**
 * A knob. `source` is either a parameter id on `node`, or a custom
 * { label, get(), set(n), format(n), def } for things that aren't host params.
 */
export function knob(node, source) {
  const custom = typeof source === 'object';
  const p = custom ? source : node.param(source);
  const get = custom ? () => source.get() : () => node.shown(source);
  const set = custom ? (n) => source.set(n) : (n) => node.set(source, n);
  const fmt = custom ? (n) => source.format(n) : (n) => p.format(p.map(n));
  const def = custom ? source.def : p.def;
  const el = h('div', 'k-knob');
  const cv = h('canvas');
  const out = h('output');
  el.append(cv, h('span', '', p.label), out);
  el.title = `${p.label}: drag up/down (Shift for fine), double-click to reset`;
  let drag = null;
  cv.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    cv.setPointerCapture(e.pointerId);
    drag = { y: e.clientY, v: custom ? get() : node.get(source) };
  });
  cv.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const scale = e.shiftKey ? 1000 : 180;
    set(Math.min(1, Math.max(0, drag.v + (drag.y - e.clientY) / scale)));
    draw();
  });
  const end = () => (drag = null);
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
  cv.addEventListener('dblclick', () => {
    set(def);
    draw();
    changed(el);
  });
  cv.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      set(Math.min(1, Math.max(0, (custom ? get() : node.get(source)) - Math.sign(e.deltaY) * 0.02)));
      draw();
    },
    { passive: false },
  );
  function draw() {
    const v = get();
    const { w, h: ht, dpr } = fitCanvas(cv);
    const g = cv.getContext('2d');
    g.clearRect(0, 0, w, ht);
    const cx = w / 2;
    const cy = ht / 2;
    const r = Math.min(w, ht) / 2 - 4 * dpr;
    const a0 = Math.PI * 0.75;
    const a1 = a0 + Math.PI * 1.5 * v;
    g.lineWidth = 3.5 * dpr;
    g.lineCap = 'round';
    g.strokeStyle = '#2b313d';
    g.beginPath();
    g.arc(cx, cy, r, a0, a0 + Math.PI * 1.5);
    g.stroke();
    const auto = !custom && node.autoValues.has(source);
    g.strokeStyle = auto ? '#ff9e3d' : getComputedStyle(el).getPropertyValue('--acc') || '#fff';
    g.beginPath();
    g.arc(cx, cy, r, a0, a1);
    g.stroke();
    g.fillStyle = '#e6e9f0';
    g.beginPath();
    g.arc(cx + Math.cos(a1) * r * 0.55, cy + Math.sin(a1) * r * 0.55, 2.2 * dpr, 0, Math.PI * 2);
    g.fill();
    out.textContent = fmt(v);
    el.classList.toggle('auto', auto);
  }
  el.draw = draw;
  requestAnimationFrame(draw);
  return el;
}

/** A dropdown for a choice parameter. */
export function select(node, id) {
  const p = node.param(id);
  const el = h('label', 'k-sel');
  const s = h('select');
  p.choices.forEach((c, i) => s.append(Object.assign(h('option', '', c), { value: i })));
  s.onchange = () => node.set(id, p.unmap(+s.value));
  el.append(h('span', '', p.label), s);
  el.draw = () => {
    s.value = String(p.map(node.shown(id)));
  };
  el.draw();
  return el;
}

/** Knobs and dropdowns for a list of parameter ids. */
export function controls(node, ids) {
  return ids.map((id) => (node.param(id).kind === 'choice' ? select(node, id) : knob(node, id)));
}

export function panel(title, children, extra = []) {
  const p = h('div', 'k-p');
  const head = h('header');
  head.append(h('span', '', title), h('span', 'grow'), ...extra);
  const body = h('div', 'k-knobs');
  body.append(...children);
  p.append(head, body);
  return p;
}

/** Min/max per pixel column, for drawing a waveform. */
export function peaks(L, R, columns) {
  const out = new Float32Array(columns * 2);
  const per = L.length / columns;
  for (let c = 0; c < columns; c++) {
    let lo = 0;
    let hi = 0;
    const a = Math.floor(c * per);
    const b = Math.min(L.length, Math.floor((c + 1) * per));
    const stride = Math.max(1, Math.floor((b - a) / 256));
    for (let i = a; i < b; i += stride) {
      const v = (L[i] + R[i]) * 0.5;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    out[c * 2] = lo;
    out[c * 2 + 1] = hi;
  }
  return out;
}

export function drawPeaks(g, pk, w, h, color) {
  const cols = pk.length / 2;
  g.fillStyle = color;
  const mid = h / 2;
  for (let x = 0; x < w; x++) {
    const c = Math.min(cols - 1, Math.floor((x / w) * cols));
    const lo = pk[c * 2];
    const hi = pk[c * 2 + 1];
    const y0 = mid - hi * mid * 0.92;
    const y1 = mid - lo * mid * 0.92;
    g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
  }
}

/** Header row: logo, file name/status, Load and Demo buttons. Handles drag-and-drop on `dropTarget`. */
export function fileBar(node, logo, dropTarget, onLoaded) {
  const bar = h('div', 'k-top');
  const name = h('div', 'k-file');
  const input = Object.assign(h('input'), { type: 'file', accept: 'audio/*,.wav,.mp3,.ogg,.flac,.m4a,.aif,.aiff', hidden: true });
  const load = h('button', '', 'Load audio…');
  load.title = 'Load an audio file (or drop one on the waveform). Everyone in the room gets the same file.';
  const demo = h('button', '', 'Demo');
  demo.title = 'Back to the built-in demo sound';
  load.onclick = () => input.click();
  const use = async (file) => {
    if (!isAudioFile(file)) {
      node.sampleError = 'That isn’t an audio file (wav, mp3, ogg, flac, m4a)';
      node.emit('sample');
      return;
    }
    if (await node.loadFile(file)) onLoaded?.(true);
    changed(bar);
  };
  input.onchange = () => {
    const f = input.files[0];
    input.value = '';
    if (f) use(f);
  };
  demo.onclick = async () => {
    if (await node.setSample(null)) onLoaded?.(false);
    changed(bar);
  };
  // Drops land here instead of on coprod's page (which would make a new channel).
  const stop = (e) => {
    if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  };
  dropTarget.addEventListener('dragover', (e) => stop(e) && dropTarget.classList.add('drop'));
  dropTarget.addEventListener('dragleave', () => dropTarget.classList.remove('drop'));
  dropTarget.addEventListener('drop', (e) => {
    if (!stop(e)) return;
    dropTarget.classList.remove('drop');
    document.body.classList.remove('dropping'); // coprod's page-wide drop hint
    const f = e.dataTransfer.files[0];
    if (f) use(f);
  });
  bar.append(h('span', 'k-logo', logo), name, load, demo, input);
  bar.refresh = () => {
    name.replaceChildren();
    if (node.uploading) name.append(`Uploading ${node.uploading}…`);
    else if (node.sampleError) name.append(Object.assign(h('span', 'k-err', node.sampleError)));
    else if (node.audio) {
      name.append(h('b', '', node.audio.name), ` · ${node.audio.duration.toFixed(2)} s`);
    } else name.append('Loading…');
    demo.disabled = !node.sample;
  };
  bar.refresh();
  return bar;
}

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = (n) => `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`;
