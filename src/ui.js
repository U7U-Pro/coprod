// Small DOM helpers shared by every screen.

import { COLORS } from './shared/colors.js';

export const $ = (id) => document.getElementById(id);

/** el('button', { class: 'x', onclick, dataset: {...} }, 'text', child...). null/false props and children are skipped. */
export function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  e.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return e;
}

/** For tight spots (name tags, cursors): the first word, at most 14 characters. Profiles show the whole name. */
export function shortName(name) {
  const first = [...String(name ?? '').trim().split(/\s+/)[0]];
  return first.length > 14 ? `${first.slice(0, 13).join('')}…` : first.join('');
}

export const initial = (name) => ([...String(name ?? '').trim()][0] ?? '?').toUpperCase();

/** A round colored face with the person's initial (and an optional status dot). */
export function face(user, { size = 32, status = null, title = null } = {}) {
  return el(
    'span',
    { class: `face${status ? ` st-${status}` : ''}`, style: `--c:${user.color}; --size:${size}px`, title, 'aria-hidden': title ? null : 'true' },
    initial(user.name),
  );
}

/** The color picker used when signing up and editing a profile. */
export function colorPicker(root, value, onPick) {
  root.replaceChildren(
    ...COLORS.map((c) =>
      el('button', {
        type: 'button',
        style: `background:${c}`,
        role: 'radio',
        'aria-label': c,
        'aria-checked': String(c === value),
        class: c === value ? 'on' : '',
        onclick: (e) => {
          for (const x of root.children) {
            x.classList.toggle('on', x === e.currentTarget);
            x.setAttribute('aria-checked', String(x === e.currentTarget));
          }
          onPick(c);
        },
      }),
    ),
  );
}

/** Hand the browser a file to save. */
export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ------------------------------------------------------------------ time

export function timeAgo(t, now = Date.now()) {
  if (!t) return '';
  const s = Math.max(0, (now - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  const days = Math.round(s / 86_400);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: new Date(t).getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric' });
}

export const monthYear = (t) => new Date(t).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
export const clock = (t) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

// ------------------------------------------------------------------ toasts and notifications

let toastTimer;
export function toast(text) {
  $('toast').textContent = text;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 2600);
}

/**
 * A card in the corner with buttons, for things that need an answer
 * (a friend request, an invite). Clicking a button runs it and closes the card.
 * @param {{ user?: object, text: string, actions?: { label: string, primary?: boolean, run: () => any }[], timeout?: number }} n
 */
export function notify({ user = null, text, actions = [], timeout = 15_000 }) {
  const close = () => {
    card.classList.add('out');
    setTimeout(() => card.remove(), 200);
  };
  const card = el(
    'div',
    { class: 'notice-card', role: 'status' },
    user && face(user, { size: 34 }),
    el(
      'div',
      { class: 'notice-body' },
      el('p', {}, text),
      actions.length
        ? el(
            'div',
            { class: 'notice-actions' },
            ...actions.map((a) =>
              el(
                'button',
                {
                  type: 'button',
                  class: a.primary ? 'primary small' : 'ghost small',
                  onclick: async () => {
                    close();
                    try {
                      await a.run();
                    } catch (err) {
                      toast(err.message);
                    }
                  },
                },
                a.label,
              ),
            ),
          )
        : null,
    ),
    el('button', { type: 'button', class: 'notice-x', 'aria-label': 'Dismiss', onclick: close }, '✕'),
  );
  $('notices').append(card);
  if (timeout) setTimeout(close, timeout);
  return close;
}

/** Click outside `root` or press Escape: call `close`. Returns a function that stops listening. */
export function dismissable(root, close, { ignore = [] } = {}) {
  const onDown = (e) => {
    if (root.contains(e.target) || ignore.some((x) => x?.contains?.(e.target))) return;
    close();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  // Wait a tick so the click that opened it doesn't close it.
  const t = setTimeout(() => {
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
  });
  return () => {
    clearTimeout(t);
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
  };
}
