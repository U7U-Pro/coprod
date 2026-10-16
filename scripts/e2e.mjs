// End-to-end: people sign up, two browsers edit the same project and see each
// other live, chat, become friends, and save and reopen it as a .copr file.
//   npm run build && npm run e2e     (set CHROMIUM_PATH if needed)
// Screenshots land in e2e-shots/.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startServer } from '../server/index.js';

const SHOTS = fileURLToPath(new URL('../e2e-shots/', import.meta.url));
mkdirSync(SHOTS, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), 'coprod-e2e-'));
const srv = await startServer({ port: 0, dataDir });
const URL_ = `http://localhost:${srv.port}/?room=e2e-${Date.now()}`;

// A second server on another origin, standing in for a third-party plugin site.
const echoSrc = readFileSync(new URL('../public/wam/coprod-echo/index.js', import.meta.url));
const foreign = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/javascript', 'access-control-allow-origin': '*' });
  res.end(echoSrc);
});
await new Promise((r) => foreign.listen(0, r));
const FOREIGN_URL = `http://127.0.0.1:${foreign.address().port}/plugins/far-echo/index.js`;

/** A short decaying sine "boom" as a WAV file (or `hits` of them, half a second apart). */
function makeWav(path, freq, hits = 1) {
  const rate = 22050;
  const n = Math.floor(rate * (hits > 1 ? hits * 0.5 : 0.4));
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i % Math.floor(rate * 0.5); // time since the last hit
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * t) / rate) * Math.exp(-t / (rate * 0.1)) * 30000), 44 + i * 2);
  }
  writeFileSync(path, buf);
  return path;
}
const boom = makeWav(join(dataDir, 'boom.wav'), 55);
const snap = makeWav(join(dataDir, 'snap.wav'), 900);
const loop = makeWav(join(dataDir, 'loop.wav'), 220, 4);

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const errors = [];
const watch = (page, name) => {
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // Fonts and the WAM community list come from the internet, which may be out of reach (e.g. in a sandbox).
    const url = m.location()?.url ?? '';
    if (/fonts\.g/.test(m.text()) || (/^Failed to load resource/.test(m.text()) && url && !url.startsWith(`http://localhost:${srv.port}`))) return;
    errors.push(`${name}: ${m.text()}`);
  });
};
/** Open the invite link, create an account (the sign-up form comes first for invite links), land in the room. */
async function join_(name, viewport = { width: 1280, height: 860 }, fullName = name) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, acceptDownloads: true });
  const page = await ctx.newPage();
  watch(page, name);
  await page.goto(URL_);
  await page.waitForSelector('#authScreen:not([hidden]) #authName');
  await page.fill('#authName', fullName);
  await page.fill('#authUsername', name.toLowerCase());
  await page.fill('#authPassword', 'correct horse battery');
  await page.click('#authGo');
  await page.waitForSelector('.row');
  return page;
}

/** Open the invite link and continue as a guest (just a name). */
async function joinAsGuest(name, viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  watch(page, name);
  await page.goto(URL_);
  await page.click('#authGuest');
  await page.fill('#authName', name);
  await page.click('#authGo');
  await page.waitForSelector('.row');
  return page;
}
const step = (m) => console.log(`• ${m}`);
const project = (page) => page.evaluate(() => window.coprod.S.readProject(window.coprod.doc));

try {
  const ana = await join_('Ana');
  const ben = await join_('Ben', undefined, 'Benjamin Okonkwo-Fairweather');
  await ana.waitForFunction(() => document.querySelectorAll('#people .avatar').length === 2);
  await ben.waitForFunction(() => document.querySelectorAll('#people .avatar').length === 2);
  step('Both signed up from the invite link, joined the room and see two people');

  // ---- Profiles and friends -------------------------------------------------
  await ana.click('#people .avatar[data-user="ben"]');
  await ana.waitForSelector('#profileCard [data-action="friend"]');
  const card = await ana.textContent('#profileCard');
  if (!card.includes('Benjamin Okonkwo-Fairweather') || !card.includes('@ben') || !/Here now, on Pattern 1/.test(card)) throw new Error(`profile card: ${card}`);
  await (await ana.$('#profileCard')).screenshot({ path: `${SHOTS}0a-profile.png` });
  await ana.click('#profileCard [data-action="friend"]');
  await ben.waitForSelector('.notice-card:has-text("wants to be friends")');
  await ben.click('.notice-card:has-text("wants to be friends") button.primary');
  await ana.waitForSelector('#profileCard .pill.ok');
  await ana.keyboard.press('Escape');
  await ana.waitForSelector('#profileCard', { state: 'hidden' });
  step('Clicking Ben’s avatar shows his full name and @username; Ana’s friend request pops up for Ben, he accepts, and her card says Friends');

  // ---- Chat -----------------------------------------------------------------
  await ana.click('#chatBtn');
  await ana.fill('#chatInput', 'hey @ben, check the kick');
  await ana.press('#chatInput', 'Enter');
  await ben.waitForFunction(() => document.querySelector('#chatBadge')?.textContent === '1');
  await ben.waitForSelector('.notice-card:has-text("check the kick")'); // a mention pops up while his chat is closed
  await ben.click('#chatBtn');
  await ben.waitForSelector('.chat-msg.mentions-me:has-text("check the kick")');
  const who = await ben.textContent('.chat-msg .chat-who b');
  if (who !== 'Ana') throw new Error(`chat author: ${who}`);
  await ben.fill('#chatInput', 'on it');
  await ben.press('#chatInput', 'Enter');
  await ana.waitForSelector('.chat-msg:has-text("on it")');
  await ana.screenshot({ path: `${SHOTS}0b-chat.png` });
  await ana.click('#chatClose');
  await ben.click('#chatClose');
  step('Chat: Ana’s @mention reaches Ben (unread badge, a pop-up, highlighted), and his reply reaches her');

  // ---- Home: projects and friends -------------------------------------------
  await ana.fill('#title', 'E2E jam');
  await ana.press('#title', 'Enter');
  const home = await ana.context().newPage();
  watch(home, 'Ana (home)');
  await home.goto(`http://localhost:${srv.port}/`);
  await home.waitForSelector('.project-card:has-text("E2E jam") .pj-live:has-text("Benjamin Okonkwo-Fairweather")');
  await home.waitForSelector('#friendList .person:has-text("In “E2E jam”") button:has-text("Join")');
  await home.screenshot({ path: `${SHOTS}0c-home.png` });
  await home.close();
  step('Ana’s home screen lists the project (and who’s in it now), and shows her friend Ben in that session with a Join button');

  // Ana toggles a kick step; Ben sees it.
  const kickStep = '.row:first-child .step[data-step="2"]';
  await ana.click(kickStep);
  await ben.waitForSelector(`${kickStep}.on`);
  step("Ana's step appears on Ben's screen");

  // Drag-paint four hats.
  const hat = await ana.$$('.row:nth-child(3) .step');
  const a = await hat[8].boundingBox();
  const b = await hat[11].boundingBox();
  await ana.mouse.move(a.x + 5, a.y + 5);
  await ana.mouse.down();
  await ana.mouse.move(b.x + 5, b.y + 5, { steps: 8 });
  await ana.mouse.up();
  await ben.waitForFunction(() => document.querySelectorAll('.row:nth-child(3) .step.on').length >= 6);
  step('Drag-painting steps syncs');

  // Ben changes tempo; Ana sees it.
  await ben.fill('#bpm', '140');
  await ben.press('#bpm', 'Enter');
  await ana.waitForFunction(() => document.querySelector('#bpm').value === '140');
  step('Tempo change syncs');

  // Ana opens the bass piano roll and writes a note; Ben sees it.
  const before = (await project(ben)).patterns[0].notes.length;
  await ana.click('.row.synth .miniroll');
  await ana.waitForSelector('#rollPanel:not([hidden])');
  const grid = await ana.$('.roll .grid');
  const gb = await grid.boundingBox();
  const rollBox = await (await ana.$('.roll')).boundingBox();
  await ana.mouse.click(gb.x + 200, rollBox.y + 120);
  await ben.waitForFunction((n) => window.coprod.S.readProject(window.coprod.doc).patterns[0].notes.length === n + 1, before);
  step("Ana's new piano-roll note reaches Ben");

  // Ben opens the same roll and sees Ana's cursor.
  await ben.click('.row.synth .miniroll');
  await ben.waitForSelector('#rollPanel:not([hidden])');
  await ana.mouse.move(gb.x + 320, rollBox.y + 160);
  await ben.waitForFunction(() =>
    [...window.coprod.provider.awareness.getStates().values()].some((s) => s.user?.name === 'Ana' && s.cursor),
  );
  await ben.waitForSelector('.row.busy');
  step("Ben sees Ana's live cursor and which channel she's on");

  // Undo only reverts Ana's last edit (the note), not Ben's tempo.
  await ana.click('#undo');
  await ben.waitForFunction((n) => window.coprod.S.readProject(window.coprod.doc).patterns[0].notes.length === n, before);
  if ((await project(ana)).bpm !== 140) throw new Error('undo reverted someone else’s edit');
  step('Undo is per-person');

  // Ben adds a channel; Ana sees a new row.
  const rows = await ana.locator('.row').count();
  await ben.selectOption('#addChannel', 'pluck');
  await ana.waitForFunction((n) => document.querySelectorAll('.row').length === n + 1, rows);
  step('New channel appears for everyone');

  // Playback runs and the playhead moves.
  await ana.click('#play');
  await ana.waitForSelector('.step.now', { timeout: 3000 });
  const playing = await ana.evaluate(() => window.coprod.engine.playing && window.coprod.engine.ctx.state);
  if (playing !== 'running') throw new Error(`audio context is ${playing}`);
  step('Playback runs with a moving playhead');
  await ana.screenshot({ path: `${SHOTS}1-ana-desktop.png` });
  await ben.screenshot({ path: `${SHOTS}2-ben-desktop.png` });
  await ana.click('#play');

  // ---- Samples ----------------------------------------------------------
  const chooser = ana.waitForEvent('filechooser');
  await ana.selectOption('#addChannel', '__sample');
  await (await chooser).setFiles(boom);
  await ben.waitForFunction(() => [...document.querySelectorAll('.row .name')].some((i) => i.value === 'boom'));
  const boomId = await ben.evaluate(() => window.coprod.ui.project.channels.find((c) => c.name === 'boom').id);
  await ben.waitForFunction(
    (id) => {
      const c = window.coprod.ui.project.channels.find((x) => x.id === id);
      return window.coprod.engine.sampleStatus(c.sample.id).status === 'ready';
    },
    boomId,
  );
  step("Ana uploads a sample; Ben's browser downloads and decodes the same file");

  await ana.click(`.row[data-id="${boomId}"] .step[data-step="0"]`);
  await ben.waitForSelector(`.row[data-id="${boomId}"] .step[data-step="0"].on`);
  step('Sample channels sequence like any drum channel');

  // Drag a file onto the Clap row to swap its sound.
  const clapId = await ana.evaluate(() => window.coprod.ui.project.channels.find((c) => c.inst === 'clap').id);
  const snapB64 = readFileSync(snap).toString('base64');
  await ana.evaluate(
    async ({ b64, id }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'snap.wav', { type: 'audio/wav' }));
      const row = document.querySelector(`.row[data-id="${id}"] .lane`);
      for (const type of ['dragenter', 'dragover', 'drop']) row.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    },
    { b64: snapB64, id: clapId },
  );
  await ben.waitForFunction((id) => window.coprod.ui.project.channels.find((c) => c.id === id).inst === 'sample', clapId);
  step('Dropping an audio file on a channel replaces its sound for everyone');

  // ---- Plugin instrument -------------------------------------------------
  await ana.selectOption('#addChannel', '__plugin');
  await ana.click('.picker-item:has-text("Acid")');
  await ana.waitForSelector('#channelPanel .plugin-gui input[data-param="cutoff"]');
  const acidId = await ana.evaluate(() => window.coprod.ui.project.channels.find((c) => c.inst === 'wam').id);
  await ben.waitForFunction((id) => window.coprod.engine.slotStatus(id).status === 'ready', acidId);
  step("Ana adds the Acid plugin; it loads in Ben's browser too");

  // Ana turns a knob in the plugin's own GUI; Ben's copy follows.
  await ana.evaluate(() => {
    const knob = document.querySelector('#channelPanel input[data-param="cutoff"]');
    knob.value = '0.9';
    knob.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await ben.waitForFunction((id) => window.coprod.engine.slots.get(id)?.node.params.cutoff === 0.9, acidId);
  step("Turning a knob in Ana's plugin GUI changes Ben's plugin");

  // Ben opens the same channel and sees the knob where Ana left it.
  await ben.click(`.row[data-id="${acidId}"] .fxbtn`);
  await ben.waitForFunction(() => document.querySelector('#channelPanel input[data-param="cutoff"]')?.value === '0.9');

  // Ben adds the built-in Echo effect to that channel.
  await ben.selectOption('#channelPanel .fx-add', '/wam/coprod-echo/index.js');
  await ana.waitForFunction(
    (id) => {
      const c = window.coprod.ui.project.channels.find((x) => x.id === id);
      return c.fx.length === 1 && window.coprod.engine.slotStatus(`${id}/${c.fx[0].id}`).status === 'ready' && window.coprod.engine.buses.get(id).chainKey === c.fx[0].id;
    },
    acidId,
  );
  step('Ben adds an Echo effect; it is inserted in the chain on both sides');

  // Notes on the plugin channel play through it.
  await ana.click('#rollClose');
  await ana.evaluate((id) => {
    const { doc, S, ui } = window.coprod;
    S.addNote(doc, ui.project.patterns[0].id, { ch: id, p: 45, s: 0, l: 2 });
    S.addNote(doc, ui.project.patterns[0].id, { ch: id, p: 57, s: 4, l: 1 });
  }, acidId);
  await ana.click('#play');
  await ana.waitForFunction((id) => window.coprod.engine.slots.get(id).node.voices.size >= 2, acidId, { timeout: 4000 });
  await ana.click('#play');
  step('Playback drives the plugin with MIDI notes (both pitches played)');

  // ---- A plugin from another website --------------------------------------
  await ana.selectOption('#channelPanel .fx-add', '__browse').catch(async () => {
    await ana.click(`.row[data-id="${acidId}"] .fxbtn`);
    await ana.selectOption('#channelPanel .fx-add', '__browse');
  });
  await ana.click('#picker summary');
  await ana.fill('#pickerUrl', FOREIGN_URL);
  await ana.click('#pickerUrlFx');
  await ana.waitForFunction(
    (id) => {
      const c = window.coprod.ui.project.channels.find((x) => x.id === id);
      return c.fx.length === 2 && window.coprod.engine.slotStatus(`${id}/${c.fx[1].id}`).status === 'ready';
    },
    acidId,
  );
  step('Ana adds a plugin from another site by URL (she chose it, so it loads for her)');

  await ben.waitForSelector('#channelPanel .notice.warn');
  const benFx = await ben.evaluate((id) => window.coprod.ui.project.channels.find((x) => x.id === id).fx[1].id, acidId);
  const blocked = await ben.evaluate((key) => window.coprod.engine.slotStatus(key).status, `${acidId}/${benFx}`);
  if (blocked !== 'blocked') throw new Error(`foreign plugin should be blocked for Ben, was ${blocked}`);
  await ben.screenshot({ path: `${SHOTS}5-ben-plugin-blocked.png` });
  step("Ben's browser does NOT run it until he allows that site");

  await ben.click('#channelPanel .notice.warn button');
  await ben.waitForFunction((key) => window.coprod.engine.slotStatus(key).status === 'ready', `${acidId}/${benFx}`);
  step('After Ben allows the site, it loads for him too');
  await ben.waitForTimeout(300);
  await ben.screenshot({ path: `${SHOTS}6-ben-plugins.png` });
  await ana.screenshot({ path: `${SHOTS}7-ana-rack.png`, fullPage: true });

  // ---- Dexed (the DX7 engine compiled to WebAssembly) ----------------------
  await ana.click('#play').catch(() => {});
  await ana.click('#play').catch(() => {}); // make sure transport is stopped
  if (await ana.evaluate(() => window.coprod.engine.playing)) await ana.click('#play');
  await ana.selectOption('#addChannel', '__plugin');
  await ana.click('.picker-item:has-text("Dexed")');
  await ana.waitForFunction(() => /\d\d \S/.test(document.querySelector('#channelPanel .dx-lcd')?.textContent ?? ''), null, { timeout: 15000 });
  const dxId = await ana.evaluate(() => window.coprod.ui.project.channels.find((c) => c.plugin?.name === 'Dexed').id);
  const lcd = await ana.textContent('#channelPanel .dx-lcd');
  step(`Dexed loads in the browser and shows its first voice: "${lcd.trim()}"`);

  // Play a chord straight into it and measure the output level.
  const level = await ana.evaluate(async (id) => {
    const { engine } = window.coprod;
    const node = engine.slots.get(id).node;
    const an = engine.ctx.createAnalyser();
    an.fftSize = 2048;
    node.connect(an);
    const t = engine.ctx.currentTime + 0.05;
    for (const n of [57, 60, 64]) node.scheduleEvents({ type: 'wam-midi', time: t, data: { bytes: [0x90, n, 100] } });
    await new Promise((r) => setTimeout(r, 400));
    const buf = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(buf);
    for (const n of [57, 60, 64]) node.scheduleEvents({ type: 'wam-midi', time: engine.ctx.currentTime, data: { bytes: [0x80, n, 0] } });
    node.disconnect(an);
    return Math.sqrt(buf.reduce((s, x) => s + x * x, 0) / buf.length);
  }, dxId);
  if (!(level > 0.005)) throw new Error(`Dexed is silent (rms ${level})`);
  step(`Playing a chord into Dexed produces sound (rms ${level.toFixed(3)})`);

  // Ana picks another voice from the bank; Ben's Dexed switches too.
  await ana.click('#channelPanel .dx-voices button:nth-child(6)');
  const wantName = (await ana.textContent('#channelPanel .dx-voices button:nth-child(6)')).slice(2).trim();
  await ben.waitForFunction((id) => window.coprod.engine.slotStatus(id).status === 'ready', dxId, { timeout: 15000 });
  await ben.waitForFunction(
    ({ id, want }) => {
      const p = window.coprod.engine.slots.get(id)?.node.state.program;
      return p && String.fromCharCode(...p.slice(145, 155)).trim() === want;
    },
    { id: dxId, want: wantName },
    { timeout: 8000 },
  );
  step(`Choosing voice "${wantName}" in Ana's Dexed switches Ben's too`);

  // Ana tweaks operator 1's level; Ben's program byte follows.
  await ana.evaluate(() => {
    const slider = [...document.querySelectorAll('#channelPanel .dx-op')][0].querySelector('input[type=range]');
    slider.value = '42';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await ben.waitForFunction((id) => window.coprod.engine.slots.get(id)?.node.state.program[5 * 21 + 16] === 42, dxId, { timeout: 8000 });
  step('Editing an operator in Dexed syncs to Ben');
  await ana.waitForTimeout(300);
  await (await ana.$('#channelPanel')).screenshot({ path: `${SHOTS}8-dexed.png` });

  // ---- Vertex (wavetable synth) ----------------------------------------
  await ana.click('#channelPanel .cp-close').catch(() => {});
  await ana.selectOption('#addChannel', '__plugin');
  await ana.click('.picker-item:has-text("Vertex")');
  await ana.waitForSelector('#channelPanel .vx', { timeout: 15000 });
  const vxId = await ana.evaluate(() => window.coprod.ui.project.channels.find((c) => c.plugin?.name === 'Vertex').id);
  await ben.waitForFunction((id) => window.coprod.engine.slotStatus(id).status === 'ready', vxId, { timeout: 15000 });
  step('Ana adds Vertex; it loads for Ben too');

  await ana.selectOption('#channelPanel .vx-preset select', { label: 'Supersaw Lead' });
  await ben.waitForFunction((id) => window.coprod.engine.slots.get(id)?.node.name === 'Supersaw Lead', vxId, { timeout: 8000 });
  step('Picking a Vertex preset switches Ben’s Vertex');

  // Turn the cutoff knob by dragging it, like a person would.
  const cutoff = await ana.$('#channelPanel .vx-knob[data-param="flt_cutoff"]');
  await cutoff.scrollIntoViewIfNeeded();
  const kb = await cutoff.boundingBox();
  const cutoffBefore = await ben.evaluate((id) => window.coprod.engine.slots.get(id).node.get('flt_cutoff'), vxId);
  await ana.mouse.move(kb.x + kb.width / 2, kb.y + 20);
  await ana.mouse.down();
  await ana.mouse.move(kb.x + kb.width / 2, kb.y - 40, { steps: 6 });
  await ana.mouse.up();
  await ben.waitForFunction(
    ({ id, before }) => window.coprod.engine.slots.get(id).node.get('flt_cutoff') < before - 0.1 || window.coprod.engine.slots.get(id).node.get('flt_cutoff') > before + 0.1,
    { id: vxId, before: cutoffBefore },
    { timeout: 8000 },
  );
  step('Dragging Vertex’s cutoff knob moves Ben’s too');

  // Drag LFO 2 onto the oscillator's wavetable position knob.
  // (A tall window so the chip and the knob are both on screen, as on a desktop.)
  await ana.setViewportSize({ width: 1280, height: 2000 });
  await (await ana.$('#channelPanel .vx')).scrollIntoViewIfNeeded();
  await ana.dragAndDrop('#channelPanel .vx-chip:has-text("LFO 2")', '#channelPanel .vx-knob[data-param="a_pos"]');
  await ana.setViewportSize({ width: 1280, height: 860 });
  await ben.waitForFunction((id) => window.coprod.engine.slots.get(id).node.routes.some((r) => r.src === 'lfo2' && r.dst === 'a_pos'), vxId, { timeout: 8000 });
  step('Drag-and-drop LFO 2 → WT position creates a modulation route for everyone');

  // Touch-friendly way: tap a source, then tap a knob.
  await ana.click('#channelPanel .vx-chip:has-text("Env 2")');
  await ana.click('#channelPanel .vx-knob[data-param="flt_res"]');
  await ben.waitForFunction((id) => window.coprod.engine.slots.get(id).node.routes.some((r) => r.src === 'env2' && r.dst === 'flt_res'), vxId, { timeout: 8000 });
  step('Tap Env 2, then tap Resonance: also creates a route (works on phones)');

  // A custom wavetable from a formula.
  await ana.click('#channelPanel .vx-wt >> nth=0');
  await ana.fill('.vx-modal input[type=text]', 'sin(2*pi*x) + y*0.5*sq(x*3)');
  await ana.click('.vx-modal button:has-text("Apply to all frames")');
  await ana.click('.vx-modal button:has-text("Use this wavetable")');
  await ben.waitForFunction((id) => window.coprod.engine.slots.get(id).node.tables.a.kind === 'custom', vxId, { timeout: 8000 });
  step('A custom wavetable made in Ana’s editor reaches Ben');
  await ana.waitForTimeout(500);
  await (await ana.$('#channelPanel')).screenshot({ path: `${SHOTS}9-vertex.png` });

  // ---- Automation ---------------------------------------------------------
  await ana.click(`.row[data-id="${vxId}"] .autobtn`);
  await ana.waitForSelector('#autoPanel:not([hidden])');
  await ana.waitForFunction(() => [...document.querySelectorAll('#autoPanel .ap-add option')].some((o) => o.value.startsWith('p:flt_cutoff|')), null, { timeout: 8000 });
  const cutoffOpt = await ana.evaluate(() => [...document.querySelectorAll('#autoPanel .ap-add option')].find((o) => o.value.startsWith('p:flt_cutoff|')).value);
  await ana.selectOption('#autoPanel .ap-add', cutoffOpt);
  await (await ana.$('#autoPanel .ap-canvas')).scrollIntoViewIfNeeded();
  const cv = await (await ana.$('#autoPanel .ap-canvas')).boundingBox();
  await ana.mouse.click(cv.x + 4, cv.y + cv.height - 12); // low at the start
  await ana.mouse.click(cv.x + cv.width * 0.5, cv.y + 12); // high in the middle
  await ana.mouse.click(cv.x + cv.width - 6, cv.y + cv.height * 0.6);
  await ben.waitForFunction((id) => window.coprod.ui.project.patterns[0].lanes.some((l) => l.ch === id && l.target === 'p:flt_cutoff' && l.points.length === 3), vxId, { timeout: 8000 });
  step('Ana draws a 3-point cutoff automation lane; Ben has it');

  // A volume lane on the kick.
  const kickId = await ana.evaluate(() => window.coprod.ui.project.channels[0].id);
  await ana.evaluate((id) => {
    const { doc, S, ui } = window.coprod;
    const pid = ui.project.patterns[0].id;
    const lane = S.addLane(doc, pid, id, 'vol', 'Volume');
    S.setPoint(doc, pid, lane, null, { s: 0, v: 0.1 });
    S.setPoint(doc, pid, lane, null, { s: 16, v: 1 });
  }, kickId);
  await (await ana.$('#autoPanel')).screenshot({ path: `${SHOTS}10-automation.png` });

  // Ben plays: the automation drives his Vertex and his kick volume.
  if (await ben.evaluate(() => window.coprod.engine.playing)) await ben.click('#play');
  await ben.click('#play');
  await ben.waitForFunction((id) => window.coprod.engine.slots.get(id).node.autoValues.has('flt_cutoff'), vxId, { timeout: 5000 });
  const gains = await ben.evaluate(async (id) => {
    const g = window.coprod.engine.buses.get(id).autoGain.gain;
    const seen = [];
    for (let i = 0; i < 12; i++) {
      seen.push(g.value);
      await new Promise((r) => setTimeout(r, 120));
    }
    return seen;
  }, kickId);
  if (!(Math.min(...gains) < 0.5)) throw new Error(`kick volume automation not applied: ${gains.map((g) => g.toFixed(2))}`);
  step(`Playing applies automation: Vertex cutoff follows the lane, kick volume ramps (${Math.min(...gains).toFixed(2)}→${Math.max(...gains).toFixed(2)})`);
  await ben.click('#play');
  await ben.waitForFunction((id) => window.coprod.engine.slots.get(id).node.autoValues.size === 0, vxId, { timeout: 5000 });
  const restored = await ben.evaluate((id) => new Promise((r) => setTimeout(() => r(window.coprod.engine.buses.get(id).autoGain.gain.value), 300)), kickId);
  if (restored < 0.95) throw new Error(`volume not restored after stop (${restored})`);
  step('Stopping hands the knobs back (automation overrides cleared)');

  // ---- Vertex user presets ------------------------------------------------
  await ana.click('#channelPanel .vx-bar > button:has-text("Save")');
  await ana.fill('#channelPanel .vx-name', 'Ana Lead');
  await ana.click('#channelPanel button:has-text("Save preset")');
  await ana.waitForFunction(() => [...document.querySelectorAll('#channelPanel .vx-preset optgroup[label="My presets"] option')].some((o) => o.textContent === 'Ana Lead'));
  await ben.waitForFunction((id) => window.coprod.engine.slots.get(id)?.node.name === 'Ana Lead', vxId, { timeout: 8000 });
  step('Ana saves her sound as a preset; it shows under "My presets" (and Ben sees the new name)');

  const presetDl = ana.waitForEvent('download');
  await ana.click('#channelPanel .vx-bar > button:has-text("Export")');
  const presetPath = `${dataDir}/ana-lead.vertex.json`;
  await (await presetDl).saveAs(presetPath);
  const presetJson = JSON.parse(readFileSync(presetPath, 'utf8'));
  if (presetJson.format !== 'vertex-preset' || presetJson.name !== 'Ana Lead') throw new Error('bad preset file');
  await ben.click(`.row[data-id="${vxId}"] .fxbtn`);
  await ben.waitForSelector('#channelPanel .vx');
  const chooser2 = ben.waitForEvent('filechooser');
  await ben.click('#channelPanel .vx-bar > button:has-text("Import")');
  await (await chooser2).setFiles(presetPath);
  await ben.waitForFunction(() => [...document.querySelectorAll('#channelPanel .vx-preset optgroup[label="My presets"] option')].some((o) => o.textContent === 'Ana Lead'));
  step('She exports it as a file; Ben imports it into his own presets');

  // ---- WAV export -----------------------------------------------------------
  if (await ana.evaluate(() => window.coprod.engine.playing)) await ana.click('#play');
  await ana.click('#exportBtn');
  await ana.selectOption('#exWhat', 'pattern');
  await ana.selectOption('#exLoops', '1');
  await ana.selectOption('#exTail', '0');
  const wavDl = ana.waitForEvent('download', { timeout: 30000 });
  await ana.click('#exGo');
  const wavPath = `${dataDir}/export.wav`;
  await (await wavDl).saveAs(wavPath);
  const wav = readFileSync(wavPath);
  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const channels = dv.getUint16(22, true);
  const rate = dv.getUint32(24, true);
  const n = dv.getUint32(40, true) / 2;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (dv.getInt16(44 + i * 2, true) / 32768) ** 2;
  const seconds = n / channels / rate;
  const wavRms = Math.sqrt(sum / n);
  const bpm = await ana.evaluate(() => window.coprod.ui.project.bpm);
  const expected = (16 * 60) / bpm / 4;
  if (Math.abs(seconds - expected) > 0.01) throw new Error(`export is ${seconds}s, expected ${expected}s`);
  if (!(wavRms > 0.01)) throw new Error(`export is silent (rms ${wavRms})`);
  step(`WAV export: one bar at ${bpm} BPM = ${seconds.toFixed(3)} s, stereo ${rate} Hz, rms ${wavRms.toFixed(3)}`);

  // ---- Pitch bend lanes -------------------------------------------------------
  // On a built-in synth (the bass): add the lane from the menu, draw a bend up.
  const bassId = await ana.evaluate(() => window.coprod.ui.project.channels.find((c) => c.inst === 'bass').id);
  await ana.click(`.row[data-id="${bassId}"] .autobtn`);
  await ana.waitForFunction(() => [...document.querySelectorAll('#autoPanel .ap-add option')].some((o) => o.value.startsWith('bend|')));
  await ana.selectOption('#autoPanel .ap-add', 'bend|Pitch bend');
  await ana.waitForSelector('#autoPanel .ap-range:not([hidden])');
  await ana.selectOption('#autoPanel .ap-range select', '12');
  await ana.evaluate((id) => {
    const { doc, S, ui } = window.coprod;
    const pat = ui.project.patterns[0];
    const lane = pat.lanes.find((l) => l.ch === id && l.target === 'bend');
    S.setPoint(doc, pat.id, lane.id, null, { s: 0, v: 0.5 });
    S.setPoint(doc, pat.id, lane.id, null, { s: 8, v: 1 });
  }, bassId);
  await ben.waitForFunction((id) => window.coprod.ui.project.patterns[0].lanes.some((l) => l.ch === id && l.target === 'bend' && l.range === 12 && l.points.length === 2), bassId);
  await ben.click('#play');
  const bends = await ben.evaluate(async (id) => {
    const o = window.coprod.engine.buses.get(id).bend.offset;
    const seen = [];
    for (let i = 0; i < 14; i++) {
      seen.push(o.value);
      await new Promise((r) => setTimeout(r, 120));
    }
    return seen;
  }, bassId);
  await ben.click('#play');
  if (!(Math.max(...bends) > 600)) throw new Error(`bass bend not applied: ${bends.map(Math.round)}`);
  step(`A ±12 st bend lane on the built-in bass bends it live for Ben (up to +${Math.round(Math.max(...bends))} cents)`);

  // On a plugin (Vertex): prove it in the audio. Hold an A4, bend up halfway
  // through, export just Vertex, and measure the pitch of each half.
  await ana.selectOption('#channelPanel .vx-preset select', { label: 'Init' });
  await ana.waitForTimeout(300);
  await ana.evaluate((id) => {
    const { doc, S, ui, engine } = window.coprod;
    const pat = ui.project.patterns[0];
    for (const n of pat.notes.filter((x) => x.ch === id)) S.removeNote(doc, pat.id, n.id);
    // The cutoff lane from earlier nearly closes the filter at the start; drop it
    // so the measurement hears a steady tone.
    for (const l of pat.lanes.filter((x) => x.ch === id)) S.removeLane(doc, pat.id, l.id);
    S.addNote(doc, pat.id, { ch: id, p: 69, s: 0, l: 16 });
    const lane = S.addLane(doc, pat.id, id, 'bend', 'Pitch bend');
    S.setPoint(doc, pat.id, lane, null, { s: 0, v: 0.5 });
    S.setPoint(doc, pat.id, lane, null, { s: 8, v: 0.5 });
    S.setPoint(doc, pat.id, lane, null, { s: 8.25, v: 1 });
    engine.solo.clear();
    engine.setSolo(id, true);
  }, vxId);
  await ana.waitForTimeout(1200); // let the Init preset reach the shared state
  await ana.click('#exportBtn');
  await ana.selectOption('#exWhat', 'pattern');
  await ana.selectOption('#exLoops', '1');
  await ana.selectOption('#exTail', '0');
  const bendDl = ana.waitForEvent('download', { timeout: 30000 });
  await ana.click('#exGo');
  const bendPath = `${dataDir}/bend.wav`;
  await (await bendDl).saveAs(bendPath);
  await ana.evaluate(() => window.coprod.engine.solo.clear());
  const bw = readFileSync(bendPath);
  const bv = new DataView(bw.buffer, bw.byteOffset, bw.byteLength);
  const bRate = bv.getUint32(24, true);
  const left = (i) => bv.getInt16(44 + i * 4, true); // channel 0 of interleaved stereo
  const pitchIn = (t0, t1) => {
    let c = 0;
    for (let i = Math.floor(t0 * bRate) + 1; i < t1 * bRate; i++) if (left(i - 1) < 0 && left(i) >= 0) c++;
    return c / (t1 - t0);
  };
  const pitchBefore = pitchIn(0.15, 0.75);
  const pitchAfter = pitchIn(1.0, 1.65);
  if (Math.abs(pitchBefore - 440) > 6 || Math.abs(pitchAfter - 493.9) > 6) throw new Error(`Vertex bend: ${pitchBefore.toFixed(1)} -> ${pitchAfter.toFixed(1)} Hz`);
  step(`Bend lane on Vertex, measured in the exported WAV: ${pitchBefore.toFixed(1)} Hz → ${pitchAfter.toFixed(1)} Hz (A4 bent +2 st)`);
  await (await ana.$('#autoPanel')).screenshot({ path: `${SHOTS}11-bend.png` });

  // ---- Curves (FL-style): right-click a segment, pick a shape -----------------
  await ana.click(`.row[data-id="${bassId}"] .autobtn`);
  await ana.waitForSelector('#autoPanel .ap-range:not([hidden])');
  const canvas = await ana.$('#autoPanel .ap-canvas');
  await canvas.scrollIntoViewIfNeeded();
  const cb = await canvas.boundingBox();
  const cellW = cb.width / 16;
  await ana.mouse.click(cb.x + cellW * 4, cb.y + cb.height * 0.75, { button: 'right' });
  await ana.waitForSelector('#autoPanel .ap-menu:not([hidden])');
  await ana.click('#autoPanel .ap-curve:has-text("Stairs")');
  await ben.waitForFunction((id) => window.coprod.ui.project.patterns[0].lanes.find((l) => l.ch === id && l.target === 'bend')?.points[0].c === 'stairs', bassId, { timeout: 8000 });
  await ana.waitForSelector('#autoPanel .ap-amount');
  await ana.waitForTimeout(200);
  await (await ana.$('#autoPanel')).screenshot({ path: `${SHOTS}12-curve-menu.png` });
  await ana.keyboard.press('Escape');
  step('Right-click a segment → "Stairs": the curve type reaches Ben');

  // While Ben plays, the bend must sit exactly on the stairs (no ramps between).
  await ben.click('#play');
  const stairs = await ben.evaluate(async (id) => {
    const o = window.coprod.engine.buses.get(id).bend.offset;
    const seen = [];
    for (let i = 0; i < 40; i++) {
      seen.push(o.value);
      await new Promise((r) => setTimeout(r, 45));
    }
    return seen;
  }, bassId);
  await ben.click('#play');
  const offStair = stairs.filter((v) => ![0, 400, 800, 1200].some((s) => Math.abs(v - s) < 2));
  if (offStair.length || new Set(stairs.map(Math.round)).size < 3) throw new Error(`stair values: ${stairs.map(Math.round)}`);
  step(`Ben's playback steps through the stairs exactly: ${[...new Set(stairs.map(Math.round))].sort((a, b) => a - b).join(' / ')} cents`);

  // Back to a single curve, then bend it by dragging the middle handle.
  await ana.mouse.click(cb.x + cellW * 4, cb.y + cb.height * 0.75, { button: 'right' });
  await ana.click('#autoPanel .ap-curve:has-text("Single curve")');
  await ana.keyboard.press('Escape');
  await ana.waitForTimeout(200);
  const handle = await ana.evaluate(() => window.coprod.autoPanel.handles()[0]);
  await ana.mouse.move(cb.x + handle.x, cb.y + handle.y);
  await ana.mouse.down();
  await ana.mouse.move(cb.x + handle.x, cb.y + handle.y + 40, { steps: 5 });
  await ana.mouse.up();
  await ben.waitForFunction((id) => {
    const p = window.coprod.ui.project.patterns[0].lanes.find((l) => l.ch === id && l.target === 'bend')?.points[0];
    return p.c === 'single' && p.t > 0.3;
  }, bassId, { timeout: 8000 });
  step('Dragging the tension handle bends the curve for everyone');
  await (await ana.$('#autoPanel')).screenshot({ path: `${SHOTS}13-curve-tension.png` });

  // ---- Slicer and Grains ------------------------------------------------
  await ana.selectOption('#addChannel', '__plugin');
  await ana.click('.picker-item:has-text("Slicer")');
  await ana.waitForSelector('#channelPanel .sl .k-wave canvas');
  const slicerId = await ana.evaluate(() => window.coprod.ui.project.channels.find((c) => c.name === 'Slicer').id);
  await ben.waitForFunction((id) => window.coprod.engine.slots.get(id)?.node?.marks?.length === 19, slicerId);
  step('Ana adds Slicer: its demo break is cut into 19 slices, for Ben too');

  await ana.evaluate((b64) => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'loop.wav', { type: 'audio/wav' }));
    const wave = document.querySelector('#channelPanel .sl .k-wave');
    for (const type of ['dragover', 'drop']) wave.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, readFileSync(loop).toString('base64'));
  await ben.waitForFunction((id) => {
    const node = window.coprod.engine.slots.get(id)?.node;
    return node?.audio?.name === 'loop' && node.marks.length === 4;
  }, slicerId);
  const channelCount = (await project(ana)).channels.length;
  step('Dropping a loop on Slicer cuts it at its 4 hits; Ben gets the same file and slices (and no extra channel)');

  await ana.click('#channelPanel .sl button:has-text("To piano roll")');
  await ben.waitForFunction(
    (id) => window.coprod.ui.project.patterns[0].notes.filter((n) => n.ch === id).map((n) => n.p).sort().join() === '60,61,62,63',
    slicerId,
  );
  await (await ana.$('#channelPanel')).screenshot({ path: `${SHOTS}14-slicer.png` });
  step('"To piano roll" writes notes that play the slices in order (C4, C#4, D4, D#4)');

  await ana.selectOption('#addChannel', '__plugin');
  await ana.click('.picker-item:has-text("Grains")');
  await ana.waitForSelector('#channelPanel .gr .k-wave canvas');
  const grainsId = await ana.evaluate(() => window.coprod.ui.project.channels.find((c) => c.name === 'Grains').id);
  const hold = await ana.$('#channelPanel .gr-hold');
  await hold.scrollIntoViewIfNeeded();
  const box = await hold.boundingBox();
  await ana.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await ana.mouse.down();
  await ana.waitForFunction((id) => window.coprod.engine.slots.get(id).node.status?.grains?.length > 0, grainsId);
  await ana.mouse.up();
  step('Ana adds Grains and holds a note: grains are playing');

  const wave = await (await ana.$('#channelPanel .gr .k-wave canvas')).boundingBox();
  await ana.mouse.click(wave.x + wave.width * 0.8, wave.y + wave.height / 2);
  await ben.waitForFunction((id) => Math.abs(window.coprod.engine.slots.get(id)?.node?.get('position') - 0.8) < 0.02, grainsId);
  await (await ana.$('#channelPanel')).screenshot({ path: `${SHOTS}15-grains.png` });
  step('Clicking the Grains waveform moves the grain position for Ben too');
  if ((await project(ana)).channels.length !== channelCount + 1) throw new Error('unexpected channel count');

  // ---- Vocalist ----------------------------------------------------------
  await ana.selectOption('#addChannel', '__plugin');
  await ana.click('.picker-item:has-text("Vocalist")');
  await ana.waitForSelector('#channelPanel .vo textarea');
  const vocId = await ana.evaluate(() => window.coprod.ui.project.channels.find((c) => c.name === 'Vocalist').id);
  await ben.waitForFunction((id) => window.coprod.engine.slotStatus(id).status === 'ready', vocId);
  // A 4-note melody, then lyrics with more syllables than notes: notes get split.
  await ana.evaluate((id) => {
    const { doc, S, ui } = window.coprod;
    const pid = ui.project.patterns[0].id;
    [[0, 60], [4, 60], [8, 67], [12, 67]].forEach(([s, p]) => S.addNote(doc, pid, { ch: id, p, s, l: 4 }));
  }, vocId);
  await ana.fill('#channelPanel .vo textarea', 'Twin-kle twin-kle lit-tle star');
  await ana.click('#channelPanel .vo button:has-text("Put lyrics on notes")');
  const lyricsOf = (page) =>
    page.evaluate((id) => window.coprod.ui.project.patterns[0].notes.filter((n) => n.ch === id).sort((a, b) => a.s - b.s).map((n) => n.ly).join(' '), vocId);
  await ben.waitForFunction((id) => window.coprod.ui.project.patterns[0].notes.filter((n) => n.ch === id && n.ly).length === 7, vocId);
  step(`Ana types lyrics into Vocalist: syllables land on the notes for Ben too ("${await lyricsOf(ben)}")`);

  // Lyrics mode in the piano roll: click the first note, type, Tab to the next.
  await ana.waitForSelector('#rollPanel:not([hidden]) #rollLyrics:not([hidden])');
  await ana.click('#rollLyrics');
  await ana.evaluate(() => {
    const grid = document.querySelector('#roll canvas.grid');
    const r = grid.getBoundingClientRect();
    const cw = r.width / (window.coprod.ui.project.patterns[0].bars * 16);
    const y = r.top + (96 - 60 + 0.5) * 16;
    grid.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + cw * 0.5, clientY: y, button: 0, bubbles: true, pointerId: 1 }));
  });
  await ana.waitForSelector('#roll .lyric-edit');
  await ana.keyboard.press('Control+A');
  await ana.keyboard.type('Shine');
  await ana.keyboard.press('Tab');
  await ana.keyboard.type('on you');
  await ana.keyboard.press('Enter');
  await ben.waitForFunction((id) => window.coprod.ui.project.patterns[0].notes.filter((n) => n.ch === id).sort((a, b) => a.s - b.s).slice(0, 3).map((n) => n.ly).join(' ') === 'Shine on you', vocId);
  await (await ana.$('#rollPanel')).screenshot({ path: `${SHOTS}16-lyrics-roll.png` });
  step('In the piano roll, typing on a note (Tab to the next, several words fill the next notes) reaches Ben');

  // Playback sings: the plugin reports the phonemes it's on.
  await ana.click('#play');
  await ana.waitForFunction(
    (id) => {
      const st = window.coprod.engine.slots.get(id).node.status;
      (window.__heard ??= new Set()).add(st?.ph);
      return ['sh', 'ay', 'n', 'aa', 'y', 'uw'].every((p) => window.__heard.has(p));
    },
    vocId,
    { timeout: 8000, polling: 15 },
  );
  await ana.click('#play');
  step('Playback sings the lyrics: Ana hears sh-ay-n, aa-n, y-uw…');

  // Export just the singer (solo is per person) and check the file isn't silent.
  await ana.click(`.row[data-id="${vocId}"] .solo`);
  await ana.click('#exportBtn');
  await ana.selectOption('#exWhat', 'pattern');
  await ana.selectOption('#exLoops', '1');
  await ana.selectOption('#exTail', '0');
  const vocDl = ana.waitForEvent('download', { timeout: 30000 });
  await ana.click('#exGo');
  const vocPath = `${dataDir}/vocal.wav`;
  await (await vocDl).saveAs(vocPath);
  await ana.click(`.row[data-id="${vocId}"] .solo`);
  const vw = readFileSync(vocPath);
  const vdv = new DataView(vw.buffer, vw.byteOffset, vw.byteLength);
  const vn = vdv.getUint32(40, true) / 2;
  let vsum = 0;
  for (let i = 0; i < vn; i++) vsum += (vdv.getInt16(44 + i * 2, true) / 32768) ** 2;
  const vocRms = Math.sqrt(vsum / vn);
  if (!(vocRms > 0.01)) throw new Error(`vocal export is silent (rms ${vocRms})`);
  await (await ana.$('#channelPanel')).screenshot({ path: `${SHOTS}17-vocalist.png` });
  step(`The WAV export sings too (Vocalist solo, rms ${vocRms.toFixed(3)})`);

  // ---- Selection, copy/paste, longer patterns, fine notes ----------------
  // Pointer gestures on canvases, in content coordinates (works however it's scrolled).
  const gesture = (page, selector, events) =>
    page.evaluate(
      ({ selector, events }) => {
        const el = document.querySelector(selector);
        const r = el.getBoundingClientRect();
        for (const [type, x, y, mods = {}] of events) {
          el.dispatchEvent(new PointerEvent(type, { clientX: r.left + x, clientY: r.top + y, button: type === 'contextmenu' ? 2 : 0, bubbles: true, cancelable: true, pointerId: 1, ...mods }));
        }
      },
      { selector, events },
    );
  const rollGeom = (page) =>
    page.evaluate(() => {
      const grid = document.querySelector('#roll canvas.grid');
      const { roll } = window.coprod;
      return { cw: roll.cellW, width: grid.getBoundingClientRect().width };
    });
  const rowY = (pitch) => (96 - pitch + 0.5) * 16; // the roll's row for a pitch
  await ana.click('#patternTabs .tab:first-child');
  await ana.click(`.row[data-id="${bassId}"] .miniroll`);
  await ana.waitForSelector('#rollPanel:not([hidden])');
  let { cw } = await rollGeom(ana);
  // Ctrl+drag a box around the first three bass notes (steps 0-7, pitches 33-45), copy.
  await gesture(ana, '#roll canvas.grid', [
    ['pointerdown', 0.2 * cw, rowY(46), { ctrlKey: true }],
    ['pointermove', 7.5 * cw, rowY(32), { ctrlKey: true }],
    ['pointerup', 7.5 * cw, rowY(32), { ctrlKey: true }],
  ]);
  if ((await ana.evaluate(() => window.coprod.roll.sel.size)) !== 3) throw new Error('box select did not pick 3 notes');
  await ana.keyboard.press('Control+C');
  // A new pattern; paste into it. The notes land where they were.
  await ana.click('#addPattern');
  await ana.waitForFunction(() => window.coprod.ui.project.patterns.length === 2 && window.coprod.ui.patternId === window.coprod.ui.project.patterns[1].id);
  await ana.keyboard.press('Control+V');
  const p2 = await ana.evaluate(() => window.coprod.ui.patternId);
  await ben.waitForFunction(
    ({ p2, bassId }) => {
      const p = window.coprod.ui.project.patterns.find((x) => x.id === p2);
      return p?.notes.filter((n) => n.ch === bassId).map((n) => `${n.s}:${n.p}`).sort().join() === '0:33,3:33,6:45';
    },
    { p2, bassId },
  );
  step('Ctrl+drag selects notes; Ctrl+C in one pattern, Ctrl+V in another: Ben sees them in the new pattern');

  // Click in the empty bar after the pattern: the note goes there and the pattern grows a bar.
  await ana.keyboard.press('Escape'); // the pasted notes are still selected; let go of them
  ({ cw } = await rollGeom(ana));
  await gesture(ana, '#roll canvas.grid', [
    ['pointerdown', 20.5 * cw, rowY(40)],
    ['pointerup', 20.5 * cw, rowY(40)],
  ]);
  await ben.waitForFunction((p2) => window.coprod.ui.project.patterns.find((x) => x.id === p2)?.bars === 2, p2);
  step('Writing a note past the end of a 1-bar pattern makes it 2 bars, for Ben too');

  // Alt+drag a note: it moves by a fraction of a step.
  ({ cw } = await rollGeom(ana));
  await gesture(ana, '#roll canvas.grid', [
    ['pointerdown', 3.5 * cw, rowY(33), { altKey: true }],
    ['pointermove', 3.5 * cw + 0.35 * cw, rowY(33), { altKey: true }],
    ['pointerup', 3.5 * cw + 0.35 * cw, rowY(33), { altKey: true }],
  ]);
  await ben.waitForFunction(
    ({ p2, bassId }) => {
      const n = window.coprod.ui.project.patterns.find((x) => x.id === p2).notes.find((x) => x.ch === bassId && x.p === 33 && x.s > 3 && x.s < 4);
      return n && Math.abs(n.s - (3 + 8 / 24)) < 1 / 24 + 1e-6;
    },
    { p2, bassId },
  );
  step('Alt+drag moves a note off the grid (to 1/24 of a step), and Ben has the same position');

  // ---- Slides ----------------------------------------------------------
  // Draw one in the roll: in Slide mode, drag from the middle of the note at step 6 up 5 rows.
  await ana.click('#rollSlide');
  ({ cw } = await rollGeom(ana));
  await gesture(ana, '#roll canvas.grid', [
    ['pointerdown', 6.5 * cw, rowY(45)],
    ['pointermove', 7.2 * cw, rowY(47)],
    ['pointermove', 7.9 * cw, rowY(50)],
    ['pointerup', 7.9 * cw, rowY(50)],
  ]);
  await ben.waitForFunction(
    ({ p2, bassId }) => {
      const n = window.coprod.ui.project.patterns.find((x) => x.id === p2).notes.find((x) => x.ch === bassId && x.p === 45);
      return n?.pb && Math.max(...n.pb.map((pt) => pt[1])) === 5 && n.pb[0][1] === 0;
    },
    { p2, bassId },
  );
  await (await ana.$('#rollPanel')).screenshot({ path: `${SHOTS}18-slide.png` });
  await ana.click('#rollSlide');
  step('In Slide mode, dragging along a note draws its pitch (here up 5 semitones); Ben has the same slide');

  // Built-in synth: render a sliding note offline in the page and measure it.
  const keysPitch = await ana.evaluate(async () => {
    const { engine, ui } = window.coprod;
    const keys = ui.project.channels.find((c) => c.inst === 'keys');
    const sr = 48000;
    const ctx = new OfflineAudioContext(1, sr * 1.2, sr);
    const e = new engine.constructor({ context: ctx });
    e.setProject(ui.project);
    e.voice(keys, 0, { pitch: 69, vel: 1, dur: 1, pb: [[0, 0], [0.5, 0], [0.52, 12], [1, 12]] });
    const out = (await ctx.startRendering()).getChannelData(0);
    const hz = (t0, t1) => {
      let c = 0;
      for (let i = Math.floor(t0 * sr) + 1; i < t1 * sr; i++) if (out[i - 1] < 0 && out[i] >= 0) c++;
      return c / (t1 - t0);
    };
    return [hz(0.3, 0.48), hz(0.65, 0.95)];
  });
  if (Math.abs(keysPitch[0] - 440) > 8 || Math.abs(keysPitch[1] - 880) > 12) throw new Error(`keys slide: ${keysPitch}`);
  step(`A slide on the built-in Keys plays: ${keysPitch[0].toFixed(0)} Hz → ${keysPitch[1].toFixed(0)} Hz`);

  // Vertex (a plugin): one A4 that slides up a fifth halfway, exported and measured.
  await ana.click('#patternTabs .tab:first-child');
  await ana.evaluate((id) => {
    const { doc, S, ui, engine } = window.coprod;
    const pat = ui.project.patterns[0];
    for (const n of pat.notes.filter((x) => x.ch === id)) S.removeNote(doc, pat.id, n.id);
    for (const l of pat.lanes.filter((x) => x.ch === id)) S.removeLane(doc, pat.id, l.id);
    S.addNote(doc, pat.id, { ch: id, p: 69, s: 0, l: 16, pb: [[0, 0], [0.5, 0], [0.52, 7], [1, 7]] });
    engine.solo.clear();
    engine.setSolo(id, true);
  }, vxId);
  await ana.click('#exportBtn');
  await ana.selectOption('#exWhat', 'pattern');
  await ana.selectOption('#exLoops', '1');
  await ana.selectOption('#exTail', '0');
  const slideDl = ana.waitForEvent('download', { timeout: 30000 });
  await ana.click('#exGo');
  const slidePath = `${dataDir}/slide.wav`;
  await (await slideDl).saveAs(slidePath);
  await ana.evaluate(() => window.coprod.engine.solo.clear());
  const sw = readFileSync(slidePath);
  const sv = new DataView(sw.buffer, sw.byteOffset, sw.byteLength);
  const sRate = sv.getUint32(24, true);
  const sLeft = (i) => sv.getInt16(44 + i * 4, true);
  const sPitch = (t0, t1) => {
    let c = 0;
    for (let i = Math.floor(t0 * sRate) + 1; i < t1 * sRate; i++) if (sLeft(i - 1) < 0 && sLeft(i) >= 0) c++;
    return c / (t1 - t0);
  };
  const vxBefore = sPitch(0.15, 0.75);
  const vxAfter = sPitch(1.0, 1.65);
  if (Math.abs(vxBefore - 440) > 6 || Math.abs(vxAfter - 659.3) > 8) throw new Error(`Vertex slide: ${vxBefore.toFixed(1)} -> ${vxAfter.toFixed(1)} Hz`);
  step(`A slide on Vertex, measured in the exported WAV: ${vxBefore.toFixed(1)} Hz → ${vxAfter.toFixed(1)} Hz (A4 up a fifth)`);

  // ---- Arrangement -------------------------------------------------------
  // Pattern 2 on the second track at bar 1: it plays at the same time as pattern 1.
  await ana.click(`#patternTabs .tab:nth-child(2)`);
  await ana.locator('#playlist').scrollIntoViewIfNeeded();
  const barW = await ana.evaluate(() => window.coprod.playlist.barW);
  await gesture(ana, '#playlist canvas', [
    ['pointerdown', 6, 22 + 34 + 12],
    ['pointerup', 6, 22 + 34 + 12],
  ]);
  // ...and again on the first track at bar 5, after a gap.
  await gesture(ana, '#playlist canvas', [
    ['pointerdown', 4 * barW + 6, 22 + 12],
    ['pointerup', 4 * barW + 6, 22 + 12],
  ]);
  await ben.waitForFunction(
    (p2) => {
      const clips = window.coprod.ui.project.clips;
      return clips.some((c) => c.p === p2 && c.t === 1 && c.s === 0) && clips.some((c) => c.p === p2 && c.t === 0 && c.s === 64);
    },
    p2,
  );
  await ana.click('button[data-mode="song"]');
  await ana.click('#play');
  await ana.waitForFunction(() => window.coprod.engine.position()?.active.length === 2, null, { timeout: 8000 });
  await ana.waitForFunction(() => {
    const pos = window.coprod.engine.position();
    return pos && pos.songStep >= 34 && pos.songStep < 60 && pos.active.length === 0;
  }, null, { timeout: 15000 });
  await ana.click('#play');
  await (await ana.$('.song')).screenshot({ path: `${SHOTS}19-arrangement.png` });
  await ana.click('button[data-mode="pattern"]');
  step('Arrangement: two patterns on two tracks play at once, then a gap plays silence (Ben sees the same clips)');

  // ---- Automation points: copy from one lane, paste into another ---------------
  // (kickId: the first channel, the kick)
  await ana.click('#patternTabs .tab:first-child');
  const lanes = await ana.evaluate((id) => {
    const { doc, S, ui } = window.coprod;
    const pid = ui.project.patterns[0].id;
    for (const l of ui.project.patterns[0].lanes.filter((x) => x.ch === id)) S.removeLane(doc, pid, l.id); // from earlier steps
    const vol = S.addLane(doc, pid, id, 'vol', 'Volume');
    const pan = S.addLane(doc, pid, id, 'pan', 'Pan');
    [[0, 0.2], [4, 0.9], [8, 0.5]].forEach(([s, v]) => S.setPoint(doc, pid, vol, null, { s, v }));
    return { vol, pan };
  }, kickId);
  await ana.click(`.row[data-id="${kickId}"] .autobtn`);
  await ana.waitForSelector('#autoPanel:not([hidden]) .ap-lanes .tab');
  await ana.click('#autoPanel .ap-lanes .tab:has-text("Volume")');
  await gesture(ana, '#autoPanel .ap-canvas', [
    ['pointerdown', 2, 2, { ctrlKey: true }],
    ['pointerup', 2, 2, { ctrlKey: true }],
  ]);
  await ana.keyboard.press('Control+A');
  await ana.keyboard.press('Control+C');
  await ana.click('#autoPanel .ap-lanes .tab:has-text("Pan")');
  await ana.keyboard.press('Control+V');
  await ben.waitForFunction(
    (pan) => window.coprod.ui.project.patterns[0].lanes.find((l) => l.id === pan)?.points.map((p) => `${p.s}:${p.v}`).join() === '0:0.2,4:0.9,8:0.5',
    lanes.pan,
  );
  await ana.click('#autoPanel .ap-close');
  step('Automation: Ctrl+A, Ctrl+C on the volume lane, Ctrl+V on the pan lane: Ben has the same points');

  // ---- Follow: Ben's view follows Ana's ---------------------------------------
  await ben.click('#people .avatar[data-user="ana"]');
  await ben.click('#profileCard button:has-text("Follow")');
  await ben.waitForSelector('#followBar:not([hidden])');
  for (const n of [2, 1]) {
    await ana.click(`#patternTabs .tab:nth-child(${n})`);
    await ben.waitForFunction(() => window.coprod.ui.patternId === [...window.coprod.provider.awareness.getStates().values()].find((s) => s.user?.username === 'ana')?.pattern);
  }
  await ben.click('#followStop');
  await ben.waitForSelector('#followBar', { state: 'hidden' });
  step('Ben follows Ana: when she switches patterns, so does his view');

  // ---- .copr: save the project, open it as a new one -------------------------
  await ana.click('#exportBtn');
  const coprDl = ana.waitForEvent('download', { timeout: 30000 });
  await ana.click('#exCopr');
  const copr = await coprDl;
  const coprPath = join(dataDir, 'saved.copr');
  await copr.saveAs(coprPath);
  await ana.click('#exCancel');
  const zipBytes = readFileSync(coprPath);
  if (copr.suggestedFilename() !== 'E2E jam.copr' || zipBytes.toString('latin1', 0, 2) !== 'PK') throw new Error(`copr file: ${copr.suggestedFilename()}`);
  const original = await project(ana);
  const opener = await ana.context().newPage();
  watch(opener, 'Ana (open .copr)');
  await opener.goto(`http://localhost:${srv.port}/`);
  await opener.waitForSelector('#homeScreen:not([hidden])');
  await opener.setInputFiles('#coprInput', coprPath);
  await opener.waitForURL((u) => u.searchParams.get('room') && u.searchParams.get('room') !== new URL(URL_).searchParams.get('room'));
  await opener.waitForSelector('.row');
  const copy = await project(opener);
  const sig = (p) => JSON.stringify({ t: p.title, b: p.bpm, c: p.channels.map((c) => [c.name, c.inst, c.sample?.id ?? null]), n: p.patterns.map((x) => x.notes.length) });
  if (sig(copy) !== sig(original)) throw new Error(`the reopened project differs:\n${sig(original)}\n${sig(copy)}`);
  // Its samples decode in the copy too (they travel inside the file, under the same content hashes).
  await opener.click('#play');
  await opener.waitForFunction(() => {
    const { engine, ui } = window.coprod;
    return ui.project.channels.filter((c) => c.sample).every((c) => engine.sampleStatus(c.sample.id).status === 'ready');
  }, null, { timeout: 15000 });
  await opener.click('#play');
  await opener.close();
  step(`Export → Download .copr saves "E2E jam.copr" (${(zipBytes.length / 1024).toFixed(0)} KB with its samples); opening it makes a new project with the same ${copy.channels.length} channels, notes and samples`);

  // ---- Export: sounds like playback, MP3 and OGG, progress, cancel ------------
  // Dee, a guest in a fresh project (the starter beat), so these settings don't touch the shared room.
  const dee = await (await browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true })).newPage();
  watch(dee, 'Dee');
  await dee.goto(`http://localhost:${srv.port}/`);
  await dee.click('#authGuest');
  await dee.fill('#authName', 'Dee');
  await dee.click('#authGo');
  await dee.click('#homeNew');
  await dee.waitForSelector('.row');
  // Record what she hears for 4 loops of the pattern, then export the same 4 loops: every beat should be as loud.
  const deeBpm = await dee.evaluate(() => window.coprod.ui.project.bpm);
  const heard = await dee.evaluate(async (seconds) => {
    const { engine } = window.coprod;
    await engine.ensure();
    const ctx = engine.ctx;
    const src = `registerProcessor('rec', class extends AudioWorkletProcessor {
      process(inputs) { const i = inputs[0]; if (i.length) this.port.postMessage({ f: currentFrame, l: i[0].slice() }); return true; }
    });`;
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    const rec = new AudioWorkletNode(ctx, 'rec', { numberOfInputs: 1, numberOfOutputs: 0 });
    const chunks = [];
    rec.port.onmessage = (e) => chunks.push(e.data);
    engine.out.connect(rec);
    await engine.play({ mode: 'pattern' });
    const first = Math.round(engine.marks[0].time * ctx.sampleRate);
    await new Promise((r) => setTimeout(r, (seconds + 0.6) * 1000));
    engine.stop();
    engine.out.disconnect(rec);
    const n = Math.round(seconds * ctx.sampleRate);
    const out = new Float32Array(n);
    for (const c of chunks) for (let i = 0; i < c.l.length; i++) if (c.f + i - first >= 0 && c.f + i - first < n) out[c.f + i - first] = c.l[i];
    return Array.from(out);
  }, (4 * 16 * 15) / deeBpm);
  const exportFrom = async (page, { format, quality, loops = '4', tail = '0' }) => {
    await page.click('#exportBtn');
    await page.selectOption('#exWhat', 'pattern');
    await page.selectOption('#exLoops', loops);
    await page.selectOption('#exTail', tail);
    await page.selectOption('#exFormat', format);
    await page.selectOption('#exQuality', quality);
    const dl = page.waitForEvent('download', { timeout: 60000 });
    await page.click('#exGo');
    await page.waitForSelector('#exProgress:not([hidden])', { timeout: 5000 }).catch(() => {}); // (a short export can finish first)
    const file = await dl;
    return { name: file.suggestedFilename(), bytes: readFileSync(await file.path()) };
  };
  const deeWav = await exportFrom(dee, { format: 'wav', quality: '32' });
  const fdv = new DataView(deeWav.bytes.buffer, deeWav.bytes.byteOffset, deeWav.bytes.byteLength);
  const exported = Array.from({ length: (deeWav.bytes.length - 44) / 8 }, (_, i) => fdv.getFloat32(44 + i * 8, true)); // left channel
  const sr = fdv.getUint32(24, true);
  const beatDb = (x) => {
    const len = Math.floor((60 / deeBpm) * sr);
    return Array.from({ length: 16 }, (_, b) => {
      let e = 0;
      for (let i = b * len; i < (b + 1) * len; i++) e += (x[i] ?? 0) ** 2;
      return 10 * Math.log10(e / len + 1e-12);
    });
  };
  const liveDb = beatDb(heard);
  const fileDb = beatDb(exported);
  const worst = Math.max(...liveDb.map((v, i) => Math.abs(fileDb[i] - v)));
  if (!(worst < 1.5)) throw new Error(`export loudness differs from playback by up to ${worst.toFixed(1)} dB per beat:\n live ${liveDb.map((v) => v.toFixed(1))}\n file ${fileDb.map((v) => v.toFixed(1))}`);
  step(`The export matches playback: 16 beats, each within ${worst.toFixed(1)} dB of what Dee heard (beat 1 included: plugins warm up before the music)`);

  // MP3 and OGG files that decode to the right length.
  const decode = (bytes) =>
    dee.evaluate(async (b64) => {
      const buf = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
      const a = await window.coprod.engine.ctx.decodeAudioData(buf);
      const d = a.getChannelData(0);
      let e = 0;
      for (let i = 0; i < d.length; i++) e += d[i] * d[i];
      return { seconds: a.duration, rms: Math.sqrt(e / d.length) };
    }, bytes.toString('base64'));
  const bar = (16 * 15) / deeBpm;
  for (const [format, quality] of [['mp3', '320'], ['ogg', '6']]) {
    const f = await exportFrom(dee, { format, quality, loops: '1' });
    const got = await decode(f.bytes);
    if (!f.name.endsWith(`.${format}`) || Math.abs(got.seconds - bar) > 0.08 || !(got.rms > 0.01)) throw new Error(`${format}: ${f.name} decodes to ${got.seconds}s (want ${bar}s), rms ${got.rms}`);
    step(`${format.toUpperCase()} export: "${f.name}" (${(f.bytes.length / 1024).toFixed(0)} KB) decodes to ${got.seconds.toFixed(3)} s for a ${bar.toFixed(3)} s bar, rms ${got.rms.toFixed(3)}`);
  }
  // Pick WAV again (the dialog remembers the format per person).
  await dee.click('#exportBtn');
  await dee.selectOption('#exFormat', 'wav');
  await dee.click('#exCancel');

  // A long export shows its progress and can be cancelled.
  await dee.evaluate(() => window.coprod.S.setPattern(window.coprod.doc, window.coprod.ui.patternId, { bars: 32 }));
  await dee.click('#exportBtn');
  await dee.selectOption('#exLoops', '8');
  await dee.selectOption('#exFormat', 'mp3');
  let downloaded = false;
  dee.once('download', () => (downloaded = true));
  await dee.click('#exGo');
  await dee.waitForFunction(() => /Rendering \d+:\d\d of \d+:\d\d/.test(document.getElementById('exStatus').textContent), null, { timeout: 15000 });
  const progressText = await dee.textContent('#exStatus');
  await (await dee.$('#exportModal .card')).screenshot({ path: `${SHOTS}0d-export-progress.png` });
  await dee.click('#exCancel');
  await dee.waitForFunction(() => document.getElementById('toast').textContent === 'Export cancelled');
  await dee.waitForTimeout(800);
  if (downloaded || (await dee.isDisabled('#exGo'))) throw new Error('cancelling didn’t stop the export');
  step(`Exporting ${Math.round((32 * 8 * 16 * 15) / deeBpm / 60)} minutes of audio shows progress ("${progressText}"), and Cancel stops it`);
  await dee.context().close();

  // A phone-sized third person, joining as a guest.
  const cara = await joinAsGuest('Cara', { width: 390, height: 844 });
  await cara.waitForFunction(() => document.querySelectorAll('#people .avatar').length === 3);
  await cara.screenshot({ path: `${SHOTS}3-cara-mobile.png` });
  await cara.click('.row.synth .miniroll');
  await cara.waitForSelector('#rollPanel:not([hidden])');
  await cara.waitForTimeout(400);
  await cara.screenshot({ path: `${SHOTS}4-cara-mobile-roll.png` });
  step('A third (mobile) person joins as a guest, with just a name, and sees everyone');

  // Others see she's a guest (no friend button); she makes an account from her own card and keeps her place.
  await ana.click('#people .avatar[data-user^="guest_"]');
  await ana.waitForSelector('#profileCard .pill:has-text("Guest")');
  if (await ana.$('#profileCard [data-action="friend"]')) throw new Error('guests can’t be added as friends');
  await ana.keyboard.press('Escape');
  await cara.click('#rollClose');
  await cara.click('#people .avatar[data-user^="guest_"]');
  await cara.click('#profileCard [data-action="upgrade"]');
  await cara.waitForSelector('#upgradeModal:not([hidden])');
  await cara.fill('#upUsername', 'cara');
  await cara.fill('#upPassword', 'correct horse battery');
  await cara.click('#upgradeForm button.primary');
  await cara.waitForSelector('#upgradeModal', { state: 'hidden' });
  await ana.waitForSelector('#people .avatar[data-user="cara"]');
  if (await ana.$('#people .avatar[data-user^="guest_"]')) throw new Error('Cara still shows as a guest');
  step('Ana sees Cara is a guest (no Add friend); Cara creates an account from her profile card and becomes @cara for everyone, without leaving');

  if (errors.length) throw new Error(`browser errors:\n${errors.join('\n')}`);
  console.log('\nE2E PASSED');
} catch (err) {
  console.error('\nE2E FAILED:', err.message);
  for (const [i, ctx] of browser.contexts().entries()) await ctx.pages()[0]?.screenshot({ path: `${SHOTS}fail-${i}.png` }).catch(() => {});
  if (errors.length) console.error(errors);
  process.exitCode = 1;
} finally {
  await browser.close();
  await srv.close();
  foreign.close();
  rmSync(dataDir, { recursive: true, force: true });
}
