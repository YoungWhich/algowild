// server/kernels/jump_point.js — JPS 跳点（简化版：按同行/列 4 邻跳）
import { heur, NEI4 } from '../util.js';
export function jump_point(ctx, rng, params) {
  const { sx, sy, gx, gy, blocked } = params;
  const open = [{ x: sx, y: sy, f: heur(sx, sy, gx, gy), p: null }];
  const seen = new Set(); let iter = 0;
  while (open.length && iter++ < 1024) {
    open.sort((a, b) => a.f - b.f);
    const cur = open.shift();
    if (cur.x === gx && cur.y === gy) {
      const path = []; let n = cur;
      while (n) { path.unshift([n.x, n.y]); n = n.p; } return { path };
    }
    seen.add(cur.x + ',' + cur.y);
    for (const [dx, dy] of NEI4) {
      const nx = cur.x + dx, ny = cur.y + dy;
      const k = nx + ',' + ny;
      if (seen.has(k) || (blocked && blocked(nx, ny))) continue;
      open.push({ x: nx, y: ny, f: heur(nx, ny, gx, gy), p: cur });
    }
  }
  return { path: [] };
}
jump_point.__meta = { id: 'jump_point', branch: 'graph_search', hardLimits: { iter: 1024 }, fallback: 'noop' };