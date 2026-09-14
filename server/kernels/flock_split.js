// server/kernels/flock_split.js — 大群按速度方差分裂
export function flock_split(ctx, rng, params) {
  const { boids: bs, varThreshold } = params;
  if (bs.length < 4) return { groups: [bs], split: false };
  const mx = bs.reduce((s, b) => s + b.vx, 0) / bs.length;
  const my = bs.reduce((s, b) => s + b.vy, 0) / bs.length;
  const variance = bs.reduce((s, b) => s + (b.vx - mx) ** 2 + (b.vy - my) ** 2, 0) / bs.length;
  if (variance < varThreshold) return { groups: [bs], split: false, variance };
  const g1 = bs.filter(b => b.vx * mx + b.vy * my > 0);
  const g2 = bs.filter(b => !g1.includes(b));
  return { groups: [g1, g2], split: true, variance };
}
flock_split.__meta = { id: 'flock_split', branch: 'swarm', hardLimits: { count: 256 }, fallback: 'noop' };