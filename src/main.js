// A session: one shared project, edited live by everyone in the room.
// Loaded by app.js once someone is signed in and the URL names a room.

import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import * as S from './shared/schema.js';
import { api, live, session, exportCopr, importCopr } from './api.js';
import { el, face, initial, toast, timeAgo, saveBlob } from './ui.js';
import { goToRoom } from './nav.js';
import { Chat } from './chat.js';
import { openProfile, onProfileSaved, openUpgrade } from './profile.js';
import { Engine } from './audio.js';
import { Rack } from './rack.js';
import { PianoRoll } from './pianoroll.js';
import { ChannelPanel } from './channelpanel.js';
import { AutomationPanel } from './automation.js';
import { Playlist } from './playlist.js';
import { CATALOG, communityPlugins, trustOrigin, nameFromUrl, pluginOrigin } from './plugins.js';
import { renderProject, download, exportLength, FORMATS } from './export.js';

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
document.body.classList.add('in-room');
$('roomScreen').hidden = false;
$('status').textContent = 'Connecting…';
$('status').classList.add('show');
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
  songStart: 0, // song step Song mode plays from (mine)
  active: null, // the editor keyboard shortcuts go to: 'roll' | 'auto' | 'playlist'
  following: null, // user id whose view mine follows
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

// Who I am comes from my account (the server shows everyone else the same).
const me = session.user;
const badge = () => ({ id: me.id, name: me.name, username: me.username, color: me.color, ...(me.guest ? { guest: true } : {}) });
onProfileSaved(() => {
  publishPresence(); // (the server re-reads the account, e.g. a guest who just made one)
  if (!$('inviteModal').hidden) drawInviteFriends();
  render();
});

function publishPresence(extra = {}) {
  awareness.setLocalState({
    ...(awareness.getLocalState() ?? {}),
    user: badge(),
    pattern: ui.patternId,
    channel: ui.focusChannel,
    roll: ui.rollChannel, // the piano roll I have open (for people following me)
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
  addNotes: (notes) => S.addNotes(doc, currentPattern().id, notes.map((n) => ({ ...n, ch: ui.rollChannel }))),
  updateNotes: (patches) => S.updateNotes(doc, currentPattern().id, patches),
  removeNotes: (ids) => S.removeNotes(doc, currentPattern().id, ids),
  setLyric: (id, text) => S.setLyric(doc, currentPattern().id, id, text),
  preview: (pitch, note) => {
    const c = channelById(ui.rollChannel);
    const dur = note?.pb ? Math.min(2, (note.l * 15) / ui.project.bpm) : note?.ly ? 0.4 : 0.25;
    if (c) engine.ensure().then(() => engine.preview(c, pitch, dur, note));
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
  browseEffects: (ch) => openPlugins({ kind: 'effect', channel: ch }),
  setNotes: (ch, notes) => {
    // Replace this channel's notes in the current pattern; it grows to fit.
    const p = currentPattern();
    undo.stopCapturing();
    doc.transact(() => {
      S.removeNotes(doc, p.id, p.notes.filter((n) => n.ch === ch).map((n) => n.id));
      S.addNotes(doc, p.id, notes.map((n) => ({ ch, p: n.p, s: n.s, l: n.l, v: n.v ?? 100 })));
    });
    openRoll(ch);
  },
  setLyrics: (ch, syllables, opts) => {
    undo.stopCapturing();
    const result = S.assignLyrics(doc, currentPattern().id, ch, syllables, opts);
    openRoll(ch);
    return result;
  },
  onClose: () => render(),
});

const autoPanel = new AutomationPanel($('autoPanel'), engine, {
  addLane: (ch, target, label) => S.addLane(doc, currentPattern().id, ch, target, label),
  removeLane: (lane) => S.removeLane(doc, currentPattern().id, lane),
  setLane: (lane, patch) => S.setLane(doc, currentPattern().id, lane, patch),
  setPoint: (lane, point, pos) => S.setPoint(doc, currentPattern().id, lane, point, pos),
  removePoint: (lane, point) => S.removePoint(doc, currentPattern().id, lane, point),
  removePoints: (lane, ids) => S.removePoints(doc, currentPattern().id, lane, ids),
  updatePoints: (lane, patches) => S.updatePoints(doc, currentPattern().id, lane, patches),
  pastePoints: (lane, points) => S.pastePoints(doc, currentPattern().id, lane, points),
  setCurve: (lane, point, curve) => S.setCurve(doc, currentPattern().id, lane, point, curve),
  beginGesture: () => undo.stopCapturing(),
  onClose: () => render(),
});

const playlist = new Playlist($('playlist'), {
  beginGesture: () => undo.stopCapturing(),
  activate: () => (ui.active = 'playlist'),
  addClip: (clip) => S.addClip(doc, clip),
  addClips: (clips) => S.addClips(doc, clips),
  updateClips: (patches) => S.updateClips(doc, patches),
  removeClips: (ids) => S.removeClips(doc, ids),
  selectPattern: (id) => selectPattern(id),
  setStart: (step) => {
    ui.songStart = step;
    if (engine.playing && ui.mode === 'song') engine.play({ mode: 'song', patternId: ui.patternId, from: step });
    render();
  },
});

// Keyboard shortcuts go to the editor you last clicked in.
$('roll').addEventListener('pointerdown', () => (ui.active = 'roll'), true);
$('autoPanel').addEventListener('pointerdown', () => (ui.active = 'auto'), true);

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
  const project = [...e.dataTransfer.files].find((f) => /\.copr$/i.test(f.name));
  if (project) return openCopr(project);
  const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('audio/') || /\.(wav|mp3|ogg|flac|m4a)$/i.test(f.name));
  if (!files.length) return toast('Drop audio files (wav, mp3, ogg, flac, m4a)');
  uploadFiles(files, e.target.closest?.('.row')?.dataset.id ?? null);
});

/**
 * The plugin browser: coprod's own plugins, the WAM community's, or any WAM by
 * URL. Instruments become a new channel; effects go on the chosen channel.
 * @param {{ kind?: 'all'|'instrument'|'effect', channel?: string }} opts
 */
function openPlugins({ kind = 'all', channel } = {}) {
  const hint = (text) => Object.assign(document.createElement('p'), { className: 'hint', textContent: text });
  const heading = (text) => Object.assign(document.createElement('h3'), { className: 'picker-group', textContent: text });

  // Where effects go: the channel you opened this from, else the one you last touched.
  const target = $('pickerTarget');
  const channels = ui.project.channels;
  target.replaceChildren(...channels.map((c) => Object.assign(document.createElement('option'), { value: c.id, textContent: c.name })));
  target.value = [channel, ui.focusChannel].find((id) => channels.some((c) => c.id === id)) ?? channels[0]?.id ?? '';

  const add = (p, type) => {
    trustOrigin(pluginOrigin(p.url)); // you chose it, so it may run for you
    const plugin = { url: p.url, name: p.name };
    if (type === 'effect' && !target.value) return toast('Add a channel first, then put effects on it');
    $('picker').hidden = true;
    engine.ensure();
    if (type === 'instrument') {
      const id = S.addPluginChannel(doc, plugin);
      openRoll(id);
      openChannel(id);
    } else {
      S.addEffect(doc, target.value, plugin);
      openChannel(target.value);
    }
  };

  const item = (p) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'picker-item';
    b.innerHTML = '<b></b><span class="hint"></span>';
    b.firstChild.textContent = p.name;
    b.lastChild.textContent = `${p.vendor || 'Built into coprod'} · ${p.about}`;
    if (p.thumb) {
      const img = document.createElement('img');
      img.src = p.thumb;
      img.alt = '';
      img.loading = 'lazy';
      b.prepend(img);
      b.classList.add('has-thumb');
    }
    b.onclick = () => add(p, p.type);
    return b;
  };

  let all = [...CATALOG];
  let status = 'Loading the WAM community plugins…';
  const search = $('pickerSearch');
  search.value = '';
  const show = () => {
    for (const b of $('pickerKinds').children) {
      const n = all.filter((p) => b.dataset.kind === 'all' || p.type === b.dataset.kind).length;
      b.classList.toggle('on', b.dataset.kind === kind);
      b.textContent = `${{ all: 'All', instrument: 'Instruments', effect: 'Effects' }[b.dataset.kind]} ${n}`;
    }
    $('pickerTargetRow').hidden = kind === 'instrument';
    const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = all.filter((p) => words.every((w) => `${p.name} ${p.vendor ?? ''} ${p.about} ${p.tags ?? ''} ${p.type}`.toLowerCase().includes(w)));
    const out = [];
    for (const type of ['instrument', 'effect']) {
      if (kind !== 'all' && kind !== type) continue;
      const group = hits.filter((p) => p.type === type);
      if (kind === 'all' && group.length) out.push(heading(type === 'instrument' ? 'Instruments (new channel)' : 'Effects'));
      out.push(...group.map(item));
    }
    if (!out.length) out.push(hint('No matches.'));
    if (status) out.push(hint(status));
    $('pickerList').replaceChildren(...out);
  };
  for (const b of $('pickerKinds').children) b.onclick = () => ((kind = b.dataset.kind), show());
  search.oninput = show;
  show();
  communityPlugins().then(
    (community) => {
      all = [...CATALOG, ...community];
      status = null;
      show();
    },
    (err) => {
      status = `Couldn’t load the WAM community list (${err.message}). You can still add a plugin by URL below.`;
      show();
    },
  );

  $('pickerUrl').value = '';
  const fromUrl = (type) => {
    const url = S.cleanPluginUrl($('pickerUrl').value);
    if (!url) return toast('That doesn’t look like a plugin URL');
    add({ url, name: nameFromUrl(url) }, type);
  };
  $('pickerUrlInst').onclick = () => fromUrl('instrument');
  $('pickerUrlFx').onclick = () => fromUrl('effect');
  $('pickerForm').onsubmit = (e) => e.preventDefault(); // Enter in a field must not reload the page
  $('pickerCancel').onclick = () => ($('picker').hidden = true);
  $('picker').hidden = false;
  search.focus();
}

function openRoll(id) {
  ui.rollChannel = id;
  ui.focusChannel = id;
  publishPresence(); // always: people following me open this roll too
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

  // People: one avatar per person (someone with two tabs open counts once). Click for their profile.
  const people = [];
  for (const s of [{ user: badge(), pattern: ui.patternId }, ...remote]) {
    if (s.user.id && people.some((x) => x.user.id === s.user.id)) continue;
    people.push(s);
  }
  $('people').replaceChildren(
    ...people.map((s) => {
      const mine = s.user.id === me.id;
      const b = el('button', { type: 'button', class: `avatar${ui.following === s.user.id ? ' followed' : ''}`, style: `--c:${s.user.color}`, dataset: { user: s.user.username ?? '' } }, initial(s.user.name));
      const where = p.patterns.find((x) => x.id === s.pattern)?.name;
      b.title = `${s.user.name}${mine ? ' (you)' : s.user.guest ? ' (guest)' : ''}${where && !mine ? ` · on ${where}` : ''}`;
      b.setAttribute('aria-label', `${b.title}: show profile`);
      b.onclick = () => showPerson(s.user, b);
      return b;
    }),
  );
  $('chatWho').textContent = people.length > 1 ? `${people.length} here` : 'Just you so far';
  updateFollowBar(remote);

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
  rack.render(p, pattern, {
    solo: engine.solo,
    selectedChannel: ui.rollChannel ?? channelPanel.channelId,
    remote,
    status: channelStatus,
    visible: $('hideUnused').checked ? usedIn(pattern) : null,
  });
  channelPanel.render(p);
  autoPanel.render(p, pattern);
  const rollCh = channelById(ui.rollChannel);
  if (ui.rollChannel && (!rollCh || !S.isSynth(rollCh.inst))) closeRoll();
  else if (rollCh) {
    $('rollTitle').textContent = `${rollCh.name} · ${pattern.name}`;
    $('rollSwatch').style.background = rollCh.color;
    roll.set(p, pattern, remote);
    // Lyrics editing, for plugins that sing (or notes that already have lyrics).
    const sings = !!engine.slots.get(rollCh.id)?.descriptor?.lyrics || pattern.notes.some((n) => n.ch === rollCh.id && n.ly);
    $('rollLyrics').hidden = !sings;
    if (!sings && roll.lyricMode) roll.setMode('notes');
    for (const [id, mode] of [['rollLyrics', 'lyrics'], ['rollSlide', 'slide']]) {
      $(id).classList.toggle('on', roll.mode === mode);
      $(id).setAttribute('aria-pressed', roll.mode === mode);
    }
    $('rollHint').textContent = {
      lyrics: 'Click a note to type its lyric · Tab: next note · several words fill the next notes',
      slide: "Drag along a note to draw its pitch (Shift: straight line · Alt: fine) · drag a point to move it · right-click a point (or a note) to remove",
      notes: 'Click to add · drag to move or resize (Alt: fine) · click a note to delete · Ctrl+drag to select, then Ctrl+C / Ctrl+V / Delete',
    }[roll.mode];
  }

  // Arrangement
  playlist.set(p, { patternId: ui.patternId, start: ui.songStart });
}

/** For "Hide unused": channels with steps, notes or automation in this pattern (plus the ones I have open). */
function usedIn(pattern) {
  const used = new Set([ui.rollChannel, channelPanel.channelId, autoPanel.channelId, ui.focusChannel]);
  for (const k of pattern.steps.keys()) used.add(k.slice(0, k.lastIndexOf(':')));
  for (const n of pattern.notes) used.add(n.ch);
  for (const l of pattern.lanes) if (l.points.length) used.add(l.ch);
  return used;
}

function setValue(input, value) {
  if (document.activeElement !== input && String(input.value) !== String(value)) input.value = value;
}

function selectPattern(id) {
  if (ui.following) stopFollowing(); // you went somewhere yourself
  ui.patternId = id;
  publishPresence();
  render();
}

// The playhead runs every frame, independent of edits.
function loop() {
  const pos = engine.position();
  // The pattern I'm looking at shows its playhead when it's playing (in any clip).
  const step = pos?.active.find((a) => a.patternId === ui.patternId)?.step ?? -1;
  rack.setNow(step);
  roll.setPlayStep(step);
  autoPanel.setPlayStep(step);
  playlist.setPlayStep(pos?.songStep ?? -1);
  autoPanel.draw();
  roll.draw();
  playlist.draw();
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
awareness.on('change', () => {
  followTick();
  render();
});
undo.on('stack-item-added', render);
undo.on('stack-item-popped', render);

let lastSessionCheck = 0;
provider.on('status', ({ status }) => {
  $('status').textContent = status === 'connected' ? '' : status === 'connecting' ? 'Connecting…' : 'Offline: edits will sync when you reconnect';
  $('status').classList.toggle('show', status !== 'connected');
  // The server refuses the socket if the session has ended; find out (this signs you out if so).
  if (status === 'disconnected' && Date.now() - lastSessionCheck > 10_000) {
    lastSessionCheck = Date.now();
    api.get('/api/me').then(({ user }) => !user && session.onSignedOut?.(), () => {});
  }
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
  else await engine.play({ mode: ui.mode, patternId: ui.patternId, from: ui.songStart });
  document.body.classList.toggle('playing', engine.playing);
}

$('play').onclick = togglePlay;
for (const b of document.querySelectorAll('[data-mode]')) {
  b.onclick = () => {
    ui.mode = b.dataset.mode;
    engine.mode = ui.mode;
    if (engine.playing) engine.play({ mode: ui.mode, patternId: ui.patternId, from: ui.songStart });
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
$('bars').onchange = (e) => {
  const bars = Math.round(+e.target.value);
  if (bars >= 1 && bars <= S.MAX_BARS) S.setPattern(doc, ui.patternId, { bars });
  render();
};
$('songAdd').onclick = () => S.appendClip(doc, ui.patternId);
$('rollClose').onclick = closeRoll;
$('rollLyrics').onclick = () => {
  roll.setMode(roll.mode === 'lyrics' ? 'notes' : 'lyrics');
  render();
};
$('rollSlide').onclick = () => {
  roll.setMode(roll.mode === 'slide' ? 'notes' : 'slide');
  render();
};
$('hideUnused').checked = store.get('coprod:hideUnused') === '1';
$('hideUnused').onchange = () => {
  store.set('coprod:hideUnused', $('hideUnused').checked ? '1' : '0');
  render();
};

for (const id of S.BUILT_IN) {
  const o = document.createElement('option');
  o.value = id;
  o.textContent = `${S.INSTRUMENTS[id].label} (${S.INSTRUMENTS[id].kind})`;
  $('addChannel').append(o);
}
for (const [value, label] of [
  ['__sample', 'Sample from a file…'],
  ['__plugin', 'Plugins (instruments & effects)…'],
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
  if (inst === '__plugin') return openPlugins();
  const id = S.addChannel(doc, inst);
  if (S.isSynth(inst)) openRoll(id);
};

// ------------------------------------------------------------------ audio export

const exportPrefs = {
  get: () => {
    try {
      return JSON.parse(store.get('coprod:export') ?? '{}') ?? {};
    } catch {
      return {};
    }
  },
  set: (patch) => store.set('coprod:export', JSON.stringify({ ...exportPrefs.get(), ...patch })),
};
// Approximate bitrates (kbit/s) for the size estimate.
const KBPS = { mp3: { 320: 320, 256: 256, 192: 192, 128: 128 }, ogg: { 8: 256, 6: 192, 4: 128 } };

const clockTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function exportOptions() {
  return { what: $('exWhat').value, patternId: ui.patternId, loops: +$('exLoops').value, tail: +$('exTail').value, format: $('exFormat').value, quality: $('exQuality').value };
}

function exportSummary() {
  const p = ui.project;
  const opts = exportOptions();
  const { steps, seconds } = exportLength(p, opts);
  const bars = Math.ceil(steps / S.STEPS_PER_BAR);
  const sr = engine.ctx?.sampleRate ?? 48000;
  const bytes = opts.format === 'wav' ? (seconds * sr * 2 * +opts.quality) / 8 : (seconds * (KBPS[opts.format][opts.quality] ?? 192) * 1000) / 8;
  const size = bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
  const loopNote = opts.format === 'mp3' && opts.tail === 0 ? ' Every MP3 starts with a short silence (a few hundredths of a second), so for seamless loops use WAV or OGG.' : '';
  const length = seconds < 60 ? `${seconds.toFixed(1)} s` : clockTime(seconds);
  $('exInfo').textContent = `${bars} bar${bars === 1 ? '' : 's'} at ${p.bpm} BPM ≈ ${length}, about ${size}. Mutes and your solos apply.${loopNote}`;
  $('exLoopsRow').hidden = opts.what === 'song';
  if (!exporting) $('exGo').textContent = `Export ${FORMATS[opts.format].ext.toUpperCase()}`;
}

/** The quality menu for the chosen format (remembering the last choice for each). */
function fillQualities() {
  const format = $('exFormat').value;
  $('exQuality').replaceChildren(...FORMATS[format].qualities.map(([value, label]) => new Option(label, value)));
  const saved = exportPrefs.get()[`quality:${format}`];
  $('exQuality').value = FORMATS[format].qualities.some(([v]) => v === saved) ? saved : FORMATS[format].qualities[0][0];
}

const roughly = (s) => (s < 60 ? `${Math.max(1, Math.round(s))} s` : `${Math.round(s / 60)} min`);

let exporting = null; // the running export's AbortController
let progressShown = { at: 0, overall: 0 };
/** One bar for the whole export: loading 0-3%, rendering, then encoding (longer for MP3/OGG). */
function showExportProgress(p, format) {
  const now = performance.now();
  if (p.phase === progressShown.phase && p.fraction !== 1 && now - progressShown.at < 100) return; // ~10 updates a second
  const encodeShare = format === 'wav' ? 0.02 : 0.12;
  const bar = $('exBar').parentElement;
  bar.classList.toggle('unknown', p.phase === 'rendering' && p.fraction == null);
  let overall = progressShown.overall;
  let text;
  if (p.phase === 'loading') {
    overall = p.total ? (0.03 * p.done) / p.total : 0;
    text = p.total ? `Loading plugins and samples… ${p.done} of ${p.total}` : 'Getting ready…';
  } else if (p.phase === 'rendering') {
    if (p.fraction == null) text = 'Rendering… (this browser can’t say how far along it is)';
    else {
      overall = 0.03 + (0.97 - encodeShare) * p.fraction;
      text = p.rendered > 0 ? `Rendering ${clockTime(p.rendered)} of ${clockTime(p.seconds)}${p.eta > 2 ? ` · about ${roughly(p.eta)} left` : ''}` : 'Warming up the plugins…';
    }
  } else {
    overall = 1 - encodeShare * (1 - p.fraction);
    text = format === 'wav' ? 'Writing the file…' : `Encoding ${FORMATS[format].ext.toUpperCase()}… ${Math.round(p.fraction * 100)}%`;
  }
  overall = Math.max(progressShown.overall, Math.min(1, overall)); // never goes backwards
  progressShown = { at: now, overall, phase: p.phase };
  $('exProgress').hidden = false;
  $('exBar').style.width = `${(overall * 100).toFixed(1)}%`;
  bar.setAttribute('aria-valuenow', String(Math.round(overall * 100)));
  $('exStatus').textContent = text;
}

function setExportBusy(on) {
  $('exportForm').classList.toggle('busy', on);
  $('exGo').disabled = on;
  $('exCopr').disabled = on;
  $('exCancel').textContent = on ? 'Cancel export' : 'Cancel';
  if (on) $('exGo').textContent = 'Exporting…';
  else {
    $('exProgress').hidden = true;
    $('exBar').style.width = '0';
    progressShown = { at: 0, overall: 0 };
    exportSummary();
  }
}

$('exportBtn').onclick = () => {
  const songOpt = $('exWhat').options[0];
  songOpt.disabled = !ui.project.clips.length;
  if (songOpt.disabled) $('exWhat').value = 'pattern';
  const prefs = exportPrefs.get();
  if (FORMATS[prefs.format]) $('exFormat').value = prefs.format;
  fillQualities();
  exportSummary();
  $('exportModal').hidden = false;
};
for (const id of ['exWhat', 'exLoops', 'exTail']) $(id).onchange = exportSummary;
$('exFormat').onchange = () => {
  exportPrefs.set({ format: $('exFormat').value });
  fillQualities();
  exportSummary();
};
$('exQuality').onchange = () => {
  exportPrefs.set({ [`quality:${$('exFormat').value}`]: $('exQuality').value });
  exportSummary();
};
function cancelOrCloseExport() {
  if (exporting) exporting.abort();
  else $('exportModal').hidden = true;
}
$('exCancel').onclick = cancelOrCloseExport;
$('exportForm').onsubmit = async (e) => {
  e.preventDefault();
  if (exporting) return;
  const controller = (exporting = new AbortController());
  const opts = exportOptions();
  setExportBusy(true);
  showExportProgress({ phase: 'loading', done: 0, total: 0 }, opts.format);
  try {
    // Export renders the shared state: stop playback (automation is moving knobs) and save any knob still waiting.
    if (engine.playing) {
      engine.stop();
      document.body.classList.remove('playing');
    }
    await engine.ensure();
    await channelPanel.flush();
    const res = await renderProject(ui.project, opts, engine, { signal: controller.signal, onProgress: (p) => showExportProgress(p, opts.format) });
    const name = `${(ui.project.title || 'coprod').replace(/[^\w .-]+/g, '_')}.${res.ext}`;
    download(res.blob, name);
    $('exportModal').hidden = true;
    const peak = Number.isFinite(res.peak) ? `peak ${res.peak.toFixed(1)} dBFS${res.peak > -0.1 ? ' (clipping: turn something down)' : ''}` : 'silent';
    toast(`Exported ${name}: ${res.seconds.toFixed(1)} s, ${peak}${res.problems.length ? `. Left out: ${res.problems.join(', ')}` : ''}`);
  } catch (err) {
    toast(err.name === 'ExportCancelled' ? 'Export cancelled' : `Export failed: ${err.message}`);
  } finally {
    exporting = null;
    setExportBusy(false);
  }
};

// ------------------------------------------------------------------ people: profiles, following, invites

/** Someone's most recent presence in this room (if they're here). */
const stateOf = (userId) => remoteStates().find((s) => s.user.id === userId) ?? null;

/** "On Pattern 2, in Bass's piano roll" */
function whereIs(s) {
  const pattern = ui.project?.patterns.find((x) => x.id === s.pattern);
  const roll = channelById(s.roll);
  const ch = channelById(s.channel);
  const parts = [];
  if (pattern) parts.push(`on ${pattern.name}`);
  if (roll) parts.push(`in ${roll.name}’s piano roll`);
  else if (ch) parts.push(`working on ${ch.name}`);
  return `Here now${parts.length ? `, ${parts.join(', ')}` : ''}`;
}

/** Show what they're looking at: their pattern, and their piano roll if one is open. */
function goTo(s) {
  if (s.pattern && s.pattern !== ui.patternId && ui.project.patterns.some((x) => x.id === s.pattern)) {
    ui.patternId = s.pattern;
    publishPresence();
  }
  const roll = channelById(s.roll);
  if (roll && S.isSynth(roll.inst)) {
    if (ui.rollChannel !== roll.id) openRoll(roll.id);
  } else if (s.channel) {
    const row = document.querySelector(`.row[data-id="${CSS.escape(s.channel)}"]`);
    row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    row?.classList.add('flash');
    setTimeout(() => row?.classList.remove('flash'), 1200);
  }
  render();
}

let followSeen = null;
function follow(user) {
  ui.following = user.id;
  followSeen = null;
  followTick();
  toast(`Following ${user.name}. Pick a pattern yourself (or press Stop) to stop.`);
  render();
}
function stopFollowing() {
  ui.following = null;
  render();
}
/** While following, move whenever the person I follow does. */
function followTick() {
  if (!ui.following) return;
  const s = stateOf(ui.following);
  if (!s) {
    ui.following = null;
    toast('They left, so you’re not following anyone now');
    return render();
  }
  const key = `${s.pattern}|${s.roll}`;
  if (key === followSeen) return;
  followSeen = key;
  goTo(s);
}
function updateFollowBar(remote) {
  const s = ui.following && remote.find((x) => x.user.id === ui.following);
  $('followBar').hidden = !s;
  if (!s) return;
  $('followName').textContent = s.user.name;
  $('followBar').querySelector('.face-slot').replaceChildren(face(s.user, { size: 22 }));
}
$('followStop').onclick = stopFollowing;

/** A person's profile card, with what you can do with them in a session. */
function showPerson(user, anchor) {
  const mine = user.id === me.id;
  openProfile(user.id, {
    anchor,
    user,
    here: () => {
      if (mine) return null;
      const s = stateOf(user.id);
      return s ? whereIs(s) : null;
    },
    actions: () => {
      if (mine) return [];
      const here = !!stateOf(user.id);
      return [
        here && {
          label: 'Go to them',
          title: 'Jump to the pattern and channel they’re on',
          run: () => {
            const s = stateOf(user.id);
            if (s) goTo(s);
            else toast(`${user.name} isn’t here anymore`);
          },
        },
        here && (ui.following === user.id ? { label: 'Stop following', run: stopFollowing } : { label: 'Follow', title: 'Your view follows theirs as they move around', run: () => follow(user) }),
        { label: '@ Mention', title: 'Start a chat message to them', run: () => chat.mention(user.username) },
      ].filter(Boolean);
    },
  });
}

const chat = new Chat(
  { panel: $('chatPanel'), log: $('chatLog'), form: $('chatForm'), input: $('chatInput'), typing: $('chatTyping'), badge: $('chatBadge') },
  provider,
  {
    me: badge,
    openProfile: (user, anchor) => showPerson(user, anchor),
    onToggle: (open) => {
      $('chatBtn').setAttribute('aria-expanded', String(open));
      $('chatBtn').classList.toggle('on', open);
    },
  },
);
$('chatBtn').onclick = () => chat.toggle();
$('chatClose').onclick = () => chat.close();

async function drawInviteFriends() {
  const box = $('inviteFriends');
  const hint = (text) => el('p', { class: 'hint' }, text);
  if (me.guest) {
    box.replaceChildren(
      hint('Guests send the link. With an account you can add friends and invite them here with one click.'),
      el('button', { type: 'button', class: 'ghost small', onclick: () => (($('inviteModal').hidden = true), openUpgrade()) }, 'Create an account'),
    );
    return;
  }
  try {
    const { friends } = await api.get('/api/friends');
    const here = new Set(remoteStates().map((s) => s.user.id));
    box.replaceChildren(
      ...(friends.length
        ? friends.map((f) => {
            const line = here.has(f.user.id) ? 'Here with you' : f.status === 'session' ? `In “${f.session.title}”` : f.status === 'online' ? 'Online' : f.seen ? `Last seen ${timeAgo(f.seen)}` : 'Offline';
            const button = el('button', { type: 'button', class: 'primary small', dataset: { invite: f.user.username } }, 'Invite');
            if (here.has(f.user.id)) Object.assign(button, { disabled: true, textContent: 'Here', className: 'ghost small' });
            else if (f.status === 'offline') Object.assign(button, { disabled: true, textContent: 'Offline', className: 'ghost small', title: 'Invites reach people who have coprod open. Send them the link instead.' });
            button.onclick = async () => {
              button.disabled = true;
              try {
                const { delivered } = await api.post('/api/invites', { to: f.user.id, room });
                button.textContent = delivered ? 'Invited ✓' : 'Not online';
                if (!delivered) toast(`${f.user.name} just went offline. Send them the link instead.`);
              } catch (err) {
                toast(err.message);
                button.disabled = false;
              }
            };
            return el(
              'div',
              { class: 'person' },
              el('span', { class: 'person-main' }, face(f.user, { size: 32, status: f.status }), el('span', { class: 'person-text' }, el('b', {}, f.user.name), el('span', { class: 'hint' }, line))),
              button,
            );
          })
        : [hint('No friends yet. Click someone’s picture in a session to add them, or find people by @username on your projects page.')]),
    );
  } catch (err) {
    box.replaceChildren(hint(err.message));
  }
}
live.on('friends', () => !$('inviteModal').hidden && drawInviteFriends());

$('share').onclick = () => {
  $('inviteLink').value = location.href;
  $('inviteModal').hidden = false;
  $('inviteCopy').textContent = 'Copy link';
  drawInviteFriends();
};
$('inviteCopy').onclick = async () => {
  try {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) await navigator.share({ title: 'Jam with me on coprod', url: location.href });
    else {
      await navigator.clipboard.writeText(location.href);
      $('inviteCopy').textContent = 'Copied ✓';
    }
  } catch {
    $('inviteLink').select();
  }
};
$('inviteClose').onclick = () => ($('inviteModal').hidden = true);

// ------------------------------------------------------------------ .copr project files

async function saveCopr() {
  const b = $('exCopr');
  b.disabled = true;
  try {
    if (!provider.synced) toast('Still connecting: the file may miss your latest edits');
    const { blob, name } = await exportCopr(room);
    saveBlob(blob, name);
    toast(`Saved ${name}`);
  } catch (err) {
    toast(`Couldn’t save: ${err.message}`);
  } finally {
    b.disabled = false;
  }
}
$('exCopr').onclick = saveCopr;

async function openCopr(file) {
  if (!confirm(`Open “${file.name}” as a new project? (This one stays as it is.)`)) return;
  toast(`Opening ${file.name}…`);
  try {
    goToRoom((await importCopr(file)).id);
  } catch (err) {
    toast(err.message);
  }
}

window.addEventListener('keydown', (e) => {
  const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName) && document.activeElement.type !== 'range';
  // Selection shortcuts (Delete, Ctrl+C/X/V/A/B, Esc) for the editor in use.
  const editor = { roll: ui.rollChannel && roll, auto: autoPanel.channelId && autoPanel, playlist }[ui.active];
  if (editor && !typing && editor.key(e)) {
    e.preventDefault();
    render();
    return;
  }
  if (e.code === 'Space' && !typing) {
    e.preventDefault();
    togglePlay();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    // Everything saves by itself; Ctrl+S gives you a .copr copy instead of the browser's "save page".
    e.preventDefault();
    toast('coprod saves as you go. Downloading a .copr copy…');
    saveCopr();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) {
    e.preventDefault();
    if (e.shiftKey) undo.redo();
    else undo.undo();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y' && !typing) {
    e.preventDefault();
    undo.redo();
  } else if (e.key === 'Escape') {
    if (!$('picker').hidden) $('picker').hidden = true;
    else if (!$('exportModal').hidden) cancelOrCloseExport();
    else if (!$('inviteModal').hidden) $('inviteModal').hidden = true;
    else if (!$('profileModal').hidden) $('profileModal').hidden = true;
    else if (chat.isOpen) chat.close();
    else if (ui.following) stopFollowing();
    else if (ui.rollChannel) closeRoll();
    else if (channelPanel.channelId) channelPanel.close();
    else if (autoPanel.channelId) autoPanel.close();
  }
});

// ------------------------------------------------------------------ audio

// Browsers only start audio after the page has been clicked or typed in. Coming
// from the projects page (or signing in) counts; otherwise the first click does.
function unlockAudio() {
  engine.ensure();
  for (const t of ['pointerdown', 'keydown']) removeEventListener(t, unlockAudio, true);
}
if (navigator.userActivation?.hasBeenActive) engine.ensure();
else for (const t of ['pointerdown', 'keydown']) addEventListener(t, unlockAudio, true);

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

requestAnimationFrame(loop);

// Handy for debugging and for the end-to-end test.
window.coprod = { doc, provider, engine, ui, S, channelPanel, autoPanel, roll, playlist, chat };
