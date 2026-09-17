// tests/gomoku.test.mjs — 五子棋（gomoku）模式插件
// 覆盖：落子校验 / 五连判定 / 平局 / routeIntent 语义 / 快照形态 / 简单 AI 确定性 / 认输。
// 风格参考 tests/go_mode.test.mjs：node:test + node:assert/strict。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { World, loadKernels } from '../server/engine.js';
import gomokuDef from '../server/modes/gomoku.js';
import { getMode, normalizeMode, boardMaxForMode, availableVictoryLinesForMode, listModes } from '../server/modes/index.js';

await loadKernels();

const SIZE = 15;
const K = (x, y) => y * SIZE + x;   // 行优先下标

function freshGomoku(seed = 42) {
  const w = new World('gomoku_' + seed, 1, seed, { mode: 'gomoku' });
  w._skipAIFill = true;
  return w;
}
// 两位人类就座，返回 { w, black, white }
function seated(seed = 42) {
  const w = freshGomoku(seed);
  const black = w.addPlayer(1, 'Black');
  const white = w.addPlayer(2, 'White');
  w._gomokuInit();
  return { w, black, white };
}
// 直接摆放棋子供构造局面
function put(w, x, y, f) { w.gomoku.board[K(x, y)] = f; }

// 形状盘（地图编辑器挖墙）：4×4，墙 = (1,1)/(2,1)/(1,2)/(2,2)，可落 12 格。
// 与 mode_wiring.qa.test.mjs 的 SHAPE_4 同款；墙哨兵值 = 99（World.GOMOKU_WALL，落在阵营号 1..8 之外，不与玩家阵营撞值）。
const SHAPE_4 = '####/#x.#/#..#/####';
const WALL = 99;
function shapedGomoku(seed = 7) {
  const w = new World('gomoku_shaped_' + seed, 1, seed, { mode: 'gomoku', board: { w: 4, h: 4, shape: SHAPE_4 } });
  w._skipAIFill = true;
  w.addPlayer(1, 'B');
  w.addPlayer(2, 'W');
  w._gomokuInit();
  return w;
}

test('GK-01 落子基本：黑先手，(7,7)→黑子，moveNo=1，轮到白', () => {
  const { w } = seated();
  const r = w.applyGomokuIntent(1, { lx: 7, ly: 7 }, []);
  assert.equal(r.ok, true);
  assert.equal(w.gomoku.board[K(7, 7)], 1);
  assert.equal(w.gomoku.moveNo, 1);
  assert.equal(w.gomoku.turn, 2, '换手给白方');
  assert.deepEqual(w.gomoku.lastMove, { x: 7, y: 7, f: 1 });
});

test('GK-02 横向五连 → 黑胜（reason=five）', () => {
  const { w } = seated();
  const seq = [
    [1, 3, 7], [2, 0, 0],
    [1, 4, 7], [2, 1, 0],
    [1, 5, 7], [2, 2, 0],
    [1, 6, 7], [2, 3, 0],
    [1, 7, 7],   // 黑成 (3..7,7) 五连
  ];
  let last = null;
  for (const [pid, x, y] of seq) last = w.applyGomokuIntent(pid, { lx: x, ly: y }, []);
  assert.equal(last.win, true);
  assert.equal(w.gomoku.result.reason, 'five');
  assert.equal(w.gomoku.result.winner, 1);
  assert.equal(w.gomoku.result.line.length, 5);
});

test('GK-03 斜向五连同样判胜', () => {
  const { w } = seated();
  const seq = [
    [1, 3, 3], [2, 0, 14],
    [1, 4, 4], [2, 1, 14],
    [1, 5, 5], [2, 2, 14],
    [1, 6, 6], [2, 3, 14],
    [1, 7, 7],   // 主对角五连
  ];
  let last = null;
  for (const [pid, x, y] of seq) last = w.applyGomokuIntent(pid, { lx: x, ly: y }, []);
  assert.equal(last.win, true);
  assert.equal(w.gomoku.result.winner, 1);
});

test('GK-04 占位拒绝：重复落子 → occupied，棋盘不变', () => {
  const { w } = seated();
  w.applyGomokuIntent(1, { lx: 7, ly: 7 }, []);
  const r = w.applyGomokuIntent(2, { lx: 7, ly: 7 }, []);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'occupied');
  assert.equal(w.gomoku.moveNo, 1);
});

test('GK-05 越界拒绝：oob', () => {
  const { w } = seated();
  assert.equal(w.applyGomokuIntent(1, { lx: -1, ly: 0 }, []).reason, 'oob');
  assert.equal(w.applyGomokuIntent(1, { lx: 15, ly: 0 }, []).reason, 'oob');
  assert.equal(w.applyGomokuIntent(1, { lx: 0, ly: 99 }, []).reason, 'oob');
});

test('GK-06 非本回合：not_your_turn', () => {
  const { w } = seated();
  const r = w.applyGomokuIntent(2, { lx: 7, ly: 7 }, []);   // 白先手 → 非法
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_your_turn');
});

test('GK-07 平局：盘满且无五连 → draw', () => {
  const { w } = seated();
  // 周期性 2 色图案：任意方向最长连续 2（无五连），留 (0,0) 作最后一手。
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (x === 0 && y === 0) continue;
      put(w, x, y, ((x + 2 * y) % 4) < 2 ? 1 : 2);
    }
  }
  w.gomoku.moveNo = SIZE * SIZE - 1;   // 假装下了 224 手
  const r = w.applyGomokuIntent(1, { lx: 0, ly: 0 }, []);
  assert.equal(r.draw, true);
  assert.equal(w.gomoku.result.reason, 'draw');
  assert.equal(w.gomoku.result.winner, null);
});

test('GK-08 routeIntent 语义：gomoku 意图被消费；其余 silent', () => {
  const { w } = seated();
  const ev = [];
  const r1 = gomokuDef.routeIntent(w, 1, { gomoku: { lx: 7, ly: 7 } }, ev);
  assert.equal(r1.handled, true);
  assert.equal(r1.result.ok, true);
  const r2 = gomokuDef.routeIntent(w, 1, { move: { dx: 1, dy: 0 } }, ev);
  assert.deepEqual(r2, { handled: true, silent: true });
  const r3 = gomokuDef.routeIntent(w, 1, { go: { lx: 1, ly: 1 } }, ev);
  assert.deepEqual(r3, { handled: true, silent: true });
});

test('GK-09 snapshot 形态：mode=gomoku，切片含 15×15 棋盘与席位', () => {
  const { w } = seated();
  w.applyGomokuIntent(1, { lx: 7, ly: 7 }, []);
  const s = w.snapshot();
  assert.equal(s.mode, 'gomoku');
  const g = s.go;
  assert.equal(g.size, 15);
  assert.equal(g.board.length, 225);
  assert.equal(g.board[K(7, 7)], 1);
  assert.equal(g.phase, 'play');
  assert.equal(g.result, null);
  assert.equal(g.win, 5);
  assert.equal(g.seats.length, 2);
  assert.equal(g.turn, 2);
});

test('GK-10 认输：黑认输 → 白胜', () => {
  const { w } = seated();
  const r = w.applyGomokuIntent(1, { resign: true }, []);
  assert.equal(r.resign, true);
  assert.equal(w.gomoku.result.winner, 2);
  assert.equal(w.gomoku.result.reason, 'resign');
});

test('GK-11 AI 确定性：同 seed 双世界逐手一致（禁 Math.random）', () => {
  function aiWorld(seed) {
    const w = new World('gomoku_ai_' + seed, 1, seed, { mode: 'gomoku' });
    w._skipAIFill = true;
    w.addAI(); w.addAI();
    return w;
  }
  const wa = aiWorld(7), wb = aiWorld(7);
  for (let i = 0; i < 8; i++) { wa._gomokuMaybeAIMove([]); wb._gomokuMaybeAIMove([]); }
  assert.equal(wa.gomoku.moveLog.length, 8);
  assert.deepEqual(wa.gomoku.moveLog, wb.gomoku.moveLog, '同 seed AI 出手应逐手一致');
});

test('GK-12 AI 会补成五连取胜', () => {
  const w = new World('gomoku_win', 1, 5, { mode: 'gomoku' });
  w._skipAIFill = true;
  const ai = w.addAI();          // 首座 = AI（黑，先手）
  w._gomokuInit();
  put(w, 3, 7, 1); put(w, 4, 7, 1); put(w, 5, 7, 1); put(w, 6, 7, 1);
  w.gomoku.moveNo = 4;
  const acted = w._gomokuMaybeAIMove([]);
  assert.equal(acted, true);
  assert.equal(w.gomoku.result && w.gomoku.result.reason, 'five');
  assert.equal(w.gomoku.result.winner, ai.id);
});

test('GK-13 tick 钩子：1Hz 步进返回 { changed:true, events }', () => {
  const { w } = seated();
  const ev = [];
  const r = gomokuDef.tick(w, ev);
  assert.equal(r.changed, true);
  assert.ok(Array.isArray(r.events));
  assert.equal(w.tick, 1, 'tick 计数推进');
});

test('GK-16 主干 seam：世界走 interval 循环路径（_mode.tick），轮到 AI 自动出手 / 计时推进', () => {
  // 复现主干 1Hz 循环的取法：const step = w._mode.intervalStep || w._mode.tick;（gomoku 仅提供 tick）
  const w = new World('gomoku_seam', 1, 3, { mode: 'gomoku' });
  w._skipAIFill = true;
  w.addPlayer(1, 'Human');           // 黑（人类，先手）
  const ai = w.addAI();              // 白（AI，次手）
  w._gomokuInit();
  w.applyGomokuIntent(1, { lx: 7, ly: 7 }, []);   // 人类落子 → 轮到白(AI)
  assert.equal(w.gomoku.turn, 2);
  assert.equal(w.gomoku.seats[w.gomoku.turnIdx], ai.id, '当前行动方应为 AI');
  const before = w.gomoku.moveNo;

  const step = w._mode.intervalStep || w._mode.tick;
  assert.equal(typeof step, 'function', '主干应能按注册表取到 interval 步进函数');

  // 第 1 步：轮到 AI → 自动落一手（此前因主干硬编码 go 方法而不生效）
  const r1 = step(w, []);
  assert.ok(r1 && r1.changed !== false, '循环步进应报告 changed');
  assert.equal(w.gomoku.moveNo, before + 1, '轮到 AI 应自动落一手');
  assert.equal(w.gomoku.turn, 1, 'AI 落子后换回人类');

  // 第 2 步：轮到人类 → AI 不出手，仅计时推进
  const ticksBefore = w.gomoku.turnTicks;
  step(w, []);
  assert.equal(w.gomoku.moveNo, before + 1, '人类回合 AI 不应落子');
  assert.equal(w.gomoku.turnTicks, ticksBefore + 1, '计时（turnTicks）应推进');
});

// ---------- 平局判定（非矩形盘 · 修复 #1） ----------

test('GK-17 非矩形盘：仍有可落非墙空点 → 不判平局（即便 moveNo 已达 size²）', () => {
  const w = shapedGomoku();
  const g = w._gomokuInit();
  assert.equal(g.size, 4, '容器尺寸取 max(cfg.w,cfg.h)=4');
  // 填满除 (0,0)/(3,3) 外的所有可落格（墙格保持 3）
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      if (g.board[y * 4 + x] === WALL) continue;
      if ((x === 0 && y === 0) || (x === 3 && y === 3)) continue;
      g.board[y * 4 + x] = ((x + y) % 2) ? 1 : 2;
    }
  }
  w.gomoku.moveNo = 16;                          // 人为抬到 size²(16) —— 旧判定在此必判平局
  assert.equal(g.board[3 * 4 + 3], 0, '(3,3) 应仍为可落的非墙空点');
  const r = w.applyGomokuIntent(1, { lx: 0, ly: 0 }, []);
  assert.equal(r.ok, true);
  assert.equal(r.draw, undefined, '仍有一个可落非墙空点 → 不得判平局');
  assert.equal(w.gomoku.result, null);
  assert.equal(w._gomokuNoEmpty(), false, '隐藏助手：仍有非墙空点');
});

test('GK-18 非矩形盘：所有非墙格占满 → 判平局（draw）', () => {
  const w = shapedGomoku();
  const g = w._gomokuInit();
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      if (g.board[y * 4 + x] === WALL) continue;
      if (x === 0 && y === 0) continue;           // 留 (0,0) 作最后一手
      g.board[y * 4 + x] = ((x + y) % 2) ? 1 : 2;
    }
  }
  w.gomoku.moveNo = 11;                          // 11 个非墙格已占（< size²=16）
  assert.equal(Array.from(g.board).some((v) => v === 0), true, '落子前应还剩 1 个空点');
  const r = w.applyGomokuIntent(1, { lx: 0, ly: 0 }, []);
  assert.equal(r.draw, true, '所有非墙格占满 → 平局');
  assert.equal(w.gomoku.result.reason, 'draw');
  assert.equal(w.gomoku.result.winner, null);
  assert.equal(Array.from(g.board).some((v) => v === 0), false, '盘上应再无空点');
});

test('GK-19 15×15 回归：仅剩 1 空点不判平局，占满即平局（board=null 逐字节等价旧行为）', () => {
  const { w } = seated();
  assert.equal(Array.from(w.gomoku.board).some((v) => v === WALL), false, 'board=null → 不得有墙');
  // 周期性图案：任意方向最长连续 2（无五连），留 (0,0) 作最后一手。
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (x === 0 && y === 0) continue;
      put(w, x, y, ((x + 2 * y) % 4) < 2 ? 1 : 2);
    }
  }
  w.gomoku.moveNo = SIZE * SIZE - 1;              // 224 手
  assert.equal(w._gomokuNoEmpty(), false, '还剩 1 空点 → 不应认为"满盘"');
  const r = w.applyGomokuIntent(1, { lx: 0, ly: 0 }, []);
  assert.equal(r.draw, true, '占满 225 格 → 平局（等价旧 moveNo >= size²）');
  assert.equal(w.gomoku.moveNo, SIZE * SIZE);
  assert.equal(w.gomoku.result.reason, 'draw');
});

test('GK-14 IR-3a：server/modes/gomoku.js 不含 Math.random / Date.now', () => {
  const src = readFileSync('server/modes/gomoku.js', 'utf8');
  assert.ok(!/Math\.random\s*\(/.test(src), '不得含 Math.random()');
  assert.ok(!/Date\.now\s*\(/.test(src), '不得含 Date.now()');
});

test('GK-15 注册表：gomoku 已注册（id/驱动/上限/胜利线/归一/清单）', () => {
  assert.equal(getMode('gomoku').id, 'gomoku');
  assert.equal(getMode('gomoku').label, '五子棋');
  assert.equal(getMode('gomoku').tickDriver, 'interval');
  assert.equal(getMode('gomoku').intervalMs, 1000);
  assert.equal(boardMaxForMode('gomoku'), 128);
  assert.deepEqual(availableVictoryLinesForMode('gomoku'), ['territory']);
  assert.equal(normalizeMode('gomoku'), 'gomoku');
  assert.equal(gomokuDef.id, 'gomoku');
  assert.ok(listModes().some((m) => m.id === 'gomoku'), 'listModes 应含 gomoku');
});
