// The home screen: your projects (newest first, with who's in them right now)
// and your friends (who's online, who's in a session you can join).

import { api, live, session, importCopr, exportCopr } from './api.js';
import { $, el, face, toast, timeAgo, dismissable, saveBlob } from './ui.js';
import { openProfile, onProfileSaved, openUpgrade } from './profile.js';
import { goToRoom } from './nav.js';

const data = { projects: null, friends: null };
let refreshTimer = null;
let menuClose = null;

export function showHome() {
  document.body.classList.add('at-home');
  $('homeScreen').hidden = false;
  document.title = 'Your projects · coprod';
  drawMe();
  let wasGuest = !!session.user.guest;
  onProfileSaved((me) => {
    drawMe();
    if (wasGuest !== !!me.guest) loadFriends(); // a guest just made an account: friends are open to them now
    wasGuest = !!me.guest;
  });

  $('homeNew').onclick = newProject;
  $('homeOpen').onclick = () => {
    $('coprInput').value = '';
    $('coprInput').click();
  };
  $('coprInput').onchange = () => $('coprInput').files[0] && openFile($('coprInput').files[0]);
  setupSearch();
  setupDrop();

  // Live: friends coming and going, requests answered. Plus a slow refresh for
  // projects other people are joining (nobody tells us about non-friends).
  // (Opening a project from here keeps this page, so stop once we've left the home screen.)
  const here = () => document.body.classList.contains('at-home') && document.visibilityState === 'visible';
  live.on('friends', () => here() && scheduleRefresh());
  live.on('open', () => here() && scheduleRefresh());
  setInterval(() => here() && loadProjects(), 30_000);
  document.addEventListener('visibilitychange', () => here() && scheduleRefresh());
  loadProjects();
  loadFriends();
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    loadFriends();
    loadProjects();
  }, 150);
}

function drawMe() {
  const me = session.user;
  const b = $('homeMe');
  b.replaceChildren(...[face(me, { size: 30 }), el('span', { class: 'me-name' }, me.name), me.guest && el('span', { class: 'pill' }, 'Guest')].filter(Boolean));
  b.title = me.guest ? `${me.name} (guest)` : `${me.name} (@${me.username})`;
  b.onclick = () => openProfile(me.id, { anchor: b, user: me });
}

async function newProject() {
  $('homeNew').disabled = true;
  try {
    goToRoom((await api.post('/api/projects')).id);
  } catch (err) {
    toast(err.message);
    $('homeNew').disabled = false;
  }
}

async function openFile(file) {
  toast(`Opening ${file.name}…`);
  try {
    const res = await importCopr(file);
    if (res.skipped) toast(`${res.skipped} sample${res.skipped === 1 ? '' : 's'} in the file couldn’t be added`);
    goToRoom(res.id);
  } catch (err) {
    toast(err.message);
  }
}

function setupDrop() {
  const isFile = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  $('homeScreen').addEventListener('dragover', (e) => {
    if (!isFile(e)) return;
    e.preventDefault();
    $('homeScreen').classList.add('dropping');
  });
  $('homeScreen').addEventListener('dragleave', (e) => {
    if (!$('homeScreen').contains(e.relatedTarget)) $('homeScreen').classList.remove('dropping');
  });
  $('homeScreen').addEventListener('drop', (e) => {
    if (!isFile(e)) return;
    e.preventDefault();
    $('homeScreen').classList.remove('dropping');
    const file = [...e.dataTransfer.files].find((f) => /\.copr$/i.test(f.name));
    if (file) openFile(file);
    else toast('Drop a .copr project file to open it');
  });
}

// ------------------------------------------------------------------ projects

async function loadProjects() {
  try {
    data.projects = (await api.get('/api/projects')).projects;
    drawProjects();
  } catch (err) {
    if (!data.projects) $('projectList').replaceChildren(el('p', { class: 'hint' }, err.message));
  }
}

const names = (users) => {
  const n = users.map((u) => (u.id === session.user.id ? 'you' : u.name));
  return n.length <= 2 ? n.join(' and ') : `${n.slice(0, 2).join(', ')} and ${n.length - 2} more`;
};

function drawProjects() {
  const list = data.projects;
  $('homeCount').textContent = list.length ? String(list.length) : '';
  if (!list.length) {
    $('projectList').replaceChildren(
      el(
        'div',
        { class: 'empty' },
        el('p', {}, 'No projects yet.'),
        el('p', { class: 'hint' }, 'Start a new one, open a .copr file, or join a friend’s session. Every project you open shows up here.'),
      ),
    );
    return;
  }
  $('projectList').replaceChildren(
    ...list.map((p) => {
      const here = p.here.filter((u) => u.id !== session.user.id);
      const open = () => goToRoom(p.id);
      return el(
        'article',
        {
          class: `project-card${here.length ? ' live' : ''}`,
          tabindex: '0',
          dataset: { id: p.id },
          onclick: (e) => !e.target.closest('button') && open(),
          onkeydown: (e) => e.key === 'Enter' && e.target === e.currentTarget && open(),
        },
        el(
          'div',
          { class: 'pj-top' },
          el('h3', {}, p.title),
          el('button', { type: 'button', class: 'pj-more', 'aria-label': `More for ${p.title}`, onclick: (e) => projectMenu(e.currentTarget, p) }, '⋯'),
        ),
        el('p', { class: 'hint' }, `Edited ${timeAgo(p.updated)}`, p.owner && p.owner !== 'you' ? ` · ${p.owner.name}’s project` : ''),
        el(
          'div',
          { class: 'pj-people' },
          p.with.length
            ? [
                el('span', { class: 'faces' }, ...p.with.slice(0, 5).map((u) => face(u, { size: 24, title: u.name }))),
                el('span', { class: 'hint' }, p.members > 5 ? `+${p.members - 5}` : `with ${names(p.with)}`),
              ]
            : el('span', { class: 'hint' }, 'Just you so far'),
        ),
        here.length ? el('p', { class: 'pj-live' }, `${names(here)} ${here.length === 1 ? 'is' : 'are'} here now`) : null,
      );
    }),
  );
}

function projectMenu(button, p) {
  menuClose?.();
  const close = () => {
    stop();
    menu.remove();
    menuClose = null;
  };
  const item = (label, run, cls = '') =>
    el(
      'button',
      {
        type: 'button',
        class: cls,
        onclick: async () => {
          close();
          try {
            await run();
          } catch (err) {
            toast(err.message);
          }
        },
      },
      label,
    );
  const menu = el(
    'div',
    { class: 'menu', role: 'menu' },
    item('Open', () => goToRoom(p.id)),
    item('Download .copr', async () => {
      toast('Preparing the file…');
      const { blob, name } = await exportCopr(p.id);
      saveBlob(blob, name);
    }),
    item('Copy invite link', async () => {
      await navigator.clipboard.writeText(`${location.origin}/?room=${p.id}`);
      toast('Link copied. Anyone signed in with it can join and edit.');
    }),
    item(
      'Remove from my list',
      async () => {
        await api.del(`/api/projects/${p.id}`);
        data.projects = data.projects.filter((x) => x.id !== p.id);
        drawProjects();
        toast('Removed. It comes back if you open it again.');
      },
      'danger',
    ),
  );
  button.closest('.project-card').append(menu);
  const stop = dismissable(menu, close, { ignore: [button] });
  menuClose = close;
}

// ------------------------------------------------------------------ friends

async function loadFriends() {
  if (session.user.guest) return drawGuestFriends();
  try {
    data.friends = await api.get('/api/friends');
    drawFriends();
  } catch (err) {
    if (!data.friends) $('friendList').replaceChildren(el('p', { class: 'hint' }, err.message));
  }
}

function statusLine(f) {
  if (f.status === 'session') {
    const w = f.session.with;
    return `In “${f.session.title}”${w.length ? ` with ${names(w)}` : ''}`;
  }
  if (f.status === 'online') return 'Online';
  return f.seen ? `Last seen ${timeAgo(f.seen)}` : 'Offline';
}

const joinAction = (f) => (f.status === 'session' ? [{ label: 'Join their session', primary: true, run: () => goToRoom(f.session.room) }] : []);

function personRow(user, { status = null, line = '', buttons = [], profile = {} } = {}) {
  return el(
    'div',
    { class: 'person', dataset: { user: user.username } },
    el(
      'button',
      { type: 'button', class: 'person-main', onclick: (e) => openProfile(user.id, { anchor: e.currentTarget, user, onChange: scheduleRefresh, ...profile }) },
      face(user, { size: 34, status }),
      el('span', { class: 'person-text' }, el('b', {}, user.name), el('span', { class: 'hint' }, line || `@${user.username}`)),
    ),
    ...buttons,
  );
}

const small = (label, cls, run) =>
  el(
    'button',
    {
      type: 'button',
      class: `${cls} small`,
      onclick: async (e) => {
        const b = e.currentTarget;
        b.disabled = true;
        try {
          await run();
        } catch (err) {
          toast(err.message);
        }
        b.disabled = false;
        scheduleRefresh();
      },
    },
    label,
  );

/** Guests have no friends list: say what an account gets you. */
function drawGuestFriends() {
  $('friendCount').textContent = '';
  $('friendSearch').closest('.friend-add').hidden = true;
  $('friendRequests').replaceChildren();
  $('friendSent').replaceChildren();
  $('friendList').replaceChildren(
    el(
      'div',
      { class: 'guest-card' },
      el('p', {}, 'You’re a guest. Create an account to add friends, see when they’re jamming, and invite them in.'),
      el('p', { class: 'hint' }, 'Everything you’ve made as a guest comes with you. As a guest, your projects are only on this browser.'),
      el('button', { type: 'button', class: 'primary', 'data-action': 'upgrade', onclick: openUpgrade }, 'Create account'),
    ),
  );
}

function drawFriends() {
  $('friendSearch').closest('.friend-add').hidden = false;
  const { friends, incoming, outgoing } = data.friends;
  const live_ = friends.filter((f) => f.status !== 'offline').length;
  $('friendCount').textContent = friends.length ? `${live_} of ${friends.length} online` : '';

  $('friendRequests').replaceChildren(
    ...(incoming.length
      ? [
          el('h3', { class: 'side-head' }, `Friend requests · ${incoming.length}`),
          ...incoming.map((r) =>
            personRow(r.user, {
              line: `@${r.user.username} · ${timeAgo(r.at)}`,
              buttons: [
                small('Accept', 'primary', () => api.post(`/api/friends/${r.user.id}/accept`).then(() => toast(`You and ${r.user.name} are friends now`))),
                small('Decline', 'ghost', () => api.post(`/api/friends/${r.user.id}/decline`)),
              ],
            }),
          ),
        ]
      : []),
  );

  $('friendList').replaceChildren(
    ...(friends.length
      ? friends.map((f) =>
          personRow(f.user, {
            status: f.status,
            line: statusLine(f),
            buttons: f.status === 'session' ? [small('Join', 'primary', () => goToRoom(f.session.room))] : [],
            profile: { actions: () => joinAction(f) },
          }),
        )
      : [el('p', { class: 'hint empty-friends' }, 'No friends yet. Look someone up by their @username above, or click a person’s picture in a session to add them.')]),
  );

  $('friendSent').replaceChildren(
    ...(outgoing.length
      ? [
          el('h3', { class: 'side-head' }, 'Waiting for an answer'),
          ...outgoing.map((r) => personRow(r.user, { line: `Asked ${timeAgo(r.at)}`, buttons: [small('Cancel', 'ghost', () => api.del(`/api/friends/${r.user.id}`))] })),
        ]
      : []),
  );
}

function setupSearch() {
  const input = $('friendSearch');
  const box = $('friendResults');
  let timer = null;
  let seq = 0;
  const hide = () => (box.hidden = true);
  const run = async () => {
    const q = input.value.trim();
    if (q.replace(/^@/, '').length < 2) return hide();
    const mine = ++seq;
    try {
      const { users } = await api.get(`/api/users?q=${encodeURIComponent(q)}`);
      if (mine !== seq) return; // a newer search is on its way
      const label = { none: null, requested: 'Requested', incoming: 'Wants to be friends', friends: 'Friends' };
      box.replaceChildren(
        ...(users.length
          ? users.map(({ user, relation }) =>
              personRow(user, {
                line: `@${user.username}${label[relation] ? ` · ${label[relation]}` : ''}`,
                buttons:
                  relation === 'none'
                    ? [small('Add', 'primary', async () => {
                        const res = await api.post('/api/friends', { id: user.id });
                        toast(res.relation === 'friends' ? `You and ${user.name} are friends now` : `Friend request sent to ${user.name}`);
                        run();
                      })]
                    : relation === 'incoming'
                      ? [small('Accept', 'primary', () => api.post(`/api/friends/${user.id}/accept`).then(run))]
                      : [],
              }),
            )
          : [el('p', { class: 'hint' }, 'Nobody by that name yet.')]),
      );
      box.hidden = false;
    } catch (err) {
      toast(err.message);
    }
  };
  input.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(run, 200);
  };
  input.onfocus = () => input.value && run();
  input.onkeydown = (e) => e.key === 'Escape' && (input.value = '', hide());
  document.addEventListener('pointerdown', (e) => !e.target.closest('.friend-add') && !e.target.closest('#profileCard') && hide());
}
