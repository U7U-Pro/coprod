// The sign-in / create-account screen.

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

/**
 * Show the screen until someone signs in, then call `done(user)`.
 * @param {{ room?: string|null, done: (user: object) => void }} opts  room: they came from an invite link
 */
export function showSignIn({ room = null, done }) {
  let mode = 'login';
  let color = COLORS[Math.floor(Math.random() * COLORS.length)];
  let usernameEdited = false;
  const form = $('authForm');
  const fields = { name: $('authName'), username: $('authUsername'), email: $('authEmail'), password: $('authPassword') };

  colorPicker($('authColors'), color, (c) => (color = c));
  $('authLead').textContent = room ? 'Sign in to join the session you were invited to.' : 'Make beats together, live, in your browser.';

  const setMode = (m) => {
    mode = m;
    for (const b of $('authTabs').children) {
      b.classList.toggle('on', b.dataset.tab === m);
      b.setAttribute('aria-selected', String(b.dataset.tab === m));
    }
    for (const x of form.querySelectorAll('[data-for="signup"]')) x.hidden = m !== 'signup';
    fields.password.autocomplete = m === 'signup' ? 'new-password' : 'current-password';
    fields.password.placeholder = m === 'signup' ? 'At least 8 characters' : '';
    $('authGo').textContent = m === 'signup' ? 'Create account' : 'Sign in';
    showError(null);
    (m === 'signup' ? fields.name : fields.email).focus();
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
  fields.name.oninput = () => {
    if (!usernameEdited) fields.username.value = suggestUsername(fields.name.value);
  };
  fields.username.oninput = () => {
    usernameEdited = !!fields.username.value;
    fields.username.value = fields.username.value.toLowerCase().replace(/[^a-z0-9_]/g, '');
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    showError(null);
    const body = { email: fields.email.value, password: fields.password.value };
    if (mode === 'signup') Object.assign(body, { name: fields.name.value, username: fields.username.value, color });
    $('authGo').disabled = true;
    try {
      const { user } = await api.post(mode === 'signup' ? '/api/auth/signup' : '/api/auth/login', body);
      $('authScreen').hidden = true;
      fields.password.value = '';
      done(user);
    } catch (err) {
      // Someone who tries to sign up with an existing email probably wants to sign in.
      if (err.status === 409 && err.field === 'email') setMode('login');
      showError(err);
    } finally {
      $('authGo').disabled = false;
    }
  };

  $('authScreen').hidden = false;
  setMode(room ? 'signup' : 'login'); // invite links mostly bring new people
}
