// server/kernels/cellular_automaton.js — 通用 CA（支持 Conway/Rule 30 等）
export function cellular_automaton(ctx, rng, params) {
  const { cells, rule = 'B3/S23' } = params;
  const W = cells.length, H = cells[0].length;
  const next = Array.from({ length: W }, () => new Uint8Array(H));
  const [bs, ss] = rule.split('/');
  const born = parseInt(bs.slice(1), 2);
  const survive = parseInt(ss.slice(1), 2);
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) {
    let n = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      if (!dx && !dy) continue;
      const nx = (x + dx + W) % W, ny = (y + dy + H) % H;
      n += cells[nx][ny];
    }
    if (cells[x][y]) next[x][y] = (survive >> n) & 1;
    else next[x][y] = (born >> n) & 1;
  }
  return { cells: next.map(a => Array.from(a)) };
}
cellular_automaton.__meta = { id: 'cellular_automaton', branch: 'swarm', hardLimits: { w: 96, h: 96 }, fallback: 'noop' };