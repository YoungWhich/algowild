// scripts/qa_gameplay_probe.mjs — 独立验证探针（QA：Edward）
//
// 目的：不是复跑实施者的单测，而是**自己写探针去打**，逐字对照用户本轮 5 条需求。
// 两条腿：
//   A) 纯模拟断言：`import { World } from '../server/engine.js'`（引擎真实代码路径）
//   B) 端到端：spawn 真实服务（PORT=17915），DB_PATH → 临时文件库（**绝不碰 server/data**）
//
// 覆盖：A 取消孤子不死 / B 死亡宽限精确语义 / C 回合制多颗落子 / D 棋盘只在结束回合后运行
//       E 实时棋子近战吞噬 / F 房间设置透传与重建 / G 文案与引擎一致性 / A4 残留孤子豁免 grep
//
// 用法：node scripts/qa_gameplay_probe.mjs
// 退出码：有 CRITICAL/HIGH 级问题 → 1（便于 CI 判定 VERDICT）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { World, loadKernels } from '../server/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 17915;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP_DB = path.join(os.tmpdir(), 'algowild_qa_gp_' + Date.now() + '.db');
const TMP_LOG = path.join(os.tmpdir(), 'algowild_qa_gp_' + Date.now() + '.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 启动时清理上次运行遗留的临时库（Windows 下句柄释放有延迟，可能删除失败）
try {
  for (const f of fs.readdirSync(os.tmpdir())) {
    if (/^algowild_qa_gp_.*\.(db|log)/.test(f)) { try { fs.unlinkSync(path.join(os.tmpdir(), f)); } catch {} }
  }
} catch {}

await loadKernels();

// ---------------- 断言框架 ----------------
let pass = 0, fail = 0;
const issues = [];   // { sev, title, repro, expected, actual, impact, clause }
function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ' — ' + extra : ''}`); }
  return !!cond;
}
function note(label, extra) { console.log(`  ·  ${label}${extra ? ' — ' + extra : ''}`); }
function section(t) { console.log(`\n======== ${t} ========`); }
function issue(sev, title, repro, expected, actual, impact, clause) {
  issues.push({ sev, title, repro, expected, actual, impact, clause });
  console.log(`  ⚠  [${sev}] ${title}`);
}

const rid = () => Math.random().toString(36).slice(2, 7);

// ---------------- 模拟世界工具 ----------------
function rtsWorld(seed, opts = {}) {
  const w = new World('qa-gp-rts-' + rid(), 1, seed, { mode: 'rts', ...opts });
  w._skipAIFill = true;
  w.addPlayer(1, 'A');   // faction 1
  w.addPlayer(2, 'B');   // faction 2
  w._lifeInit();
  return w;
}
function goWorld(seed, opts = {}) {
  const w = new World('qa-gp-go-' + rid(), 1, seed, { mode: 'go', ...opts });
  w._skipAIFill = true;
  w.addPlayer(1, 'A');
  w.addPlayer(2, 'B');
  w._goInit();
  return w;
}
function clearBoard(w) {
  for (let x = 0; x < World.LIFE_W; x++) {
    for (let y = 0; y < World.LIFE_W; y++) {
      w._life[x][y] = 0; w._lifeDoom[x][y] = -1; w._lifeDmg[x][y] = 0;
    }
  }
}
function clearGo(w) {
  clearBoard(w);
  w.go.lastPlacedKeys = new Set();
  w.go.ko = null;
}
function countCells(w) {
  let n = 0;
  for (let x = 0; x < World.LIFE_W; x++) for (let y = 0; y < World.LIFE_W; y++) if (w._life[x][y]) n++;
  return n;
}
function gridStr(w) { return w._life.map(c => Array.from(c).join(',')).join('|'); }
function goTurnPid(w) { return (w.go.seats && w.go.seats[w.go.turnIdx] != null) ? w.go.seats[w.go.turnIdx] : null; }
function goPlay(w, moves) { return w.applyGoIntent(goTurnPid(w), { moves }, []); }
function boardFingerprint(w) {
  let f = '';
  for (let x = 0; x < World.LIFE_W; x++) for (let y = 0; y < World.LIFE_W; y++) if (w._life[x][y]) f += `${x},${y}=${w._life[x][y]};`;
  return f;
}

// =====================================================================
// A. 取消两个模式的孤子不死
// =====================================================================
section('A. 取消孤子不死（两种模式）');

// A1. rts：真实 tickOnce 流程（tick%LIFE_STEP_TICKS 触发 _lifeStep）
{
  const w = rtsWorld(101);
  clearBoard(w);
  w._life[16][16] = 1;                        // 孤立强细胞（0 邻）
  const before = w._life[16][16];
  let steps = 0;
  for (let i = 0; i < World.LIFE_STEP_TICKS; i++) w.tickOnce();
  if (w.tick % World.LIFE_STEP_TICKS === 0) steps++;
  const after = w._life[16][16];
  ok(before === 1 && after === 0,
    `A1 rts 真实流程：孤立强细胞跑 ${World.LIFE_STEP_TICKS} tick（1 次 _lifeStep）后消失`,
    `tick=${w.tick} before=${before} after=${after}`);
}

// A2. go：真实走一回合 applyGoIntent 整批提交（当回合豁免允许，下一回合必须死）
{
  const w = goWorld(202, { lonelyDeathDelay: 0 });
  clearGo(w);
  const S = { lx: 16, ly: 16 };
  const r1 = goPlay(w, [S]);                                    // A 落 1 颗（豁免本回合）
  const aliveThisRound = w._life[S.lx][S.ly] === 1;
  // 换手后 B 落一子（触发下一次演化）
  const r2 = goPlay(w, [{ lx: 2, ly: 2 }]);
  const aliveNextRound = w._life[S.lx][S.ly] === 1;
  ok(r1.ok && aliveThisRound && !aliveNextRound,
    'A2 go 真实流程：孤子「本回合豁免存活、下一回合必死」',
    `r1=${JSON.stringify(r1)} 当回合=${w._life[S.lx][S.ly]} 次回合存活=${aliveNextRound}`);
  if (aliveThisRound && aliveNextRound) {
    issue('CRITICAL', 'go 孤子下一回合仍未死', 'go 世界 applyGoIntent 落 1 颗孤子 → 换手 → 下一回合该点仍为 1',
      '下一回合该点必须为 0', `仍为 ${w._life[S.lx][S.ly]}`, '孤子不死未取消（回合制）', '需求1');
  }
}

// A3. 反证：2×2 同色方块不得被误杀（跑 20+ 拍）
{
  const w = rtsWorld(303);
  clearBoard(w);
  w._life[10][10] = 1; w._life[11][10] = 1; w._life[10][11] = 1; w._life[11][11] = 1;
  for (let i = 0; i < 24; i++) w._lifeStep([]);
  const all = w._life[10][10] === 1 && w._life[11][10] === 1 && w._life[10][11] === 1 && w._life[11][11] === 1;
  ok(all, 'A3 反证：2×2 同色方块 24 拍后四格全在（未误杀）',
    `[10,10]=${w._life[10][10]} [11,11]=${w._life[11][11]}`);
}

// A4. 残留"孤子豁免"静态排查 + 同一套 B3/S23 判定
{
  const eng = fs.readFileSync(path.join(ROOT, 'server/engine.js'), 'utf8');
  const go = fs.readFileSync(path.join(ROOT, 'server/go.js'), 'utf8');
  // 兼容两种写法：(n === 2 || n === 3) / (allyN === 2 || allyN === 3)（rts 邻域只数己方）
  const B3S23_RE = /\((\w+) === 2 \|\| \1 === 3\)/;
  const engHasB3S23 = B3S23_RE.test(eng);
  const goHasB3S23 = B3S23_RE.test(go);
  const engNle3 = /n\s*<=\s*3/.test(eng);
  const goNle3 = /n\s*<=\s*3/.test(go);
  const orphanMarker = [];
  for (const [file, txt] of [['engine.js', eng], ['go.js', go]]) {
    txt.split('\n').forEach((line, i) => {
      if (/孤子不死|孤子豁免|n\s*<=\s*3/.test(line)) orphanMarker.push(`${file}:${i + 1}: ${line.trim().slice(0, 90)}`);
    });
  }
  ok(engHasB3S23 && goHasB3S23 && !engNle3 && !goNle3,
    'A4 两种模式强/弱细胞同走 n===2||n===3；无 n<=3 残留',
    `engine B3/S23=${engHasB3S23} go B3/S23=${goHasB3S23} n<=3(eng/go)=${engNle3}/${goNle3}`);
  if (orphanMarker.length) {
    note('含"孤子不死/豁免"字样的行（确认均为注释说明取消，而非代码分支）', '');
    orphanMarker.forEach(l => console.log('     ' + l));
  }
}

// =====================================================================
// B. 死亡宽限 lonelyDeathDelay 的精确语义
// =====================================================================
section('B. 死亡宽限 lonelyDeathDelay 精确语义');

// B1~B3. rts 逐拍存活序列
{
  function seq(delay, steps) {
    const w = rtsWorld(400 + delay, { lonelyDeathDelay: delay });
    clearBoard(w);
    w._life[8][8] = 1;
    const out = [];
    for (let i = 0; i < steps; i++) { w._lifeStep([]); out.push(w._life[8][8] === 1 ? 1 : 0); }
    return out;
  }
  const d0 = seq(0, 3); const d1 = seq(1, 3); const d2 = seq(2, 4);
  note(`delay=0 逐拍存活 [${d0.join(',')}]（1=活 0=死）`);
  note(`delay=1 逐拍存活 [${d1.join(',')}]`);
  note(`delay=2 逐拍存活 [${d2.join(',')}]`);
  ok(d0[0] === 0, 'B1 delay=0：第 1 次失败即死（=原行为）', `seq=[${d0.join(',')}]`);
  ok(d1[0] === 1 && d1[1] === 0, 'B2 delay=1：第 1 次失败存活、第 2 次才死', `seq=[${d1.join(',')}]`);
  ok(d2[0] === 1 && d2[1] === 1 && d2[2] === 0, 'B3 delay=2：第 1、2 次存活、第 3 次死', `seq=[${d2.join(',')}]`);
}

// B4. 反向恢复：被扣宽限的格子邻域恢复健康 → 立刻清空计数；再变孤子应重新拿满宽限
{
  const w = rtsWorld(440, { lonelyDeathDelay: 2 });
  clearBoard(w);
  w._life[10][10] = 1;
  w._lifeStep([]);                                  // 第 1 次失败 → doom=1
  const doomAfterFail = w._lifeDoom[10][10];
  // 邻域恢复健康：加两个己方强细胞使 (10,10) 邻数=2
  w._life[11][10] = 1; w._life[10][11] = 1;
  w._lifeStep([]);                                  // (10,10) n=2 → 健康 → doom 清空
  const aliveHealthy = w._life[10][10] === 1;
  const doomCleared = w._lifeDoom[10][10] === -1;
  // 再次变孤子（移除邻居）
  w._life[11][10] = 0; w._life[10][11] = 0;
  w._lifeStep([]);                                  // 若计数已清 → 应重新拿满 2 宽限，第 1 次失败存活
  const aliveAgain = w._life[10][10] === 1;
  const doomAfterRefail = w._lifeDoom[10][10];
  ok(aliveHealthy && doomCleared && aliveAgain && doomAfterRefail === 1,
    'B4 反向恢复：健康后宽限清零，再变孤子重新拿满宽限（不会无端死）',
    `doom首次=${doomAfterFail} 健康存活=${aliveHealthy} 清空=${doomCleared} 再孤子存活=${aliveAgain} doom=${doomAfterRefail}`);
  if (!doomCleared) issue('HIGH', '宽限计数未在邻域恢复健康时清空', 'rts loner 扣宽限 → 补邻域健康 → 再变孤子',
    '宽限应清零后重新拿满', `doom 未清零`, '被判定将死的格子即使恢复也会被无端清除', '需求3');
}

// B5. 宽限在 rts 与 go 两种模式都生效
{
  // rts 已在上方 B1~B3 验证。go：直接 _goEvolveOnce 逐拍 + 真实 applyGoIntent 流程
  function goSeq(delay, steps) {
    const w = goWorld(500 + delay, { lonelyDeathDelay: delay });
    clearGo(w);
    const f = w.go.seatF[0];
    w._life[15][15] = f;
    w.go.lastPlacedKeys = new Set();
    const out = [];
    for (let i = 0; i < steps; i++) { w._goEvolveOnce(3); out.push(w._life[15][15] === f ? 1 : 0); }
    return out;
  }
  const g0 = goSeq(0, 2), g1 = goSeq(1, 3), g2 = goSeq(2, 4);
  note(`go delay=0 逐拍 [${g0.join(',')}]   delay=1 [${g1.join(',')}]   delay=2 [${g2.join(',')}]`);
  ok(g0[0] === 0, 'B5a go _goEvolveOnce delay=0：立即死', `[${g0.join(',')}]`);
  ok(g1[0] === 1 && g1[1] === 0, 'B5b go delay=1：撑 1 回合', `[${g1.join(',')}]`);
  ok(g2[0] === 1 && g2[1] === 1 && g2[2] === 0, 'B5c go delay=2：撑 2 回合', `[${g2.join(',')}]`);

  // 真实流程：2 人类回合制，观察 S 的存活轮数随 delay 变化
  function goRealRounds(delay, rounds) {
    const w = goWorld(600 + delay, { lonelyDeathDelay: delay });
    clearGo(w);
    const S = { lx: 16, ly: 16 };
    const far = [{ lx: 2, ly: 2 }, { lx: 20, ly: 20 }, { lx: 5, ly: 25 }, { lx: 28, ly: 8 }];
    const alive = [];
    goPlay(w, [S]);                                  // 第 1 回合（豁免）
    for (let k = 0; k < rounds; k++) {
      goPlay(w, [far[k % far.length]]);              // 换手落子 → 触发演化
      alive.push(w._life[S.lx][S.ly] === 1 ? 1 : 0);
    }
    return alive;
  }
  const real0 = goRealRounds(0, 2), real1 = goRealRounds(1, 3), real2 = goRealRounds(2, 4);
  note(`go 真实流程 S 存活序列 delay=0 [${real0.join(',')}] delay=1 [${real1.join(',')}] delay=2 [${real2.join(',')}]`);
  ok(real0[0] === 0, 'B5d go 真实流程 delay=0：换手后首轮死', `[${real0.join(',')}]`);
  ok(real1[0] === 1 && real1[1] === 0, 'B5e go 真实流程 delay=1：多活一轮', `[${real1.join(',')}]`);
  ok(real2[0] === 1 && real2[1] === 1 && real2[2] === 0, 'B5f go 真实流程 delay=2：多活两轮', `[${real2.join(',')}]`);
}

// =====================================================================
// C. 回合制多颗落子（moves 批次）
// =====================================================================
section('C. 回合制多颗落子（moves 批次）');

// C1. 预算钳制
{
  const w = goWorld(701, { stonesPerTurn: 3 });
  clearGo(w);
  const r3 = goPlay(w, [{ lx: 5, ly: 5 }, { lx: 6, ly: 5 }, { lx: 5, ly: 6 }]);
  ok(r3.ok && r3.placed === 3, 'C1a stonesPerTurn=3：提交 3 颗 ok', JSON.stringify(r3));
  // 换手后测超限
  const w2 = goWorld(702, { stonesPerTurn: 3 });
  clearGo(w2);
  const r4 = goPlay(w2, [{ lx: 5, ly: 5 }, { lx: 6, ly: 5 }, { lx: 5, ly: 6 }, { lx: 6, ly: 6 }]);
  ok(!r4.ok && r4.reason === 'too_many_stones', 'C1b stonesPerTurn=3：提交 4 颗 → too_many_stones', JSON.stringify(r4));
  const w3 = goWorld(703, { stonesPerTurn: 1 });
  clearGo(w3);
  const r1ok = goPlay(w3, [{ lx: 5, ly: 5 }]);
  ok(r1ok.ok && r1ok.placed === 1, 'C1c stonesPerTurn=1：提交 1 颗 ok', JSON.stringify(r1ok));
  const w4 = goWorld(704, { stonesPerTurn: 1 });
  clearGo(w4);
  const r1bad = goPlay(w4, [{ lx: 5, ly: 5 }, { lx: 6, ly: 5 }]);
  ok(!r1bad.ok && r1bad.reason === 'too_many_stones', 'C1d stonesPerTurn=1：提交 2 颗 → too_many_stones', JSON.stringify(r1bad));
  const w5 = goWorld(705, { stonesPerTurn: 16 });
  clearGo(w5);
  const sixteen = [];
  for (let dx = 0; dx < 4; dx++) for (let dy = 0; dy < 4; dy++) sixteen.push({ lx: 10 + dx, ly: 10 + dy });
  const r16 = goPlay(w5, sixteen);
  ok(r16.ok && r16.placed === 16, 'C1e stonesPerTurn=16：提交 16 颗 ok', JSON.stringify(r16));
}

// C2. 原子性：一批里只要有一颗非法 → 整批不得生效（棋盘/moveNo/turn 不变）
{
  function atomicCase(reason, moves, setup) {
    const w = goWorld(710 + reason.length, { stonesPerTurn: 8 });
    clearGo(w);
    if (setup) setup(w);
    const before = boardFingerprint(w);
    const mn0 = w.go.moveNo, turn0 = w.go.turn, placed0 = w.go.placedThisTurn;
    const r = goPlay(w, moves);
    const unchanged = boardFingerprint(w) === before && w.go.moveNo === mn0 && w.go.turn === turn0 && (w.go.placedThisTurn || 0) === (placed0 || 0);
    return { r, unchanged, boardSame: boardFingerprint(w) === before };
  }
  const dup = atomicCase('duplicate', [{ lx: 10, ly: 10 }, { lx: 10, ly: 10 }]);
  ok(!dup.r.ok && dup.r.reason === 'duplicate' && dup.unchanged,
    'C2a 重复坐标 → 整批拒绝，棋盘/moveNo/turn 不变', `${JSON.stringify(dup.r)} unchanged=${dup.unchanged}`);
  const oob = atomicCase('oob', [{ lx: 10, ly: 10 }, { lx: 99, ly: 10 }]);
  ok(!oob.r.ok && oob.r.reason === 'oob' && oob.unchanged,
    'C2b 越界 → 整批拒绝，棋盘不变', `${JSON.stringify(oob.r)} unchanged=${oob.unchanged}`);
  // 落在已有子上：先由 A 落一颗，然后 B 的批里含该点
  {
    const w = goWorld(730, { stonesPerTurn: 8 });
    clearGo(w);
    goPlay(w, [{ lx: 5, ly: 5 }]);       // A 落子 → 换手
    const before = boardFingerprint(w);
    const mn0 = w.go.moveNo, turn0 = w.go.turn;
    const r = goPlay(w, [{ lx: 6, ly: 6 }, { lx: 5, ly: 5 }]);   // 含已占点
    const unchanged = boardFingerprint(w) === before && w.go.moveNo === mn0 && w.go.turn === turn0;
    ok(!r.ok && r.reason === 'occupied' && unchanged && w._life[6][6] === 0,
      'C2c 落在已有子上 → 整批拒绝，另一颗也不落', `${JSON.stringify(r)} (6,6)=${w._life[6][6]} unchanged=${unchanged}`);
  }
  // 劫禁着点：直接设置 g.ko 检验批校验守卫
  {
    const w = goWorld(740, { stonesPerTurn: 8 });
    clearGo(w);
    w.go.ko = { lx: 7, ly: 7 };
    const before = boardFingerprint(w);
    const r = goPlay(w, [{ lx: 9, ly: 9 }, { lx: 7, ly: 7 }]);
    const unchanged = boardFingerprint(w) === before;
    ok(!r.ok && r.reason === 'ko' && unchanged && w._life[9][9] === 0,
      'C2d 劫禁着点入批 → 整批拒绝（守卫路径）', `${JSON.stringify(r)} unchanged=${unchanged}`);
    note('注：劫禁着由引擎自动产生的完整复盘未重建，此处验证的是批校验中的 ko 守卫分支');
  }
}

// C3. 整批一起判自杀 / 提子
{
  // 自杀：P 被 4 面敌子围住，落 P 无气且无提子
  function surround(w, x, y, f) { w._life[x - 1][y] = f; w._life[x + 1][y] = f; w._life[x][y - 1] = f; w._life[x][y + 1] = f; }
  {
    const w = goWorld(750, { stonesPerTurn: 8 });
    clearGo(w);
    surround(w, 10, 10, 2);
    const before = boardFingerprint(w);
    const r = goPlay(w, [{ lx: 10, ly: 10 }]);
    ok(!r.ok && r.reason === 'suicide' && boardFingerprint(w) === before,
      'C3a 单颗自杀 → suicide 且棋盘不变', JSON.stringify(r));
  }
  {
    const w = goWorld(751, { stonesPerTurn: 8 });
    clearGo(w);
    surround(w, 10, 10, 2); surround(w, 20, 20, 2);
    const before = boardFingerprint(w);
    const r = goPlay(w, [{ lx: 10, ly: 10 }, { lx: 20, ly: 20 }]);
    ok(!r.ok && r.reason === 'suicide' && boardFingerprint(w) === before,
      'C3b 整批（两颗都无气）→ 一起判自杀，整批回滚', JSON.stringify(r));
  }
  {
    // 提子：2 星被 3 面 f=1 围住，第 4 面是禁着点 → 落该点即提
    const w = goWorld(752, { stonesPerTurn: 8 });
    clearGo(w);
    w._life[20][20] = 2;
    w._life[19][20] = 1; w._life[21][20] = 1; w._life[20][19] = 1;
    const before = boardFingerprint(w);
    const r = goPlay(w, [{ lx: 20, ly: 21 }, { lx: 25, ly: 25 }]);
    const capturedGone = w._life[20][20] === 0;
    ok(r.ok && (r.captured || 0) > 0 && capturedGone && w._life[25][25] === 1,
      'C3c 一批把敌方团团围住提掉 → 成功且 captured>0', `${JSON.stringify(r)} (20,20)=${w._life[20][20]}`);
  }
}

// C4. 演化只跑一次（N 颗 ≠ N 步）
{
  const moves = [{ lx: 10, ly: 10 }, { lx: 11, ly: 10 }, { lx: 10, ly: 11 }];
  // X：真实批提交
  const X = goWorld(760, { stonesPerTurn: 3 });
  clearGo(X);
  let evCount = 0;
  const origEv = X._goEvolveOnce.bind(X);
  X._goEvolveOnce = function (...a) { evCount++; return origEv(...a); };
  const rx = goPlay(X, moves);
  // Y：手工只落同样的子，再演化一次
  const Y = goWorld(761, { stonesPerTurn: 3 });
  clearGo(Y);
  const fy = Y.go.seatF[0];
  for (const m of moves) Y._life[m.lx][m.ly] = fy;
  Y.go.lastPlacedKeys = new Set(moves.map(m => m.lx * World.LIFE_W + m.ly));
  Y.go.ko = null;
  Y._goEvolveOnce(3);
  const same = gridStr(X) === gridStr(Y);
  ok(rx.ok && evCount === 1,
    'C4a 提交 N=3 颗后演化只跑 1 步', `_goEvolveOnce 调用次数=${evCount}`);
  ok(same, 'C4b 批提交结果 == 手工落 3 颗再演化 1 次（证明不是 N 步）', `boardSame=${same}`);
  if (evCount !== 1) issue('HIGH', '一批 N 颗触发了 N 次演化', 'stonesPerTurn=3 提交 3 颗，统计 _goEvolveOnce', '应只 1 次', `实际 ${evCount} 次`, '回合制演化步数错误', '需求5');
}

// C5. 兼容旧格式 + moves:[] 行为
{
  const w = goWorld(770, { stonesPerTurn: 3 });
  clearGo(w);
  const rOld = goPlay(w, undefined);   // 占位：下面用旧格式
  // 用旧格式 {lx,ly}（不经 moves 包装）
  const w2 = goWorld(771, { stonesPerTurn: 3 });
  clearGo(w2);
  const pid = goTurnPid(w2);
  const rOldFmt = w2.applyGoIntent(pid, { lx: 16, ly: 16 }, []);
  ok(rOldFmt.ok && rOldFmt.placed === 1 && w2._life[16][16] !== 0,
    'C5a 兼容旧格式 {go:{lx,ly}} 仍能落 1 颗', JSON.stringify(rOldFmt));
  const w3 = goWorld(772, { stonesPerTurn: 3 });
  clearGo(w3);
  const rEmpty = w3.applyGoIntent(goTurnPid(w3), { moves: [] }, []);
  ok(!rEmpty.ok && rEmpty.reason === 'bad_move',
    'C5b moves:[] → bad_move（A 的实现选择）', JSON.stringify(rEmpty));
  note('客户端一致性：submitGoPending 空预选 → {go:{pass:true}}（永不发送 moves:[]；见 D 静态核对）');
}

// C6. AI 多子：多次真实回合（多 seed × 多 stonesPerTurn），全部合法、服务端不拒绝、统计平均颗数
{
  const configs = [{ spt: 3, seeds: [780, 781, 782, 783] }, { spt: 2, seeds: [790, 791] }, { spt: 16, seeds: [800, 801] }];
  const illegal = []; const rejectedList = []; let rejected = 0; let passes = 0; let deadStones = 0;
  const perCfg = {}; const moveCounts = [];
  for (const cfg of configs) {
    let turns = 0;
    for (const seed of cfg.seeds) {
      const w = goWorld(seed, { stonesPerTurn: cfg.spt });
      clearGo(w);
      w.addAI(); w.addAI(); w.addAI();          // 4 席（1 人 + 3 AI）
      for (let i = 0; i < 40 && !w.go.result; i++) {
        const f = w.go.turn;
        const pid = goTurnPid(w);
        const mv = World.goAIMove(w, f);
        const moves = (mv && Array.isArray(mv.moves)) ? mv.moves
          : (mv && Number.isInteger(mv.lx) && Number.isInteger(mv.ly) ? [{ lx: mv.lx, ly: mv.ly }] : null);
        if (!moves || !moves.length) { passes++; w.applyGoIntent(pid, { pass: true }, []); continue; }
        turns++;
        moveCounts.push(moves.length);
        if (moves.length < 1 || moves.length > cfg.spt) illegal.push({ seed, moves, why: 'count_out_of_range' });
        const seen = new Set();
        for (const m of moves) {
          const k = m.lx * 32 + m.ly;
          if (seen.has(k)) illegal.push({ seed, m, why: 'duplicate' });
          seen.add(k);
          if (m.lx < 0 || m.ly < 0 || m.lx >= 32 || m.ly >= 32) illegal.push({ seed, m, why: 'oob' });
          else if (w._life[m.lx][m.ly] !== 0) illegal.push({ seed, m, why: 'occupied_at_select' });
        }
        const r = w.applyGoIntent(pid, { moves }, []);
        if (!r.ok) { rejected++; rejectedList.push({ seed, spt: cfg.spt, moves, reason: r.reason }); }
        else { for (const m of moves) if (w._life[m.lx][m.ly] && w._goLiberties(m.lx, m.ly) === 0) deadStones++; }
      }
    }
    perCfg[cfg.spt] = turns;
  }
  const avg = moveCounts.length ? (moveCounts.reduce((a, b) => a + b, 0) / moveCounts.length) : 0;
  const maxLen = moveCounts.length ? Math.max(...moveCounts) : 0;
  ok(illegal.length === 0 && rejected === 0,
    'C6a AI 多子（spt=2/3/16，8 局）：全部合法、服务端零拒绝（无 reject→pass 退化）',
    `总手数=${moveCounts.length} passes=${passes} rejected=${rejected} 非法=${illegal.length} 每配置手数=${JSON.stringify(perCfg)}`);
  if (illegal.length) console.log('     非法样本:', JSON.stringify(illegal.slice(0, 5)));
  if (rejectedList.length) console.log('     拒绝样本:', JSON.stringify(rejectedList.slice(0, 5)));
  ok(moveCounts.length > 0 && maxLen <= 16, 'C6b AI 单批颗数不超过 stonesPerTurn 上限', `maxLen=${maxLen}`);
  note('AI 落子颗数分布', JSON.stringify(moveCounts.reduce((m, c) => (m[c] = (m[c] || 0) + 1, m), {})));
  note('AI 平均落子颗数', avg.toFixed(2) + ` (n=${moveCounts.length})`);
  if (rejected > 0) issue('HIGH', 'AI 提交被服务端拒绝 → 退化为 pass', '多局 AI 对局统计 applyGoIntent 返回', 'AI 落子应总被接受', `rejected=${rejected}: ${JSON.stringify(rejectedList.slice(0, 3))}`, 'AI 回合空转（reject→pass 退化循环）', '需求2');
  if (deadStones > 0) {
    note(`⚠ 观察到 ${deadStones} 次"新落子落点无气仍留在盘上"（批自杀判定只在全批无气时回滚）`);
    issue('LOW', '多子批可能留下"无气死子"', 'AI 批含互不相连的点，其中一个自身无气但另一个有气 → 整批通过',
      '无气单点不应留在盘上', `观测 ${deadStones} 次`, '与围棋"禁自杀"语义不完全一致（单点无气可存活）', '需求2');
  }
}

// =====================================================================
// E. 实时模式棋子近战吞噬
// =====================================================================
section('E. 实时模式棋子近战吞噬（_cellCombat / _lifeStep）');

// E1. 相邻敌方弱痕：一步内被直接吞噬（cell_eaten 事件）
{
  const w = rtsWorld(801, { lonelyDeathDelay: 6 });
  clearBoard(w);
  w._life[5][5] = 1;     // 己方强细胞
  w._life[6][5] = 12;    // 阵营 2 弱痕
  const ev = [];
  w._lifeStep(ev);       // 演化（宽限保护）→ 近战吞噬
  const eatenEv = ev.find(e => e.type === 'cell_eaten' && e.x === 6 && e.y === 5);
  ok(w._life[6][5] === 0 && !!eatenEv && eatenEv.f === 2 && eatenEv.by === 1,
    'E1 _lifeStep 内相邻敌弱痕被吞噬（cell_eaten 坐标/阵营正确）',
    `(6,5)=${w._life[6][5]} ev=${JSON.stringify(eatenEv)}`);
}

// E2. 相邻敌方强细胞：1 面围攻不第一步死，恰在 killAt 步击碎；给逐拍 dmg 序列
//   新公式（FIX MEDIUM-4）：dmg += max(1, atkIn)；killAt = ceil(CELL_ATK_HP * resist * anchor)
{
  const w = rtsWorld(802, { lonelyDeathDelay: 6 });
  clearBoard(w);
  w._life[5][5] = 2;     // 防守 f=2（resist 默认 1.0）
  w._life[6][5] = 1;     // 攻击 f=1（1 面，atkIn=1）
  const killAt = Math.ceil(World.CELL_ATK_HP * 1.0 * 1);   // =3
  const seq = [];
  let destroyedAt = -1;
  for (let s = 1; s <= killAt + 2; s++) {
    w._lifeStep([]);
    if (w._life[5][5] === 0) { seq.push('K'); destroyedAt = s; break; }
    seq.push(w._lifeDmg[5][5]);
  }
  ok(seq[0] !== 'K', 'E2a 1 面围攻：第 1 步不碎（incoming=max(1,atkIn)，resist 只抬阈值 killAt）', `逐拍=[${seq.join(',')}]`);
  ok(destroyedAt === killAt, `E2b 恰在第 killAt(=${killAt}=ceil(3*1.0*1)) 步被击碎`, `destroyedAt=${destroyedAt} 逐拍=[${seq.join(',')}]`);
  note('E2 逐拍 dmg 序列(killed=K)', `[${seq.join(',')}]`);
}

// E3. resist / 2×2 要塞（anchor）减伤对照 —— 验证新公式 killAt=ceil(3*resist*anchor) 无死区
//   ⚠ 隔离防守方阈值：用"耐久攻击方"（f=1 resist 极高，不会先死），让防守方稳定承受 incoming
//      直到恰好 ceil(3*resist*anchor) 被击碎，避免"攻守同拍互灭"掩盖纯阈值判定。
//   现实"会死"的互相磨血（含 1v1 同拍互灭）由 E2 / E3f / E3g / E3h / E7 覆盖。
//   注：引擎已改为"两阶段结算 → 同拍互灭"（去坐标偏序），旧的"谁下标小谁先死"行为已消除。
{
  function stepsToBreak(attackers, resist, anchor, durableAtk = true) {
    const w = rtsWorld(810 + attackers * 10 + Math.round(resist * 100) + (anchor ? 1 : 0), { lonelyDeathDelay: 40 });
    clearBoard(w);
    w._life[5][5] = 2;   // 防守 f=2
    const dirs = [[1, 0], [-1, 0], [0, -1], [0, 1]];
    for (let k = 0; k < attackers; k++) { const [dx, dy] = dirs[k]; w._life[5 + dx][5 + dy] = 1; }
    // durableAtk：f=1 攻击方 resist 极高（killAt≈300）→ 不会先死，隔离防守方阈值。
    const resistOf = durableAtk ? { 1: 100, 2: resist } : { 1: 1.0, 2: resist };
    const sh = anchor ? Array.from({ length: 32 }, () => new Uint8Array(32)) : undefined;
    if (sh) sh[5][5] = 1;
    for (let s = 1; s <= 60; s++) { w._cellCombat([], resistOf, sh); if (w._life[5][5] === 0) return s; }
    return Infinity;
  }
  const resists = [1.0, 1.15, 1.5, 2.0, 3.0];
  const atk1 = {}, atk4 = {};
  for (const r of resists) { atk1[r] = stepsToBreak(1, r, false); atk4[r] = stepsToBreak(4, r, false); }
  note('1 面围攻（耐久攻方）：resist→击碎步数', JSON.stringify(atk1));
  note('4 面围攻（耐久攻方）：resist→击碎步数', JSON.stringify(atk4));
  // 1 面：incoming=max(1,1)=1 → 步数应恰等于 ceil(3*resist*1)
  const expect1 = {}; for (const r of resists) expect1[r] = Math.ceil(World.CELL_ATK_HP * r * 1);
  ok(resists.every(r => atk1[r] === expect1[r]),
    'E3a 1 面：击碎步数 == ceil(3*resist*1)（阈值侧减伤，incoming=1）', `实测=${JSON.stringify(atk1)} 期望=${JSON.stringify(expect1)}`);
  if (!resists.every(r => atk1[r] === expect1[r])) issue('HIGH', '阈值公式 killAt=ceil(3*resist*anchor) 与实测不符', '耐久攻击方 1 面围攻，resist 1.0/1.15/1.5/2.0/3.0', JSON.stringify(expect1), JSON.stringify(atk1), '减伤阈值公式错误', '需求4');
  // 死区消失：阈值 3/4/5/6/9 严格递增且互不相同（1.15/1.5 与 1.0 有区别）
  const thresholds = resists.map(r => expect1[r]);
  const strictInc = thresholds.every((v, i) => i === 0 || v > thresholds[i - 1]) && new Set(thresholds).size === resists.length;
  ok(strictInc, 'E3b 死区消失：killAt 随 resist 严格递增且互不相同（ceil(3*r)=3/4/5/6/9）',
    `阈值=${JSON.stringify(thresholds)} 实测步数=${JSON.stringify(atk1)}`);
  if (!strictInc) issue('HIGH', 'resist 减伤仍存在死区（相邻 resist 阈值相同）', 'killAt=ceil(3*resist)', '3<4<5<6<9', JSON.stringify(thresholds), 'resist 分级仍失效', '需求4');
  // 4 面：incoming=max(1,4)=4 → 步数 == ceil(killAt/4)（验证 dmg += max(1,atkIn)）
  const expect4 = {}; for (const r of resists) expect4[r] = Math.ceil(expect1[r] / 4);
  ok(resists.every(r => atk4[r] === expect4[r]),
    'E3c 4 面：incoming=4 → 步数 == ceil(killAt/4)（验证 dmg += max(1,atkIn)）', `实测=${JSON.stringify(atk4)} 期望=${JSON.stringify(expect4)}`);
  // 2×2 要塞 anchor=2：阈值翻倍
  const a1n = stepsToBreak(1, 1.0, false), a1y = stepsToBreak(1, 1.0, true);
  const a4n = stepsToBreak(4, 1.0, false), a4y = stepsToBreak(4, 1.0, true);
  note('anchor 对照', `1面 非要塞=${a1n} 要塞=${a1y}；4面 非要塞=${a4n} 要塞=${a4y}`);
  ok(a1y > a1n && a4y > a4n, 'E3d 2×2 要塞(anchor=2) 阈值翻倍 → 击碎步数变长', `1面 ${a1n}→${a1y}；4面 ${a4n}→${a4y}`);
  const expectA = {}, gotA = {};
  for (const r of resists) { expectA[r] = Math.ceil(World.CELL_ATK_HP * r * 2); gotA[r] = stepsToBreak(1, r, true); }
  ok(resists.every(r => gotA[r] === expectA[r]), 'E3e 要塞：击碎步数 == ceil(3*resist*2)', `实测=${JSON.stringify(gotA)} 期望=${JSON.stringify(expectA)}`);
  // E3f 现实耦合：4 个"会死"的攻击方（resist 1.0）围攻 resist 1.0 防守方 → 当拍即碎（incoming=4≥killAt=3）
  const real4 = stepsToBreak(4, 1.0, false, false);
  ok(real4 <= 2, 'E3f 现实 4 面（攻方也会死）resist 1.0：当拍即碎（incoming=4 ≥ killAt=3）', `步数=${real4}`);
  const real1 = stepsToBreak(1, 1.0, false, false);
  note('1v1 现实对磨（非耐久攻方, resist 1.0）', `防守方击碎步数=${real1 === Infinity ? 'Infinity' : real1}；新语义下 f1/f2 于同拍互灭（旧引擎此处受 (x,y) 下标偏序影响）`);
}

// E3g/E3h. 去坐标偏序（铁律「算法=世界法则」）：1v1 贴脸 → 同拍双双清除；坐标互换/整体平移 → 结果一致
{
  function duel(f1, f2) {
    const w = rtsWorld(900, {});
    clearBoard(w);
    w._life[f1[0]][f1[1]] = 1; w._life[f2[0]][f2[1]] = 2;
    const cells = [f1, f2];
    const seq = []; const clearAt = [-1, -1];
    for (let s = 1; s <= 6; s++) {
      w._cellCombat([], { 1: 1.0, 2: 1.0 }, undefined);
      const row = cells.map(([x, y], i) => {
        if (w._life[x][y] === 0) { if (clearAt[i] < 0) clearAt[i] = s; return 'K'; }
        return String(w._lifeDmg[x][y]);
      });
      seq.push(row.join('/'));
    }
    return {
      seq: seq.join('|'), clearAt,
      bothGone: w._life[f1[0]][f1[1]] === 0 && w._life[f2[0]][f2[1]] === 0,
      dmgZero: w._lifeDmg[f1[0]][f1[1]] === 0 && w._lifeDmg[f2[0]][f2[1]] === 0,
    };
  }
  const A = duel([5, 5], [6, 5]);       // f1 下标更小
  const Bc = duel([6, 5], [5, 5]);      // 坐标互换（f1 下标更大）
  const Ct = duel([20, 20], [21, 20]);  // 整体平移 (+15,+15)
  note('E3g 逐拍（f1 dmg / f2 dmg，K=清除）', `A=${A.seq}  互换=${Bc.seq}  平移=${Ct.seq}`);
  const sameTick = A.clearAt[0] === A.clearAt[1] && A.clearAt[0] > 0;
  const consistent = Bc.seq === A.seq && Ct.seq === A.seq
    && A.clearAt[0] === Bc.clearAt[0] && A.clearAt[0] === Ct.clearAt[0];
  ok(A.bothGone && Bc.bothGone && Ct.bothGone && sameTick && A.dmgZero,
    'E3g 1v1 贴脸：同一拍双双被清除（不再"谁下标小谁先死"）',
    `A=${A.seq} clearAt=${JSON.stringify(A.clearAt)}`);
  ok(consistent,
    'E3h 去坐标偏序：坐标互换 / 整体平移 (+15,+15) → 逐拍结果与清除拍完全一致',
    `A=${A.seq} 互换=${Bc.seq} 平移=${Ct.seq}`);
  if (!(A.bothGone && sameTick)) issue('HIGH', '1v1 贴脸未同拍互灭（仍存在坐标/顺序依赖）', 'f1@(5,5) f2@(6,5) 各跑 6 拍', '同拍双双清除', `A=${A.seq}`, '违反铁律「算法=世界法则」，玩家无法解释', '需求4');
  if (!consistent) issue('HIGH', '近战结算仍依赖棋盘坐标（互换/平移结果不一致）', 'A vs 坐标互换 vs 平移', '三者逐拍一致', `A=${A.seq} 互换=${Bc.seq} 平移=${Ct.seq}`, '顺序依赖', '需求4');
}

// E4. 无攻击 → dmg 逐步自愈回 0（自愈行为应不受新公式影响）
{
  const w = rtsWorld(820);
  clearBoard(w);
  w._life[5][5] = 2;
  w._lifeDmg[5][5] = 2;
  w._cellCombat([], { 1: 1.0, 2: 1.0 }, undefined);
  const d1 = w._lifeDmg[5][5];
  w._cellCombat([], { 1: 1.0, 2: 1.0 }, undefined);
  const d2 = w._lifeDmg[5][5];
  ok(d1 === 1 && d2 === 0, 'E4 无攻击时 dmg 逐步自愈回 0（不受新公式影响）', `2 → ${d1} → ${d2}`);
}

// E5. snapshot().lifeHits 与内部 _lifeDmg 逐格一致（只含 dmg>0）
{
  const w = rtsWorld(830);
  clearBoard(w);
  w._life[5][5] = 2; w._life[6][5] = 1;
  w._life[9][9] = 2; w._life[8][9] = 1; w._life[10][9] = 1;
  w._cellCombat([], { 1: 1.0, 2: 1.0 }, undefined);
  const snap = w.snapshot();
  const expect = [];
  for (let x = 0; x < World.LIFE_W; x++) for (let y = 0; y < World.LIFE_W; y++) if (w._lifeDmg[x][y] > 0) expect.push(`${x},${y},${w._lifeDmg[x][y]}`);
  const got = (snap.lifeHits || []).map(h => `${h[0]},${h[1]},${h[2]}`);
  const same = expect.length === got.length && expect.every(e => got.includes(e)) && (snap.lifeHits || []).every(h => h[2] > 0);
  ok(same && expect.length > 0, 'E5 snapshot().lifeHits 与 _lifeDmg 逐格一致（稀疏，仅 dmg>0）',
    `expect=[${expect.join('|')}] got=[${got.join('|')}]`);
  const rtsHasHits = Array.isArray(snap.lifeHits);
  const goW = goWorld(831);
  const goHasHits = Array.isArray(goW.snapshot().lifeHits);
  ok(rtsHasHits && goHasHits, 'E5b 两种模式快照都含 lifeHits 字段', `rts=${rtsHasHits} go=${goHasHits}`);
}

// E6. 攻击只发生在 _lifeStep（与演化同拍），不在 20TPS 每 tick 结算
{
  const w = rtsWorld(840, { lonelyDeathDelay: 6 });
  clearBoard(w);
  w._life[5][5] = 2; w._life[6][5] = 1;
  const trace = [];
  for (let i = 1; i <= World.LIFE_STEP_TICKS; i++) { w.tickOnce(); trace.push(w._lifeDmg[5][5] || 0); }
  const increments = trace.filter((v, i) => i === 0 ? v > 0 : v > trace[i - 1]).length;
  ok(increments === 1 && trace[trace.length - 1] > 0,
    `E6 单个 LIFE_STEP 窗口内伤害只结算 1 次（非每 tick）`, `trace=[${trace.join(',')}] increments=${increments}`);
}

// E7. 确定性：新减伤公式无 Math.random / Date.now，同输入逐拍一致
{
  const engTxt = fs.readFileSync(path.join(ROOT, 'server/engine.js'), 'utf8');
  const s = engTxt.indexOf('_cellCombat(events, resistOf, sh)');
  const e = engTxt.indexOf('_captureEnclosed', s);
  const body = engTxt.slice(s, e > s ? e : s + 3000);
  const noRandom = !/Math\.random|Date\.now/.test(body);
  function run() {
    const w = rtsWorld(870, {});
    clearBoard(w); w._life[5][5] = 2; w._life[6][5] = 1; w._life[4][5] = 1;
    const t = [];
    for (let k = 0; k < 4; k++) { w._cellCombat([], { 1: 1.0, 2: 1.5 }, undefined); t.push(w._life[5][5] === 0 ? 'K' : w._lifeDmg[5][5]); }
    return t.join(',');
  }
  const a = run(), b = run();
  ok(noRandom && a === b, 'E7 确定性：新公式无 Math.random/Date.now，同输入逐拍一致', `noRandom=${noRandom} a=[${a}] b=[${b}]`);
  if (!noRandom || a !== b) issue('HIGH', '减伤公式破坏确定性', '核对 _cellCombat 主体 + 两次同输入运行', '无随机性、结果一致', `noRandom=${noRandom} a=[${a}] b=[${b}]`, '同 seed 复盘不一致', '需求4');
}

// =====================================================================
// 静态：客户端"点棋盘只入预选/撤回/提交"代码路径核对（D2/D3/D4 + G 文案）
// =====================================================================
section('D-static / G. 客户端代码与文案静态核对');
const clientTxt = fs.readFileSync(path.join(ROOT, 'public/client.js'), 'utf8');
const indexTxt = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
function has(re, txt) { return re.test(txt); }
function extract(txt, re) { const m = txt.match(re); return m ? m[0] : null; }

// D2：go 分支的 mousedown 只入预选，不含 sendIntent
{
  const mi = clientTxt.indexOf("cv.addEventListener('mousedown'");
  const wi = clientTxt.indexOf("cv.addEventListener('wheel'", mi);
  const seg = clientTxt.slice(mi, wi > mi ? wi : mi + 2600);
  const segNoSubmit = !/sendIntent/.test(seg);
  ok(segNoSubmit && mi >= 0, 'D2a mousedown 处理函数（含 go 点击分支）内无任何 sendIntent（点棋盘只入预选）',
    `mousedown@${mi} segmentHasSendIntent=${!segNoSubmit}`);
  const onlySubmit = (clientTxt.match(/go:\s*\{\s*moves/g) || []).length;
  ok(onlySubmit === 1, 'D2b 唯一提交路径 submitGoPending 发送 {go:{moves}}（仅 1 处）', `occurrences=${onlySubmit}`);
  ok(has(/sendIntent\(\{ go: \{ moves \} \}\)/, clientTxt), 'D2c 提交映射 state.goPending → {go:{moves:[...]}} 一次性发送');
  ok(has(/id="go-end-turn"/, clientTxt) && has(/\$\('go-end-turn'\)/, clientTxt), 'D2d 结束回合按钮 id=go-end-turn 且绑定 onclick=submitGoPending');
}

// D3：倒计时保护 —— sec<=2 && goPending.length>0 才提交；无预选不提交
{
  const guard = extract(clientTxt, /myTurn && g\.phase !== 'over' && Math\.ceil\(\(g\.msLeft \|\| 0\) \/ 1000\) <= 2\s*\n?\s*&& state\.goPending && state\.goPending\.length > 0/);
  ok(!!guard, 'D3a 倒计时保护条件含 goPending.length>0（无预选不提交）', guard ? 'matched' : '未匹配');
  const fn = extract(clientTxt, /function submitGoPending\(\)\s*\{[\s\S]*?\n\}/);
  ok(!!fn && /if \(moves\.length === 0\)\s*sendIntent\(\{ go: \{ pass: true \} \}\)/.test(fn),
    'D3b submitGoPending 空预选 → 发 {go:{pass:true}}（停一手；不替玩家发 moves:[]）', fn ? 'ok' : '未取到函数体');
}

// D4：撤回 —— 左键点幽灵子 splice；右键/Esc pop；提交用撤回后最终列表
{
  ok(has(/state\.goPending\.splice\(pi, 1\)/, clientTxt), 'D4a 左键点已预选幽灵子 → splice 掉那一颗');
  ok(has(/function undoGoPending\(\)[\s\S]*?state\.goPending\.pop\(\)/, clientTxt), 'D4b undoGoPending → pop 最后一颗');
  ok(has(/e\.button === 2/ , clientTxt) && has(/if \(undoGoPending\(\)\) e\.preventDefault\(\)/, clientTxt), 'D4c 右键 & Esc 均调用 undoGoPending');
  ok(has(/\(state\.goPending \|\| \[\]\)\.map\(p => \(\{ lx: p\.lx, ly: p\.ly \}\)\)/, clientTxt), 'D4d 提交时读取 goPending 当前值（撤回后的最终列表）');
}

// G. 文案与引擎一致性（本轮复验：对标杆句与全文 2×2 表述重新核对）
{
  // G1：标杆句「单颗和 2 颗相邻都会被吃掉；≥3 颗连片（直线三连 / L 形）或 2×2 方块才稳」是否与引擎一致
  function shapeResidual(cells) {
    const w = rtsWorld(950 + cells.length, {});
    clearBoard(w);
    for (const [x, y] of cells) w._life[x][y] = 1;
    for (let i = 0; i < 6; i++) w._lifeStep([]);
    let n = 0;
    for (let x = 0; x < 32; x++) for (let y = 0; y < 32; y++) if (w._life[x][y] === 1) n++;
    return n;
  }
  const shapes = {
    '单颗': [[10, 10]],
    '2块相邻': [[10, 10], [11, 10]],
    '直线3': [[10, 10], [11, 10], [12, 10]],
    'L形3': [[10, 10], [11, 10], [10, 11]],
    '2×2方块': [[10, 10], [11, 10], [10, 11], [11, 11]],
  };
  const table = {};
  for (const [k, v] of Object.entries(shapes)) table[k] = shapeResidual(v);
  note('各形状 6 拍后残余己方细胞数（0=被康威吃掉）', JSON.stringify(table));
  const claimMatches = table['单颗'] === 0 && table['2块相邻'] === 0 && table['直线3'] >= 3 && table['L形3'] >= 4 && table['2×2方块'] >= 4;
  ok(claimMatches, 'G1 标杆句与引擎实测一致：单颗/2 颗相邻=死；≥3 连片(直线3/L) 或 2×2=活', JSON.stringify(table));
  if (!claimMatches) issue('HIGH', '标杆句与引擎实测不符', '摆 5 种形状各跑 6 拍', '单颗/2颗=0，直线3≥3，L3≥4，2×2≥4', JSON.stringify(table), '玩家可见文案错误', '需求1/文案');
  // 本轮（用户要求简化文案、去掉"康威"等玩家不懂的术语）后，标杆句改为直白表述：
  // "单独 1 颗、或只挨着 1 颗的细胞会消失；≥3 颗连成一片（直线三连 / L 形）或 2×2 方块才稳"
  const newStd = /单独 1 颗、或只挨着 1 颗的细胞会消失/.test(clientTxt);
  const ambiguousGone = !/或连片才稳/.test(clientTxt) && !/或连成片才稳/.test(clientTxt);
  ok(newStd && ambiguousGone, 'G1b 文案已换成直白标杆句，旧「2×2 同色或连片才稳」歧义表述已消除', `newStd=${newStd} ambiguousGone=${ambiguousGone}`);
  if (!(newStd && ambiguousGone)) issue('HIGH', '标杆句未完整铺开或仍残留歧义旧句', '读 client.js 简报/帮助/键面板/organHint 与 index.html', '含直白标杆句且无「或连片才稳」', `newStd=${newStd} ambiguousGone=${ambiguousGone}`, '玩家可见文案不一致', '需求1/文案');

  // G2：棋子/细胞会主动攻击相邻的敌人/敌方细胞 —— 与 E1/E2（_cellCombat）一致；本轮文案简化为"自动攻击附近的敌人"
  ok(/自动攻击附近的敌人/.test(indexTxt) || /会自动攻击/.test(indexTxt) || /棋子会主动攻击相邻敌方细胞/.test(clientTxt),
    'G2 文案「细胞/棋子会主动攻击相邻敌人」存在且与 _cellCombat 一致（见 E1/E2）');

  // G3：go 文案与引擎数值
  ok(/每回合可落多颗/.test(clientTxt) && /默认 3/.test(clientTxt),
    'G3a go 文案含「每回合可落多颗（默认 3）」', '');
  ok(World.STONES_PER_TURN_DEFAULT === 3, 'G3b 引擎 stonesPerTurn 默认=3（与文案一致）', `=${World.STONES_PER_TURN_DEFAULT}`);
  ok(World.LONELY_DEATH_DELAY_DEFAULT === 0 && World.LONELY_DEATH_DELAY_MAX === 10,
    'G3c 引擎 死亡宽限 默认0/上限10（与文案一致）', `=${World.LONELY_DEATH_DELAY_DEFAULT}/${World.LONELY_DEATH_DELAY_MAX}`);
  const goEvo = fs.readFileSync(path.join(ROOT, 'server/go.js'), 'utf8');
  ok(has(/jp && jp\.has\(x \* W \+ y\)\) \{ next\[x\]\[y\] = cur; continue; \}/, goEvo),
    'G3d 引擎实现「本回合刚落的子当回合豁免死亡」（与文案一致）');

  // G4：go 速查面板「目标」与「规则①」口径一致（均“可落多颗”），不再有“落一子”
  const goalMulti = /<b style="color:#ffd479">目标<\/b>：32×32 棋盘上，每回合可在任意空格落<b>多颗<\/b>子（默认 3，房主可设 1~16）/.test(clientTxt);
  const rule1Multi = /① <b>落子<\/b>：点任意空格即可（不限于邻接）；<b>每回合可落多颗<\/b>（默认 3，房主可设 1~16）/.test(clientTxt);
  const noSingleInGoal = !/空格落一子/.test(clientTxt);
  ok(goalMulti && rule1Multi && noSingleInGoal,
    'G4 go 速查「目标」与「规则①」口径一致（均为“可落多颗，默认3，1~16”），无“落一子”',
    `目标多颗=${goalMulti} 规则①多颗=${rule1Multi} 无落一子=${noSingleInGoal}`);
  if (!(goalMulti && rule1Multi && noSingleInGoal)) issue('HIGH', 'go 速查面板口径仍不一致', '读“目标”与“规则①”', '均写“可落多颗”', `目标多颗=${goalMulti} 规则①多颗=${rule1Multi} 无落一子=${noSingleInGoal}`, '违背用户第 2 条', '需求2/文案');

  // G5：全文重扫 2x2/2×2 —— 只允许「要塞机制」「双倍抗性」「要摆成才稳」语义，无“一次 F 得到 2×2”
  const files = [['client.js', clientTxt], ['index.html', indexTxt]];
  const badLines = []; let twoCount = 0;
  for (const [fn, txt] of files) {
    txt.split('\n').forEach((l, i) => {
      if (!/2x2|2×2/.test(l)) return;
      twoCount++;
      if (!/要塞|抗吞噬|抗性|帝国网|要自己摆|才稳|掩码|stronghold|双倍/.test(l)) badLines.push(`${fn}:${i + 1}: ${l.trim().slice(0, 90)}`);
    });
  }
  const fPlants1 = /F 种 1 颗强细胞/.test(clientTxt);
  const floatFixed = /\+1 强细胞/.test(clientTxt) && !/\+2x2 据点/.test(clientTxt);
  const enginePlantsOne = /this\._life\[lx\]\[ly\] = f;\s*\n\s*return \{ lx, ly \};/.test(fs.readFileSync(path.join(ROOT, 'server/engine.js'), 'utf8'));
  note('rts F 落子：引擎每按一次 = 1 格（_lifePlant 只设单格）', `enginePlantsOne=${enginePlantsOne}`);
  ok(badLines.length === 0, 'G5 全文 2×2 说法均为「要塞机制」或「要摆成才稳」语义，无“一次 F 得 2×2”',
    `含 2x2 行数=${twoCount} 可疑=${badLines.length}${badLines.length ? ' → ' + JSON.stringify(badLines) : ''}`);
  ok(fPlants1 && floatFixed, 'G5b 键面板“F 种 1 颗强细胞” + 落子飘字改为“+1 强细胞”', `F1颗=${fPlants1} floatFixed=${floatFixed}`);
  if (badLines.length) issue('HIGH', 'rts 文案仍有“一次 F 得到 2×2”类说法', '全文扫 2x2/2×2', '仅剩要塞/要摆成才稳语义', JSON.stringify(badLines), '玩家误解落子效果', '需求1/文案');
  if (!(fPlants1 && floatFixed)) issue('HIGH', 'F 落子文案/飘字未与引擎“1 格”对齐', '读键面板与落子飘字', '均表述为 1 颗', `F1颗=${fPlants1} floatFixed=${floatFixed}`, '文案与引擎不符', '需求1/文案');

  // G6：前端版本号
  const ver = extract(indexTxt, /client\.js\?v=[\w]+/);
  ok(/^client\.js\?v=\d{8}[a-z]$/.test(String(ver)), 'G6 index.html 含有效缓存版本号（防旧缓存）', String(ver));
}

// =====================================================================
// 端到端：真实服务（PORT=17915，临时 DB）
// =====================================================================
section('E2E. 真实服务（PORT=17915，临时 DB）');

let bootLog = '';
let currentSrv = null;
function startServer() {
  const p = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', (d) => { bootLog += d.toString(); });
  p.stderr.on('data', (d) => { bootLog += d.toString(); });
  currentSrv = p;
  return p;
}
const stopSrv = () => { try { if (currentSrv) currentSrv.kill('SIGKILL'); } catch {} };
async function waitUp(tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(BASE + '/api/meta'); if (r.ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
async function restartServer() {
  stopSrv();
  await new Promise(r => setTimeout(r, 800));
  startServer();
  return waitUp();
}
startServer();

async function req(method, p, body, token) {
  const url = BASE + '/api' + p + (token ? (p.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token) : '');
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { code: -1, message: 'non_json', raw: t.slice(0, 120) }; }
}
const uniq = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
async function mkUser(tag) {
  const u = tag + '_' + uniq();
  const r = await req('POST', '/auth/register', { username: u, password: 'password123' });
  if (r.code !== 0) throw new Error('register fail: ' + JSON.stringify(r));
  return { ...r.data.user, token: r.data.token };
}
function wsFirstSnap(worldId, token, ms = 4000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const snaps = [];
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', data: { token, worldId } })));
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === 'snap') snaps.push(m.data);
    });
    ws.on('error', () => {});
    setTimeout(() => { try { ws.close(); } catch {} resolve({ snaps }); }, ms);
  });
}

try {
  const up = await waitUp();
  ok(up, 'E2E 服务已启动', (bootLog.match(/\[db\][^\n]*/) || ['(no db log)'])[0]);
  if (!up) throw new Error('server not up');

  const host = await mkUser('h');

  // ---- F1. 设置透传四处一致 ----
  {
    const room = await req('POST', '/rooms', { name: 'GP', maxPlayers: 4, visibility: 'public', mode: 'go', stonesPerTurn: 5, lonelyDeathDelay: 2 }, host.token);
    const code = room.data.code;
    const w = await req('POST', `/rooms/${code}/world`, { mode: 'go' }, host.token);
    const worldId = w.data.worldId;
    await req('POST', `/rooms/${code}/join`, {}, host.token);
    await req('POST', `/rooms/${code}/start`, {}, host.token);
    const info = await req('GET', `/rooms/${code}`, null, host.token);       // 房间视图
    const list = await req('GET', '/rooms', null, host.token);               // 大厅列表
    const lst = (list.data.rooms || []).find(r => r.code === code);
    const snapHttp = await req('GET', `/worlds/${worldId}`, null, host.token);
    const { snaps } = await wsFirstSnap(worldId, host.token, 2500);
    const wsSnap = snaps.length ? snaps[snaps.length - 1] : null;
    const a = info.data && info.data.stonesPerTurn + '/' + info.data.lonelyDeathDelay;
    const b = lst && lst.stonesPerTurn + '/' + lst.lonelyDeathDelay;
    const c = snapHttp.data && snapHttp.data.settings.stonesPerTurn + '/' + snapHttp.data.settings.lonelyDeathDelay;
    const d = wsSnap && wsSnap.settings.stonesPerTurn + '/' + wsSnap.settings.lonelyDeathDelay;
    ok(a === '5/2' && b === '5/2' && c === '5/2' && d === '5/2',
      'F1 房间设置 5/2 在「房间视图 / 大厅列表 / HTTP快照 / WS快照」四处一致',
      `room=${a} list=${b} snap=${c} ws=${d}`);
  }

  // ---- F2. 非法/越界值钳制，不 500 ----
  {
    const cases = [
      ['0', 'stonesPerTurn', 0, 1], ['99', 'stonesPerTurn', 99, 16], ["'abc'", 'stonesPerTurn', 'abc', 3],
      ['null', 'stonesPerTurn', null, 3], ['负数', 'stonesPerTurn', -5, 1],
      ['0', 'lonelyDeathDelay', 0, 0], ['99', 'lonelyDeathDelay', 99, 10], ["'abc'", 'lonelyDeathDelay', 'abc', 0],
      ['null', 'lonelyDeathDelay', null, 0], ['负数', 'lonelyDeathDelay', -1, 0],
    ];
    let allOk = true; const det = [];
    for (const [tag, key, val, exp] of cases) {
      const r = await req('POST', '/rooms', { name: 'clamp', mode: 'rts', [key]: val }, host.token);
      const got = r.data && r.data[key];
      const good = r.code === 0 && got === exp && r.code !== 500;
      if (!good) { allOk = false; det.push(`${key}=${tag}→${got}(期望${exp},code=${r.code})`); }
    }
    ok(allOk, 'F2 非法值(0/99/abc/null/负)全部钳制到合法区间或默认，且不 500', det.length ? det.join(';') : '10/10 用例通过');
    if (!allOk) issue('HIGH', '房间设置非法值未被正确钳制', 'POST /rooms 传 0/99/abc/null/负数', '钳制到 1..16 / 0..10 或默认，不 500', det.join(';'), '玩家输入非法时可能 500 或越界', '需求2/3');
  }

  // ---- F3. 不传 → 3 / 0 ----
  {
    const r = await req('POST', '/rooms', { name: 'default', mode: 'rts' }, host.token);
    ok(r.data && r.data.stonesPerTurn === 3 && r.data.lonelyDeathDelay === 0,
      'F3 不传设置 → 默认 3 / 0', r.data ? `${r.data.stonesPerTurn}/${r.data.lonelyDeathDelay}` : JSON.stringify(r));
  }

  // ---- D1. 棋盘只在“结束回合”后才运行（服务端侧） ----
  {
    const room = await req('POST', '/rooms', { name: 'gostill', maxPlayers: 2, visibility: 'public', mode: 'go' }, host.token);
    const code = room.data.code;
    const w = await req('POST', `/rooms/${code}/world`, { mode: 'go' }, host.token);
    const worldId = w.data.worldId;
    await req('POST', `/rooms/${code}/join`, {}, host.token);
    await req('POST', `/rooms/${code}/start`, {}, host.token);
    // 静置 ~6s（< GO_TURN_MS=30s），全程不发任何 intent
    const { snaps } = await wsFirstSnap(worldId, host.token, 6000);
    const first = snaps[0], last = snaps[snaps.length - 1];
    const gridSame = first && last && JSON.stringify(first.lifeGrid) === JSON.stringify(last.lifeGrid);
    const moveNoSame = first && last && first.go.moveNo === last.go.moveNo;
    const msDecreased = first && last && last.go.msLeft <= first.go.msLeft;
    const nonEmpty = first && first.lifeGrid.some(col => col.some(v => v !== 0));
    ok(snaps.length >= 3 && gridSame && moveNoSame && msDecreased && !nonEmpty,
      'D1 服务端：静置 6s（未发 intent）棋盘 lifeGrid 与 moveNo 完全不变，仅 msLeft 在走',
      `snaps=${snaps.length} gridSame=${gridSame} moveNo=${first && first.go.moveNo}->${last && last.go.moveNo} msLeft=${first && first.go.msLeft}->${last && last.go.msLeft}`);
    if (!gridSame || !moveNoSame) issue('CRITICAL', '未落子时棋盘/手数仍在推进', 'go 房间静置 6s 不发 intent', 'lifeGrid 与 moveNo 不变', `gridSame=${gridSame} moveNoSame=${moveNoSame}`, '违反“结束回合前棋盘不动”', '需求5');
  }

  // ---- C6-E2E. AI 真实出手（走 net/index 的 1s 循环） ----
  {
    const room = await req('POST', '/rooms', { name: 'aigo', maxPlayers: 4, visibility: 'public', mode: 'go' }, host.token);
    const code = room.data.code;
    const w = await req('POST', `/rooms/${code}/world`, { mode: 'go' }, host.token);
    const worldId = w.data.worldId;
    await req('POST', `/rooms/${code}/join`, {}, host.token);           // 人类先手
    await req('POST', `/rooms/${code}/ai`, {}, host.token);
    await req('POST', `/rooms/${code}/ai`, {}, host.token);
    await req('POST', `/rooms/${code}/ai`, {}, host.token);
    await req('POST', `/rooms/${code}/start`, {}, host.token);
    // 人类先手：连上 WS，轮到我时提交一手（= 结束回合）；随后 AI 自动接续。
    const snaps = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      const acc = []; let sent = false;
      ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', data: { token: host.token, worldId } })));
      ws.on('message', (raw) => {
        let m; try { m = JSON.parse(raw.toString()); } catch { return; }
        if (m.type !== 'snap') return;
        acc.push(m.data);
        const g = m.data.go;
        if (!sent && g && g.phase !== 'over' && g.turn != null && String(g.turn) === String(host.id)) {
          sent = true;
          ws.send(JSON.stringify({ type: 'intent', data: { go: { moves: [{ lx: 16, ly: 16 }] } } }));
        }
      });
      ws.on('error', () => {});
      setTimeout(() => { try { ws.close(); } catch {} resolve(acc); }, 9000);
    });
    const mn = snaps.map(s => s.go && s.go.moveNo).filter(x => x != null);
    const advanced = mn.length && Math.max(...mn) - Math.min(...mn) >= 1;
    ok(snaps.length > 0 && advanced, 'C6-E2E 真实服务：人类结束回合后 AI 自动接续推进（无死锁）',
      `snaps=${snaps.length} moveNo ${mn.length ? Math.min(...mn) : '?'}→${mn.length ? Math.max(...mn) : '?'}`);
    let maxPts = 0;
    for (const s of snaps) if (s.go && s.go.lastMove && s.go.lastMove.pts) maxPts = Math.max(maxPts, s.go.lastMove.pts.length);
    ok(maxPts >= 1 && maxPts <= 3, 'C6-E2E AI 落子颗数 ∈ [1,3]（快照 lastMove.pts）', `maxPts=${maxPts}`);
  }

  // ---- I. 独立质疑 A 的 §13 改动（AI 自动补位 → 手动 addAI）是否掩盖真回归 ----
  {
    // I1 单元：新建世界 + _maybeAddAI() 不产生任何玩家（不再自动补位）
    const wi = new World('qa-nofill-' + rid(), 1, 9001, { mode: 'rts' });
    const p0 = Object.keys(wi.players).length;
    wi._maybeAddAI();
    const p1 = Object.keys(wi.players).length;
    ok(p0 === 0 && p1 === 0, 'I1 _maybeAddAI() 为 no-op：不自动补位（席位模型）', `players ${p0}→${p1}`);

    // I2 真实 go 房：1 人类 + 不手动加 AI → 快照席位=1、无幽灵 AI、无死锁
    const rg = await req('POST', '/rooms', { name: 'soloGo', maxPlayers: 4, visibility: 'public', mode: 'go' }, host.token);
    const cg = rg.data.code;
    const wg = await req('POST', `/rooms/${cg}/world`, { mode: 'go' }, host.token);
    await req('POST', `/rooms/${cg}/join`, {}, host.token);
    await req('POST', `/rooms/${cg}/start`, {}, host.token);
    const { snaps: gsnaps } = await wsFirstSnap(wg.data.worldId, host.token, 4000);
    const glast = gsnaps[gsnaps.length - 1];
    const gseats = (glast && glast.go && glast.go.seats) || [];
    const gAdvanced = glast && glast.go && glast.go.msLeft < 30000;   // 计时在走=未死锁
    ok(gseats.length === 1 && gseats.every(s => !s.isAI) && gAdvanced,
      'I2 真实 go 房：1 人类不加 AI → 快照席位=1、无自动补 AI、计时推进（无死锁）',
      `seats=${gseats.length} isAI=${JSON.stringify(gseats.map(s => s.isAI))} msLeft=${glast && glast.go && glast.go.msLeft}`);

    // I3 真实 rts 房：1 人类 + 不手动加 AI → 席位 1H+0AI（不再自动补到 4）
    const rr = await req('POST', '/rooms', { name: 'soloRts', maxPlayers: 4, visibility: 'public', mode: 'rts' }, host.token);
    const cr = rr.data.code;
    await req('POST', `/rooms/${cr}/world`, { mode: 'rts' }, host.token);
    await req('POST', `/rooms/${cr}/join`, {}, host.token);
    const rinfo = await req('GET', `/rooms/${cr}`, null, host.token);
    ok(rinfo.data.seatCount === 1 && rinfo.data.aiCount === 0,
      'I3 真实 rts 房：1 人类不加 AI → 席位 1H+0AI（旧的自动补到 4 已移除）',
      `seat=${rinfo.data.seatCount} human=${rinfo.data.humanCount} ai=${rinfo.data.aiCount}`);
  }

  // ---- F4. 世界重建不丢设置（重启服务，同 DB；走"按房间重新取"= 主流程） ----
  {
    const room = await req('POST', '/rooms', { name: 'rebuild', maxPlayers: 2, visibility: 'public', mode: 'rts', stonesPerTurn: 7, lonelyDeathDelay: 4 }, host.token);
    const code = room.data.code;
    const w = await req('POST', `/rooms/${code}/world`, { mode: 'rts' }, host.token);
    const worldId = w.data.worldId;
    await req('POST', `/rooms/${code}/join`, {}, host.token);
    ok(!!worldId, 'F4a 建房/建世界成功（rts, 7/4）', `code=${code} world=${worldId}`);
    // 重启服务（同 DB）→ activeWorlds 清空；客户端重连会先 POST /rooms/:code/join（按房间重建）
    const up2 = await restartServer();
    ok(up2, 'F4b 服务重启成功（同临时 DB）', (bootLog.match(/\[db\][\s\S]*?(?=\n)/) || [''])[0]);
    const j = await req('POST', `/rooms/${code}/join`, {}, host.token);   // 主流程：按房间重新取世界
    const info = await req('GET', `/rooms/${code}`, null, host.token);
    const roomSet = info.data && `${info.data.stonesPerTurn}/${info.data.lonelyDeathDelay}`;
    const joinSet = j.data && j.data.snap && `${j.data.snap.settings.stonesPerTurn}/${j.data.snap.settings.lonelyDeathDelay}`;
    ok(roomSet === '7/4' && joinSet === '7/4',
      'F4c 重启后（按房间重建 /join）：房间设置 与 重建世界 snapshot.settings 仍为 7/4',
      `room=${roomSet} joinWorld=${joinSet}`);
    if (roomSet !== '7/4' || joinSet !== '7/4') issue('HIGH', '按房间重建后设置丢失', '重启服务后 POST /rooms/:code/join', '设置仍为 7/4', `room=${roomSet} joinWorld=${joinSet}`, '房主设置重启后丢失', '需求2/3');
  }

  // ---- F4-alt. 备用重建路径 GET /worlds/:id（不传房间设置）是否丢设置 ----
  {
    const room = await req('POST', '/rooms', { name: 'rebuild2', maxPlayers: 2, visibility: 'public', mode: 'rts', stonesPerTurn: 9, lonelyDeathDelay: 5 }, host.token);
    const code = room.data.code;
    const w = await req('POST', `/rooms/${code}/world`, { mode: 'rts' }, host.token);
    const worldId = w.data.worldId;
    await req('POST', `/rooms/${code}/join`, {}, host.token);
    await restartServer();
    const snap = await req('GET', `/worlds/${worldId}`, null, host.token);   // 直接按 worldId 重建（无 roomOpts）
    const altSet = snap.data && `${snap.data.settings.stonesPerTurn}/${snap.data.settings.lonelyDeathDelay}`;
    ok(altSet === '9/5', 'F4d-alt 重启后直接 GET /worlds/:id（备用路径）重建也保留房间设置 9/5',
      `altWorld=${altSet}`);
    if (altSet !== '9/5') {
      note('备用路径 GET /worlds/:id 未带房间设置 → 以默认值重建，且会缓存进 activeWorlds，随后按房间 join 会拿到这个默认世界');
      issue('MEDIUM', '备用重建路径 GET /worlds/:id 丢房间设置（ensureWorld 未传 roomOpts）',
        '建房 9/5 → 建世界 → 重启 → 先 GET /worlds/:id 再 POST /rooms/:code/join',
        '两条重建路径都应带房间设置', `GET /worlds/:id 得到 ${altSet}（默认 3/0）`,
        '若客户端/tooling 先命中该路径，会以默认设置缓存世界，随后按房间 join 也拿到错误设置', '需求2/3');
    }
  }
} catch (e) {
  fail++;
  console.log('  ❌ E2E 异常：' + (e && e.stack || e));
} finally {
  stopSrv();
}

// =====================================================================
// 汇总
// =====================================================================
section('汇总');
console.log(`断言：${pass} 通过 / ${fail} 失败`);
if (issues.length) {
  console.log('\n问题清单：');
  for (const it of issues) console.log(`  [${it.sev}] ${it.title}  → 需求${it.clause}`);
} else {
  console.log('未发现 CRITICAL/HIGH/MEDIUM 级问题。');
}
const critHigh = issues.filter(i => i.sev === 'CRITICAL' || i.sev === 'HIGH');
console.log('\nVERDICT: ' + (critHigh.length ? 'FAIL' : 'PASS'));

// 清理：临时 DB / 日志（Windows 下子进程句柄释放有延迟 → 重试）
for (let i = 0; i < 12; i++) {
  try { fs.unlinkSync(TMP_DB); break; } catch { await sleep(150); }
}
try { fs.unlinkSync(TMP_DB + '-journal'); } catch {}
try { fs.unlinkSync(TMP_LOG); } catch {}
process.exit(critHigh.length ? 1 : (fail ? 1 : 0));
