// server/kernels/signal_slot.js — 信号-槽聚合
export function signal_slot(ctx, rng, params) {
  const { signals, slots } = params;
  const out = {};
  for (const [sig, fnName] of Object.entries(signals)) {
    const fn = slots[fnName]; if (!fn) continue;
    out[sig] = fn(params);
  }
  return out;
}
signal_slot.__meta = { id: 'signal_slot', branch: 'systems', hardLimits: {}, fallback: 'noop' };