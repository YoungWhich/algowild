// server/kernels/idastar.js — 迭代加深 A*
import { heur, NEI4 } from '../util.js';
export function idastar(ctx, rng, params) {
  const { sx, sy, gx, gy, blocked } = params;
  const h0 = heur(sx, sy, gx, gy);
  let bound = h0, path = [[sx, sy]];
  let iter = 0;
  while (iter++ < 1024) {
    const out = search(path, 0, bound, gx, gy, blocked, () => iter++);
    if (out === 'FOUND') return { path };
    if (out === Infinity) return { path: [] };
    bound = out;
  }
  return { path: [] };
}
function search(path, g, bound, gx, gy, blocked, tick) {
  tick();
  const [x, y] = path[path.length - 1];
  const f = g + heur(x, y, gx, gy);
  if (f > bound) return f;
  if (x === gx && y === gy) return 'FOUND';
  let min = Infinity;
  for (const [dx, dy] of NEI4) {
    const nx = x + dx, ny = y + dy;
    if (blocked && blocked(nx, ny)) continue;
    if (path.some(([px, py]) => px === nx && py === ny)) continue;
    path.push([nx, ny]);
    const t = search(path, g + 1, bound, gx, gy, blocked, tick);
    if (t === 'FOUND') return 'FOUND';
    if (t < min) min = t;
    path.pop();
  }
  return min;
}
idastar.__meta = { id: 'idastar', branch: 'graph_search', hardLimits: { iter: 1024, depth: 64 }, fallback: 'noop' };