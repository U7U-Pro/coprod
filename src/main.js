import './style.css';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import * as S from './shared/schema.js';
import { Engine } from './audio.js';
import { Rack } from './rack.js';
import { PianoRoll } from './pianoroll.js';
import { ChannelPanel } from './channelpanel.js';
import { AutomationPanel } from './automation.js';
import { CATALOG, trustOrigin, nameFromUrl, pluginOrigin } from './plugins.js';
import { renderProject, download } from './export.js';

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ room

function roomFromUrl() {
  const params = new URLSearchParams(location.search);
  let room = params.get('room');
  if (!room || !/^[A-Za-z0-9_-]{1,64}$/.test(room)) {
    room = `jam-${S.newId()}${S.newId()}`;
    history.replaceState(null, '', `/?room=${room}`);
  }
  return room;
}

const room = roomFromUrl();
const doc = new Y.Doc();
const provider = new WebsocketProvider(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`, room, doc);
const awareness = provider.awareness;
const undo = new Y.UndoManager(S.undoScope(doc), { captureTimeout: 400 });
const engine = new Engine();
engine.onChange = () => render();

const ui = {
  project: null,
  patternId: null, // the pattern I'm looking at / looping
  rollChannel: null, // synth channel open in the piano roll
  focusChannel: null, // last channel I touched (shown to others)
  mode: 'pattern',
};

// ------------------------------------------------------------------ me

const store = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

const me = {
  name: store.get('coprod:name') ?? '',
  color: store.get('coprod:color') ?? S.COLORS[Math.floor(Math.random() * S.COLORS.length)],
};

function publishPresence(extra = {}) {
  awareness.setLocalState({
    ...(awareness.getLocalState() ?? {}),
    user: { name: me.name || 'Guest', color: me.color },
    pattern: ui.patternId,
    channel: ui.focusChannel,
    ...extra,
  });
}

function remoteStates() {
  const out = [];
  for (const [id, s] of awareness.getStates()) if (id !== doc.clientID && s.user) out.push({ id, ...s });
  return out;
}

// ------------------------------------------------------------------ edits

const currentPattern = () => ui.project.patterns.find((p) => p.id === ui.patternId) ?? ui.project.patterns[0];
const channelById = (id) => ui.project.channels.find((c) => c.id === id);

function focusChannel(id) {
  if (ui.focusChannel === id) return;
  ui.focusChannel = id;
  publishPresence();
}

const rack = new Rack($('rack'), {
  beginGesture: () => undo.stopCapturing(),
  setStep: (ch, step, on) => {
    focusChannel(ch);
    S.setStep(doc, currentPattern().id, ch, step, on ? 100 : 0);
  },
  setChannel: (id, patch) => {
    focusChannel(id);
    S.setChannel(doc, id, patch);
  },
  removeChannel: (id) => {
    const c = channelById(id);
    if (c && confirm(`Delete "${c.name}" for everyone?`)) {
      S.removeChannel(doc, id);
      if (ui.rollChannel === id) closeRoll();
    }
  },
  toggleSolo: (id) => {
    engine.setSolo(id, !engine.solo.has(id));
    render();
  },
  preview: (id) => {
    const c = channelById(id);
    if (c) engine.ensure().then(() => engine.preview(c));
  },
  openRoll: (id) => openRoll(id),
  openChannel: (id) => openChannel(id),
  openAuto: (id) => openAuto(id),
  focusChannel,
});

const roll = new PianoRoll($('roll'), {
  beginGesture: () => undo.stopCapturing(),
  addNote: (n) => S.addNote(doc, currentPattern().id, { ...n, ch: ui.rollChannel }),
  updateNote: (id, patch) => S.updateNote(doc, currentPattern().id, id, patch),
  removeNote: (id) => S.removeNote(doc, currentPattern().id, id),
  preview: (pitch) => {
    const c = channelById(ui.rollChannel);
    if (c) engine.ensure().then(() => engine.preview(c, pitch, 0.25));
  },
  cursor: throttle((pos) => publishPresence({ cursor: pos }), 50),
});

// ------------------------------------------------------------------ samples + plugins

const channelPanel = new ChannelPanel($('channelPanel'), engine, {
  saveState: (key, state) => {
    const [ch, fx] = key.split('/');
    if (fx) S.setEffect(doc, ch, fx, { state });
    else S.setPluginState(doc, ch, state);
  },
  allowOrigin: (origin) => {
    trustOrigin(origin);
    engine.retryBlocked();
  },
  pickSample: (id) => pickSample(id),
  setEffect: (ch, fx, patch) => S.setEffect(doc, ch, fx, patch),
  removeEffect: (ch, fx) => S.removeEffect(doc, ch, fx),
  addEffect: (ch, plugin) => {
    engine.ensure();
    S.addEffect(doc, ch, plugin);
  },
  addEffectFromUrl: (ch) => pickPlugin('effect', (plugin) => S.addEffect(doc, ch, plugin)),
  onClose: () => render(),
});

const autoPanel = new AutomationPanel($('autoPanel'), engine, {
  addLane: (ch, target, label) => S.addLane(doc, currentPattern().id, ch, target, label),
  removeLane: (lane) => S.removeLane(doc, currentPattern().id, lane),
  setPoint: (lane, point, pos) => S.setPoint(doc, currentPattern().id, lane, point, pos),
  removePoint: (lane, point) => S.removePoint(doc, currentPattern().id, lane, point),
  beginGesture: () => undo.stopCapturing(),
  onClose: () => render(),
});

function openAuto(id) {
  focusChannel(id);
  engine.ensure(); // plugin parameter lists need the plugin loaded
  autoPanel.open(id);
  render();
  $('autoPanel').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function openChannel(id) {
  focusChannel(id);
  engine.ensure(); // plugins need running audio to load
  channelPanel.open(id);
  render();
  $('channelPanel').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/** Short status for a channel's row: is its sample/plugin usable yet? */
function channelStatus(c) {
  if (!engine.ctx) return null;
  if (c.sample && S.INSTRUMENTS[c.inst].needs === 'sample') {
    const st = engine.sampleStatus(c.sample.id).status;
    if (st === 'loading') return { text: 'loading…', level: 'info' };
    if (st === 'error') return { text: 'sample missing', level: 'bad' };
  }
  const keys = [...(c.inst === 'wam' ? [c.id] : []), ...c.fx.map((f) => `${c.id}/${f.id}`)];
  const states = keys.map((k) => engine.slotStatus(k).status);
  if (states.includes('blocked')) return { text: 'plugin blocked: open FX', level: 'warn' };
  if (states.includes('error')) return { text: 'plugin failed', level: 'bad' };
  if (states.includes('loading')) return { text: 'loading plugin…', level: 'info' };
  return null;
}

let sampleTarget = null; // channel to replace, or null for new channels
function pickSample(channelId = null) {
  sampleTarget = channelId;
  $('fileInput').value = '';
  $('fileInput').click();
}
$('fileInput').onchange = () => uploadFiles([...$('fileInput').files], sampleTarget);

async function uploadFiles(files, targetChannel = null) {
  engine.ensure();
  for (const [i, file] of files.entries()) {
    if (file.size > 15 * 1024 * 1024) {
      toast(`${file.name} is over 15 MB`);
      continue;
    }
    toast(`Uploading ${file.name}…`);
    try {
      const res = await fetch('/api/samples', { method: 'POST', body: file, headers: { 'content-type': file.type || 'application/octet-stream' } });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
      const sample = { id: out.id, name: file.name };
      if (targetChannel && i === 0) S.setChannelSample(doc, targetChannel, sample);
      else S.addSampleChannel(doc, sample);
      toast(`Added ${file.name}`);
    } catch (err) {
      toast(`${file.name}: ${err.message}`);
    }
  }
}

// Drag and drop audio files onto the page or onto a channel.
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  document.body.classList.add('dropping');
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove('dropping');
  }
});
window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  for (const r of document.querySelectorAll('.row.drop')) r.classList.remove('drop');
  e.target.closest?.('.row')?.classList.add('drop');
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dropping');
  for (const r of document.querySelectorAll('.row.drop')) r.classList.remove('drop');
  const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('audio/') || /\.(wav|mp3|ogg|flac|m4a)$/i.test(f.name));
  if (!files.length) return toast('Drop audio files (wav, mp3, ogg, flac, m4a)');
  uploadFiles(files, e.target.closest?.('.row')?.dataset.id ?? null);
});

/** Choose a plugin: one from the catalog, or any WAM by URL. */
function pickPlugin(type, onPick) {
  $('pickerTitle').textContent = type === 'instrument' ? 'Add a plugin instrument' : 'Add an effect';
  const done = (plugin) => {
    $('picker').hidden = true;
    engine.ensure();
    onPick(plugin);
  };
  $('pickerList').replaceChildren(
    ...CATALOG.filter((p) => p.type === type).map((p) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'picker-item';
      b.innerHTML = '<b></b><span class="hint"></span>';
      b.firstChild.textContent = p.name;
      b.lastChild.textContent = p.about;
      b.onclick = () => done({ url: p.url, name: p.name });
      return b;
    }),
  );
  $('pickerUrl').value = '';
  $('pickerUrlAdd').onclick = () => {
    const url = S.cleanPluginUrl($('pickerUrl').value);
    if (!url) return toast('That doesn’t look like a plugin URL');
    trustOrigin(pluginOrigin(url)); // you chose it, so it may run for you
    done({ url, name: nameFromUrl(url) });
  };
  $('pickerCancel').onclick = () => ($('picker').hidden = true);
  $('picker').hidden = false;
}

function openRoll(id) {
  ui.rollChannel = id;
  focusChannel(id);
  $('rollPanel').hidden = false;
  roll.open(id);
  render();
  $('rollPanel').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function closeRoll() {
  ui.rollChannel = null;
  $('rollPanel').hidden = true;
  publishPresence({ cursor: null });
  render();
}

// ------------------------------------------------------------------ render

let frame = 0;
function render() {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(renderNow);
}

function renderNow() {
  const p = ui.project;
  if (!p) return;
  if (!p.patterns.some((x) => x.id === ui.patternId)) ui.patternId = p.patterns[0]?.id;
  const pattern = currentPattern();
  const remote = remoteStates();
  engine.patternId = ui.patternId;

  // Top bar
  setValue($('title'), p.title);
  setValue($('bpm'), p.bpm);
  document.title = `${p.title} · coprod`;
  for (const b of document.querySelectorAll('[data-mode]')) b.classList.toggle('on', b.dataset.mode === ui.mode);
  $('undo').disabled = undo.undoStack.length === 0;
  $('redo').disabled = undo.redoStack.length === 0;

  // People
  const people = [{ user: { name: `${me.name || 'You'} (you)`, color: me.color }, pattern: ui.patternId }, ...remote];
  $('people').replaceChildren(
    ...people.map((s) => {
      const d = document.createElement('span');
      d.className = 'avatar';
      d.style.setProperty('--c', s.user.color);
      d.textContent = (s.user.name || '?').trim().charAt(0).toUpperCase();
      const where = p.patterns.find((x) => x.id === s.pattern)?.name;
      d.title = `${s.user.name}${where ? ` · on ${where}` : ''}`;
      return d;
    }),
  );

  // Pattern tabs (with dots for who's on which pattern)
  $('patternTabs').replaceChildren(
    ...p.patterns.map((pt) => {
      const b = document.createElement('button');
      b.className = `tab ${pt.id === ui.patternId ? 'on' : ''}`;
      b.textContent = pt.name;
      b.onclick = () => selectPattern(pt.id);
      b.ondblclick = () => {
        const name = prompt('Rename pattern', pt.name);
        if (name) S.setPattern(doc, pt.id, { name });
      };
      for (const s of remote.filter((r) => r.pattern === pt.id)) {
        const dot = document.createElement('i');
        dot.style.background = s.user.color;
        dot.title = s.user.name;
        b.append(dot);
      }
      return b;
    }),
  );
  setValue($('bars'), pattern.bars);
  $('deletePattern').disabled = p.patterns.length <= 1;

  // Rack + roll
  rack.render(p, pattern, { solo: engine.solo, selectedChannel: ui.rollChannel ?? channelPanel.channelId, remote, status: channelStatus });
  channelPanel.render(p);
  autoPanel.render(p, pattern);
  const rollCh = channelById(ui.rollChannel);
  if (ui.rollChannel && (!rollCh || !S.isSynth(rollCh.inst))) closeRoll();
  else if (rollCh) {
    $('rollTitle').textContent = `${rollCh.name} · ${pattern.name}`;
    $('rollSwatch').style.background = rollCh.color;
    roll.set(p, pattern, remote);
  }

  // Song strip
  $('songStrip').replaceChildren(
    ...p.song.map((pid, i) => {
      const pt = p.patterns.find((x) => x.id === pid);
      const chip = document.createElement('button');
      chip.className = 'song-chip';
      chip.dataset.index = i;
      chip.style.flexGrow = pt?.bars ?? 1;
      chip.innerHTML = `<span></span><b aria-label="Remove">✕</b>`;
      chip.firstChild.textContent = pt?.name ?? '?';
      chip.onclick = (e) => {
        if (e.target.tagName === 'B') S.songRemove(doc, i);
        else selectPattern(pid);
      };
      return chip;
    }),
  );
  if (!p.song.length) $('songStrip').innerHTML = '<span class="hint">Empty: add patterns to arrange a song.</span>';
}

function setValue(input, value) {
  if (document.activeElement !== input && String(input.value) !== String(value)) input.value = value;
}

function selectPattern(id) {
  ui.patternId = id;
  publishPresence();
  render();
}

// The playhead runs every frame, independent of edits.
function loop() {
  const pos = engine.position();
  if (pos && ui.mode === 'song' && pos.patternId !== ui.patternId) selectPattern(pos.patternId);
  const step = pos && pos.patternId === ui.patternId ? pos.step : -1;
  rack.setNow(step);
  roll.setPlayStep(step);
  autoPanel.setPlayStep(step);
  autoPanel.draw();
  for (const c of document.querySelectorAll('.song-chip')) c.classList.toggle('now', !!pos && ui.mode === 'song' && +c.dataset.index === pos.songIndex);
  roll.draw();
  requestAnimationFrame(loop);
}

// ------------------------------------------------------------------ wiring

doc.on('update', () => {
  ui.project = S.readProject(doc);
  engine.setProject(ui.project);
  // Keep the roll's view of notes current between frames (for dragging).
  if (ui.rollChannel) roll.set(ui.project, currentPattern(), remoteStates());
  render();
});
awareness.on('change', render);
undo.on('stack-item-added', render);
undo.on('stack-item-popped', render);

provider.on('status', ({ status }) => {
  $('status').textContent = status === 'connected' ? '' : status === 'connecting' ? 'Connecting…' : 'Offline: edits will sync when you reconnect';
  $('status').classList.toggle('show', status !== 'connected');
});
provider.once('sync', () => {
  ui.project = S.readProject(doc);
  engine.setProject(ui.project);
  ui.patternId = ui.project.patterns[0]?.id;
  publishPresence();
  render();
});

async function togglePlay() {
  if (engine.playing) engine.stop();
  else await engine.play({ mode: ui.mode, patternId: ui.patternId });
  document.body.classList.toggle('playing', engine.playing);
}

$('play').onclick = togglePlay;
for (const b of document.querySelectorAll('[data-mode]')) {
  b.onclick = () => {
    ui.mode = b.dataset.mode;
    engine.mode = ui.mode;
    if (engine.playing) engine.play({ mode: ui.mode, patternId: ui.patternId });
    render();
  };
}
$('bpm').onchange = (e) => S.setMeta(doc, { bpm: e.target.value });
$('title').onchange = (e) => S.setMeta(doc, { title: e.target.value });
$('undo').onclick = () => undo.undo();
$('redo').onclick = () => undo.redo();
$('addPattern').onclick = () => selectPattern(S.addPattern(doc));
$('clonePattern').onclick = () => selectPattern(S.clonePattern(doc, ui.patternId));
$('deletePattern').onclick = () => {
  const pt = currentPattern();
  if (confirm(`Delete "${pt.name}" for everyone?`)) S.removePattern(doc, pt.id);
};
$('bars').onchange = (e) => S.setPattern(doc, ui.patternId, { bars: +e.target.value });
$('songAdd').onclick = () => S.songAppend(doc, ui.patternId);
$('rollClose').onclick = closeRoll;

for (const id of S.BUILT_IN) {
  const o = document.createElement('option');
  o.value = id;
  o.textContent = `${S.INSTRUMENTS[id].label} (${S.INSTRUMENTS[id].kind})`;
  $('addChannel').append(o);
}
for (const [value, label] of [
  ['__sample', 'Sample from a file…'],
  ['__plugin', 'Plugin instrument…'],
]) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  $('addChannel').append(o);
}
$('addChannel').onchange = (e) => {
  const inst = e.target.value;
  e.target.value = '';
  if (!inst) return;
  if (inst === '__sample') return pickSample(null);
  if (inst === '__plugin') {
    return pickPlugin('instrument', (plugin) => {
      const id = S.addPluginChannel(doc, plugin);
      openRoll(id);
      openChannel(id);
    });
  }
  const id = S.addChannel(doc, inst);
  if (S.isSynth(inst)) openRoll(id);
};

// ------------------------------------------------------------------ WAV export

function exportSummary() {
  const p = ui.project;
  const what = $('exWhat').value;
  const pats = what === 'song' ? p.song.map((id) => p.patterns.find((x) => x.id === id)).filter(Boolean) : Array(+$('exLoops').value).fill(currentPattern());
  const bars = pats.reduce((n, x) => n + x.bars, 0);
  const secs = (bars * 16 * 60) / p.bpm / 4 + +$('exTail').value;
  $('exInfo').textContent = `${bars} bar${bars === 1 ? '' : 's'} at ${p.bpm} BPM ≈ ${secs.toFixed(1)} s. Mutes and your solos apply.`;
  $('exLoopsRow').hidden = what === 'song';
}

$('exportBtn').onclick = () => {
  const songOpt = $('exWhat').options[0];
  songOpt.disabled = !ui.project.song.length;
  if (songOpt.disabled) $('exWhat').value = 'pattern';
  exportSummary();
  $('exGo').disabled = false;
  $('exGo').textContent = 'Export';
  $('exportModal').hidden = false;
};
for (const id of ['exWhat', 'exLoops', 'exTail']) $(id).onchange = exportSummary;
$('exCancel').onclick = () => ($('exportModal').hidden = true);
$('exportForm').onsubmit = async (e) => {
  e.preventDefault();
  $('exGo').disabled = true;
  $('exGo').textContent = 'Rendering…';
  try {
    await engine.ensure();
    const res = await renderProject(
      ui.project,
      { what: $('exWhat').value, patternId: ui.patternId, loops: +$('exLoops').value, tail: +$('exTail').value, bits: +$('exBits').value },
      engine,
    );
    const name = `${(ui.project.title || 'coprod').replace(/[^\w .-]+/g, '_')}.wav`;
    download(res.blob, name);
    $('exportModal').hidden = true;
    const peak = Number.isFinite(res.peak) ? `peak ${res.peak.toFixed(1)} dBFS${res.peak > -0.1 ? ' (clipping: turn something down)' : ''}` : 'silent';
    toast(`Exported ${name}: ${res.seconds.toFixed(1)} s, ${peak}${res.problems.length ? `. Left out: ${res.problems.join(', ')}` : ''}`);
  } catch (err) {
    toast(`Export failed: ${err.message}`);
  } finally {
    $('exGo').disabled = false;
    $('exGo').textContent = 'Export';
  }
};

$('share').onclick = async () => {
  try {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) await navigator.share({ title: 'Jam with me on coprod', url: location.href });
    else {
      await navigator.clipboard.writeText(location.href);
      toast('Link copied. Anyone with it can join and edit.');
    }
  } catch {
    toast(location.href);
  }
};

window.addEventListener('keydown', (e) => {
  const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName) && document.activeElement.type !== 'range';
  if (e.code === 'Space' && !typing) {
    e.preventDefault();
    togglePlay();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) {
    e.preventDefault();
    if (e.shiftKey) undo.redo();
    else undo.undo();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y' && !typing) {
    e.preventDefault();
    undo.redo();
  } else if (e.key === 'Escape') {
    if (!$('picker').hidden) $('picker').hidden = true;
    else if (!$('exportModal').hidden) $('exportModal').hidden = true;
    else if (ui.rollChannel) closeRoll();
    else if (channelPanel.channelId) channelPanel.close();
    else if (autoPanel.channelId) autoPanel.close();
  }
});

// ------------------------------------------------------------------ welcome

function welcome() {
  $('nameInput').value = me.name;
  const pick = $('colorPick');
  for (const c of S.COLORS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.style.background = c;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', c);
    b.className = c === me.color ? 'on' : '';
    b.onclick = () => {
      me.color = c;
      for (const x of pick.children) x.classList.toggle('on', x === b);
    };
    pick.append(b);
  }
  $('welcome').hidden = false;
  $('nameInput').focus();
  $('welcomeForm').onsubmit = (e) => {
    e.preventDefault();
    me.name = $('nameInput').value.trim().slice(0, 20) || 'Guest';
    store.set('coprod:name', me.name);
    store.set('coprod:color', me.color);
    $('welcome').hidden = true;
    engine.ensure(); // this click counts as the gesture that unlocks audio
    publishPresence();
    render();
  };
}

let toastTimer;
function toast(text) {
  $('toast').textContent = text;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 2600);
}

function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  let pending;
  return (arg) => {
    pending = arg;
    const now = Date.now();
    clearTimeout(timer);
    if (now - last >= ms) {
      last = now;
      fn(pending);
    } else {
      timer = setTimeout(() => {
        last = Date.now();
        fn(pending);
      }, ms - (now - last));
    }
  };
}

welcome();
requestAnimationFrame(loop);

// Handy for debugging and for the end-to-end test.
window.coprod = { doc, provider, engine, ui, S, channelPanel, autoPanel };
