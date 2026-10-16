// Render the project to an audio file (WAV, MP3 or OGG), offline.
//
// A second Engine runs on an OfflineAudioContext with its own instances of
// every plugin, loaded from the same shared state, so the file sounds like
// what everyone hears, minus anything you haven't allowed to load. Two things
// keep it sounding like playback rather than like a cold start:
//
// - Warm-up. The render starts with WARMUP_S of silence that's cut off. A
//   freshly loaded plugin glides its knobs from their defaults to their
//   settings over its first moments (Grey Hole's delay sweeps up from zero
//   for about a second, with 90% feedback). Live, that happened long before
//   anyone pressed play; here it happens before the music, with nothing going
//   in, so there's nothing to hear.
// - Events a slice at a time. Like playback, notes and automation go out a
//   little ahead of time (SLICE_S + AHEAD_S), not the whole song up front.
//   Plugins that act on events when they arrive rather than at their
//   timestamps would otherwise play the entire song at once at the start.
//
// The render pauses at every slice (OfflineAudioContext.suspend) to schedule
// the next one, which is also how it reports progress and can be cancelled.

import { Engine } from './audio.js';
import { STEPS_PER_BAR, songLength, clipsAt } from './shared/schema.js';
import { peakDb } from './wav.js';
import { FORMATS } from './formats.js';

export { FORMATS };
export const WARMUP_S = 2;
const SLICE_S = 0.1;
const AHEAD_S = 0.05;
const LOAD_TIMEOUT_MS = 30_000;
const QUANTUM = 128; // frames per Web Audio render quantum

export class ExportCancelled extends Error {
  constructor() {
    super('Export cancelled');
    this.name = 'ExportCancelled';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** How long the export will be: { steps, seconds } (music, then the tail). */
export function exportLength(project, { what, patternId, loops, tail }) {
  const song = what === 'song' && project.clips.length > 0;
  const pattern = project.patterns.find((p) => p.id === patternId) ?? project.patterns[0];
  const steps = song ? songLength(project) : Math.max(1, loops | 0) * pattern.bars * STEPS_PER_BAR;
  return { song, pattern, steps, seconds: (steps * 60) / project.bpm / 4 + Math.max(0, tail ?? 2) };
}

/**
 * Render to raw audio.
 * @param {object} project   readProject() snapshot
 * @param {object} opts      { what: 'song' | 'pattern', patternId, loops, tail (s), sampleRate }
 * @param {Engine} live      the playing engine (for decoded samples and solo state)
 * @param {{ onProgress?: (p: object) => void, signal?: AbortSignal }} hooks
 *   progress: { phase: 'loading', done, total } then { phase: 'rendering', fraction, rendered, seconds, eta }
 * @returns {Promise<{ channels: Float32Array[], sampleRate: number, seconds: number, peak: number, problems: string[], latency: number }>}
 */
export async function renderAudio(project, opts, live, { onProgress = () => {}, signal } = {}) {
  const check = () => {
    if (signal?.aborted) throw new ExportCancelled();
  };
  const stepDur = 60 / project.bpm / 4;
  const { song, pattern, steps, seconds } = exportLength(project, opts);
  if (seconds > 60 * 20) throw new Error('That is longer than 20 minutes; export a shorter part');
  const sampleRate = opts.sampleRate ?? live.ctx?.sampleRate ?? 48000;

  const latency = await masterLatency(sampleRate);
  const warmup = Math.round((WARMUP_S * sampleRate) / QUANTUM) * QUANTUM; // frames
  const lead = warmup / sampleRate; // the music starts here, exactly on a frame
  const frames = Math.ceil(seconds * sampleRate);
  const offline = new OfflineAudioContext(2, warmup + latency + frames, sampleRate);
  const engine = new Engine({ context: offline });
  try {
    engine.solo = new Set(live.solo);
    // Reuse samples the live engine already decoded.
    for (const [id, s] of live.samples) if (s.status === 'ready') engine.samples.set(id, s);
    engine.setProject(project);

    // Load every plugin and sample (showing how many are done), but don't wait forever for one.
    const pending = () => [...engine.slots.values(), ...engine.samples.values()];
    const deadline = Date.now() + LOAD_TIMEOUT_MS;
    while (pending().some((x) => x.status === 'loading') && Date.now() < deadline) {
      check();
      const all = pending();
      onProgress({ phase: 'loading', done: all.filter((x) => x.status !== 'loading').length, total: all.length });
      await sleep(100);
    }
    const name = (s) => s.url.split('/').slice(-2, -1)[0] || s.url;
    const why = { blocked: 'not allowed', error: 'failed to load', loading: 'took too long to load' };
    const problems = [...engine.slots.values()].filter((s) => s.status !== 'ready').map((s) => `${name(s)} (${why[s.status] ?? s.status})`);
    if ([...engine.samples.values()].some((s) => s.status !== 'ready')) problems.push('some samples (missing or still loading)');

    // Plugins that apply their settings asynchronously get a moment on the main thread.
    await sleep(150);
    check();

    engine.playing = true;
    engine.sendTransport(null, lead); // bar 1 starts after the warm-up
    engine.laneLast = new Map();
    engine.laneStepped = new Map();
    const length = pattern.bars * STEPS_PER_BAR;
    let step = 0;
    const scheduleUntil = (until) => {
      for (; step < steps && lead + step * stepDur < until; step++) {
        const t = lead + step * stepDur;
        if (song) for (const a of clipsAt(engine.project, step)) engine.scheduleStep(a.pattern, a.step, t, stepDur);
        else engine.scheduleStep(pattern, step % length, t, stepDur);
      }
    };

    const total = offline.length;
    const slice = Math.max(QUANTUM, Math.round((SLICE_S * sampleRate) / QUANTUM) * QUANTUM);
    const started = performance.now();
    const report = (frame) => {
      const rendered = Math.max(0, frame - warmup) / sampleRate;
      const elapsed = (performance.now() - started) / 1000;
      const speed = frame / sampleRate / Math.max(elapsed, 1e-3); // seconds of audio per second
      onProgress({ phase: 'rendering', fraction: frame / total, rendered: Math.min(rendered, seconds), seconds, eta: (total - frame) / sampleRate / speed });
    };

    let cancelled;
    const stopped = new Promise((_, reject) => (cancelled = reject));
    const onAbort = () => cancelled(new ExportCancelled());
    signal?.addEventListener('abort', onAbort, { once: true });
    if (typeof offline.suspend === 'function') {
      scheduleUntil((slice / sampleRate) + AHEAD_S);
      const pauseAt = (frame) => {
        // (half a frame in, so rounding can't land it on the previous quantum)
        offline.suspend((frame + 0.5) / sampleRate).then(() => {
          if (signal?.aborted) return; // left suspended: the render just stops
          try {
            scheduleUntil((frame + slice) / sampleRate + AHEAD_S);
            report(frame);
          } catch (err) {
            cancelled(err);
            return;
          }
          if (frame + slice < total) pauseAt(frame + slice);
          offline.resume();
        }, cancelled);
      };
      if (slice < total) pauseAt(slice);
    } else {
      scheduleUntil(Infinity); // no suspend() (older Firefox): everything up front, no progress
      onProgress({ phase: 'rendering', fraction: null, rendered: null, seconds, eta: null });
    }
    const audio = await Promise.race([offline.startRendering(), stopped]);
    signal?.removeEventListener('abort', onAbort);
    onProgress({ phase: 'rendering', fraction: 1, rendered: seconds, seconds, eta: 0 });

    // Drop the warm-up and the compressor's look-ahead, so beat 1 is at sample 0.
    const start = warmup + latency;
    const channels = Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c).slice(start, start + frames));
    const trimmed = { numberOfChannels: channels.length, getChannelData: (c) => channels[c] };
    return { channels, sampleRate, seconds, peak: peakDb(trimmed), problems, latency };
  } finally {
    for (const slot of engine.slots.values()) {
      try {
        slot.node?.destroy?.();
      } catch {}
    }
  }
}

/** Encode in a Web Worker (so the page never freezes), with progress. Resolves with the file's bytes. */
export function encodeInWorker(job, { onProgress = () => {}, signal } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./encode-worker.js', import.meta.url), { type: 'module' });
    const finish = () => {
      worker.terminate();
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      finish();
      reject(new ExportCancelled());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') return onProgress({ phase: 'encoding', fraction: data.fraction });
      finish();
      if (data.type === 'done') resolve(data.bytes);
      else reject(new Error(data.message));
    };
    worker.onerror = (e) => {
      finish();
      reject(new Error(e.message || 'The encoder couldn’t start'));
    };
    worker.postMessage(job, job.channels.map((c) => c.buffer));
  });
}

/**
 * Render and encode: { blob, ext, seconds, peak, problems }.
 * @param {object} opts  renderAudio's options plus { format: 'wav'|'mp3'|'ogg', quality }
 */
export async function renderProject(project, opts, live, hooks = {}) {
  const format = FORMATS[opts.format] ? opts.format : 'wav';
  const quality = opts.quality ?? (opts.bits ? String(opts.bits) : FORMATS[format].qualities[0][0]);
  const r = await renderAudio(project, opts, live, hooks);
  hooks.onProgress?.({ phase: 'encoding', fraction: 0, format });
  const bytes = await encodeInWorker({ format, quality, sampleRate: r.sampleRate, channels: r.channels }, hooks);
  return { blob: new Blob([bytes], { type: FORMATS[format].mime }), ext: FORMATS[format].ext, seconds: r.seconds, peak: r.peak, problems: r.problems, latency: r.latency };
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
