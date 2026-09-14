// server/kernels/voronoi.js — Voronoi（朴素：按种子点最近分配）
export function voronoi(ctx, rng, params) {
  const { sites, w, h } = params;
  const cells = Array.from({ length: w }, () => new Array(h).fill(-1));
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
    let best = -1, bd = Infinity;
    for (let i = 0; i < sites.length; i++) {
      const d = (sites[i].x - x) ** 2 + (sites[i].y - y) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    cells[x][y] = best;
  }
  return { cells };
}
voronoi.__meta = { id: 'voronoi', branch: 'geometry', hardLimits: { w: 96, h: 96, sites: 32 }, fallback: 'noop' };