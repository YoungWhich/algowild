// server/kernels/bidirectional.js — 双向搜索（同时从两端展开）
import { NEI4 } from '../util.js';
export function bidirectional(ctx, rng, params) {
  const { sx, sy, gx, gy, blocked } = params;
  const sVis = new Set([sx + ',' + sy]);
  const gVis = new Set([gx + ',' + gy]);
  let sFront = [[sx, sy]], gFront = [[gx, gy]];
  let iter = 0;
  while (sFront.length && gFront.length && iter++ < 2048) {
    const nf = [];
    for (const [x, y] of sFront) for (const [dx, dy] of NEI4) {
      const nx = x + dx, ny = y + dy;
      const k = nx + ',' + ny;
      if (sVis.has(k) || (blocked && blocked(nx, ny))) continue;
      sVis.add(k); nf.push([nx, ny]); if (gVis.has(k)) return { path: [[sx, sy], 'meet', [nx, ny], [gx, gy]] };
    }
    sFront = nf; nf.length = 0;
    for (const [x, y] of gFront) for (const [dx, dy] of NEI4) {
      const nx = x + dx, ny = y + dy;
      const k = nx + ',' + ny;
      if (gVis.has(k) || (blocked && blocked(nx, ny))) continue;
      gVis.add(k); nf.push([nx, ny]); if (sVis.has(k)) return { path: [[sx, sy], 'meet', [nx, ny], [gx, gy]] };
    }
    gFront = nf;
  }
  return { path: [] };
}
bidirectional.__meta = { id: 'bidirectional', branch: 'graph_search', hardLimits: { iter: 2048 }, fallback: 'noop' };