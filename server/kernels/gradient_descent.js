// server/kernels/gradient_descent.js — 数值梯度下降
export function gradient_descent(ctx, rng, params) {
  const { x, y, grad, lr = 0.1, iters = 64, eps = 1e-3 } = params;
  let cx = x, cy = y;
  for (let i = 0; i < iters; i++) {
    const g = grad(cx, cy);
    cx -= lr * g.gx; cy -= lr * g.gy;
    if (Math.hypot(g.gx, g.gy) < eps) break;
  }
  return { x: cx, y: cy };
}
gradient_descent.__meta = { id: 'gradient_descent', branch: 'optimization', hardLimits: { iters: 1024 }, fallback: 'noop' };