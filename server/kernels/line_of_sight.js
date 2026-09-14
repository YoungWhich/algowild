// server/kernels/line_of_sight.js — 视线（Bresenham 直线）
export function line_of_sight(ctx, rng, params) {
  const { x0, y0, x1, y1, block } = params;
  let x = x0, y = y0, dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy, blocked = false, steps = 0;
  while (steps++ < 1024) {
    if (block && block(x, y)) { blocked = true; break; }
    if (x === x1 && y === y1) break;
    let e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
  return { clear: !blocked };
}
line_of_sight.__meta = { id: 'line_of_sight', branch: 'geometry', hardLimits: { steps: 1024 }, fallback: 'noop' };