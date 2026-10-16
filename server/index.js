// Serves the built app (dist/), the API (/api, see api.js), the real-time
// sync endpoint at /ws/<room> and the notification socket at /live. Both
// sockets need a signed-in session.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { RoomManager, ROOM_NAME } from './rooms.js';
import { SampleStore } from './samples.js';
import { Db } from './db.js';
import { createApi } from './api.js';
import { sameOrigin } from './auth.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');
const PORT = Number(process.env.PORT) || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.wasm': 'application/wasm', // browsers only compile WebAssembly served as this
};

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/**
 * @param {{ port?: number, dataDir?: string|null, roomOptions?: object }} opts  dataDir
 *   holds coprod.json (accounts), rooms/ and samples/. null keeps accounts and rooms
 *   in memory only (tests) and samples in a temp dir. roomOptions go to RoomManager.
 */
export async function startServer({ port = PORT, dataDir = process.env.COPROD_DATA ?? join(ROOT, 'data'), roomOptions = {} } = {}) {
  const db = await Db.open(dataDir && join(dataDir, 'coprod.json'));
  const rooms = new RoomManager({ dataDir: dataDir && join(dataDir, 'rooms'), ...roomOptions });
  const samples = new SampleStore(join(dataDir ?? join(tmpdir(), 'coprod-samples'), 'samples'));
  const api = createApi({ db, rooms, samples });

  const server = createServer(async (req, res) => {
    let path;
    try {
      path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      return json(res, 400, { error: 'Bad URL' }); // e.g. a stray "%" (decoding it would throw)
    }
    if (path === '/healthz') return res.end('ok');
    if (path.startsWith('/api/')) return api.handle(req, res, path);

    const sample = path.match(/^\/samples\/([a-f0-9]{64})$/);
    if (sample) {
      const found = await samples.get(sample[1]);
      if (!found) return json(res, 404, { error: 'No such sample' });
      res.writeHead(200, {
        'content-type': found.type,
        'content-length': found.buf.length,
        'cache-control': 'public, max-age=31536000, immutable', // content-addressed: never changes
        'x-content-type-options': 'nosniff',
      });
      return res.end(found.buf);
    }

    const file = normalize(join(DIST, path === '/' ? 'index.html' : path));
    if (!file.startsWith(DIST)) {
      res.writeHead(403);
      return res.end();
    }
    try {
      const body = await readFile(file);
      const long = path.startsWith('/assets/'); // hashed file names from Vite
      res.writeHead(200, {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        'cache-control': long ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
      res.end(body);
    } catch {
      try {
        const index = await readFile(join(DIST, 'index.html'));
        res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
        res.end(index);
      } catch {
        res.writeHead(503, { 'content-type': 'text/plain' });
        res.end('App not built yet. Run `npm run build` first (or `npm run dev` while developing).');
      }
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const refuse = (status) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    const path = new URL(req.url, 'http://x').pathname;
    const m = path.match(/^\/ws\/(.+)$/);
    if (path !== '/live' && (!m || !ROOM_NAME.test(m[1]))) return socket.destroy();
    if (!sameOrigin(req)) return refuse('403 Forbidden'); // another site's page can't open your rooms
    const user = api.userOf(req);
    if (!user) return refuse('401 Unauthorized');
    wss.handleUpgrade(req, socket, head, (ws) => (m ? rooms.connect(ws, m[1], user) : api.addLive(ws, user)));
  });

  await new Promise((resolve) => server.listen(port, resolve));
  return {
    port: server.address().port,
    rooms,
    db,
    async close() {
      for (const ws of wss.clients) ws.terminate();
      api.close();
      await rooms.closeAll();
      await db.flush();
      await new Promise((r) => server.close(r));
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { port } = await startServer();
  console.log(`coprod listening on http://localhost:${port}`);
}
