// server/kernels/reaction_diffusion.js — Gray-Scott 反应扩散
export function reaction_diffusion(ctx, rng, params) {
  const { u: uu, v: vv, w: W, h: H, Du = 0.16, Dv = 0.08, f = 0.044, k = 0.062 } = params;
  const u = uu.map(r => r.slice()), v = vv.map(r => r.slice());
  const nu = Array.from({ length: W }, () => new Array(H).fill(0));
  const nv = Array.from({ length: W }, () => new Array(H).fill(0));
  for (let x = 1; x < W - 1; x++) for (let y = 1; y < H - 1; y++) {
    nu[x][y] = uu[x][y] + Du * (uu[x + 1][y] + uu[x - 1][y] + uu[x][y + 1] + uu[x][y - 1] - 4 * uu[x][y]) - uu[x][y] * vv[x][y] * vv[x][y] + f * (1 - uu[x][y]);
    nv[x][y] = vv[x][y] + Dv * (vv[x + 1][y] + vv[x - 1][y] + vv[x][y + 1] + vv[x][y - 1] - 4 * vv[x][y]) + uu[x][y] * vv[x][y] * vv[x][y] - (f + k) * vv[x][y];
  }
  return { u: u.map(r => r.map(v => Math.max(0, Math.min(1, v)))), v: v.map(r => r.map(v => Math.max(0, Math.min(1, v)))) };
}
reaction_diffusion.__meta = { id: 'reaction_diffusion', branch: 'emergent', hardLimits: { w: 64, h: 64 }, fallback: 'noop' };