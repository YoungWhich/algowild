// server/kernels/minimax.js — 极小极大（递归版，硬限 depth=6）
export function minimax(ctx, rng, params) {
  const { state, depth, maximizing: max0, evalF, moves } = params;
  let best, iter = 0;
  function rec(s, d, max) {
    iter++; if (iter > 4096) return 0;
    if (d === 0) return evalF(s);
    const ms = moves(s);
    if (!ms.length) return evalF(s);
    let v = max ? -Infinity : Infinity;
    for (const m of ms) {
      const nv = rec(m.next, d - 1, !max);
      v = max ? Math.max(v, nv) : Math.min(v, nv);
    }
    return v;
  }
  best = max0 ? -Infinity : Infinity;
  let bm = null;
  for (const m of moves(state)) {
    const v = rec(m.next, depth - 1, !max0);
    if (max0 ? v > best : v < best) { best = v; bm = m; }
  }
  return { move: bm, value: best };
}
minimax.__meta = { id: 'minimax', branch: 'game_decision', hardLimits: { iter: 4096, depth: 6 }, fallback: 'noop' };