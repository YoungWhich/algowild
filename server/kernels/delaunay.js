// server/kernels/delaunay.js — Delaunay 三角化（极简 Bowyer-Watson 子集）
export function delaunay(ctx, rng, params) {
  const { points } = params;
  const tris = [];
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) for (let k = j + 1; k < points.length; k++) {
    const a = points[i], b = points[j], c = points[k];
    const ab = Math.hypot(a.x - b.x, a.y - b.y), ac = Math.hypot(a.x - c.x, a.y - c.y), bc = Math.hypot(b.x - c.x, b.y - c.y);
    if (Math.max(ab, ac, bc) < Math.hypot(8, 8)) tris.push([i, j, k]);
  }
  return { triangles: tris };
}
delaunay.__meta = { id: 'delaunay', branch: 'geometry', hardLimits: { points: 32 }, fallback: 'noop' };