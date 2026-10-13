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
- **Your own samples**: drop audio files (wav, mp3, ogg, flac, m4a, up to 15 MB) on the
  page for new channels, or on a channel to replace its sound. Play them as one-shots
  on the step grid or pitched from the piano roll ("Sample (keys)"). Each file is
  uploaded once and every collaborator downloads the same bytes.
- **Plugins** ([Web Audio Modules 2.0](https://www.webaudiomodules.com/)): add plugin
  instruments and stack plugin effects on any channel (the **FX** button). The plugin's
  own interface appears in the channel panel, and turning its knobs updates everyone's
  copy. Bundled:
  - **Vertex**, a wavetable synth built for coprod: two wavetable oscillators (up to
    16-voice unison, 8 warp modes), sub and noise, a multimode filter, 3 envelopes,
    4 LFOs (with drawable shapes), 4 macros, a drag-and-drop modulation matrix, an
    8-slot reorderable effects rack (distortion, chorus, flanger, phaser, delay,
    reverb, compressor/OTT-style multiband, EQ), 13 presets, and a wavetable editor
    (draw frames, safe math formulas, import audio, crossfade/spectral morphing).
    **Save** your own presets (kept in your browser, usable in every project), and
    **Export**/**Import** them as files to share.
  - **Dexed**, the open-source DX7 emulator compiled to WebAssembly, with its
    1,000+ voices.
  - Small **Acid** synth and **Echo** delay examples.

  Any WAM can be added by URL.
- **Automation**: the **A** button on a channel opens lanes for this pattern:
  volume, pan, or any parameter of the channel's plugin or effects. Click to add
  points, drag to move. Lanes are part of the shared project, so everyone hears them
  when they press play; when playback stops, knobs go back to their saved values.
- **Multiplayer**: live edits, avatars, colored name tags on the channel each
  person is working on, live cursors in the piano roll, dots on the pattern tabs
  showing who's where.
- **Undo/redo is per person**: Ctrl+Z undoes *your* last edit, never someone else's.
- **Offline-tolerant**: if your connection drops you can keep editing; changes
  merge when you reconnect.
- **WAV export** (top bar): the song or the current pattern (looped 1-8 times),
  with an optional tail for reverb, as 16-bit, 24-bit or 32-bit float. It renders
  offline (faster than real time) with fresh copies of every plugin, so it sounds
  like playback. Mutes and your solos apply; files start exactly on the beat, so a
  tail-less pattern export loops cleanly.
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
- `src/audio.js`: look-ahead scheduler, mixer buses, playhead, sample playback,
  plugin instruments (driven with MIDI events) and per-channel effect chains.
- `src/plugins.js`: loading WAM plugins, and the per-person "allow this site" list.
- `src/channelpanel.js`: the FX panel; mounts plugin GUIs and shares their settings.
- `public/wam/`: the bundled plugins, written against the plain WAM interface.
- `public/wam/vertex/`: the wavetable synth. `engine.js` (voices, oscillators,
  filter, modulation) and `fx.js` are plain JS that run both in the audio worklet and
  in Node tests; `wavetables.js` builds band-limited mipmaps so high notes don't
  alias; `gui.js` is the interface.
- `src/automation.js`: the automation lane editor; lanes are scheduled in `audio.js`.
- `src/export.js`, `src/wav.js`: offline rendering and WAV encoding.
- `plugins/dexed/`: the Dexed port: Dexed's engine source (GPLv3), the small shims
  that replace JUCE, a C interface (`dexed_wasm.cpp`), and `build.sh` to rebuild
  `public/wam/dexed/dexed.wasm` with clang's WebAssembly target. **Dexed is GPLv3**:
  if you publish coprod with Dexed in it, publish this folder's source too.
- `server/samples.js`: sample upload/download, stored by SHA-256 of the file.
- `src/instruments.js`: the synthesized instruments.
- `src/rack.js`, `src/pianoroll.js`, `src/main.js`: the UI.
- `server/rooms.js`: a small y-websocket-compatible sync server with persistence.

### Plugins and safety

A WAM plugin is JavaScript loaded from a URL, so loading one runs that code in your
browser with the same access coprod has. So:

- Plugins served by coprod itself load automatically.
- A plugin from any other site only loads for you after **you** allow that site
  (remembered in your browser). A collaborator adding one is never enough: you
  see a warning in the FX panel and an "Allow plugins from …" button.
- Whoever adds a plugin by URL has chosen it, so it's allowed for them.

Plugin settings are shared as the plugin's `getState()` JSON, stored per top-level
key (up to 256 KB each), so turning one knob only sends the part that changed, not
e.g. a synth's custom wavetables. Plugins whose state isn't plain JSON won't sync
their knobs yet.

## Tests

```bash
npm test                      # merge/conflict behavior + server sync & persistence
npm run build && npm run e2e  # three real browsers editing one room, incl. samples, plugins
                              # and the plugin-safety prompt (needs Chromium;
                              # set CHROMIUM_PATH if Playwright's isn't installed)
```

## Deploying

Any Node 20+ host with WebSocket support (Render, Railway, Fly.io, a VPS). Build
command `npm install && npm run build`, start command `npm start`. Point
`COPROD_DATA` at a persistent disk so rooms (`rooms/`) and uploaded samples
(`samples/`) survive redeploys. Serve it over HTTPS: browsers only allow the audio
worklets some plugins use on secure pages (localhost is fine for development).

## Known limits (it's a prototype)

- No accounts. Anyone with a room link can edit it, so treat links like a shared
  Google Doc's "anyone with the link" setting.
- Plugins are web plugins (WAM), not native VST/AU. Native plugins need a desktop
  app; see the plan below.
- Vertex is CPU-hungry at extremes (like any big wavetable synth): 8 voices with
  7-voice unison on both oscillators plus effects uses roughly a quarter of one core.
- Automation of the bundled Acid/Echo plugins is applied slightly ahead of time
  (they react when events are scheduled, up to ~0.1 s early); Vertex is sample-block
  accurate.
- Uploads are rate-limited per IP address but there's no storage quota yet, and
  behind a reverse proxy everyone shares one address.
- Each person's play button is independent (like each person scrolling their own
  copy of a doc). There's no "play for everyone" yet.
- No audio export yet.

## Ideas / next steps

1. **Pitch bend and slides**: a pitch-bend automation lane, and FL-style slide
   notes in the piano roll.
2. **A plugin browser** fed by the WAM community registry, plus more bundled
   plugins (a drum machine, a sampler with slicing).
3. **Vertex**: more warp modes, a WebAssembly/SIMD engine for more voices, and
   live modulation display on the knobs. **Export**: stems (one WAV per channel)
   and MP3.
4. **Play together**: a shared transport so one person can say "listen to this".
5. **Web MIDI input**, so you can record from a real keyboard.
6. **Native VST3/CLAP via a desktop companion** that joins the same rooms. For a
   plugin only some people own, the owner's machine renders that channel and
   shares the audio, so everyone hears it.
7. **FL Studio project import**: the .flp format is largely community-documented,
   so a "bring your FL beat into a shared room" importer is realistic.
8. Accounts, a project list, and read-only share links.
