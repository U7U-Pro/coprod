// Shared by the server tests: sign in over HTTP, connect to rooms as a person.

import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';

export const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** Sign up (or in, if the account exists) and return { user, cookie, call }. */
export async function account(port, name, extra = {}) {
  const base = `http://localhost:${port}`;
  const body = { email: `${name.toLowerCase()}@example.com`, password: 'correct horse', name, username: name.toLowerCase(), ...extra };
  const post = (path) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let res = await post('/api/auth/signup');
  if (res.status === 409) res = await post('/api/auth/login');
  assert.ok(res.ok, `sign in as ${name}: ${res.status}`);
  const user = (await res.json()).user;
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return { user, cookie, call: api(port, cookie) };
}

/** call(method, path, body?) -> { status, body } as the person with `cookie`. */
export function api(port, cookie) {
  return async (method, path, body) => {
    const headers = { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) };
    const res = await fetch(`http://localhost:${port}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
}

/** A WebSocket class that sends `cookie` (Node's ws, for y-websocket's WebSocketPolyfill). */
export const withCookie = (cookie) =>
  class extends WebSocket {
    constructor(url, protocols) {
      super(url, protocols, { headers: { cookie } });
    }
  };

/** A y-websocket client signed in with `cookie`. */
export function client(port, room, cookie) {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(`ws://localhost:${port}/ws`, room, doc, { WebSocketPolyfill: withCookie(cookie), disableBc: true });
  return { doc, provider, close: () => (provider.destroy(), doc.destroy()) };
}
