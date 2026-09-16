// server/modes/_template.js — 新增模式的**后端插件骨架**（分形模板）。
//
// ⚠️ 这是一个**惰性模板**：它**不**调用 registerMode，因此**永远不会被注册表加载**
//    （注册表 server/modes/index.js 只用显式 `import './<id>.js';`；本文件名以 `_` 开头，无人 import）。
//    复制它来创建新模式：`node scripts/new-mode.mjs <id> <Label> [boardMax] [boardDefault]`
//    会以本文件为模板生成 server/modes/<id>.js，并自动完成注册表/前端/HTML/测试的接线。
//
// ─────────────────────────────────────────────────────────────────────────────
// ModePlugin 契约（与 docs/MODES.md §2 一致）：
//   id                     string   唯一模式 id（'rts' | 'go' | 'gomoku' | ...）
//   label                  string   人类可读名（建房下拉 / 房间列表用）
//   tickDriver             'realtime' | 'interval'   主干如何驱动本模式
//                                     · 'realtime' → 20 TPS 主循环（rts）
//                                     · 'interval' → 1Hz 计时循环（go / 棋盘类回合制）
//   intervalMs?            number   interval 模式的步进周期（默认 1000）
//   boardMax               number   可编辑棋盘尺寸上限（rts 32 / go 100 / gomoku 15 / weiqi 19）
//   growLifeLayer?         boolean  生命层是否随棋盘尺寸扩容（go=true；自带棋盘的模式=false）
//   availableVictoryLines  string[] 本模式可用胜利线（territory/economy/singularity/survival 子集）
//   install?(World)                 首次加载时把本模式方法挂到 World.prototype（mixin，方法名建议 `_<id>*` 前缀）
//   tick?(engine, events)           一次模拟步进（interval 模式由 1Hz 循环调用；realtime 留空）
//   intervalStep?(engine, events)   interval 一步（含 AI）；主干 1Hz 循环优先调用它（回退 tick）
//   onAddPlayer?(engine, p)         玩家加入时的模式初始化（空盘/就座/跳过 rts 出生点）
//   onAddAI?(engine, ai)            电脑加入时的模式初始化
//   routeIntent?(engine, pid, intent, events)  处理 WS 意图，返回 { handled, silent?, result? }
//   snapshot?(engine)               注入本模式专属快照切片（rts 留空 → snapshot().go = null）
// ─────────────────────────────────────────────────────────────────────────────
//
// 设计约定（务必遵守，见 AGENTS.md 铁律）：
//   · 只加文件、不改主干（engine/net/index/routes/rooms 零改动）—— 主干只经注册表钩子调用本模式。
//   · 方法族以 `_<id>*` 前缀命名空间挂载，mixin 只挂自己的方法，别碰别人的原型。
//   · 模拟路径禁用 Math.random / Date.now（IR-3a 确定性）：平票打破用种子化 rng `this._rng()`。
//   · snapshot 切片固定注入到 snap 的 **.go** 字段（engine.snapshot() 的字段名历史固定为 go），
//     前端统一读 state.world.go。切片的形状由本模式自定，但字段名建议稳定。
//   · 自带棋盘容器时，尺寸尊重地图编辑器：若 `engine.board`（归一配置）存在则取 max(cfg.w,cfg.h)，
//     否则默认标准尺寸；用 `engine._isWall(lx, ly)` 复用"形状外/虚空/越界 = 墙"的统一语义。
import { registerMode } from './index.js';

// 常量（按模式实际情况调整）
const TEMPLATE_SIZE = 8;     // 默认棋盘边长（board=null 时）
const TEMPLATE_WALL = 99;    // 容器内"墙"哨兵（形状外/虚空/越界），取值 99 落在阵营号 1..8 之外，不与玩家阵营撞值

// ---------------- 纯函数（不依赖 this，便于单测与 AI 复用） ----------------

/** 行优先线性下标：idx = y*size + x。 */
function idx(size, x, y) { return y * size + x; }
/** 是否在 [0,size) 方形盘内。 */
function inBounds(size, x, y) { return x >= 0 && y >= 0 && x < size && y < size; }

// ---------------- 挂到 World.prototype 的方法族 ----------------

const proto = {
  /**
   * 惰性初始化本模式状态容器（示例：自带 Int8Array 棋盘）。
   * 尺寸尊重编辑器：engine.board 存在 → max(cfg.w,cfg.h)；否则默认 TEMPLATE_SIZE。
   * @returns {object} this.template
   */
  _templateInit() {
    const cfg = this.board || null;
    const size = cfg ? Math.max(cfg.w | 0, cfg.h | 0) : TEMPLATE_SIZE;
    const rev = this._boardRev || 0;
    if (this.template && this.template.size === size && this.template.rev === rev) return this.template;
    this.template = {
      size,
      rev,
      board: new Int8Array(size * size),   // 0 空 / 1 甲 / 2 乙 / 99 墙
      played: 0,                           // 已落子数（示例计数）
      // …按需补充：seats / turn / turnTicks / result / moveLog 等
    };
    // 若配置了棋盘形状：把墙（形状外/虚空/越界）标为 TEMPLATE_WALL（board=null → 无墙，标准行为）。
    if (this._bmp) {
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if (this._isWall(x, y)) this.template.board[idx(size, x, y)] = TEMPLATE_WALL;
        }
      }
    }
    return this.template;
  },

  /**
   * 处理本模式意图（示例）。返回 { ok, reason? }。
   * @param {*} playerId @param {object} data @param {object[]} [events]
   */
  applyTemplateIntent(playerId, data, events) {
    void playerId; void events;
    const g = this._templateInit();
    if (this.paused) return { ok: false, reason: 'paused' };
    if (!data || typeof data !== 'object') return { ok: false, reason: 'bad_move' };
    if (typeof data.lx !== 'number' || typeof data.ly !== 'number') return { ok: false, reason: 'bad_move' };
    const x = data.lx | 0, y = data.ly | 0;
    if (!inBounds(g.size, x, y)) return { ok: false, reason: 'oob' };
    const k = idx(g.size, x, y);
    if (g.board[k] === TEMPLATE_WALL) return { ok: false, reason: 'wall' };   // 编辑器形状外/虚空
    if (g.board[k] !== 0) return { ok: false, reason: 'occupied' };
    g.board[k] = 1;      // 示例：恒落"甲"色；真实模式应记在行动方并换手
    g.played++;
    if (events) events.push({ type: 'template_move', playerId, lx: x, ly: y });
    return { ok: true };
  },

  /** 本模式快照切片（注入 engine.snapshot() 的 mode 字段；示例）。 */
  _templateSnapshot() {
    const g = this._templateInit();
    return { size: g.size, board: Array.from(g.board), played: g.played, phase: 'play' };
  },
};

// ---------------- 模式插件契约对象 ----------------

const def = {
  id: '<id>',                    // ← 由脚手架替换
  label: '<Label>',              // ← 由脚手架替换
  tickDriver: 'interval',        // 'realtime'（20 TPS）| 'interval'（1Hz 计时）
  intervalMs: 1000,
  boardMax: TEMPLATE_SIZE,       // ← 由脚手架替换为 boardMax
  growLifeLayer: false,          // 自带棋盘 → 不扩容 rts 生命层
  availableVictoryLines: ['territory'],

  // 首次加载：把方法族挂到 World.prototype（只挂自己的 `_template*` 方法）。
  install(World) {
    const P = World.prototype;
    P._templateInit = proto._templateInit;
    P.applyTemplateIntent = proto.applyTemplateIntent;
    P._templateSnapshot = proto._templateSnapshot;
    World.TEMPLATE_SIZE = TEMPLATE_SIZE;
    World.TEMPLATE_WALL = TEMPLATE_WALL;
  },

  // interval 一步（含 AI）。主干 1Hz 循环优先调用 intervalStep（回退 tick）；返回 { changed:true } 触发广播。
  tick(engine, events) {
    void engine; void events;
    return { changed: true };
  },

  // 玩家加入：就座 / 跳过 rts 出生点。示例：只登记房主。
  onAddPlayer(engine, p) {
    engine.players[p.id] = p;
    if (engine.hostId == null) engine.hostId = p.id;
  },
  onAddAI(engine, ai) {
    void engine; void ai;
  },

  // 意图路由：只消费 { template: {...} }；其余意图 silent（不入 rts 队列、不广播）。
  routeIntent(engine, pid, intent, events) {
    if (!(intent && intent.template && typeof intent.template === 'object')) {
      return { handled: true, silent: true };
    }
    let r;
    try { r = engine.applyTemplateIntent(pid, intent.template, events); }
    catch (e) { return { handled: true, result: { ok: false, reason: 'template_intent_failed' } }; }
    if (!r.ok && r.reason && r.reason !== 'oob') {
      const t = intent.template || {};
      if (typeof t.lx === 'number' && typeof t.ly === 'number') {
        events.push({ type: 'template_reject', reason: String(r.reason), lx: t.lx | 0, ly: t.ly | 0, playerId: pid });
      }
    }
    return { handled: true, result: r };
  },

  snapshot(engine) { return engine._templateSnapshot(); },
};

// ⚠️ 模板保持 inert（不自注册）：注册表只用显式 import 加载插件，本文件（以 `_` 开头）无人 import。
// 脚手架 new-mode.mjs 生成 <id>.js 时会替换下面两行，使新文件在模块顶层自注册。
// __REGISTER__
// registerMode(def);

export default def;
