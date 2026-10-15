// The channel rack: one row per channel with mixer controls and either a
// step grid (drums) or a mini piano-roll preview (synths).
//
// Rows are keyed by channel id and patched in place on every change, so a
// slider someone is dragging is never replaced under their finger while
// other people's edits stream in.

import { INSTRUMENTS, BUILT_IN, STEPS_PER_BAR, isSynth } from './shared/schema.js';

const el = (tag, props = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  e.append(...children);
  return e;
};

export class Rack {
  /**
   * @param {HTMLElement} root
   * @param {object} actions  callbacks into main.js
   */
  constructor(root, actions) {
    this.root = root;
    this.actions = actions;
    this.rows = new Map(); // channelId -> row elements
    this.paint = null; // { channelId, value } while dragging across steps
    this.nowStep = -1;

    // Drag-painting across steps.
    root.addEventListener('pointerdown', (e) => {
      const cell = e.target.closest('.step');
      if (!cell) return;
      e.preventDefault();
      cell.releasePointerCapture?.(e.pointerId); // let pointerover reach other cells (touch)
      const { channel, step } = cell.dataset;
      this.paint = { channel, value: !cell.classList.contains('on') };
      actions.beginGesture();
      actions.setStep(channel, +step, this.paint.value);
      if (this.paint.value) actions.preview(channel);
    });
    root.addEventListener('pointerover', (e) => {
      const cell = e.target.closest('.step');
      if (!this.paint || !cell || cell.dataset.channel !== this.paint.channel) return;
      if (cell.classList.contains('on') !== this.paint.value) actions.setStep(this.paint.channel, +cell.dataset.step, this.paint.value);
    });
    window.addEventListener('pointerup', () => (this.paint = null));
    window.addEventListener('pointercancel', () => (this.paint = null));
  }

  makeRow(c) {
    const r = {};
    r.mute = el('button', { class: 'mini mute', title: 'Mute for everyone', onclick: () => this.actions.setChannel(c.id, { mute: !r.data.mute }) }, 'M');
    r.solo = el('button', { class: 'mini solo', title: 'Solo (just for you)', onclick: () => this.actions.toggleSolo(c.id) }, 'S');
    r.name = el('input', { class: 'name', maxlength: '32', 'aria-label': 'Channel name' });
    r.name.addEventListener('change', () => this.actions.setChannel(c.id, { name: r.name.value }));
    r.name.addEventListener('focus', () => this.actions.focusChannel(c.id));
    r.inst = el('select', { class: 'inst', 'aria-label': 'Instrument' });
    r.inst.addEventListener('change', () => this.actions.setChannel(c.id, { inst: r.inst.value }));
    r.fx = el('button', { class: 'mini fxbtn', title: 'Sound, plugin and effects', onclick: () => this.actions.openChannel(c.id) }, 'FX');
    r.auto = el('button', { class: 'mini fxbtn autobtn', title: 'Automation in this pattern', onclick: () => this.actions.openAuto(c.id) }, 'A');
    r.status = el('span', { class: 'chip' });
    r.vol = el('input', { type: 'range', min: '0', max: '1', step: '0.01', class: 'vol', title: 'Volume', 'aria-label': 'Volume' });
    r.vol.addEventListener('input', () => this.actions.setChannel(c.id, { vol: +r.vol.value }));
    r.pan = el('input', { type: 'range', min: '-1', max: '1', step: '0.05', class: 'pan', title: 'Pan', 'aria-label': 'Pan' });
    r.pan.addEventListener('input', () => this.actions.setChannel(c.id, { pan: +r.pan.value }));
    r.pan.addEventListener('dblclick', () => this.actions.setChannel(c.id, { pan: 0 }));
    r.del = el('button', { class: 'mini del', title: 'Delete channel', onclick: () => this.actions.removeChannel(c.id) }, '✕');
    r.steps = el('div', { class: 'steps' });
    r.mini = el('canvas', { class: 'miniroll', title: 'Open piano roll' });
    r.mini.addEventListener('click', () => this.actions.openRoll(c.id));
    r.badge = el('div', { class: 'badges' });
    r.row = el(
      'div',
      { class: 'row', dataset: { id: c.id } },
      el('div', { class: 'ctrl' }, el('span', { class: 'color' }), r.mute, r.solo, el('div', { class: 'namebox' }, r.name, r.inst), r.vol, r.pan, r.fx, r.auto),
      el('div', { class: 'lane' }, r.steps, r.mini, r.badge, r.status),
      r.del,
    );
    return r;
  }

  /** `visible`: a Set of channel ids to show (others hidden, just for me), or null for all. */
  render(project, pattern, { solo, selectedChannel, remote, status, visible = null }) {
    const ids = new Set(project.channels.map((c) => c.id));
    for (const [id, r] of this.rows) {
      if (!ids.has(id)) {
        r.row.remove();
        this.rows.delete(id);
      }
    }
    const length = pattern.bars * STEPS_PER_BAR;
    // Synth previews line up with the step grid, however long the pattern is.
    this.root.style.setProperty('--len', length);
    project.channels.forEach((c, i) => {
      let r = this.rows.get(c.id);
      if (!r) {
        r = this.makeRow(c);
        this.rows.set(c.id, r);
      }
      if (this.root.children[i] !== r.row) this.root.insertBefore(r.row, this.root.children[i] ?? null);
      r.row.hidden = !!visible && !visible.has(c.id);
      this.patchRow(r, c, pattern, length, { solo, selectedChannel, remote, status });
    });
    this.nowStep = -1;
  }

  patchRow(r, c, pattern, length, { solo, selectedChannel, remote, status }) {
    r.data = c;
    const synth = isSynth(c.inst);
    r.row.style.setProperty('--ch', c.color);
    r.row.classList.toggle('synth', synth);
    r.row.classList.toggle('muted', c.mute);
    r.row.classList.toggle('selected', selectedChannel === c.id);
    r.mute.classList.toggle('on', c.mute);
    r.solo.classList.toggle('on', solo.has(c.id));
    const set = (input, value) => {
      if (document.activeElement !== input && String(input.value) !== String(value)) input.value = value;
    };
    set(r.name, c.name);

    // Instrument choices: built-ins, plus sample/plugin modes when the
    // channel has a sample or plugin attached.
    const choices = [...BUILT_IN, ...(c.sample ? ['sample', 'samplekeys'] : []), ...(c.plugin ? ['wam'] : [])];
    const key = choices.join() + (c.plugin?.name ?? '');
    if (r.instKey !== key) {
      r.inst.replaceChildren(
        ...choices.map((id) => el('option', { value: id }, id === 'wam' ? `${c.plugin.name} (plugin)` : INSTRUMENTS[id].label)),
      );
      r.instKey = key;
    }
    set(r.inst, c.inst);
    r.fx.textContent = c.fx?.length ? `FX ${c.fx.length}` : 'FX';
    r.fx.classList.toggle('on', !!c.fx?.length);
    const lanes = (pattern.lanes ?? []).filter((l) => l.ch === c.id && l.points.length).length;
    r.auto.textContent = lanes ? `A ${lanes}` : 'A';
    r.auto.classList.toggle('on', lanes > 0);
    const st = status(c);
    r.status.hidden = !st;
    if (st) {
      r.status.textContent = st.text;
      r.status.className = `chip ${st.level}`;
    }
    set(r.vol, c.vol);
    set(r.pan, c.pan);

    // Who else is working on this channel right now.
    const here = remote.filter((s) => s.channel === c.id && s.pattern === pattern.id);
    r.row.classList.toggle('busy', here.length > 0);
    if (here.length) r.row.style.setProperty('--who', here[0].user.color);
    r.badge.replaceChildren(...here.map((s) => el('span', { class: 'who', style: `--c:${s.user.color}` }, s.user.name)));

    if (synth) {
      r.steps.hidden = true;
      r.mini.hidden = false;
      this.drawMini(r.mini, pattern.notes.filter((n) => n.ch === c.id), length, c.color);
      return;
    }
    r.steps.hidden = false;
    r.mini.hidden = true;
    if (r.steps.childElementCount !== length) {
      r.steps.replaceChildren(
        ...Array.from({ length }, (_, i) =>
          el('button', {
            class: `step ${Math.floor(i / 4) % 2 ? 'alt' : ''}`,
            dataset: { channel: c.id, step: i },
            'aria-label': `Step ${i + 1}`,
          }),
        ),
      );
    }
    for (const cell of r.steps.children) {
      cell.classList.toggle('on', pattern.steps.has(`${c.id}:${cell.dataset.step}`));
    }
  }

  drawMini(canvas, notes, length, color) {
    const w = canvas.clientWidth || 400;
    const h = canvas.clientHeight || 32;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
    if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr);
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const cw = w / length;
    g.fillStyle = 'rgba(255,255,255,0.04)';
    for (let i = 0; i < length; i += 8) g.fillRect(i * cw, 0, cw * 4, h);
    if (!notes.length) {
      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.font = '12px Inter, system-ui, sans-serif';
      g.fillText('Empty, click to write notes', 8, h / 2 + 4);
      return;
    }
    // Fit the used pitch range (at least an octave) into the lane.
    const lo = Math.min(...notes.map((n) => n.p));
    const span = Math.max(12, Math.max(...notes.map((n) => n.p)) - lo + 1);
    const rh = Math.max(4, Math.min(7, (h - 6) / span));
    g.fillStyle = color;
    for (const n of notes) {
      const y = h - 3 - ((n.p - lo + 0.5) / span) * (h - 6) - rh / 2;
      g.beginPath();
      g.roundRect(n.s * cw + 1, y, Math.max(3, n.l * cw - 2), rh, 2);
      g.fill();
    }
  }

  /** Light up the column that's playing. */
  setNow(step) {
    if (step === this.nowStep) return;
    for (const c of this.root.querySelectorAll('.step.now')) c.classList.remove('now');
    if (step >= 0) for (const c of this.root.querySelectorAll(`.step[data-step="${step}"]`)) c.classList.add('now');
    this.nowStep = step;
  }
}
