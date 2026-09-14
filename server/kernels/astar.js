// server/kernels/astar.js — A* 寻路（4 邻接；blocked(nx,ny) 为 true 表示不可通行）
import { heur, NEI4 } from '../util.js';
class H { // 二叉堆（按 f 排序），避免大图重复入堆退化
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(n) { const a = this.a; a.push(n); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p].f <= a[i].f) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() { const a = this.a, t = a[0], l = a.pop(); if (a.length) { a[0] = l; let i = 0; for (;;) { const L = 2 * i + 1, R = 2 * i + 2; let s = i; if (L < a.length && a[L].f < a[s].f) s = L; if (R < a.length && a[R].f < a[s].f) s = R; if (s === i) break; [a[s], a[i]] = [a[i], a[s]]; i = s; } } return t; }
}
export function astar(ctx, rng, params) {
  const { sx, sy, gx, gy, blocked } = params;
  const open = new H(); open.push({ x: sx, y: sy, g: 0, f: heur(sx, sy, gx, gy), p: null });
  const g = new Map([[sx + ',' + sy, 0]]);
  let it = 0;
  while (open.size && it++ < 4096) {
    const c = open.pop();
    if (c.x === gx && c.y === gy) { const path = []; let n = c; while (n) { path.unshift([n.x, n.y]); n = n.p; } return { path }; }
    for (const [dx, dy] of NEI4) {
      const nx = c.x + dx, ny = c.y + dy, k = nx + ',' + ny, ng = c.g + 1;
      if (blocked && blocked(nx, ny)) continue;
      if ((g.get(k) ?? Infinity) <= ng) continue;
      g.set(k, ng); open.push({ x: nx, y: ny, g: ng, f: ng + heur(nx, ny, gx, gy), p: c });
    }
  }
  return { path: [] };
}
astar.__meta = { id: 'astar', branch: 'graph_search', hardLimits: { iter: 4096 }, fallback: 'noop' };
