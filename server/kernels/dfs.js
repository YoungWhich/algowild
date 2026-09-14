// server/kernels/dfs.js — 深度优先（栈版本，避免深递归）
export function dfs(ctx, rng, params) {
  const { sx, sy, blocked } = params;
  const visited = new Set([sx + ',' + sy]);
  const stack = [[sx, sy]];
  const order = [[sx, sy]];
  let iter = 0;
  while (stack.length && iter++ < 2048) {
    const [x, y] = stack.pop();
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = x + dx, ny = y + dy;
      const k = nx + ',' + ny;
      if (visited.has(k) || (blocked && blocked(nx, ny))) continue;
      visited.add(k); order.push([nx, ny]); stack.push([nx, ny]);
    }
  }
  return { order, visitedCount: visited.size };
}
dfs.__meta = { id: 'dfs', branch: 'graph_search', hardLimits: { iter: 2048 }, fallback: 'noop' };