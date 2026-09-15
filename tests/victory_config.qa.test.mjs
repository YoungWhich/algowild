// tests/victory_config.qa.test.mjs — 独立验证：房主可配置胜利条件（QA · Edward）
//
// 本文件**独立于** tests/victory_config.test.mjs（工程自测），重点攻击工程自测未必覆盖的边界：
//   QA-01 每条 rts 胜利线「关=不触发 / 开=触发」独立真伪（4 条线各自构造成立条件）
//   QA-02 默认值：不传 victoryLines → rts 实际只开 territory（singularity/economy/survival 构造成立也不胜）
//   QA-03 go 模式门禁：API/World 强传非法线被强制归零且**不生效**
//   QA-04 【重点】吃光不判胜：2 人局一方被提光 → winner=null（0:0 平局），而非幸存者无条件胜
//   QA-05 数子法正确性：手工确定盘面 + 手算期望值比对 _goScoreChinese
//   QA-06 不贴子：无 komi 补偿（空盘/对称盘双方等分；黑先不额外加分）
//   QA-07 门槛可配：victoryThresholds 真正改变 rts 判定
//   QA-08 economy 攒条清零：中途关掉再打开不"一开即胜"
//   QA-09 全关：rts 不发 victory 不崩；go 关 territory → winner=null
//   QA-10 PATCH /rooms/:code/settings：非房主 403；房主改后 roomInfo 与 snapshot 同步
//   QA-11 确定性守卫：go.js/engine.js/ai.js 模拟路径无 Math.random / Date.now
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import { createRouter } from '../server/routes.js';
import { signToken } from '../server/auth.js';
import { initDB, usersRepo } from '../server/db/index.js';
import { World, loadKernels } from '../server/engine.js';
import { activeWorlds } from '../server/worldhub.js';
import {
  createRoom, roomInfo, getRoom,
} from '../server/rooms.js';

await initDB();
await loadKernels();

// ---------------------------------------------------------------- helpers
async function setupApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createRouter());
  return app;
}

let seq = 0;
function newUser(prefix = 'q') {
  const name = prefix + '_' + Date.now() + '_' + (seq++);
  usersRepo.create(name, name + '@t', 'fakehash');
  const u = usersRepo.byUsername(name);
  return { id: u.id, username: u.username, token: signToken({ id: u.id, username: u.username }) };
}

async function call(app, method, path, body, token) {
  const http = await import('node:http');
  return new Promise((resolve, reject) => {
    const server = app.listen(0);
    server.on('listening', () => {
      const port = server.address().port;
      const data = body ? JSON.stringify(body) : '';
      const req = http.request({
        method, hostname: '127.0.0.1', port, path,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          server.close();
          const txt = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try { parsed = JSON.parse(txt); } catch (e) { parsed = { raw: txt }; }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      if (data) req.write(data);
      req.end();
    });
  });
}

function freshWorld(seed, opts) {
  const w = new World('qa_' + seed + '_' + (seq++), 1, seed, opts || {});
  w._skipAIFill = true;
  return w;
}

function seatedGo(seed, opts) {
  const w = new World('qaGo' + seed + '_' + (seq++), 1, seed, Object.assign({ mode: 'go' }, opts || {}));
  w._skipAIFill = true;
  w.addPlayer(1, 'Black');
  w.addPlayer(2, 'White');
  w._goInit();
  return w;
}

function clearLife(w) {
  const L = w._life;
  for (let x = 0; x < 32; x++) for (let y = 0; y < 32; y++) L[x][y] = 0;
  return L;
}

const ALL_OFF = { territory: false, economy: false, singularity: false, survival: false };

// ============================================================ QA-01 每条线开关真伪
// 对每条线：a) 该线关闭（其余也关）→ 条件成立也不胜；b) 该线单开 → 同名 winReason 胜利 1 次。

test('QA-01 territory 线：关=不触发；开=触发（winReason=territory）', () => {
  // 关：把领土条件设成立，但 territory=false
  const off = freshWorld(101, { victoryLines: ALL_OFF });
  const pOff = off.addPlayer(1, 'P');
  pOff.era = 5; pOff.regionsOwned = 30;   // 远超默认门槛 16
  const evOff = [];
  off._checkVictoryConditions(evOff);
  assert.equal(pOff.won, false, '领土线关闭时不得胜');
  assert.equal(evOff.filter(e => e.type === 'victory').length, 0, '关闭线不得发 victory');

  // 开：同样条件
  const on = freshWorld(102, { victoryLines: { ...ALL_OFF, territory: true } });
  const pOn = on.addPlayer(1, 'P');
  pOn.era = 5; pOn.regionsOwned = 30;
  const evOn = [];
  on._checkVictoryConditions(evOn);
  assert.equal(pOn.won, true, '领土线开启 + 条件成立 → 胜');
  assert.equal(pOn.winReason, 'territory');
  assert.equal(evOn.filter(e => e.type === 'victory' && e.reason === 'territory').length, 1);
});

test('QA-01 economy 线：关=不触发；开=触发（winReason=economy）', () => {
  const mk = (w) => {
    const p1 = w.addPlayer(1, 'P1');
    const p2 = w.addPlayer(2, 'P2');
    p1.score = 900; p2.score = 100; p1.regionsOwned = 12; p1.era = 4; p1.scoreLeadTicks = 1799;
    return p1;
  };
  const off = freshWorld(103, { victoryLines: ALL_OFF });
  const pOff = mk(off);
  off._checkVictoryConditions([]);   // 关闭 → 不推进/清零
  assert.equal(pOff.won, false, '经济线关闭时不得胜');

  const on = freshWorld(104, { victoryLines: { ...ALL_OFF, economy: true } });
  const pOn = mk(on);
  on._checkVictoryConditions([]);    // 1799 -> 1800
  on._checkVictoryConditions([]);    // 达标
  assert.equal(pOn.won, true, '经济线开启 + 持续达标 → 胜');
  assert.equal(pOn.winReason, 'economy');
});

test('QA-01 singularity 线：关=不触发；开=触发（winReason=singularity）', () => {
  const mk = (w) => {
    const p = w.addPlayer(1, 'P');
    p._stock = { wood: 35, stone: 35, ore: 35, crystal: 35, food: 35, shard: 35 };
    return p;
  };
  const off = freshWorld(105, { victoryLines: ALL_OFF });
  const pOff = mk(off);
  off._checkVictoryConditions([]);
  assert.equal(pOff.won, false, '采集线关闭时不得胜');

  const on = freshWorld(106, { victoryLines: { ...ALL_OFF, singularity: true } });
  const pOn = mk(on);
  on._checkVictoryConditions([]);
  assert.equal(pOn.won, true, '采集线开启 + 六资源达标 → 胜');
  assert.equal(pOn.winReason, 'singularity');
});

test('QA-01 survival 线：关=不触发；开=触发（winReason=survival）', () => {
  const mk = (w) => {
    const p1 = w.addPlayer(1, 'P1');
    const p2 = w.addPlayer(2, 'P2');
    p2.lost = true;   // 只剩 p1
    return p1;
  };
  const off = freshWorld(107, { victoryLines: ALL_OFF });
  const pOff = mk(off);
  const evOff = [];
  off._checkVictoryConditions(evOff);
  assert.equal(pOff.won, false, '生存线关闭时，最后一人不自动胜');
  assert.equal(evOff.filter(e => e.type === 'victory').length, 0);

  const on = freshWorld(108, { victoryLines: { ...ALL_OFF, survival: true } });
  const pOn = mk(on);
  const evOn = [];
  on._checkVictoryConditions(evOn);
  assert.equal(pOn.won, true, '生存线开启 + 只剩一人 → 胜');
  assert.equal(pOn.winReason, 'survival');
  assert.equal(evOn.filter(e => e.type === 'victory' && e.reason === 'survival').length, 1);
});

// ============================================================ QA-02 默认值（只开 territory）
test('QA-02 不传 victoryLines：rts 默认只开 territory，其余三线构造成立也不胜', () => {
  // a) 默认 World：victoryLines 精确等于仅 territory
  const w = freshWorld(201);   // 不传 victoryLines
  assert.deepEqual(w.victoryLines,
    { territory: true, economy: false, singularity: false, survival: false }, '默认仅 territory');

  // b) singularity 条件成立 → 不该胜（默认关闭）
  const ws = freshWorld(202);
  const ps = ws.addPlayer(1, 'P');
  ps._stock = { wood: 99, stone: 99, ore: 99, crystal: 99, food: 99, shard: 99 };
  ws._checkVictoryConditions([]);
  assert.equal(ps.won, false, '默认（不传）下采集线不生效');

  // c) economy 条件成立 → 不该胜。
  //    注意：必须让领土条件**不**成立（regionsOwned 恰好 10，未达 territory 的 16），
  //    否则会因默认开启的 territory 线获胜，掩盖对 economy 的验证。
  const we = freshWorld(203);
  const pe1 = we.addPlayer(1, 'P1'); const pe2 = we.addPlayer(2, 'P2');
  pe1.score = 5000; pe2.score = 0; pe1.regionsOwned = 10; pe1.era = 5; pe1.scoreLeadTicks = 5000;
  we._checkVictoryConditions([]);
  assert.equal(pe1.won, false, '默认（不传）下经济线不生效（regionsOwned=10 未误触 territory）');

  // d) survival 条件成立（只剩一人）→ 不该胜
  const wv = freshWorld(204);
  const pv1 = wv.addPlayer(1, 'P1'); const pv2 = wv.addPlayer(2, 'P2');
  pv2.lost = true;
  wv._checkVictoryConditions([]);
  assert.equal(pv1.won, false, '默认（不传）下生存线不生效');
});

test('QA-02 不传 victoryLines：go 默认只开 territory（availableLines 仅 1 条）', () => {
  const g = seatedGo(205);   // 不传 victoryLines
  assert.deepEqual(g.victoryLines,
    { territory: true, economy: false, singularity: false, survival: false }, 'go 默认仅 territory');
  assert.deepEqual(g.snapshot().settings.availableLines, ['territory']);
});

// ============================================================ QA-03 go 模式门禁（强传非法线）
test('QA-03 go 房强传 {singularity:true} 等非法线 → 归一归零且 World 不生效、判负不触发', () => {
  // 强传 singularity+economy+survival
  const g = new World('qaGate' + (seq++), 1, 1, {
    mode: 'go',
    victoryLines: { territory: true, economy: true, singularity: true, survival: true },
  });
  assert.deepEqual(g.victoryLines,
    { territory: true, economy: false, singularity: false, survival: false }, 'go 强制归零非法线');

  // 即便构造 singularity 成立的 rts 条件，go 世界也不会因此判胜（且 go 世界不跑 _checkVictoryConditions 的越权分支）
  const p = g.addPlayer(1, 'P');
  p._stock = { wood: 99, stone: 99, ore: 99, crystal: 99, food: 99, shard: 99 };
  const ev = [];
  g._checkVictoryConditions(ev);
  assert.equal(p.won, false, 'go 下采集线被强制关闭，不得由此判胜');
  assert.equal(ev.filter(e => e.type === 'victory').length, 0);
});

// ============================================================ QA-04 【重点】吃光不判胜
test('QA-04 2 人局一方被全部提光、盘面全空 → winner=null（0:0 平局），非幸存者无条件胜', () => {
  const w = seatedGo(401);
  clearLife(w);   // 盘面全空：双方子数都是 0
  const pB = w.players[w.go.blackId];
  pB.maxLifeCells = 6;   // 曾建立规模
  pB.lifeCells = 0;      // 被吃光
  const ev = [];
  w.applyGoIntent(w.go.seats[w.go.turnIdx], { pass: true }, ev);   // 黑已 lost，触发 wiped → 终局
  assert.ok(w.go.result, 'wiped 应触发终局');
  assert.equal(w.go.result.reason, 'wiped');
  assert.equal(pB.lost, true);
  // 关键断言：幸存者（白）盘面 0 子，数子同为 0 → 平局，而非"白无条件胜"
  assert.equal(w.go.result.winner, null, '盘面全空 → 0:0 平局，winner=null');
  assert.equal(w.players[w.go.whiteId].won, false, '幸存者不得被无条件判胜');
  assert.equal(w.players[w.go.blackId].won, false);
});

test('QA-04 一方被吃光但幸存者盘面有子且更高分 → 数子高者胜（不多不少，就是数子）', () => {
  const w = seatedGo(402);
  const L = clearLife(w);
  // 白有 5 子且围住一个空点（4 邻全白）→ white = 6；黑 0 子 → black = 0
  L[3][3] = 0; L[2][3] = w.go.whiteF; L[4][3] = w.go.whiteF; L[3][2] = w.go.whiteF; L[3][4] = w.go.whiteF;
  L[10][10] = w.go.whiteF;
  const pB = w.players[w.go.blackId];
  pB.maxLifeCells = 6; pB.lifeCells = 0;
  const ev = [];
  w.applyGoIntent(w.go.seats[w.go.turnIdx], { pass: true }, ev);
  assert.equal(w.go.result.reason, 'wiped');
  assert.ok(w.go.result.whiteScore > w.go.result.blackScore, '白数子应领先');
  assert.equal(w.go.result.winner, w.go.whiteId, '数子高者（白）胜——结果来自数子，而非旧"清盘者对手无条件胜"');
});

test('QA-04 被吃光方即使 0 子也不会"反超"：wiped 方数子恒计入池但分数为 0', () => {
  const w = seatedGo(403);
  const L = clearLife(w);
  L[15][15] = w.go.whiteF;  // 白 1 子
  const pB = w.players[w.go.blackId];
  pB.maxLifeCells = 5; pB.lifeCells = 0;
  const ev = [];
  w.applyGoIntent(w.go.seats[w.go.turnIdx], { pass: true }, ev);
  const rankedB = w.go.result.ranked.find(r => r.playerId === w.go.blackId);
  assert.ok(rankedB, '被吃光方应保留在 ranked（供平局判定的池）');
  assert.equal(rankedB.score, 0, '被吃光方数子 = 0，不可能反超');
  assert.equal(w.go.result.winner, w.go.whiteId);
});

// ============================================================ QA-05 数子法正确性（手算）
test('QA-05 数子法：子数 + 单侧围空 —— 手算期望 vs _goScoreChinese', () => {
  const w = seatedGo(501);
  const L = clearLife(w);
  const B = w.go.blackF, W = w.go.whiteF;
  // 黑墙围出一个 (5,5) 单格空区：上下左右全是黑
  L[4][5] = B; L[6][5] = B; L[5][4] = B; L[5][6] = B;
  // 黑再加 3 颗孤立子
  L[1][1] = B; L[30][30] = B; L[16][16] = B;
  // 白放 2 颗相邻子
  L[20][20] = W; L[21][20] = W;
  const sc = w._goScoreChinese();
  // 手算：黑子数 = 4(围) + 3(孤) = 7；黑围空 = 1
  assert.equal(sc.stoneByF[B], 7, '黑子数 = 7');
  assert.equal(sc.emptyByF[B], 1, '黑围空 = 1 (5,5)');
  assert.equal(sc.byF[B], 8, '黑总分 = 7 + 1 = 8');
  // 白子数 = 2；外围大空区同时接触黑白 → 中立 → 白围空 = 0
  assert.equal(sc.stoneByF[W], 2, '白子数 = 2');
  assert.equal(sc.emptyByF[W] || 0, 0, '大空区接触双色 → 白无围空');
  assert.equal(sc.byF[W], 2, '白总分 = 2');
  assert.equal(sc.black, 8); assert.equal(sc.white, 2);
});

test('QA-05 数子法边界：被双方接触的空区必须中立（不计给任一方）', () => {
  const w = seatedGo(502);
  const L = clearLife(w);
  const B = w.go.blackF, W = w.go.whiteF;
  // 黑白对角相邻，中间连通空区同时接触两色 → 中立
  L[10][10] = B; L[11][11] = W;
  const sc = w._goScoreChinese();
  assert.equal(sc.emptyByF[B] || 0, 0, '双色接触的空区不给黑');
  assert.equal(sc.emptyByF[W] || 0, 0, '双色接触的空区不给白');
  assert.equal(sc.byF[B], 1, '黑仅 1 子');
  assert.equal(sc.byF[W], 1, '白仅 1 子');
});

test('QA-05 数子法边界：棋盘边缘外不算归属（边上开口的空区不得归该色）', () => {
  const w = seatedGo(503);
  const L = clearLife(w);
  const B = w.go.blackF, W = w.go.whiteF;
  // 黑围三面 (0,0) 角：右 (1,0) 与下 (0,1) 是黑，左/上越界 → 开口朝棋盘外
  // 按设计：越界不计归属，但空区 (0,0) 的 4-邻里 (1,0)/(0,1) 都是黑 → 空区仍接触单色黑 → 归黑。
  // 关键反例：单独一颗黑紧贴角落，其"内侧"空区不能因棋盘边被算作围住。
  L[0][0] = B;
  L[1][1] = W;   // 让 (1,1) 之外的空区接触两色
  const sc = w._goScoreChinese();
  // 黑子 1、白子 1；除 (0,0)/(1,1) 外的空区连通且同时接触黑白 → 中立
  assert.equal(sc.stoneByF[B], 1);
  assert.equal(sc.stoneByF[W], 1);
  assert.equal(sc.emptyByF[B] || 0, 0, '既不是单侧围住（接触双色）→ 不归黑');
  assert.equal(sc.emptyByF[W] || 0, 0, '同上 → 不归白');
  assert.equal(sc.byF[B], 1); assert.equal(sc.byF[W], 1);
});

test('QA-05 数子法边界：单色独占整盘时全部空点归该色（单侧围住）', () => {
  const w = seatedGo(504);
  const L = clearLife(w);
  const B = w.go.blackF;
  L[16][16] = B;   // 仅黑一子，其余全空 → 空区只接触黑 → 全归黑
  const sc = w._goScoreChinese();
  assert.equal(sc.stoneByF[B], 1);
  assert.equal(sc.emptyByF[B], 32 * 32 - 1, '整盘空点归唯一色');
  assert.equal(sc.byF[B], 32 * 32, '黑总分 = 整盘');
});

// ============================================================ QA-06 不贴子（无 komi）
test('QA-06 不贴子：完全对称盘面双方等分 → 平局（黑先不加分）', () => {
  const w = seatedGo(601);
  const L = clearLife(w);
  const B = w.go.blackF, W = w.go.whiteF;
  // 两块对称 2x2，距离同源；空区接触双色 → 中立
  L[3][3] = B; L[4][3] = B; L[3][4] = B; L[4][4] = B;
  L[27][27] = W; L[26][27] = W; L[27][26] = W; L[26][26] = W;
  const ev = [];
  w.applyGoIntent(w.go.seats[w.go.turnIdx], { pass: true }, ev);
  w.applyGoIntent(w.go.seats[w.go.turnIdx], { pass: true }, ev);
  assert.ok(w.go.result);
  assert.equal(w.go.result.blackScore, w.go.result.whiteScore, '对称盘面数子相等');
  assert.equal(w.go.result.winner, null, '相等即平局（无 komi 补偿，黑先不白送分）');
});

test('QA-06 不贴子：空盘终局 0:0（黑先无补偿）', () => {
  const w = seatedGo(602);
  clearLife(w);
  const ev = [];
  w.applyGoIntent(w.go.seats[w.go.turnIdx], { pass: true }, ev);
  w.applyGoIntent(w.go.seats[w.go.turnIdx], { pass: true }, ev);
  assert.equal(w.go.result.blackScore, 0);
  assert.equal(w.go.result.whiteScore, 0);
  assert.equal(w.go.result.winner, null, '空盘 → 0:0 平局（不存在黑贴子使黑负的逻辑）');
});

// ============================================================ QA-07 门槛可配
test('QA-07 territoryRegions 门槛：调高不达标不胜、调低即胜', () => {
  const base = { ...ALL_OFF, territory: true };
  // 门槛 40：20 区 + era 3 不达标
  const hi = freshWorld(701, { victoryLines: base, victoryThresholds: { territoryRegions: 40 } });
  const pHi = hi.addPlayer(1, 'P'); pHi.era = 3; pHi.regionsOwned = 20;
  hi._checkVictoryConditions([]);
  assert.equal(pHi.won, false, '门槛 40，20 区不达标');
  // 门槛 6：同 20 区达标
  const lo = freshWorld(702, { victoryLines: base, victoryThresholds: { territoryRegions: 6 } });
  const pLo = lo.addPlayer(1, 'P'); pLo.era = 3; pLo.regionsOwned = 20;
  lo._checkVictoryConditions([]);
  assert.equal(pLo.won, true, '门槛 6，20 区达标即胜');
});

test('QA-07 singularityThreshold 门槛：调高不达标不胜、调低即胜', () => {
  const base = { ...ALL_OFF, singularity: true };
  // 门槛 200：六资源各 50 不达标
  const hi = freshWorld(703, { victoryLines: base, victoryThresholds: { singularityThreshold: 200 } });
  const pHi = hi.addPlayer(1, 'P');
  pHi._stock = { wood: 50, stone: 50, ore: 50, crystal: 50, food: 50, shard: 50 };
  hi._checkVictoryConditions([]);
  assert.equal(pHi.won, false, '门槛 200，各 50 不达标');
  // 门槛 6：各 50 达标
  const lo = freshWorld(704, { victoryLines: base, victoryThresholds: { singularityThreshold: 6 } });
  const pLo = lo.addPlayer(1, 'P');
  pLo._stock = { wood: 50, stone: 50, ore: 50, crystal: 50, food: 50, shard: 50 };
  lo._checkVictoryConditions([]);
  assert.equal(pLo.won, true, '门槛 6，各 50 达标即胜');
});

// ============================================================ QA-08 economy 攒条清零
test('QA-08 economy 中途关掉再打开 → 累计清零，不"一开即胜"', () => {
  const w = freshWorld(801, { victoryLines: { ...ALL_OFF, economy: true } });
  const p1 = w.addPlayer(1, 'P1');
  const p2 = w.addPlayer(2, 'P2');
  p1.score = 900; p2.score = 0; p1.regionsOwned = 12; p1.era = 3;
  // 攒条到 1799（差 1 tick 达标）
  for (let i = 0; i < 1799; i++) w._checkVictoryConditions([]);
  assert.equal(p1.scoreLeadTicks, 1799, '已攒 1799');
  assert.equal(p1.won, false);
  // 中途关掉 economy → 应清零
  w.victoryLines = { ...ALL_OFF, economy: false };
  w._checkVictoryConditions([]);
  assert.equal(p1.scoreLeadTicks, 0, '关线应清零累计计数器');
  // 再打开 → 从 0 重新累计，1 tick 不足以达标
  w.victoryLines = { ...ALL_OFF, economy: true };
  w._checkVictoryConditions([]);
  assert.equal(p1.scoreLeadTicks, 1, '重开后从头累计');
  assert.equal(p1.won, false, '重开后不得"一开即胜"');
});

// ============================================================ QA-09 全关
test('QA-09 rts 4 线全关：不发 victory、不崩（条件全成立亦然）', () => {
  const w = freshWorld(901, { victoryLines: ALL_OFF });
  const p = w.addPlayer(1, 'P');
  const p2 = w.addPlayer(2, 'P2');
  p.era = 5; p.regionsOwned = 40;
  p._stock = { wood: 999, stone: 999, ore: 999, crystal: 999, food: 999, shard: 999 };
  p.score = 9999; p.scoreLeadTicks = 99999;
  p2.lost = true;
  const ev = [];
  assert.doesNotThrow(() => w._checkVictoryConditions(ev), '全关不应抛错');
  assert.equal(ev.filter(e => e.type === 'victory').length, 0, '全关不发任何 victory');
  assert.equal(p.won, false, '全关不产生胜者');
});

test('QA-09 go 关 territory → 终局 winner=null（仅出明细）', () => {
  const w = seatedGo(902, { victoryLines: { territory: false } });
  const L = clearLife(w);
  L[3][3] = w.go.blackF; L[4][3] = w.go.blackF; L[3][4] = w.go.blackF; L[4][4] = w.go.blackF;
  L[20][20] = w.go.whiteF;
  const ev = [];
  w.applyGoIntent(w.go.seats[w.go.turnIdx], { pass: true }, ev);
  w.applyGoIntent(w.go.seats[w.go.turnIdx], { pass: true }, ev);
  assert.ok(w.go.result, '仍会终局');
  assert.equal(w.go.result.reason, 'pass');
  assert.equal(w.go.result.winner, null, '关 territory → 不宣告胜者');
  assert.equal(w.players[w.go.blackId].won, false);
  assert.equal(w.players[w.go.whiteId].won, false);
  assert.ok(Array.isArray(w.go.result.ranked) && w.go.result.ranked.length > 0, '仍出数子明细');
});

// ============================================================ QA-10 PATCH /rooms/:code/settings
test('QA-10 非房主 PATCH → 403 not_host（含未建世界的房）', async () => {
  const app = await setupApp();
  const host = newUser('host');
  const guest = newUser('guest');
  const r = await call(app, 'POST', '/api/rooms', { name: 'qa权限房', maxPlayers: 4, mode: 'rts' }, host.token);
  assert.equal(r.body.code, 0);
  const code = r.body.data.code;
  const deny = await call(app, 'PATCH', `/api/rooms/${code}/settings`, { victoryLines: { economy: true } }, guest.token);
  assert.equal(deny.body.code, 403);
  assert.equal(deny.body.message, 'not_host');
});

test('QA-10 房主 PATCH → roomInfo + snapshot 双同步（真实 HTTP）', async () => {
  const app = await setupApp();
  const host = newUser('host');
  const r = await call(app, 'POST', '/api/rooms', { name: 'qa同步房', maxPlayers: 4, mode: 'rts' }, host.token);
  const code = r.body.data.code;
  const wRes = await call(app, 'POST', `/api/rooms/${code}/world`, { mode: 'rts', seed: 11 }, host.token);
  assert.equal(wRes.body.code, 0);
  const worldId = wRes.body.data.worldId;

  const ok = await call(app, 'PATCH', `/api/rooms/${code}/settings`,
    { victoryLines: { territory: false, economy: true }, victoryThresholds: { territoryRegions: 8 } }, host.token);
  assert.equal(ok.body.code, 0);

  // 1) 世界快照同步
  const snap = activeWorlds.get(worldId).snapshot().settings;
  assert.deepEqual(snap.victoryLines, { territory: false, economy: true, singularity: false, survival: false });
  assert.equal(snap.victoryThresholds.territoryRegions, 8);

  // 2) roomInfo 同步
  const info = await call(app, 'GET', `/api/rooms/${code}`, null, host.token);
  assert.deepEqual(info.body.data.victoryLines, { territory: false, economy: true, singularity: false, survival: false });
  assert.equal(info.body.data.victoryThresholds.territoryRegions, 8);
  assert.deepEqual(info.body.data.availableLines, ['territory', 'economy', 'singularity', 'survival']);

  // 3) 响应体也反映
  assert.deepEqual(ok.body.data.victoryLines, { territory: false, economy: true, singularity: false, survival: false });
  assert.equal(ok.body.data.victoryThresholds.territoryRegions, 8);
});

test('QA-10 go 房主 PATCH 强传非法线 → 归一归零、GET roomInfo 一致', async () => {
  const app = await setupApp();
  const host = newUser('host');
  const r = await call(app, 'POST', '/api/rooms', { name: 'qa go改配', maxPlayers: 4, mode: 'go' }, host.token);
  const code = r.body.data.code;
  const ok = await call(app, 'PATCH', `/api/rooms/${code}/settings`,
    { victoryLines: { territory: true, economy: true, survival: true, singularity: true } }, host.token);
  assert.equal(ok.body.code, 0);
  assert.deepEqual(ok.body.data.victoryLines,
    { territory: true, economy: false, singularity: false, survival: false }, 'go 强制归零');
  const info = await call(app, 'GET', `/api/rooms/${code}`, null, host.token);
  assert.deepEqual(info.body.data.victoryLines,
    { territory: true, economy: false, singularity: false, survival: false });
  assert.deepEqual(info.body.data.availableLines, ['territory']);
  assert.equal(getRoom(code).mode, 'go');
});

// ============================================================ QA-11 确定性守卫
test('QA-11 go.js 无 Math.random / Date.now；engine.js 模拟路径无 Math.random', () => {
  // 只检查**代码**（剔除注释行），避免误伤文档里对 "禁 Math.random" 的引用。
  const codeLines = (src) => src.split('\n').filter((ln) => {
    const t = ln.trim();
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  }).join('\n');
  const go = codeLines(fs.readFileSync(new URL('../server/go.js', import.meta.url), 'utf8'));
  assert.equal(/Math\.random/.test(go), false, 'go.js 代码中禁 Math.random');
  assert.equal(/Date\.now/.test(go), false, 'go.js 代码中禁 Date.now');
  const ai = codeLines(fs.readFileSync(new URL('../server/ai.js', import.meta.url), 'utf8'));
  assert.equal(/Math\.random/.test(ai), false, 'ai.js 代码中禁 Math.random');
  // engine.js：Math.random 一律禁止（Date.now 仅用于时间戳/计时，非模拟随机，允许）
  const eng = codeLines(fs.readFileSync(new URL('../server/engine.js', import.meta.url), 'utf8'));
  assert.equal(/Math\.random/.test(eng), false, 'engine.js 代码中禁 Math.random');
});

test('QA-11 同 seed 两个 go 世界：数子结果一致（未改种子流）', () => {
  const a = seatedGo(1101);
  const b = seatedGo(1101);
  for (const w of [a, b]) {
    const L = clearLife(w);
    L[3][3] = w.go.blackF; L[4][3] = w.go.blackF; L[25][25] = w.go.whiteF;
  }
  const sa = a._goScoreChinese();
  const sb = b._goScoreChinese();
  assert.deepEqual(sa.byF, sb.byF, '同盘面数子一致');
  assert.equal(sa.black, sb.black); assert.equal(sa.white, sb.white);
});

// ============================================================ QA-12 追加攻击面（回归发现）
test('QA-12 认输方被剔除胜负池：即使盘面子多也不得被判胜', () => {
  const w = seatedGo(1201);
  const L = clearLife(w);
  // 黑子明显更多，但黑主动认输 → 黑绝不应胜
  for (let i = 0; i < 12; i++) L[i][0] = w.go.blackF;
  L[20][20] = w.go.whiteF;
  const ev = [];
  const res = w.applyGoIntent(w.go.blackId, { resign: true }, ev);
  assert.equal(res.ok, true);
  assert.equal(w.go.result.reason, 'resign');
  assert.equal(w.go.result.winner, w.go.whiteId, '认输方被剔除，对手胜');
  assert.equal(w.players[w.go.blackId].won, false, '认输方不得胜');
  // 认输方不应出现在 ranked 池
  assert.equal(w.go.result.ranked.some(r => r.playerId === w.go.blackId), false, '认输方不入池');
});

test('QA-12 特征化：双方散点、空区连通且接触双色 → 绝大多数空点中立（口径已知，非 Bug）', () => {
  // 记录并锁定架构 A11 的"≥2 阵营接触即中立"保守口径：
  // 在 32x32 双方散点的真实局面里，围空几乎恒为 0，胜负≈子数之差。
  // 该断言是**特征化（characterization）**：固化当前设计，若将来口径变更必须显式更新。
  const w = seatedGo(1202);
  const L = clearLife(w);
  const B = w.go.blackF, W = w.go.whiteF;
  for (let y = 2; y < 30; y += 3) { L[5][y] = B; L[8][y] = B; L[11][y] = B; }
  for (let y = 2; y < 30; y += 3) { L[21][y] = W; L[24][y] = W; L[27][y] = W; }
  const sc = w._goScoreChinese();
  assert.equal(sc.emptyByF[B] || 0, 0, '散点局面下黑无围空（空区接触双色→中立）');
  assert.equal(sc.emptyByF[W] || 0, 0, '散点局面下白无围空');
  assert.equal(sc.byF[B], sc.stoneByF[B], '黑总分 = 子数（无围空加分）');
  assert.equal(sc.byF[W], sc.stoneByF[W], '白总分 = 子数');
});
