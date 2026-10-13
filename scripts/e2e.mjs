// End-to-end: two browsers edit the same project and see each other live.
//   npm run build && npm run e2e     (set CHROMIUM_PATH if needed)
// Screenshots land in e2e-shots/.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { startServer } from '../server/index.js';

const SHOTS = new URL('../e2e-shots/', import.meta.url).pathname;
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

/** A short decaying sine "boom" as a WAV file. */
function makeWav(path, freq) {
  const rate = 22050;
  const n = Math.floor(rate * 0.4);
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
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * Math.exp(-i / (rate * 0.1)) * 30000), 44 + i * 2);
  writeFileSync(path, buf);
  return path;
}
const boom = makeWav(join(dataDir, 'boom.wav'), 55);
const snap = makeWav(join(dataDir, 'snap.wav'), 900);

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const errors = [];
async function join_(name, viewport = { width: 1280, height: 860 }) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/fonts\.g/.test(m.text()) && errors.push(`${name}: ${m.text()}`));
  await page.goto(URL_);
  await page.fill('#nameInput', name);
  await page.click('#welcomeForm button.primary');
  await page.waitForSelector('.row');
  return page;
}
const step = (m) => console.log(`• ${m}`);
const project = (page) => page.evaluate(() => window.coprod.S.readProject(window.coprod.doc));

try {
  const ana = await join_('Ana');
  const ben = await join_('Ben');
  await ana.waitForFunction(() => document.querySelectorAll('#people .avatar').length === 2);
  await ben.waitForFunction(() => document.querySelectorAll('#people .avatar').length === 2);
  step('Both joined the room and see two people');

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
  await ana.selectOption('#channelPanel .fx-add', '__url').catch(async () => {
    await ana.click(`.row[data-id="${acidId}"] .fxbtn`);
    await ana.selectOption('#channelPanel .fx-add', '__url');
  });
  await ana.click('#picker summary');
  await ana.fill('#pickerUrl', FOREIGN_URL);
  await ana.click('#pickerUrlAdd');
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

  // A phone-sized third person.
  const cara = await join_('Cara', { width: 390, height: 844 });
  await cara.waitForFunction(() => document.querySelectorAll('#people .avatar').length === 3);
  await cara.screenshot({ path: `${SHOTS}3-cara-mobile.png` });
  await cara.click('.row.synth .miniroll');
  await cara.waitForSelector('#rollPanel:not([hidden])');
  await cara.waitForTimeout(400);
  await cara.screenshot({ path: `${SHOTS}4-cara-mobile-roll.png` });
  step('A third (mobile) user joins and sees everyone');

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
