// server/kernels/boids.js — Reynolds Boids 群飞
export function boids(ctx, rng, params) {
  const { boids: bs, sepR, aliR, cohR, maxV } = params;
  const out = [];
  for (let i = 0; i < bs.length; i++) {
    const b = bs[i]; let sx = 0, sy = 0, ax = 0, ay = 0, cx = 0, cy = 0, cn = 0, sn = 0;
    for (let j = 0; j < bs.length; j++) {
      if (i === j) continue; const o = bs[j];
      const dx = b.x - o.x, dy = b.y - o.y; const d2 = dx * dx + dy * dy;
      if (d2 < cohR * cohR) { cx += o.x; cy += o.y; cn++; ax += o.vx; ay += o.vy; }
      if (d2 < aliR * aliR) { ax += o.vx; ay += o.vy; }
      if (d2 < sepR * sepR) { sx += dx; sy += dy; sn++; }
    }
    let vx = b.vx, vy = b.vy;
    if (cn > 0) { cx /= cn; cy /= cn; vx += (cx - b.x) * 0.005 - b.vx * 0.02; vy += (cy - b.y) * 0.005 - b.vy * 0.02; ax /= cn; ay /= cn; vx += ax * 0.05; vy += ay * 0.05; }
    if (sn > 0) { vx += sx * 0.05; vy += sy * 0.05; }
    const sp = Math.hypot(vx, vy);
    if (sp > maxV) { vx = (vx / sp) * maxV; vy = (vy / sp) * maxV; }
    out.push({ ...b, vx, vy, x: b.x + vx, y: b.y + vy });
  }
  return { boids: out };
}
boids.__meta = { id: 'boids', branch: 'swarm', hardLimits: { count: 256 }, fallback: 'noop' };