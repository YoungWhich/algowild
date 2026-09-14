// server/kernels/event_bus.js — 事件总线顺序处理
export function event_bus(ctx, rng, params) {
  const { events, handlers } = params;
  const log = [];
  let i = 0;
  for (const ev of events) {
    const hs = handlers[ev.type] || [];
    for (const fn of hs) {
      log.push({ type: ev.type, fn: fn.name, i });
      i++; if (i > 1024) break;
    }
  }
  return { log };
}
event_bus.__meta = { id: 'event_bus', branch: 'systems', hardLimits: { events: 1024 }, fallback: 'noop' };