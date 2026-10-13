// Automation lanes for one channel in the current pattern: volume, pan, and
// any parameter of the channel's plugin instrument or plugin effects.
// Points live in the shared project, so everyone sees (and hears) them.

import { STEPS_PER_BAR, BEND_RANGES, laneValueAt } from './shared/schema.js';

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
    c.addEventListener('pointerup', () => (this.drag = null));
    c.addEventListener('dblclick', (e) => this.removeAt(e));
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.removeAt(e);
    });
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

  down(e) {
    if (e.button !== 0 || !this.laneId) return;
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    this.actions.beginGesture();
    const pos = this.at(e);
    const hit = this.hit(pos);
    const id = hit ? hit.id : this.actions.setPoint(this.laneId, null, { s: pos.s, v: pos.v });
    this.drag = { id };
  }

  move(e) {
    if (!this.drag) return;
    const pos = this.at(e);
    this.actions.setPoint(this.laneId, this.drag.id, { s: pos.s, v: pos.v });
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
    const cw = this.cellW;
    g.strokeStyle = color;
    g.lineWidth = width;
    g.beginPath();
    g.moveTo(0, Y(laneValueAt(points, 0)));
    for (const p of points) g.lineTo(p.s * cw, Y(p.v));
    g.lineTo(W, Y(points.at(-1).v));
    g.stroke();
  }
}
