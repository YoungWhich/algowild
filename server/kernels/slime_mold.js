// server/kernels/slime_mold.js — 黏菌（Physarum-like 简化）
export function slime_mold(ctx, rng, params) {
  const { trails: T, w, h, agents, decay = 0.95 } = params;
  const next = T.map(r => r.map(v => v * decay));
  let iter = 0;
  for (const a of agents) {
    if (iter++ > 4096) break;
    const ax = Math.floor(a.x), ay = Math.floor(a.y);
    if (ax < 0 || ay < 0 || ax >= w || ay >= h) continue;
    let best = -Infinity, bdx = 0, bdy = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const nx = (ax + dx + w) % w, ny = (ay + dy + h) % h;
      const v = next[nx][ny] + 0.01;
      if (v > best) { best = v; bdx = dx; bdy = dy; }
    }
    a.x += bdx * 0.5; a.y += bdy * 0.5;
    const cx = Math.floor(a.x), cy = Math.floor(a.y);
    if (cx >= 0 && cy >= 0 && cx < w && cy < h) next[cx][cy] = Math.min(1, next[cx][cy] + 0.3);
  }
  return { trails: next };
}
slime_mold.__meta = { id: 'slime_mold', branch: 'emergent', hardLimits: { agents: 128, w: 96, h: 96 }, fallback: 'noop' };