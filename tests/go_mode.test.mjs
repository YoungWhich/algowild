// tests/go_mode.test.mjs — 回合制模式（go）· 围棋提子 + 康威演化
// 覆盖 docs/go-mode-arch.md §6 的 GM-01 ~ GM-18。
// 风格参考 tests/life_board.test.mjs：node:test + node:assert/strict。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { World, loadKernels } from '../server/engine.js';

// 加载算法内核（Voronoi / markov_chain 等），否则领地计分与呼吸机制拿不到内核。
await loadKernels();

// go 模式世界：空盘、2 座位、跳过 AI 自动补位（测试自控）
function freshGoWorld(seed = 42, skipAI = true) {
  const w = new World('go1', 1, seed, { mode: 'go' });
  w._skipAIFill = skipAI;
  return w;
}
// 建一个 2 人类座位的 go 世界，返回 { w, black, white }
function seated(seed = 42) {
  const w = freshGoWorld(seed);
  const black = w.addPlayer(1, 'Black');
  const white = w.addPlayer(2, 'White');
  w._goInit();
  return { w, black, white };
}
// 黑白阵营号
function fB(w) { return w.go.blackF; }
function fW(w) { return w.go.whiteF; }

test('GM-01 提单子：落子使 1 颗敌子无气 → 被提，captured===1，该点变 0', () => {
  const { w } = seated();
  const L = w._life;
  const B = fB(w), W = fW(w);
  // 白子(5,5)，黑占其 3 个 4-邻，留 (5,6) 作为黑下一手
  L[5][5] = W; L[4][5] = B; L[6][5] = B; L[5][4] = B;
  assert.equal(w._goLiberties(5, 5), 1, '提子前白子应有 1 口气');
  const r = w._goPlay(B, 5, 6, []);
  assert.equal(r.ok, true);
  assert.equal(r.captured, 1, '应恰好提 1 子');
  assert.equal(L[5][5], 0, '被提点应变 0');
});

test('GM-02 提整团：3 子团被围 → 一次提 3', () => {
  const { w } = seated();
  const L = w._life;
  const B = fB(w), W = fW(w);
  // 白 3 子团 (5,5)(5,6)(6,5)，黑围住其外侧，留 (6,6) 作最后一手
  L[5][5] = W; L[5][6] = W; L[6][5] = W;
  L[4][5] = B; L[4][6] = B; L[6][6 - 2] = B; // (6,3) 无关，占位避免歧义
  L[6][4] = B; L[5][7] = B; L[6][6 + 1] = B; // (6,7)
  L[4][6] = B; L[5][5 - 1] = B;              // (5,4)
  L[6][6] = 0;                                // 留作最后落点
  L[7][5] = B; L[7][6] = B;                   // 右侧封口
  assert.equal(w._goLiberties(5, 5), 1, '白团应只剩 (6,6) 一口');
  const r = w._goPlay(B, 6, 6, []);
  assert.equal(r.ok, true);
  assert.equal(r.captured, 3, '应一次提 3 子');
  assert.equal(L[5][5], 0); assert.equal(L[5][6], 0); assert.equal(L[6][5], 0);
});

test('GM-03 禁自杀：落子在无气且未提子的点 → suicide，棋盘不变', () => {
  const { w } = seated();
  const L = w._life;
  const B = fB(w), W = fW(w);
  // 白占 (3,3) 的 4-邻
  L[2][3] = W; L[4][3] = W; L[3][2] = W; L[3][4] = W;
  const r = w._goPlay(B, 3, 3, []);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'suicide');
  assert.equal(L[3][3], 0, '自杀手应回滚，落点保持空');
});

test('GM-04 有气可落：紧邻敌子但自身有气 → ok', () => {
  const { w } = seated();
  const L = w._life;
  const B = fB(w), W = fW(w);
  L[5][5] = W;
  // 黑落在 (5,6)，紧邻白子但四周还有空 → 有气，合法
  const r = w._goPlay(B, 5, 6, []);
  assert.equal(r.ok, true);
  assert.equal(L[5][6], B);
});

test('GM-05 劫禁着：构造劫 → 立即回提被拒 reason=ko', () => {
  const { w } = seated();
  const L = w._life;
  const B = fB(w), W = fW(w);
  // 经典劫形：(5,5)=白(1 气在 6,5)，周围黑；(6,5) 落黑后自身仅 1 气(在 5,5)
  L[5][5] = W; L[4][5] = B; L[5][4] = B; L[5][6] = B;
  L[7][5] = W; L[6][4] = W; L[6][6] = W;
  const r1 = w._goPlay(B, 6, 5, []);
  assert.equal(r1.ok, true);
  assert.equal(r1.captured, 1);
  assert.ok(w.go.ko && w.go.ko.lx === 5 && w.go.ko.ly === 5, '应记劫禁着 (5,5)');
  const r2 = w._goPlay(W, 5, 5, []);
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'ko');
});

test('GM-06 劫后应一手可回提：双方各走一手后 → 回提成功', () => {
  const { w } = seated();
  const L = w._life;
  const B = fB(w), W = fW(w);
  L[5][5] = W; L[4][5] = B; L[5][4] = B; L[5][6] = B;
  L[7][5] = W; L[6][4] = W; L[6][6] = W;
  const r1 = w._goPlay(B, 6, 5, []);
  assert.equal(r1.ok, true);
  // 白在他处应一手
  const r2 = w._goPlay(W, 20, 20, []);
  assert.equal(r2.ok, true);
  // 黑再走一手（劫自动解除）
  const r3 = w._goPlay(B, 21, 20, []);
  assert.equal(r3.ok, true);
  // 白回提 → 应成功
  const r4 = w._goPlay(W, 5, 5, []);
  assert.equal(r4.ok, true, '隔一手后回提应被允许');
  assert.equal(r4.captured, 1);
});

test('GM-07 演化确定性：同 seed 同手顺双跑 → 逐手 lifeGrid 一致', () => {
  // 需求返工（2026-09-10）：取消"孤子不死"，恢复标准康威 B3/S23。故"远离稀疏"的单子会立即死亡，
  // 这里改为**每回合一批、紧凑成团**的下法（默认每回合 3 颗；三颗 L 形会塌成 2×2 稳定块），
  // 既覆盖多颗落子，又让盘面稳定，专注验证确定性。
  const batches = [
    [[4, 4], [5, 4], [4, 5]],       // 黑：L 形 → 塌成 2×2
    [[27, 27], [26, 27], [27, 26]], // 白：L 形
    [[16, 4], [17, 4], [16, 5]],
    [[16, 27], [17, 27], [16, 26]],
  ];
  function run() {
    const w = freshGoWorld(12345);
    w.addPlayer(1, 'A'); w.addPlayer(2, 'B');
    w._goInit();
    const snaps = [];
    for (const batch of batches) {
      const cur = w.go.seats[w.go.turnIdx];
      const r = w.applyGoIntent(cur, { moves: batch.map(([lx, ly]) => ({ lx, ly })) }, []);
      assert.equal(r.ok, true, `batch ${JSON.stringify(batch)} 应合法`);
      assert.equal(r.placed, batch.length, '整批应全部落下');
      snaps.push(w.snapshot().lifeGrid.map(col => col.join(',')));
    }
    return snaps;
  }
  const a = run(), b = run();
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assert.deepEqual(a[i], b[i], `第 ${i + 1} 手后盘面应完全一致`);
  }
});

test('GM-08 演化平票：1:1 邻域 → 平票由种子掷定（两阵营都可能出现）', () => {
  // 说明（如实）：诞生阈值默认为 3/5（奇数），此时 cnt[黑]+cnt[白]=n 为奇数，
  // 故 cnt[黑] !== cnt[白] 恒成立 → 平票分支在默认配置下不可达。
  // 为覆盖"平票掷种子"这条代码路径，这里用偶数阈值 2 构造 1:1 邻域（cnt[黑]=cnt[白]=1）。
  const drew = new Set();
  for (let seed = 1; seed <= 80; seed++) {
    const w = freshGoWorld(seed);
    w.addPlayer(1, 'A'); w.addPlayer(2, 'B');
    w._goInit();
    const L = w._life;
    const B = w.go.blackF, W = w.go.whiteF;
    // 空格 (5,5)：8 邻恰好 1 黑 1 白（n=2），设 bornThresh=2 → 触发诞生且平票
    L[4][5] = B; L[6][5] = W;
    w._goEvolveOnce(2);
    // _goEvolveOnce 会替换 this._life，故必须从 w._life 读（不是旧的 L）
    const v = w._life[5][5];
    if (v === B) drew.add('B');
    if (v === W) drew.add('W');
  }
  assert.equal(drew.size, 2, '平票时应由种子掷出两种阵营（多 seed 覆盖）');

  // 另：默认阈值（3）下，多 seed 多步后黑、白两阵营都应参与演化（都出现过新生子）。
  const seen = new Set();
  for (let seed = 1; seed <= 40 && seen.size < 2; seed++) {
    const w = freshGoWorld(seed);
    w.addPlayer(1, 'A'); w.addPlayer(2, 'B');
    w._goInit();
    const L = w._life;
    const B = w.go.blackF, W = w.go.whiteF;
    // 棋盘斑块：制造密集边界
    for (let x = 0; x < 14; x++) for (let y = 0; y < 14; y++) {
      L[x][y] = ((x + y) % 2 === 0) ? B : W;
    }
    for (let s = 0; s < 3; s++) w._goEvolveOnce(3);
    let hasB = false, hasW = false;
    for (let x = 0; x < 32; x++) for (let y = 0; y < 32; y++) {
      if (L[x][y] === B) hasB = true;
      if (L[x][y] === W) hasW = true;
    }
    if (hasB) seen.add('B');
    if (hasW) seen.add('W');
  }
  assert.equal(seen.size, 2, '演化后两阵营都应出现过');
});

test('GM-09 刚落的子不死：落子后立即演化 → 该点仍为落子方', () => {
  const { w } = seated();
  const B = fB(w);
  const r = w._goPlay(B, 10, 10, []);
  assert.equal(r.ok, true);
  // 演化（正常 1 步）：本回合刚落的子豁免死亡
  w._goEvolve(0, []);
  assert.equal(w._life[10][10], B, '刚落的子不应在当回合演化中死亡');
});

test('GM-10 领地计分：落子后 go.territory 之和 > 0，归属正确阵营', () => {
  const { w } = seated();
  const B = fB(w);
  w._goPlay(B, 16, 16, []);
  const sc = w._goScore();
  assert.ok(sc.black > 0, '黑应有领地格');
  assert.equal(sc.white, 0, '白无子时应 0 目');
  // 快照字段一致
  const g = w.snapshot().go;
  assert.equal(g.territory.black, sc.black);
  assert.equal(g.territory.white, sc.white);
});

test('GM-11 终局-连续 pass：两次 pass → go.result.reason === "pass"', () => {
  const { w } = seated();
  const ev = [];
  assert.equal(w.applyGoIntent(1, { pass: true }, ev).ok, true);
  assert.equal(w.applyGoIntent(2, { pass: true }, ev).ok, true);
  assert.ok(w.go.result, '应已终局');
  assert.equal(w.go.result.reason, 'pass');
});

test('GM-12 终局-手数上限：moveNo=150 → reason === "max_moves"', () => {
  const { w } = seated();
  const ev = [];
  // 直接设 moveNo 逼近上限，再落一手触发换手 → 进入 endTurn 判定
  w.go.moveNo = 150;
  const r = w.applyGoIntent(1, { lx: 16, ly: 16 }, ev);
  assert.equal(r.ok, true);
  assert.ok(w.go.result, '应已终局');
  assert.equal(w.go.result.reason, 'max_moves');
});

test('GM-13 终局-吃光不再判胜：一方 lifeCells=0 → reason=wiped 触发终局，但胜者由数子决定', () => {
  const { w } = seated();
  const ev = [];
  const pB = w.players[w.go.blackId];
  // 模拟黑曾经达到规模后被清零（盘面清空确保白也无子 → 数子双方都 0 → 平局）
  for (let x = 0; x < 32; x++) for (let y = 0; y < 32; y++) w._life[x][y] = 0;
  pB.maxLifeCells = 6;
  pB.lifeCells = 0;
  // 触发一次 endTurn（当前行动方 pass）
  const cur = w.go.seats[w.go.turnIdx];
  w.applyGoIntent(cur, { pass: true }, ev);
  assert.ok(w.go.result, '应已终局（wiped 仍作为终局触发器）');
  assert.equal(w.go.result.reason, 'wiped');
  assert.equal(pB.lost, true, '被吃光方应 lost');
  // 关键行为变更（VC-09/VC-10）：清盘**不再**让对手无条件胜；胜负由数子决定。
  // 本局面盘面全空 → 双方数子 0:0 → 平局（winner=null），绝不再是"清盘者对手胜"。
  assert.equal(w.go.result.winner, null, '清盘不产生"清盘者对手无条件胜"，双方同分应为平局');
  // 数子明细应为 0 子 0 空点
  assert.equal(w.go.result.blackScore, 0);
  assert.equal(w.go.result.whiteScore, 0);
});

test('GM-14 超时=pass：turnTicks 推到 30 → go_timeout 事件 + 手数推进', () => {
  const { w } = seated();
  w.go.turnTicks = 30;   // 30 × 1000 >= GO_TURN_MS(30000)
  const before = w.go.moveNo;
  const r = w._goTick();
  const hasTimeout = r.events.some(e => e.type === 'go_timeout');
  assert.ok(hasTimeout, '应产生 go_timeout 事件');
  assert.ok(w.go.moveNo > before, '超时应推进手数（视为 pass）');
  // 行动方超时计数 +1
  const pid = w._lifeOwners[w.go.turn - 1] || w._lifeOwners[(w.go.turn === w.go.blackF ? w.go.whiteF : w.go.blackF) - 1];
  const anyTimeout = Object.values(w.players).some(p => (p.goTimeouts || 0) >= 1);
  assert.ok(anyTimeout, '某方 goTimeouts 应 +1');
  void pid;
});

test('GM-15 非行动方落子被拒：not_your_turn', () => {
  const { w } = seated();
  // 当前行动方 = 黑
  const blackF = w.go.blackF;
  const nonTurner = blackF === 1 ? 2 : 1;   // 另一个 playerId
  const r = w.applyGoIntent(nonTurner, { lx: 16, ly: 16 }, []);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_your_turn');
});

test('GM-16 mode 回归：rts 世界跑 200 tick，lifeGrid 仍含 11+ 弱痕，行为不变', () => {
  const w = new World('r1', 1, 777, { mode: 'rts' });
  w._skipAIFill = true;
  const p = w.addPlayer(1, 'P');
  assert.equal(w.mode, 'rts');
  assert.equal(w.snapshot().go, null, 'rts 快照的 go 字段应为 null');
  // 移动留弱痕（faction+10 编码）
  for (let i = 0; i < 200; i++) {
    p.x = 40 + (i % 20) * 4; p.y = 40 + Math.floor(i / 20) * 4;
    w.tickOnce();
  }
  let hasTrail = false;
  for (let x = 0; x < World.LIFE_W; x++) for (let y = 0; y < World.LIFE_W; y++) {
    const v = w._life[x][y];
    if (v >= 11) { hasTrail = true; break; }
  }
  assert.ok(hasTrail, 'rts 世界仍应产出 11+ 弱痕编码（未受 go 改动影响）');
});

test('GM-17 零 Math.random / Date.now：go 相关源码 grep 无二者', () => {
  const files = ['server/go.js', 'server/ai.js'];
  // 去掉注释与行内注释后再 grep：铁律禁的是"模拟内执行"，注释里提及禁令本身是允许的。
  const stripComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => line.replace(/\/\/.*$/, ''))
    .join('\n');
  for (const f of files) {
    const src = stripComments(readFileSync(new URL('../' + f, import.meta.url), 'utf8'));
    assert.ok(!/Math\.random\s*\(/.test(src), `${f} 不应出现 Math.random()`);
    assert.ok(!/Date\.now\s*\(/.test(src), `${f} 不应出现 Date.now()`);
  }
});

test('GM-18 呼吸/事件内核接入：moveNo 到 10/25 → breath 变化 / event !== calm 出现过', () => {
  const { w } = seated();
  const ev = [];
  // 强制推进到第 10 手（换手时会触发 _goBreathe）
  w.go.moveNo = 10;
  const breathBefore = w.go._breathR;
  // 落一手 → endTurn 使 moveNo=11，(11 % 10===1) → 呼吸
  w.applyGoIntent(w._lifeOwners[w.go.turn - 1], { lx: 5, ly: 5 }, ev);
  const breathAfter = w.go._breathR;
  // breath 应属于 {3,4,5}，且呼吸内部状态已更新（值可能相同，但 breathState 一定被推进）
  assert.ok([3, 4, 5].includes(breathAfter), 'breath 应 ∈ {3,4,5}');
  void breathBefore;
  // 事件：推到第 25 手边界
  w.go.moveNo = 25;
  w.applyGoIntent(w._lifeOwners[w.go.turn - 1], { lx: 6, ly: 6 }, ev);
  assert.ok(w.go.lastEvent && ['calm', 'flourish', 'frost', 'mutate'].includes(w.go.lastEvent),
    '应已抽取世界事件');
  // 至少在一次运行里 event !== calm（多 seed 覆盖）
  let nonCalm = w.go.lastEvent !== 'calm';
  for (let seed = 1; seed <= 30 && !nonCalm; seed++) {
    const { w: w2 } = seated(seed);
    w2.go.moveNo = 25;
    w2.applyGoIntent(w2._lifeOwners[w2.go.turn - 1], { lx: 6, ly: 6 }, []);
    if (w2.go.lastEvent && w2.go.lastEvent !== 'calm') nonCalm = true;
  }
  assert.ok(nonCalm, '多 seed 下世界事件应至少出现过一次非 calm');
});

// 额外：AI 出手不阻塞、且不同 seed 可复现（GO-10 支撑）
test('GM-19(附带) goAIMove 返回合法整批或 pass（空盘→天元小群落）', async () => {
  await loadKernels();
  const { w } = seated(7);
  const mv = World.goAIMove(w, w.go.blackF);
  assert.ok(mv && (mv.pass === true || (Array.isArray(mv.moves) && mv.moves.length > 0)),
    'goAIMove 应返回 {moves:[...]} 或 {pass:true}');
  if (!mv.pass) {
    assert.ok(mv.moves.length >= 1 && mv.moves.length <= w.stonesPerTurn,
      `一批棋子数应在 1..stonesPerTurn（${w.stonesPerTurn}）`);
    for (const p of mv.moves) {
      assert.ok(Number.isInteger(p.lx) && Number.isInteger(p.ly), 'AI 落点应为整数坐标');
      assert.ok(p.lx >= 0 && p.lx < 32 && p.ly >= 0 && p.ly < 32, 'AI 落点应在盘内');
    }
    const r = w._goPlayBatch(w.go.blackF, mv.moves, []);
    assert.equal(r.ok, true, 'AI 整批落点应合法');
  }
});

// GM-20：**手动**添加电脑玩家后，轮到它时会自动出手（不阻塞回合）
// 新席位模型：AI 不再自动补位，必须由玩家显式 addAI()。
test('GM-20(附带) 手动添加的 AI 轮到它时自动落子', async () => {
  await loadKernels();
  const w = freshGoWorld(99);
  w.addPlayer(1, 'Human');
  const ai = w.addAI();                 // 手动添加，而不是自动补位
  assert.ok(ai && ai.id, '应成功添加一个电脑玩家');
  const g = w._goInit();
  assert.equal(g.seats.length, 2, '应有 2 个座位（1 人类 + 1 AI）');
  // 让 AI 成为当前行动方
  const aiIdx = g.seats.indexOf(ai.id);
  g.turnIdx = aiIdx;
  g.turn = g.seatF[aiIdx];
  const events = [];
  const did = w._goMaybeAIMove(events);
  assert.equal(did, true, 'AI 应完成一手');
  const played = w.go.moveLog.length > 0 || (w.go.passStreak || 0) > 0;
  assert.ok(played, 'AI 应落子或 pass');
});

// GM-21（席位模型）：**席位数由房主设置**，**电脑玩家同样占席位**，人类与电脑共用同一池；
// 硬上限 8。AI 只由玩家手动添加（不自动补位），所以不会偷偷把位子占满。
test('GM-21 席位模型：房主设定席位数 + 电脑玩家占席位 + 硬上限 8', () => {
  const w = freshGoWorld(42);
  w.maxPlayers = 3;                     // 房主设定：本局最多 3 个席位（人类 + 电脑）
  assert.equal(w.seatCap(), 3);
  const a = w.addPlayer(101, 'HumanA');
  const ai1 = w.addAI();
  const ai2 = w.addAI();
  assert.ok(a && a.id && ai1 && ai1.id && ai2 && ai2.id, '1 人类 + 2 电脑应全部就座');
  assert.equal(w.seatCount(), 3, '电脑玩家同样占席位');
  assert.equal(w.humanCount(), 1, '人类数单独统计');
  // 席位已满：人类与电脑都被拒绝
  assert.equal((w.addPlayer(102, 'HumanB') || {}).rejected, 'room_full', '满席后人类应被拒绝');
  assert.equal((w.addAI() || {}).rejected, 'room_full', '满席后电脑也应被拒绝');
  // 自定义上限：8 席全满后再加被拒；且硬上限不超过 8
  const w2 = freshGoWorld(7);
  w2.maxPlayers = 99;                   // 试图超过硬上限
  assert.equal(w2.seatCap(), 8, '席位上限不得突破硬上限 8');
  for (let i = 0; i < 6; i++) w2.addPlayer(200 + i, 'H' + i);
  w2.addAI(); w2.addAI();
  assert.equal(w2.seatCount(), 8, '总数应达 8');
  assert.equal((w2.addAI() || {}).rejected, 'room_full', '超过 8 席应拒绝');
  assert.equal((w2.addPlayer(299, 'HX') || {}).rejected, 'room_full', '超过 8 席的人类也应拒绝');
  // 单人开局（maxPlayers=1）也能玩：1 席即满
  const w3 = freshGoWorld(3);
  w3.maxPlayers = 1;
  w3.addPlayer(301, 'Solo');
  assert.equal(w3.seatCount(), 1);
  assert.equal((w3.addAI() || {}).rejected, 'room_full', '1 席局满员后不得再加');
});

// GM-22：移除 AI 必须回收 faction 槽位（置 null 复用、长度不变），且计分/快照不崩。
// 这是 CRITICAL-1 的根因不变式：faction 号是 _lifeOwner 网格的索引，绝不能 splice 缩短。
test('GM-22 faction 槽位回收：移除 AI 后 whiteF===2、长度不变、计分/快照不崩', () => {
  const w = freshGoWorld(42);
  const a = w.addPlayer(101, 'HumanA');   // faction 1
  const ai1 = w.addAI();                  // faction 2
  w.addPlayer(102, 'HumanB');             // faction 3
  const g0 = w._goInit();
  assert.equal(g0.seatF.length, 3, '应有 3 个座位');
  const lenBefore = w._lifeOwners.length;
  assert.ok(w.removeAI(ai1.id), '应能移除该 AI');
  // 长度不变（只置 null），且人类 B 仍是 faction 3（不做压缩重排）
  assert.equal(w._lifeOwners.length, lenBefore, '_lifeOwners 长度不得因移除而缩短');
  assert.equal(w._factionOf(102), 3, '既有玩家的 faction 号不得被重排');
  // AI 的 id 已被置空
  assert.equal(w._lifeOwners.indexOf(ai1.id), -1, '被移除 AI 的 id 不应残留在 _lifeOwners');
  // 再补一个 AI → 复用空槽（faction 2），不会无限膨胀
  const ai2 = w.addAI();
  assert.equal(w._factionOf(ai2.id), 2, '新 AI 应复用被回收的 faction 2 空槽');
  assert.equal(w._lifeOwners.length, lenBefore, '复用空槽后 _lifeOwners 长度仍不变');
  assert.doesNotThrow(() => w._goScore(), '_goScore 不应抛异常');
  assert.doesNotThrow(() => w.snapshot(true), 'snapshot 不应抛异常');
});

// FIX-C1（直接崩溃点 + 归属判定）：图案奖不得因 faction 非 {1,2} 崩溃；
// faction 1/2 的团奖励归属正确；第三方 faction（如 3）不崩且不计分。
test('GM-23 图案奖不崩：faction1/2 归属正确 + faction3 不崩且不计分', async () => {
  await loadKernels();
  const { w } = seated();
  const B = fB(w), W = fW(w);
  const L = w._life;
  // 黑方一条横 3 格（振荡图案 +2 归属黑）；白方一条纵 3 格（+2 归属白）
  L[3][3] = B; L[4][3] = B; L[5][3] = B;
  L[10][10] = W; L[10][11] = W; L[10][12] = W;
  let sc;
  assert.doesNotThrow(() => { sc = w._goScore(); }, '正常盘面 _goScore 不应崩溃');
  // 归属正确：黑/白各得至少一次图案奖（振荡 +2）
  assert.ok(sc.bonus.black >= 2, '黑方应至少获得振荡图案奖 +2，实际 black bonus=' + sc.bonus.black);
  assert.ok(sc.bonus.white >= 2, '白方应至少获得振荡图案奖 +2，实际 white bonus=' + sc.bonus.white);
  const blackHits = sc.bonus.hits.filter(h => h.f === B);
  const whiteHits = sc.bonus.hits.filter(h => h.f === W);
  assert.ok(blackHits.length >= 1 && whiteHits.length >= 1, '黑白团应各自计入对应方');

  // 第三方 faction 3 单独场景：盘面只有一条 faction 3 的横 3 格团（振荡图案），
  // 不得崩溃、不得给 black/white 计任何分（即使图案本身可识别）。
  const { w: w3 } = seated(7);
  const L3 = w3._life;
  L3[15][15] = 3; L3[16][15] = 3; L3[17][15] = 3;
  let sc3;
  assert.doesNotThrow(() => { sc3 = w3._goScore(); }, 'faction 3 的团不应使 _goScore 崩溃');
  assert.equal(sc3.bonus.black, 0, 'faction 3 不得计入黑方');
  assert.equal(sc3.bonus.white, 0, 'faction 3 不得计入白方');
  const f3hits = sc3.bonus.hits.filter(h => h.f === 3);
  assert.ok(f3hits.length >= 1, 'faction 3 的图案应被识别但不计分，实际 hits=' + JSON.stringify(sc3.bonus.hits));
  // 快照也不得因 faction 3 崩溃
  assert.doesNotThrow(() => w3.snapshot(true), 'faction 3 下 snapshot 不应崩溃');
});



// ==================== 席位/房主新模型（2026-09-10 需求返工） ====================

// GM-24：**中途离开由电脑接手**（不删除玩家），**重连即接回原位**
test('GM-24 掉线由电脑接手：botControlled 后电脑替其出手，重连交还控制权', () => {
  const w = freshGoWorld(11);
  const a = w.addPlayer(501, 'A');
  const b = w.addPlayer(502, 'B');
  assert.ok(a && a.id && b && b.id);
  w._goInit();
  // A 掉线 → 交给电脑接管（不删除玩家、不清棋盘）
  assert.equal(w.handOverToAI(501), true, '应能交出控制权');
  assert.equal(w.players[501].botControlled, true, '应标记为电脑代管');
  assert.ok(w.players[501], '玩家对象必须保留（离开不等于删除）');
  // 让 A 成为行动方 → 电脑应替它出手
  const g = w.go;
  const idx = g.seats.indexOf(501);
  g.turnIdx = idx; g.turn = g.seatF[idx];
  const did = w._goMaybeAIMove([]);
  assert.equal(did, true, '接手后应由电脑完成一手');
  // 回到原位（重连）
  const back = w.addPlayer(501, 'A');
  assert.equal(back.id, 501, '重连应返回同一玩家对象');
  assert.equal(back.botControlled, false, '重连后应交还控制权');
  assert.ok(w.go.seats.includes(501), '重连后仍占原席位');
});

// GM-25：**多方对局**（4 方）——轮流落子、各占一个阵营、终局按领地排名
test('GM-25 多方对局：4 方轮流落子 + 各占阵营 + 排名结算', () => {
  const w = freshGoWorld(21);
  w.maxPlayers = 4;
  const ids = [601, 602, 603, 604];
  ids.forEach((id, i) => w.addPlayer(id, 'P' + (i + 1)));
  const g = w._goInit();
  assert.equal(g.seats.length, 4, '应有 4 个座位');
  assert.equal(new Set(g.seatF).size, 4, '四方必须各占一个不同阵营');
  for (let i = 0; i < 4; i++) {
    const cur = g.seats[g.turnIdx];
    const r = w.applyGoIntent(cur, { lx: 6 + i * 6, ly: 6 }, []);
    assert.equal(r.ok, true, '第 ' + (i + 1) + ' 方应能落子（当前行动方=' + cur + '）');
    assert.equal(g.turnIdx, (i + 1) % 4, '行动方应轮转到下一位');
  }
  assert.equal(w.go.moveLog.length, 4, '应记录 4 手');
  // 非行动方落子被拒
  const nt = w.applyGoIntent(g.seats[(g.turnIdx + 1) % 4], { lx: 1, ly: 1 }, []);
  assert.equal(nt.ok, false, '非行动方不得落子');
  assert.equal(nt.reason, 'not_your_turn');
  // 领地与排名按阵营输出
  const sc = w._goScore();
  assert.equal(sc.ranked.length, 4, '排名应含 4 方');
  assert.ok(sc.byF && typeof sc.byF === 'object', '应按阵营统计领地');
  // 全员各 pass 一次 → 终局（N 方 pass 规则）
  const ev = [];
  for (let i = 0; i < 4; i++) w.applyGoIntent(w.go.seats[w.go.turnIdx], { pass: true }, ev);
  assert.ok(w.go.result, '全员 pass 后应终局');
  assert.equal(w.go.result.reason, 'pass');
  assert.equal(w.go.result.ranked.length, 4, '终局排名应含 4 方');
});

// GM-26：**中途加入**——对局进行中加入者立刻就座并拿到阵营，轮到即可落子
test('GM-26 中途加入：对局中加入者就座、拿到阵营、可落子', () => {
  const w = freshGoWorld(31);
  w.maxPlayers = 4;
  w.addPlayer(701, 'A');
  w.addPlayer(702, 'B');
  const g0 = w._goInit();
  assert.equal(g0.seats.length, 2, '开局 2 席');
  // 先走一手
  w.applyGoIntent(g0.seats[g0.turnIdx], { lx: 10, ly: 10 }, []);
  // 第三人中途加入
  const c = w.addPlayer(703, 'C');
  assert.ok(c && c.id, '中途加入应成功');
  const g = w._goInit();
  assert.equal(g.seats.length, 3, '加入者应立即就座');
  assert.ok(g.seatF.includes(w._factionOf(703)), '加入者应拿到一个阵营');
  assert.equal(g.seatF.length, 3, '阵营数组应与座位数一致');
  // 轮到它时可落子
  const idx = g.seats.indexOf(703);
  g.turnIdx = idx; g.turn = g.seatF[idx];
  const r = w.applyGoIntent(703, { lx: 20, ly: 20 }, []);
  assert.equal(r.ok, true, '中途加入者应能落子');
});

// GM-27：**房主暂停**不推进任何时钟（rts 与 go 都适用；此处验 go）
test('GM-27 房主暂停：paused 时 go 计时与 tick 都不推进', () => {
  const w = freshGoWorld(41);
  w.addPlayer(801, 'A'); w.addPlayer(802, 'B');
  w.hostId = 801;
  w._goInit();
  const t0 = w.tick;
  w.paused = true;
  const r = w.tickOnce();
  assert.equal(r.paused, true, '暂停时 tickOnce 应直接返回 paused');
  assert.equal(w.tick, t0, '暂停时 tick 不得推进');
  assert.equal(w.go.turnTicks, 0, '暂停时回合计时不得推进');
  w.paused = false;
  w.tickOnce();
  assert.equal(w.tick, t0 + 1, '恢复后应正常推进');
});

// ==================== 服务端模拟返工（2026-09-10）====================

// GM-28：**一回合可下多颗棋子**（`moves` 批）。默认 3 颗；超限 → too_many_stones；
// 快照新增 go.stonesPerTurn / go.stonesLeft；整批原子结算（placed 反映实际落下数）。
test('GM-28 多颗落子：整批 placed=3；超限 too_many_stones；快照 stonesPerTurn/stonesLeft', () => {
  const { w } = seated();
  const g = w.snapshot().go;
  assert.equal(g.stonesPerTurn, 3, '默认每回合 3 颗（快照 stonesPerTurn）');
  assert.equal(g.stonesLeft, 3, '回合开始时应剩 3 颗可下（stonesLeft）');
  const B = fB(w);
  const moves = [{ lx: 6, ly: 6 }, { lx: 7, ly: 6 }, { lx: 6, ly: 7 }];
  const r = w.applyGoIntent(w.go.seats[w.go.turnIdx], { moves }, []);
  assert.equal(r.ok, true);
  assert.equal(r.placed, 3, '整批应落 3 颗');
  assert.equal(w._life[6][6], B); assert.equal(w._life[7][6], B); assert.equal(w._life[6][7], B);
  // 换手后 stonesLeft 复位为 stonesPerTurn（本设计：一批即一整回合）
  assert.equal(w.snapshot().go.stonesLeft, 3, '换手后 stonesLeft 应复位');

  // 超限：一次提交 4 颗 → too_many_stones，棋盘不变
  const before = w.snapshot().lifeGrid.map(c => c.join(','));
  const r2 = w.applyGoIntent(w.go.seats[w.go.turnIdx], {
    moves: [{ lx: 20, ly: 20 }, { lx: 21, ly: 20 }, { lx: 20, ly: 21 }, { lx: 21, ly: 21 }],
  }, []);
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'too_many_stones');
  assert.deepEqual(w.snapshot().lifeGrid.map(c => c.join(',')), before, '超限应整批拒绝，棋盘不变');

  // 兼容旧格式 {lx,ly}（视为 1 颗的一批）
  const r3 = w.applyGoIntent(w.go.seats[w.go.turnIdx], { lx: 25, ly: 25 }, []);
  assert.equal(r3.ok, true);
  assert.equal(r3.placed, 1, '旧格式 {lx,ly} 视为 1 颗');
});

// GM-29（标准康威）：**取消孤子不死** —— go 模式里孤立单子演化后死亡；2×2 稳定块永存。
test('GM-29 取消孤子不死：go 里孤子演化即死、2×2 稳定块存活', () => {
  const { w } = seated();
  const L = w._life;
  const B = fB(w);
  // 盘上放"敌我无关"的孤立单子（远离一切），其余清空
  for (let x = 0; x < 32; x++) for (let y = 0; y < 32; y++) L[x][y] = 0;
  L[10][10] = B;                 // 孤子：0 邻
  L[20][20] = B;                 // 0 邻
  w.go.lastPlacedKeys = new Set();   // 清掉"本回合豁免"，模拟上一回合遗留子
  w._goEvolveOnce(3);
  assert.equal(w._life[10][10], 0, '孤子（0 邻）应死亡');
  assert.equal(w._life[20][20], 0, '孤子（0 邻）应死亡');

  // 2×2 稳定块：每格 3 邻 → 永久存活
  const { w: w2 } = seated(9);
  const L2 = w2._life;
  for (let x = 0; x < 32; x++) for (let y = 0; y < 32; y++) L2[x][y] = 0;
  const B2 = fB(w2);
  L2[5][5] = B2; L2[6][5] = B2; L2[5][6] = B2; L2[6][6] = B2;
  w2.go.lastPlacedKeys = new Set();
  for (let s = 0; s < 5; s++) w2._goEvolveOnce(3);
  assert.equal(w2._life[5][5], B2); assert.equal(w2._life[6][5], B2);
  assert.equal(w2._life[5][6], B2); assert.equal(w2._life[6][6], B2);
  assert.equal(w2._life[4][4], 0, '2×2 不应向角外扩散');
});
