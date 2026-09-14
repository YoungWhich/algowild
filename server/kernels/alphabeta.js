// server/kernels/alphabeta.js — Alpha-Beta 剪枝
export function alphabeta(ctx, rng, params) {
  const { state, depth, maximizing, evalF, moves } = params;
  let best = maximizing ? -Infinity : Infinity, bm = null; let iter = 0;
  function rec(s, d, a, b, max) {
    iter++; if (iter > 4096) return 0;
    if (d === 0) return evalF(s);
    let v = max ? -Infinity : Infinity;
    for (const m of moves(s)) {
      const nv = rec(m.next, d - 1, a, b, !max);
      if (max) { v = Math.max(v, nv); a = Math.max(a, v); if (a >= b) break; }
      else { v = Math.min(v, nv); b = Math.min(b, v); if (a >= b) break; }
    }
    return v;
  }
  for (const m of moves(state)) {
    const v = rec(m.next, depth - 1, -Infinity, Infinity, !maximizing);
    if (maximizing ? v > best : v < best) { best = v; bm = m; }
  }
  return { move: bm, value: best };
}
alphabeta.__meta = { id: 'alphabeta', branch: 'game_decision', hardLimits: { iter: 4096, depth: 6 }, fallback: 'noop' };