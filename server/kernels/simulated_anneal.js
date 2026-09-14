// server/kernels/simulated_anneal.js — 模拟退火
export function simulated_anneal(ctx, rng, params) {
  const { x, y, evalF, T0 = 1, cool = 0.95, iters = 128 } = params;
  let bx = x, by = y, bv = evalF(x, y), cx = x, cy = y, cv = bv, T = T0;
  for (let i = 0; i < iters; i++) {
    T *= cool;
    const nx = cx + (rng() * 2 - 1) * T;
    const ny = cy + (rng() * 2 - 1) * T;
    const nv = evalF(nx, ny);
    const dE = nv - cv;
    if (dE < 0 || rng() < Math.exp(-dE / Math.max(0.0001, T))) { cx = nx; cy = ny; cv = nv; }
    if (cv < bv) { bx = cx; by = cy; bv = cv; }
  }
  return { x: bx, y: by, val: bv };
}
simulated_anneal.__meta = { id: 'simulated_anneal', branch: 'optimization', hardLimits: { iters: 1024 }, fallback: 'noop' };