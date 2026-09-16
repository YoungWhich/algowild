// tests/mode_seatcap_wall.test.mjs — 工程师（寇豆码）回归测试：BUG-1（2 席上限 + 墙哨兵移出阵营范围）+ BUG-2（落点有限整数）。
//
// 由来（QA 对抗式排障确认的真缺陷）：
//   · 容器"墙"哨兵曾取值 3，与 `_factionOf` 返回的阵营号 1..8 **撞值** → 形状盘上可造假胜 / 提不掉子 / 假"wall"拒绝。
//   · gomoku / weiqi 无模式级 2 席上限 → 第 3 席（人类或电脑）能进入，其 faction=3 被当成墙。
//   · 落点只做 `typeof === 'number'` 校验 → NaN / Infinity / 浮点被 `|0` 静默截断为合法格。
//
// 修复约定：0=空、1=黑、2=白、**墙=99**（落在 1..8 之外）；gomoku/weiqi 恒 2 席（`_mode.maxSeats`，主干只读注册表）。
// IR-3a：本文件为测试，不进入模拟路径；被测源码不得引入 Math.random / Date.now（由既有守卫覆盖）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { World, loadKernels } from '../server/engine.js';
import { getMode } from '../server/modes/index.js';

await loadKernels();

const GOMOKU_WALL = 99;
const WEIQI_WALL = 99;

/** 建一个指定模式的空世界（默认不自动补 AI）。 */
function world(mode, opts = {}) {
  const w = new World('sc_' + mode + '_' + (opts.seed || 1), 1, opts.seed || 1, Object.assign({ mode }, opts.world || {}));
  w._skipAIFill = true;
  return w;
}

// ---------------- A. 注册表元数据（不走 mode 字符串分支，只读 _mode.maxSeats） ----------------

test('SC-REG-01 注册表：gomoku/weiqi 声明 maxSeats=2；rts/go 未声明（受房主上限约束）', () => {
  assert.equal(getMode('gomoku').maxSeats, 2);
  assert.equal(getMode('weiqi').maxSeats, 2);
  assert.equal(getMode('rts').maxSeats, undefined, 'rts 不应有模式级席位上限');
  assert.equal(getMode('go').maxSeats, undefined, 'go 不应有模式级席位上限');
  // 世界实例持有本模式插件
  const w = world('gomoku');
  assert.equal(w._mode.maxSeats, 2);
  assert.equal(w.seatCap(), 2, 'gomoku 有效席位上限 = 2');
});

// ---------------- B. BUG-1 A：模式级 2 席上限（第 3 席人类/电脑一律拒绝） ----------------

test('SC-CAP-01 gomoku：第 3 名人类被拒（room_full），seatCap/快照反映 2', () => {
  const w = world('gomoku');
  const p1 = w.addPlayer(1, 'P1');
  const p2 = w.addPlayer(2, 'P2');
  assert.equal(p1.rejected, undefined);
  assert.equal(p2.rejected, undefined);
  assert.equal(w.seatCap(), 2);
  const p3 = w.addPlayer(3, 'P3');
  assert.deepEqual(p3, { rejected: 'room_full' }, '第 3 席人类必须被拒');
  assert.equal(w.seatCount(), 2);
  const g = w._gomokuInit();
  assert.equal(g.seats.length, 2, 'gomoku 容器应恰好 2 席');
  // 快照字段显示真实上限
  const s = w.snapshot();
  assert.equal(s.seatCap, 2);
  assert.equal(s.maxPlayers, 2);
});

test('SC-CAP-02 gomoku：第 3 台电脑被拒（room_full）；2 席仍可正常对局', () => {
  const w = world('gomoku');
  w.addPlayer(1, 'B');
  w.addPlayer(2, 'W');
  assert.deepEqual(w.addAI(), { rejected: 'room_full' }, '第 3 席（AI）必须被拒');
  assert.equal(w.seatCount(), 2);
  const g = w._gomokuInit();
  assert.equal(g.seats.length, 2);
  // 2 席对局仍工作：黑先手落子成功
  assert.equal(w.applyGomokuIntent(1, { lx: 7, ly: 7 }, []).ok, true);
  assert.equal(g.board[7 * 15 + 7], 1);
});

test('SC-CAP-03 weiqi：第 3 名人类与第 3 台电脑均被拒，容器恰好 2 席', () => {
  const w = world('weiqi');
  w.addPlayer(1, 'B');
  w.addPlayer(2, 'W');
  assert.deepEqual(w.addPlayer(3, 'P3'), { rejected: 'room_full' });
  assert.deepEqual(w.addAI(), { rejected: 'room_full' });
  const g = w._weiqiInit();
  assert.equal(g.seats.length, 2);
  assert.equal(w.seatCap(), 2);
  assert.equal(w.snapshot().seatCap, 2);
});

test('SC-CAP-04 房主把 maxPlayers 设为 8，gomoku 仍封顶 2；rts/go 不受影响', () => {
  const gm = world('gomoku', { world: { maxPlayers: 8 } });
  gm.addPlayer(1, 'A'); gm.addPlayer(2, 'B');
  assert.equal(gm.seatCap(), 2, '模式级上限优先于房主设定');
  assert.deepEqual(gm.addPlayer(3, 'C'), { rejected: 'room_full' });
  // rts：seatCap 跟随房主设定（8）
  const r = world('rts', { world: { maxPlayers: 8 } });
  assert.equal(r.seatCap(), 8);
  // go：seatCap 跟随房主设定（8），不因棋盘类而被误封顶
  const go = world('go', { world: { maxPlayers: 8 } });
  assert.equal(go.seatCap(), 8);
});

// ---------------- C. BUG-1 B：墙哨兵移出阵营范围（=99），不再与 1..8 撞值 ----------------

test('SC-WALL-01 墙哨兵 = 99，落在阵营号 1..8 之外（双模式一致）', () => {
  assert.equal(World.GOMOKU_WALL, 99);
  assert.equal(World.WEIQI_WALL, 99);
  assert.ok(World.GOMOKU_WALL > 8 && World.GOMOKU_WALL > World.MAX_SLOTS, '墙值必须超出席位范围');
  assert.ok(World.WEIQI_WALL > 8 && World.WEIQI_WALL > World.MAX_SLOTS);
});

test('SC-WALL-02 形状盘：墙格标 99 且拒落(wall)；可落格成功；容器值不与阵营撞车', () => {
  const SHAPE_4 = '####/#x.#/#..#/####';           // 墙 = (1,1)(2,1)(1,2)(2,2)
  for (const mode of ['gomoku', 'weiqi']) {
    const w = world(mode, { world: { board: { w: 4, h: 4, shape: SHAPE_4 } } });
    w.addPlayer(1, 'B'); w.addPlayer(2, 'W');
    const g = mode === 'gomoku' ? w._gomokuInit() : w._weiqiInit();
    const K = (x, y) => y * 4 + x;
    for (const [x, y] of [[1, 1], [2, 1], [1, 2], [2, 2]]) {
      assert.equal(g.board[K(x, y)], 99, `${mode} (${x},${y}) 应为墙(99)`);
    }
    const before = Array.from(g.board);
    for (const [x, y] of [[1, 1], [2, 1], [1, 2], [2, 2]]) {
      const r = mode === 'gomoku'
        ? w.applyGomokuIntent(1, { lx: x, ly: y }, [])
        : w.applyWeiqiIntent(1, { lx: x, ly: y }, []);
      assert.equal(r.reason, 'wall', `${mode} 墙格应拒为 wall`);
    }
    assert.deepEqual(Array.from(g.board), before, '被拒后棋盘不得改变');
    const ok = mode === 'gomoku'
      ? w.applyGomokuIntent(1, { lx: 0, ly: 0 }, [])
      : w.applyWeiqiIntent(1, { lx: 0, ly: 0 }, []);
    assert.equal(ok.ok, true, `${mode} 可落格应成功`);
  }
});

test('SC-WALL-03 撞车消除：棋子值 ∈ {1,2}，墙(99) 不等于任何席位 faction', () => {
  const w = world('gomoku');       // 标准 15×15（board=null，无墙）
  w.addPlayer(1, 'B'); w.addPlayer(2, 'W');
  const g = w._gomokuInit();
  w.applyGomokuIntent(1, { lx: 7, ly: 7 }, []);
  w.applyGomokuIntent(2, { lx: 7, ly: 8 }, []);
  assert.equal(g.board[7 * 15 + 7], 1);
  assert.equal(g.board[8 * 15 + 7], 2);
  for (const f of g.seatF) {
    assert.ok(f >= 1 && f <= 8, '阵营号应在 1..8');
    assert.notEqual(f, World.GOMOKU_WALL, '阵营号绝不得等于墙哨兵');
  }
});

test('SC-WALL-04 形状盘"假胜"消除：4 子 + 1 墙格 不判五连', () => {
  // 6×3：第 0 行 col4 为墙（形状外 '.'），其余可落子。
  const shape = '####.#/######/######';
  const w = world('gomoku', { seed: 9, world: { board: { w: 6, h: 3, shape } } });
  w.addPlayer(1, 'B'); w.addPlayer(2, 'W');
  const g = w._gomokuInit();
  const K = (x, y) => y * 6 + x;
  assert.equal(g.board[K(4, 0)], 99, '(4,0) 应为墙(99)');
  // 黑方已摆 3 子 (0,0)(1,0)(2,0)，再落 (3,0) → 4 连 + 紧邻墙(99) ≠ 五连
  g.board[K(0, 0)] = 1; g.board[K(1, 0)] = 1; g.board[K(2, 0)] = 1;
  g.turnIdx = 0; g.turn = 1;
  const r = w.applyGomokuIntent(1, { lx: 3, ly: 0 }, []);
  assert.equal(r.win, undefined, '4 子 + 墙不应判胜');
  assert.equal(g.result, null, '不应终局');
});

// ---------------- D. BUG-2：落点必须是有限整数 ----------------

test('SC-INT-01 gomoku：NaN/Infinity/浮点 → bad_move；整数越界 → oob', () => {
  const w = world('gomoku');
  w.addPlayer(1, 'B'); w.addPlayer(2, 'W');
  const g = w._gomokuInit();
  for (const bad of [[NaN, 0], [0, NaN], [Infinity, 0], [0, -Infinity], [1.5, 0], [0, 2.5], [1.0000001, 3]]) {
    const r = w.applyGomokuIntent(1, { lx: bad[0], ly: bad[1] }, []);
    assert.equal(r.ok, false, `应拒绝 (${bad[0]},${bad[1]})`);
    assert.equal(r.reason, 'bad_move', `应判 bad_move（实为 ${r.reason}）`);
  }
  assert.equal(g.moveNo, 0, '非法坐标不得落子');
  assert.equal(g.board.every((v) => v === 0), true, '棋盘应保持全空');
  // 合法整数但越界 → oob（区别于 bad_move）
  assert.equal(w.applyGomokuIntent(1, { lx: 15, ly: 0 }, []).reason, 'oob');
  assert.equal(w.applyGomokuIntent(1, { lx: -1, ly: 0 }, []).reason, 'oob');
});

test('SC-INT-02 weiqi：NaN/Infinity/浮点 → bad_move；越界 → oob', () => {
  const w = world('weiqi');
  w.addPlayer(1, 'B'); w.addPlayer(2, 'W');
  const g = w._weiqiInit();
  for (const bad of [[NaN, 0], [0, NaN], [Infinity, 5], [3.5, 3.5], [-0.5, 1]]) {
    const r = w.applyWeiqiIntent(1, { lx: bad[0], ly: bad[1] }, []);
    assert.equal(r.ok, false, `应拒绝 (${bad[0]},${bad[1]})`);
    assert.equal(r.reason, 'bad_move');
  }
  assert.equal(g.moveNo, 0);
  assert.equal(w.applyWeiqiIntent(1, { lx: 19, ly: 0 }, []).reason, 'oob');
});

// ---------------- E. 隔离性：本改动不得波及 rts / go 的席位与棋盘 ----------------

test('SC-ISO-01 rts 仍可容纳 8 席；go 3 席不受影响', () => {
  const r = world('rts', { world: { maxPlayers: 8 } });
  for (const id of [1, 2, 3, 4, 5, 6, 7, 8]) assert.equal(r.addPlayer(id, 'P' + id).rejected, undefined);
  assert.equal(r.seatCap(), 8);
  assert.equal(r.seatCount(), 8);
  const go = world('go', { world: { maxPlayers: 8 } });
  go.addPlayer(1, 'A'); go.addPlayer(2, 'B');
  go.addAI();
  assert.equal(go.seatCount(), 3, 'go 未被 2 席上限波及');
  assert.equal(go.seatCap(), 8);
});
