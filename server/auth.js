// Passwords, the session cookie, rate limits, and the rules for usernames
// and display names.

import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { COLORS } from '../src/shared/colors.js';

// ------------------------------------------------------------------ passwords

// scrypt with 16 MB of memory per hash: slow enough to make guessing a stolen
// password file expensive, quick enough (~50 ms) for a login.
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_BYTES = 32;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

const derive = (password, salt, { N, r, p }) =>
  new Promise((resolve, reject) =>
    scrypt(String(password).normalize('NFKC'), salt, KEY_BYTES, { N, r, p, maxmem: SCRYPT.maxmem }, (err, key) => (err ? reject(err) : resolve(key))),
  );

/** "scrypt$N$r$p$salt$key", so the cost can be raised later without breaking old hashes. */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await derive(password, salt, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function checkPassword(password, stored) {
  const [kind, N, r, p, salt, key] = String(stored).split('$');
  if (kind !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const got = await derive(password, Buffer.from(salt, 'base64'), { N: +N, r: +r, p: +p });
  return got.length === expected.length && timingSafeEqual(got, expected);
}

// A login for a username with no account (or a guest, who has no password)
// does the same work as a real one, so response times give nothing away.
let decoy;
export async function wastePasswordCheck(password) {
  decoy ??= await hashPassword(randomBytes(12).toString('hex'));
  await checkPassword(password, decoy);
}

// ------------------------------------------------------------------ input rules

export const USERNAME_RULE = 'Usernames are 3 to 20 characters: letters, numbers and _';

/** A username as typed ("@Ana_99" -> "ana_99"), or null if it breaks the rules. */
export function cleanUsername(v) {
  const name = String(v ?? '').trim().toLowerCase().replace(/^@/, '');
  return /^[a-z0-9_]{3,20}$/.test(name) ? name : null;
}

// Guests get "guest_xxxxxx" usernames, so nobody else can pick one.
export const isGuestUsername = (username) => username.startsWith('guest_');

// Control characters and bidi overrides could make one name look like another.
const UNSAFE = /[\p{Cc}‎‏‪-‮⁦-⁩]/gu;
const cut = (s, n) => [...s].slice(0, n).join(''); // by characters, so emoji aren't split

export function cleanName(v) {
  const name = cut(String(v ?? '').replace(UNSAFE, '').replace(/\s+/g, ' ').trim(), 32).trim();
  return name || null;
}

export function cleanBio(v) {
  return cut(String(v ?? '').replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').replace(UNSAFE, (c) => (c === '\n' ? c : '')).replace(/\n{3,}/g, '\n\n').trim(), 160);
}

export const cleanColor = (v) => (COLORS.includes(v) ? v : null);
export const randomColor = () => COLORS[Math.floor(Math.random() * COLORS.length)];

// ------------------------------------------------------------------ cookie

export const COOKIE = 'coprod_session';

export function readCookie(req, name = COOKIE) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** HttpOnly (page scripts and plugins can't read it), SameSite=Lax (other sites can't use it), Secure on HTTPS. */
export function sessionCookie(req, token, maxAgeSeconds) {
  const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
  return `${COOKIE}=${token ?? ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

/**
 * Browsers always send Origin on cross-site requests and WebSocket handshakes,
 * so a request from another site's page is refused even before cookies matter.
 * (No Origin means a non-browser client, which can't borrow anyone's cookie.)
 */
export function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ rate limits

/** At most `max` hits per key in any `windowMs`. */
export class Limiter {
  constructor(max, windowMs) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
    this.calls = 0;
  }

  recent(key) {
    const now = Date.now();
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    if (++this.calls % 1000 === 0) this.prune();
    return list;
  }

  blocked(key) {
    return this.recent(key).length >= this.max;
  }

  hit(key) {
    const list = this.recent(key);
    list.push(Date.now());
    this.hits.set(key, list);
  }

  /** Count a hit and say whether it was within the limit. */
  allow(key) {
    if (this.blocked(key)) return false;
    this.hit(key);
    return true;
  }

  prune() {
    const now = Date.now();
    for (const [key, list] of this.hits) if (list.every((t) => now - t >= this.windowMs)) this.hits.delete(key);
  }
}
