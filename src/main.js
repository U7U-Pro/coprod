import './style.css';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import * as S from './shared/schema.js';
import { Engine } from './audio.js';
import { Rack } from './rack.js';
import { PianoRoll } from './pianoroll.js';

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
  rack.render(p, pattern, { solo: engine.solo, selectedChannel: ui.rollChannel, remote });
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

for (const [id, info] of Object.entries(S.INSTRUMENTS)) {
  const o = document.createElement('option');
  o.value = id;
  o.textContent = `${info.label} (${info.kind})`;
  $('addChannel').append(o);
}
$('addChannel').onchange = (e) => {
  const inst = e.target.value;
  e.target.value = '';
  if (!inst) return;
  const id = S.addChannel(doc, inst);
  if (S.isSynth(inst)) openRoll(id);
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
  } else if (e.key === 'Escape' && ui.rollChannel) closeRoll();
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
window.coprod = { doc, provider, engine, ui, S };
