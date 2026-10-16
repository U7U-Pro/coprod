// Profile cards (click a person anywhere: their full name, @username, about,
// how you know each other, and what you can do) and the "edit your profile" form.

import { api, live, session } from './api.js';
import { $, el, face, toast, timeAgo, monthYear, colorPicker, dismissable } from './ui.js';
import { suggestUsername, typedUsername } from './signin.js';

let open_ = null; // { userId, anchor, close, refresh }

// If they accept, unfriend you, come online or join a session while their card is open, it updates.
live.on('friends', () => open_?.refresh?.().catch(() => {}));

/**
 * Show someone's profile card next to `anchor` (or centered without one).
 * @param {string} userId
 * @param {{
 *   anchor?: HTMLElement,
 *   user?: object,                 what's already known, shown while the rest loads
 *   here?: () => string|null,      (in a session) where they are right now: "On Pattern 2 · editing Bass"
 *   actions?: (p) => Array<{ label: string, run: () => any, primary?: boolean, title?: string }>,
 *   onChange?: (p) => void,        their relationship to you changed
 * }} opts
 */
export async function openProfile(userId, opts = {}) {
  if (open_?.userId === userId && open_.anchor === opts.anchor) return closeProfile(); // a second click closes it
  closeProfile();
  const card = $('profileCard');
  const state = { userId, anchor: opts.anchor ?? null, close: null, profile: null };
  open_ = state;
  const stop = dismissable(card, closeProfile, { ignore: [opts.anchor] });
  state.close = () => {
    stop();
    card.hidden = true;
    card.replaceChildren();
  };

  const draw = () => {
    if (open_ !== state) return;
    card.replaceChildren(...render(state.profile ?? { user: opts.user, loading: true }, opts, refresh).filter(Boolean));
    card.hidden = false;
    place(card, opts.anchor);
  };
  const refresh = async (profile) => {
    const next = profile ?? (await api.get(`/api/users/${encodeURIComponent(userId)}`));
    if (open_ !== state) return;
    const changed = state.profile && state.profile.relation !== next.relation;
    state.profile = next;
    draw();
    if (profile || changed) opts.onChange?.(next);
  };
  state.refresh = () => refresh();
  if (opts.user) draw();
  try {
    await refresh();
  } catch (err) {
    if (open_ !== state) return;
    toast(err.message);
    closeProfile();
  }
}

export function closeProfile() {
  open_?.close();
  open_ = null;
}

/** The card's contents for a profile from GET /api/users/:id. */
function render(p, opts, refresh) {
  const u = p.user;
  const self = p.relation === 'self' || u.id === session.user?.id;
  const busy = (fn) => async (e) => {
    const button = e.currentTarget; // (null once we've awaited)
    button.disabled = true;
    try {
      await fn();
    } catch (err) {
      toast(err.message);
    }
    button.disabled = false;
  };
  const friendAction = (call, done) =>
    busy(async () => {
      const res = await call();
      await refresh(res.profile);
      done?.(res);
    });

  const relation = u.guest
    ? el('span', { class: 'pill' }, 'Guest')
    : {
        friends: el('span', { class: 'pill ok' }, '✓ Friends'),
        requested: el('span', { class: 'pill' }, 'Friend request sent'),
        incoming: el('span', { class: 'pill warn' }, 'Wants to be friends'),
      }[p.relation];
  const iAmGuest = !!session.user?.guest;

  const facts = [];
  if (u.created && !u.guest) facts.push(`Joined ${monthYear(u.created)}`);
  if (!self && p.together) facts.push(`${p.together} project${p.together === 1 ? '' : 's'} together`);
  if (!self && p.mutual) facts.push(`${p.mutual} mutual friend${p.mutual === 1 ? '' : 's'}`);
  if (p.relation === 'friends' && p.since) facts.push(`Friends since ${monthYear(p.since)}`);

  const here = opts.here?.();
  const status =
    here ??
    (p.status === 'session'
      ? `In “${p.session.title}”${sessionWith(p.session)}`
      : p.status === 'online'
        ? 'Online'
        : p.status === 'offline' && p.seen
          ? `Last seen ${timeAgo(p.seen)}`
          : null);

  const buttons = [];
  if (!p.loading && !self) {
    const friends = () => toast(`You and ${u.name} are friends now`);
    const button = (cls, action, label, call, done) => el('button', { class: `${cls} small`, 'data-action': action, onclick: friendAction(call, done) }, label);
    if (p.relation === 'none' && iAmGuest && !u.guest) {
      buttons.push(el('button', { class: 'ghost small', onclick: () => (closeProfile(), openUpgrade()) }, 'Create an account to add friends'));
    } else if (p.relation === 'none' && !u.guest) {
      buttons.push(
        button('primary', 'friend', '+ Add friend', () => api.post('/api/friends', { id: u.id }), (res) =>
          res.relation === 'friends' ? friends() : toast(`Friend request sent to ${u.name}`),
        ),
      );
    }
    if (p.relation === 'incoming') {
      buttons.push(button('primary', 'accept', 'Accept', () => api.post(`/api/friends/${u.id}/accept`), friends));
      buttons.push(button('ghost', 'decline', 'Decline', () => api.post(`/api/friends/${u.id}/decline`)));
    }
    if (p.relation === 'requested') buttons.push(button('ghost', 'cancel', 'Cancel request', () => api.del(`/api/friends/${u.id}`)));
  }
  for (const a of (!p.loading && opts.actions?.(p)) || []) {
    buttons.push(el('button', { class: a.primary ? 'primary small' : 'ghost small', title: a.title ?? null, onclick: busy(async () => (await a.run()) !== false && closeProfile()) }, a.label));
  }
  if (self) {
    if (iAmGuest) buttons.push(el('button', { class: 'primary small', 'data-action': 'upgrade', onclick: () => (closeProfile(), openUpgrade()) }, 'Create account'));
    buttons.push(el('button', { class: 'ghost small', onclick: () => (closeProfile(), openProfileEditor()) }, 'Edit profile'));
    buttons.push(el('button', { class: 'ghost small', onclick: signOut }, 'Sign out'));
  }

  return [
    el(
      'div',
      { class: 'pc-head' },
      face(u, { size: 56 }),
      el('div', { class: 'pc-names' }, el('h3', { class: 'pc-name' }, u.name, self ? el('span', { class: 'hint' }, ' (you)') : null), el('span', { class: 'pc-user' }, `@${u.username}`), relation ?? null),
    ),
    u.bio ? el('p', { class: 'pc-bio' }, u.bio) : null,
    status ? el('p', { class: `pc-status ${p.status === 'offline' && !here ? '' : 'live'}` }, status) : null,
    facts.length ? el('p', { class: 'pc-facts hint' }, facts.join(' · ')) : null,
    buttons.length ? el('div', { class: 'pc-actions' }, ...buttons) : null,
    p.relation === 'friends'
      ? el(
          'button',
          {
            class: 'pc-unfriend linklike',
            onclick: busy(async () => {
              if (!confirm(`Remove ${u.name} from your friends?`)) return;
              await refresh((await api.del(`/api/friends/${u.id}`)).profile);
            }),
          },
          'Unfriend',
        )
      : null,
  ];
}

/** " with you and 2 others" for a friend's session. */
function sessionWith(s) {
  const others = s.people - 1;
  if (others < 1) return '';
  const withMe = s.with?.some((u) => u.id === session.user?.id);
  const rest = others - (withMe ? 1 : 0);
  const parts = [withMe ? 'you' : null, rest ? `${rest} other${rest === 1 ? '' : 's'}` : null].filter(Boolean);
  return ` with ${parts.join(' and ')}`;
}

function place(card, anchor) {
  const w = card.offsetWidth;
  const h = card.offsetHeight;
  const pad = 8;
  let left;
  let top;
  if (anchor?.isConnected) {
    const r = anchor.getBoundingClientRect();
    left = r.right - w; // most people are listed top right, so the card hangs to the left
    if (left < pad) left = r.left;
    top = r.bottom + 8;
    if (top + h > innerHeight - pad) top = Math.max(pad, r.top - h - 8);
  } else {
    left = (innerWidth - w) / 2;
    top = Math.max(pad, innerHeight * 0.18);
  }
  card.style.left = `${Math.round(Math.min(Math.max(pad, left), innerWidth - w - pad))}px`;
  card.style.top = `${Math.round(Math.min(Math.max(pad, top), innerHeight - h - pad))}px`;
}

export async function signOut() {
  if (
    session.user?.guest &&
    !confirm(
      'You’re a guest, so signing out deletes this guest account. Your projects stay with the people in them, but you won’t be able to get back to them as yourself.\n\nCreate an account first to keep them. Sign out anyway?',
    )
  )
    return;
  await api.post('/api/auth/logout').catch(() => {});
  location.href = '/';
}

/** Swap in the server's latest copy of me (keeping the same object, which other modules hold). */
function updateMe(user) {
  for (const k of Object.keys(session.user)) if (!(k in user)) delete session.user[k]; // e.g. `guest` after making an account
  Object.assign(session.user, user);
  for (const fn of listeners) fn(session.user);
}

// ------------------------------------------------------------------ editing your own profile

const listeners = new Set();
/** Called with the updated user after they save their profile. */
export const onProfileSaved = (fn) => listeners.add(fn);

export function openProfileEditor() {
  const me = session.user;
  let color = me.color;
  $('pfName').value = me.name;
  $('pfUsername').value = me.username;
  $('pfBio').value = me.bio ?? '';
  $('pfWho').textContent = `@${me.username}`;
  // Guests have no username or password of their own yet.
  for (const x of $('profileForm').querySelectorAll('[data-member]')) x.hidden = !!me.guest;
  for (const x of $('profileForm').querySelectorAll('[data-guest]')) x.hidden = !me.guest;
  $('pfCurrent').value = '';
  $('pfNew').value = '';
  colorPicker($('pfColors'), color, (c) => (color = c));
  const error = (el_, err) => {
    el_.hidden = !err;
    el_.textContent = err?.message ?? '';
  };
  error($('pfError'));
  error($('pfPassError'));

  $('profileForm').onsubmit = async (e) => {
    e.preventDefault();
    error($('pfError'));
    try {
      const patch = { name: $('pfName').value, bio: $('pfBio').value, color };
      if (!me.guest) patch.username = $('pfUsername').value;
      updateMe((await api.patch('/api/me', patch)).user);
      $('profileModal').hidden = true;
      toast('Profile saved');
    } catch (err) {
      error($('pfError'), err);
    }
  };
  $('pfUsername').oninput = () => ($('pfUsername').value = typedUsername($('pfUsername').value));
  $('pfPassGo').onclick = async () => {
    error($('pfPassError'));
    try {
      await api.post('/api/me/password', { current: $('pfCurrent').value, password: $('pfNew').value });
      $('pfCurrent').value = '';
      $('pfNew').value = '';
      toast('Password changed. Other devices have been signed out.');
    } catch (err) {
      error($('pfPassError'), err);
    }
  };
  $('pfCancel').onclick = () => ($('profileModal').hidden = true);
  $('pfSignOut').onclick = signOut;
  $('pfUpgrade').onclick = () => {
    $('profileModal').hidden = true;
    openUpgrade();
  };
  $('profileModal').hidden = false;
  $('pfName').focus();
}

/** A guest picks a username and password: same person, same projects, now a full account. */
export function openUpgrade() {
  const me = session.user;
  if (!me.guest) return;
  $('upName').value = /^Guest \d+$/.test(me.name) ? '' : me.name;
  $('upUsername').value = suggestUsername(me.name.replace(/^Guest \d+$/, ''));
  $('upPassword').value = '';
  $('upError').hidden = true;
  $('upUsername').oninput = () => ($('upUsername').value = typedUsername($('upUsername').value));
  $('upgradeForm').onsubmit = async (e) => {
    e.preventDefault();
    $('upError').hidden = true;
    try {
      const { user } = await api.post('/api/auth/upgrade', { name: $('upName').value, username: $('upUsername').value, password: $('upPassword').value });
      updateMe(user);
      $('upgradeModal').hidden = true;
      toast(`Welcome, @${user.username}! Your account is set up, with everything you made as a guest.`);
    } catch (err) {
      $('upError').textContent = err.message;
      $('upError').hidden = false;
      ({ name: $('upName'), username: $('upUsername'), password: $('upPassword') })[err.field]?.focus();
    }
  };
  $('upCancel').onclick = () => ($('upgradeModal').hidden = true);
  $('upgradeModal').hidden = false;
  ($('upName').value ? $('upUsername') : $('upName')).focus();
}
