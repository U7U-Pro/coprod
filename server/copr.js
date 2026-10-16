// .copr project files.
//
// A .copr is an ordinary zip archive (rename it to .zip to look inside):
//   manifest.json            what it is: format, version, title, tempo, the samples
//   project.ydoc             the whole shared document as one Yjs update: channels,
//                            patterns, notes, plugin settings, automation, arrangement
//   samples/<sha256>.<ext>   every uploaded audio file the project uses, so it opens
//                            complete on any coprod server
//
// Opening one always makes a new project; it never overwrites an existing one.

import { promisify } from 'node:util';
import zlib from 'node:zlib';
import * as Y from 'yjs';
import { readProject } from '../src/shared/schema.js';

const deflate = promisify(zlib.deflateRaw);
const inflate = promisify(zlib.inflateRaw);

export const COPR_FORMAT = 'coprod-project';
export const COPR_VERSION = 1;
export const MAX_COPR_BYTES = 200 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const MAX_UNPACKED = 400 * 1024 * 1024;

const bad = (message) => Object.assign(new Error(message), { status: 400 });
const SHA = /^[a-f0-9]{64}$/;
const EXT = { 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/mp4': 'm4a' };

// ------------------------------------------------------------------ zip

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(buf) {
  if (zlib.crc32) return zlib.crc32(buf);
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** A zip archive of [{ name, data }]. Each file is deflated if that saves space, else stored. */
export async function zip(files, now = new Date()) {
  const { time, date } = dosTime(now);
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    let body = await deflate(data);
    let method = 8;
    if (body.length >= data.length * 0.97) {
      body = data; // audio is mostly compressed already
      method = 0;
    }
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // file names are UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // made by
    entry.writeUInt16LE(20, 6); // needed
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

/**
 * The files in a zip, as a Map of name -> Buffer. Reads zips from zip() and
 * from ordinary tools. Refuses encrypted, damaged or oversized archives
 * (sizes are checked before inflating, so a "zip bomb" can't fill memory).
 */
export async function unzip(buf) {
  if (buf.length < 22) throw bad('That file isn’t a .copr project');
  let eocd = -1;
  for (let i = buf.length - 22, min = Math.max(0, buf.length - 22 - 0xffff); i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw bad('That file isn’t a .copr project');
  const count = buf.readUInt16LE(eocd + 10);
  const dirSize = buf.readUInt32LE(eocd + 12);
  let p = buf.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES || p + dirSize > eocd) throw bad('That .copr file is damaged');

  const files = new Map();
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== 0x02014b50) throw bad('That .copr file is damaged');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const packed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const at = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    if (name.endsWith('/')) continue; // a folder
    if (flags & 1) throw bad('That .copr file is encrypted');
    if ((total += size) > MAX_UNPACKED) throw bad('That .copr file is too big to open');
    if (at + 30 > buf.length || buf.readUInt32LE(at) !== 0x04034b50) throw bad('That .copr file is damaged');
    const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
    if (start + packed > buf.length) throw bad('That .copr file is cut short');
    const raw = buf.subarray(start, start + packed);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) {
      try {
        data = await inflate(raw, { maxOutputLength: Math.max(1, size) });
      } catch {
        throw bad('That .copr file is damaged');
      }
    } else throw bad('That .copr file uses a compression coprod can’t read');
    if (data.length !== size || crc32(data) !== crc) throw bad('That .copr file is damaged');
    files.set(name, data);
  }
  return files;
}

// ------------------------------------------------------------------ projects

/**
 * Every sample a project refers to, with a name for each: channel samples and
 * anything a plugin keeps in its settings (Slicer's loop, Grains' sound).
 */
export function samplesUsed(project) {
  const found = new Map();
  const walk = (v) => {
    if (typeof v === 'string') {
      if (SHA.test(v) && !found.has(v)) found.set(v, null);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      if (typeof v.id === 'string' && SHA.test(v.id) && typeof v.name === 'string') found.set(v.id, v.name);
      Object.values(v).forEach(walk);
    }
  };
  walk(project.channels);
  return found;
}

/**
 * A .copr file for a room's document.
 * @param {Uint8Array} update  the document (RoomManager.encode)
 * @param {{ get(id: string): Promise<{buf: Buffer, type: string}|null> }} samples
 */
export async function packProject(update, samples) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  const project = readProject(doc);
  doc.destroy();

  const files = [];
  const list = [];
  for (const [id, name] of samplesUsed(project)) {
    const found = await samples.get(id);
    if (!found) continue; // not on this server (the project still opens; that sound is silent)
    const path = `samples/${id}.${EXT[found.type] ?? 'bin'}`;
    files.push({ name: path, data: found.buf });
    list.push({ id, name, path, type: found.type, size: found.buf.length });
  }
  const manifest = {
    format: COPR_FORMAT,
    version: COPR_VERSION,
    title: project.title,
    bpm: project.bpm,
    saved: new Date().toISOString(),
    channels: project.channels.map((c) => c.name),
    patterns: project.patterns.map((p) => p.name),
    samples: list,
  };
  return zip([
    { name: 'manifest.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
    { name: 'project.ydoc', data: Buffer.from(update) },
    ...files,
  ]);
}

/** Read and check a .copr file: { manifest, update, title, samples: [Buffer] }. */
export async function unpackProject(buf) {
  const files = await unzip(buf);
  let manifest = null;
  try {
    manifest = JSON.parse(files.get('manifest.json')?.toString('utf8') ?? 'null');
  } catch {}
  if (manifest?.format !== COPR_FORMAT) throw bad('That file isn’t a coprod project (.copr)');
  if (!(manifest.version <= COPR_VERSION)) throw bad('That project was saved by a newer version of coprod');
  const ydoc = files.get('project.ydoc');
  if (!ydoc) throw bad('That .copr file has no project in it');

  const update = new Uint8Array(ydoc);
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, update);
  } catch {
    doc.destroy();
    throw bad('The project in that .copr file is damaged');
  }
  const ok = !!doc.getMap('meta').get('version');
  const title = readProject(doc).title;
  doc.destroy();
  if (!ok) throw bad('The project in that .copr file is empty or damaged');

  const samples = [...files].filter(([name]) => name.startsWith('samples/')).map(([, data]) => data);
  return { manifest, update, title, samples };
}

/** "My beat.copr", safe for any operating system. */
export function coprFileName(title) {
  const base = String(title || 'coprod project')
    .replace(/[\\/:*?"<>|\p{Cc}]+/gu, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 80);
  return `${base || 'coprod project'}.copr`;
}
