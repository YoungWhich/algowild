// server/kernels/predator_prey.js — Lotka-Volterra 离散化
export function predator_prey(ctx, rng, params) {
  const { prey: P0, pred: Q0, a = 1, b = 0.1, c = 0.1, d = 0.5, steps = 32 } = params;
  let P = P0, Q = Q0, log = [[P, Q]];
  let iter = 0;
  while (iter++ < steps) {
    const dP = a * P - b * P * Q, dQ = c * P * Q - d * Q;
    P = Math.max(0, P + dP); Q = Math.max(0, Q + dQ);
    log.push([P, Q]);
  }
  return { prey: P, pred: Q, log };
}
predator_prey.__meta = { id: 'predator_prey', branch: 'emergent', hardLimits: { steps: 1024 }, fallback: 'noop' };