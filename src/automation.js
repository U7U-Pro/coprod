// Automation lanes for one channel in the current pattern: volume, pan, and
// any parameter of the channel's plugin instrument or plugin effects.
// Points live in the shared project, so everyone sees (and hears) them.

import { STEPS_PER_BAR, BEND_RANGES, CURVES, curveShape, curveCount, segmentAt, laneValueAt } from './shared/schema.js';

const HEIGHT = 150;
const PAD = 8;

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export class AutomationPanel {
  constructor(root, engine, actions) {
    this.root = root;
    this.engine = engine;
    this.actions = actions;
    this.channelId = null;
    this.laneId = null;
    this.pattern = null;
    this.project = null;
    this.playStep = -1;
    this.drag = null;
    this.infoCache = new Map(); // slot key -> Promise<param info>
    this.dirty = true;

    this.title = root.querySelector('.ap-title');
    this.swatch = root.querySelector('.swatch');
    this.tabs = root.querySelector('.ap-lanes');
    this.add = root.querySelector('.ap-add');
    this.del = root.querySelector('.ap-del');
    this.range = root.querySelector('.ap-range');
    this.rangeNote = root.querySelector('.ap-range-note');
    const rangeSel = this.range.querySelector('select');
    for (const r of BEND_RANGES) rangeSel.append(new Option(`±${r} semitone${r > 1 ? 's' : ''}`, r));
    rangeSel.onchange = () => actions.setLane(this.laneId, { range: +rangeSel.value });
    this.body = root.querySelector('.ap-body');
    this.canvas = root.querySelector('.ap-canvas');
    root.querySelector('.ap-close').onclick = () => this.close();
    this.add.onchange = () => {
      const [target, ...label] = this.add.value.split('|');
      this.add.value = '';
      if (!target) return;
      const id = actions.addLane(this.channelId, target, label.join('|'));
      if (id) this.laneId = id;
    };
    this.del.onclick = () => {
      if (this.laneId) actions.removeLane(this.laneId);
      this.laneId = null;
    };

    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.down(e));
    c.addEventListener('pointermove', (e) => this.move(e));
    c.addEventListener('pointerup', (e) => this.up(e));
    c.addEventListener('pointercancel', () => this.cancelPress());
    c.addEventListener('dblclick', (e) => this.removeAt(e));
    // Right-click (or long-press on touch) opens the curve menu for a segment.
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.openMenu(e);
    });
    this.menu = el('div', 'ap-menu');
    this.menu.hidden = true;
    root.append(this.menu);
    document.addEventListener('pointerdown', (e) => {
      if (!this.menu.hidden && !this.menu.contains(e.target)) this.closeMenu();
    });
    document.addEventListener('keydown', (e) => e.key === 'Escape' && this.closeMenu());
    new ResizeObserver(() => (this.dirty = true)).observe(this.body);
  }

  open(channelId) {
    if (this.channelId !== channelId) this.laneId = null;
    this.channelId = channelId;
    this.root.hidden = false;
    this.dirty = true;
  }

  close() {
    this.channelId = null;
    this.root.hidden = true;
    this.actions.onClose?.();
  }

  get length() {
    return (this.pattern?.bars ?? 1) * STEPS_PER_BAR;
  }

  get cellW() {
    return Math.max(22, Math.floor((this.body.clientWidth - 2) / this.length));
  }

  lanes() {
    return (this.pattern?.lanes ?? []).filter((l) => l.ch === this.channelId);
  }

  lane() {
    return this.lanes().find((l) => l.id === this.laneId);
  }

  render(project, pattern) {
    this.project = project;
    this.pattern = pattern;
    if (!this.channelId) return;
    const c = project.channels.find((x) => x.id === this.channelId);
    if (!c) return this.close();
    const lanes = this.lanes();
    if (!lanes.some((l) => l.id === this.laneId)) this.laneId = lanes[0]?.id ?? null;
    this.title.textContent = `Automation · ${c.name} · ${pattern.name}`;
    this.swatch.style.background = c.color;
    this.tabs.replaceChildren(
      ...lanes.map((l) => {
        const b = el('button', `tab ${l.id === this.laneId ? 'on' : ''}`, l.label);
        b.onclick = () => {
          this.laneId = l.id;
          this.render(this.project, this.pattern);
        };
        return b;
      }),
    );
    if (!lanes.length) this.tabs.append(el('span', 'hint', 'No lanes yet: add one to automate a knob over this pattern.'));
    this.del.hidden = !this.laneId;
    // Bend range: ours for built-in sounds, the plugin's own for plugins.
    const lane = this.lane();
    const isBend = lane?.target === 'bend';
    this.range.hidden = !isBend || c.inst === 'wam';
    this.rangeNote.hidden = !isBend || c.inst !== 'wam';
    if (isBend) this.range.querySelector('select').value = lane.range ?? 2;
    this.fillAddMenu(c, new Set(lanes.map((l) => l.target)));
    this.dirty = true;
  }

  /** "+ Add lane" lists the mixer, then each plugin's parameters. */
  async fillAddMenu(c, used) {
    const groups = [['Channel', [['vol', 'Volume'], ['pan', 'Pan'], ['bend', 'Pitch bend']]]];
    const slots = [];
    if (c.inst === 'wam') slots.push({ key: c.id, prefix: 'p:', name: c.plugin?.name ?? 'Plugin' });
    for (const f of c.fx ?? []) slots.push({ key: `${c.id}/${f.id}`, prefix: `fx:${f.id}:`, name: f.name });
    for (const s of slots) {
      const info = await this.paramInfo(s.key);
      if (!info) continue;
      // Split big plugins by their own parameter groups.
      const byGroup = new Map();
      for (const p of Object.values(info)) {
        const g = p.group ? `${s.name} · ${p.group}` : s.name;
        if (!byGroup.has(g)) byGroup.set(g, []);
        byGroup.get(g).push([`${s.prefix}${p.id}`, p.label ?? p.id]);
      }
      groups.push(...byGroup.entries());
    }
    const key = JSON.stringify([groups, [...used]]);
    if (key === this.menuKey) return;
    this.menuKey = key;
    this.add.replaceChildren(new Option('+ Add lane…', ''));
    for (const [label, items] of groups) {
      const og = document.createElement('optgroup');
      og.label = label;
      for (const [target, name] of items) {
        if (used.has(target)) continue;
        const prefix = target.startsWith('p:') || target.startsWith('fx:') ? `${label.split(' · ')[0]}: ` : '';
        og.append(new Option(name, `${target}|${prefix}${name}`));
      }
      if (og.children.length) this.add.append(og);
    }
  }

  paramInfo(key) {
    const slot = this.engine.slots.get(key);
    if (slot?.status !== 'ready' || !slot.node.getParameterInfo) return Promise.resolve(null);
    const cacheKey = `${key}|${slot.url}`;
    if (!this.infoCache.has(cacheKey)) this.infoCache.set(cacheKey, slot.node.getParameterInfo().catch(() => null));
    return this.infoCache.get(cacheKey);
  }

  // ---------------------------------------------------------------- editing

  at(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const s = x / this.cellW;
    let v = 1 - (y - PAD) / (HEIGHT - PAD * 2);
    // Centered lanes (pan, bend) snap to the middle so "no bend" is easy to hit.
    if (this.centered() && !e.shiftKey && Math.abs(v - 0.5) < 0.04) v = 0.5;
    return {
      s: e.shiftKey ? s : Math.round(s * 4) / 4, // snap to 1/4 step unless Shift
      v,
      x,
      y,
    };
  }

  centered() {
    const t = this.lane()?.target;
    return t === 'bend' || t === 'pan';
  }

  hit(pos) {
    const lane = this.lane();
    if (!lane) return null;
    const X = (s) => s * this.cellW;
    const Y = (v) => PAD + (1 - v) * (HEIGHT - PAD * 2);
    return lane.points.find((p) => Math.hypot(X(p.s) - pos.x, Y(p.v) - pos.y) < 9) ?? null;
  }

  /** Tension handles: one in the middle of each segment that has an amount. */
  handles() {
    const lane = this.lane();
    if (!lane) return [];
    const cw = this.cellW;
    const Y = (v) => PAD + (1 - v) * (HEIGHT - PAD * 2);
    const out = [];
    const pts = lane.points;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      if ((b.s - a.s) * cw < 18 || !CURVES[a.c]?.amount) continue;
      const mid = (a.s + b.s) / 2;
      out.push({ i, point: a, x: mid * cw, y: Y(laneValueAt(pts, mid)), rising: b.v >= a.v });
    }
    return out;
  }

  down(e) {
    if (e.button !== 0 || !this.laneId) return;
    e.preventDefault();
    this.closeMenu();
    this.canvas.setPointerCapture(e.pointerId);
    this.actions.beginGesture();
    const pos = this.at(e);
    // Long-press opens the menu on touch screens.
    if (e.pointerType === 'touch') {
      this.press = { x: e.clientX, y: e.clientY, timer: setTimeout(() => this.longPress(e), 500) };
    }
    const handle = this.handles().find((h) => Math.hypot(h.x - pos.x, h.y - pos.y) < 8);
    if (handle) {
      this.drag = { tension: handle, y: e.clientY, t: handle.point.t ?? 0 };
      return;
    }
    const hit = this.hit(pos);
    if (hit) this.drag = { id: hit.id };
    else if (e.pointerType === 'touch') this.drag = { pending: pos }; // add on tap/drag, not on long-press
    else this.drag = { id: this.actions.setPoint(this.laneId, null, { s: pos.s, v: pos.v }) };
  }

  move(e) {
    if (this.press && Math.hypot(e.clientX - this.press.x, e.clientY - this.press.y) > 8) this.cancelPress();
    const d = this.drag;
    if (!d) return;
    if (d.tension) {
      // Drag the handle toward where the curve should bend.
      const dy = (d.y - e.clientY) / 70;
      const single = (d.tension.point.c ?? 'single') === 'single';
      const t = d.t + (single && d.tension.rising ? -dy : dy);
      this.actions.setCurve(this.laneId, d.tension.point.id, { t: Math.max(-1, Math.min(1, t)) });
      return;
    }
    if (d.pending) {
      if (Math.hypot(e.clientX - this.press?.x, e.clientY - this.press?.y) < 6) return;
      d.id = this.actions.setPoint(this.laneId, null, { s: d.pending.s, v: d.pending.v });
      delete d.pending;
    }
    const pos = this.at(e);
    this.actions.setPoint(this.laneId, d.id, { s: pos.s, v: pos.v });
  }

  up() {
    if (this.drag?.pending) this.actions.setPoint(this.laneId, null, { s: this.drag.pending.s, v: this.drag.pending.v });
    this.cancelPress();
    this.drag = null;
  }

  cancelPress() {
    if (this.press) clearTimeout(this.press.timer);
    this.press = null;
  }

  longPress(e) {
    this.press = null;
    this.drag = null;
    this.openMenu(e);
  }

  // ---------------------------------------------------------------- curve menu

  openMenu(e) {
    const lane = this.lane();
    if (!lane) return;
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const pts = lane.points;
    const onPoint = this.hit(this.at(e));
    const seg = segmentAt(pts, x / this.cellW);
    const segPoint = seg >= 0 && seg < pts.length - 1 ? pts[seg] : null;
    if (!segPoint && !onPoint) return;
    const m = this.menu;
    m.replaceChildren();
    if (segPoint) {
      m.append(el('h4', '', 'Curve'));
      const list = el('div', 'ap-curves');
      for (const [c, info] of Object.entries(CURVES)) {
        const b = el('button', `ap-curve ${segPoint.c === c ? 'on' : ''}`);
        b.append(curveIcon(c, segPoint.c === c ? segPoint.t : 0), el('span', '', info.label));
        b.onclick = () => {
          this.actions.beginGesture();
          this.actions.setCurve(this.laneId, segPoint.id, { c, t: segPoint.c === c ? segPoint.t : 0 });
          segPoint.c = c;
          this.openMenuAt(e, segPoint, onPoint);
        };
        list.append(b);
      }
      m.append(list);
      const info = CURVES[segPoint.c];
      if (info?.amount) {
        const row = el('label', 'ap-amount');
        const slider = el('input');
        Object.assign(slider, { type: 'range', min: -100, max: 100, step: 1, value: Math.round((segPoint.t ?? 0) * 100) });
        const out = el('output', '', amountText(segPoint.c, segPoint.t ?? 0));
        slider.onpointerdown = () => this.actions.beginGesture();
        slider.oninput = () => {
          const t = slider.value / 100;
          out.textContent = amountText(segPoint.c, t);
          this.actions.setCurve(this.laneId, segPoint.id, { t });
        };
        const reset = el('button', 'ghost', 'Reset');
        reset.onclick = () => {
          slider.value = 0;
          slider.oninput();
        };
        row.append(el('span', '', info.amount), slider, out, reset);
        m.append(row);
      }
    }
    if (onPoint) {
      const del = el('button', 'ghost danger ap-delpt', 'Delete point');
      del.onclick = () => {
        this.actions.removePoint(this.laneId, onPoint.id);
        this.closeMenu();
      };
      m.append(del);
    }
    m.hidden = false;
    // Place it at the pointer, kept inside the panel.
    const host = this.root.getBoundingClientRect();
    const mw = m.offsetWidth;
    const mh = m.offsetHeight;
    m.style.left = `${Math.max(4, Math.min(host.width - mw - 4, e.clientX - host.left))}px`;
    m.style.top = `${Math.max(4, Math.min(host.height - mh - 4, e.clientY - host.top))}px`;
  }

  /** Re-open after a change, so the slider label matches the new curve type. */
  openMenuAt(e, segPoint) {
    requestAnimationFrame(() => this.openMenu({ clientX: e.clientX, clientY: e.clientY, shiftKey: true }));
  }

  closeMenu() {
    this.menu.hidden = true;
  }

  removeAt(e) {
    const hit = this.hit(this.at(e));
    if (hit) this.actions.removePoint(this.laneId, hit.id);
  }

  setPlayStep(step) {
    if (step !== this.playStep) {
      this.playStep = step;
      this.dirty = true;
    }
  }

  draw() {
    if (!this.dirty || !this.channelId || !this.pattern) return;
    this.dirty = false;
    const cw = this.cellW;
    const W = cw * this.length;
    const dpr = window.devicePixelRatio || 1;
    const c = this.canvas;
    if (c.width !== W * dpr || c.height !== HEIGHT * dpr) {
      c.width = W * dpr;
      c.height = HEIGHT * dpr;
      c.style.width = `${W}px`;
      c.style.height = `${HEIGHT}px`;
    }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#171a21';
    g.fillRect(0, 0, W, HEIGHT);
    for (let s = 0; s <= this.length; s++) {
      g.fillStyle = s % 16 === 0 ? '#3a4050' : s % 4 === 0 ? '#2a2f3b' : '#1f232c';
      g.fillRect(s * cw, 0, 1, HEIGHT);
    }
    const Y = (v) => PAD + (1 - v) * (HEIGHT - PAD * 2);
    g.fillStyle = '#262a34';
    g.fillRect(0, Y(0.5), W, 1);
    const color = this.project.channels.find((x) => x.id === this.channelId)?.color ?? '#fff';

    // other lanes of this channel, faint
    for (const lane of this.lanes()) {
      if (lane.id === this.laneId || !lane.points.length) continue;
      this.curve(g, lane.points, W, Y, 'rgba(255,255,255,0.12)', 1);
    }
    const lane = this.lane();
    const base = this.centered() ? 0.5 : 0;
    if (base) {
      g.fillStyle = '#3a4050';
      g.fillRect(0, Y(0.5), W, 1);
      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.font = '10px Inter, system-ui, sans-serif';
      const c = this.project.channels.find((x) => x.id === this.channelId);
      const r = lane?.target === 'bend' ? (c?.inst === 'wam' ? null : lane.range ?? 2) : null;
      const top = lane?.target === 'pan' ? 'R' : r ? `+${r} st` : 'up';
      const bottom = lane?.target === 'pan' ? 'L' : r ? `−${r} st` : 'down';
      g.fillText(top, 4, 18);
      g.fillText(bottom, 4, HEIGHT - 6);
    }
    if (lane) {
      if (lane.points.length) {
        // fill between the curve and the baseline (the middle for pan/bend)
        g.beginPath();
        g.moveTo(0, Y(base));
        for (let x = 0; x <= W; x += 2) g.lineTo(x, Y(laneValueAt(lane.points, x / cw)));
        g.lineTo(W, Y(base));
        g.closePath();
        g.fillStyle = `${color}22`;
        g.fill();
        this.curve(g, lane.points, W, Y, color, 2);
        g.fillStyle = '#fff';
        for (const p of lane.points) {
          g.beginPath();
          g.arc(p.s * cw, Y(p.v), 4, 0, Math.PI * 2);
          g.fill();
        }
        // tension handles
        g.lineWidth = 1.5;
        for (const h of this.handles()) {
          g.strokeStyle = 'rgba(255,255,255,0.8)';
          g.fillStyle = '#171a21';
          g.beginPath();
          g.arc(h.x, h.y, 3.5, 0, Math.PI * 2);
          g.fill();
          g.stroke();
        }
      } else {
        g.fillStyle = 'rgba(255,255,255,0.4)';
        g.font = '12px Inter, system-ui, sans-serif';
        g.fillText('Click to add the first point', 12, HEIGHT / 2 - 8);
      }
    }
    if (this.playStep >= 0) {
      g.fillStyle = '#fff';
      g.fillRect(this.playStep * cw, 0, 1, HEIGHT);
    }
  }

  curve(g, points, W, Y, color, width) {
    // Sample the real shape, so the line shows exactly what plays.
    const cw = this.cellW;
    g.strokeStyle = color;
    g.lineWidth = width;
    g.beginPath();
    for (let x = 0; x <= W; x += 1) {
      const y = Y(laneValueAt(points, x / cw));
      if (x) g.lineTo(x, y);
      else g.moveTo(x, y);
    }
    g.stroke();
  }

}

function amountText(c, t) {
  const kind = CURVES[c]?.amount;
  if (kind === 'Steps' || kind === 'Cycles') return `${Math.max(c === 'pulse' || c === 'wave' ? 1 : 2, curveCount(t))}`;
  return `${t > 0 ? '+' : ''}${Math.round(t * 100)}%`;
}

/** A tiny picture of a curve type for the menu. */
function curveIcon(c, t) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 36 20');
  svg.setAttribute('width', '36');
  svg.setAttribute('height', '20');
  const path = document.createElementNS(NS, 'path');
  let d = '';
  for (let i = 0; i <= 36; i++) {
    const x = i / 36;
    // Show the shape at a typical amount when it's flat at zero.
    const amt = (c === 'single' || c === 'double') && !t ? 0.45 : t;
    const y = curveShape(c, amt, x === 1 ? 0.9999 : x);
    d += `${i ? 'L' : 'M'}${i},${(18 - y * 16).toFixed(1)}`;
  }
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.6');
  svg.append(path);
  return svg;
}
