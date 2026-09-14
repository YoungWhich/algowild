// server/kernels/pso.js — 粒子群优化（数值）
export function pso(ctx, rng, params) {
  const { swarm, w, c1, c2, iters } = params;
  for (const p of swarm) {
    if (p.bestVal === undefined || p.val < p.bestVal) { p.bestVal = p.val; p.bestPos = [p.x, p.y]; }
  }
  let g = swarm[0], gv = swarm[0].bestVal;
  for (const p of swarm) if (p.bestVal < gv) { gv = p.bestVal; g = p; }
  for (let it = 0; it < (iters || 8); it++) {
    for (const p of swarm) {
      p.vx = w * p.vx + c1 * rng() * (p.bestPos[0] - p.x) + c2 * rng() * (g.bestPos[0] - p.x);
      p.vy = w * p.vy + c1 * rng() * (p.bestPos[1] - p.y) + c2 * rng() * (g.bestPos[1] - p.y);
      p.x += p.vx; p.y += p.vy; p.val = p.eval ? p.eval(p.x, p.y) : p.x * p.x + p.y * p.y;
      if (p.val < p.bestVal) { p.bestVal = p.val; p.bestPos = [p.x, p.y]; }
    }
  }
  return { bestPos: g.bestPos, bestVal: g.bestVal };
}
pso.__meta = { id: 'pso', branch: 'swarm', hardLimits: { swarm: 128, iters: 32 }, fallback: 'noop' };