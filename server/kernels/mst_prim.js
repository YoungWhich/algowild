// server/kernels/mst_prim.js — Prim 最小生成树
export function mst_prim(ctx, rng, params) {
  const { nodes, edges } = params; // edges: [[u,v,w]]
  if (!nodes || !nodes.length) return { edges: [], total: 0 };
  const adj = new Map();
  for (const [u, v, w] of edges) {
    if (!adj.has(u)) adj.set(u, []); if (!adj.has(v)) adj.set(v, []);
    adj.get(u).push([v, w]); adj.get(v).push([u, w]);
  }
  const used = new Set([nodes[0]]);
  const heap = (adj.get(nodes[0]) || []).slice();
  const mst = []; let total = 0; let iter = 0;
  while (heap.length && iter++ < 4096) {
    heap.sort((a, b) => a[1] - b[1]);
    const [v, w] = heap.shift();
    if (used.has(v)) continue;
    used.add(v); mst.push([v, w]); total += w;
    for (const e of (adj.get(v) || [])) if (!used.has(e[0])) heap.push(e);
  }
  return { edges: mst, total };
}
mst_prim.__meta = { id: 'mst_prim', branch: 'graph_search', hardLimits: { iter: 4096 }, fallback: 'noop' };