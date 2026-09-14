// server/kernels/expectimax.js — 期望最大化（含概率分支）
export function expectimax(ctx, rng, params) {
  const { state, depth, evalF, moves, chance } = params;
  let iter = 0;
  function rec(s, d, type) {
    iter++; if (iter > 4096 || d === 0) return evalF(s);
    if (type === 'chance') {
      const cs = chance(s); let total = 0, w = 0;
      for (const c of cs) { w += c.p * rec(c.next, d - 1, 'max'); total += c.p; }
      return total ? w / total : 0;
    }
    const ms = moves(s); if (!ms.length) return evalF(s);
    if (type === 'max') { let v = -Infinity; for (const m of ms) v = Math.max(v, rec(m.next, d - 1, 'chance')); return v; }
    let v = Infinity; for (const m of ms) v = Math.min(v, rec(m.next, d - 1, 'chance')); return v;
  }
  const ms = moves(state); let best = null, bestV = -Infinity;
  for (const m of ms) { const v = rec(m.next, depth - 1, 'chance'); if (v > bestV) { bestV = v; best = m; } }
  return { move: best, value: bestV };
}
expectimax.__meta = { id: 'expectimax', branch: 'game_decision', hardLimits: { iter: 4096, depth: 5 }, fallback: 'noop' };