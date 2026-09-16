// server/modes/go.js — 回合制演化棋（go）模式插件。
//
// 实现仍委托给 server/go.js 的 mixin（installGoMode 把 _go* 方法挂到 World.prototype），
// 本文件只描述"模式契约"：驱动方式、棋盘上限、可用胜利线、生命周期钩子、意图路由、快照切片。
// 主干（engine/net/index）通过这些钩子驱动 go，不再出现 `mode === 'go'` 硬编码分支。
import { registerMode } from './index.js';
import { installGoMode } from '../go.js';

const go = {
  id: 'go',
  label: '回合制演化棋',
  tickDriver: 'interval', // 1Hz 计时循环驱动（无 20 TPS tick）
  intervalMs: 1000,
  boardMax: 100, // 棋盘即棋盘，1..100
  growLifeLayer: true, // 生命层随棋盘尺寸扩容（max(32, w, h)）
  availableVictoryLines: ['territory'],
  // 首次加载：把 go 的 _go* 方法族挂到 World.prototype（mixin）。
  install(World) { installGoMode(World); },
  // 模拟步进：go 世界由 1Hz 循环调用 _goTick（mixin 提供）。
  tick(engine) { return engine._goTick(); },
  // interval 循环的一步（含 AI）：主干 1Hz 循环按注册表调用本钩子（优先于 tick），
  // 使"按注册表驱动"契约对 go 与世界其它 interval 模式一致。语义与改造前 net 层逐字节等价：
  //   AI 若刚出手 → 本秒不再推进计时；否则推进 _goTick（超时 pass / 计时），事件并入 events。
  intervalStep(engine, events) {
    const evts = events || [];
    let changed = false;
    try { if (engine._goMaybeAIMove(evts)) changed = true; } catch (e) { /* AI 异常不阻断计时 */ }
    if (!changed) {
      const r = engine._goTick();
      if (r && r.events && r.events.length) { for (const e of r.events) evts.push(e); }
    }
    return { events: evts, changed: true };
  },
  // 玩家加入：空盘开局、就座、跳过 rts 出生点资源。
  onAddPlayer(engine, p) {
    engine._lifeInit();
    engine.players[p.id] = p;
    p.goTimeouts = 0; p.seeds = 0; p.goPassed = false;
    engine._goSeatJoin(p);
    if (engine.hostId == null) engine.hostId = p.id; // 首位加入者即为房主
  },
  // 电脑加入：同样就座，不走 rts 纪元戳。
  onAddAI(engine, ai) {
    ai.goTimeouts = 0; ai.seeds = 0; ai.goPassed = false;
    engine._goSeatJoin(ai);
  },
  // 意图路由：go 落子/停一手/认输由 engine.applyGoIntent 直接处理（绕过 20TPS intentQueue）。
  //   · 非 go 意图 → silent（既不入 rts 意图队列，也不广播），与改造前 net 层行为一致。
  //   · 被拒（reason 非 'oob'）→ 把落点压成 go_reject 事件（客户端在落点留红叉）。
  //   · 内部异常 → 返回 go_intent_failed（沿用旧 net 层错误码，文案不变）。
  routeIntent(engine, pid, intent, events) {
    if (!(intent && intent.go && typeof intent.go === 'object')) {
      return { handled: true, silent: true };
    }
    let r;
    try {
      r = engine.applyGoIntent(pid, intent.go, events);
    } catch (e) {
      return { handled: true, result: { ok: false, reason: 'go_intent_failed' } };
    }
    if (!r.ok && r.reason && r.reason !== 'oob') {
      const rg = intent.go || {};
      const pts = Array.isArray(rg.moves)
        ? rg.moves.filter((m) => m && typeof m.lx === 'number' && typeof m.ly === 'number')
        : (typeof rg.lx === 'number' && typeof rg.ly === 'number' ? [{ lx: rg.lx, ly: rg.ly }] : []);
      for (const p of pts) {
        events.push({ type: 'go_reject', reason: String(r.reason), lx: p.lx | 0, ly: p.ly | 0, playerId: pid });
      }
    }
    return { handled: true, result: r };
  },
  // 快照切片：注入 go 专属状态（rts 下返回 null）。
  snapshot(engine) { return engine._goSnapshotState(); },
};

registerMode(go);
export default go;
