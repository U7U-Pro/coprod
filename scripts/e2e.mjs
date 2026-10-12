// End-to-end: two browsers edit the same project and see each other live.
//   npm run build && npm run e2e     (set CHROMIUM_PATH if needed)
// Screenshots land in e2e-shots/.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { startServer } from '../server/index.js';

const SHOTS = new URL('../e2e-shots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), 'coprod-e2e-'));
const srv = await startServer({ port: 0, dataDir });
const URL_ = `http://localhost:${srv.port}/?room=e2e-${Date.now()}`;

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
  rmSync(dataDir, { recursive: true, force: true });
}
