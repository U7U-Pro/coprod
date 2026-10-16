// Startup: find out who's signed in, then show the sign-in screen, your
// projects ("/"), or a session ("/?room=<id>"). Friend requests and invites
// can arrive on any screen.

import './style.css';
import { api, live, session } from './api.js';
import { toast, notify } from './ui.js';
import { roomFromUrl, onNavigate, goToRoom } from './nav.js';
import { showSignIn } from './signin.js';
import { openProfile } from './profile.js';

let shown = null; // 'home' | 'room'

async function route() {
  const room = roomFromUrl();
  if (room) {
    if (shown === 'room') return;
    shown = 'room';
    document.getElementById('homeScreen').hidden = true;
    document.body.classList.remove('at-home');
    await import('./main.js'); // the session: Yjs, audio, editors (loaded only when needed)
  } else {
    if (shown === 'home') return;
    shown = 'home';
    const { showHome } = await import('./home.js');
    showHome();
  }
}

function signedIn(user) {
  session.user = user;
  session.onSignedOut = () => {
    session.onSignedOut = null;
    toast('You’ve been signed out');
    setTimeout(() => location.reload(), 1200);
  };
  live.start();
  route();
}

// Things that need an answer, wherever you are.
live.on('request', ({ from }) =>
  notify({
    user: from,
    text: `${from.name} (@${from.username}) wants to be friends`,
    actions: [
      { label: 'Accept', primary: true, run: () => api.post(`/api/friends/${from.id}/accept`).then(() => toast(`You and ${from.name} are friends now`)) },
      { label: 'View profile', run: () => openProfile(from.id, { user: from }) },
    ],
    timeout: 30_000,
  }),
);
live.on('accepted', ({ by }) => notify({ user: by, text: `${by.name} accepted your friend request. You’re friends now.`, timeout: 8000 }));
live.on('invite', ({ from, room, title }) => {
  if (room === roomFromUrl()) return; // already here
  notify({
    user: from,
    text: `${from.name} invited you to jam on “${title}”`,
    actions: [
      { label: 'Join', primary: true, run: () => goToRoom(room) },
      { label: 'Not now', run: () => {} },
    ],
    timeout: 60_000,
  });
});

onNavigate(route);
window.addEventListener('popstate', () => location.reload()); // back/forward: start the page over on that screen

api.get('/api/me').then(
  ({ user }) => (user ? signedIn(user) : showSignIn({ room: roomFromUrl(), done: signedIn })),
  (err) => {
    document.getElementById('status').textContent = `${err.message} Reload to try again.`;
    document.getElementById('status').classList.add('show');
  },
);
