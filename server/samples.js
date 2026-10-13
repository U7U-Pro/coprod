// Uploaded audio samples, stored once by content hash. Every collaborator
// fetches the same bytes, so everyone hears the same sound.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const MAX_SAMPLE_BYTES = 15 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;

// Uploads are checked by their first bytes, not by what the client claims.
export function sniffAudio(buf) {
  const ascii = (start, end) => buf.subarray(start, end).toString('latin1');
  if (buf.length < 12) return null;
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 4) === 'fLaC') return 'audio/flac';
  if (ascii(4, 8) === 'ftyp') return 'audio/mp4';
  if (ascii(0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  return null;
}

export class SampleStore {
  constructor(dir) {
    this.dir = dir;
    this.recent = new Map(); // ip -> [{ at, bytes }] for rate limiting
  }

  /** Simple per-address budget: 40 uploads or 150 MB per 10 minutes. */
  allow(ip, bytes) {
    const now = Date.now();
    const list = (this.recent.get(ip) ?? []).filter((e) => now - e.at < 10 * 60_000);
    const total = list.reduce((a, e) => a + e.bytes, 0);
    if (list.length >= 40 || total + bytes > 150 * 1024 * 1024) return false;
    list.push({ at: now, bytes });
    this.recent.set(ip, list);
    return true;
  }

  async put(buf) {
    const type = sniffAudio(buf);
    if (!type) throw Object.assign(new Error('Not a supported audio file (wav, mp3, ogg, flac or m4a)'), { status: 415 });
    const id = createHash('sha256').update(buf).digest('hex');
    const file = join(this.dir, id);
    try {
      await stat(file); // already stored: identical uploads share one file
    } catch {
      await mkdir(this.dir, { recursive: true });
      await writeFile(`${file}.tmp`, buf);
      await rename(`${file}.tmp`, file);
    }
    return { id, type, size: buf.length };
  }

  async get(id) {
    if (!HASH.test(id)) return null;
    try {
      const buf = await readFile(join(this.dir, id));
      return { buf, type: sniffAudio(buf) ?? 'application/octet-stream' };
    } catch {
      return null;
    }
  }
}

/** Read a request body, refusing anything over `limit` bytes. */
export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (declared > limit) return reject(Object.assign(new Error('File too large (max 15 MB)'), { status: 413 }));
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('File too large (max 15 MB)'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
