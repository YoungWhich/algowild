// server/kernels/hill_climb.js — 爬山
export function hill_climb(ctx, rng, params) {
  const { x, y, step, evalF, iters = 64, range = 1 } = params;
  let bx = x, by = y, bv = evalF(x, y);
  for (let i = 0; i < iters; i++) {
    const nx = x + (rng() * 2 - 1) * step * range;
    const ny = y + (rng() * 2 - 1) * step * range;
    const nv = evalF(nx, ny);
    if (nv < bv) { bx = nx; by = ny; bv = nv; }
  }
  return { x: bx, y: by, val: bv };
}
hill_climb.__meta = { id: 'hill_climb', branch: 'optimization', hardLimits: { iters: 256 }, fallback: 'noop' };