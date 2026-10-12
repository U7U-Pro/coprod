# coprod

Make beats together, live, in the browser. It's an FL-style **channel rack**, **piano
roll** and **pattern/song** arranger where everyone with the link edits the same
project at the same time and sees each other's changes, cursors and focus as
they happen.

## Try it

```bash
npm install
npm run dev        # http://localhost:5173  (Vite + sync server, hot reload)
```

Open the page and you get a fresh room with a starter beat. Press **Invite** and
send the link; whoever opens it joins the same project.

Production:

```bash
npm run build
npm start          # serves dist/ and the sync socket on $PORT (default 3000)
```

## What's in the prototype

- **Channel rack**: drum channels with a step grid (click or drag to paint), synth
  channels with a mini preview of their notes. Per-channel volume, pan, mute
  (shared) and solo (just for you).
- **Piano roll** for synth channels: click to add, drag to move, drag the end to
  resize, click a note to delete. Other synth channels show as faint ghost notes.
- **Patterns** of 1, 2 or 4 bars (add, clone, rename by double-clicking, delete), and a
  **Song** strip that plays patterns in order.
- **11 built-in instruments**: kick, snare, clap, hats, perc, bass, lead, pluck, keys, pad.
  All are synthesized in the browser, so everyone hears exactly the same thing.
- **Multiplayer**: live edits, avatars, colored name tags on the channel each
  person is working on, live cursors in the piano roll, dots on the pattern tabs
  showing who's where.
- **Undo/redo is per person**: Ctrl+Z undoes *your* last edit, never someone else's.
- **Offline-tolerant**: if your connection drops you can keep editing; changes
  merge when you reconnect.
- Space plays and stops; Esc closes the piano roll.

## How it works

The project is a [Yjs](https://yjs.dev) document (a CRDT): the same technology
behind Google-Docs-style editors. Edits are tiny messages, and any two sets of
concurrent edits merge to the same result on every machine, with no locking and
no "someone else is editing" errors. **Audio is never streamed.** Each browser
plays the shared project itself with the Web Audio API, scheduled ahead on the
audio clock so timing stays tight.

```
browser ── edits (Yjs updates) ──► server/rooms.js ──► every other browser in the room
   │                                     │
   └─ renders audio locally              └─ saves each room to data/rooms/<room>.ydoc
```

- `src/shared/schema.js`: the document layout and every edit operation (also used
  by the server to seed new rooms). The comments explain why steps are keyed map
  entries rather than array slots.
- `src/audio.js`: look-ahead scheduler, mixer buses, playhead.
- `src/instruments.js`: the synthesized instruments.
- `src/rack.js`, `src/pianoroll.js`, `src/main.js`: the UI.
- `server/rooms.js`: a small y-websocket-compatible sync server with persistence.

## Tests

```bash
npm test                      # merge/conflict behavior + server sync & persistence
npm run build && npm run e2e  # three real browsers editing one room (needs Chromium;
                              # set CHROMIUM_PATH if Playwright's isn't installed)
```

## Deploying

Any Node 20+ host with WebSocket support (Render, Railway, Fly.io, a VPS). Build
command `npm install && npm run build`, start command `npm start`. Point
`COPROD_DATA` at a persistent disk so rooms survive redeploys.

## Known limits (it's a prototype)

- No accounts. Anyone with a room link can edit it, so treat links like a shared
  Google Doc's "anyone with the link" setting.
- Built-in instruments only: no samples, VST plugins, effects or automation yet.
- Each person's play button is independent (like each person scrolling their own
  copy of a doc). There's no "play for everyone" yet.
- No audio export yet.

## Ideas / next steps

1. **Export to WAV** (render with an `OfflineAudioContext`).
2. **Sample upload**: content-addressed files stored once on the server, so every
   collaborator gets the same sound.
3. **Effects**: per-channel reverb/delay/filter, and knobs for each instrument.
4. **Play together**: a shared transport so one person can say "listen to this".
5. **Web MIDI input**, so you can record from a real keyboard.
6. **FL Studio project import**: the .flp format is largely community-documented,
   so a "bring your FL beat into a shared room" importer is realistic.
7. Accounts, a project list, and read-only share links.
