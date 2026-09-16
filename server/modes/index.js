// server/modes/index.js — 模式注册表（"拼图"契约的唯一扩展点）
//
// 设计目标（见 docs/MODES.md）：
//   · 主干（engine / net / index / routes / rooms）不再出现 `mode === 'go'` / `=== 'rts'` 这类硬编码分支。
//   · 新增一个模式（如 gomoku / checkers / xiangqi）= 在 server/modes/ 放一个 <id>.js 插件文件 + 在本文件底部加一行 import，
//     主干零改动、零回归。
//   · 每个插件通过 default 导出一个符合 ModePlugin 契约的对象，并在模块顶层 self-register。
//
// ModePlugin 契约：
//   id: string            唯一模式 id（'rts' | 'go' | 'gomoku' | ...）
//   label: string         人类可读名（建房下拉、房间列表用）
//   tickDriver: 'realtime' | 'interval'  主干如何驱动本模式：
//                 'realtime' → 20 TPS 主循环（rts）
//                 'interval' → 1Hz 计时循环（go、棋盘类回合制）
//   intervalMs?: number   interval 模式的步进周期（默认 1000）
//   boardMax: number      可编辑棋盘尺寸上限（rts 32 / go 100）
//   maxSeats?: number     **模式级席位上限**（可选）。如 gomoku / weiqi 恒为 2 席（黑/白）。
//                         主干只读 `world._mode.maxSeats`：有效上限 = min(maxPlayers, 8, maxSeats ?? Infinity)，
//                         据此在 addPlayer / addAI / canAcceptHuman 处拒绝超额的第 3 席（人类或电脑）。
//   growLifeLayer?: bool  生命层是否随棋盘尺寸扩容（go=true）
//   availableVictoryLines: string[]  本模式可用的胜利线（go 仅 territory）
//   install?(World)        首次加载时把本模式的方法挂到 World.prototype（mixin）
//   tick?(engine, events)  一次模拟步进（interval 模式由 1Hz 循环调用；realtime 模式留空）
//   onAddPlayer?(engine, p)   玩家加入时的模式专属初始化（go：空盘就座、跳过 rts 出生点）
//   onAddAI?(engine, ai)      电脑加入时的模式专属初始化
//   routeIntent?(engine, pid, intent, events)  处理 WS 意图；返回 { handled, result, rejectPoints? }
//   snapshot?(engine)          注入本模式专属的快照切片（rts 留空 → null）

// 用 var（而非 const/let）保证在插件（本文件的依赖）先于本文件 body 求值时，
// ensureModes() 不会触发 TDZ —— 插件在依赖求值阶段就会调用 registerMode。
var _MODES;
function ensureModes() {
  if (!_MODES) _MODES = new Map();
  return _MODES;
}

export function registerMode(def) {
  if (def && typeof def.id === 'string') ensureModes().set(def.id, def);
}

export function getMode(id) {
  const m = ensureModes();
  return m.get(id) || m.get('rts');
}

export function listModes() {
  return [...ensureModes().values()].map((m) => ({ id: m.id, label: m.label, tickDriver: m.tickDriver }));
}

export function allModeDefs() {
  return [...ensureModes().values()];
}

// ---- 元数据便捷访问器：主干通过这些读取模式能力，不再散落字符串比较 ----
export function boardMaxForMode(id) {
  // 已注册模式 → 用其 boardMax（rts 32 / go 100）；
  // 未指定 / 未知模式 → 回宽松上限 100（保持改造前 `mode !== 'rts' → BOARD_MAX` 语义，避免归一化拒绝大盘）。
  const m = ensureModes().get(id);
  return (m && m.boardMax != null) ? m.boardMax : 100;
}
export function availableVictoryLinesForMode(id) {
  const m = getMode(id);
  return Array.isArray(m.availableVictoryLines)
    ? m.availableVictoryLines.slice()
    : ['territory', 'economy', 'singularity', 'survival'];
}
export function growLifeLayerForMode(id) {
  return !!getMode(id).growLifeLayer;
}
/**
 * 把"用户/房间传入的模式串"归一为已注册的模式 id。
 * 未注册 / 非法 → fallback（默认 'rts'；传 null 表示"未指定"）。
 * 主干（routes/rooms）用它做模式 id 归一，新增模式无需改动这些调用点。
 * @param {*} id @param {string|null|undefined} [fallback='rts']
 */
export function normalizeMode(id, fallback) {
  const m = ensureModes().get(id);
  if (m) return m.id;
  return fallback === undefined ? 'rts' : fallback;
}

// ---- 插件注册（副作用导入，模块求值阶段即完成注册；顺序无关）----
// 每个插件在自身顶层调用 registerMode(default)。新增模式：在 server/modes/ 建 <id>.js，并追加 `import './<id>.js';`。
import './rts.js';
import './go.js';
import './gomoku.js';
import './weiqi.js';
