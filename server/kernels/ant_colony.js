// server/kernels/ant_colony.js — 蚁群信息素
export function ant_colony(ctx, rng, params) {
  const { grid, ants, start, evap, alpha, beta } = params;
  const tau = grid.map(r => r.slice());
  const moves = []; let iter = 0;
  for (const a of ants) {
    let cx = a.x, cy = a.y, steps = 0;
    while (steps++ < 64 && iter++ < 4096) {
      const cand = []; for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= grid.length || ny >= grid[0].length) continue;
        cand.push([nx, ny, tau[nx][ny] ** alpha * (1 / (grid[nx][ny] + 1)) ** beta]);
      }
      if (!cand.length) break;
      const sum = cand.reduce((s, c) => s + c[2], 0);
      let r = rng() * sum; let pick = cand[0];
      for (const c of cand) { r -= c[2]; if (r <= 0) { pick = c; break; } }
      tau[pick[0]][pick[1]] += 0.1; cx = pick[0]; cy = pick[1];
      if (cx === start.x && cy === start.y) break;
    }
    moves.push([a.x, a.y, cx, cy]);
  }
  for (let i = 0; i < tau.length; i++) for (let j = 0; j < tau[0].length; j++) tau[i][j] *= (1 - evap);
  return { moves, tau: tau.map(r => r.map(v => Math.round(v * 100) / 100)) };
}
ant_colony.__meta = { id: 'ant_colony', branch: 'swarm', hardLimits: { iter: 4096, steps: 64 }, fallback: 'noop' };