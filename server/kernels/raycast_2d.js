// server/kernels/raycast_2d.js — 2D DDA 射线投射
export function raycast_2d(ctx, rng, params) {
  const { ox, oy, tdx, tdy, maxDist, block } = params;
  let x = ox, y = oy, dist = 0; const step = 0.25; let hit = false;
  while (dist < maxDist) {
    x += tdx * step; y += tdy * step; dist += step;
    const ix = Math.floor(x), iy = Math.floor(y);
    if (block && block(ix, iy)) { hit = true; break; }
  }
  return { x, y, dist, hit };
}
raycast_2d.__meta = { id: 'raycast_2d', branch: 'geometry', hardLimits: { steps: 1024 }, fallback: 'noop' };