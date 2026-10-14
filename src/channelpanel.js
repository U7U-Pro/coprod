// The "FX" panel for one channel: its sound source (built-in synth, uploaded
// sample, or a plugin's own GUI) and its chain of plugin effects.
//
// Plugin GUIs are mounted once and kept alive across re-renders. When you
// turn a knob in a plugin GUI we read the plugin's state and share it, so
// everyone's copy of the plugin sounds the same.

import { INSTRUMENTS } from './shared/schema.js';
import { CATALOG, pluginOrigin } from './plugins.js';

const el = (tag, props = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  e.append(...children.filter((c) => c !== null && c !== undefined));
  return e;
};

export class ChannelPanel {
  constructor(root, engine, actions) {
    this.root = root;
    this.engine = engine;
    this.actions = actions;
    this.channelId = null;
    this.guis = new Map(); // slot key -> { box, gui, instance }
    this.body = root.querySelector('.cp-body');
    this.title = root.querySelector('.cp-title');
    this.swatch = root.querySelector('.swatch');
    root.querySelector('.cp-close').onclick = () => this.close();

    // Any interaction inside a plugin GUI may have changed its settings.
    const touched = (e) => {
      const key = e.target.closest?.('[data-slot]')?.dataset.slot;
      if (key) this.scheduleCapture(key);
    };
    for (const type of ['input', 'change', 'pointerup', 'keyup', 'wheel']) root.addEventListener(type, touched, true);
    // A plugin GUI can hand us notes for this channel (e.g. Slicer's "To piano roll").
    root.addEventListener('coprod:notes', (e) => {
      if (!this.channelId || !Array.isArray(e.detail?.notes)) return;
      e.preventDefault();
      this.actions.setNotes(this.channelId, e.detail.notes);
    });
    // ...or lyrics, one syllable per note (Vocalist's "Put lyrics on notes").
    root.addEventListener('coprod:lyrics', (e) => {
      if (!this.channelId || !Array.isArray(e.detail?.syllables)) return;
      e.preventDefault();
      e.detail.result = this.actions.setLyrics(this.channelId, e.detail.syllables, { fill: e.detail.fill });
    });
    this.pending = new Map();
    // Some GUIs change state without DOM events (canvas knobs, pointer capture).
    // Not while playing: then automation is moving knobs, and those values
    // are temporary, not edits to share.
    setInterval(() => {
      if (!this.channelId || this.engine.playing) return;
      for (const key of this.guis.keys()) this.capture(key);
    }, 1000);
  }

  open(channelId) {
    if (this.channelId !== channelId) this.unmountAll();
    this.sig = null;
    this.channelId = channelId;
    this.root.hidden = false;
  }

  close() {
    this.unmountAll();
    this.channelId = null;
    this.root.hidden = true;
    this.actions.onClose?.();
  }

  scheduleCapture(key) {
    if (this.pending.has(key)) return;
    this.pending.set(
      key,
      setTimeout(() => {
        this.pending.delete(key);
        this.capture(key);
      }, 90),
    );
  }

  async capture(key) {
    const state = await this.engine.captureState(key);
    if (state) this.actions.saveState(key, state);
  }

  unmountAll() {
    for (const [key, g] of this.guis) this.unmount(key, g);
  }

  unmount(key, g = this.guis.get(key)) {
    if (!g) return;
    try {
      if (g.gui) g.instance?.destroyGui?.(g.gui);
    } catch {}
    g.box.remove();
    this.guis.delete(key);
  }

  /** The GUI element for a ready slot, created once. */
  guiFor(key) {
    const slot = this.engine.slots.get(key);
    let g = this.guis.get(key);
    if (g && g.instance !== slot?.instance) {
      this.unmount(key, g);
      g = null;
    }
    if (!g && slot?.status === 'ready') {
      g = { box: el('div', { class: 'plugin-gui', dataset: { slot: key } }), instance: slot.instance };
      this.guis.set(key, g);
      slot.instance
        .createGui?.()
        .then((gui) => {
          g.gui = gui;
          if (this.guis.get(key) === g) g.box.append(gui);
        })
        .catch((err) => g.box.append(el('p', { class: 'hint' }, `This plugin's interface failed to load: ${err.message}`)));
    }
    return g?.box ?? null;
  }

  render(project) {
    if (!this.channelId) return;
    const c = project.channels.find((x) => x.id === this.channelId);
    if (!c) return this.close();
    this.title.textContent = `${c.name} · sound & effects`;
    this.swatch.style.background = c.color;

    // Only rebuild when the structure changes. Plugin settings changes (which
    // stream in while someone turns a knob) must not move the GUI elements,
    // or a knob being dragged would be dropped mid-gesture.
    const slotKeys = [...(c.inst === 'wam' ? [c.id] : []), ...c.fx.map((f) => `${c.id}/${f.id}`)];
    const sig = JSON.stringify([
      c.id,
      c.inst,
      c.color,
      c.plugin,
      c.sample,
      c.sample && this.engine.sampleStatus(c.sample.id).status,
      c.fx.map((f) => [f.id, f.on, f.name, f.url]),
      slotKeys.map((k) => this.engine.slotStatus(k).status),
    ]);
    if (sig === this.sig) return;
    this.sig = sig;

    const live = new Set();
    const source = this.renderSource(c, live);
    const fx = this.renderEffects(c, live);
    for (const key of [...this.guis.keys()]) if (!live.has(key)) this.unmount(key);
    // Keep mounted GUI elements in place: only swap the light-weight wrappers.
    this.body.replaceChildren(source, fx);
  }

  status(key, url) {
    const st = this.engine.slotStatus(key);
    const origin = pluginOrigin(url);
    if (st.status === 'blocked') {
      return el(
        'div',
        { class: 'notice warn' },
        el('p', {}, el('b', {}, 'Plugin from another site. '), `It's from `, el('code', {}, origin), `. Plugins run their own code in your browser, so only allow sites you trust.`),
        el('button', { class: 'ghost', onclick: () => this.actions.allowOrigin(origin) }, `Allow plugins from ${new URL(origin).host}`),
      );
    }
    if (st.status === 'error') return el('div', { class: 'notice bad' }, `Couldn't load this plugin: ${st.error ?? 'unknown error'}`);
    if (st.status === 'loading') return el('p', { class: 'hint' }, 'Loading plugin…');
    if (st.status === 'idle') return el('p', { class: 'hint' }, 'Press play or click a key to start audio, then the plugin loads.');
    return null;
  }

  renderSource(c, live) {
    const box = el('section', { class: 'cp-section' }, el('h3', {}, 'Sound'));
    if (c.inst === 'wam') {
      const key = c.id;
      live.add(key);
      const origin = pluginOrigin(c.plugin.url);
      box.append(
        el('p', { class: 'hint' }, `Plugin instrument `, el('b', {}, c.plugin.name), origin === location.origin ? ' (built into coprod)' : ` from ${origin}`),
        this.status(key, c.plugin.url) ?? this.guiFor(key) ?? el('span'),
      );
    } else if (c.sample && INSTRUMENTS[c.inst].needs === 'sample') {
      const st = this.engine.sampleStatus(c.sample.id);
      const wave = el('canvas', { class: 'wave' });
      box.append(
        el(
          'div',
          { class: 'sample-line' },
          el('span', {}, '🎵 ', el('b', {}, c.sample.name)),
          el('span', { class: 'hint' }, st.status === 'ready' ? `${st.buffer.duration.toFixed(2)} s` : st.status === 'error' ? st.error : 'loading…'),
          el('button', { class: 'ghost', onclick: () => this.actions.pickSample(c.id) }, 'Replace…'),
        ),
        wave,
        el('p', { class: 'hint' }, c.inst === 'samplekeys' ? 'Plays pitched from the piano roll (C4 = original pitch).' : 'Plays as a one-shot on the step grid. Switch to "Sample (keys)" in the row to play it pitched.'),
      );
      if (st.status === 'ready') requestAnimationFrame(() => drawWave(wave, st.buffer, c.color));
    } else {
      box.append(
        el('p', { class: 'hint' }, `Built-in ${INSTRUMENTS[c.inst].label.toLowerCase()} synth. Drop an audio file on this channel, or load one, to turn it into a sampler.`),
        el('button', { class: 'ghost', onclick: () => this.actions.pickSample(c.id) }, 'Load sample…'),
      );
    }
    return box;
  }

  renderEffects(c, live) {
    const box = el('section', { class: 'cp-section' }, el('h3', {}, 'Effects ', el('span', { class: 'hint' }, 'run top to bottom')));
    if (!c.fx.length) box.append(el('p', { class: 'hint' }, 'No effects yet.'));
    for (const f of c.fx) {
      const key = `${c.id}/${f.id}`;
      live.add(key);
      const origin = pluginOrigin(f.url);
      box.append(
        el(
          'div',
          { class: `fx ${f.on ? '' : 'off'}` },
          el(
            'div',
            { class: 'fx-head' },
            el('label', { class: 'switch', title: f.on ? 'Bypass' : 'Enable' }, el('input', { type: 'checkbox', checked: f.on, onchange: (e) => this.actions.setEffect(c.id, f.id, { on: e.target.checked }) }), el('span')),
            el('b', {}, f.name),
            origin !== location.origin ? el('span', { class: 'hint' }, new URL(origin).host) : null,
            el('button', { class: 'mini del', title: 'Remove effect', onclick: () => this.actions.removeEffect(c.id, f.id) }, '✕'),
          ),
          this.status(key, f.url) ?? this.guiFor(key),
        ),
      );
    }
    const add = el('select', { class: 'fx-add', 'aria-label': 'Add an effect' }, el('option', { value: '' }, '+ Add effect…'));
    for (const p of CATALOG.filter((x) => x.type === 'effect')) add.append(el('option', { value: p.url }, `${p.name}: ${p.about}`));
    add.append(el('option', { value: '__browse' }, 'Browse all effects…'));
    add.onchange = () => {
      const v = add.value;
      add.value = '';
      if (v === '__browse') this.actions.browseEffects(c.id);
      else if (v) this.actions.addEffect(c.id, CATALOG.find((p) => p.url === v));
    };
    box.append(add);
    return box;
  }
}

function drawWave(canvas, buffer, color) {
  const w = canvas.clientWidth || 600;
  const h = canvas.clientHeight || 56;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  const data = buffer.getChannelData(0);
  const per = Math.max(1, Math.floor(data.length / w));
  g.fillStyle = color;
  for (let x = 0; x < w; x++) {
    let peak = 0;
    for (let i = x * per; i < (x + 1) * per && i < data.length; i += 4) peak = Math.max(peak, Math.abs(data[i]));
    const bar = Math.max(1, peak * (h - 4));
    g.fillRect(x, (h - bar) / 2, 1, bar);
  }
}
