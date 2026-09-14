// server/kernels/dijkstra.js — Dijkstra 单源最短路
import { NEI4 } from '../util.js';
export function dijkstra(ctx, rng, params) {
  const { sx, sy, weight } = params;
  const dist = new Map();
  dist.set(sx + ',' + sy, 0);
  const pq = [{ x: sx, y: sy, d: 0 }];
  let iter = 0;
  while (pq.length && iter++ < 1024) {
    pq.sort((a, b) => a.d - b.d);
    const cur = pq.shift();
    const ck = cur.x + ',' + cur.y;
    if (cur.d > (dist.get(ck) ?? Infinity)) continue;
    for (const [dx, dy] of NEI4) {
      const nx = cur.x + dx, ny = cur.y + dy;
      const w = weight ? weight(nx, ny) : 1;
      const nd = cur.d + w;
      const nk = nx + ',' + ny;
      if (nd < (dist.get(nk) ?? Infinity)) { dist.set(nk, nd); pq.push({ x: nx, y: ny, d: nd }); }
    }
  }
  return { dist: Object.fromEntries(dist) };
}
dijkstra.__meta = { id: 'dijkstra', branch: 'graph_search', hardLimits: { iter: 1024 }, fallback: 'noop' };