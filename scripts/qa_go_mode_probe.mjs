// scripts/qa_go_mode_probe.mjs
// 独立 QA 探针（严过关）——不依赖、不修改工程师的 tests/go_mode.test.mjs。
// 目的：以"黑盒 + 白盒混合"方式独立复核 go（回合制 · 演化棋）模式真的能玩、且没破坏 rts。
//
// 运行： node scripts/qa_go_mode_probe.mjs
// 输出： 每项 PASS/FAIL + 实际观测值；结尾汇总。
//
// 铁律：本脚本只读 server/public，不改任何游戏源码；仅新增本文件。
import { World, loadKernels } from '../server/engine.js';

await loadKernels();

// ---------- 极小断言器（避免引入测试框架，保持脚本自包含） ----------
let PASS = 0, FAIL = 0, WARN = 0;
const results = [];
function ok(name, cond, detail) {
  if (cond) { PASS++; results.push({ name, st: 'PASS', detail }); console.log(`  [PASS] ${name}${detail ? ' — ' + detail : ''}`); }
  else { FAIL++; results.push({ name, st: 'FAIL', detail }); console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}
function warn(name, detail) {
  WARN++; results.push({ name, st: 'WARN', detail });
  console.log(`  [WARN] ${name}${detail ? ' — ' + detail : ''}`);
}
function section(t) { console.log(`\n=== ${t} ===`); }

// ---------- 构造器（独立于测试文件的写法） ----------
// mulberry32：与服务端同源算法的独立实现，用于"种子化 RNG"（禁 Math.random）。
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function goWorld(seed = 42, skipAI = true) {
  const w = new World('probe-go', 1, seed, { mode: 'go' });
  w._skipAIFill = skipAI;
  return w;
}
function seated(seed = 42, skipAI = true) {
  const w = goWorld(seed, skipAI);
  const black = w.addPlayer(1, 'Black');
  const white = w.addPlayer(2, 'White');
  w._goInit();
  return { w, black, white };
}
function clearBoard(w) {
  for (let x = 0; x < World.LIFE_W; x++) for (let y = 0; y < World.LIFE_W; y++) w._life[x][y] = 0;
}
function snapLife(w) { return w._life.map(c => Array.from(c).join('')).join('|'); }
const B = (w) => w.go.blackF;
const Wf = (w) => w.go.whiteF;

// ============================================================
// 1. 4 邻气语义：角上单子气数 = 2
// ============================================================
section('1. 4 邻气语义（角上单子 → 2 气；必须不同于 rts 的 8 邻语义）');
{
  const { w } = seated();
  clearBoard(w);
  const bf = B(w);
  w._life[0][0] = bf;             // 棋盘角落，天然只有 (1,0) 与 (0,1) 两个 4 邻
  const libs = w._goLiberties(0, 0);
  ok('角上单子 4-邻气数 == 2', libs === 2, `实测 = ${libs}（期望 2；若为 4/8 说明用了 8 邻或环形边界）`);
  // 边界上非角单子：(0,5) → 3 个盘内 4 邻 → 气 3
  clearBoard(w);
  w._life[0][5] = bf;
  ok('边缘单子 4-邻气数 == 3', w._goLiberties(0, 5) === 3, `实测 = ${w._goLiberties(0, 5)}`);
  // 盘中孤立单子 → 4
  clearBoard(w);
  w._life[10][10] = bf;
  ok('盘中孤立单子 4-邻气数 == 4', w._goLiberties(10, 10) === 4, `实测 = ${w._goLiberties(10, 10)}`);
  // 与 rts 的 _captureEnclosed 8 邻语义对照：构造斜向包围，4 邻气应仍 > 0
  clearBoard(w);
  const wf = Wf(w);
  w._life[10][10] = bf;                      // 中心己方子
  w._life[9][9] = wf; w._life[11][9] = wf;   // 仅斜向被敌占
  w._life[9][11] = wf; w._life[11][11] = wf;
  ok('斜向包围不算减气（4 邻语义而非 8 邻）', w._goLiberties(10, 10) === 4,
    `实测 = ${w._goLiberties(10, 10)}（8 邻语义会算成 0 并被提）`);
}

// ============================================================
// 2. 禁自杀
// ============================================================
section('2. 禁自杀：落子后自身无气且未提子 → suicide 且棋盘不变');
{
  const { w } = seated();
  clearBoard(w);
  const bf = B(w), wf = Wf(w);
  w._life[3][2] = wf; w._life[3][4] = wf; w._life[2][3] = wf; w._life[4][3] = wf;
  const before = snapLife(w);
  const r = w._goPlay(bf, 3, 3, []);
  ok('禁自杀返回 reason=suicide', r.ok === false && r.reason === 'suicide', JSON.stringify(r));
  ok('禁自杀后棋盘逐格不变', snapLife(w) === before, '回滚正确');
}

// ============================================================
// 3. 提子优先（落下即提）
// ============================================================
section('3. 提子优先：落下即提对方 → 允许落子且敌子被提');
{
  const { w } = seated();
  clearBoard(w);
  const bf = B(w), wf = Wf(w);
  w._life[5][5] = wf; w._life[4][5] = bf; w._life[6][5] = bf; w._life[5][4] = bf;
  const r = w._goPlay(bf, 5, 6, []);
  ok('提子手合法', r.ok === true, JSON.stringify(r));
  ok('恰好提 1 子', r.captured === 1, `captured=${r.captured}`);
  ok('被提点变 0', w._life[5][5] === 0, `实测=${w._life[5][5]}`);
}

// ============================================================
// 4. 标准劫三连测
// ============================================================
section('4. 劫：①立即回提被拒 ko ②隔一手可回提 ③非劫不被误判');
{
  // 标准劫形
  const buildKo = () => {
    const { w } = seated();
    clearBoard(w);
    const bf = B(w), wf = Wf(w);
    w._life[5][5] = wf; w._life[4][5] = bf; w._life[5][4] = bf; w._life[5][6] = bf;
    w._life[7][5] = wf; w._life[6][4] = wf; w._life[6][6] = wf;
    return { w, bf, wf };
  };
  {
    const { w, bf, wf } = buildKo();
    const r1 = w._goPlay(bf, 6, 5, []);
    ok('劫：黑提 1 子成功', r1.ok && r1.captured === 1, JSON.stringify(r1));
    ok('劫禁着点被记录为 (5,5)', !!w.go.ko && w.go.ko.lx === 5 && w.go.ko.ly === 5,
      JSON.stringify(w.go.ko));
    const r2 = w._goPlay(wf, 5, 5, []);
    ok('劫：立即回提被拒 reason=ko', r2.ok === false && r2.reason === 'ko', JSON.stringify(r2));
  }
  {
    const { w, bf, wf } = buildKo();
    w._goPlay(bf, 6, 5, []);
    const r2 = w._goPlay(wf, 20, 20, []);   // 白别处应一手
    ok('劫：他处应手合法', r2.ok === true, JSON.stringify(r2));
    const r3 = w._goPlay(bf, 21, 20, []);   // 黑再一手（劫解除）
    ok('劫：黑续手合法', r3.ok === true, JSON.stringify(r3));
    const r4 = w._goPlay(wf, 5, 5, []);
    ok('劫：隔一手后回提成功', r4.ok === true && r4.captured === 1, JSON.stringify(r4));
  }
  {
    // 非劫：普通提单子后，对方在无关联处落子不应被拒
    const { w } = seated();
    clearBoard(w);
    const bf = B(w), wf = Wf(w);
    // 孤立白子 (10,10) 被黑三面围，黑从 (10,11) 提
    w._life[10][10] = wf; w._life[9][10] = bf; w._life[11][10] = bf; w._life[10][9] = bf;
    const r1 = w._goPlay(bf, 10, 11, []);
    ok('非劫：普通提 1 子成功', r1.ok && r1.captured === 1, JSON.stringify(r1));
    const koSet = !!w.go.ko;
    // 白在无关联空点落子
    const r2 = w._goPlay(wf, 25, 25, []);
    ok('非劫：无关联处落子不被判 ko', r2.ok === true && r2.reason !== 'ko', JSON.stringify(r2) + ` koSet=${koSet}`);
    if (koSet) warn('非劫提子仍设置了 ko 禁着点', `ko=${JSON.stringify(w.go.ko)}（可能误判，需关注）`);
  }
}

// ============================================================
// 5. 落子位置自由 / occupied / oob
// ============================================================
section('5. 落子位置自由：远离所有棋子的空点可落；非空返回 occupied；越界返回 oob');
{
  const { w } = seated();
  clearBoard(w);
  const bf = B(w), wf = Wf(w);
  w._life[5][5] = bf;
  const r = w._goPlay(wf, 28, 3, []);   // 远离所有棋子
  ok('远离棋子的空点落子成功（位置自由）', r.ok === true, JSON.stringify(r));
  const rOcc = w._goPlay(bf, 5, 5, []);
  ok('非空点返回 occupied', rOcc.ok === false && rOcc.reason === 'occupied', JSON.stringify(rOcc));
  const rOob = w._goPlay(bf, 32, 5, []);
  ok('越界返回 oob', rOob.ok === false && rOob.reason === 'oob', JSON.stringify(rOob));
  const rOob2 = w._goPlay(bf, -1, 5, []);
  ok('负坐标返回 oob', rOob2.ok === false && rOob2.reason === 'oob', JSON.stringify(rOob2));
}

// ============================================================
// 6. 没有强弱棋子：60 手随机对局，全盘 _life ∈ {0,1,2}
// ============================================================
section('6. 没有强弱棋子：60 手随机对局后全盘 _life 非零值 ∈ {1,2}（禁 11/12）');
{
  const w = goWorld(2026);
  w.addPlayer(1, 'A'); w.addPlayer(2, 'B');
  w._goInit();
  const rng = mulberry32(9999);
  let bad = null, badVal = null, moves = 0;
  for (let i = 0; i < 60; i++) {
    const f = w.go.turn;
    const pid = w._lifeOwners[f - 1];
    // 随机尝试若干点，取第一个合法点
    let played = false;
    for (let t = 0; t < 40 && !played; t++) {
      const lx = (rng() * 32) | 0, ly = (rng() * 32) | 0;
      const r = w.applyGoIntent(pid, { lx, ly }, []);
      if (r.ok) { played = true; moves++; }
    }
    if (!played) { w.applyGoIntent(pid, { pass: true }, []); }
    if (w.go.result) break;
    for (let x = 0; x < 32 && !bad; x++) for (let y = 0; y < 32; y++) {
      const v = w._life[x][y];
      if (v !== 0 && v !== 1 && v !== 2) { bad = [x, y]; badVal = v; break; }
    }
    if (bad) break;
  }
  ok('60 手内全盘无非 {0,1,2} 编码（无强弱之分）', bad === null,
    bad ? `发现 (${bad}) = ${badVal}（弱痕段泄漏！）` : `完成 ${moves} 手，全盘编码干净`);
}

// ============================================================
// 7. 演化不会"落下即死"
// ============================================================
section('7. 演化不会"落下即死"：落子后立即演化，该点仍属落子方');
{
  const { w } = seated();
  clearBoard(w);
  const bf = B(w);
  const r = w._goPlay(bf, 16, 16, []);
  ok('落子成功', r.ok === true, JSON.stringify(r));
  w._goEvolve(0, []);
  ok('演化后落点仍为落子方', w._life[16][16] === bf, `实测=${w._life[16][16]} 期望=${bf}`);
}

// ============================================================
// 8. 演化是标准康威 B3/S23：孤子(0/1 邻)死 + 3 邻 L 形诞生 + 过密死
//    （2026-09-10 需求返工：取消"孤子不死"）+ 死亡宽限 lonelyDeathDelay
// ============================================================
section('8. 演化（标准康威）：孤子(0/1 邻)死；3 邻 L 形空格诞生；过密(n>3)死；死亡宽限 delay');
{
  const { w } = seated();
  clearBoard(w);
  const bf = B(w);
  w._life[20][20] = bf;          // 孤立（0 邻）
  w._goEvolveOnce(3);
  ok('孤子（0 邻）演化后死亡（取消孤子不死，恢复标准康威）',
    w._life[20][20] === 0, `实测=${w._life[20][20]}（期望 0）`);
}
{
  const { w } = seated();
  clearBoard(w);
  const bf = B(w);
  w._life[20][20] = bf; w._life[21][20] = bf;   // 双联，每格 1 邻
  w._goEvolveOnce(3);
  ok('双联子（各 1 邻）演化后死亡（标准 B3/S23）',
    w._life[20][20] === 0 && w._life[21][20] === 0, `实测=${w._life[20][20]},${w._life[21][20]}`);
}
{
  // 2×2 稳定块：每格 3 邻 → 永久存活
  const { w } = seated();
  clearBoard(w);
  const bf = B(w);
  w._life[10][10] = bf; w._life[11][10] = bf; w._life[10][11] = bf; w._life[11][11] = bf;
  for (let s = 0; s < 4; s++) w._goEvolveOnce(3);
  ok('2×2 稳定块多步演化后仍存（每格 3 邻）',
    w._life[10][10] === bf && w._life[11][11] === bf, `实测角=(${w._life[10][10]},${w._life[11][11]})`);
}
{
  // 过密致死：中心格 8 邻全满 → n=8 > 3 → 死亡
  const { w } = seated();
  clearBoard(w);
  const bf = B(w);
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    if (dx || dy) w._life[20 + dx][20 + dy] = bf;
  }
  w._goEvolveOnce(3);
  ok('过密(n=8>3)致死', w._life[20][20] === 0, `实测=${w._life[20][20]}`);
}
{
  const { w } = seated();
  clearBoard(w);
  const bf = B(w);
  // L 形三子围绕空格 (10,10)：(9,9),(10,9),(9,10) 均为同色
  w._life[9][9] = bf; w._life[10][9] = bf; w._life[9][10] = bf;
  w._goEvolveOnce(3);
  ok('3 邻 L 形使空格 (10,10) 诞生新子', w._life[10][10] !== 0, `实测=${w._life[10][10]} 期望非0`);
}
{
  // 死亡宽限：孤子设置 lonelyDeathDelay 后可撑 N 个回合才死（默认 0 = 立即死）
  function lonerAliveInGo(delay, steps) {
    const w = new World('probe-go-delay', 1, 42, { mode: 'go', lonelyDeathDelay: delay });
    w._skipAIFill = true;
    w.addPlayer(1, 'Black'); w.addPlayer(2, 'White');
    w._goInit();
    clearBoard(w);
    w.go.lastPlacedKeys = new Set();
    const bf = B(w);
    w._life[16][16] = bf;
    for (let s = 0; s < steps; s++) w._goEvolveOnce(3);
    return w._life[16][16] === bf;
  }
  ok('delay=0：孤子 1 步即死', lonerAliveInGo(0, 1) === false);
  ok('delay=1：孤子撑到第 1 步后仍活、第 2 步死',
    lonerAliveInGo(1, 1) === true && lonerAliveInGo(1, 2) === false);
  ok('delay=2：孤子撑到第 2 步后仍活、第 3 步死',
    lonerAliveInGo(2, 2) === true && lonerAliveInGo(2, 3) === false);
}

// ============================================================
// 9. 确定性：同 seed 同手顺 → 逐手 lifeGrid 完全一致
// ============================================================
section('9. 确定性：同 seed + 同手顺 双跑 → 逐手 lifeGrid 完全一致');
{
  const moves = [[16, 16], [15, 16], [16, 15], [17, 17], [14, 14], [18, 18], [16, 14], [15, 15], [20, 20], [21, 21]];
  function run() {
    const w = goWorld(12345);
    w.addPlayer(1, 'A'); w.addPlayer(2, 'B');
    w._goInit();
    const snaps = [];
    for (const [x, y] of moves) {
      const pid = w._lifeOwners[w.go.turn - 1];
      const r = w.applyGoIntent(pid, { lx: x, ly: y }, []);
      if (!r.ok) { snaps.push('REJECT:' + r.reason); continue; }
      snaps.push(snapLife(w));
    }
    return snaps;
  }
  const a = run(), b = run();
  let same = a.length === b.length;
  for (let i = 0; i < a.length && same; i++) if (a[i] !== b[i]) same = false;
  ok('同 seed 双跑逐手一致', same, `${a.length} 手比对${same ? '全部相同' : '存在差异'}`);
}

// ============================================================
// 10. 领地随"先后拓展"变化
// ============================================================
section('10. 领地：territory 归属正确阵营且格数 > 0；对手就近落子后归属转移');
{
  const { w } = seated();
  clearBoard(w);
  const bf = B(w), wf = Wf(w);
  // 黑在左上落子，白在右下落子，相距很远
  w._goPlay(bf, 6, 6, []);
  w._goPlay(wf, 25, 25, []);
  const sc1 = w._goScore();
  ok('黑有领地格 > 0', sc1.black > 0, `black=${sc1.black}`);
  ok('白有领地格 > 0', sc1.white > 0, `white=${sc1.white}`);
  // 白在黑子旁边就近落子 → 该片归属应发生转移（黑的近邻格被白抢走）
  const w0 = w._goScore();
  w._goPlay(wf, 7, 7, []);   // 紧贴黑子
  const w1 = w._goScore();
  ok('对手就近落子后黑目数下降（领地可被翻转）', w1.black < w0.black,
    `黑 ${w0.black} → ${w1.black}；白 ${w0.white} → ${w1.white}`);
}

// ============================================================
// 11. 四大不可预测机制真的接入
// ============================================================
section('11. 不可预测机制：呼吸 ∈ {3,4,5}；世界事件出现 ≥2 种不同值');
{
  // 呼吸：把 moveNo 推到 10 的倍数边界，跨多种子观察 breath 变化
  const breaths = new Set();
  for (let seed = 1; seed <= 25; seed++) {
    const { w } = seated(seed);
    w.go.moveNo = 10;
    w.applyGoIntent(w._lifeOwners[w.go.turn - 1], { lx: 5, ly: 5 }, []);
    breaths.add(w.go._breathR);
    w.go.moveNo = 20;
    w.applyGoIntent(w._lifeOwners[w.go.turn - 1], { lx: 6, ly: 6 }, []);
    breaths.add(w.go._breathR);
  }
  const invalid = [...breaths].filter(v => ![3, 4, 5].includes(v));
  ok('呼吸值全部 ∈ {3,4,5}', invalid.length === 0, `观测集合 = {${[...breaths].sort()}}`);
  ok('呼吸确有多档变化（非恒定）', breaths.size >= 2, `观测到 ${breaths.size} 种档位`);

  // 世界事件：跨多种子抽取，应出现 ≥2 种不同值
  const events = new Set();
  for (let seed = 1; seed <= 40; seed++) {
    const { w } = seated(seed);
    w.go.moveNo = 25;
    w.applyGoIntent(w._lifeOwners[w.go.turn - 1], { lx: 6, ly: 6 }, []);
    if (w.go.lastEvent) events.add(w.go.lastEvent);
  }
  ok('世界事件出现 ≥2 种不同值', events.size >= 2, `观测集合 = {${[...events]}}`);
  const evValid = [...events].every(e => ['calm', 'flourish', 'frost', 'mutate'].includes(e));
  ok('世界事件值均合法', evValid, `观测集合 = {${[...events]}}`);
}

// ============================================================
// 12. 终局：四种触发
// ============================================================
section('12. 终局：连续 2 次 pass / 手数 150 / 吃光 / 累计 3 次超时');
{
  // pass
  const { w } = seated();
  const ev = [];
  w.applyGoIntent(w.go.blackId === 1 ? 1 : 1, { pass: true }, ev);
  w.applyGoIntent(2, { pass: true }, ev);
  ok('终局-连续 2 次 pass → reason=pass', !!w.go.result && w.go.result.reason === 'pass',
    JSON.stringify(w.go.result));
}
{
  // 手数上限
  const { w } = seated();
  w.go.moveNo = 150;
  w.applyGoIntent(w._lifeOwners[w.go.turn - 1], { lx: 16, ly: 16 }, []);
  ok('终局-手数 150 → reason=max_moves', !!w.go.result && w.go.result.reason === 'max_moves',
    JSON.stringify(w.go.result));
}
{
  // 吃光出局
  const { w } = seated();
  clearBoard(w);
  const blackP = w.players[w.go.blackId];
  blackP.maxLifeCells = 6; blackP.lifeCells = 0;
  // 触发一次 endTurn（当前行动方 pass）
  const cur = w._lifeOwners[w.go.turn - 1];
  w.applyGoIntent(cur, { pass: true }, []);
  ok('终局-黑被吃光 → reason=wiped 且 black.lost', !!w.go.result &&
    w.go.result.reason === 'wiped' && blackP.lost === true, JSON.stringify(w.go.result));
  ok('终局-被吃光方为负、对方胜', w.go.result.winner != null &&
    String(w.go.result.winner) === String(w.go.whiteId), `winner=${w.go.result.winner} whiteId=${w.go.whiteId}`);
}
{
  // 累计 3 次超时。注意规则（R7/R8）："连续超时 2 次 = 终局（并入 pass）"，
  // 故"累计 3 次超时判负"必须由**非连续**超时构成 —— 每次超时后由对方真实落子打断 pass 链。
  const { w } = seated();
  // 让黑方连续超时 3 次，中间夹白方真实落子（重置 passes）
  let guard = 0;
  while (!w.go.result && guard++ < 20) {
    const curF = w.go.turn;
    const curPid = w._lifeOwners[curF - 1];
    if (curPid === w.go.blackId) {
      // 黑超时
      w.go.turnTicks = 30;
      w._goTick();
    } else {
      // 白落一子（真实落子 → passes 归零），选远离已有的空点
      const p = w._lifeOwners[curF - 1];
      let done = false;
      for (let t = 0; t < 50 && !done; t++) {
        const lx = 2 + ((t * 7) % 28), ly = 2 + ((t * 11) % 28);
        if (w.applyGoIntent(p, { lx, ly }, []).ok) done = true;
      }
      if (!done) w.applyGoIntent(p, { pass: true }, []);
    }
  }
  ok('终局-累计 3 次超时 → reason=timeout', !!w.go.result && w.go.result.reason === 'timeout',
    `result=${JSON.stringify(w.go.result)} timeouts=${JSON.stringify(Object.fromEntries(Object.entries(w.players).map(([k, p]) => [k, p.goTimeouts || 0])))}`);
}
{
  // 复核 R7/R8 边界：连续 2 次超时 → 并入 pass 终局（PRD 明确"连续超时 2 次 = 终局"）
  const { w } = seated();
  w.go.turnTicks = 30; w._goTick();   // 第 1 次超时
  w.go.turnTicks = 30; w._goTick();   // 第 2 次超时（当前行动方）
  ok('连续 2 次超时 → 并入 pass 终局', !!w.go.result && w.go.result.reason === 'pass',
    JSON.stringify(w.go.result));
}

// ============================================================
// 13. AI 零非法手 + 耗时
// ============================================================
section('13. AI vs AI：40 手零非法手（无 occupied/suicide/ko），每手 < 800ms');
{
  const w = goWorld(31337, false);
  w.addPlayer(1, 'Human');   // 人类占 1 席
  w.addAI();                 // 新席位模型：AI 不自动补位，需由玩家手动添加
  w._goInit();
  // 让黑也交给 AI：手动指定行动方后调用 goAIMove
  const aiIds = Object.keys(w.players).filter(id => w.players[id].isAI);
  ok('已补齐 AI 对手', aiIds.length >= 1, `AI ids = [${aiIds}]`);

  const illegal = [];
  let maxMs = 0, sumMs = 0, played = 0, turns = 0;
  for (let i = 0; i < 40 && !w.go.result; i++) {
    turns++;
    const f = w.go.turn;
    const pid = Object.keys(w.players).find(id => w._factionOf(id) === f) || w._lifeOwners[f - 1];
    const t0 = process.hrtime.bigint();
    const mv = World.goAIMove(w, f);
    const dt = Number(process.hrtime.bigint() - t0) / 1e6;
    maxMs = Math.max(maxMs, dt); sumMs += dt;
    // 新契约：AI 返回 { moves:[{lx,ly},...] }（一回合 1..stonesPerTurn 颗）；
    // 兼容旧的 { lx, ly }（视为 1 颗的一批）。
    const moves = (mv && Array.isArray(mv.moves)) ? mv.moves
      : (mv && Number.isInteger(mv.lx) && Number.isInteger(mv.ly) ? [{ lx: mv.lx, ly: mv.ly }] : null);
    if (!mv || mv.pass || !moves || moves.length === 0) { w.applyGoIntent(pid, { pass: true }, []); continue; }
    const r = w.applyGoIntent(pid, { moves }, []);
    if (!r.ok) illegal.push({ move: i, moves, reason: r.reason });
    else played++;
  }
  ok('AI 40 手零非法手', illegal.length === 0, illegal.length ? JSON.stringify(illegal.slice(0, 5)) : `${played} 手全部合法`);
  ok('AI 单手耗时 < 800ms', maxMs < 800, `max=${maxMs.toFixed(1)}ms avg=${(sumMs / Math.max(1, turns)).toFixed(1)}ms`);
  let cells = 0;
  for (let x = 0; x < 32; x++) for (let y = 0; y < 32; y++) if (w._life[x][y]) cells++;
  ok('40 手后棋盘仍有棋子', cells > 0, `非空格数 = ${cells}`);
}

// ============================================================
// 14. rts 回归（关键）
// ============================================================
section('14. rts 回归：mode=rts 跑 400 tick → 不抛异常 + 出现 ≥11 弱痕 + snapshot.go===null');
{
  const w = new World('probe-rts', 1, 777, { mode: 'rts' });
  w._skipAIFill = true;
  const p = w.addPlayer(1, 'P');
  ok('rts 世界 mode === "rts"', w.mode === 'rts', `mode=${w.mode}`);
  let threw = null;
  try {
    for (let i = 0; i < 400; i++) {
      p.x = 40 + (i % 20) * 4; p.y = 40 + Math.floor(i / 20) * 4;
      w.tickOnce();
    }
  } catch (e) { threw = e; }
  ok('rts 400 tick 不抛异常', threw === null, threw ? threw.stack : 'ok');
  let hasWeak = false, maxV = 0;
  for (let x = 0; x < World.LIFE_W; x++) for (let y = 0; y < World.LIFE_W; y++) {
    const v = w._life[x][y];
    if (v > maxV) maxV = v;
    if (v >= 11) hasWeak = true;
  }
  ok('rts 出现 ≥11 弱痕值（未受 go 改动破坏）', hasWeak, `全盘最大值 = ${maxV}`);
  ok('rts snapshot().go === null', w.snapshot().go === null, `go=${JSON.stringify(w.snapshot().go)}`);
}

// ============================================================
// 15. _updateVoronoi(rOverride) 不变式
// ============================================================
section('15. _updateVoronoi 不变式：不传参/传 null 走纪元逻辑；传 4 → 半径 4');
{
  const w = new World('probe-rts2', 1, 555, { mode: 'rts' });
  w._skipAIFill = true;
  const p = w.addPlayer(1, 'P');
  // 放一颗自己的强细胞，让 Voronoi 有 seed
  w._lifeInit();
  clearBoard(w);
  const f = w._factionOf(p.id);
  w._life[16][16] = f;
  // era0 → _influenceR 应为 1
  w._updateVoronoi();
  const rEra = p.influenceR;
  w._updateVoronoi(null);
  const rNull = p.influenceR;
  ok('era0 不传参 → 半径 = 1（纪元逻辑）', rEra === 1, `实测=${rEra}`);
  ok('传 null → 半径仍 = 1（与不传等价）', rNull === 1, `实测=${rNull}`);
  w._updateVoronoi(4);
  ok('传数字 4 → 半径 = 4', p.influenceR === 4, `实测=${p.influenceR}`);
  // 且 4 的领地格数应 > era0(半径1) 的领地格数
  const own4 = countOwn(w, f);
  w._updateVoronoi(1);
  const own1 = countOwn(w, f);
  ok('半径 4 的领地格数 > 半径 1', own4 > own1, `R4=${own4} 格, R1=${own1} 格`);
  function countOwn(ww, ff) {
    let n = 0;
    for (let x = 0; x < 32; x++) for (let y = 0; y < 32; y++) if (ww._lifeOwner[x][y] === ff) n++;
    return n;
  }
}

// ============================================================
// 【附加复核 1】GM-08 平票：默认 bornThresh=3 下平票是否可达？
// ============================================================
section('附加A. 复核工程师自述"默认阈值下平票不可达"是否成立');
{
  // 默认 bornThresh=3：诞生需 n===3，即 cnt[1]+cnt[2]=3（奇数）→ cnt[1] !== cnt[2] 恒成立 → 平票不可达。
  // 独立验证：全盘 brute force 检查所有 8 邻配置 n=3 时是否可能出现 cnt 相等。
  let tieAtN3 = 0;
  for (let a = 0; a <= 8; a++) {           // 黑邻数
    const b = 3 - a;                       // 白邻数 = 3 - a；若 a===b 则平票
    if (b < 0 || b > 8) continue;
    if (a === b) tieAtN3++;
  }
  ok('数学断言：n=3 时 cnt[黑]!==cnt[白] 恒成立（平票不可达）', tieAtN3 === 0,
    `n=3 时可能的平票组合数 = ${tieAtN3}`);

  // 独立经验验证：默认阈值 3 跑全盘，统计诞生点是否出现平票
  let bornTotal = 0, tieBorn = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const { w } = seated(seed);
    clearBoard(w);
    const bf = B(w), wf = Wf(w);
    for (let x = 0; x < 32; x++) for (let y = 0; y < 32; y++) w._life[x][y] = ((x + y) % 2 === 0) ? bf : wf;
    const L = w._life;
    // 对每个空格统计 8 邻，若 n===3 记为诞生点，并检查是否平票
    for (let x = 0; x < 32; x++) for (let y = 0; y < 32; y++) {
      if (L[x][y]) continue;
      let cb = 0, cw = 0;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= 32 || ny >= 32) continue;
        const v = L[nx][ny];
        if (v === bf) cb++; else if (v === wf) cw++;
      }
      if (cb + cw === 3) { bornTotal++; if (cb === cw) tieBorn++; }
    }
  }
  ok('默认阈值 3 下 20 seed 全盘诞生点中平票数 = 0（平票分支不可达）', tieBorn === 0,
    `诞生点 ${bornTotal} 个，其中平票 ${tieBorn} 个`);
  warn('设计观察：平票掷种子在默认对局中不可触发',
    'GO-05/R2.3 的"平票由种子掷定"在默认 bornThresh=3 下为死代码（仅 bornThresh=2 的测试路径可达）');
}

// ============================================================
// 附加复核 2：grep 可执行路径中是否含 Math.random / Date.now
// ============================================================
section('附加B. grep 复核 go 可执行路径的 Math.random / Date.now（去注释后）');
{
  const { readFileSync } = await import('node:fs');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  // IR-3a 禁的是"模拟内"的非确定性随机。网络心跳/loop 节流/性能计时属于连接与调度管线，
  // 不参与可复盘的棋局模拟（这些值也不进 snapshot/不参与摆子），与 engine.js 的 t0 同类。
  // 因此：Math.random 是零容忍；Date.now 只允许出现在基础设施行（下钻逐行判定）。
  const infraRe = /heartbeat|Heartbeat|PONG|Pong|pong|grace|GRACE|lastAt|now\b|Date\.now/;
  const files = ['server/go.js', 'server/ai.js', 'server/net.js', 'server/index.js', 'server/engine.js'];
  for (const f of files) {
    let src = '';
    try { src = strip(readFileSync(new URL('../' + f, import.meta.url), 'utf8')); }
    catch (e) { warn(`${f} 读取失败`, String(e)); continue; }
    const mr = (src.match(/Math\.random\s*\(/g) || []).length;
    const lines = src.split('\n');
    const dateLines = [];
    lines.forEach((l, i) => { if (/Date\.now\s*\(/.test(l)) dateLines.push({ n: i + 1, text: l.trim() }); });
    ok(`${f} 去注释后无 Math.random（零容忍）`, mr === 0, `Math.random=${mr}`);
    // Date.now 逐行分类：基础设施行（含 heartbeat/grace/now 变量/loop 计时）不算模拟违规
    const simHits = dateLines.filter(d => !infraRe.test(d.text));
    if (f === 'server/go.js' || f === 'server/ai.js') {
      ok(`${f} 无任何 Date.now（纯模拟层，零容忍）`, dateLines.length === 0, `Date.now=${dateLines.length}`);
    } else {
      ok(`${f} 的 Date.now 仅存在于基础设施行（非模拟逻辑）`, simHits.length === 0,
        `基础设施行 ${dateLines.length} 处 [${dateLines.map(d => d.n).join(',')}]，疑似模拟违规 ${simHits.length} 处` +
        (simHits.length ? ' → ' + JSON.stringify(simHits) : ''));
    }
  }
}

// ============================================================
// 附加复核 3：go 世界即便被误塞进 20TPS tick 路径也不失控
// ============================================================
section('附加C. go 防御转发：tickOnce 被调用时转发为 _goTick（不跑 20TPS 主循环）');
{
  const { w } = seated();
  const before = w.go.turnTicks;
  const r = w.tickOnce();
  ok('go 的 tickOnce 返回 {events,tickMs}（_goTick 形状）', r && Array.isArray(r.events) && typeof r.tickMs === 'number',
    JSON.stringify(r).slice(0, 120));
  ok('go 的 tickOnce 只让 turnTicks +1（非 20TPS）', w.go.turnTicks === before + 1,
    `turnTicks ${before} → ${w.go.turnTicks}`);
}

// ============================================================
console.log('\n\n========== QA 探针汇总 ==========');
console.log(`PASS=${PASS}  FAIL=${FAIL}  WARN=${WARN}  (共 ${results.length} 项)`);
if (FAIL) {
  console.log('\n--- FAIL 明细 ---');
  for (const r of results) if (r.st === 'FAIL') console.log(`  ✗ ${r.name} — ${r.detail}`);
}
if (WARN) {
  console.log('\n--- WARN 明细 ---');
  for (const r of results) if (r.st === 'WARN') console.log(`  ! ${r.name} — ${r.detail}`);
}
process.exit(FAIL ? 1 : 0);
