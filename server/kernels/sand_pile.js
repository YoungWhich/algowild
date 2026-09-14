// server/kernels/sand_pile.js — Bak-Tang-Wiesenfeld 沙堆
export function sand_pile(ctx, rng, params) {
  const { grid, threshold = 4 } = params;
  const W = grid.length, H = grid[0].length;
  const g = grid.map(r => r.slice());
  let topple = 0, iter = 0;
  let changed = true;
  while (changed && iter++ < 256) {
    changed = false;
    for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) {
      if (g[x][y] >= threshold) {
        g[x][y] -= 4; topple++;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < W && ny < H) g[nx][ny]++;
        }
        changed = true;
      }
    }
  }
  return { grid: g, topple };
}
sand_pile.__meta = { id: 'sand_pile', branch: 'emergent', hardLimits: { w: 64, h: 64, iter: 256 }, fallback: 'noop' };