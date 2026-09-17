// tests/weiqi.test.mjs — 围棋（weiqi）模式插件
// 覆盖：气/提子 / 禁自杀 / 劫 / 双 pass 终局 / 中国规则数子 + 贴目 / **无演化** / 快照 / routeIntent。
// 风格参考 tests/go_mode.test.mjs：node:test + node:assert/strict。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { World, loadKernels } from '../server/engine.js';
import weiqiDef from '../server/modes/weiqi.js';
import { getMode, normalizeMode, boardMaxForMode, availableVictoryLinesForMode, listModes } from '../server/modes/index.js';

await loadKernels();

const SIZE = 19;
const K = (x, y) => y * SIZE + x;   // 行优先下标

function freshWeiqi(seed = 42) {
  const w = new World('weiqi_' + seed, 1, seed, { mode: 'weiqi' });
  w._skipAIFill = true;
  return w;
}
function seated(seed = 42) {
  const w = freshWeiqi(seed);
  const black = w.addPlayer(1, 'Black');
  const white = w.addPlayer(2, 'White');
  w._weiqiInit();
  return { w, black, white };
}
function put(w, x, y, f) { w.weiqi.board[K(x, y)] = f; }

test('WQ-01 落子基本：黑先，(9,9)→黑子，换手给白', () => {
  const { w } = seated();
  const r = w.applyWeiqiIntent(1, { lx: 9, ly: 9 }, []);
  assert.equal(r.ok, true);
  assert.equal(w.weiqi.board[K(9, 9)], 1);
  assert.equal(w.weiqi.moveNo, 1);
  assert.equal(w.weiqi.turn, 2);
});

test('WQ-02 提单子：落子使 1 颗敌子无气 → 提，captured=1', () => {
  const { w } = seated();
  put(w, 5, 5, 2);            // 白单子
  put(w, 4, 5, 1); put(w, 6, 5, 1); put(w, 5, 4, 1);   // 黑占其三面
  const r = w._weiqiPlay(1, 5, 6, []);                 // 第四面落黑 → 提
  assert.equal(r.ok, true);
  assert.equal(r.captured, 1);
  assert.equal(w.weiqi.board[K(5, 5)], 0);
});

test('WQ-03 提整团：3 子白团被围 → 一次提 3', () => {
  const { w } = seated();
  put(w, 5, 5, 2); put(w, 5, 6, 2); put(w, 6, 5, 2);            // 白团 {(5,5),(5,6),(6,5)}
  for (const [x, y] of [[4, 5], [5, 4], [4, 6], [5, 7], [7, 5], [6, 4]]) put(w, x, y, 1);
  const r = w._weiqiPlay(1, 6, 6, []);                          // 最后一气
  assert.equal(r.ok, true);
  assert.equal(r.captured, 3);
  assert.equal(w.weiqi.board[K(5, 5)], 0);
  assert.equal(w.weiqi.board[K(5, 6)], 0);
  assert.equal(w.weiqi.board[K(6, 5)], 0);
});

test('WQ-04 禁自杀：无气且未提子 → suicide，棋盘不变', () => {
  const { w } = seated();
  put(w, 2, 3, 2); put(w, 4, 3, 2); put(w, 3, 2, 2); put(w, 3, 4, 2);
  const r = w._weiqiPlay(1, 3, 3, []);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'suicide');
  assert.equal(w.weiqi.board[K(3, 3)], 0, '自杀手应回滚');
});

test('WQ-05 劫（ko）：立即回提被拒；隔一手后可回提', () => {
  const { w } = seated();
  put(w, 5, 5, 2);
  put(w, 4, 5, 1); put(w, 5, 4, 1); put(w, 5, 6, 1);
  put(w, 7, 5, 2); put(w, 6, 4, 2); put(w, 6, 6, 2);
  const r1 = w._weiqiPlay(1, 6, 5, []);         // 黑提白单子 → 成劫
  assert.equal(r1.ok, true);
  assert.equal(r1.captured, 1);
  assert.deepEqual(w.weiqi.ko, { x: 5, y: 5 }, '应记劫禁着 (5,5)');
  const r2 = w._weiqiPlay(2, 5, 5, []);         // 白立即回提 → 被拒
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'ko');
  // 双方各在他处应一手 → 劫解除
  assert.equal(w._weiqiPlay(2, 10, 10, []).ok, true);
  assert.equal(w._weiqiPlay(1, 11, 10, []).ok, true);
  const r5 = w._weiqiPlay(2, 5, 5, []);         // 隔一手后回提成功
  assert.equal(r5.ok, true, '隔一手后回提应被允许');
  assert.equal(r5.captured, 1);
});

test('WQ-06 双 pass → 终局（中国规则数子 + 贴目）', () => {
  const { w } = seated();
  // 黑在左上角围出一个 5×5 边框 → 内含 3×3=9 空点为黑地；白在盘外放一子 → 外部空区中立。
  for (let i = 0; i <= 4; i++) { put(w, i, 0, 1); put(w, i, 4, 1); put(w, 0, i, 1); put(w, 4, i, 1); }
  put(w, 10, 10, 2);
  assert.equal(w.applyWeiqiIntent(1, { pass: true }, []).ok, true);
  assert.equal(w.weiqi.result, null, '仅一方 pass 不终局');
  assert.equal(w.applyWeiqiIntent(2, { pass: true }, []).ok, true);
  const res = w.weiqi.result;
  assert.equal(res.reason, 'pass');
  assert.equal(res.blackTerr, 9, '被黑唯一围住的 9 空点归黑');
  assert.equal(res.whiteTerr, 0);
  assert.equal(res.black, 16 + 9, '黑 = 子 16 + 空 9');
  assert.equal(res.white, 1 + 7.5, '白 = 子 1 + 贴目 7.5');
  assert.equal(res.winner, 1, '黑胜');
  assert.equal(res.komi, 7.5);
});

test('WQ-07 空点中立：两颗孤立异色子 → 四周空区接触双方 → 皆不计地', () => {
  const { w } = seated();
  put(w, 0, 0, 1); put(w, 18, 18, 2);
  const sc = w._weiqiScore();
  assert.equal(sc.blackTerr, 0);
  assert.equal(sc.whiteTerr, 0);
  assert.equal(sc.black, 1);
  assert.equal(sc.white, 1 + 7.5);
  assert.equal(sc.winnerF, 2, '白靠贴目领先');
});

test('WQ-08 停一手会重置连续 pass 计数', () => {
  const { w } = seated();
  assert.equal(w.applyWeiqiIntent(1, { pass: true }, []).ok, true);
  assert.equal(w.weiqi.passes, 1);
  assert.equal(w.applyWeiqiIntent(2, { lx: 0, ly: 0 }, []).ok, true);   // 白落子
  assert.equal(w.weiqi.passes, 0, '有落子即清零连续 pass');
  assert.equal(w.weiqi.result, null);
});

test('WQ-09 无演化（与 go 的本质区别）：落子后多次 tick 棋盘不变、孤子不死不生', () => {
  const { w } = seated();
  w.applyWeiqiIntent(1, { lx: 9, ly: 9 }, []);   // 单颗黑子
  const before = Array.from(w.weiqi.board);
  for (let i = 0; i < 5; i++) w._weiqiTick([]);
  assert.deepEqual(Array.from(w.weiqi.board), before, 'tick 不得改变棋盘（无康威演化）');
  let stones = 0;
  for (const v of w.weiqi.board) if (v) stones++;
  assert.equal(stones, 1, '孤子既不死也不引发新生');
});

test('WQ-10 认输：黑认输 → 白胜（不按分数）', () => {
  const { w } = seated();
  const r = w.applyWeiqiIntent(1, { resign: true }, []);
  assert.equal(r.resign, true);
  assert.equal(w.weiqi.result.winner, 2);
  assert.equal(w.weiqi.result.reason, 'resign');
});

test('WQ-11 routeIntent 语义 + snapshot 形态', () => {
  const { w } = seated();
  const r1 = weiqiDef.routeIntent(w, 1, { weiqi: { lx: 9, ly: 9 } }, []);
  assert.equal(r1.handled, true);
  assert.equal(r1.result.ok, true);
  assert.deepEqual(weiqiDef.routeIntent(w, 1, { move: { dx: 1, dy: 0 } }, []), { handled: true, silent: true });
  assert.deepEqual(weiqiDef.routeIntent(w, 1, { gomoku: { lx: 1, ly: 1 } }, []), { handled: true, silent: true });
  const s = w.snapshot();
  assert.equal(s.mode, 'weiqi');
  const g = s.go;
  assert.equal(g.size, 19);
  assert.equal(g.board.length, 361);
  assert.equal(g.komi, 7.5);
  assert.equal(g.phase, 'play');
  assert.ok(g.score && typeof g.score.black === 'number');
  assert.equal(g.seats.length, 2);
});

test('WQ-12 非本回合 / 越界 / 占位 校验', () => {
  const { w } = seated();
  assert.equal(w.applyWeiqiIntent(2, { lx: 9, ly: 9 }, []).reason, 'not_your_turn');
  assert.equal(w.applyWeiqiIntent(1, { lx: -1, ly: 0 }, []).reason, 'oob');
  w.applyWeiqiIntent(1, { lx: 9, ly: 9 }, []);
  assert.equal(w.applyWeiqiIntent(2, { lx: 9, ly: 9 }, []).reason, 'occupied');
});

test('WQ-13 贴目常量 + IR-3a：server/modes/weiqi.js 不含 Math.random / Date.now', () => {
  assert.equal(World.WEIQI_KOMI, 7.5);
  assert.equal(World.WEIQI_SIZE, 19);
  const src = readFileSync('server/modes/weiqi.js', 'utf8');
  assert.ok(!/Math\.random\s*\(/.test(src), '不得含 Math.random()');
  assert.ok(!/Date\.now\s*\(/.test(src), '不得含 Date.now()');
});

test('WQ-14 注册表：weiqi 已注册（id/驱动/上限/胜利线/归一/清单）', () => {
  assert.equal(getMode('weiqi').id, 'weiqi');
  assert.equal(getMode('weiqi').label, '围棋');
  assert.equal(getMode('weiqi').tickDriver, 'interval');
  assert.equal(getMode('weiqi').intervalMs, 1000);
  assert.equal(boardMaxForMode('weiqi'), 128);
  assert.deepEqual(availableVictoryLinesForMode('weiqi'), ['territory']);
  assert.equal(normalizeMode('weiqi'), 'weiqi');
  assert.equal(weiqiDef.id, 'weiqi');
  assert.ok(listModes().some((m) => m.id === 'weiqi'), 'listModes 应含 weiqi');
});

test('WQ-16 无"满盘平局"判定：填满棋盘不自动终局（围棋仍以双 pass / 认输终结）', () => {
  const { w } = seated();
  // 填满棋盘（围棋无墙：全部 361 格皆可落）
  for (let k = 0; k < w.weiqi.board.length; k++) w.weiqi.board[k] = (k % 2) ? 1 : 2;
  assert.equal(w.weiqi.result, null, '围棋无"满盘平局"，填满不得自动终局（区别于 gomoku 的修复 #1）');
  assert.equal(w.applyWeiqiIntent(1, { pass: true }, []).pass, true);
  assert.equal(w.weiqi.result, null, '单 pass 不终局');
  assert.equal(w.applyWeiqiIntent(2, { pass: true }, []).pass, true);
  assert.equal(w.weiqi.result.reason, 'pass', '双 pass 才终局（中国规则数子）');
});

test('WQ-15 主干 seam：世界走 interval 循环路径（_mode.tick），轮到 AI 自动出手 / 计时推进', () => {
  // 复现主干 1Hz 循环的取法：const step = w._mode.intervalStep || w._mode.tick;（weiqi 仅提供 tick）
  const w = new World('weiqi_seam', 1, 3, { mode: 'weiqi' });
  w._skipAIFill = true;
  w.addPlayer(1, 'Human');           // 黑（人类，先手）
  const ai = w.addAI();              // 白（AI，次手）
  w._weiqiInit();
  w.applyWeiqiIntent(1, { lx: 9, ly: 9 }, []);   // 人类落子 → 轮到白(AI)
  assert.equal(w.weiqi.turn, 2);
  assert.equal(w.weiqi.seats[w.weiqi.turnIdx], ai.id, '当前行动方应为 AI');
  const before = w.weiqi.moveNo;

  const step = w._mode.intervalStep || w._mode.tick;
  assert.equal(typeof step, 'function', '主干应能按注册表取到 interval 步进函数');

  // 第 1 步：轮到 AI → 自动落一手（此前因主干硬编码 go 方法而不生效）
  const r1 = step(w, []);
  assert.ok(r1 && r1.changed !== false, '循环步进应报告 changed');
  assert.equal(w.weiqi.moveNo, before + 1, '轮到 AI 应自动落一手');
  assert.equal(w.weiqi.turn, 1, 'AI 落子后换回人类');

  // 第 2 步：轮到人类 → AI 不出手，仅计时推进
  const ticksBefore = w.weiqi.turnTicks;
  step(w, []);
  assert.equal(w.weiqi.moveNo, before + 1, '人类回合 AI 不应落子');
  assert.equal(w.weiqi.turnTicks, ticksBefore + 1, '计时（turnTicks）应推进');
});
