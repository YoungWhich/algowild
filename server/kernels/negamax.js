// server/kernels/negamax.js — Negamax（统一符号）
export function negamax(ctx, rng, params) {
  const { state, depth, evalF, moves } = params;
  let iter = 0;
  function rec(s, d) {
    iter++; if (iter > 4096 || d === 0) return evalF(s);
    const ms = moves(s); if (!ms.length) return evalF(s);
    let v = -Infinity;
    for (const m of ms) v = Math.max(v, -rec(m.next, d - 1));
    return v;
  }
  const ms = moves(state); let best = null, bestV = -Infinity;
  for (const m of ms) { const v = -rec(m.next, depth - 1); if (v > bestV) { bestV = v; best = m; } }
  return { move: best, value: bestV };
}
negamax.__meta = { id: 'negamax', branch: 'game_decision', hardLimits: { iter: 4096, depth: 6 }, fallback: 'noop' };