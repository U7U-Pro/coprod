// Piano roll for one synth channel, drawn on canvas. Shows other synth
// channels as faint "ghost" notes for harmony, and other people's cursors
// when they are in the same roll. Notes can carry lyrics (for singing
// plugins): they're drawn on the notes, and in lyrics mode (or with Alt)
// clicking a note opens a text box for its syllable.

import { MIN_PITCH, MAX_PITCH, STEPS_PER_BAR } from './shared/schema.js';

const ROW_H = 16;
const KEYS_W = 56;
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const isBlack = (p) => [1, 3, 6, 8, 10].includes(p % 12);
const noteName = (p) => `${NAMES[p % 12]}${Math.floor(p / 12) - 1}`;
const ROWS = MAX_PITCH - MIN_PITCH + 1;

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
    this.project = null;
    this.remote = [];
    this.drag = null;
    this.lastLen = 2;
    this.hover = null;
    this.playStep = -1;
    this.dirty = true;
    this.lyricMode = false;
    this.editor = null; // { input, id }

    this.grid.addEventListener('pointerdown', (e) => this.down(e));
    this.grid.addEventListener('pointermove', (e) => this.move(e));
    this.grid.addEventListener('pointerup', (e) => this.up(e));
    this.grid.addEventListener('pointercancel', () => (this.drag = null));
    this.grid.addEventListener('pointerleave', () => {
      this.hover = null;
      this.actions.cursor(null);
      this.dirty = true;
    });
    this.grid.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const hit = this.hit(this.at(e));
      if (hit) this.actions.removeNote(hit.id);
    });
    this.keys.addEventListener('pointerdown', (e) => {
      const p = this.at(e).pitch;
      this.actions.preview(p);
    });
    new ResizeObserver(() => {
      this.dirty = true;
    }).observe(root);
  }

  get length() {
    return this.pattern.bars * STEPS_PER_BAR;
  }

  get cellW() {
    const avail = this.root.clientWidth - KEYS_W - 2;
    return Math.max(22, Math.floor(avail / this.length));
  }

  open(channelId) {
    const first = this.channel !== channelId;
    if (first) this.closeEditor(false);
    this.channel = channelId;
    this.dirty = true;
    if (first) this.pendingScroll = true; // after the next draw gives the canvas its height
  }

  set(project, pattern, remote) {
    this.project = project;
    this.pattern = pattern;
    this.remote = remote;
    this.dirty = true;
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
    return { x: x / this.cellW, pitch: MAX_PITCH - Math.floor(y / ROW_H), px: x };
  }

  /** This channel's notes in singing order: by time, highest first in a chord. */
  ordered() {
    return this.pattern.notes.filter((n) => n.ch === this.channel).sort((a, b) => a.s - b.s || b.p - a.p);
  }

  hit({ x, pitch }) {
    return this.pattern.notes.find((n) => n.ch === this.channel && n.p === pitch && x >= n.s && x < n.s + n.l);
  }

  down(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    this.grid.setPointerCapture(e.pointerId);
    this.actions.beginGesture();
    const pos = this.at(e);
    const hit = this.hit(pos);
    if (hit && (this.lyricMode || e.altKey)) {
      this.openEditor(hit.id);
      return;
    }
    this.closeEditor(true);
    if (hit) {
      const edge = (hit.s + hit.l) * this.cellW - pos.px < Math.min(10, this.cellW / 3);
      this.drag = edge
        ? { mode: 'resize', id: hit.id, s: hit.s, moved: false }
        : { mode: 'move', id: hit.id, offset: pos.x - hit.s, s: hit.s, p: hit.p, moved: false };
      if (!edge) this.actions.preview(hit.p, hit);
    } else {
      const s = Math.floor(pos.x);
      const id = this.actions.addNote({ p: pos.pitch, s, l: Math.min(this.lastLen, this.length - s) });
      this.drag = { mode: 'resize', id, s, moved: false, created: true };
      this.actions.preview(pos.pitch);
    }
    this.dirty = true;
  }

  move(e) {
    const pos = this.at(e);
    this.hover = pos;
    this.actions.cursor({ x: pos.x, y: pos.pitch });
    this.dirty = true;
    const d = this.drag;
    if (!d) {
      const hit = this.hit(pos);
      const edge = hit && (hit.s + hit.l) * this.cellW - pos.px < Math.min(10, this.cellW / 3);
      this.grid.style.cursor = edge ? 'ew-resize' : hit ? 'grab' : 'crosshair';
      return;
    }
    if (d.mode === 'move') {
      const s = Math.max(0, Math.round(pos.x - d.offset));
      const p = Math.max(MIN_PITCH, Math.min(MAX_PITCH, pos.pitch));
      if (s !== d.s || p !== d.p) {
        if (p !== d.p) this.actions.preview(p, this.pattern.notes.find((n) => n.id === d.id));
        this.actions.updateNote(d.id, { s, p });
        d.s = s;
        d.p = p;
        d.moved = true;
      }
    } else {
      const l = Math.max(1, Math.ceil(pos.x) - d.s);
      const note = this.pattern.notes.find((n) => n.id === d.id);
      if (note && l !== note.l) {
        this.actions.updateNote(d.id, { l });
        this.lastLen = l;
        d.moved = true;
      }
    }
  }

  up() {
    const d = this.drag;
    this.drag = null;
    // A plain click on an existing note (no drag) deletes it.
    if (d && d.mode === 'move' && !d.moved) this.actions.removeNote(d.id);
    if (d && d.mode === 'resize' && !d.created) {
      const note = this.pattern.notes.find((n) => n.id === d.id);
      if (note) this.lastLen = note.l;
    }
    this.dirty = true;
  }

  // ---------------------------------------------------------------- lyrics

  setLyricMode(on) {
    this.lyricMode = on;
    if (!on) this.closeEditor(true);
    this.dirty = true;
  }

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
    const W = cw * this.length;
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
    for (let s = 0; s <= this.length; s++) {
      g.fillStyle = s % 16 === 0 ? '#3a4050' : s % 4 === 0 ? '#2a2f3b' : '#1f232c';
      g.fillRect(s * cw, 0, 1, H);
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
    for (const n of this.pattern.notes) {
      if (n.ch !== this.channel) continue;
      const x = n.s * cw + 1;
      const y = (MAX_PITCH - n.p) * ROW_H + 1;
      const w = n.l * cw - 2;
      g.fillStyle = color;
      g.globalAlpha = this.drag?.id === n.id ? 1 : 0.88;
      roundRect(g, x, y, w, ROW_H - 2, 3);
      g.fill();
      g.globalAlpha = 1;
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(x + w - 4, y + 3, 2, ROW_H - 8); // resize grip
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

    // Playhead
    if (this.playStep >= 0) {
      g.fillStyle = 'rgba(255,255,255,0.08)';
      g.fillRect(this.playStep * cw, 0, cw, H);
      g.fillStyle = '#fff';
      g.fillRect(this.playStep * cw, 0, 1, H);
    }

    // Hover row highlight
    if (this.hover && !this.drag) {
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
      const label = s.user.name;
      const tw = g.measureText(label).width;
      roundRect(g, x + 10, y + 5, tw + 10, 16, 4);
      g.fill();
      g.fillStyle = '#111';
      g.fillText(label, x + 15, y + 17);
    }
  }
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
