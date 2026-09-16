// public/modes/index.js — 前端模式注册表（与 server/modes 对齐的"拼图"契约）
//
// 用途：把"当前是什么模式"从散落的 `mode === 'go'` 字符串比较，收敛为一次查表。
// 新增模式（五子棋 / 跳棋 / 象棋 …）步骤（详见 docs/MODES.md）：
//   1) 在 public/modes/ 新建 <id>.js，导出该模式的渲染 / 输入 / HUD 入口。
//   2) 在本表 MODES 里加一条：{ id, label, kind, tickDriver, boardMax, render?, hud?, input? }。
//   3) 在 client.js 的模式分派处（render / renderHud / mousedown / keydown）按 kind 走对应入口。
//
// 注意：本表只放"元数据 + 入口引用"，不引入 client.js（避免循环依赖）。

export const MODES = {
  rts: {
    id: 'rts',
    label: '实时生存对战',
    kind: 'rts',
    tickDriver: 'realtime',
    boardMax: 32,
    boardDefault: 32,
  },
  go: {
    id: 'go',
    label: '回合制演化棋',
    kind: 'go',
    tickDriver: 'interval',
    boardMax: 100,
    boardDefault: 32,
  },
  gomoku: {
    id: 'gomoku',
    label: '五子棋',
    kind: 'gomoku',
    tickDriver: 'interval',
    boardMax: 15,
    boardDefault: 15,
  },
  weiqi: {
    id: 'weiqi',
    label: '标准围棋',
    kind: 'weiqi',
    tickDriver: 'interval',
    boardMax: 19,
    boardDefault: 19,
  },
};

/** 取模式定义；未知 id → rts（默认模式）。 */
export function getMode(id) {
  return MODES[id] || MODES.rts;
}

/** 归一为已注册模式 id（未知 → 'rts'）。 */
export function normalizeMode(id) {
  return getMode(id).id;
}

/** 当前是否 go 模式（以挂载在 world 上的服务端权威 mode 为准，state.mode 作兜底）。 */
export function isGo(id) {
  return getMode(id).id === 'go';
}

/** 是否"回合制（interval 驱动）"模式：go / gomoku / weiqi —— 均无 rts 移动意图。
 *  用于 client.js 的输入分派，避免在主干里硬编码具体模式名。 */
export function isIntervalMode(id) {
  return getMode(id).tickDriver === 'interval';
}

/** 该模式可编辑棋盘尺寸上限（rts 32 / go 100 / gomoku 15 / weiqi 19）。
 *  未指定 / 未知 → 宽松 100（与改造前 client 端 `mode !== 'rts' → 100` 语义一致）。 */
export function boardMaxForMode(id) {
  const m = MODES[id];
  return (m && m.boardMax != null) ? m.boardMax : 100;
}

/** 该模式棋盘尺寸默认值（rts 32 / go 32 / gomoku 15 / weiqi 19）。未指定 / 未知 → 32。 */
export function boardDefaultForMode(id) {
  const m = MODES[id];
  return (m && m.boardDefault != null) ? m.boardDefault : 32;
}

/** 模式清单（建房下拉 / 房间列表用）。 */
export function listModes() {
  return Object.values(MODES).map((m) => ({ id: m.id, label: m.label, kind: m.kind }));
}
