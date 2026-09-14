// server/kernels/convex_hull.js — 凸包（Graham 扫描）
export function convex_hull(ctx, rng, params) {
  const { points } = params;
  if (points.length < 3) return { hull: points.slice() };
  const pts = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lo = []; for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  const up = []; for (const p of pts.slice().reverse()) { while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  return { hull: lo.slice(0, -1).concat(up.slice(0, -1)) };
}
convex_hull.__meta = { id: 'convex_hull', branch: 'geometry', hardLimits: { points: 256 }, fallback: 'noop' };