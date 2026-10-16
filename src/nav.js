// Which screen we're on. "/" is your projects; "/?room=<id>" is a session.

export const ROOM_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export function roomFromUrl() {
  const room = new URLSearchParams(location.search).get('room');
  return room && ROOM_NAME.test(room) ? room : null;
}

let router = null;
export const onNavigate = (fn) => (router = fn);

/** Open a session. From the home screen this keeps the page (and the click that unlocks audio). */
export function goToRoom(id) {
  const url = `/?room=${encodeURIComponent(id)}`;
  if (document.body.classList.contains('in-room')) {
    location.href = url; // a session page is set up for one room: start a fresh page
    return;
  }
  history.pushState(null, '', url);
  router?.();
}

export function goHome() {
  location.href = '/';
}
