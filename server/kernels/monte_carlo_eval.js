// server/kernels/monte_carlo_eval.js — Monte Carlo 评估
export function monte_carlo_eval(ctx, rng, params) {
  const { state, moves, evalF, samples = 32, rollout = 8 } = params;
  let total = 0; let iter = 0;
  for (let i = 0; i < samples && iter++ < 4096; i++) {
    let cur = state, d = 0; let s = evalF(cur);
    while (d++ < rollout) {
      const ms = moves(cur); if (!ms.length) break;
      cur = ms[Math.floor(rng() * ms.length)]; s = evalF(cur);
    }
    total += s;
  }
  return { avg: total / samples };
}
monte_carlo_eval.__meta = { id: 'monte_carlo_eval', branch: 'game_decision', hardLimits: { samples: 256, iter: 4096 }, fallback: 'noop' };