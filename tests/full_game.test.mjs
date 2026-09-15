// tests/full_game.test.mjs — 整局端到端回归：走真实驱动路径，把一局下到底。
//
// 为什么需要这个文件：此前所有用例都只验证「单点/单步」行为（归一边界、落子合法性、快照字段……），
// **没有一条真正把一局下完**。棋盘尺寸 >32 时落子崩溃的 Bug 正是因此长期藏匿。
// 本文件用真实驱动（addAI 建电脑玩家 → _goMaybeAIMove 推进 → 终局）验证：
//   · 一局能从开局走到终局，中途不崩溃；
//   · 自定义棋盘（含形状+虚空）与超大棋盘同样能下完；
//   · 终局结果自洽（winner 与 ranked 一致、分数有限、非负）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { World, loadKernels } from '../server/engine.js';

await loadKernels();

const rect = (w, h) => Array.from({ length: h }, () => '#'.repeat(w)).join('/');
// 十字臂 + 中央虚空：形状与虚空叠加
function crossVoid(w, h) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    let r = '';
    for (let x = 0; x < w; x++) {
      const mid = Math.floor(w / 2);
      const band = Math.max(2, Math.floor(w / 6));
      const inArm = Math.abs(x - mid) <= band || Math.abs(y - mid) <= band;
      const inCore = Math.abs(x - mid) <= 1 && Math.abs(y - mid) <= 1;
      r += inCore ? 'x' : (inArm ? '#' : '.');
    }
    rows.push(r);
  }
  return rows.join('/');
}

/**
 * 用真实驱动把一局 go 下到底。
 * @returns {{wd:object,g:object,steps:number,aborted:string|null}}
 */
function playToEnd(seed, boardW, boardH, shape, seats, maxSteps = 20000) {
  const wd = new World('fg_' + seed + '_' + boardW, 1, seed, {
    mode: 'go', board: { w: boardW, h: boardH, shape }, stonesPerTurn: 3,
  });
  wd._skipAIFill = true;
  wd.started = true;
  for (let i = 0; i < seats; i++) wd.addAI();      // 电脑玩家同样占席位；go 下自动入座
  const g = wd._goInit();
  let steps = 0, aborted = null;
  while (!g.result && steps < maxSteps) {
    const before = g.moveNo;
    if (!wd._goMaybeAIMove([])) { aborted = 'no_ai_to_move'; break; }
    if (g.result) break;
    if (g.moveNo === before) { aborted = 'no_progress'; break; }
    steps++;
  }
  if (!g.result && !aborted) aborted = 'step_cap';
  return { wd, g, steps, aborted };
}

/** 终局结果自洽性（供各用例复用）。 */
function assertSaneResult(wd, g, label) {
  const res = g.result;
  assert.ok(res, `${label}：应有终局结果`);
  assert.equal(typeof res.reason, 'string', `${label}：reason 应为字符串`);
  assert.ok(Array.isArray(res.ranked) && res.ranked.length > 0, `${label}：ranked 非空`);
  assert.ok(Number.isFinite(res.blackScore) && Number.isFinite(res.whiteScore), `${label}：分数有限`);
  assert.ok(res.blackScore >= 0 && res.whiteScore >= 0, `${label}：分数非负`);
  // winner 必须出现在 ranked 中；为 null（平局）时双方分数应相等
  if (res.winner == null) {
    assert.equal(res.blackScore, res.whiteScore, `${label}：判平局时双方分数必须相等`);
  } else {
    const ids = res.ranked.map((r) => r.playerId);
    assert.ok(ids.includes(res.winner), `${label}：winner 必须来自 ranked`);
    // 胜者分数不得低于同场其他席位（并列时取先手者胜，允许相等）
    const w = res.ranked.find((r) => r.playerId === res.winner);
    for (const r of res.ranked) assert.ok(w.score >= r.score, `${label}：胜者分数不低于 ${r.playerId}`);
  }
  // 盘面 / 数子明细
  const sc = wd._goScoreChinese();
  assert.ok(Number.isFinite(sc.black) && Number.isFinite(sc.white), `${label}：数子有限`);
  assert.equal(sc.black + sc.white >= 0, true, `${label}：总分非负`);
}

test('FG-01 go 默认矩形：AI 对 AI 能把一局下到终局', () => {
  const { wd, g, steps, aborted } = playToEnd(111, 32, 32, rect(32, 32), 2);
  assert.equal(aborted, null, `中途不应中断（aborted=${aborted}）`);
  assert.ok(steps > 0, '应有实际推进的步数');
  assert.ok(g.moveNo > 0, '手数应大于 0');
  assertSaneResult(wd, g, 'FG-01');
});

test('FG-02 go 自定义棋盘（形状 + 虚空）：能下到终局且不崩溃', () => {
  const shape = crossVoid(40, 40);
  const { wd, g, aborted } = playToEnd(222, 40, 40, shape, 2);
  assert.equal(aborted, null, `中途不应中断（aborted=${aborted}）`);
  assert.equal(wd.lifeW, 40, '生命层应为 40（>32 路径）');
  assertSaneResult(wd, g, 'FG-02');
});

test('FG-03 go 棋盘 >32：整局不崩溃（尺寸修复的核心回归）', () => {
  const { wd, g, aborted } = playToEnd(333, 48, 48, rect(48, 48), 2);
  assert.equal(aborted, null, `中途不应中断（aborted=${aborted}）`);
  assert.equal(wd.lifeW, 48);
  assertSaneResult(wd, g, 'FG-03');
});

test('FG-04 go 多方（3 席）：整局可完成且 ranked 覆盖全部席位', () => {
  const { wd, g, aborted } = playToEnd(444, 48, 48, rect(48, 48), 3);
  assert.equal(aborted, null, `中途不应中断（aborted=${aborted}）`);
  assert.equal(g.result.ranked.length, 3, 'ranked 应含 3 个席位');
  assertSaneResult(wd, g, 'FG-04');
});

test('FG-05 rts 自定义棋盘（形状 + 虚空）：出生点合法且 tick 不崩溃', () => {
  const wd = new World('fg_rts', 1, 777, { mode: 'rts', board: { w: 32, h: 32, shape: crossVoid(32, 32) } });
  wd._skipAIFill = true;
  wd.started = true;
  for (let i = 0; i < 4; i++) wd.addAI();
  assert.equal(wd.lifeW, 32, 'rts 生命层恒 32');
  const players = Object.values(wd.players);
  assert.equal(players.length, 4, '应有 4 个玩家');
  for (const p of players) {
    assert.ok(wd._isPlayableWorld(p.x, p.y), `出生点 (${p.x},${p.y}) 必须落在可通行格`);
  }
  for (let t = 0; t < 120; t++) if (typeof wd._tick === 'function') wd._tick();
});

test('FG-06 确定性：同 seed 同尺寸的两局结果一致（winner 与分数）', () => {
  const a = playToEnd(555, 32, 32, rect(32, 32), 2);
  const b = playToEnd(555, 32, 32, rect(32, 32), 2);
  assert.equal(a.aborted, null);
  assert.equal(b.aborted, null);
  assert.equal(a.g.moveNo, b.g.moveNo, '手数一致');
  assert.equal(a.g.result.blackScore, b.g.result.blackScore, '黑分一致');
  assert.equal(a.g.result.whiteScore, b.g.result.whiteScore, '白分一致');
});
