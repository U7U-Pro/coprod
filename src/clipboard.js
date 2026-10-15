// One clipboard for the editors (piano roll, automation, arrangement), so
// notes copied in one pattern paste into another, points from one lane into
// another. It's per person and lives in this tab.

let content = null; // { kind: 'notes' | 'points' | 'clips', items: [...] }

export const clipboard = {
  set(kind, items) {
    content = { kind, items: structuredClone(items) };
  },
  get(kind) {
    return content?.kind === kind ? structuredClone(content.items) : null;
  },
};

/** Is this keydown a Ctrl/Cmd shortcut for `key`? */
export const shortcut = (e, key) => (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === key;

/** A drag rectangle in content coordinates, normalized. */
export function box(a, b) {
  return { x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y) };
}

/**
 * Simplify a drawn line (Ramer-Douglas-Peucker on y): keep the points that
 * matter. `pts` are [x, y] with x increasing; `eps` is the largest allowed
 * vertical error.
 */
export function simplify(pts, eps) {
  if (pts.length <= 2) return pts.slice();
  const [ax, ay] = pts[0];
  const [bx, by] = pts.at(-1);
  let worst = 0;
  let at = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i];
    const t = bx === ax ? 0 : (px - ax) / (bx - ax);
    const d = Math.abs(py - (ay + t * (by - ay)));
    if (d > worst) {
      worst = d;
      at = i;
    }
  }
  if (worst <= eps) return [pts[0], pts.at(-1)];
  return [...simplify(pts.slice(0, at + 1), eps).slice(0, -1), ...simplify(pts.slice(at), eps)];
}
