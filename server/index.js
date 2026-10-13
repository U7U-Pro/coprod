// Serves the built app (dist/) and the real-time sync endpoint at /ws/<room>.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { RoomManager, ROOM_NAME } from './rooms.js';
import { SampleStore, readBody, MAX_SAMPLE_BYTES } from './samples.js';

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
};

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/**
 * @param {{ port?: number, dataDir?: string|null }} opts  dataDir holds rooms/ and
 *   samples/. null keeps rooms in memory only (tests) and samples in a temp dir.
 */
export function startServer({ port = PORT, dataDir = process.env.COPROD_DATA ?? join(ROOT, 'data') } = {}) {
  const rooms = new RoomManager({ dataDir: dataDir && join(dataDir, 'rooms') });
  const samples = new SampleStore(join(dataDir ?? join(tmpdir(), 'coprod-samples'), 'samples'));

  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/healthz') return res.end('ok');

    if (path === '/api/samples' && req.method === 'POST') {
      try {
        const ip = req.socket.remoteAddress;
        if (!samples.allow(ip, Number(req.headers['content-length']) || 0)) {
          return json(res, 429, { error: 'Too many uploads, try again in a few minutes' });
        }
        const body = await readBody(req, MAX_SAMPLE_BYTES);
        return json(res, 200, await samples.put(body));
      } catch (err) {
        return json(res, err.status ?? 500, { error: err.status ? err.message : 'Upload failed' });
      }
    }

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
    const m = new URL(req.url, 'http://x').pathname.match(/^\/ws\/(.+)$/);
    if (!m || !ROOM_NAME.test(m[1])) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => rooms.connect(ws, m[1]));
  });

  return new Promise((resolve) =>
    server.listen(port, () =>
      resolve({
        port: server.address().port,
        rooms,
        async close() {
          for (const ws of wss.clients) ws.terminate();
          await rooms.closeAll();
          await new Promise((r) => server.close(r));
        },
      }),
    ),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { port } = await startServer();
  console.log(`coprod listening on http://localhost:${port}`);
}
