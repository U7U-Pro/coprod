// Vertex GUI: plain DOM + canvas, no framework.

import { PARAMS, INDEX as I, SOURCES, SOURCE_LABELS, FX_KINDS, FX_LABELS, format, LFO_SHAPES } from './params.js';
import * as WT from './wavetables.js';
import { PRESETS, userPresets, saveUserPreset, deleteUserPreset, presetFile, parsePresetFile } from './presets.js';

const SRC_COLORS = {
  env1: '#ffb23f', env2: '#ff8a3d', env3: '#ff5f6d', lfo1: '#3ad5ff', lfo2: '#4f8bff', lfo3: '#8f7bff', lfo4: '#c86bff',
  vel: '#5ce1a3', note: '#b8f35d', mod: '#ffd23f', rand: '#e8e8e8', macro1: '#ff6bb5', macro2: '#ff6bb5', macro3: '#ff6bb5', macro4: '#ff6bb5',
};
const DRAG_TYPE = 'application/x-vertex-source';

const CSS = `
.vx{--bg:#12151b;--panel:#1a1e26;--panel2:#212631;--line:#2b313d;--txt:#e6e9f0;--mut:#8b93a5;--acc:#39d0ff;--auto:#ff9e3d;
  font:11px/1.3 Inter,system-ui,sans-serif;color:var(--txt);background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:10px;
  display:flex;flex-direction:column;gap:10px;min-width:720px;user-select:none;position:relative}
.vx *{box-sizing:border-box}
.vx button,.vx select,.vx input{font:inherit;color:inherit}
.vx button{background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:4px 8px;cursor:pointer}
.vx button.on{background:var(--acc);border-color:var(--acc);color:#04202a}
.vx select{background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:3px 6px}
.vx-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.vx-logo{font-weight:800;letter-spacing:.2em;font-size:13px;color:var(--acc)}
.vx-preset{flex:1;min-width:160px;background:#0c0f14;border:1px solid var(--line);border-radius:6px;padding:5px 8px;font-weight:600;font-size:12px;display:flex;align-items:center;gap:8px}
.vx-preset select{flex:1;border:0;background:transparent;font-weight:600;font-size:12px}
.vx-tabs{display:flex;gap:2px;background:#0c0f14;border-radius:8px;padding:2px}
.vx-tabs button{border:0;background:none;color:var(--mut);padding:5px 12px}
.vx-tabs button.on{background:var(--panel2);color:var(--txt)}
.vx-grid{display:grid;gap:8px}
.vx-p{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:8px;display:flex;flex-direction:column;gap:6px;min-width:0}
.vx-p.off>*:not(header){opacity:.4}
.vx-p header{display:flex;align-items:center;gap:6px}
.vx-p header b{letter-spacing:.12em;font-size:10px;color:var(--mut)}
.vx-p header .grow{flex:1}
.vx-pw{width:14px;height:14px;border-radius:50%;padding:0!important;border:2px solid var(--line)!important;background:#0c0f14!important}
.vx-pw.on{background:var(--acc)!important;border-color:var(--acc)!important;box-shadow:0 0 8px var(--acc)}
.vx-row{display:flex;flex-wrap:wrap;gap:4px 6px;align-items:flex-start}
.vx-row.k6{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));justify-items:center}
.vx-knob{display:flex;flex-direction:column;align-items:center;width:52px;gap:1px;cursor:ns-resize;touch-action:none;border-radius:6px}
.vx-knob canvas{width:40px;height:40px}
.vx-knob span{font-size:9px;color:var(--mut);text-transform:uppercase;letter-spacing:.05em;white-space:nowrap;overflow:hidden;max-width:52px;text-overflow:ellipsis}
.vx-knob output{font-size:9px;font-variant-numeric:tabular-nums;color:var(--txt);white-space:nowrap}
.vx-knob.drop{outline:2px dashed var(--acc)}
.vx-knob.armed{outline:1px dashed var(--mut)}
.vx-ctl{display:flex;flex-direction:column;gap:2px;font-size:9px;color:var(--mut);text-transform:uppercase;letter-spacing:.05em}
.vx-wt{width:100%;height:96px;background:#0c0f14;border-radius:8px;cursor:pointer}
.vx-src{display:flex;flex-wrap:wrap;gap:4px}
.vx-chip{border-radius:999px!important;padding:3px 9px!important;border:1px solid var(--line)!important;cursor:grab!important;font-weight:600;font-size:10px}
.vx-chip i{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px;background:var(--c)}
.vx-chip.sel{background:var(--panel2)!important;border-color:var(--c)!important}
.vx-chip.armed{background:var(--c)!important;color:#111!important}
.vx-ed{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:start}
.vx-cv{width:100%;height:110px;background:#0c0f14;border-radius:8px;touch-action:none}
.vx-hint{color:var(--mut);font-size:10px}
.vx-mx{width:100%;border-collapse:collapse}
.vx-mx td,.vx-mx th{padding:4px;border-bottom:1px solid var(--line);text-align:left}
.vx-mx th{color:var(--mut);font-weight:500}
.vx-mx input[type=range]{width:120px;accent-color:var(--acc)}
.vx-fx{display:flex;flex-direction:column;gap:6px}
.vx-modal{position:absolute;inset:0;background:#0b0d12f2;border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:8px;z-index:5}
.vx-modal .bar{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.vx-modal canvas{width:100%;background:#0c0f14;border-radius:8px;touch-action:none}
.vx-modal input[type=text]{flex:1;min-width:200px;background:#0c0f14;border:1px solid var(--line);border-radius:6px;padding:5px 8px;font-family:ui-monospace,Menlo,monospace}
.vx-modal input[type=range]{flex:1;accent-color:var(--acc)}
.vx-err{color:#ff6b6b}
.vx-bar{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:-4px}
.vx-bar>button{padding:2px 8px;font-size:10px;color:var(--mut)}
.vx-bar .vx-top{gap:6px}
.vx-name{background:#0c0f14;border:1px solid var(--line);border-radius:6px;padding:5px 8px;min-width:180px}
`;

const h = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

function fitCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, c.clientWidth);
  const ht = Math.max(1, c.clientHeight);
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(ht * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(ht * dpr);
  }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, ht);
  return { g, w, h: ht };
}

// ---- frames for display, cached per table
const displayCache = new Map();
function displayFrames(spec) {
  const key = spec.kind === 'custom' ? `c${spec.data.length}:${spec.data.slice(0, 64)}:${spec.data.slice(-64)}` : `b:${spec.name}`;
  if (!displayCache.has(key)) displayCache.set(key, WT.editFramesFromSpec(spec));
  return displayCache.get(key);
}

export function createGui(node) {
  const root = h('div', 'vx');
  root.innerHTML = `<style>${CSS}</style>`;
  const knobs = new Map(); // param id -> [redraw fns]
  const others = []; // redraw fns for selects/toggles
  let armed = null; // a source chosen by tap, waiting for a knob tap
  let scope = null; // registrations made while building replaceable UI
  const onParam = (id, fn) => {
    if (!knobs.has(id)) knobs.set(id, []);
    knobs.get(id).push(fn);
    scope?.push([id, fn]);
  };
  const dropScope = (list) => {
    for (const [id, fn] of list) {
      const fns = knobs.get(id);
      const k = fns?.indexOf(fn) ?? -1;
      if (k >= 0) fns.splice(k, 1);
    }
    list.length = 0;
  };

  // ------------------------------------------------------------------ controls

  function knob(id, label) {
    const i = I[id];
    const p = PARAMS[i];
    const el = h('div', 'vx-knob');
    el.dataset.param = id;
    const c = h('canvas');
    const out = h('output');
    el.append(c, h('span', '', label ?? p.label.replace(/^(Osc )?[AB] /, '').replace(/^Env\d |^LFO\d /, '')), out);
    el.title = `${p.label}. Drag to change, Shift for fine, double-click to reset. Drop a mod source here to modulate.`;
    let drag = null;
    el.addEventListener('pointerdown', (e) => {
      if (armed) {
        node.addRoute(armed, id, 0.5);
        setArmed(null);
        return;
      }
      el.setPointerCapture(e.pointerId);
      drag = { y: e.clientY, v: node.get(id) };
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const scale = e.shiftKey ? 1000 : 180;
      let v = drag.v + (drag.y - e.clientY) / scale;
      if (p.kind !== 'float') {
        // stepped parameters snap to their steps
        const steps = p.kind === 'choice' ? p.choices.length - 1 : p.kind === 'int' ? Math.round(p.map(1) - p.map(0)) : 1;
        v = Math.round(Math.min(1, Math.max(0, v)) * steps) / steps;
      }
      if (v !== node.get(id)) node.set(id, v);
    });
    el.addEventListener('pointerup', () => (drag = null));
    el.addEventListener('dblclick', () => node.set(id, p.def));
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      node.set(id, node.get(id) - Math.sign(e.deltaY) * (e.shiftKey ? 0.002 : 0.02));
    }, { passive: false });
    el.addEventListener('dragover', (e) => {
      if (![...e.dataTransfer.types].includes(DRAG_TYPE)) return;
      e.preventDefault();
      el.classList.add('drop');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop'));
    el.addEventListener('drop', (e) => {
      el.classList.remove('drop');
      const src = e.dataTransfer.getData(DRAG_TYPE);
      if (src) node.addRoute(src, id, 0.5);
    });
    const draw = () => {
      const { g, w, h: ht } = fitCanvas(c);
      const cx = w / 2;
      const cy = ht / 2 + 2;
      const r = 14;
      const a0 = Math.PI * 0.75;
      const span = Math.PI * 1.5;
      const v = node.get(id);
      const shown = node.shown(id);
      const automated = node.autoValues.has(id);
      // track
      g.lineCap = 'round';
      g.lineWidth = 4;
      g.strokeStyle = '#2b313d';
      g.beginPath();
      g.arc(cx, cy, r, a0, a0 + span);
      g.stroke();
      // value
      g.strokeStyle = automated ? '#ff9e3d' : '#39d0ff';
      g.beginPath();
      g.arc(cx, cy, r, a0, a0 + span * Math.max(0.001, shown));
      g.stroke();
      // modulation rings
      let ring = 0;
      for (const rt of node.routes) {
        if (rt.dst !== id) continue;
        const rr = r + 5 + ring * 3;
        ring++;
        const from = rt.bi ? v - Math.abs(rt.amt) : v;
        const to = rt.bi ? v + Math.abs(rt.amt) : v + rt.amt;
        const lo = Math.max(0, Math.min(from, to));
        const hi = Math.min(1, Math.max(from, to));
        g.lineWidth = 2;
        g.strokeStyle = SRC_COLORS[rt.src];
        g.beginPath();
        g.arc(cx, cy, rr, a0 + span * lo, a0 + span * Math.max(lo + 0.005, hi));
        g.stroke();
      }
      // pointer
      const ang = a0 + span * shown;
      g.strokeStyle = '#e6e9f0';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(cx + Math.cos(ang) * 5, cy + Math.sin(ang) * 5);
      g.lineTo(cx + Math.cos(ang) * (r - 1), cy + Math.sin(ang) * (r - 1));
      g.stroke();
      out.textContent = format(i, shown);
    };
    onParam(id, draw);
    requestAnimationFrame(draw);
    return el;
  }

  function choice(id, label) {
    const p = PARAMS[I[id]];
    const wrap = h('label', 'vx-ctl');
    const sel = h('select');
    p.choices.forEach((c, k) => sel.append(new Option(c, k)));
    sel.onchange = () => node.set(id, p.unmap(+sel.value));
    wrap.append(label ?? p.label.replace(/^(Osc )?[AB] /, ''), sel);
    const draw = () => (sel.value = p.map(node.shown(id)));
    onParam(id, draw);
    draw();
    return wrap;
  }

  function toggle(id, label, cls = '') {
    const b = h('button', cls, label);
    b.onclick = () => node.set(id, node.get(id) >= 0.5 ? 0 : 1);
    const draw = () => b.classList.toggle('on', node.shown(id) >= 0.5);
    onParam(id, draw);
    draw();
    return b;
  }

  function power(id) {
    const b = toggle(id, '', 'vx-pw');
    b.title = 'On / off';
    return b;
  }

  function panel(title, onId, ...children) {
    const p = h('section', 'vx-p');
    const head = h('header');
    if (onId) head.append(power(onId));
    head.append(h('b', '', title), h('span', 'grow'));
    p.append(head, ...children);
    if (onId) {
      const draw = () => p.classList.toggle('off', node.get(onId) < 0.5);
      onParam(onId, draw);
      draw();
    }
    return { el: p, head };
  }

  const row = (...els) => {
    const r = h('div', 'vx-row');
    r.append(...els);
    return r;
  };
  const row6 = (...els) => {
    const r = row(...els);
    r.classList.add('k6');
    return r;
  };

  // ------------------------------------------------------------------ header

  const top = h('div', 'vx-top');
  const presetBox = h('div', 'vx-preset');
  const presetSel = h('select');
  const presetName = h('span', '', node.name);
  presetSel.title = 'Load a preset';

  // Factory presets first, then yours (saved in this browser).
  const allPresets = () => [
    ...PRESETS.map((p, k) => ({ key: `f:${k}`, name: p.name, category: p.category, load: () => node.loadPreset(p) })),
    ...userPresets().map((p) => ({ key: `u:${p.name}`, name: p.name, category: 'My presets', user: true, load: () => node.setState(p.state) })),
  ];
  function fillPresets() {
    presetSel.replaceChildren(new Option('— Presets —', ''));
    const list = allPresets();
    for (const cat of [...new Set(list.map((p) => p.category))]) {
      const og = document.createElement('optgroup');
      og.label = cat;
      for (const p of list) if (p.category === cat) og.append(new Option(p.name, p.key));
      presetSel.append(og);
    }
  }
  fillPresets();
  presetSel.onchange = () => {
    allPresets().find((p) => p.key === presetSel.value)?.load();
    presetSel.value = '';
  };
  const step = (d) => {
    const list = allPresets();
    const k = list.findIndex((p) => p.name === node.name);
    list[(k + d + list.length) % list.length].load();
  };
  const prev = h('button', '', '◀');
  const next = h('button', '', '▶');
  prev.title = 'Previous preset';
  next.title = 'Next preset';
  prev.onclick = () => step(-1);
  next.onclick = () => step(1);
  presetBox.append(presetName, presetSel);

  // Save / delete / export / import
  const saveBtn = h('button', '', 'Save');
  saveBtn.title = 'Save the current sound to your presets (in this browser)';
  const delBtn = h('button', '', 'Delete');
  delBtn.title = 'Delete this preset from your presets';
  const expBtn = h('button', '', 'Export');
  expBtn.title = 'Download this sound as a preset file';
  const impBtn = h('button', '', 'Import');
  impBtn.title = 'Load a preset file';
  const impFile = h('input');
  Object.assign(impFile, { type: 'file', accept: '.json,.vertex,application/json', hidden: true });
  const saveRow = h('div', 'vx-top');
  saveRow.hidden = true;
  const saveName = h('input');
  Object.assign(saveName, { type: 'text', maxLength: 40, placeholder: 'Preset name' });
  saveName.className = 'vx-name';
  const saveOk = h('button', 'on', 'Save preset');
  const saveCancel = h('button', '', 'Cancel');
  const presetMsg = h('span', 'vx-hint');
  saveRow.append(h('span', 'vx-hint', 'Save as'), saveName, saveOk, saveCancel);
  const flash = (text, err = false) => {
    presetMsg.textContent = text;
    presetMsg.className = err ? 'vx-err' : 'vx-hint';
    clearTimeout(flash.t);
    flash.t = setTimeout(() => (presetMsg.textContent = ''), 4000);
  };
  const isUser = () => userPresets().some((p) => p.name === node.name);
  const syncPresetButtons = () => (delBtn.hidden = !isUser());
  saveBtn.onclick = () => {
    saveRow.hidden = false;
    saveName.value = node.name === 'Init' ? '' : node.name;
    saveName.focus();
    saveName.select();
  };
  saveCancel.onclick = () => (saveRow.hidden = true);
  const doSave = async () => {
    const name = saveName.value.trim();
    if (!name) return flash('Give the preset a name', true);
    if (userPresets().some((p) => p.name === name) && name !== node.name && !confirm(`Replace your preset "${name}"?`)) return;
    const res = saveUserPreset(name, await node.getState());
    if (!res.ok) return flash(res.error, true);
    node.setName(name);
    saveRow.hidden = true;
    fillPresets();
    syncPresetButtons();
    flash(`Saved "${name}" to your presets`);
  };
  saveOk.onclick = doSave;
  saveName.onkeydown = (e) => {
    if (e.key === 'Enter') doSave();
    if (e.key === 'Escape') saveRow.hidden = true;
    e.stopPropagation(); // keep typing out of the host's shortcuts
  };
  delBtn.onclick = () => {
    if (!confirm(`Delete your preset "${node.name}"?`)) return;
    deleteUserPreset(node.name);
    fillPresets();
    syncPresetButtons();
    flash('Preset deleted');
  };
  expBtn.onclick = async () => {
    const state = await node.getState();
    const url = URL.createObjectURL(new Blob([presetFile(state)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(state.name || 'Vertex preset').replace(/[^\w .-]+/g, '_')}.vertex.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  impBtn.onclick = () => impFile.click();
  impFile.onchange = async () => {
    const f = impFile.files[0];
    impFile.value = '';
    if (!f) return;
    try {
      const state = parsePresetFile(await f.text());
      await node.setState(state);
      const res = saveUserPreset(state.name, state);
      fillPresets();
      syncPresetButtons();
      flash(res.ok ? `Imported "${state.name}" (also added to your presets)` : `Loaded "${state.name}", but couldn't save it: ${res.error}`, !res.ok);
    } catch (err) {
      flash(err.message, true);
    }
  };
  syncPresetButtons();
  const tabs = h('div', 'vx-tabs');
  const tabNames = ['OSC', 'FX', 'MATRIX'];
  const tabBtns = tabNames.map((t) => {
    const b = h('button', t === 'OSC' ? 'on' : '', t);
    b.onclick = () => showTab(t);
    return b;
  });
  tabs.append(...tabBtns);
  top.append(h('span', 'vx-logo', 'VERTEX'), prev, next, presetBox, tabs, knob('vol', 'Volume'));
  const presetBar = h('div', 'vx-bar');
  presetBar.append(saveBtn, delBtn, expBtn, impBtn, impFile, saveRow, presetMsg);

  // ------------------------------------------------------------------ OSC tab

  const oscTab = h('div', 'vx-grid');
  oscTab.style.gridTemplateColumns = 'minmax(0,1fr) minmax(0,1fr)';

  const wtCanvases = {};
  for (const o of ['a', 'b']) {
    const O = o.toUpperCase();
    const { el, head } = panel(`OSC ${O}`, `${o}_on`);
    const tableSel = h('select');
    for (const name of Object.keys(WT.BUILTIN)) tableSel.append(new Option(name, name));
    tableSel.append(new Option('Custom…', '__custom'));
    tableSel.onchange = () => {
      if (tableSel.value === '__custom') return openEditor(o);
      node.setTable(o, { kind: 'builtin', name: tableSel.value });
    };
    const edit = h('button', '', 'Edit');
    edit.onclick = () => openEditor(o);
    head.append(tableSel, edit);
    const wt = h('canvas', 'vx-wt');
    wt.title = 'Click to open the wavetable editor';
    wt.onclick = () => openEditor(o);
    wtCanvases[o] = { canvas: wt, select: tableSel };
    el.append(
      wt,
      row6(knob(`${o}_pos`, 'WT Pos'), knob(`${o}_unison`, 'Unison'), knob(`${o}_detune`, 'Detune'), knob(`${o}_blend`, 'Blend'), knob(`${o}_width`, 'Width'), knob(`${o}_level`, 'Level')),
      row6(knob(`${o}_oct`, 'Oct'), knob(`${o}_semi`, 'Semi'), knob(`${o}_fine`, 'Fine'), knob(`${o}_pan`, 'Pan'), knob(`${o}_phase`, 'Phase'), knob(`${o}_rand`, 'Rand')),
      row(choice(`${o}_warp`, 'Warp'), knob(`${o}_warpamt`, 'Amount'), toggle(`${o}_flt`, '→ Filter')),
    );
    onParam(`${o}_pos`, () => drawWt(o));
    oscTab.append(el);
  }

  const sub = panel('SUB', 'sub_on');
  sub.el.append(row(choice('sub_shape', 'Shape'), knob('sub_oct', 'Oct'), knob('sub_level', 'Level'), knob('sub_pan', 'Pan'), toggle('sub_flt', '→ Filter')));
  const noise = panel('NOISE', 'noise_on');
  noise.el.append(row(choice('noise_type', 'Type'), knob('noise_level', 'Level'), knob('noise_pan', 'Pan'), toggle('noise_flt', '→ Filter')));
  const flt = panel('FILTER', 'flt_on');
  flt.el.append(row(choice('flt_type', 'Type'), knob('flt_cutoff', 'Cutoff'), knob('flt_res', 'Res'), knob('flt_drive', 'Drive'), knob('flt_mix', 'Mix'), knob('flt_key', 'Key trk')));
  const mid = h('div', 'vx-grid');
  mid.style.gridTemplateColumns = 'minmax(0,1fr) minmax(0,1fr)';
  const subNoise = h('div', 'vx-grid');
  subNoise.append(sub.el, noise.el);
  mid.append(subNoise, flt.el);
  mid.style.gridColumn = '1 / -1';
  oscTab.append(mid);

  // ---- modulation sources and their editors
  const mod = panel('MODULATION');
  mod.el.style.gridColumn = '1 / -1';
  const chips = h('div', 'vx-src');
  let selected = 'env1';
  const chipEls = {};
  for (const src of SOURCES) {
    const c = h('button', 'vx-chip');
    c.style.setProperty('--c', SRC_COLORS[src]);
    c.innerHTML = '<i></i>';
    c.append(SOURCE_LABELS[src]);
    c.draggable = true;
    c.title = 'Drag onto a knob to modulate it (or tap here, then tap a knob)';
    c.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData(DRAG_TYPE, src);
      e.dataTransfer.setData('text/plain', SOURCE_LABELS[src]);
      e.dataTransfer.effectAllowed = 'link';
    });
    c.onclick = () => {
      if (/^(env|lfo)/.test(src)) {
        selected = src;
        renderEditor();
      }
      setArmed(armed === src ? null : src);
    };
    chipEls[src] = c;
    chips.append(c);
  }
  const editor = h('div', 'vx-ed');
  const macroRow = row(knob('macro1', 'Macro 1'), knob('macro2', 'Macro 2'), knob('macro3', 'Macro 3'), knob('macro4', 'Macro 4'));
  const voicing = row(knob('poly', 'Voices'), toggle('legato', 'Legato'), knob('glide', 'Glide'), knob('bend', 'Bend'));
  mod.el.append(chips, h('p', 'vx-hint', 'Tip: drag a source onto any knob (or tap the source, then the knob). Edit amounts in the MATRIX tab.'), editor, row(macroRow, voicing));
  oscTab.append(mod.el);

  function setArmed(src) {
    armed = src;
    for (const [s, c] of Object.entries(chipEls)) {
      c.classList.toggle('armed', s === armed);
      c.classList.toggle('sel', s === selected);
    }
    for (const k of root.querySelectorAll('.vx-knob')) k.classList.toggle('armed', !!armed);
  }

  let editorDraw = null;
  const editorScope = [];
  function renderEditor() {
    dropScope(editorScope);
    scope = editorScope;
    editor.replaceChildren();
    const c = h('canvas', 'vx-cv');
    const n = +selected.slice(-1);
    let controls;
    if (selected.startsWith('env')) {
      const e = `env${n}`;
      controls = row(knob(`${e}_a`, 'Attack'), knob(`${e}_h`, 'Hold'), knob(`${e}_d`, 'Decay'), knob(`${e}_s`, 'Sustain'), knob(`${e}_r`, 'Release'));
      editorDraw = () => drawEnv(c, e);
      for (const k of ['a', 'h', 'd', 's', 'r']) onParam(`${e}_${k}`, () => editorDraw?.());
      if (n === 1) controls.prepend(h('span', 'vx-hint', 'Env 1 shapes the volume.'));
    } else {
      const l = `lfo${n}`;
      const rateBox = h('div');
      const rateScope = [];
      const syncDraw = () => {
        dropScope(rateScope);
        const outer = scope;
        scope = rateScope;
        rateBox.replaceChildren(node.get(`${l}_sync`) >= 0.5 ? choice(`${l}_div`, 'Rate') : knob(`${l}_rate`, 'Rate'));
        scope = outer;
      };
      onParam(`${l}_sync`, syncDraw);
      syncDraw();
      controls = row(choice(`${l}_shape`, 'Shape'), choice(`${l}_mode`, 'Mode'), toggle(`${l}_sync`, 'Sync'), rateBox, knob(`${l}_phase`, 'Phase'));
      editorDraw = () => drawLfo(c, n);
      for (const k of ['shape', 'phase']) onParam(`${l}_${k}`, () => editorDraw?.());
      lfoPointEditing(c, n);
    }
    editor.append(c, controls);
    scope = null;
    requestAnimationFrame(() => editorDraw?.());
    setArmed(armed);
  }

  // ------------------------------------------------------------------ FX tab

  const fxTab = h('div', 'vx-fx');
  const FX_CONTROLS = {
    dist: () => [choice('dist_type', 'Type'), knob('dist_drive', 'Drive'), knob('dist_mix', 'Mix')],
    chorus: () => [knob('chorus_rate', 'Rate'), knob('chorus_depth', 'Depth'), knob('chorus_mix', 'Mix')],
    flanger: () => [knob('flanger_rate', 'Rate'), knob('flanger_depth', 'Depth'), knob('flanger_fb', 'Feedback'), knob('flanger_mix', 'Mix')],
    phaser: () => [knob('phaser_rate', 'Rate'), knob('phaser_depth', 'Depth'), knob('phaser_fb', 'Feedback'), knob('phaser_mix', 'Mix')],
    delay: () => [toggle('delay_sync', 'Sync'), choice('delay_div', 'Division'), knob('delay_time', 'Time'), knob('delay_fb', 'Feedback'), toggle('delay_pp', 'Ping-pong'), knob('delay_tone', 'Tone'), knob('delay_mix', 'Mix')],
    reverb: () => [knob('reverb_size', 'Size'), knob('reverb_damp', 'Damp'), knob('reverb_width', 'Width'), knob('reverb_mix', 'Mix')],
    comp: () => [choice('comp_mode', 'Mode'), knob('comp_thresh', 'Thresh'), knob('comp_ratio', 'Ratio'), knob('comp_attack', 'Attack'), knob('comp_release', 'Release'), knob('comp_depth', 'OTT depth'), knob('comp_gain', 'Makeup')],
    eq: () => [knob('eq_lowf', 'Low f'), knob('eq_lowg', 'Low'), knob('eq_midf', 'Mid f'), knob('eq_midg', 'Mid'), knob('eq_highf', 'High f'), knob('eq_highg', 'High')],
  };
  const fxPanels = {};
  for (const kind of FX_KINDS) {
    const { el, head } = panel(FX_LABELS[kind].toUpperCase(), `${kind}_on`);
    const up = h('button', '', '▲');
    const down = h('button', '', '▼');
    up.title = 'Move earlier in the chain';
    down.title = 'Move later in the chain';
    const move = (d) => {
      const order = [...node.fxOrder];
      const k = order.indexOf(kind);
      const j = k + d;
      if (j < 0 || j >= order.length) return;
      [order[k], order[j]] = [order[j], order[k]];
      node.setFxOrder(order);
    };
    up.onclick = () => move(-1);
    down.onclick = () => move(1);
    head.append(up, down);
    el.append(row(...FX_CONTROLS[kind]()));
    fxPanels[kind] = el;
  }
  const drawFxOrder = () => fxTab.replaceChildren(h('p', 'vx-hint', 'Effects run top to bottom. Power them on and reorder freely.'), ...node.fxOrder.map((k) => fxPanels[k]));

  // ------------------------------------------------------------------ MATRIX tab

  const mxTab = h('div', 'vx-p');
  function drawMatrix() {
    const table = h('table', 'vx-mx');
    table.innerHTML = '<tr><th>Source</th><th>Destination</th><th>Amount</th><th>Bipolar</th><th></th></tr>';
    node.routes.forEach((r, k) => {
      const tr = h('tr');
      const src = h('select');
      for (const s of SOURCES) src.append(new Option(SOURCE_LABELS[s], s));
      src.value = r.src;
      const dst = destSelect(r.dst);
      const amt = h('input');
      Object.assign(amt, { type: 'range', min: -100, max: 100, step: 1, value: Math.round(r.amt * 100) });
      const amtOut = h('output', '', `${Math.round(r.amt * 100)}%`);
      const bi = h('input');
      bi.type = 'checkbox';
      bi.checked = r.bi;
      const del = h('button', '', '✕');
      const update = (patch) => node.setRoutes(node.routes.map((x, j) => (j === k ? { ...x, ...patch } : x)));
      src.onchange = () => update({ src: src.value });
      dst.onchange = () => update({ dst: dst.value });
      amt.oninput = () => {
        amtOut.textContent = `${amt.value}%`;
        update({ amt: amt.value / 100 });
      };
      bi.onchange = () => update({ bi: bi.checked });
      del.onclick = () => node.setRoutes(node.routes.filter((_, j) => j !== k));
      const cells = [src, dst, h('span'), bi, del].map((x) => {
        const td = h('td');
        td.append(x);
        return td;
      });
      cells[2].replaceChildren(amt, amtOut);
      tr.append(...cells);
      table.append(tr);
    });
    const add = h('button', '', '+ Add route');
    add.onclick = () => node.setRoutes([...node.routes, { src: 'lfo1', dst: 'flt_cutoff', amt: 0.25, bi: false }]);
    mxTab.replaceChildren(h('header').appendChild(h('b', '', 'MODULATION MATRIX')).parentNode, table, add, h('p', 'vx-hint', 'Amounts are in each parameter’s own range: +100% sweeps it from where the knob is to the top. Bipolar sources swing both ways.'));
  }
  function destSelect(value) {
    const sel = h('select');
    const groups = {};
    for (const p of PARAMS) {
      if (p.group === 'macro' || p.kind === 'bool') continue;
      (groups[p.group] ??= []).push(p);
    }
    for (const [g, ps] of Object.entries(groups)) {
      const og = document.createElement('optgroup');
      og.label = g.toUpperCase();
      for (const p of ps) og.append(new Option(p.label, p.id));
      sel.append(og);
    }
    sel.value = value;
    return sel;
  }

  // ------------------------------------------------------------------ drawing

  function drawWt(o) {
    const { canvas, select } = wtCanvases[o];
    const spec = node.tables[o];
    select.value = spec.kind === 'builtin' ? spec.name : '__custom';
    if (spec.kind === 'custom' && ![...select.options].some((x) => x.value === '__custom' && x.textContent.startsWith('Custom:'))) {
      select.options[select.options.length - 1].textContent = `Custom: ${spec.name}`;
    }
    const { frames, count } = displayFrames(spec);
    const { g, w, h: ht } = fitCanvas(canvas);
    const pos = node.shown(`${o}_pos`) * (count - 1);
    const shownFrames = Math.min(count, 20);
    const dx = (w * 0.25) / shownFrames;
    const dy = (ht * 0.35) / shownFrames;
    const fw = w * 0.72;
    const amp = ht * 0.22;
    const drawFrame = (f, color, width) => {
      const j = (f / Math.max(1, count - 1)) * (shownFrames - 1);
      const x0 = 8 + j * dx;
      const y0 = ht - 14 - amp - j * dy;
      g.strokeStyle = color;
      g.lineWidth = width;
      g.beginPath();
      for (let i = 0; i <= WT.EDIT_SIZE; i += 4) {
        const v = frames[Math.min(count - 1, f) * WT.EDIT_SIZE + (i % WT.EDIT_SIZE)];
        const x = x0 + (i / WT.EDIT_SIZE) * fw;
        const y = y0 - v * amp;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
    };
    for (let k = shownFrames - 1; k >= 0; k--) {
      const f = Math.round((k / Math.max(1, shownFrames - 1)) * (count - 1));
      drawFrame(f, 'rgba(57,208,255,0.16)', 1);
    }
    drawFrame(Math.round(pos), '#39d0ff', 2);
    g.fillStyle = '#8b93a5';
    g.font = '10px Inter, system-ui';
    g.fillText(`${spec.kind === 'custom' ? spec.name : spec.name} · frame ${Math.round(pos) + 1}/${count}`, 8, 12);
  }

  function drawEnv(c, e) {
    const { g, w, h: ht } = fitCanvas(c);
    const v = (k) => node.shown(`${e}_${k}`);
    // segment widths follow the (perceptual) normalized knob values
    const seg = [0.04 + v('a'), 0.02 + v('h') * 0.6, 0.04 + v('d'), 0.5, 0.04 + v('r')];
    const total = seg.reduce((a, b) => a + b, 0);
    const X = (t) => 10 + (t / total) * (w - 20);
    const Y = (l) => ht - 10 - l * (ht - 22);
    const s = v('s');
    let t = 0;
    const pts = [[0, 0]];
    t += seg[0];
    pts.push([t, 1]);
    t += seg[1];
    pts.push([t, 1]);
    const decayStart = t;
    t += seg[2];
    for (let k = 1; k <= 12; k++) {
      const q = 1 - k / 12;
      pts.push([decayStart + (seg[2] * k) / 12, s + (1 - s) * q * q * q]);
    }
    t += seg[3];
    pts.push([t, s]);
    const relStart = t;
    for (let k = 1; k <= 12; k++) {
      const q = 1 - k / 12;
      pts.push([relStart + (seg[4] * k) / 12, s * q * q * q]);
    }
    g.fillStyle = 'rgba(255,178,63,0.12)';
    g.strokeStyle = SRC_COLORS[e];
    g.lineWidth = 2;
    g.beginPath();
    pts.forEach(([x, y], k) => (k ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y))));
    g.stroke();
    g.lineTo(X(pts.at(-1)[0]), Y(0));
    g.lineTo(X(0), Y(0));
    g.fill();
    g.fillStyle = '#8b93a5';
    g.font = '10px Inter, system-ui';
    g.fillText(`${e.toUpperCase()} · A ${format(I[`${e}_a`], v('a'))} · D ${format(I[`${e}_d`], v('d'))} · S ${format(I[`${e}_s`], s)} · R ${format(I[`${e}_r`], v('r'))}`, 10, 12);
  }

  function lfoValue(shape, p, n) {
    switch (shape) {
      case 0:
        return 0.5 + 0.5 * Math.sin(2 * Math.PI * p);
      case 1:
        return p < 0.5 ? p * 2 : 2 - p * 2;
      case 2:
        return p;
      case 3:
        return 1 - p;
      case 4:
        return p < 0.5 ? 1 : 0;
      case 5:
        return [0.2, 0.9, 0.5, 0.75, 0.1, 0.6, 0.35, 0.95][Math.floor(p * 8) % 8];
      case 6: {
        const r = [0.2, 0.9, 0.5, 0.75, 0.1, 0.6, 0.35, 0.95, 0.2];
        const k = Math.floor(p * 8);
        const t = 0.5 - 0.5 * Math.cos(Math.PI * (p * 8 - k));
        return r[k] + (r[k + 1] - r[k]) * t;
      }
      default: {
        const pts = node.lfo[n] ?? [[0, 0], [1, 1]];
        let k = 1;
        while (k < pts.length - 1 && pts[k][0] < p) k++;
        const [x0, y0] = pts[k - 1];
        const [x1, y1] = pts[k];
        return x1 > x0 ? y0 + ((y1 - y0) * (p - x0)) / (x1 - x0) : y1;
      }
    }
  }

  function drawLfo(c, n) {
    const { g, w, h: ht } = fitCanvas(c);
    const shape = PARAMS[I[`lfo${n}_shape`]].map(node.shown(`lfo${n}_shape`));
    const X = (p) => 10 + p * (w - 20);
    const Y = (v) => ht - 10 - v * (ht - 22);
    g.strokeStyle = SRC_COLORS[`lfo${n}`];
    g.lineWidth = 2;
    g.beginPath();
    for (let k = 0; k <= 200; k++) {
      const p = k / 200;
      const y = Y(lfoValue(shape, p, n));
      if (k) g.lineTo(X(p), y);
      else g.moveTo(X(p), y);
    }
    g.stroke();
    if (shape === 7) {
      g.fillStyle = '#fff';
      for (const [x, y] of node.lfo[n] ?? []) {
        g.beginPath();
        g.arc(X(x), Y(y), 4, 0, Math.PI * 2);
        g.fill();
      }
    }
    // playhead from the audio thread (first active voice, or the free-running LFO)
    const ph = node.status?.vlfo?.[n - 1] ?? node.status?.lfo?.[n - 1];
    if (ph !== undefined && node.status?.voices) {
      g.fillStyle = 'rgba(255,255,255,0.5)';
      g.fillRect(X(ph), 4, 1, ht - 8);
    }
    g.fillStyle = '#8b93a5';
    g.font = '10px Inter, system-ui';
    g.fillText(shape === 7 ? `LFO ${n} · custom: click to add points, drag to move, double-click to delete` : `LFO ${n} · ${LFO_SHAPES[shape]} (pick "Custom" to draw your own)`, 10, 12);
  }

  function lfoPointEditing(c, n) {
    let drag = null;
    const toXY = (e) => {
      const r = c.getBoundingClientRect();
      return [Math.min(1, Math.max(0, (e.clientX - r.left - 10) / (r.width - 20))), Math.min(1, Math.max(0, (r.height - 10 - (e.clientY - r.top)) / (r.height - 22)))];
    };
    const isCustom = () => PARAMS[I[`lfo${n}_shape`]].map(node.get(`lfo${n}_shape`)) === 7;
    const pts = () => (node.lfo[n] ?? [[0, 0], [0.5, 1], [1, 0]]).map((p) => [...p]);
    c.addEventListener('pointerdown', (e) => {
      if (!isCustom()) return;
      c.setPointerCapture(e.pointerId);
      const [x, y] = toXY(e);
      const list = pts();
      const r = c.getBoundingClientRect();
      let k = list.findIndex(([px, py]) => Math.hypot((px - x) * r.width, (py - y) * r.height) < 10);
      if (k < 0) {
        list.push([x, y]);
        list.sort((a, b) => a[0] - b[0]);
        k = list.findIndex((p) => p[0] === x && p[1] === y);
      }
      drag = k;
      node.setLfoShape(n, list);
    });
    c.addEventListener('pointermove', (e) => {
      if (drag === null) return;
      const list = pts();
      const [x, y] = toXY(e);
      const first = drag === 0;
      const last = drag === list.length - 1;
      const lo = first ? 0 : list[drag - 1][0];
      const hi = last ? 1 : list[drag + 1][0];
      list[drag] = [first ? 0 : last ? 1 : Math.min(hi, Math.max(lo, x)), y];
      node.setLfoShape(n, list);
    });
    c.addEventListener('pointerup', () => (drag = null));
    c.addEventListener('dblclick', (e) => {
      if (!isCustom()) return;
      const list = pts();
      const [x, y] = toXY(e);
      const r = c.getBoundingClientRect();
      const k = list.findIndex(([px, py]) => Math.hypot((px - x) * r.width, (py - y) * r.height) < 10);
      if (k > 0 && k < list.length - 1) {
        list.splice(k, 1);
        node.setLfoShape(n, list);
      }
    });
  }

  // ------------------------------------------------------------------ wavetable editor

  function openEditor(o) {
    const spec = node.tables[o];
    const src = displayFrames(spec);
    let frames = Float32Array.from(src.frames);
    let count = src.count;
    let cur = Math.round(node.get(`${o}_pos`) * (count - 1));
    let name = spec.kind === 'custom' ? spec.name : `${spec.name} (edited)`;
    const modal = h('div', 'vx-modal');
    const title = h('b');
    const overview = h('canvas');
    overview.style.height = '90px';
    const drawCv = h('canvas');
    drawCv.style.height = '200px';
    drawCv.title = 'Draw on the waveform';
    const frameSlider = h('input');
    frameSlider.type = 'range';
    const status = h('span', 'vx-hint');
    const formula = h('input');
    formula.type = 'text';
    formula.value = 'sin(2*pi*x) * (1 - y) + saw(x) * y';
    formula.title = 'x = phase 0..1, y = frame position 0..1. Functions: sin cos tan abs sqrt exp log tanh floor fract saw sq tri rand min max pow clamp';
    const countSel = h('select');
    for (const k of [1, 8, 16, 32, 64]) countSel.append(new Option(`${k} frames`, k));
    countSel.value = String(Math.max(8, count));
    const file = h('input');
    file.type = 'file';
    file.accept = 'audio/*';
    file.hidden = true;

    const btn = (label, fn, title) => {
      const b = h('button', '', label);
      b.onclick = fn;
      if (title) b.title = title;
      return b;
    };
    const setStatus = (t, err = false) => {
      status.textContent = t;
      status.className = err ? 'vx-err' : 'vx-hint';
    };
    const refresh = () => {
      frameSlider.min = 0;
      frameSlider.max = count - 1;
      frameSlider.value = cur;
      title.textContent = `Wavetable editor · OSC ${o.toUpperCase()} · ${name} · frame ${cur + 1}/${count}`;
      drawOverview();
      drawFrameEdit();
    };
    function drawOverview() {
      const { g, w, h: ht } = fitCanvas(overview);
      const cw = w / count;
      for (let f = 0; f < count; f++) {
        g.strokeStyle = f === cur ? '#39d0ff' : 'rgba(57,208,255,0.35)';
        g.lineWidth = f === cur ? 1.5 : 1;
        g.beginPath();
        for (let i = 0; i <= 64; i++) {
          const v = frames[f * WT.EDIT_SIZE + ((i * 8) % WT.EDIT_SIZE)];
          const x = f * cw + (i / 64) * cw;
          const y = ht / 2 - v * (ht / 2 - 6);
          if (i) g.lineTo(x, y);
          else g.moveTo(x, y);
        }
        g.stroke();
      }
    }
    function drawFrameEdit() {
      const { g, w, h: ht } = fitCanvas(drawCv);
      g.strokeStyle = '#2b313d';
      g.beginPath();
      g.moveTo(0, ht / 2);
      g.lineTo(w, ht / 2);
      g.stroke();
      g.strokeStyle = '#39d0ff';
      g.lineWidth = 2;
      g.beginPath();
      for (let i = 0; i < WT.EDIT_SIZE; i++) {
        const x = (i / (WT.EDIT_SIZE - 1)) * w;
        const y = ht / 2 - frames[cur * WT.EDIT_SIZE + i] * (ht / 2 - 8);
        if (i) g.lineTo(x, y);
        else g.moveTo(x, y);
      }
      g.stroke();
    }
    // drawing on the current frame
    let last = null;
    const paint = (e) => {
      const r = drawCv.getBoundingClientRect();
      const i = Math.round(((e.clientX - r.left) / r.width) * (WT.EDIT_SIZE - 1));
      const v = Math.max(-1, Math.min(1, (r.height / 2 - (e.clientY - r.top)) / (r.height / 2 - 8)));
      const from = last ?? [i, v];
      const [i0, v0] = from;
      const steps = Math.max(1, Math.abs(i - i0));
      for (let s = 0; s <= steps; s++) {
        const k = Math.round(i0 + ((i - i0) * s) / steps);
        if (k >= 0 && k < WT.EDIT_SIZE) frames[cur * WT.EDIT_SIZE + k] = v0 + ((v - v0) * s) / steps;
      }
      last = [i, v];
      drawFrameEdit();
    };
    drawCv.addEventListener('pointerdown', (e) => {
      drawCv.setPointerCapture(e.pointerId);
      last = null;
      paint(e);
    });
    drawCv.addEventListener('pointermove', (e) => last && paint(e));
    drawCv.addEventListener('pointerup', () => {
      last = null;
      drawOverview();
    });
    overview.addEventListener('click', (e) => {
      const r = overview.getBoundingClientRect();
      cur = Math.min(count - 1, Math.floor(((e.clientX - r.left) / r.width) * count));
      refresh();
    });
    frameSlider.oninput = () => {
      cur = +frameSlider.value;
      refresh();
    };

    const builtinSel = h('select');
    builtinSel.append(new Option('Load built-in…', ''));
    for (const n of Object.keys(WT.BUILTIN)) builtinSel.append(new Option(n, n));
    builtinSel.onchange = () => {
      if (!builtinSel.value) return;
      const t = WT.editFramesFromSpec({ kind: 'builtin', name: builtinSel.value });
      frames = Float32Array.from(t.frames);
      count = t.count;
      name = `${builtinSel.value} (edited)`;
      cur = 0;
      builtinSel.value = '';
      refresh();
    };
    file.onchange = async () => {
      const f = file.files[0];
      if (!f) return;
      try {
        setStatus(`Decoding ${f.name}…`);
        const ctx = new OfflineAudioContext(1, 1, 48000);
        const buf = await ctx.decodeAudioData(await f.arrayBuffer());
        const data = buf.getChannelData(0).slice(0, 48000 * 20);
        const n = +countSel.value;
        const t = WT.framesFromAudio(data, n, n === 1 ? 'single' : 'split');
        frames = t.frames;
        count = t.count;
        name = f.name.replace(/\.[^.]+$/, '').slice(0, 30);
        cur = 0;
        setStatus(`Imported ${count} frame${count > 1 ? 's' : ''} from ${f.name}`);
        refresh();
      } catch (err) {
        setStatus(`Couldn't read that audio file: ${err.message}`, true);
      }
      file.value = '';
    };

    const tools = h('div', 'bar');
    tools.append(
      builtinSel,
      btn('Import audio…', () => file.click(), 'Slice an audio file into frames (count from the menu; 1 frame = whole file as one cycle)'),
      countSel,
      btn('Add frame', () => {
        const nf = new Float32Array((count + 1) * WT.EDIT_SIZE);
        nf.set(frames.subarray(0, (cur + 1) * WT.EDIT_SIZE));
        nf.set(frames.subarray(cur * WT.EDIT_SIZE, (cur + 1) * WT.EDIT_SIZE), (cur + 1) * WT.EDIT_SIZE);
        nf.set(frames.subarray((cur + 1) * WT.EDIT_SIZE), (cur + 2) * WT.EDIT_SIZE);
        if (count >= WT.MAX_FRAMES) return setStatus(`At most ${WT.MAX_FRAMES} frames`, true);
        frames = nf;
        count++;
        cur++;
        refresh();
      }),
      btn('Delete frame', () => {
        if (count <= 1) return;
        const nf = new Float32Array((count - 1) * WT.EDIT_SIZE);
        nf.set(frames.subarray(0, cur * WT.EDIT_SIZE));
        nf.set(frames.subarray((cur + 1) * WT.EDIT_SIZE), cur * WT.EDIT_SIZE);
        frames = nf;
        count--;
        cur = Math.min(cur, count - 1);
        refresh();
      }),
      btn('Crossfade fill', () => {
        WT.morphFill(frames, count);
        refresh();
      }, 'Rebuild in-between frames as a crossfade from the first to the last'),
      btn('Spectral fill', () => {
        WT.spectralMorphFill(frames, count);
        refresh();
      }, 'Rebuild in-between frames by morphing harmonics from the first to the last'),
      btn('Normalize', () => {
        WT.normalize(WT.removeDC(frames, WT.EDIT_SIZE));
        refresh();
      }),
    );
    const formulaBar = h('div', 'bar');
    formulaBar.append(
      h('span', 'vx-hint', 'Formula'),
      formula,
      btn('Apply to all frames', () => {
        try {
          const n = Math.max(1, +countSel.value);
          const t = WT.framesFromFormula(formula.value, n);
          frames = t.frames;
          count = t.count;
          name = 'Formula';
          cur = 0;
          setStatus(`Generated ${count} frames`);
          refresh();
        } catch (err) {
          setStatus(err.message, true);
        }
      }),
    );
    const actions = h('div', 'bar');
    actions.append(
      btn('Use this wavetable', () => {
        node.setTable(o, WT.customSpec(name, frames, count));
        modal.remove();
      }),
      btn('Cancel', () => modal.remove()),
      status,
    );
    modal.append(title, overview, row(h('span', 'vx-hint', 'Frame'), frameSlider), drawCv, tools, formulaBar, actions, file);
    root.append(modal);
    requestAnimationFrame(refresh);
  }

  // ------------------------------------------------------------------ tabs + refresh

  const body = h('div');
  function showTab(t) {
    tabBtns.forEach((b) => b.classList.toggle('on', b.textContent === t));
    if (t === 'OSC') body.replaceChildren(oscTab);
    else if (t === 'FX') {
      drawFxOrder();
      body.replaceChildren(fxTab);
    } else {
      drawMatrix();
      body.replaceChildren(mxTab);
    }
    requestAnimationFrame(redrawAll);
  }

  function redrawAll() {
    presetName.textContent = node.name;
    syncPresetButtons();
    for (const fns of knobs.values()) for (const fn of fns) fn();
    drawWt('a');
    drawWt('b');
    editorDraw?.();
  }

  let pending = false;
  const listener = (kind, id) => {
    if (kind === 'param' && id) {
      for (const fn of knobs.get(id) ?? []) fn();
      return;
    }
    if (kind === 'routes') {
      if (mxTab.isConnected) drawMatrix();
    }
    if (kind === 'fx' && fxTab.isConnected) drawFxOrder();
    if (kind === 'lfo') editorDraw?.();
    if (kind === 'status') {
      if (!pending && editorDraw && selected.startsWith('lfo')) {
        pending = true;
        requestAnimationFrame(() => {
          pending = false;
          editorDraw?.();
        });
      }
      return;
    }
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      if (kind === 'all' && mxTab.isConnected) drawMatrix();
      redrawAll();
    });
  };
  node.listeners.add(listener);
  root.cleanup = () => node.listeners.delete(listener);

  root.append(top, presetBar, body);
  renderEditor();
  showTab('OSC');
  return root;
}
