// server/kernels/nelder_mead.js — Nelder-Mead 单纯形法（简化）
export function nelder_mead(ctx, rng, params) {
  const { start, evalF, alpha = 1, gamma = 2, rho = 0.5, iters = 32 } = params;
  const v = (p) => evalF(p.x, p.y);
  const simp = [start, { x: start.x + 1, y: start.y }, { x: start.x, y: start.y + 1 }];
  for (let it = 0; it < iters; it++) {
    simp.sort((a, b) => v(a) - v(b));
    const lo = simp[0], hi = simp[2];
    const mx = { x: (simp[0].x + simp[1].x) / 2, y: (simp[0].y + simp[1].y) / 2 };
    const xr = { x: mx.x + alpha * (mx.x - hi.x), y: mx.y + alpha * (mx.y - hi.y) };
    const fr = v(xr), fh = v(hi), fl = v(lo);
    if (fr < fl) { const xe = { x: mx.x + gamma * (xr.x - mx.x), y: mx.y + gamma * (xr.y - mx.y) }; simp[2] = v(xe) < fr ? xe : xr; }
    else if (fr < fh) { simp[2] = xr; }
    else { const xc = { x: mx.x + rho * (hi.x - mx.x), y: mx.y + rho * (hi.y - mx.y) }; simp[2] = v(xc) < fh ? xc : hi; }
  }
  simp.sort((a, b) => v(a) - v(b));
  return { best: simp[0], val: v(simp[0]) };
}
nelder_mead.__meta = { id: 'nelder_mead', branch: 'optimization', hardLimits: { iters: 128 }, fallback: 'noop' };