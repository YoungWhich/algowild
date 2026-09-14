// server/kernels/langtons_ant.js — Langton 蚂蚁
export function langtons_ant(ctx, rng, params) {
  const { cells, w, h, x, y, dir, steps } = params;
  const g = cells.map(r => r.slice());
  let cx = x, cy = y, d = dir || 0;
  const out = [];
  const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  let s = 0;
  while (s++ < (steps || 64)) {
    const c = g[cx][cy];
    d = (d + (c ? 1 : 3)) % 4;
    g[cx][cy] = c ? 0 : 1;
    cx = (cx + dirs[d][0] + w) % w; cy = (cy + dirs[d][1] + h) % h;
    out.push([cx, cy, d, g[cx][cy]]);
  }
  return { cells: g, path: out };
}
langtons_ant.__meta = { id: 'langtons_ant', branch: 'classic_rules', hardLimits: { steps: 256 }, fallback: 'noop' };