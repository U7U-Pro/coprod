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
  (per-note pitch curves). **Done** ("Slide" mode, see the editing round below).
- FL Studio parity where it counts: free arrangement, selection and copy/paste,
  fine note positions, any pattern length.
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
- **Vocalist** (`public/wam/vocalist/`): a singing synth. Klatt-style formant synthesis with an LF glottal source (Rd from 0.4 to 2.8, band-limited via Vertex's `buildMips`), breath noise gated by the glottal open phase, a nasal pole/zero, 5 cascaded formants, a frication branch and a singer's-formant peak. Text goes through the dictionary (`lexicon.js`, ~900 words), then suffixes on dictionary stems, then NRL-style rules (`g2p.js`), then maximal-onset syllables (`lyrics.js`). Notes carry `ly`/`ph` (schema `cleanNote`, `setLyric`, `assignLyrics`). The host sends lyrics as SysEx `F0 7D 4C 59 note text F7` before note-on (`lyricEvent` in `src/plugins.js`).
  - **Look-ahead:** the kit processor hands note and lyric events to `engine.enqueue()` as they arrive, so the engine starts consonants up to 90 ms before the beat. That limit comes from the host's 0.12 s scheduler look-ahead. Pre-utterance takes at most 40% of the previous note, and vowels keep at least 55% of their note.
  - **Piano roll:** "✎ Lyrics" mode (or Alt+click) opens an inline editor. Tab moves to the next note, and several words fill the following notes. Notes show their syllable. Previews sing a note's own syllable.
  - **Tests:** `test/vocalist.test.js` (16: g2p, syllables, wire format, pitch, formant regions, Formant/Breathiness effects, pre-utterance timing, codas, melisma, stop, stability, speed) and 3 schema tests. The e2e has 4 more steps: lyrics to notes for both users, roll editing, playback phonemes, and the exported WAV.
  - **Gotchas:**
    - The in-app browser pane stops firing requestAnimationFrame when Claude's window is in the background, so coprod's UI doesn't update there. Use the e2e (headless) for UI checks.
    - The e2e serves `dist/`, so the page can't `import('/src/...')`. Drive the real UI instead (e.g. the Export dialog).
    - When editing files from a `node -e`/heredoc script, regex backslashes inside template literals get eaten (`/\s+/` turned into `/s+/`). Prefer the Edit tool for code containing backslashes.
    - Big heredocs through the Bash tool sometimes fail with "unexpected EOF while looking for matching `'`". Write the script with the Write tool into the scratchpad and run `node script.cjs` instead.

## Accounts round: sign-in, home screen, friends, chat, profiles, .copr files

Branch `claude/user-system-session-persistence-1kkg7v`. Rooms now need an account. Covered by `test/accounts.test.js` (9 tests), `test/copr.test.js` (7) and the updated `test/server.test.js`. Last verification: see the end of this section.

- **Accounts** (`server/db.js`, `server/auth.js`): **username + password, no email** (the owner dropped email: maybe later, for pricing tiers). Passwords are scrypt N=16384, salted (`scrypt$N$r$p$salt$key`). Each account has a display name (≤32 chars, shown in full on profiles), a unique `@username` (`[a-z0-9_]{3,20}`, stored lowercase; `guest_*` is reserved), a color and a bio (≤160). Sessions: a random token in an HttpOnly, SameSite=Lax cookie `coprod_session` (Secure on HTTPS or `x-forwarded-proto: https`); only its SHA-256 is stored; 30 days, renewed as used (`GET /api/me` re-sets the cookie). A password change ends every other session. Login failures are limited per address+username and per username; unknown usernames and guests do a decoy hash so timing gives nothing away. `scripts/reset-password.mjs <username>` resets a password with the server stopped. Accounts saved by the brief email version load fine (their `email` is dropped on load).
- **Guests** (`POST /api/auth/guest {name?, color?}`): real accounts with `guest: true`, `pass: null` and a `guest_xxxxxx` username, so presence and chat stamping work unchanged. They can't send or receive friend requests, aren't in search, can't change their username or password, and are flagged `guest: true` in `publicUser` and the room badge. `POST /api/auth/upgrade {username, password, name?}` makes one a full account with the same id, so projects, chat and memberships carry over. Logout deletes a guest (`db.deleteUser` clears sessions, friends, requests and project memberships, and drops projects nobody is left in). `db.pruneGuests()` removes guests with no live session, at startup and hourly. Guest creation is limited to 60 per address per hour.
- **Storage:** `data/coprod.json` holds users, sessions, friends, requests and the project index (who has opened which room). It's kept in memory and written atomically 200 ms after changes. A damaged file stops the server rather than being overwritten. Collections are Maps in memory (room ids like `__proto__` are valid room names, so no plain-object keys).
- **CSRF / sockets:** every non-GET `/api` request and both WebSocket upgrades must have no `Origin` or one matching `Host`. Vite's string proxy shorthand sets `changeOrigin: true` (rewrites Host), so `vite.config.js` now sets `changeOrigin: false` for `/api` and proxies `/live` too. `/ws/<room>` and `/live` answer 401 without a session.
- **Identity in rooms:** `Room` writes `state.user = { id, name, username, color }` from the account into every awareness update it receives (`badge()`), so a client can't appear as someone else. Uploads (`/api/samples`) need a session and are rate-limited per account, not per IP (the old IP limit lumped everyone behind cloudflared together).
- **Presence:** `RoomManager` is an EventEmitter: `visit` (every connection: records the project in your list), `join`/`leave` (first and last connection of a person, with a 4 s leave grace so reconnects and reloads don't flap), and `saved`. `api.js` keeps `where` (user → rooms) and `live` (user → /live sockets). Status is `session` (with room, title, who's there), `online`, or `offline` (with `seen`).
- **Live socket** `/live` (server → client JSON): `hello`, `friends` (refetch `/api/friends`), `request {from}`, `accepted {by}`, `invite {from, room, title}`. The client (`src/api.js` `live`) reconnects with backoff. Open profile cards and the invite list refresh on `friends`.
- **Chat:** message type `MSG_CHAT = 100` on the room's y-websocket (`provider.messageHandlers[100]`), with JSON both ways. Client → server: `hello` (subscribe; the reply is `history`) and `say {text}`. Server → client: `history`, `message`, `notice` (join/leave, not stored) and `error` (rate limit: 8 per 10 s per person). Only clients that said hello get chat traffic, so plain y-websocket clients (tests) never see type 100. The last 300 messages are kept in `rooms/<id>.chat.json`, at most 1000 characters each. The typing indicator is awareness field `typing` (a timestamp).
- **API:** `POST /api/auth/{signup,login,guest,upgrade,logout}`, `GET|PATCH /api/me` (GET answers `{user:null}` when signed out, so the browser logs no 401), `POST /api/me/password`, `GET /api/users?q=`, `GET /api/users/:id` (relation `self|friends|requested|incoming|none`, `together`, `mutual`, and presence for friends), `GET|POST /api/friends`, `POST /api/friends/:id/{accept,decline}`, `DELETE /api/friends/:id`, `POST /api/invites`, `GET|POST /api/projects`, `DELETE /api/projects/:id` (hide from my list), `GET /api/projects/:id/export`, `POST /api/projects/import`.
- **.copr** (`server/copr.js`): a zip (UTF-8 names; deflate unless it saves <3%) of `manifest.json` (`format: "coprod-project"`, `version: 1`), `project.ydoc` (`Y.encodeStateAsUpdate`) and `samples/<sha256>.<ext>`. Samples are found by walking every channel field for 64-hex strings, so plugin-held samples (Slicer, Grains) are included. Import always creates a new room (`RoomManager.create` applies the update before `seedProject`, which then no-ops). Sizes are checked before inflating (`maxOutputLength`) and CRCs after. Export is allowed for members only. The standard `unzip` reads the files (tested).
- **Client:** `src/app.js` is the entry now (index.html loads it): `/api/me`, then `signin.js`, `home.js` or `import('./main.js')` (the session is a lazy chunk). Going home → room is a `pushState` (keeps user activation, so audio can start; `main.js` also unlocks on the first pointerdown/keydown, replacing the old welcome modal). Room → anything is a full page load. The session markup is wrapped in `#roomScreen` with `display: contents`. `src/ui.js` has the shared `el`, `face`, `toast`, `notify` (action cards) and `dismissable`.
- **In-session extras:** profile cards (Go to them, Follow, @ Mention), follow mode (`ui.following`; stops when you pick a pattern yourself, on Esc, or when they leave; awareness now carries `roll`), the Invite modal (online friends get a live invite), Export → Download .copr, Ctrl+S (downloads a .copr), and dropping a `.copr` on the page.
- **e2e:** `join_()` signs up through the invite link (username + password); `joinAsGuest()` uses Continue as guest. New steps cover profile and friending, chat with mentions, the home screen (the project, who's in it, a friend's Join), Follow, and a .copr save-and-reopen. The console-error filter now ignores failed loads from non-local URLs (fonts and the WAM registry are unreachable in sandboxes).
- **Verification (after the guest round):** `npm test` 101/101 (accounts 11, including guests and loading email-era data; copr 7). `npm run e2e` 64 steps in headless Chromium: Ana and Ben sign up with username + password, and Cara joins as a guest and then creates an account from her profile card. A manual run through `npm run dev` (the Vite proxy) was done in the first round.
- **Gotchas:** `pkill -f <pattern>` inside a Bash tool command kills its own shell (the pattern is in its command line). With a leave grace, a quick reconnect produces no `join`, which is why project-list updates hang off `visit`. Profile cards must re-render on live events: the e2e caught a card stuck on "request sent".

## Editing round: arrangement, selection, slides, fine notes, any length

- **Arrangement (`clips` Y.Map):** `{ p, t, s, l? }` (pattern, track 0..31, start step, optional length; longer than the pattern loops it). Song mode schedules every clip under the playhead each step (`clipsAt`), and loops at `songLength`. Pattern mode is unchanged. `marks` are now `{ time, songStep, active: [{ patternId, step }] }`; the UI shows the playhead of the pattern you're viewing wherever it plays. Song mode no longer switches the viewed pattern.
  - **Migration:** the old `song` Y.Array is shown as clips `song0..n` on track 0 without writing. The first arrangement edit converts it (deterministic ids, so concurrent converters don't duplicate) and empties `song`. If two people's first edits race, one move can lose to the conversion (tested and documented).
  - **UI** in `src/playlist.js`: canvas, click to paint the current pattern, drag, edge-resize, right-click delete, click to edit a pattern, Ctrl+drag select, ruler sets "play from" (per user, `ui.songStart`), Ctrl+wheel zoom.
- **Patterns:** any length 1..`MAX_BARS` (64). `addNotes`/`updateNotes` grow the pattern to fit (`growTo`), so writing in the roll's extra bar adds a bar. `setNotes` and `assignLyrics` also grow without the old 4-bar cap.
- **Notes:** `s` and `l` are kept to 1/`TICKS` (1/24) of a step via `tick()`. The scheduler indexes notes by `floor(s)` and offsets their time within the step. Batch ops: `addNotes`, `updateNotes`, `removeNotes` (one transaction each, so one undo step). Points: `updatePoints`, `removePoints`, `pastePoints` (which replaces the target lane's points across the pasted span).
- **Slides:** `pb: [[x 0..1, semitones ±SLIDE_RANGE]]`, linear between points and held at the ends (`slideAt`); flat slides are dropped by `cleanSlide`.
  - Built-in instruments get detune ramps through `setSlide`/`play()` in `instruments.js`, and samples through `applySlide`.
  - WAMs with `descriptor.notePitch` get SysEx `F0 7D 4E 50 note msb lsb F7` (cents + 8192) every 10 ms where the value changes: Vertex, Acid, and the kit plugins Slicer, Grains and Vocalist. Others get channel pitch bend assuming ±2 st.
- **Editors:** a shared `src/clipboard.js` (kinds `notes`, `points`, `clips`). The piano roll, automation panel and playlist each have a `sel` Set and a `key(e)` method; main.js routes Delete, Ctrl+C/X/V/A/B and Esc to the editor last clicked (`ui.active`). The piano roll has modes `notes`, `lyrics` and `slide`, and Alt-drag gives fine move/resize (Alt+click without moving still opens the lyric editor).
- **Pattern instruments (decision):** channels stay global, like FL's channel rack. A per-person **Hide unused** view hides channels with nothing in the current pattern; it has no shared state, so it can't desync.
- **Tests:** schema +6 (growth, fine positions and slides, batch ops and undo, arrangement, song migration race, point paste). The e2e has 9 more steps: box select plus copy/paste across patterns, growing by writing past the end, an Alt fine move, drawing a slide, slide audio on built-in Keys (rendered offline in the page via `engine.constructor`) and on Vertex (exported WAV), two patterns at once plus a gap in Song mode, and automation copy/paste between lanes.

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
- **Audio export (WAV, MP3, OGG):**
  - Song or pattern, with loop count and tail length; WAV 16/24/32-float, MP3 CBR 320/256/192/128, OGG Vorbis q8/q6/q4 (`src/formats.js`; encoding in `src/encode-worker.js`).
  - Offline render includes plugins (Vertex and Dexed), after a 2 s warm-up, with live-like sliced scheduling (see "Audio export" under gotchas).
  - Progress (loading, rendering with time left, encoding) and Cancel. Export stops playback and flushes pending plugin state first (`ChannelPanel.flush`).
  - The compressor latency is measured and trimmed, so WAV and OGG files are loop-aligned (MP3 has encoder delay).

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

### Audio export
- A 50 ms lead-in broke loop alignment. Now a 2 s warm-up (a whole number of render quanta) is rendered first and cut off together with the compressor delay, so beat 1 is still at sample 0.
- The master compressor's look-ahead (about 6 ms in Chrome) is measured and trimmed.
- Plugin worklets need about **150 ms** after the plugins load before `startRendering`, or Vertex and Dexed render silence.
- **Cold plugins (fixed):** a fresh plugin glides its knobs from their defaults. Grey Hole's Faust `si.smooth(0.9999)` on delayTime and size sweeps from 0 for about 1 s at 0.9 feedback, so the old export (music at frame 0) piled up and the master compressor then ducked the whole song. Measured with Grey Hole on Keys: +3.3 dB on beat 1 and −2.7 dB on beat 4 before; within 0.5 dB on every beat after. Built-ins alone were −2.5 dB on beat 1 (the bus-gain glide); now +0.4.
- **Everything up front (fixed):** the old export scheduled the whole song before rendering, which blocked the page on long songs and fed timestamp-ignoring plugins every event at once. Now `OfflineAudioContext.suspend()` runs every 0.1 s of render time and schedules the next slice 0.05 s ahead, like playback. That's about 2,500 suspends for 4 minutes, cheap: 4 min with Vertex, Dexed and Acid renders in about 8 s here. Without `suspend()` it falls back to scheduling everything up front, with no progress.
- **`.wasm` MIME type:** the server sent `.wasm` as octet-stream, and `WebAssembly.compileStreaming` refuses that, so MP3/OGG export failed in production builds (Vite dev was fine). The server now sends `application/wasm`, and the worker fetches the bytes itself, so a misconfigured host still works.
- **MP3 is CBR only:** wasm-media-encoders writes no Xing/Info header, and without one, players misreport a VBR file's length.
- **Grey Hole from npm:** `npm pack wam-community` has the community plugins. Its `sdk-parammgr/src/sdk` is a missing symlink to `utils/sdk`, so a local test server must map it (the hosted site has it).

### e2e
- HTML5 drag-and-drop needs both elements visible, so that step uses a tall viewport.
- Knobs need `scrollIntoViewIfNeeded()`.
- Earlier automation lanes silence later measurements. The bend test removes lanes first.

## 6. Known limitations

- **Automation timing:** Acid and Echo apply automation about 0.1 s early (event-based, not sample-accurate).
- **Pitch bend:** the bend lane bends the **whole channel**; per-note bends are slides (`pb`). Slides on Dexed and third-party plugins fall back to channel pitch bend assuming ±2 semitones.
- **Plugin state:** states that aren't plain JSON won't sync. Each key is capped at 256 KB, and only the oversized key is dropped.
- **Vertex presets:** user presets are per browser (localStorage).
- **Uploads:** rate limited per IP, with no storage quota or garbage collection of unused samples.
- **Rooms:** no auth. Anyone with the link can edit.
- **Licensing:** **Dexed is GPLv3.** Distributing coprod with it means publishing `plugins/dexed` source (already in the repo) and keeping its LICENSE. Factor this into any closed-source or monetization plan, or drop Dexed.

## 7. Next steps (priority order)

1. **Automation clips in the arrangement** (song-level automation spanning patterns). Today automation lives in patterns; overlapping clips that automate the same knob fight (last scheduled wins).
2. **Deploy.** (The owner has tested with friends through a Cloudflare quick tunnel: `npm run build && npm start`, then `cloudflared tunnel --url http://localhost:3000`.) Use any Node host with persistent disk and websockets (Render or Fly). AudioWorklets require HTTPS. Set `PORT` and `COPROD_DATA`.
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
