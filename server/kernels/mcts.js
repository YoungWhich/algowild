// server/kernels/mcts.js — 蒙特卡洛树搜索（轻量）
export function mcts(ctx, rng, params) {
  const { state, moves, iters = 64, playout = 8 } = params;
  const stats = new Map();
  let total_ = 0;
  function key(m) { return m.id; }
  for (let it = 0; it < iters; it++) {
    const ms = moves(state); if (!ms.length) break;
    let pick = null, bestU = -Infinity;
    for (const m of ms) {
      const k = key(m), s = stats.get(k) || { n: 0, w: 0 };
      const u = s.n ? s.w / s.n + Math.sqrt(2 * Math.log(total_ + 1) / s.n) : Infinity;
      if (u > bestU) { bestU = u; pick = m; }
    }
    let val = 0;
    for (let p = 0; p < playout; p++) {
      let cur = pick.next, d = 0;
      while (d++ < 16) {
        const next = moves(cur); if (!next.length) break;
        cur = next[Math.floor(rng() * next.length)];
      }
      val += cur.score || 0;
    }
    const k = key(pick); const s = stats.get(k) || { n: 0, w: 0 };
    s.n++; s.w += val / playout; stats.set(k, s); total_++;
  }
  let bestM = null, bestN = -1;
  for (const [k, s] of stats) if (s.n > bestN) { bestN = s.n; bestM = moves(state).find(m => key(m) === k); }
  return { move: bestM, visits: Object.fromEntries(stats) };
}
mcts.__meta = { id: 'mcts', branch: 'game_decision', hardLimits: { iters: 128, playout: 16 }, fallback: 'noop' };