// Talking to the coprod server: JSON requests as the signed-in person, and the
// live socket that brings friend requests, invites and friends' comings and goings.

/** Who is signed in (set once at startup, updated when they edit their profile). */
export const session = { user: null, onSignedOut: null };

export class ApiError extends Error {
  constructor(message, status, field) {
    super(message);
    this.status = status;
    this.field = field;
  }
}

/**
 * @param {string} method
 * @param {string} path
 * @param {object|Blob|undefined} body  JSON, or a file sent as-is
 * @param {{ raw?: boolean }} opts  raw: resolve with the Response itself (for downloads)
 */
export async function request(method, path, body, { raw = false } = {}) {
  const init = { method, headers: {} };
  if (body instanceof Blob) {
    init.body = body;
    init.headers['content-type'] = 'application/octet-stream';
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError('Can’t reach coprod. Check your connection and try again.', 0);
  }
  if (raw && res.ok) return res;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && session.user && !path.startsWith('/api/auth/')) session.onSignedOut?.();
    throw new ApiError(data?.error ?? `Something went wrong (${res.status})`, res.status, data?.field);
  }
  return data;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body = {}) => request('POST', path, body),
  patch: (path, body) => request('PATCH', path, body),
  del: (path) => request('DELETE', path),
};

/** Open a .copr file as a new project. Resolves with { id, title, samples, skipped }. */
export function importCopr(file) {
  if (!/\.copr$/i.test(file.name)) return Promise.reject(new ApiError('That isn’t a .copr project file', 400));
  return request('POST', '/api/projects/import', file);
}

/** Download a project as a .copr file. */
export async function exportCopr(roomId) {
  const res = await request('GET', `/api/projects/${encodeURIComponent(roomId)}/export`, undefined, { raw: true });
  const header = res.headers.get('content-disposition') ?? '';
  const star = header.match(/filename\*=UTF-8''([^;]+)/);
  const name = star ? decodeURIComponent(star[1]) : (header.match(/filename="([^"]+)"/)?.[1] ?? 'coprod project.copr');
  return { blob: await res.blob(), name };
}

// ------------------------------------------------------------------ live socket

const handlers = new Map(); // type -> Set of fns
let socket = null;
let retry = null;
let delay = 1000;

export const live = {
  /** Listen for one kind of message ('request', 'accepted', 'invite', 'friends', 'open'). Returns an unsubscribe. */
  on(type, fn) {
    if (!handlers.has(type)) handlers.set(type, new Set());
    handlers.get(type).add(fn);
    return () => handlers.get(type).delete(fn);
  },

  emit(type, msg) {
    for (const fn of handlers.get(type) ?? []) {
      try {
        fn(msg);
      } catch (err) {
        console.error(err);
      }
    }
  },

  /** Connect, and reconnect by itself (backing off up to 30 s) whenever the connection drops. */
  start() {
    if (socket) return;
    const open = () => {
      socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/live`);
      socket.onopen = () => {
        delay = 1000;
        live.emit('open', {});
      };
      socket.onmessage = (e) => {
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        live.emit(msg.type, msg);
      };
      socket.onclose = () => {
        if (!socket) return; // stopped
        retry = setTimeout(open, delay);
        delay = Math.min(delay * 2, 30_000);
      };
    };
    open();
  },

  stop() {
    clearTimeout(retry);
    const s = socket;
    socket = null;
    s?.close();
  },
};
