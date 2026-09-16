// tests/bughunt.mode.test.mjs — 对抗式排障（QA Edward）· 只取证，不改源码。
//
// 原始缺陷（已由 Engineer 修复，本文件第 2 轮改为“修复后期望”以做回归守卫）：
//   BUG-1：gomoku/weiqi 第 3 席位的 faction(=3) 与容器“墙”哨兵(=3) 撞值 →
//          假胜 / 棋子对数子不可见 / 不可被提 / 错误码错乱；且该二模式无 2 方上限。
//   BUG-2：落点未校验有限整数，{lx:NaN} 被放行并按 |0 截断。
//
// 修复后契约（本文件据此断言）：
//   · World.GOMOKU_WALL === World.WEIQI_WALL === 99（落在 faction 1..8 之外，永不撞值）。
//   · gomoku/weiqi 恒 2 席：第 3 席（人类或电脑）→ { rejected:'room_full' }；seatCap()===2。
//   · 落子对 NaN/Infinity/浮点 → { ok:false, reason:'bad_move' }。
import test from 'node:test';
import assert from 'node:assert/strict';
import { World, loadKernels } from '../server/engine.js';
import gomokuDef from '../server/modes/gomoku.js';
import weiqiDef from '../server/modes/weiqi.js';

await loadKernels();

// ---------- gomoku：席位上限 + 墙哨兵不再撞值 ----------

function seatedGomoku2(seed = 5) {
  const w = new World('bh_gm2_' + seed, 1, seed, { mode: 'gomoku' });
  w._skipAIFill = true;
  w.addPlayer(1, 'P1');
  w.addPlayer(2, 'P2');
  w._gomokuInit();
  return w;
}

test('BH-GM-01 墙哨兵 = 99（!=faction），且 gomoku 恒 2 席：第 3 人/电脑均被拒', () => {
  const w = seatedGomoku2();
  assert.equal(World.GOMOKU_WALL, 99, '墙哨兵应落在阵营号 1..8 之外');
  assert.equal(w.seatCap(), 2, 'gomoku 有效席位上限 = 2');
  const p3 = w.addPlayer(3, 'P3');
  assert.deepEqual(p3, { rejected: 'room_full' }, '第 3 人应被拒');
  const ai = w.addAI();
  assert.deepEqual(ai, { rejected: 'room_full' }, '第 3 席（电脑）亦应被拒');
  assert.equal(w.gomoku.seats.length, 2, '仅 2 席就座');
});

test('BH-GM-02 假胜消除：两方自然对局中连到 4 子 + 相邻墙格 不判胜', () => {
  // 6×3：第 0 行 col4 为墙（99）
  const shape = '####.#/######/######';
  const w = new World('bh_gm_fakewin2', 1, 11, { mode: 'gomoku', board: { w: 6, h: 3, shape } });
  w._skipAIFill = true;
  w.addPlayer(1, 'P1');
  w.addPlayer(2, 'P2');
  const g = w._gomokuInit();
  assert.equal(g.board[0 * 6 + 4], World.GOMOKU_WALL, '(4,0) 应为墙(99)');

  // 黑(1) 在 (0,0)(1,0)(2,0)(3,0) 连子；白(2) 在别处散落弃子（不成线）
  const seq = [
    [1, 0, 0], [2, 0, 2],
    [1, 1, 0], [2, 3, 2],
    [1, 2, 0], [2, 5, 2],
    [1, 3, 0],   // 黑第 4 子 —— 墙格 (4,0) 不得被算进连线
  ];
  let last = null;
  for (const [pid, x, y] of seq) last = w.applyGomokuIntent(pid, { lx: x, ly: y }, []);
  assert.equal(last.win, undefined, '4 子 + 相邻墙格 不应判胜');
  assert.equal(w.gomoku.result, null, '不应终局');
});

test('BH-GM-03 第 3 人未就座 → not_seated，棋盘不变', () => {
  const w = seatedGomoku2(6);
  const before = Array.from(w.gomoku.board);
  const r = w.applyGomokuIntent(3, { lx: 7, ly: 7 }, []);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_seated');
  assert.equal(w.gomoku.moveNo, 0);
  assert.deepEqual(Array.from(w.gomoku.board), before, '未就座者落子不得改变棋盘');
});

test('BH-GM-04 可达性封堵：2 人类 + addAI 时 AI 不再成为第 3 席', () => {
  const w = new World('bh_gm_ai3', 1, 12, { mode: 'gomoku' });
  w._skipAIFill = true;
  w.addPlayer(1, 'P1');
  w.addPlayer(2, 'P2');
  const ai = w.addAI();               // 修复前会拿到 faction 3（==墙）
  assert.deepEqual(ai, { rejected: 'room_full' });
  const g = w._gomokuInit();
  assert.equal(g.seats.length, 2, '不得出现幽灵第 3 席');
  assert.deepEqual(w.snapshot().maxPlayers, 2);
});

test('BH-GM-05 落点必须是有限整数：NaN / Infinity / 浮点 → bad_move，棋盘不变', () => {
  const w = seatedGomoku2(7);
  for (const bad of [{ lx: NaN, ly: 0 }, { lx: Infinity, ly: 0 }, { lx: 0, ly: -Infinity }, { lx: 1.5, ly: 2 }, { lx: 2, ly: 3.9 }]) {
    const r = w.applyGomokuIntent(1, bad, []);
    assert.equal(r.ok, false, `应拒绝 ${JSON.stringify(bad)}`);
    assert.equal(r.reason, 'bad_move');
  }
  assert.equal(w.gomoku.moveNo, 0, '非法落点不得落子');
});

// ---------- weiqi：席位上限 + 墙哨兵不再撞值 ----------

test('BH-WQ-01 墙哨兵 = 99；weiqi 恒 2 席（第 3 人被拒）；棋子对数子可见', () => {
  const w = new World('bh_wq3b', 1, 7, { mode: 'weiqi' });
  w._skipAIFill = true;
  w.addPlayer(1, 'P1');
  w.addPlayer(2, 'P2');
  const p3 = w.addPlayer(3, 'P3');
  assert.equal(World.WEIQI_WALL, 99, '墙哨兵应落在阵营号 1..8 之外');
  assert.equal(w.seatCap(), 2);
  assert.deepEqual(p3, { rejected: 'room_full' });
  const g = w._weiqiInit();
  assert.equal(g.seats.length, 2);
  // 黑落一子：数子应可见（修复前第 3 方子被当墙，black+white 子数恒 0）
  assert.equal(w.applyWeiqiIntent(1, { lx: 9, ly: 9 }, []).ok, true);
  const sc = w._weiqiScore();
  assert.equal(sc.blackStones + sc.whiteStones, 1, '落子应对数子可见');
  assert.equal(sc.blackStones, 1);
});

test('BH-WQ-02 撞值消除：墙格(99)拒落=wall；而值 3 的格不再被当墙(=occupied)', () => {
  const shape = '####/#x.#/#..#/####';   // (1,1) 为空 → 编译成墙(99)
  const w = new World('bh_wq_wall', 1, 8, { mode: 'weiqi', board: { w: 4, h: 4, shape } });
  w._skipAIFill = true;
  w.addPlayer(1, 'P1'); w.addPlayer(2, 'P2');
  const g = w._weiqiInit();
  assert.equal(g.board[1 * 4 + 1], World.WEIQI_WALL, '(1,1) 墙 = 99');
  // 真正的墙格：拒落，reason=wall
  assert.equal(w.applyWeiqiIntent(1, { lx: 1, ly: 1 }, []).reason, 'wall');
  // 手动把某可落格设成旧哨兵值 3：它不应再被当作墙（证明撞值消除）
  g.board[0 * 4 + 0] = 3;
  assert.equal(w.applyWeiqiIntent(1, { lx: 0, ly: 0 }, []).reason, 'occupied', '值 3 不再是墙语义');
});

test('BH-WQ-03 落点必须是有限整数：NaN / Infinity / 浮点 → bad_move', () => {
  const w = new World('bh_wq_nan', 1, 3, { mode: 'weiqi' });
  w._skipAIFill = true;
  w.addPlayer(1, 'B'); w.addPlayer(2, 'W');
  w._weiqiInit();
  for (const bad of [{ lx: NaN, ly: 0 }, { lx: Infinity, ly: 0 }, { lx: 0, ly: 1.5 }]) {
    const r = w.applyWeiqiIntent(1, bad, []);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'bad_move');
  }
  assert.equal(w.weiqi.moveNo, 0);
});

// ---------- 对照：2 方形状盘 AI 不落非法手（保持绿） ----------

test('BH-AI-01 两方形状盘：gomoku AI 不落墙格/占位（对照组）', () => {
  const shape = '####/#x.#/#..#/####';
  const w = new World('bh_ai_gm', 1, 4, { mode: 'gomoku', board: { w: 4, h: 4, shape } });
  w._skipAIFill = true;
  w.addAI(); w.addAI();
  const g = w._gomokuInit();
  for (let i = 0; i < 12; i++) {
    if (w.gomoku.result) break;
    w._gomokuMaybeAIMove([]);
  }
  for (const mv of g.moveLog) {
    const k = mv.y * g.size + mv.x;
    assert.ok(g.board[k] === 1 || g.board[k] === 2, 'AI 落子格应为 1/2（非空非墙）');
  }
});

test('BH-AI-02 两方形状盘：weiqi AI 不落墙格（对照组）', () => {
  const shape = '####/#x.#/#..#/####';
  const w = new World('bh_ai_wq', 1, 6, { mode: 'weiqi', board: { w: 4, h: 4, shape } });
  w._skipAIFill = true;
  w.addAI(); w.addAI();
  const g = w._weiqiInit();
  for (let i = 0; i < 12; i++) {
    if (w.weiqi.result) break;
    w._weiqiMaybeAIMove([]);
  }
  for (const mv of g.moveLog) {
    const k = mv.y * g.size + mv.x;
    assert.notEqual(g.board[k], World.WEIQI_WALL, 'AI 不得落墙格');
  }
});

// ---------- 规则边界：小盘 / 无合法手 / 崩溃面 / 快照（保持绿） ----------

test('BH-SAFE-01 gomoku 4×4（<5）永不可能胜：走满 → 平局，全程无 win', () => {
  const w = new World('bh_gm4', 1, 2, { mode: 'gomoku', board: { w: 4, h: 4, shape: '####/####/####/####' } });
  w._skipAIFill = true;
  w.addPlayer(1, 'B'); w.addPlayer(2, 'W');
  const g = w._gomokuInit();
  assert.equal(g.size, 4);
  const cells = [];
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) cells.push([x, y]);
  let last = null;
  for (let i = 0; i < cells.length && !w.gomoku.result; i++) {
    const pid = (i % 2 === 0) ? 1 : 2;
    last = w.applyGomokuIntent(pid, { lx: cells[i][0], ly: cells[i][1] }, []);
    assert.equal(last.win, undefined, `4×4 上第 ${i + 1} 手不得判胜`);
  }
  assert.equal(w.gomoku.result && w.gomoku.result.reason, 'draw');
  assert.equal(w.gomoku.moveNo, 16);
});

test('BH-SAFE-02 gomoku 1×1：无死循环，AI 一子即平局', () => {
  const w = new World('bh_gm1', 1, 2, { mode: 'gomoku', board: { w: 1, h: 1, shape: '#' } });
  w._skipAIFill = true;
  w.addAI(); w.addAI();
  w._gomokuInit();
  assert.doesNotThrow(() => { for (let i = 0; i < 5; i++) w._gomokuMaybeAIMove([]); });
  assert.equal(w.gomoku.result && w.gomoku.result.reason, 'draw');
});

test('BH-SAFE-03 weiqi 1×1：无合法手时 AI pass，不崩溃（双 pass 终局）', () => {
  const w = new World('bh_wq1', 1, 2, { mode: 'weiqi', board: { w: 1, h: 1, shape: '#' } });
  w._skipAIFill = true;
  w.addAI(); w.addAI();
  w._weiqiInit();
  assert.doesNotThrow(() => { for (let i = 0; i < 4; i++) w._weiqiMaybeAIMove([]); });
  assert.equal(w.weiqi.result && w.weiqi.result.reason, 'pass');
});

test('BH-SAFE-04 崩溃面：畸形 intent 经 routeIntent 均不抛异常', () => {
  const gm = new World('bh_crash_gm', 1, 1, { mode: 'gomoku' }); gm._skipAIFill = true;
  gm.addPlayer(1, 'B'); gm.addPlayer(2, 'W'); gm._gomokuInit();
  const wq = new World('bh_crash_wq', 1, 1, { mode: 'weiqi' }); wq._skipAIFill = true;
  wq.addPlayer(1, 'B'); wq.addPlayer(2, 'W'); wq._weiqiInit();
  const bad = [null, 'x', 42, [], { gomoku: null }, { gomoku: { lx: {} } }, { gomoku: { lx: 1e9, ly: -1e9 } }];
  for (const b of bad) assert.doesNotThrow(() => gomokuDef.routeIntent(gm, 1, b, []));
  const badW = [null, 'x', 42, [], { weiqi: null }, { weiqi: { lx: {} } }, { weiqi: { pass: 'y' } }, { weiqi: { resign: 1 } }];
  for (const b of badW) assert.doesNotThrow(() => weiqiDef.routeIntent(wq, 1, b, []));
});

test('BH-SAFE-05 快照稳定性：空世界（无玩家）snapshot() 不抛且可序列化', () => {
  for (const mode of ['gomoku', 'weiqi']) {
    const w = new World('bh_snap_' + mode, 1, 1, { mode });
    w._skipAIFill = true;
    let s1, s2;
    assert.doesNotThrow(() => { s1 = w.snapshot(); s2 = w.snapshot(); });
    assert.doesNotThrow(() => JSON.stringify(s1));
    assert.equal(s1.go.turn, null, '空世界无行动方');
    assert.equal(s1.go.seats.length, 0);
    assert.deepEqual(s1.go.board, s2.go.board);
    assert.equal(s1.go.phase, 'play');
  }
});
