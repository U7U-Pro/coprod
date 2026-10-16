// The sign-in screen: sign in, create an account, or continue as a guest.

import { api } from './api.js';
import { $, colorPicker } from './ui.js';
import { COLORS } from './shared/colors.js';

/** A username suggestion from a display name: "Ana María" -> "ana_maria". */
export function suggestUsername(name) {
  return String(name)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 20);
}

/** Usernames as you type them: lowercase letters, numbers and _ (a leading @ is dropped). */
export const typedUsername = (v) => v.toLowerCase().replace(/[^a-z0-9_]/g, '');

const BUTTON = { login: 'Sign in', signup: 'Create account', guest: 'Join as guest' };
const ENDPOINT = { login: '/api/auth/login', signup: '/api/auth/signup', guest: '/api/auth/guest' };

/**
 * Show the screen until someone is in, then call `done(user)`.
 * @param {{ room?: string|null, done: (user: object) => void }} opts  room: they came from an invite link
 */
export function showSignIn({ room = null, done }) {
  let mode = 'login';
  let color = COLORS[Math.floor(Math.random() * COLORS.length)];
  let usernameEdited = false;
  const form = $('authForm');
  const fields = { name: $('authName'), username: $('authUsername'), password: $('authPassword') };

  colorPicker($('authColors'), color, (c) => (color = c));
  $('authLead').textContent = room
    ? 'You’ve been invited to a session. Sign in, create an account, or jump in as a guest.'
    : 'Make beats together, live, in your browser.';

  const setMode = (m) => {
    mode = m;
    for (const b of $('authTabs').children) {
      b.classList.toggle('on', b.dataset.tab === m);
      b.setAttribute('aria-selected', String(b.dataset.tab === m));
    }
    for (const x of form.querySelectorAll('[data-for]')) x.hidden = !x.dataset.for.split(' ').includes(m);
    fields.password.autocomplete = m === 'signup' ? 'new-password' : 'current-password';
    fields.password.placeholder = m === 'signup' ? 'At least 8 characters' : '';
    fields.name.placeholder = m === 'guest' ? 'Optional: how people see you' : 'What people see, e.g. Ana Lucía';
    if (m === 'signup' && fields.username.value) usernameEdited = true; // keep what they typed to sign in
    $('authGo').textContent = BUTTON[m];
    showError(null);
    (m === 'login' ? fields.username : fields.name).focus();
  };

  function showError(err) {
    for (const f of Object.values(fields)) f.removeAttribute('aria-invalid');
    $('authError').hidden = !err;
    if (!err) return;
    $('authError').textContent = err.message;
    const field = fields[err.field];
    if (field && !field.closest('[hidden]')) {
      field.setAttribute('aria-invalid', 'true');
      field.focus();
    }
  }

  for (const b of $('authTabs').children) b.onclick = () => setMode(b.dataset.tab);
  $('authGuest').onclick = () => setMode('guest');
  $('authBack').onclick = () => setMode('login');
  fields.name.oninput = () => {
    if (mode === 'signup' && !usernameEdited) fields.username.value = suggestUsername(fields.name.value);
  };
  fields.username.oninput = () => {
    usernameEdited = !!fields.username.value;
    fields.username.value = typedUsername(fields.username.value);
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    showError(null);
    const body =
      mode === 'guest'
        ? { name: fields.name.value, color }
        : { username: fields.username.value, password: fields.password.value, ...(mode === 'signup' ? { name: fields.name.value, color } : {}) };
    $('authGo').disabled = true;
    try {
      const { user } = await api.post(ENDPOINT[mode], body);
      $('authScreen').hidden = true;
      fields.password.value = '';
      done(user);
    } catch (err) {
      showError(err);
    } finally {
      $('authGo').disabled = false;
    }
  };

  $('authScreen').hidden = false;
  setMode(room ? 'signup' : 'login'); // invite links mostly bring new people
}
