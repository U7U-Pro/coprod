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

Create an account (a username and a password) or **Continue as guest**, then
**+ New project** gives you a fresh room with a starter beat. Press **Invite** and
send the link, or invite a friend directly; whoever opens the link signs in,
signs up or continues as a guest, and joins the same project.

Production:

```bash
npm run build
npm start          # serves dist/ and the sync socket on $PORT (default 3000)
```

## What's in the prototype

- **Accounts**: sign in with your **@username** and a password (no email). You
  pick a display name (shown in full on your profile), the username (how friends
  find you), a color and a short "about you". Sessions last 30 days and renew
  while you use coprod; changing your password signs you out everywhere else.
- **Guests**: **Continue as guest** needs only a name (or not even that). Guests
  can make and open projects, edit, play and chat, and their projects show on
  their home screen in that browser. They're marked "Guest" for everyone else,
  and can't add friends or be added. **Create account** (on a guest's own profile
  card, home screen or the invite dialog) turns them into a full account,
  keeping their projects. Signing out deletes a guest account (coprod asks
  first), and guests whose session has run out are cleared away.
- **Your projects** (the home screen at `/`): every project you've opened, newest
  first, with who else has worked on it and who's in it right now. Open one,
  download it as a **.copr** file, copy its invite link, or remove it from your
  list. **Open .copr…** (or dropping a .copr file on the page) opens a saved
  project as a new one.
- **Friends**: find people by @username or name and send a friend
  request. Requests, acceptances and invites pop up live on whatever screen
  you're on. Your friends list shows who's online, who's offline (and when they
  were last seen), and who's **in a session**, with the project's name, who
  they're with, and a **Join** button.
- **In a session**:
  - **Click anyone's avatar** (top right) for their profile card: full name,
    @username, about, when they joined, how many projects you've made together,
    mutual friends, and where they are right now ("on Pattern 2, in Bass's piano
    roll"). From there: **Add friend** (or accept, cancel, unfriend), **Go to
    them** (jump to their pattern and piano roll), **Follow** (your view follows
    theirs as they move around, until you pick a pattern yourself or press Stop),
    and **@ Mention** (starts a chat message to them). Your own avatar opens
    yours, with **Edit profile** and **Sign out**.
  - **Chat** (top bar): one chat per project, kept with it (the last 300
    messages). @mentions are highlighted and pop up if your chat is closed;
    there's an unread count, "Ana is typing…", join/leave notices, and links
    open in a new tab. Click a name for that person's profile.
  - **Invite** copies the link, and lists your friends with an **Invite** button
    for each one who's online: they get a pop-up with **Join**.
  - **Export → Download .copr** saves the whole project as a file (Ctrl+S does
    too). Everything also saves on the server as you go.
- **Channel rack**: drum channels with a step grid (click or drag to paint), synth
  channels with a mini preview of their notes. Per-channel volume, pan, mute
  (shared) and solo (just for you). **Hide unused** (just for you) hides channels
  with nothing in the current pattern.
- **Piano roll** for synth channels: click to add, drag to move, drag the end to
  resize, click a note to delete. Other synth channels show as faint ghost notes.
  - **Alt** while dragging moves or resizes freely, to 1/24 of a step (1/96 of a
    beat, like FL Studio). Notes play at their exact position.
  - **Ctrl+drag** draws a selection box (Ctrl+click adds or removes one note).
    Dragging a selected note moves or resizes them all. **Delete**,
    **Ctrl+C / Ctrl+X / Ctrl+V** (paste into any pattern or channel, at the same
    time), **Ctrl+A**, **Ctrl+B** (duplicate right after), **Esc**.
  - **〰 Slide** mode, Ableton-style: drag along a note to draw its pitch over its
    length, ±24 semitones (Shift draws a straight line, Alt gives 0.1 semitone
    steps). Drag a point to move it; right-click a point, or a note, to remove.
    Slides play on built-in synths and samples, per note on coprod's plugins,
    and as pitch bend on other plugins (within their bend range, usually
    ±2 semitones).
  - There's always an empty bar after the pattern: writing a note there makes the
    pattern a bar longer.
- **Patterns** of any length from 1 to 64 bars (add, clone, rename by
  double-clicking, delete).
- **Arrangement** (Song mode), FL-style: tracks of pattern clips placed anywhere.
  They can overlap (those patterns play together) and leave gaps. Click to place
  the current pattern (on the bar; Alt: the beat), drag to move, and drag a clip's
  end to stretch it, which loops the pattern. Right-click deletes, and clicking a
  clip opens its pattern. Ctrl+drag selects, with the same copy/paste/duplicate
  keys. Click the ruler to play from there; Ctrl+wheel zooms. Rooms from before
  the arrangement keep their song: it's laid out on the first track.
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
  - **Slicer**, a Slicex-style beat slicer. Drop a loop on it (or use its demo
    break): it's cut at the hits and fitted to the song's tempo. Slice 1 plays on
    C4, slice 2 on C#4 and so on, so the step grid triggers slice 1. Click a slice
    to hear it, double-click to add a cut, drag a cut to move it, right-click it to
    remove it, or re-cut by hits (with a sensitivity) or into 2-32 equal slices.
    Each slice has its own gain, pan, pitch and reverse. There are also an envelope,
    a resonant filter, and "play whole slice" vs "stop on note off" and "cut
    previous" vs "let ring" modes. **To piano roll** writes the notes that play the
    loop back in order.
  - **Grains**, a granular synth. Load any sound (or use its demo texture), click
    the waveform to choose where grains come from, and play notes. Position, scan
    (moves through the sound while a note is held), spray, grain size, density,
    jitter, window shape, pitch, random pitch, reverse amount and stereo spread are
    all automatable. The cloud is drawn live over the waveform.

    Both store their audio in coprod's sample store, so everyone in the room (and
    the WAV export) uses the same file.
  - **Vocalist**, a singing synthesizer. Type lyrics in its panel; **Put lyrics on
    notes** splits them into syllables and gives each of the channel's notes one,
    in time order. When there are more syllables than notes, it either splits
    long notes or adds notes after the last one. Words are split automatically
    (beau-ti-ful), or you can place hyphens yourself (to-mor-row). A lone `-`
    holds the previous syllable over the next note, and `[n ow]` gives exact
    phonemes. The piano roll shows each note's syllable; its **✎ Lyrics** mode
    (or Alt+click) lets you retype one note, with Tab to the next note, and
    several words fill the following notes. Voice knobs: Pitch, Formant,
    Breathiness, Lightness, Tension, Opening, Vibrato (depth, rate, delay),
    Glide, Scoop, Rough, Consonants, Attack, Release. There are presets from
    Soprano to Growl, and everything can be automated. Consonants start just
    before the beat so the vowel lands on it, the way singers do.
  - Small **Acid** synth and **Echo** delay examples.

  **Add channel → Plugins** opens one browser with every plugin: the bundled ones
  plus all the instruments and effects from the
  [WAM community registry](https://github.com/boourns/wam-community) (Synth-101,
  the DRM-16 drum sampler, a Soundfont player, Big Muff, Grey Hole and ~30 more
  pedals), searchable and filterable. Instruments get a new channel; effects go on
  the channel you pick. MIDI, modulation and video plugins from the registry aren't
  listed: they need host features coprod doesn't have (event routing between
  plugins, sequencer.party's extensions, cross-origin isolation). Any other WAM can
  be added by URL.
- **Automation**: the **A** button on a channel opens lanes for this pattern:
  volume, pan, **pitch bend**, or any parameter of the channel's plugin or effects.
  Bend lanes are drawn around a center line (snaps to "no bend"); plugins receive
  MIDI pitch bend (their own range setting applies, e.g. Vertex's Bend knob), and
  built-in synths and samples bend by a range you pick (±1 to ±24 semitones),
  including notes that are already sounding.
  **Curves**, FL Studio-style: right-click a segment (long-press on touch) to pick
  Single curve, Double curve, Hold, Stairs, Smooth stairs, Pulse or Wave, with an
  amount slider (tension, or number of steps/cycles); or drag the handle in the
  middle of a segment to bend it. Click to add
  points, drag to move. Lanes are part of the shared project, so everyone hears them
  when they press play; when playback stops, knobs go back to their saved values.
  Ctrl+drag selects points (dragging one moves them all). Ctrl+C / Ctrl+V copies
  them into any lane of any pattern, replacing what's there across that span.
  Delete, Ctrl+A, Ctrl+B and Esc work too.
- **Multiplayer**: live edits, avatars, colored name tags on the channel each
  person is working on, live cursors in the piano roll, dots on the pattern tabs
  showing who's where.
- **Undo/redo is per person**: Ctrl+Z undoes *your* last edit, never someone else's.
- **Offline-tolerant**: if your connection drops you can keep editing; changes
  merge when you reconnect.
- **Audio export** (top bar → Export): the song or the current pattern (looped
  1-8 times), with an optional tail for reverb, as **WAV** (16-bit, 24-bit or
  32-bit float), **MP3** (320, 256, 192 or 128 kbps) or **OGG Vorbis** (q8, q6,
  q4). The dialog remembers your format and estimates the file size.
  - It renders offline (usually much faster than real time) with fresh copies of
    every plugin. Each render starts with 2 seconds of silence that's cut off,
    so plugins settle (e.g. Grey Hole's delay glides in) before the music, the
    way they have by the time you press play. Notes and automation go out a
    slice at a time, a little ahead, exactly like playback. Measured: every beat
    of an export is within about half a decibel of what you hear.
  - A progress bar shows loading, rendering ("1:12 of 3:40 · about 40 s left")
    and encoding, and **Cancel** stops it. Encoding runs in the background, so
    the page never freezes. Starting an export stops playback and saves any
    plugin knob you just turned.
  - Mutes and your solos apply. WAV and OGG files start exactly on the beat, so a
    tail-less pattern export loops cleanly; every MP3 starts with a short
    silence (a few hundredths of a second, from the encoder).
- Space plays and stops; Esc closes the piano roll (or the chat, or stops following).

## Where projects are saved

Every project is saved on the server as you edit, about a second after each
change: the document is `data/rooms/<id>.ydoc` and its chat is
`data/rooms/<id>.chat.json`. Accounts, friends and who's been in which project
(which is what fills your projects list) are in `data/coprod.json`, and uploaded
samples are in `data/samples/`. Nothing is ever lost by closing the tab: open
the project again from your projects page.

### .copr project files

A **.copr** file is a whole project in one file, to keep as a backup, move to
another coprod server, or give to someone. Download one from **Export** in a
session or from a project's **⋯** menu on the home screen. Opening one (**Open
.copr…** or drop it on the projects page, or on a session) always makes a **new
project** owned by you; it never overwrites anything.

It's an ordinary zip archive (rename it to `.zip` to look inside):

```
manifest.json            format "coprod-project", version, title, tempo, channel and
                         pattern names, and the list of samples
project.ydoc             the shared document (Yjs): channels, patterns, notes, plugin
                         settings, automation, the arrangement
samples/<sha256>.<ext>   every uploaded sound the project uses, including ones kept in
                         plugin settings (Slicer's loop, Grains' sound)
```

Samples are named by the hash of their bytes, so a project opened on another
server finds its sounds, and opening the same file twice stores them once.
Files are checked when opened (size limits before unpacking, CRCs, the format
and version), and anything odd is refused with a message.

## How it works

The project is a [Yjs](https://yjs.dev) document (a CRDT): the same technology
behind Google-Docs-style editors. Edits are tiny messages, and any two sets of
concurrent edits merge to the same result on every machine, with no locking and
no "someone else is editing" errors. **Audio is never streamed.** Each browser
plays the shared project itself with the Web Audio API, scheduled ahead on the
audio clock so timing stays tight.

```
browser ── edits (Yjs updates) ──► server/rooms.js ──► every other browser in the room
   │       + chat (same socket)          │
   │                                     └─ saves each room to data/rooms/<room>.ydoc
   ├─ renders audio locally
   └─ /live socket ◄── server/api.js: friend requests, invites, friends' status
```

Both sockets need a signed-in session (an HttpOnly cookie), and the server
refuses them from other sites' pages. The server also writes each person's name
into their presence and chat messages from their account, so nobody can appear
as someone else.

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
- `public/wam/slicer/`, `public/wam/grains/`: the sample plugins. Each has an
  `engine.js` (plain JS, tested in Node), a `processor.js` (the audio worklet),
  `index.js` (the WAM and its shared state) and `gui.js`. They share
  `public/wam/kit/`: parameter tables, the worklet/event plumbing, sample
  upload/decoding, transient detection and the demo sounds.
- `public/wam/vocalist/`: the singing synth. `engine.js` is a Klatt-style formant
  synthesizer: an LF-model glottal pulse (`glottal.js`, band-limited with Vertex's
  mipmaps) with breath noise, a nasal pole/zero, five formant resonators and a
  frication branch, driven by per-phoneme targets (`phonemes.js`). `g2p.js` turns
  words into phonemes: the dictionary in `lexicon.js`, then regular suffixes on
  dictionary stems, then NRL-style letter-to-sound rules. `lyrics.js` splits them
  into syllables (maximal onset) and defines the lyric wire format.
- Notes can carry a lyric: `ly` (the syllable shown) and optionally `ph`
  (ARPAbet phonemes). The engine sends it to plugin instruments as MIDI SysEx just
  before the note-on: `F0 7D 4C 59 <note> <ASCII text> F7`, where the text is the
  word, or `/` followed by the phonemes. Plugins that don't sing ignore it.
- Plugin GUIs can hand notes to the channel with a bubbling `coprod:notes` DOM
  event (`{ notes: [{ p, s, l }] }`); Slicer's "To piano roll" uses it. Likewise
  `coprod:lyrics` (`{ syllables: [{ ly, ph }], fill }`) puts syllables on the
  channel's notes (`assignLyrics` in the schema).
- `src/automation.js`: the automation lane editor; lanes are scheduled in `audio.js`.
- `src/playlist.js`: the arrangement editor. In Song mode the scheduler plays every
  clip under the playhead each step (`clipsAt` in the schema). `src/clipboard.js` is
  the clipboard and selection helpers shared by the editors.
- Note slides reach plugins as SysEx before and during the note:
  `F0 7D 4E 50 <note> <msb> <lsb> F7`, the note's offset in cents + 8192. Plugins
  whose descriptor has `notePitch: true` (coprod's own) bend just that note; other
  plugins get channel pitch bend instead.
- `src/export.js`: offline rendering (warm-up, sliced scheduling, progress,
  cancel). `src/encode.js` (run in `src/encode-worker.js`): WAV (`src/wav.js`),
  MP3 and OGG encoding with the reference LAME and Vorbis encoders compiled to
  WebAssembly ([wasm-media-encoders](https://github.com/arseneyr/wasm-media-encoders)).
  Their `.wasm` files only download when someone exports in that format.
  **LAME is LGPL**: it ships as its own replaceable file (`mp3.wasm`). If you
  distribute coprod, keep it that way and point to its source (the
  wasm-media-encoders repository), like with Dexed below.
- `plugins/dexed/`: the Dexed port: Dexed's engine source (GPLv3), the small shims
  that replace JUCE, a C interface (`dexed_wasm.cpp`), and `build.sh` to rebuild
  `public/wam/dexed/dexed.wasm` with clang's WebAssembly target. **Dexed is GPLv3**:
  if you publish coprod with Dexed in it, publish this folder's source too.
- `server/samples.js`: sample upload/download, stored by SHA-256 of the file.
- `server/db.js`: accounts, sign-in sessions, friends and project lists, kept in
  memory and written to `data/coprod.json` (atomically) after changes.
- `server/auth.js`: password hashing (scrypt, salted), the session cookie, rate
  limits, and the rules for usernames and names.
- `server/api.js`: the `/api` routes and the `/live` socket; friends' presence
  comes from who's connected to which room.
- `server/copr.js`: .copr files (a small zip reader and writer on Node's zlib).
- `src/app.js` (startup and routing), `src/signin.js`, `src/home.js`,
  `src/profile.js` (profile cards and editing), `src/chat.js`, `src/api.js`
  (requests and the live socket), `src/ui.js` (shared DOM helpers).
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
- Whoever adds a plugin (by URL or from the community list) has chosen it, so it's
  allowed for them.

Plugin settings are shared as the plugin's `getState()` JSON, stored per top-level
key (up to 256 KB each), so turning one knob only sends the part that changed, not
e.g. a synth's custom wavetables. Plugins whose state isn't plain JSON won't sync
their knobs yet.

## Tests

```bash
npm test                      # merge/conflict behavior, server sync & persistence, accounts,
                              # friends, chat, .copr files, and the DSP/plugin engines
npm run build && npm run e2e  # three real browsers editing one room, incl. samples, plugins
                              # and the plugin-safety prompt (needs Chromium;
                              # set CHROMIUM_PATH if Playwright's isn't installed)
```

## Deploying

Any Node 20+ host with WebSocket support (Render, Railway, Fly.io, a VPS). Build
command `npm install && npm run build`, start command `npm start`. Point
`COPROD_DATA` at a persistent disk so accounts (`coprod.json`), rooms (`rooms/`)
and uploaded samples (`samples/`) survive redeploys, and back that folder up.
Serve it over HTTPS: browsers only allow the audio worklets some plugins use on
secure pages (localhost is fine for development), and the session cookie is
marked Secure there.

Someone forgot their password? Stop the server and run
`node scripts/reset-password.mjs their_username` (with the same `COPROD_DATA`):
it prints a new password and signs them out everywhere.

## Known limits (it's a prototype)

- Rooms are "anyone with the link can edit" (with an account or as a guest), like
  a shared Google Doc's link setting. There are no private rooms, roles or
  read-only links yet.
- Accounts have no email, so there's no "forgot my password" link: the server
  owner can reset one (see Deploying). An email (for paid plans, receipts or
  resets) can be added to accounts later without changing how sign-in works.
- A guest's account lives in one browser's cookie: clearing it, or signing out,
  loses access to the guest's projects (the projects themselves stay for
  everyone else in them).
- Accounts live in one JSON file, which is fine for a few thousand people; a
  bigger deployment should move `server/db.js` onto a real database.
- Invites only reach friends who have coprod open (otherwise, send the link).
- Plugins are web plugins (WAM), not native VST/AU. Native plugins need a desktop
  app; see the plan below.
- Vertex is CPU-hungry at extremes (like any big wavetable synth): 8 voices with
  7-voice unison on both oscillators plus effects uses roughly a quarter of one core.
- Vocalist is a formant synthesizer, not a recorded or neural voice. It is clearly
  sung and intelligible, but it sounds synthetic, like a classic speech synth
  that can sing. It sings English (the dictionary has about 900 words, and rules
  cover the rest, so unusual words may need hyphens or `[phonemes]`), and one
  note at a time: in a chord, the latest note wins.
- Automation of the bundled Acid/Echo plugins is applied slightly ahead of time
  (they react when events are scheduled, up to ~0.1 s early); Vertex is sample-block
  accurate.
- Uploads are rate-limited per account, but there's no storage quota yet.
- Each person's play button is independent (like each person scrolling their own
  copy of a doc). There's no "play for everyone" yet.
- Automation lives in patterns. When two clips of patterns that automate the same
  knob overlap in the arrangement, the last one scheduled wins at each step.
- Slides on Dexed (and other plugins from other sites) use channel pitch bend, so
  overlapping notes bend together.

## Ideas / next steps

1. **Automation clips in the arrangement** (song-level automation that spans
   patterns), and drag-and-drop of patterns from a list into it.
2. **More bundled plugins** (a drum machine), and MIDI plugins from the
   community registry (arpeggiators, sequencers).
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
8. Private rooms and read-only share links; profile pictures; an optional email
   on accounts (for plans and password resets).
