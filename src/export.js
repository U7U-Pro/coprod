// Render the project to a WAV file, offline (faster than real time).
//
// A second Engine runs on an OfflineAudioContext with its own instances of
// every plugin, loaded from the same shared state, so the file sounds like
// what everyone hears, minus anything you haven't allowed to load.

import { Engine } from './audio.js';
import { STEPS_PER_BAR } from './shared/schema.js';
import { encodeWav, peakDb } from './wav.js';

/**
 * The master compressor looks ahead a few milliseconds (it differs by
 * browser), which delays everything. Measure it once so exports can be trimmed
 * to start exactly on the beat (loop-ready files depend on that).
 */
const latencyCache = new Map();
async function masterLatency(sampleRate) {
  if (!latencyCache.has(sampleRate)) {
    const ctx = new OfflineAudioContext(1, Math.ceil(sampleRate * 0.05), sampleRate);
    const probe = new Engine({ context: ctx }); // same master chain as playback
    const click = ctx.createBuffer(1, 1, sampleRate);
    click.getChannelData(0)[0] = 1;
    const src = ctx.createBufferSource();
    src.buffer = click;
    src.connect(probe.master);
    src.start(0);
    const out = (await ctx.startRendering()).getChannelData(0);
    const first = out.findIndex((v) => Math.abs(v) > 1e-6);
    latencyCache.set(sampleRate, Math.max(0, first));
  }
  return latencyCache.get(sampleRate);
}

/**
 * @param {object} project   readProject() snapshot
 * @param {object} opts      { what: 'song' | 'pattern', patternId, loops, tail (s), bits, sampleRate }
 * @param {Engine} live      the playing engine (for decoded samples and solo state)
 */
export async function renderProject(project, opts, live) {
  const stepDur = 60 / project.bpm / 4;
  // The sequence of patterns to play, in order.
  const order =
    opts.what === 'song' && project.song.length
      ? project.song
      : Array.from({ length: Math.max(1, opts.loops | 0) }, () => opts.patternId);
  const patterns = order.map((id) => project.patterns.find((p) => p.id === id)).filter(Boolean);
  const steps = patterns.reduce((n, p) => n + p.bars * STEPS_PER_BAR, 0);
  const lead = 0; // offline: no latency to hide, and loops must start exactly at 0
  const seconds = lead + steps * stepDur + Math.max(0, opts.tail ?? 2);
  const sampleRate = opts.sampleRate ?? live.ctx?.sampleRate ?? 48000;
  if (seconds > 60 * 20) throw new Error('That is longer than 20 minutes; export a shorter part');

  const latency = await masterLatency(sampleRate);
  const frames = Math.ceil(seconds * sampleRate);
  const offline = new OfflineAudioContext(2, frames + latency, sampleRate);
  const engine = new Engine({ context: offline });
  engine.solo = new Set(live.solo);
  // Reuse samples the live engine already decoded.
  for (const [id, s] of live.samples) if (s.status === 'ready') engine.samples.set(id, s);
  engine.setProject(project);
  await engine.ready();

  const problems = [...engine.slots.values()]
    .filter((s) => s.status !== 'ready')
    .map((s) => `${s.url.split('/').slice(-2, -1)[0] || s.url} (${s.status === 'blocked' ? 'not allowed' : 'failed to load'})`);

  // Give plugins on the audio thread a moment to take their settings, then
  // schedule the whole arrangement at once.
  await new Promise((r) => setTimeout(r, 150));
  engine.playing = true;
  engine.sendTransport();
  engine.laneLast = new Map();
  let t = lead;
  for (const pattern of patterns) {
    const length = pattern.bars * STEPS_PER_BAR;
    const p = engine.project.patterns.find((x) => x.id === pattern.id);
    for (let step = 0; step < length; step++) {
      engine.scheduleStep(p, step, t, stepDur);
      t += stepDur;
    }
  }
  const audio = await offline.startRendering();
  for (const slot of engine.slots.values()) {
    try {
      slot.node?.destroy?.();
    } catch {}
  }
  // Drop the compressor's look-ahead so beat 1 is at sample 0.
  const trimmed = {
    numberOfChannels: audio.numberOfChannels,
    sampleRate,
    length: frames,
    getChannelData: (c) => audio.getChannelData(c).subarray(latency, latency + frames),
  };
  return {
    blob: new Blob([encodeWav(trimmed, opts.bits ?? 16)], { type: 'audio/wav' }),
    seconds,
    peak: peakDb(trimmed),
    problems,
    latency,
  };
}

/** Save a blob as a file. */
export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
