// The arrangement (what Song mode plays), FL Studio-style: tracks of pattern
// clips placed anywhere in time. Clips can overlap (those patterns play
// together) and leave gaps (silence); a clip stretched past its pattern's
// length loops it.
//
//   click empty: place the current pattern (on the bar; Alt: on the beat)
//   drag a clip: move it · drag its end: stretch/shorten · right-click: delete
//   click a clip: edit its pattern · click the ruler: play from there
//   Ctrl+drag: box select · Ctrl+click: add/remove · Delete, Ctrl+C/X/V/A/B, Esc
//   Ctrl+wheel: zoom

import { STEPS_PER_BAR, MAX_TRACKS, MAX_SONG_STEPS, COLORS, clipLength, songLength } from './shared/schema.js';
import { clipboard, shortcut, box } from './clipboard.js';

const RULER_H = 22;
const ROW_H = 34;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class Playlist {
  constructor(root, actions) {
    this.root = root;
    this.actions = actions;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'playlist-canvas';
    root.append(this.canvas);
    this.project = null;
    this.patternId = null;
    this.start = 0; // song step to play from (mine)
    this.playStep = -1;
    this.barW = 56; // pixels per bar
    this.sel = new Set();
    this.drag = null;
    this.marquee = null;
    this.hover = null;
    this.dirty = true;

    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.down(e));
    c.addEventListener('pointermove', (e) => this.move(e));
    c.addEventListener('pointerup', (e) => this.up(e));
    c.addEventListener('pointercancel', () => {
      this.drag = null;
      this.marquee = null;
    });
    c.addEventListener('pointerleave', () => {
      this.hover = null;
      this.dirty = true;
    });
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const hit = this.hit(this.at(e));
      if (hit) {
        this.actions.beginGesture();
        this.actions.removeClips([hit.id]);
        this.sel.delete(hit.id);
      }
    });
    c.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        this.barW = clamp(this.barW * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 16, 200);
        this.dirty = true;
      },
      { passive: false },
    );
    new ResizeObserver(() => (this.dirty = true)).observe(root);
  }

  get stepW() {
    return this.barW / STEPS_PER_BAR;
  }

  set(project, { patternId, start }) {
    this.project = project;
    this.patternId = patternId;
    this.start = start;
    this.byId = new Map(project.patterns.map((p) => [p.id, p]));
    const ids = new Set(project.clips.map((c) => c.id));
    for (const id of this.sel) if (!ids.has(id)) this.sel.delete(id);
    this.dirty = true;
  }

  setPlayStep(step) {
    if (step !== this.playStep) {
      this.playStep = step;
      this.dirty = true;
    }
  }

  tracks() {
    const used = Math.max(-1, ...this.project.clips.map((c) => c.t));
    return clamp(used + 2, 4, MAX_TRACKS);
  }

  len(clip) {
    return clipLength(clip, this.byId);
  }

  color(patternId) {
    const i = this.project.patterns.findIndex((p) => p.id === patternId);
    return COLORS[(i < 0 ? 0 : i) % COLORS.length];
  }

  // ---------------------------------------------------------------- input

  at(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    return { x, y, step: x / this.stepW, track: Math.floor((y - RULER_H) / ROW_H), ruler: y < RULER_H };
  }

  hit(pos) {
    if (pos.ruler) return null;
    // Topmost (last drawn) first.
    return [...this.project.clips].reverse().find((c) => c.t === pos.track && pos.step >= c.s && pos.step < c.s + this.len(c)) ?? null;
  }

  onEdge(c, pos) {
    return (c.s + this.len(c)) * this.stepW - pos.x < Math.min(8, (this.len(c) * this.stepW) / 3);
  }

  /** Snap a step position: to the bar, or with Alt to the beat. */
  snap(step, fine) {
    const unit = fine ? 4 : STEPS_PER_BAR;
    return Math.round(step / unit) * unit;
  }

  down(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    this.actions.activate();
    this.canvas.setPointerCapture(e.pointerId);
    const pos = this.at(e);
    if (pos.ruler) {
      this.actions.setStart(clamp(this.snap(pos.step - (e.altKey ? 2 : 8), e.altKey), 0, MAX_SONG_STEPS - 1));
      return;
    }
    this.actions.beginGesture();
    const hit = this.hit(pos);
    if (e.ctrlKey || e.metaKey) {
      if (hit) {
        if (this.sel.has(hit.id)) this.sel.delete(hit.id);
        else this.sel.add(hit.id);
      } else this.marquee = { a: pos, b: pos, add: e.shiftKey };
      this.dirty = true;
      return;
    }
    if (hit) {
      if (!this.sel.has(hit.id)) this.sel.clear();
      const group = this.sel.size ? this.project.clips.filter((c) => this.sel.has(c.id)) : [hit];
      this.drag = {
        mode: this.onEdge(hit, pos) ? 'resize' : 'move',
        id: hit.id,
        origin: pos,
        start: group.map((c) => ({ ...c, len: this.len(c) })),
        moved: false,
        last: '0|0',
      };
    } else {
      if (this.sel.size) {
        this.sel.clear();
        this.dirty = true;
        return;
      }
      if (pos.track < 0 || pos.track >= MAX_TRACKS || !this.patternId) return;
      // Paint the current pattern here, then drag it where you want.
      const s = Math.max(0, Math.floor(pos.step / (e.altKey ? 4 : STEPS_PER_BAR)) * (e.altKey ? 4 : STEPS_PER_BAR));
      const id = this.actions.addClip({ p: this.patternId, t: pos.track, s });
      if (id) this.drag = { mode: 'move', id, origin: pos, start: [{ id, p: this.patternId, t: pos.track, s, len: this.len({ p: this.patternId }) }], moved: true, placed: true, last: '0|0' };
    }
    this.dirty = true;
  }

  move(e) {
    const pos = this.at(e);
    this.hover = pos;
    this.dirty = true;
    if (this.marquee) {
      this.marquee.b = pos;
      return;
    }
    const d = this.drag;
    if (!d) {
      const hit = this.hit(pos);
      this.canvas.style.cursor = pos.ruler ? 'pointer' : hit && this.onEdge(hit, pos) ? 'ew-resize' : hit ? 'grab' : 'copy';
      return;
    }
    const lead = d.start.find((c) => c.id === d.id);
    if (d.mode === 'move') {
      let ds = this.snap(lead.s + pos.step - d.origin.step, e.altKey) - lead.s;
      ds = Math.max(ds, -Math.min(...d.start.map((c) => c.s)));
      const dt = clamp(pos.track - d.origin.track, -Math.min(...d.start.map((c) => c.t)), MAX_TRACKS - 1 - Math.max(...d.start.map((c) => c.t)));
      const key = `${ds}|${dt}`;
      if (key === d.last) return;
      d.last = key;
      d.moved = true;
      this.actions.updateClips(d.start.map((c) => ({ id: c.id, s: c.s + ds, t: c.t + dt })));
    } else {
      const end = Math.max(lead.s + (e.altKey ? 1 : 4), this.snap(pos.step, e.altKey));
      const dl = end - lead.s - lead.len;
      const key = `${dl}`;
      if (key === d.last) return;
      d.last = key;
      d.moved = true;
      // A clip at exactly its pattern's length goes back to following the pattern.
      this.actions.updateClips(
        d.start.map((c) => {
          const l = Math.max(1, c.len + dl);
          const own = (this.byId.get(c.p)?.bars ?? 1) * STEPS_PER_BAR;
          return { id: c.id, l: l === own ? null : l };
        }),
      );
    }
  }

  up() {
    if (this.marquee) {
      const m = this.marquee;
      this.marquee = null;
      const r = box({ x: m.a.step, y: m.a.track }, { x: m.b.step, y: m.b.track });
      if (!m.add) this.sel.clear();
      for (const c of this.project.clips) if (c.s < r.x1 && c.s + this.len(c) > r.x0 && c.t >= r.y0 && c.t <= r.y1) this.sel.add(c.id);
      this.dirty = true;
      return;
    }
    const d = this.drag;
    this.drag = null;
    if (d && !d.moved) {
      // A click on a clip: edit its pattern.
      const clip = this.project.clips.find((c) => c.id === d.id);
      if (clip) this.actions.selectPattern(clip.p);
    }
    this.dirty = true;
  }

  /** Keyboard shortcuts while the arrangement is in use. Returns true if handled. */
  key(e) {
    const del = e.key === 'Delete' || e.key === 'Backspace';
    if (e.key === 'Escape') {
      if (!this.sel.size) return false;
      this.sel.clear();
      this.dirty = true;
      return true;
    }
    if (shortcut(e, 'a')) {
      for (const c of this.project.clips) this.sel.add(c.id);
      this.dirty = true;
      return true;
    }
    if (shortcut(e, 'v')) {
      const items = clipboard.get('clips');
      if (items?.length) {
        this.actions.beginGesture();
        this.sel = new Set(this.actions.addClips(items));
        this.dirty = true;
      }
      return true;
    }
    const group = this.project.clips.filter((c) => this.sel.has(c.id));
    if (!group.length) return del || shortcut(e, 'c') || shortcut(e, 'x') || shortcut(e, 'b');
    const items = group.map(({ id, ...c }) => c);
    if (shortcut(e, 'c')) clipboard.set('clips', items);
    else if (shortcut(e, 'x') || del) {
      if (!del) clipboard.set('clips', items);
      this.actions.beginGesture();
      this.actions.removeClips(group.map((c) => c.id));
      this.sel.clear();
    } else if (shortcut(e, 'b')) {
      // Duplicate right after the selection (whole bars).
      const start = Math.min(...group.map((c) => c.s));
      const span = Math.max(...group.map((c) => c.s + this.len(c))) - start;
      const shift = Math.ceil(span / STEPS_PER_BAR - 1e-9) * STEPS_PER_BAR;
      this.actions.beginGesture();
      this.sel = new Set(this.actions.addClips(items.map((c) => ({ ...c, s: c.s + shift }))));
    } else return false;
    this.dirty = true;
    return true;
  }

  // ---------------------------------------------------------------- drawing

  draw() {
    if (!this.dirty || !this.project || this.root.closest('[hidden]')) return;
    this.dirty = false;
    const sw = this.stepW;
    const tracks = this.tracks();
    const end = songLength(this.project);
    const steps = Math.max(Math.ceil((this.root.clientWidth || 600) / sw), end + 8 * STEPS_PER_BAR, this.start + 4 * STEPS_PER_BAR);
    const W = Math.ceil(steps * sw);
    const H = RULER_H + tracks * ROW_H;
    const dpr = window.devicePixelRatio || 1;
    const c = this.canvas;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
      c.style.width = `${W}px`;
      c.style.height = `${H}px`;
    }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#171a21';
    g.fillRect(0, 0, W, H);
    for (let t = 0; t < tracks; t++) {
      g.fillStyle = t % 2 ? '#191c24' : '#171a21';
      g.fillRect(0, RULER_H + t * ROW_H, W, ROW_H);
    }
    // Grid: bars (and beats when there's room).
    for (let s = 0; s <= steps; s += 4) {
      const bar = s % STEPS_PER_BAR === 0;
      if (!bar && this.barW < 48) continue;
      g.fillStyle = bar ? '#2f3542' : '#1f232c';
      g.fillRect(Math.round(s * sw), RULER_H, 1, H - RULER_H);
    }
    // Ruler
    g.fillStyle = '#1d2129';
    g.fillRect(0, 0, W, RULER_H);
    g.fillStyle = '#8b92a5';
    g.font = '600 10px Inter, system-ui, sans-serif';
    const every = this.barW < 28 ? 4 : this.barW < 40 ? 2 : 1;
    for (let b = 0; b * STEPS_PER_BAR <= steps; b += every) g.fillText(String(b + 1), b * this.barW + 4, 15);
    // End of the song (where it loops).
    if (end > 0) {
      g.fillStyle = 'rgba(255,255,255,0.25)';
      g.fillRect(end * sw, 0, 1, H);
    }
    // Play-from marker
    const sx = this.start * sw;
    g.fillStyle = '#ff8a3d';
    g.beginPath();
    g.moveTo(sx, RULER_H - 2);
    g.lineTo(sx + 8, 4);
    g.lineTo(sx, 4);
    g.closePath();
    g.fill();

    // Clips
    for (const clip of this.project.clips) {
      const pattern = this.byId.get(clip.p);
      if (!pattern) continue;
      const len = this.len(clip);
      const x = clip.s * sw;
      const y = RULER_H + clip.t * ROW_H + 2;
      const w = Math.max(4, len * sw - 1);
      const h = ROW_H - 4;
      const color = this.color(clip.p);
      const editing = clip.p === this.patternId;
      g.globalAlpha = editing ? 0.95 : 0.7;
      g.fillStyle = color;
      roundRect(g, x, y, w, h, 4);
      g.fill();
      g.globalAlpha = 1;
      g.save();
      roundRect(g, x, y, w, h, 4);
      g.clip();
      // Where the pattern loops inside a stretched clip.
      const plen = pattern.bars * STEPS_PER_BAR;
      g.fillStyle = 'rgba(0,0,0,0.35)';
      for (let s = plen; s < len; s += plen) g.fillRect(x + s * sw, y, 1, h);
      // A sketch of what's in it.
      g.fillStyle = 'rgba(0,0,0,0.35)';
      const pitches = pattern.notes.map((n) => n.p);
      const lo = Math.min(...pitches, 48);
      const span = Math.max(12, Math.max(...pitches, 60) - lo + 1);
      for (let rep = 0; rep < len; rep += plen) {
        for (const n of pattern.notes) {
          if (n.s + rep >= len) continue;
          const ny = y + h - 6 - ((n.p - lo) / span) * (h - 22); // below the name
          g.fillRect(x + (n.s + rep) * sw, ny, Math.max(1, Math.min(n.l, len - rep - n.s) * sw - 1), 2);
        }
        for (const [k] of pattern.steps) {
          const s = +k.split(':')[1];
          if (s + rep < len) g.fillRect(x + (s + rep) * sw, y + h - 3, Math.max(1, sw - 1), 2);
        }
      }
      g.fillStyle = 'rgba(0,0,0,0.85)';
      g.font = '700 10px Inter, system-ui, sans-serif';
      g.fillText(pattern.name, x + 5, y + 12);
      g.restore();
      if (this.sel.has(clip.id)) {
        g.strokeStyle = '#fff';
        g.lineWidth = 2;
        roundRect(g, x, y, w, h, 4);
        g.stroke();
      }
    }

    // Selection box
    if (this.marquee) {
      const r = box(this.marquee.a, this.marquee.b);
      g.fillStyle = 'rgba(255,255,255,0.08)';
      g.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
      g.strokeStyle = 'rgba(255,255,255,0.7)';
      g.lineWidth = 1;
      g.strokeRect(r.x0 + 0.5, r.y0 + 0.5, r.x1 - r.x0, r.y1 - r.y0);
    }
    // Ghost of where a click would place the current pattern.
    const hv = this.hover;
    if (hv && !this.drag && !hv.ruler && hv.track >= 0 && hv.track < tracks && !this.hit(hv) && this.patternId) {
      const s = Math.floor(hv.step / STEPS_PER_BAR) * STEPS_PER_BAR;
      g.strokeStyle = 'rgba(255,255,255,0.3)';
      g.setLineDash([4, 3]);
      g.strokeRect(s * sw + 0.5, RULER_H + hv.track * ROW_H + 2.5, this.len({ p: this.patternId }) * sw - 1, ROW_H - 5);
      g.setLineDash([]);
    }
    // Playhead
    if (this.playStep >= 0) {
      g.fillStyle = '#fff';
      g.fillRect(this.playStep * sw, 0, 1, H);
    }
  }
}

function roundRect(g, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
