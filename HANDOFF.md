# coprod — handoff

Read this first, then `README.md`. Written at commit `98c4de1`; the "Since `98c4de1`" section below covers what was added after.

## 1. Goal / objective

A **real-time collaborative beat maker in the browser** ("multiplayer FL Studio").
Everyone with the room link edits the same project live: channel rack, piano
roll, patterns/song, plugins, automation. We chose this over reverse-engineering
or cloning FL Studio itself: decompiling FL is legally risky and FL has no
collaboration hooks.

Long-term direction the owner has expressed:
- An Ableton-style workflow where you can draw pitch along each note's length
  (per-note pitch curves). **This is the next feature** (see Next steps).
- A plugin story close to VSTs: we bundle WAM 2.0 web plugins, plus Dexed
  ported to WASM and Vertex, our own Serum-like wavetable synth.

## 2. Current state

- Repo `U7U-Pro/coprod`, branch **`main`**, HEAD `98c4de1 Add FL-style automation curves`.
  Working tree clean and pushed (except this file).
- Milestone: **working prototype, feature-rich, not deployed**. No accounts.
  Rooms are "anyone with the link". Data is stored on disk on the server.
- Last verification: `npm test` passed 44 of 44 tests. `npm run e2e` passed about 41 steps in headless Chromium.
- Commit history:
  1. `4956682` prototype (Yjs sync, rack, piano roll, patterns/song, 11 built-in synth instruments)
  2. `35460fb` sample upload + WAM plugin hosting (instruments + FX chain, trust-per-origin)
  3. `a0f36d3` Dexed (DX7) compiled to WebAssembly as a bundled WAM
  4. `a7920b0` Vertex wavetable synth + automation lanes
  5. `e3bbbbb` Vertex user presets + WAV export
  6. `cf0fc4f` pitch bend lanes
  7. `98c4de1` FL-style automation curves (right-click menu, tension handles)

### Commands
```bash
npm install
npm run dev          # Vite on :5173 + sync server on :3001 (scripts/dev.mjs; vite.config.js proxies /ws /api /samples)
npm run build && npm start   # serves dist/ + websocket on $PORT (default 3000); data in $COPROD_DATA (default ./data)
npm test             # node --test "test/*.test.js"   (NOT `node --test test/`, which fails on Node 22)
npm run build && npm run e2e   # e2e serves dist/ from its own server on a random port; needs Chromium:
                     # CHROMIUM_PATH=/path/to/chrome npm run e2e   (screenshots -> e2e-shots/, gitignored)
sh plugins/dexed/build.sh    # rebuild public/wam/dexed/dexed.wasm (see Dexed below)
```

## Since `98c4de1` (Windows dev session)

- **Dev on Windows fixed:** `scripts/dev.mjs` spawned through a shell, and `C:Program Files
odejs
ode.exe` broke it. It now runs `node` and Vite's `bin/vite.js` directly, and refuses to start on Node older than 20.19 / 22.12 (Vite 8 / rolldown crash there with an unhelpful error). After upgrading Node, run `npm install` again: on Node 18 npm silently skipped rolldown's native binding.
- **Server crash fixed:** with no `dist/`, `GET /` on the sync server wrote headers twice (`ERR_HTTP_HEADERS_SENT`) and died.
- **Plugin browser** (Add channel → Plugins, and "Browse all effects…" in the FX panel): one list of the bundled plugins plus the [WAM community registry](https://www.webaudiomodules.com/community/plugins.json) (40 instruments and effects, fetched live; the registry and plugins are served with CORS `*`). Filter chips, search, and an "Effects go on: [channel]" picker. All 42 registry instruments and effects were loaded in coprod's host; all but "Pedalboard WAC2022" (its files 404) worked. Skipped on purpose: Audio Input (asks everyone for the mic), Audio Track (state too big), and the MIDI, modulation and video plugins (they need sequencer.party extensions, `SharedArrayBuffer` or plugin-to-plugin event routing).
- **Slicer** (`public/wam/slicer/`): a Slicex-style beat slicer. **Grains** (`public/wam/grains/`): a granular synth. Both share `public/wam/kit/`. Audio is uploaded to coprod's sample store, and state is `{ v, sample: {id, name} | null, slices?, params }`. With no file, each uses a deterministic synthesized demo sound, so collaborators match without syncing anything. Slicer maps slice n to MIDI 60 + n (the step grid plays slice 1), with at most 36 slices.
- **`coprod:notes` DOM event:** a plugin GUI can dispatch it (bubbling, cancelable, `detail.notes = [{p, s, l}]`). `ChannelPanel` replaces that channel's notes in the current pattern, growing it to 2 or 4 bars as needed.
- **Tests:** `test/samplers.test.js` (15 tests: slicing, hit detection, pitch, fit to tempo, choke, gate, pan law, declicking, grain position, pitch, level and stability). The e2e has 5 more steps (Slicer demo, dropping a loop, To piano roll, Grains playing, position sync). On Windows the e2e runs with Edge: `CHROMIUM_PATH="C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"`. Its screenshot path now uses `fileURLToPath`, so it works on Windows too.

## 3. Files

Everything was created in this project; nothing pre-existed. About 7.8k lines of JS
in src/, server/ and Vertex.

| Path | What it is |
|---|---|
| `index.html` | App shell: header/transport, pattern tabs, rack, channel panel, automation panel, piano roll, song strip, modals (welcome, export, plugin picker) |
| `src/main.js` | Glue: Yjs doc + y-websocket provider, awareness/presence, UndoManager (per-user), UI wiring, keyboard shortcuts |
| `src/shared/schema.js` | **The data model.** All doc mutations go through its exported functions (addChannel, setStep, addNote, addLane, setPoint, setCurve, setPluginState, addEffect…). Also sanitizes input from the network: TARGET regex, cleanPluginUrl, MAX_PLUGIN_STATE. Shared by client and server (seedProject). `readProject(doc)` → plain JS snapshot |
| `src/audio.js` | `Engine`: look-ahead scheduler, per-channel bus (vol/pan/bend ConstantSource → detune), sample decoding, plugin nodes, `scheduleAutomation`, master compressor |
| `src/instruments.js` | 11 synthesized built-ins + sample playback; `setBend(node)` connects bend to detune |
| `src/plugins.js` | WAM host (`@webaudiomodules/sdk` initializeWamHost), CATALOG of bundled plugins, per-origin trust in localStorage, `sendEvents` (MIDI/automation/transport) |
| `src/rack.js` | Channel rack UI (step grid painting, mute/solo, drag-drop samples) |
| `src/pianoroll.js` | Piano roll canvas (add/move/resize/delete notes, ghost notes) |
| `src/channelpanel.js` | Channel settings + embedded plugin GUI + FX chain. Syncs plugin state per key |
| `src/automation.js` | Automation lane editor: points, curve context menu `.ap-menu`, tension handles, touch long-press |
| `src/export.js` | `renderProject()`: offline render via `new Engine({context: OfflineAudioContext})` |
| `src/wav.js` | WAV encoder (16/24/32-float) |
| `src/style.css` | All styles |
| `server/index.js` | `startServer({port, dataDir})`: static dist/, `/ws` y-websocket protocol, `/api/samples` upload, `/samples/<sha256>` |
| `server/rooms.js` | `RoomManager`: loads/saves Y.Doc per room to `dataDir/rooms`, **buffers early ws messages until the room has loaded**, seeds new rooms |
| `server/samples.js` | Content-addressed sample store (sha256), magic-byte sniffing, 15 MB cap, `nosniff` |
| `public/wam/vertex/*` | Vertex synth. Files: params, wavetables (FFT mipmaps), engine (voices), fx, processor (AudioWorklet), index (WAM), gui, presets |
| `public/wam/dexed/*` | Dexed WAM. Files: index.js (WAM + DX7 editor GUI), processor.js, **dexed.wasm (committed binary, 70,671 B)**, `banks/*.syx` (33), LICENSE, README |
| `public/wam/slicer/*`, `public/wam/grains/*`, `public/wam/kit/*` | Slicer and Grains. Each has engine (plain JS, tested in Node), processor (worklet), index (WAM and state) and gui. The kit holds params, the base node and module, the processor wrapper, sample upload/decode, dsp (onsets and demo sounds) and ui (knobs, waveform, file bar) |
| `public/wam/coprod-acid`, `coprod-echo` | Small example WAMs (acid synth with 0xE0 bend ±2 st; echo delay) |
| `plugins/dexed/` | Dexed C++ source for the WASM build. Contents: `dexed_wasm.cpp` (C API), `shim/` (JUCE/Tunings/MTS stubs), `upstream/` (vendored msfa + engines + PluginFx, one include patched), `build.sh`, `UPSTREAM_COMMIT`, GPLv3 `LICENSE` |
| `test/*.test.js` | Tests: schema, server, wav, vertex (DSP measured offline), dexed (runs the wasm in Node) |
| `scripts/e2e.mjs` | Playwright-core e2e covering about 41 steps: two browsers, sync, plugins, Vertex, Dexed, automation, curves, bend, export |
| `scripts/dev.mjs`, `vite.config.js` | Dev runner + proxy |

### Data model (Yjs), quick reference
- Top-level maps and arrays: `meta`, `channels`, `patterns`, `song` (`undoScope(doc)` lists them).
- **Channel:** inst, vol, pan, mute, and optionally sample, plugin `{url}`, `pstate` (a Y.Map holding one JSON value per plugin-state key), and `fx` (a list of effects whose state is kept in `fxstate` under `"fxId/key"`).
- **Pattern:**
  - bars
  - steps per channel
  - notes `{p, s, l, v}`
  - lanes `{channel, target, range?, points}`
- **Lane target:** `vol`, `pan`, `bend`, `p:<paramId>` (plugin param) or `fx:<fxId>:<paramId>`.
- **Point:** `{s, v, c?, t?}`. `c` is one of the curve types (`single`, `double`, `hold`, `stairs`, `smooth`, `pulse`, `wave`) and `t` is the amount, from −1 to 1. Both are omitted when the curve is `single` with t=0.
- **Evaluation:** `laneValueAt(points, pos)`. The curve math is `curveShape(c, t, x)`.
- **Changing the model:** update the schema validator and `readProject`, and add a test in `test/schema.test.js`.

## 4. Completed and verified

- **Collaboration:**
  - Live sync over Yjs.
  - Presence (names, colors, who's editing what).
  - Per-user undo/redo.
  - Rooms persist on the server.
  - Late joiners get the full state.
- **Sequencing:**
  - Rack with step painting; piano roll; patterns of 1, 2 or 4 bars (clone/rename/delete); song strip.
  - Pattern and Song playback modes; BPM.
- **Samples:**
  - Drag-drop or upload; deduplicated by hash.
  - Every collaborator downloads the same bytes.
  - One-shot mode or keyed ("Sample (keys)").
- **WAM hosting:**
  - Plugin instruments plus an FX chain on any channel.
  - Plugin GUI shown in the panel; state synced per key, so two people can turn different knobs at once.
  - Load by URL, with a per-origin trust prompt for each collaborator.
- **Dexed:**
  - The real Dexed engine (msfa, MkI/OPL engines, filter) compiled to WASM, with its full bank library and a DX7-style editor.
  - Pitch accuracy verified, and all 32 factory voices make sound (test/dexed.test.js).
- **Vertex:**
  - Synth: 2 wavetable oscillators (unison up to 16, 8 warp modes), sub, noise, SVF filter, 3 envelopes, 4 LFOs with drawable shapes, 4 macros, drag-drop mod matrix.
  - Effects rack: 8 reorderable slots (dist, chorus, flanger, phaser, delay, reverb, comp/OTT, EQ).
  - Wavetable editor: draw, safe formula parser, audio import, morphing.
  - 13 presets; user presets saved in localStorage, plus import/export as files.
  - Pitch, aliasing, filter, LFO, glide, FX and presets were all measured in tests.
- **Automation:**
  - Lanes for vol, pan, bend, and any plugin or effect parameter.
  - Click to add, drag to move (Shift turns off snapping), double-click to delete.
  - FL-style curves: right-click opens the curve menu plus an amount slider; drag the mid-segment handle for tension; long-press on touch.
  - Exact values verified in exported audio (stairs produced 0/400/800/1200 cents exactly).
- **Pitch bend lane:**
  - Built-in instruments use their range setting (1, 2, 3, 5, 7, 12 or 24 semitones).
  - WAM plugins get 14-bit MIDI 0xE0 and use their own range.
  - Measured in an export: 441.7 Hz rose to 493.8 Hz.
- **WAV export:**
  - Song or pattern, with loop count, tail length and 16/24/32-float bit depth.
  - Offline render includes plugins (Vertex and Dexed).
  - The compressor latency is measured and trimmed, so the file is loop-aligned.

**Never verified:**
- Sound quality by ear.
- Real third-party WAMs from the internet (webaudiomodules.com was blocked in the build sandbox).
- Firefox and Safari.
- Real mobile devices (only emulated).
- Behavior under heavy multi-user load.

## 5. What didn't work / gotchas (don't repeat these)

### Repo and environment
- **GitHub repo creation from the agent failed with 403** ("Resource not accessible by integration"). The owner creates repos manually.
- **The build sandbox blocked many hosts:** webaudiomodules.com, jsdelivr and unpkg. That is why every plugin is bundled locally. For the trust test, a second origin was served locally.
- **`node --test test/` breaks on Node 22.** Use the glob form in `npm test`.

### Server and schema
- **Server hang:** the client's first sync message arrived before the room had loaded from disk. Fixed by buffering in `RoomManager.connect`; keep that code.
- **Clean shutdown needs three things:** unref'd timers, `close({force})` in `closeAll`, and tests calling `doc.destroy()` (the awareness interval keeps Node alive).
- **Yjs gotchas:**
  - `Y.Doc.toJSON()` only includes types that have been accessed, so compare docs via `undoScope`.
  - Remote updates need the origin `'remote'`, otherwise UndoManager captures them.
  - A prelim Y.Map must be inserted into the doc before it is filled (see `clonePattern`).

### Dexed WASM build
- **Requirements:**
  - clang `--target=wasm32-wasi -mexec-model=reactor`.
  - Ubuntu packages: `clang lld wasi-libc libc++-18-dev-wasm32 libc++abi-18-dev-wasm32 libclang-rt-18-dev-wasm32`.
- **Errors hit and fixes:**
  - `PluginFx.h` included JuceHeader. It is patched to `shim/juce_shim.h`.
  - libc++ `operator new` pulled in `__cxa_allocate_exception` and `__cxa_throw`. Trap stubs were added.
  - `--export-dynamic` exported far too much. Use the explicit `-Wl,--export=dexed_*` list in build.sh.
- **No automatable parameters yet:** Dexed exposes none (no `getParameterInfo` entries).

### Vertex performance
- Template-string parameter lookups in the hot path were slow. They were replaced with precomputed index tables (OSC/ENV/LFO/MACRO/FX_ON).
- Per-unison block loops and a block-rate amp envelope took a heavy patch from about 380 ms to about 230 ms per second of audio. It is still CPU-heavy: about ¼ core for 8 voices × 2 osc × 7 unison plus FX.

### Vertex bugs already fixed (don't reintroduce)
- Poly read from an empty `eff` array.
- Mirror warp formula.
- Even-unison "blend" went silent.
- The formula parser accepted `constructor` (it now uses `Object.hasOwn`).
- OTT allocated memory per sample.

### Tests
- A one-pole HP "brightness" metric leaked low frequencies. Use the harmonic Goertzel `brightness()`.
- The LFO test was flaky until it was made robust.
- In Dexed tests, the pitch-detect helper must take the **first strong** autocorrelation peak.

### GUI
- Polling plugin state during playback captured automation values as "user edits". Polling is off while playing, and automation overrides are kept separate from base state.
- Rebuilding the channel panel cancelled knob drags. `ChannelPanel.render` now checks a signature first.
- Editor knob registrations leaked. They are now scoped.

### WAV export
- A 50 ms lead-in broke loop alignment (lead is 0 now).
- The master compressor's look-ahead (about 6 ms in Chrome) is measured and trimmed.
- Plugin worklets need about **150 ms** after `engine.ready()` before `startRendering`, or Vertex and Dexed render silence.

### e2e
- HTML5 drag-and-drop needs both elements visible, so that step uses a tall viewport.
- Knobs need `scrollIntoViewIfNeeded()`.
- Earlier automation lanes silence later measurements. The bend test removes lanes first.

## 6. Known limitations

- **Automation timing:** Acid and Echo apply automation about 0.1 s early (event-based, not sample-accurate).
- **Pitch bend:** the bend lane bends the **whole channel**, not individual notes.
- **Plugin state:** states that aren't plain JSON won't sync. Each key is capped at 256 KB, and only the oversized key is dropped.
- **Vertex presets:** user presets are per browser (localStorage).
- **Uploads:** rate limited per IP, with no storage quota or garbage collection of unused samples.
- **Rooms:** no auth. Anyone with the link can edit.
- **Licensing:** **Dexed is GPLv3.** Distributing coprod with it means publishing `plugins/dexed` source (already in the repo) and keeping its LICENSE. Factor this into any closed-source or monetization plan, or drop Dexed.

## 7. Next steps (priority order)

1. **Ableton-style per-note pitch curves.** The owner asked for this explicitly and deferred it ("we can tackle the slides later"). Draw the pitch of each note along its length in the piano roll.
   - **Data:** add an optional `pb: [{x, v}]` per note (x from 0 to 1 along the note, v in semitones). Validate it in schema.js and give it the same CRDT treatment as lanes. Reuse `curveShape` for segments.
   - **Audio for built-ins:** schedule per-voice `detune` automation.
   - **Audio for WAMs:** per-note bend needs MPE (one channel per note), or else falls back to channel bend when notes don't overlap. Check what Vertex can support: it is our code, so it could accept per-note pitch directly via a custom event.
   - **UI:** a pitch-edit mode in `src/pianoroll.js` that draws over the note.
   - **Tests:** a schema test and an export-measured pitch test, like the bend lane test.
2. **Deploy.** Use any Node host with persistent disk and websockets (Render or Fly). AudioWorklets require HTTPS. Set `PORT` and `COPROD_DATA`.
3. **Expose Dexed parameters** (`getParameterInfo`) so they can be automated.
4. **More automation features:**
   - Record automation from knob moves.
   - Song-level automation that spans patterns.
5. **More export formats:** stems per channel, MP3 or OGG.
6. **Vertex performance:**
   - A WASM or SIMD engine.
   - Live modulation display on the knobs.
7. **Shared transport ("play for everyone")**, plus a chat or follow cursor.
8. **Later:**
   - Web MIDI input.
   - Accounts and private rooms.
   - Sample garbage collection and quotas.
   - A desktop VST3/CLAP companion that lets the plugin owner render for everyone.
   - FLP import.

### Ground rules from the owner and environment
- Work on `main`. The repo was empty, and the owner has accepted direct pushes.
- Don't open PRs unless asked.
- Before pushing, run `npm test`. Also run `npm run build && npm run e2e` when the UI changes.
