// server/kernels/swarm_merge.js — 两群相遇融合
export function swarm_merge(ctx, rng, params) {
  const { a, b, threshold } = params;
  const cxA = a.reduce((s, p) => s + p.x, 0) / Math.max(1, a.length);
  const cyA = a.reduce((s, p) => s + p.y, 0) / Math.max(1, a.length);
  const cxB = b.reduce((s, p) => s + p.x, 0) / Math.max(1, b.length);
  const cyB = b.reduce((s, p) => s + p.y, 0) / Math.max(1, b.length);
  const d = Math.hypot(cxA - cxB, cyA - cyB);
  if (d > threshold) return { merged: a.concat(b), merged_: false };
  const merged = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i < a.length && i < b.length) merged.push({ x: (a[i].x + b[i].x) / 2, y: (a[i].y + b[i].y) / 2 });
    else if (i < a.length) merged.push(a[i]); else merged.push(b[i]);
  }
  return { merged, merged_: true, distance: d };
}
swarm_merge.__meta = { id: 'swarm_merge', branch: 'swarm', hardLimits: { count: 256 }, fallback: 'noop' };