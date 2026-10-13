// Hosting Web Audio Module (WAM 2.0) plugins.
//
// A WAM is JavaScript loaded from a URL, so loading one runs someone else's
// code inside this page. Plugins from coprod's own origin load automatically;
// plugins from anywhere else only load after *each* person allows that site
// (a collaborator adding a plugin must never be enough to run code on your
// machine).

import initializeWamHost from '@webaudiomodules/sdk/src/initializeWamHost.js';

/** Plugins that ship with coprod. Anything else can be added by URL. */
export const CATALOG = [
  { url: '/wam/dexed/index.js', name: 'Dexed', type: 'instrument', about: 'DX7 FM synth (Dexed, GPL) with 1,000+ classic voices' },
  { url: '/wam/coprod-acid/index.js', name: 'Acid', type: 'instrument', about: 'Squelchy synth with a resonant filter' },
  { url: '/wam/coprod-echo/index.js', name: 'Echo', type: 'effect', about: 'Tempo-synced feedback delay' },
];

const TRUST_KEY = 'coprod:trusted-plugin-origins';

export function pluginOrigin(url) {
  try {
    return new URL(url, location.href).origin;
  } catch {
    return null;
  }
}

function trustedOrigins() {
  try {
    return new Set(JSON.parse(localStorage.getItem(TRUST_KEY) ?? '[]'));
  } catch {
    return new Set();
  }
}

export function isTrusted(url) {
  const origin = pluginOrigin(url);
  return origin === location.origin || trustedOrigins().has(origin);
}

export function trustOrigin(origin) {
  const set = trustedOrigins();
  set.add(origin);
  try {
    localStorage.setItem(TRUST_KEY, JSON.stringify([...set]));
  } catch {}
}

/** "https://x.com/plugins/synth101/index.js" -> "synth101" */
export function nameFromUrl(url) {
  const parts = new URL(url, location.href).pathname.split('/').filter(Boolean);
  const last = parts.at(-1) ?? 'Plugin';
  const name = /^index\.m?js$/i.test(last) ? parts.at(-2) ?? 'Plugin' : last.replace(/\.m?js$/i, '');
  return name.slice(0, 32);
}

export class PluginHost {
  constructor() {
    this.group = null; // Promise<groupId>
    this.modules = new Map(); // url -> Promise<module namespace>
  }

  /** Load and instantiate a plugin. Caller must check isTrusted() first. */
  async create(ctx, url, state) {
    if (!isTrusted(url)) throw new Error('blocked');
    this.group ??= initializeWamHost(ctx).then(([id]) => id);
    const groupId = await this.group;
    const abs = new URL(url, location.href).href;
    if (!this.modules.has(abs)) {
      this.modules.set(
        abs,
        import(/* @vite-ignore */ abs).catch((err) => {
          this.modules.delete(abs); // allow a retry later
          throw err;
        }),
      );
    }
    const WAM = (await this.modules.get(abs)).default;
    if (!WAM?.createInstance) throw new Error('not a Web Audio Module');
    return WAM.createInstance(groupId, ctx, state ?? undefined);
  }
}

/** Send events if the node understands WAM events (plain AudioNodes don't). */
export function sendEvents(node, ...events) {
  if (typeof node?.scheduleEvents === 'function') node.scheduleEvents(...events);
}
