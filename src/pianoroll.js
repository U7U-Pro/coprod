// Piano roll for one synth channel, drawn on canvas. Shows other synth
// channels as faint "ghost" notes for harmony, and other people's cursors
// when they are in the same roll.
//
// Editing:
//   click empty: add a note (and drag to set its length) · drag a note: move ·
//   drag its end: resize · click a note: delete · right-click: delete
//   Alt while dragging: free position/length (1/24 step) · Alt+click a note: its lyric
//   Ctrl+drag: select with a box · Ctrl+click: add/remove a note from the selection
//   with a selection: dragging one moves (or resizes) them all; Delete, Ctrl+C/X/V,
//   Ctrl+A, Ctrl+B (duplicate after), Esc
// Modes: lyrics (click a note to type its syllable) and slide (draw each note's
// pitch over its length, Ableton-style).
// There's always one empty bar after the pattern: writing there makes it longer.

import { shortName } from './ui.js';
import { MIN_PITCH, MAX_PITCH, STEPS_PER_BAR, MAX_BARS, TICKS, SLIDE_RANGE, tick, slideAt } from './shared/schema.js';
import { clipboard, shortcut, box, simplify } from './clipboard.js';

const ROW_H = 16;
const KEYS_W = 56;
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const isBlack = (p) => [1, 3, 6, 8, 10].includes(p % 12);
const noteName = (p) => `${NAMES[p % 12]}${Math.floor(p / 12) - 1}`;
const ROWS = MAX_PITCH - MIN_PITCH + 1;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class PianoRoll {
  constructor(root, actions) {
    this.root = root;
    this.actions = actions;
    this.keys = document.createElement('canvas');
    this.keys.className = 'keys';
    this.grid = document.createElement('canvas');
    this.grid.className = 'grid';
    const inner = document.createElement('div');
    inner.className = 'roll-inner';
    inner.append(this.keys, this.grid);
    root.append(inner);

    this.channel = null;
    this.pattern = null;
    this.patternId = null;
    this.project = null;
    this.remote = [];
    this.drag = null;
    this.slideDrag = null;
    this.marquee = null;
    this.sel = new Set(); // selected note ids (mine only)
    this.mode = 'notes'; // 'notes' | 'lyrics' | 'slide'
    this.editor = null; // { input, id }
    this.lastLen = 2;
    this.hover = null;
    this.playStep = -1;
    this.dirty = true;

    this.grid.addEventListener('pointerdown', (e) => this.down(e));
    this.grid.addEventListener('pointermove', (e) => this.move(e));
    this.grid.addEventListener('pointerup', (e) => this.up(e));
    this.grid.addEventListener('pointercancel', () => {
      this.drag = null;
      this.slideDrag = null;
      this.marquee = null;
    });
    this.grid.addEventListener('pointerleave', () => {
      this.hover = null;
      this.actions.cursor(null);
      this.dirty = true;
    });
    this.grid.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.context(e);
    });
    this.keys.addEventListener('pointerdown', (e) => {
      const p = this.at(e).pitch;
      this.actions.preview(p);
    });
    new ResizeObserver(() => {
      this.dirty = true;
    }).observe(root);
    root.addEventListener('scroll', () => (this.dirty = true), { passive: true });
  }

  get lyricMode() {
    return this.mode === 'lyrics';
  }

  setMode(mode) {
    if (mode !== 'lyrics') this.closeEditor(true);
    this.mode = mode;
    this.dirty = true;
  }

  setLyricMode(on) {
    this.setMode(on ? 'lyrics' : 'notes');
  }

  /** The pattern's length in steps. */
  get length() {
    return this.pattern.bars * STEPS_PER_BAR;
  }

  /** What's drawn: the pattern plus one bar to write into. */
  get shown() {
    return Math.min(this.length + STEPS_PER_BAR, MAX_BARS * STEPS_PER_BAR);
  }

  get cellW() {
    const avail = this.root.clientWidth - KEYS_W - 2;
    return Math.max(22, Math.floor(avail / this.shown));
  }

  open(channelId) {
    const first = this.channel !== channelId;
    if (first) {
      this.closeEditor(false);
      this.sel.clear();
    }
    this.channel = channelId;
    this.dirty = true;
    if (first) this.pendingScroll = true; // after the next draw gives the canvas its height
  }

  set(project, pattern, remote) {
    if (pattern.id !== this.patternId) {
      this.closeEditor(false);
      this.sel.clear();
      this.patternId = pattern.id;
    }
    this.project = project;
    this.pattern = pattern;
    this.remote = remote;
    // Forget selected notes someone deleted.
    if (this.sel.size) {
      const ids = new Set(pattern.notes.map((n) => n.id));
      for (const id of this.sel) if (!ids.has(id)) this.sel.delete(id);
    }
    this.dirty = true;
  }

  notes() {
    return this.pattern.notes.filter((n) => n.ch === this.channel);
  }

  /** This channel's notes in singing order: by time, highest first in a chord. */
  ordered() {
    return this.notes().sort((a, b) => a.s - b.s || b.p - a.p);
  }

  selected() {
    return this.notes().filter((n) => this.sel.has(n.id));
  }

  scrollToNotes() {
    const notes = this.pattern?.notes.filter((n) => n.ch === this.channel) ?? [];
    const ch = this.project?.channels.find((c) => c.id === this.channel);
    const center = notes.length ? notes.reduce((a, n) => a + n.p, 0) / notes.length : ch?.inst === 'bass' ? 40 : 64;
    this.root.scrollTop = (MAX_PITCH - center) * ROW_H - this.root.clientHeight / 2;
  }

  // ---------------------------------------------------------------- input

  at(e) {
    const rect = this.grid.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    return { x: x / this.cellW, pitch: clamp(MAX_PITCH - Math.floor(y / ROW_H), MIN_PITCH, MAX_PITCH), px: x, py: y };
  }

  hit({ x, pitch }) {
    return this.notes().find((n) => n.p === pitch && x >= n.s && x < n.s + n.l);
  }

  onEdge(n, pos) {
    return (n.s + n.l) * this.cellW - pos.px < Math.min(10, (n.l * this.cellW) / 3);
  }

  down(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    this.grid.setPointerCapture(e.pointerId);
    this.actions.beginGesture();
    const pos = this.at(e);
    if (this.mode === 'slide') return this.slideDown(e, pos);
    const hit = this.hit(pos);
    if (e.ctrlKey || e.metaKey) {
      if (hit) {
        if (this.sel.has(hit.id)) this.sel.delete(hit.id);
        else this.sel.add(hit.id);
      } else this.marquee = { a: pos, b: pos, add: e.shiftKey };
      this.dirty = true;
      return;
    }
    if (hit && this.mode === 'lyrics') return this.openEditor(hit.id);
    this.closeEditor(true);
    if (hit) {
      const edge = this.onEdge(hit, pos);
      if (!this.sel.has(hit.id)) this.sel.clear(); // grabbing an unselected note: just that one
      const group = this.sel.size ? this.selected() : [hit];
      this.drag = { mode: edge ? 'resize' : 'move', id: hit.id, origin: pos, start: group.map((n) => ({ ...n })), moved: false, alt: e.altKey, last: '0|0' };
      if (!edge) this.actions.preview(hit.p, hit);
    } else {
      if (this.sel.size) {
        this.sel.clear(); // first click on empty space just deselects
        this.dirty = true;
        return;
      }
      const s = e.altKey ? tick(pos.x) : Math.floor(pos.x);
      const id = this.actions.addNote({ p: pos.pitch, s, l: this.lastLen });
      this.drag = { mode: 'resize', id, origin: pos, start: [{ id, s, l: this.lastLen, p: pos.pitch }], created: true, moved: false, alt: e.altKey, last: '' };
      this.actions.preview(pos.pitch);
    }
    this.dirty = true;
  }

  move(e) {
    const pos = this.at(e);
    this.hover = pos;
    this.actions.cursor({ x: pos.x, y: pos.pitch });
    this.dirty = true;
    if (this.marquee) {
      this.marquee.b = pos;
      return;
    }
    if (this.slideDrag) return this.slideMove(e, pos);
    const d = this.drag;
    if (!d) {
      if (this.mode === 'slide') {
        this.grid.style.cursor = this.slideHandle(pos) ? 'grab' : this.slideTarget(pos) ? 'crosshair' : 'default';
        return;
      }
      const hit = this.hit(pos);
      this.grid.style.cursor = hit && this.mode === 'lyrics' ? 'text' : hit && this.onEdge(hit, pos) ? 'ew-resize' : hit ? 'grab' : 'crosshair';
      return;
    }
    const fine = e.altKey || d.alt;
    const lead = d.start.find((n) => n.id === d.id);
    if (d.mode === 'move') {
      // The note you hold snaps to the grid (or 1/24 step with Alt); the rest keep their offsets.
      const dx = pos.x - d.origin.x;
      let ds = (fine ? tick(lead.s + dx) : Math.round(lead.s + dx)) - lead.s;
      ds = Math.max(ds, -Math.min(...d.start.map((n) => n.s)));
      const dp = clamp(pos.pitch - d.origin.pitch, MIN_PITCH - Math.min(...d.start.map((n) => n.p)), MAX_PITCH - Math.max(...d.start.map((n) => n.p)));
      const key = `${ds}|${dp}`;
      if (key === d.last) return;
      if (dp !== +d.last.split('|')[1]) this.actions.preview(lead.p + dp, lead);
      d.last = key;
      d.moved = true;
      this.actions.updateNotes(d.start.map((n) => ({ id: n.id, s: n.s + ds, p: n.p + dp })));
    } else {
      // Resize: the end follows the pointer, to the next grid line (or freely with Alt).
      const end = fine ? tick(pos.x) : Math.ceil(pos.x - 1e-6);
      const min = fine ? 1 / TICKS : Math.min(1, lead.l);
      const dl = Math.max(min, end - lead.s) - lead.l;
      const key = `${dl}`;
      if (key === d.last) return;
      d.last = key;
      d.moved = true;
      this.actions.updateNotes(d.start.map((n) => ({ id: n.id, l: Math.max(1 / TICKS, n.l + dl) })));
    }
  }

  up(e) {
    if (this.marquee) {
      const m = this.marquee;
      this.marquee = null;
      const r = box({ x: m.a.x, y: m.a.pitch }, { x: m.b.x, y: m.b.pitch });
      if (!m.add) this.sel.clear();
      for (const n of this.notes()) if (n.s < r.x1 && n.s + n.l > r.x0 && n.p >= r.y0 && n.p <= r.y1) this.sel.add(n.id);
      this.dirty = true;
      return;
    }
    if (this.slideDrag) return this.slideUp(e);
    const d = this.drag;
    this.drag = null;
    if (d?.mode === 'move' && !d.moved) {
      if (d.alt) this.openEditor(d.id); // Alt+click: type its lyric
      else {
        this.actions.removeNotes([d.id]); // a plain click deletes
        this.sel.delete(d.id);
      }
    }
    if (d?.mode === 'resize' && d.start.length === 1) {
      const note = this.pattern.notes.find((n) => n.id === d.id);
      if (note) this.lastLen = note.l;
    }
    this.dirty = true;
  }

  context(e) {
    const pos = this.at(e);
    if (this.mode === 'slide') return this.slideContext(pos);
    const hit = this.hit(pos);
    if (hit) {
      this.actions.beginGesture();
      this.actions.removeNotes([hit.id]);
      this.sel.delete(hit.id);
    }
  }

  /** Keyboard shortcuts while the roll is in use. Returns true if handled. */
  key(e) {
    const del = e.key === 'Delete' || e.key === 'Backspace';
    if (e.key === 'Escape') {
      if (!this.sel.size && !this.marquee) return false;
      this.sel.clear();
      this.marquee = null;
      this.dirty = true;
      return true;
    }
    if (shortcut(e, 'a')) {
      for (const n of this.notes()) this.sel.add(n.id);
      this.dirty = true;
      return true;
    }
    if (shortcut(e, 'v')) {
      const items = clipboard.get('notes');
      if (!items?.length) return true;
      this.actions.beginGesture();
      this.sel = new Set(this.actions.addNotes(items));
      this.dirty = true;
      return true;
    }
    const group = this.selected();
    if (!group.length) return del || shortcut(e, 'c') || shortcut(e, 'x') || shortcut(e, 'b');
    const copy = () => clipboard.set('notes', group.map(({ id, ch, ...n }) => n));
    if (shortcut(e, 'c')) copy();
    else if (shortcut(e, 'x') || del) {
      if (!del) copy();
      this.actions.beginGesture();
      this.actions.removeNotes(group.map((n) => n.id));
      this.sel.clear();
    } else if (shortcut(e, 'b')) {
      // Duplicate right after the selection (rounded up to a beat).
      const start = Math.min(...group.map((n) => n.s));
      const span = Math.max(...group.map((n) => n.s + n.l)) - start;
      const shift = Math.max(4, Math.ceil(span / 4 - 1e-9) * 4);
      this.actions.beginGesture();
      this.sel = new Set(this.actions.addNotes(group.map(({ id, ch, ...n }) => ({ ...n, s: n.s + shift }))));
    } else return false;
    this.dirty = true;
    return true;
  }

  // ---------------------------------------------------------------- slides

  /** Where a slide value sits on screen: x along the note, v in semitones. */
  slideXY(n, x, v) {
    return { px: (n.s + x * n.l) * this.cellW, py: (MAX_PITCH - n.p - v + 0.5) * ROW_H };
  }

  /** Semitones above the note at the pointer (whole ones, or 0.1 with Alt). */
  semisAt(n, pos, fine) {
    const v = MAX_PITCH + 0.5 - pos.py / ROW_H - n.p;
    return clamp(fine ? Math.round(v * 10) / 10 : Math.round(v), -SLIDE_RANGE, SLIDE_RANGE);
  }

  slideHandle(pos) {
    for (const n of this.notes()) {
      if (!n.pb) continue;
      for (let i = 0; i < n.pb.length; i++) {
        const { px, py } = this.slideXY(n, n.pb[i][0], n.pb[i][1]);
        if (Math.hypot(px - pos.px, py - pos.py) < 7) return { note: n, i };
      }
    }
    return null;
  }

  /** The note whose pitch line passes nearest the pointer, among those under it. */
  slideTarget(pos) {
    let best = null;
    let dist = Infinity;
    for (const n of this.notes()) {
      if (pos.x < n.s || pos.x > n.s + n.l) continue;
      const v = slideAt(n.pb, (pos.x - n.s) / n.l);
      const d = Math.abs(MAX_PITCH + 0.5 - pos.py / ROW_H - (n.p + v));
      if (d < dist && d < SLIDE_RANGE + 1) {
        best = n;
        dist = d;
      }
    }
    return best;
  }

  slideDown(e, pos) {
    const h = this.slideHandle(pos);
    if (h) {
      this.slideDrag = { kind: 'point', note: h.note, i: h.i, pts: h.note.pb.map((p) => [...p]), alt: e.altKey };
      return;
    }
    const n = this.slideTarget(pos);
    if (!n) return;
    const x = clamp((pos.x - n.s) / n.l, 0, 1);
    this.slideDrag = { kind: 'draw', note: n, base: (n.pb ?? []).map((p) => [...p]), stroke: new Map([[Math.round(x * 400), [x, this.semisAt(n, pos, e.altKey)]]]), line: e.shiftKey, alt: e.altKey };
    this.applyStroke();
  }

  slideMove(e, pos) {
    const d = this.slideDrag;
    const n = d.note;
    const fine = e.altKey || d.alt;
    if (d.kind === 'point') {
      const lo = d.i > 0 ? d.pts[d.i - 1][0] : 0;
      const hi = d.i < d.pts.length - 1 ? d.pts[d.i + 1][0] : 1;
      d.pts[d.i] = [clamp((pos.x - n.s) / n.l, lo, hi), this.semisAt(n, pos, fine)];
      this.actions.updateNotes([{ id: n.id, pb: d.pts }]);
      return;
    }
    const x = clamp((pos.x - n.s) / n.l, 0, 1);
    const pt = [x, this.semisAt(n, pos, fine)];
    if (d.line) {
      // Shift: a straight line from where you pressed.
      const first = [...d.stroke.values()][0];
      d.stroke = new Map([[Math.round(first[0] * 400), first], [Math.round(x * 400), pt]]);
    } else d.stroke.set(Math.round(x * 400), pt); // drawing back over a spot redraws it
    this.applyStroke();
  }

  /** Merge the stroke into the note's slide: it replaces what was there across its span. */
  applyStroke(final = false) {
    const d = this.slideDrag;
    const stroke = [...d.stroke.values()].sort((a, b) => a[0] - b[0]);
    const lo = stroke[0][0];
    const hi = stroke.at(-1)[0];
    const keep = d.base.filter(([x]) => x < lo - 1e-6 || x > hi + 1e-6);
    // A slide starts from the note's own pitch unless drawn from its very start.
    if (!d.base.length && lo > 0) keep.push([0, 0]);
    const drawn = simplify(stroke, final ? 0.15 : 0.05);
    const pb = [...keep, ...drawn].sort((a, b) => a[0] - b[0]);
    this.actions.updateNotes([{ id: d.note.id, pb }]);
  }

  slideUp() {
    const d = this.slideDrag;
    if (d.kind === 'draw') this.applyStroke(true);
    this.slideDrag = null;
    const n = this.pattern.notes.find((x) => x.id === d.note.id);
    if (n) this.actions.preview(n.p, n);
    this.dirty = true;
  }

  /** Right-click in slide mode: remove a point, or (on a note) its whole slide. */
  slideContext(pos) {
    this.actions.beginGesture();
    const h = this.slideHandle(pos);
    if (h) {
      const pts = h.note.pb.filter((_, i) => i !== h.i);
      this.actions.updateNotes([{ id: h.note.id, pb: pts.length > 1 ? pts : null }]);
      return;
    }
    const n = this.slideTarget(pos);
    if (n?.pb) this.actions.updateNotes([{ id: n.id, pb: null }]);
  }

  // ---------------------------------------------------------------- lyrics

  /** A text box over a note for typing its lyric. */
  openEditor(id) {
    this.closeEditor(true);
    const n = this.pattern.notes.find((x) => x.id === id);
    if (!n) return;
    const input = document.createElement('input');
    input.className = 'lyric-edit';
    input.value = n.ly ?? '';
    input.placeholder = 'lyric';
    input.spellcheck = false;
    input.maxLength = 120;
    input.title = 'Enter: save · Tab / Shift+Tab: next / previous note · Esc: cancel. Several words or hyphenated syllables fill the following notes.';
    Object.assign(input.style, {
      left: `${KEYS_W + n.s * this.cellW}px`,
      top: `${(MAX_PITCH - n.p) * ROW_H - 3}px`,
      width: `${Math.max(70, n.l * this.cellW)}px`,
    });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // keep Space/Esc/Ctrl+Z for the text box
      if (e.key === 'Enter') {
        e.preventDefault();
        this.closeEditor(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.closeEditor(false);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        const last = this.commit();
        const list = this.ordered();
        const at = list.findIndex((x) => x.id === (e.shiftKey ? id : last));
        const next = list[at + (e.shiftKey ? -1 : 1)];
        this.closeEditor(false);
        if (next) this.openEditor(next.id);
      }
    });
    input.addEventListener('blur', () => this.editor?.input === input && this.closeEditor(true));
    this.grid.parentElement.append(input);
    this.editor = { input, id };
    input.focus();
    input.select();
  }

  /** Save the editor's text; returns the id of the last note it filled. */
  commit() {
    const ed = this.editor;
    if (!ed) return null;
    const text = ed.input.value.trim();
    const parts = text.split(/\s+/).flatMap((w) => (w === '-' ? [w] : w.split('-').filter(Boolean)));
    if (parts.length <= 1) {
      this.actions.setLyric(ed.id, text);
      return ed.id;
    }
    // Several syllables: this note and the ones after it.
    const list = this.ordered();
    const from = list.findIndex((x) => x.id === ed.id);
    const notes = list.slice(from, from + parts.length);
    notes.forEach((n, i) => this.actions.setLyric(n.id, parts[i]));
    return notes.at(-1)?.id ?? ed.id;
  }

  closeEditor(save) {
    const ed = this.editor;
    if (!ed) return;
    if (save) this.commit();
    this.editor = null;
    ed.input.remove();
    this.dirty = true;
  }

  // ---------------------------------------------------------------- drawing

  setPlayStep(step) {
    if (step !== this.playStep) {
      this.playStep = step;
      this.dirty = true;
    }
  }

  draw() {
    if (!this.dirty || !this.pattern || !this.channel || this.root.closest('[hidden]')) return;
    this.dirty = false;
    const cw = this.cellW;
    const W = cw * this.shown;
    const H = ROWS * ROW_H;
    const dpr = window.devicePixelRatio || 1;
    const fit = (c, w, h) => {
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
        c.style.width = `${w}px`;
        c.style.height = `${h}px`;
      }
      const g = c.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      return g;
    };

    // Keyboard: white keys full width, black keys shorter on top.
    const k = fit(this.keys, KEYS_W, H);
    k.fillStyle = '#d9dce6';
    k.fillRect(0, 0, KEYS_W, H);
    for (let i = 0; i < ROWS; i++) {
      const p = MAX_PITCH - i;
      if (isBlack(p)) {
        k.fillStyle = '#1b1e26';
        k.fillRect(0, i * ROW_H + 1, KEYS_W * 0.6, ROW_H - 2);
      } else if (p % 12 === 0 || p % 12 === 5) {
        k.fillStyle = '#a9aebb'; // seam between B|C and E|F
        k.fillRect(0, (i + 1) * ROW_H - 1, KEYS_W, 1);
      }
      if (p % 12 === 0) {
        k.fillStyle = '#5b6070';
        k.font = '600 10px Inter, system-ui, sans-serif';
        k.fillText(noteName(p), KEYS_W - 24, i * ROW_H + 12);
      }
    }
    if (this.pendingScroll) {
      this.pendingScroll = false;
      this.scrollToNotes();
    }

    // Grid
    const g = fit(this.grid, W, H);
    g.fillStyle = '#171a21';
    g.fillRect(0, 0, W, H);
    for (let i = 0; i < ROWS; i++) {
      const p = MAX_PITCH - i;
      if (isBlack(p)) {
        g.fillStyle = '#13161c';
        g.fillRect(0, i * ROW_H, W, ROW_H);
      }
      if (p % 12 === 0) {
        g.fillStyle = '#262a34';
        g.fillRect(0, (i + 1) * ROW_H - 1, W, 1);
      }
    }
    for (let s = 0; s <= this.shown; s++) {
      g.fillStyle = s % 16 === 0 ? '#3a4050' : s % 4 === 0 ? '#2a2f3b' : '#1f232c';
      g.fillRect(s * cw, 0, 1, H);
    }
    // The bar after the pattern: writing there makes the pattern longer.
    const end = this.length * cw;
    if (this.shown > this.length) {
      g.fillStyle = 'rgba(8, 9, 12, 0.45)';
      g.fillRect(end, 0, W - end, H);
      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.fillRect(end, 0, 2, H);
      g.font = '600 11px Inter, system-ui, sans-serif';
      g.fillStyle = 'rgba(255,255,255,0.28)';
      const label = '+1 bar: write here to extend';
      const y = (this.root.scrollTop || 0) + 18;
      g.fillText(label, end + 8, y);
    }

    // Ghost notes from other synth channels
    const color = this.project.channels.find((c) => c.id === this.channel)?.color ?? '#fff';
    for (const n of this.pattern.notes) {
      if (n.ch === this.channel) continue;
      if (!this.project.channels.some((c) => c.id === n.ch)) continue;
      g.fillStyle = 'rgba(255,255,255,0.08)';
      g.fillRect(n.s * cw + 1, (MAX_PITCH - n.p) * ROW_H + 2, n.l * cw - 2, ROW_H - 4);
    }

    // This channel's notes
    const sliding = this.mode === 'slide';
    for (const n of this.notes()) {
      const x = n.s * cw + 1;
      const y = (MAX_PITCH - n.p) * ROW_H + 1;
      const w = Math.max(3, n.l * cw - 2);
      const selected = this.sel.has(n.id);
      g.fillStyle = color;
      g.globalAlpha = sliding ? 0.45 : this.drag?.id === n.id || selected ? 1 : 0.88;
      roundRect(g, x, y, w, ROW_H - 2, 3);
      g.fill();
      g.globalAlpha = 1;
      if (selected) {
        g.strokeStyle = '#fff';
        g.lineWidth = 2;
        roundRect(g, x, y, w, ROW_H - 2, 3);
        g.stroke();
      }
      g.fillStyle = 'rgba(0,0,0,0.35)';
      if (w > 8) g.fillRect(x + w - 4, y + 3, 2, ROW_H - 8); // resize grip
      if (n.ly) {
        g.save();
        g.beginPath();
        g.rect(x + 2, y, w - 6, ROW_H - 2);
        g.clip();
        g.fillStyle = n.ly === '-' ? 'rgba(0,0,0,0.45)' : 'rgba(0,0,0,0.85)';
        g.font = '700 10px Inter, system-ui, sans-serif';
        g.fillText(n.ly === '-' ? '–' : n.ly, x + 4, y + 11);
        g.restore();
      } else if (w > 34) {
        g.fillStyle = 'rgba(0,0,0,0.7)';
        g.font = '600 9px Inter, system-ui, sans-serif';
        g.fillText(noteName(n.p), x + 4, y + 11);
      }
    }

    // Slides: each note's pitch over its length, drawn on the keyboard's scale.
    for (const n of this.notes()) {
      if (!n.pb && !(sliding && this.hover && this.slideTarget(this.hover) === n)) continue;
      const steps = Math.max(8, Math.ceil((n.l * cw) / 3));
      g.beginPath();
      for (let i = 0; i <= steps; i++) {
        const { px, py } = this.slideXY(n, i / steps, slideAt(n.pb, i / steps));
        if (i) g.lineTo(px, py);
        else g.moveTo(px, py);
      }
      g.strokeStyle = sliding ? '#ffffff' : color;
      g.globalAlpha = sliding ? 0.95 : 0.8;
      g.lineWidth = sliding ? 2 : 1.5;
      g.stroke();
      g.globalAlpha = 1;
      if (sliding && n.pb) {
        g.fillStyle = '#fff';
        for (const [x, v] of n.pb) {
          const { px, py } = this.slideXY(n, x, v);
          g.beginPath();
          g.arc(px, py, 3.5, 0, Math.PI * 2);
          g.fill();
        }
      }
    }

    // Selection box
    if (this.marquee) {
      const m = this.marquee;
      const r = box({ x: m.a.px, y: m.a.py }, { x: m.b.px, y: m.b.py });
      g.fillStyle = 'rgba(255,255,255,0.08)';
      g.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
      g.strokeStyle = 'rgba(255,255,255,0.7)';
      g.lineWidth = 1;
      g.strokeRect(r.x0 + 0.5, r.y0 + 0.5, r.x1 - r.x0, r.y1 - r.y0);
    }

    // Playhead
    if (this.playStep >= 0) {
      g.fillStyle = 'rgba(255,255,255,0.08)';
      g.fillRect(this.playStep * cw, 0, cw, H);
      g.fillStyle = '#fff';
      g.fillRect(this.playStep * cw, 0, 1, H);
    }

    // Hover row highlight
    if (this.hover && !this.drag && !sliding) {
      g.fillStyle = 'rgba(255,255,255,0.05)';
      g.fillRect(0, (MAX_PITCH - this.hover.pitch) * ROW_H, W, ROW_H);
    }

    // Other people's cursors
    for (const s of this.remote) {
      if (!s.cursor || s.channel !== this.channel || s.pattern !== this.pattern.id) continue;
      const x = s.cursor.x * cw;
      const y = (MAX_PITCH - s.cursor.y + 0.5) * ROW_H;
      g.fillStyle = s.user.color;
      g.beginPath();
      g.moveTo(x, y - 8);
      g.lineTo(x + 11, y + 3);
      g.lineTo(x + 4, y + 3);
      g.lineTo(x, y + 9);
      g.closePath();
      g.fill();
      g.font = '600 11px Inter, system-ui, sans-serif';
      const label = shortName(s.user.name);
      const tw = g.measureText(label).width;
      roundRect(g, x + 10, y + 5, tw + 10, 16, 4);
      g.fill();
      g.fillStyle = '#111';
      g.fillText(label, x + 15, y + 17);
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
