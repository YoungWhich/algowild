// server/kernels/topo_sort.js — 拓扑排序（Kahn 算法）
export function topo_sort(ctx, rng, params) {
  const { n, edges } = params; // edges: [u, v]  u -> v
  const deg = new Array(n).fill(0);
  const adj = Array.from({ length: n }, () => []);
  for (const [u, v] of edges) { adj[u].push(v); deg[v]++; }
  const q = []; for (let i = 0; i < n; i++) if (deg[i] === 0) q.push(i);
  const order = []; let iter = 0;
  while (q.length && iter++ < 4096) {
    const u = q.shift(); order.push(u);
    for (const v of adj[u]) { if (--deg[v] === 0) q.push(v); }
  }
  return { order, hasCycle: order.length < n };
}
topo_sort.__meta = { id: 'topo_sort', branch: 'graph_search', hardLimits: { iter: 4096 }, fallback: 'noop' };