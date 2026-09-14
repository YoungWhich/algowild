// server/kernels/bfs.js — 广度优先
import { NEI4 } from '../util.js';
export function bfs(ctx, rng, params) {
  const { sx, sy, blocked } = params;
  const visited = new Set([sx + ',' + sy]);
  const queue = [[sx, sy]];
  const order = [[sx, sy]];
  let iter = 0;
  while (queue.length && iter++ < 2048) {
    const [x, y] = queue.shift();
    for (const [dx, dy] of NEI4) {
      const nx = x + dx, ny = y + dy;
      const k = nx + ',' + ny;
      if (visited.has(k) || (blocked && blocked(nx, ny))) continue;
      visited.add(k); order.push([nx, ny]); queue.push([nx, ny]);
    }
  }
  return { order, visitedCount: visited.size };
}
bfs.__meta = { id: 'bfs', branch: 'graph_search', hardLimits: { iter: 2048 }, fallback: 'noop' };