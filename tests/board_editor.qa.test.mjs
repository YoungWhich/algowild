// tests/board_editor.qa.test.mjs — 独立 QA 验证（可编辑棋盘 · 形状 + 虚空格）
//
// 本文件由 QA（Edward）独立编写，**不复跑** board_editor.test.mjs 的用例（BE-01~BE-17），
// 而是定向攻击工程师自测不一定覆盖的边界与回归点：
//   QA-REG-1/2  默认零变化（深度回归）：board=null 与 rect(32×32) 同种子对局逐字节等价
//   QA-NORM-1/2/3/4  normBoard 三态归一边界（0/101/负数/小数/非数字/字符串、行数列数不符、全空/全虚空、board=null 带 w/h、预设尺寸钳制）
//   QA-GO-1/2/3/4/5  虚空=墙 的围棋语义（气不计入虚空、阻断空区连通、墙格永不诞生、虚空落子拒 oob、终局 winReason='go'）
//   QA-LOCK-1/2/3    已开局服务端强制 403 board_locked（rts/go）+ 不可变性；未开局可改/可重置
//   QA-AI-1/2/3      go AI 适配非矩形棋盘（全落在可落子格、不退化 pass、空盘天元不过墙）
//   QA-SPAWN-1/2/3   rts 出生点形状感知（随机/自选虚空回退/自选合法）
//   QA-DET-1/2/3     确定性（islands 同 seed 同形、_genIslands 确定性、go.js/ai.js/engine 棋盘区禁 Math.random/Date.now）
//   QA-SNAP-1/2      快照下发（settings.board 每帧 + boardMap 紧凑串，含 100×100 大小隐患）
//   QA-PRESET-1/2/3  6 模板合法且解码仅含 0/1/2、极端尺寸不抛错
//   QA-RTS-VOID-1/2/3 rts 虚空语义：形状外=墙（生效）；虚空与 go 统一被当墙（PRD#7 分期"rts 虚空不生效"待确认，见报告 RISK-1）
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createRouter } from '../server/routes.js';
import { signToken } from '../server/auth.js';
import { initDB, usersRepo } from '../server/db/index.js';
import { World, loadKernels } from '../server/engine.js';
import { normBoard } from '../server/rooms.js';
import { goAIMove } from '../server/ai.js';

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
function newUser(prefix = 'qa') {
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
function seatedGo(seed = 42, opts) {
  const w = new World('qaGo' + seed + '_' + (seq++), 1, seed, Object.assign({ mode: 'go' }, opts || {}));
  w._skipAIFill = true;
  w.addPlayer(1, 'Black');
  w.addPlayer(2, 'White');
  w._goInit();
  return w;
}
function mkBoard(w, h, shape) { return { w, h, shape }; }
// 驱动一个 AI 对 AI 的 go 对局（同种子确定性由 board 状态保证），返回 pass 次数与落在墙格的着法
function simGo(world, turns, doEvolve) {
  const g = world._goInit();
  let passes = 0;
  const bad = [];
  for (let t = 0; t < turns; t++) {
    const f = g.turn;
    const mv = goAIMove(world, f);
    if (mv && mv.moves && mv.moves.length) {
      for (const m of mv.moves) if (world._isWall(m.lx, m.ly)) bad.push(m);
      const r = world._goPlayBatch(f, mv.moves, []);
      if (r.ok) { passes = 0; g.passStreak = 0; }
      else { passes++; g.passStreak = (g.passStreak || 0) + 1; }
    } else {
      passes++; g.passStreak = (g.passStreak || 0) + 1;
    }
    if (doEvolve) world._goEvolve(0);
    g.turnIdx = (g.turnIdx + 1) % g.seatF.length;
    g.turn = g.seatF[g.turnIdx];
    if (passes >= g.seatF.length) break;
  }
  return { passes, bad, g };
}

// ============================================================ QA-REG-1/2 默认零变化（深度回归）
test('QA-REG-1 board=null 与 rect(32×32) 的 go 局逐字节等价（同种子）', () => {
  const rect = World.presetBoard('rect', 32, 32, 1).shape;
  const a = seatedGo(777, {});                                  // 不传 board
  const b = seatedGo(777, { board: mkBoard(32, 32, rect) });    // 显式 32×32 全可落子
  simGo(a, 40, true);
  simGo(b, 40, true);
  for (let x = 0; x < World.LIFE_W; x++) {
    for (let y = 0; y < World.LIFE_W; y++) {
      assert.equal(a._life[x][y], b._life[x][y], `life(${x},${y}) 逐字节等价`);
    }
  }
  const sa = a._goScoreChinese(), sb = b._goScoreChinese();
  assert.equal(sa.black, sb.black, '黑方目数等价');
  assert.equal(sa.white, sb.white, '白方目数等价');
});

test('QA-REG-2 board=null 与 rect(32×32) 的 rts 世界逐字节等价（地形/资源/生命）', () => {
  const rect = World.presetBoard('rect', 32, 32, 1).shape;
  const a = freshWorld(777, { mode: 'rts' });
  const b = freshWorld(777, { mode: 'rts', board: mkBoard(32, 32, rect) });
  for (let x = 0; x < 192; x++) {
    for (let y = 0; y < 192; y++) {
      assert.equal(a.terrain[x][y], b.terrain[x][y], `terrain(${x},${y}) 等价`);
      assert.equal(a.resources[x][y], b.resources[x][y], `resources(${x},${y}) 等价`);
    }
  }
  a._lifeInit(); b._lifeInit();
  for (let i = 0; i < 5; i++) { a._lifeStep(); b._lifeStep(); }
  for (let x = 0; x < World.LIFE_W; x++) {
    for (let y = 0; y < World.LIFE_W; y++) {
      assert.equal(a._life[x][y], b._life[x][y], `life(${x},${y}) 等价`);
    }
  }
});

// ============================================================ QA-NORM-1/2/3/4 三态归一边界
test('QA-NORM-1 normBoard：w/h 为 0/101/负数/小数/非数字 时钳制或拒绝', () => {
  assert.equal(normBoard(mkBoard(0, 4, '####/####/####/####'), 'rts'), null, 'w=0 拒绝（列数与钳后宽不符）');
  assert.equal(normBoard(mkBoard(4, 0, '####/####/####/####'), 'rts'), null, 'h=0 拒绝');
  // 超上限 101：钳到 100，但与 shape 列数不符 → 拒绝
  assert.equal(normBoard(mkBoard(101, 1, '#'.repeat(101)), 'rts'), null, 'w=101 与列数不符→拒绝');
  assert.equal(normBoard(mkBoard(1, 101, '###########'), 'rts'), null, 'h=101 与行数不符→拒绝');
  // 负数 → 钳到最小 1（合法当 shape 匹配）
  const neg = normBoard(mkBoard(-5, 3, '#/#/#'), 'rts');
  assert.ok(neg, '负数 w 钳到 1 仍合法');
  assert.equal(neg.w, 1); assert.equal(neg.h, 3);
  // 小数 → 钳到 floor
  const flt = normBoard(mkBoard(2.5, 2.5, '##/##'), 'rts');
  assert.ok(flt, '小数 w 钳到 floor 仍合法');
  assert.equal(flt.w, 2); assert.equal(flt.h, 2);
  // 非数字字符串 w → 拒绝（列数与钳后宽不符）
  assert.equal(normBoard(mkBoard('abc', 2, '##/#.'), 'rts'), null, '字符串 w 拒绝');
});

test('QA-NORM-2 normBoard：行数/列数不符、全空/全虚空、非法字符宽容、非字符串 shape', () => {
  assert.equal(normBoard(mkBoard(2, 3, '##/#x'), 'rts'), null, '行数不足→拒绝');
  assert.equal(normBoard(mkBoard(2, 1, '##/#x'), 'rts'), null, '行数过多(多余行)→拒绝');
  assert.equal(normBoard(mkBoard(3, 2, '###/#x'), 'rts'), null, '列数不符→拒绝');
  assert.equal(normBoard(mkBoard(2, 2, '../x.'), 'rts'), null, '全形状外→拒绝');
  assert.equal(normBoard(mkBoard(2, 2, 'xx/xx'), 'rts'), null, '全虚空→拒绝');
  // 含非法字符：宽容视为形状外，但保留 # → 合法且 decode 映射为 0
  const bad = normBoard(mkBoard(3, 1, '#?x'), 'go');
  assert.ok(bad, '含非法字符仍可接受（宽容）');
  const bmp = World.decodeBoard(bad);
  assert.equal(bmp[0], 1); assert.equal(bmp[1], 0, '? → 形状外'); assert.equal(bmp[2], 2);
  // shape 为数字（非字符串）→ 拒绝
  assert.equal(normBoard(mkBoard(3, 3, 123), 'rts'), null, 'shape 为数字→拒绝');
});

test('QA-NORM-3 normBoard：board=null 但带 w/h → 忽略 w/h 回 null', () => {
  assert.equal(normBoard({ w: 10, h: 10 }, 'rts'), null, '无 shape → 回 null');
  assert.equal(normBoard({ w: 10, h: 10, shape: '' }, 'rts'), null, '空 shape → 回 null');
  assert.equal(normBoard({ w: 10, h: 10, shape: undefined }, 'rts'), null, 'shape=undefined → 回 null');
});

test('QA-NORM-4 presetBoard：尺寸钳制到 [1,100]（永不返回 null）', () => {
  assert.equal(World.presetBoard('rect', 200, 50, 1).w, 100, 'w 超上限钳到 100');
  assert.equal(World.presetBoard('rect', 100, 100, 1).w, 100, '100×100 合法');
  assert.equal(World.presetBoard('rect', 0, 10, 1).w, 1, 'w=0 钳到最小 1（presetBoard 不拒绝）');
  assert.equal(World.presetBoard('rect', 10, 200, 1).h, 100, 'h 超上限钳到 100');
  assert.equal(World.presetBoard('rect', -3, 5, 1).w, 1, '负数尺寸钳到 1（最小）');
  assert.equal(World.presetBoard('rect', 'abc', 5, 1).w, 1, '非数字尺寸钳到 1（presetBoard 不拒绝）');
});

// ============================================================ QA-GO-1/2/3/4/5 虚空=墙 的围棋语义
test('QA-GO-1 贴虚空的棋团气数：虚空不计入气', () => {
  const shape = '.x./#.#/...';                 // (1,0) 虚空
  const w = seatedGo(11, { board: mkBoard(3, 3, shape) });
  const L = w._life, B = w.go.blackF;
  for (let x = 0; x < 32; x++) for (let y = 0; y < 32; y++) L[x][y] = 0;
  L[1][1] = B;
  assert.equal(w._goLiberties(1, 1), 2, '虚空(1,0)与形状外(1,2)不计入气 → 仅左右 2 气');
  L[0][1] = B;                                  // 左邻被友军占
  assert.equal(w._goLiberties(1, 1), 1, '左邻被友军占 → 仅右 1 气');
});

test('QA-GO-2 虚空阻断空区连通：_goEnclosedEmpty 不穿越墙（被虚空隔成两区）', () => {
  // 5×5：外框虚空(x)；内部 (2,2) 为虚空，把上下两个空区隔开
  const shape = ['xxxxx', 'x###x', 'x#x#x', 'x###x', 'xxxxx'].join('/');
  const w = seatedGo(12, { board: mkBoard(5, 5, shape) });
  const L = w._life, B = w.go.blackF;
  for (let x = 0; x < 32; x++) for (let y = 0; y < 32; y++) L[x][y] = 0;
  // 仅外环放黑子，留出 (2,1) 与 (2,3) 两个空区，二者被 (2,2) 虚空隔开
  for (const [x, y] of [[1,1],[3,1],[1,2],[3,2],[1,3],[3,3]]) L[x][y] = B;
  const { byF } = w._goEnclosedEmpty();
  // (2,1) 与 (2,3) 各为被黑方包围的独立空区 → 共 2 格归属 blackF（虚空阻断连通，不可并）
  assert.equal(byF[B], 2, '两个被虚空隔开的空区各自归属 blackF（虚空阻断连通）');
  assert.equal(w._isWall(2, 2), true, '(2,2) 虚空为墙（不并入空区）');
});

test('QA-GO-3 墙格（虚空）永不诞生：相邻满 3 子仍 next=0', () => {
  const shape = '.x./#x#/#.#';                  // (1,1) 虚空（中心）
  const w = seatedGo(14, { board: mkBoard(3, 3, shape) });
  const L = w._life, B = w.go.blackF;
  for (let x = 0; x < 32; x++) for (let y = 0; y < 32; y++) L[x][y] = 0;
  L[0][1] = B; L[2][1] = B; L[1][2] = B;        // 3 个可落子邻格放子 → 满足诞生阈值 3
  w._goEvolveOnce(3);
  assert.equal(L[1][1], 0, '虚空格 (1,1) 演化后仍为 0（永不诞生）');
  for (let i = 0; i < 5; i++) w._goEvolveOnce(3);
  assert.equal(L[1][1], 0, '多轮后虚空格仍为 0');
});

test('QA-GO-4 虚空/形状外落子被拒 reason=oob；合规落子成功', () => {
  const shape = '###x###/#######/#######';
  const w = seatedGo(13, { board: mkBoard(7, 3, shape) });
  const B = w.go.blackF;
  assert.equal(w._goPlay(B, 3, 0, []).ok, false, '虚空落子应被拒');
  assert.equal(w._goPlay(B, 3, 0, []).reason, 'oob', 'reason=oob（复用越界码）');
  assert.equal(w._goPlay(B, 0, 5, []).ok, false, '形状外(越界)落子应被拒');
  assert.equal(w._goPlay(B, 0, 5, []).reason, 'oob');
  assert.equal(w._goPlay(B, 0, 0, []).ok, true, '合规可落子格落子成功');
});

test('QA-GO-5 终局 winReason 仍 "go"（不回归）', () => {
  const w = seatedGo(99, { board: mkBoard(5, 5, World.presetBoard('rect', 5, 5, 1).shape) });
  const white = Object.values(w.players).find((p) => p.id === 2);
  white.lost = true; white.lostReason = 'resign';
  w._goFinish('resign', []);                    // 仅剩黑方 → 黑方胜
  const black = w.players[1];
  assert.equal(black.won, true, '黑方胜');
  assert.equal(black.winReason, 'go', 'winReason 仍为 go');
});

// ============================================================ QA-LOCK-1/2/3 已开局服务端强制
test('QA-LOCK-1 已开局 rts 房 PATCH board → 403 board_locked 且 board 不变', async () => {
  const app = await setupApp();
  const u = newUser('host');
  const r = await call(app, 'POST', '/api/rooms', { mode: 'rts', maxPlayers: 4, visibility: 'public' }, u.token);
  const code = r.body.data.code;
  await call(app, 'POST', `/api/rooms/${code}/world`, { mode: 'rts' }, u.token);
  await call(app, 'POST', `/api/rooms/${code}/start`, {}, u.token);
  const patch = await call(app, 'PATCH', `/api/rooms/${code}/settings`,
    { board: mkBoard(4, 4, '####/####/####/####') }, u.token);
  assert.equal(patch.status, 200, 'HTTP 仍 200（业务码在 body）');
  assert.equal(patch.body.code, 403, '业务码 403');
  assert.equal(patch.body.message, 'board_locked', '错误码 board_locked');
  // 不可变性：回读 board 仍为 null（未被非法请求改写）
  const info = await call(app, 'GET', `/api/rooms/${code}`, null, u.token);
  assert.equal(info.body.data.board, null, '已开局改形状被拒 → board 仍为原值(null)');
});

test('QA-LOCK-2 已开局 go 房 PATCH board → 403 board_locked', async () => {
  const app = await setupApp();
  const u = newUser('hostg');
  const r = await call(app, 'POST', '/api/rooms', { mode: 'go', maxPlayers: 2, visibility: 'public' }, u.token);
  const code = r.body.data.code;
  await call(app, 'POST', `/api/rooms/${code}/world`, { mode: 'go' }, u.token);
  await call(app, 'POST', `/api/rooms/${code}/start`, {}, u.token);
  const patch = await call(app, 'PATCH', `/api/rooms/${code}/settings`,
    { board: mkBoard(5, 5, '#####/#xxx#/#x#x#/#xxx#/#####') }, u.token);
  assert.equal(patch.body.code, 403, 'go 已开局同样强制 403');
  assert.equal(patch.body.message, 'board_locked');
});

test('QA-LOCK-3 未开局房 PATCH board 成功；再传 board=null 重置默认', async () => {
  const app = await setupApp();
  const u = newUser('host3');
  const r = await call(app, 'POST', '/api/rooms', { mode: 'rts', maxPlayers: 4, visibility: 'public' }, u.token);
  const code = r.body.data.code;
  const board = mkBoard(6, 6, '######/#xxxx#/#x##x#/#x##x#/#xxxx#/######');
  const p1 = await call(app, 'PATCH', `/api/rooms/${code}/settings`, { board }, u.token);
  assert.equal(p1.body.code, 0, '未开局允许设形状');
  const p2 = await call(app, 'PATCH', `/api/rooms/${code}/settings`, { board: null }, u.token);
  assert.equal(p2.body.code, 0, '未开局允许 board=null 重置默认');
  const info = await call(app, 'GET', `/api/rooms/${code}`, null, u.token);
  assert.equal(info.body.data.board, null, '重置后 board=null');
});

// ============================================================ QA-AI-1/2/3 go AI 适配非矩形棋盘
test('QA-AI-1 非矩形 go（cross 32×32）AI 全落在可落子格且不退化 pass', () => {
  const p = World.presetBoard('cross', 32, 32, 1);
  const w = seatedGo(16, { board: { w: p.w, h: p.h, shape: p.shape } });
  const { passes, bad } = simGo(w, 40, false);
  assert.equal(bad.length, 0, 'AI 无任何落子落在墙格（虚空/形状外）');
  assert.equal(passes, 0, 'cross 棋盘 40 回合内 AI 不退化 pass');
});

test('QA-AI-2 矩形对照：AI 同样全在可落子格、0 pass（无虚空惩罚差异）', () => {
  const p = World.presetBoard('rect', 32, 32, 1);
  const w = seatedGo(16, { board: { w: p.w, h: p.h, shape: p.shape } });
  const { passes, bad } = simGo(w, 40, false);
  assert.equal(bad.length, 0, '矩形 AI 也无墙格落子');
  assert.equal(passes, 0, '矩形对照同为 0 pass（cross 不显著升高）');
});

test('QA-AI-3 空盘 cross 开局：天元偏移不过墙', () => {
  const p = World.presetBoard('cross', 32, 32, 1);
  const w = seatedGo(17, { board: { w: p.w, h: p.h, shape: p.shape } });
  const mv = goAIMove(w, w.go.blackF);          // 空盘 → 天元附近偏移
  assert.ok(mv && mv.moves && mv.moves.length > 0, '空盘有开局着法');
  for (const m of mv.moves) assert.ok(!w._isWall(m.lx, m.ly), `开局着 (${m.lx},${m.ly}) 不过墙`);
});

// ============================================================ QA-SPAWN-1/2/3 rts 出生点形状感知
test('QA-SPAWN-1 rts 随机出生点：形状仅小块可落子 → 全在可落子区', () => {
  const shape = [];
  for (let y = 0; y < 32; y++) { let row = ''; for (let x = 0; x < 32; x++) row += (x < 8 && y < 8) ? '#' : '.'; shape.push(row); }
  const w = freshWorld(17, { mode: 'rts', board: mkBoard(32, 32, shape.join('/')) });
  for (let i = 1; i <= 6; i++) w.addPlayer(i, 'P' + i);
  for (const p of Object.values(w.players)) {
    assert.ok(w._isPlayableWorld(p.x, p.y), `随机出生点 (${p.x},${p.y}) 可通行`);
    assert.ok(p.x < 48 && p.y < 48, '落在左上可落子区（生命格 8×8 → 世界 48×48）');
  }
});

test('QA-SPAWN-2 rts pick 传虚空格 → 回退随机（仍在可落子区）', () => {
  const shape = [];
  for (let y = 0; y < 32; y++) { let row = ''; for (let x = 0; x < 32; x++) row += (x < 8 && y < 8) ? '#' : (x === 10 && y === 10 ? 'x' : '.'); shape.push(row); }
  const w = freshWorld(18, { mode: 'rts', board: mkBoard(32, 32, shape.join('/')), spawnMode: 'pick', spawnXY: { x: 60, y: 60 } });
  w.addPlayer(1, 'P1');
  const p = Object.values(w.players)[0];
  assert.ok(w._isPlayableWorld(p.x, p.y), '回退随机后仍可通行');
  assert.notEqual(p.x, 60, '未落在虚空坐标');
  assert.equal(w._isWall(10, 10), true, '(10,10) 生命格确为虚空墙');
});

test('QA-SPAWN-3 rts pick 传合法坐标 → 落在指定格', () => {
  const shape = [];
  for (let y = 0; y < 32; y++) { let row = ''; for (let x = 0; x < 32; x++) row += (x < 8 && y < 8) ? '#' : '.'; shape.push(row); }
  const w = freshWorld(19, { mode: 'rts', board: mkBoard(32, 32, shape.join('/')), spawnMode: 'pick', spawnXY: { x: 30, y: 30 } });
  w.addPlayer(1, 'P1');
  const p = Object.values(w.players)[0];
  assert.equal(p.x, 30, '落在指定世界坐标 (30,30)');
  assert.equal(p.y, 30);
  assert.ok(w._isPlayableWorld(30, 30), '该坐标可通行');
});

// ============================================================ QA-DET-1/2/3 确定性
test('QA-DET-1 随机岛屿同 seed 同形、异 seed 不同', () => {
  const a = World.presetBoard('islands', 40, 40, 777).shape;
  const b = World.presetBoard('islands', 40, 40, 777).shape;
  assert.equal(a, b, '同 seed → 同形状');
  assert.notEqual(a, World.presetBoard('islands', 40, 40, 888).shape, '异 seed → 不同');
});

test('QA-DET-2 _genIslands 直接调用确定性（不依赖 Math.random）', () => {
  assert.deepEqual(World._genIslands(30, 30, 42), World._genIslands(30, 30, 42), '同 seed 逐格一致');
});

test('QA-DET-3 go.js/ai.js/engine 棋盘生成区禁 Math.random/Date.now', async () => {
  const fs = await import('node:fs');
  for (const f of ['server/go.js', 'server/ai.js']) {
    let src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/Math\.random\s*\(/.test(src), `${f} 不得含 Math.random()`);
    assert.ok(!/Date\.now\s*\(/.test(src), `${f} 不得含 Date.now()`);
  }
  const eng = fs.readFileSync('server/engine.js', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const boardRegion = eng.slice(eng.indexOf('可编辑棋盘'));
  assert.ok(!/Math\.random\s*\(/.test(boardRegion), 'engine 棋盘生成区不得含 Math.random()');
});

// ============================================================ QA-SNAP-1/2 快照下发
test('QA-SNAP-1 普通 board：settings.board 每帧携带，boardMap 为紧凑串', () => {
  const board = mkBoard(4, 4, '####/#xx#/#xx#/####');
  const w = freshWorld(19, { mode: 'rts', board });
  const s0 = w.snapshot();
  assert.deepEqual(s0.settings.board, board, 'settings.board 每帧携带');
  assert.ok(typeof s0.boardMap === 'string', 'boardMap 是串');
  assert.ok(!Array.isArray(s0.boardMap), 'boardMap 不是数组');
  assert.equal(s0.boardMap, board.shape, 'boardMap = shape 串');
  w.tick = 5; w._boardMapSentRev = w._boardRev;
  const s1 = w.snapshot();
  assert.equal(s1.boardMap, null, '无变更 → boardMap 不下发');
});

test('QA-SNAP-2 100×100 board：boardMap 紧凑串（非 100×100 数组），长度合理', () => {
  // 100×100 仅 go 模式合法（rts 生命层恒 32，棋盘上限 32 —— 见 board_size.test.mjs）。
  // 本用例验证的是「大尺寸下 boardMap 仍为紧凑串」这一与模式无关的机制。
  const board = mkBoard(100, 100, World.presetBoard('rect', 100, 100, 1).shape);
  const w = freshWorld(20, { mode: 'go', board });
  const s0 = w.snapshot();
  assert.deepEqual(s0.settings.board, board, 'settings.board 每帧携带');
  assert.ok(typeof s0.boardMap === 'string', 'boardMap 是串');
  assert.ok(!Array.isArray(s0.boardMap), 'boardMap 非嵌套数组（非 100×100 数组）');
  // 紧凑串长度 = w*h + (h-1) 分隔符 = 10000 + 99 = 10099
  assert.equal(s0.boardMap.length, 100 * 100 + (100 - 1), '紧凑串长度 = 100*100+99（约 10KB 增量，可接受）');
});

// ============================================================ QA-PRESET-1/2/3 预设模板
test('QA-PRESET-1 六模板解码仅含 0/1/2 且均有可落子格', () => {
  for (const k of ['rect', 'cross', 'castle', 'twins', 'ring', 'islands']) {
    const b = World.presetBoard(k, 24, 24, 12345);
    assert.ok(b, `${k} 生成成功`);
    const bmp = World.decodeBoard(b);
    let play = 0;
    for (const v of bmp) { assert.ok(v === 0 || v === 1 || v === 2, `${k} 仅含 0/1/2（无非法字符）`); if (v === 1) play++; }
    assert.ok(play > 0, `${k} 至少 1 个可落子格`);
  }
});

test('QA-PRESET-2 极端尺寸（1×1 / 100×100）合法且不抛错', () => {
  const a = World.presetBoard('rect', 1, 1, 1);
  assert.ok(a && a.w === 1 && a.h === 1, '1×1 合法');
  assert.equal(World.decodeBoard(a)[0], 1, '1×1 可落子');
  const b = World.presetBoard('rect', 100, 100, 1);
  assert.equal(b.w, 100);
  let play = 0; for (const v of World.decodeBoard(b)) if (v === 1) play++;
  assert.ok(play > 0, '100×100 可落子');
  assert.ok(World.presetBoard('ring', 100, 100, 1), 'ring 100×100 合法');
  assert.ok(World.presetBoard('castle', 100, 100, 1), 'castle 100×100 合法');
});

test('QA-PRESET-3 多尺寸生成均合法（形状感知无越界）', () => {
  for (const [w, h] of [[8, 8], [16, 16], [50, 50]]) {
    for (const k of ['rect', 'cross', 'castle', 'twins', 'ring', 'islands']) {
      const b = World.presetBoard(k, w, h, 7);
      assert.ok(b, `${k} ${w}×${h} 成功`);
      const bmp = World.decodeBoard(b);
      assert.equal(bmp.length, w * h, '位图长度 = w*h');
      let play = 0; for (const v of bmp) { assert.ok(v === 0 || v === 1 || v === 2); if (v === 1) play++; }
      assert.ok(play > 0, `${k} ${w}×${h} 有可落子`);
    }
  }
});

// ============================================================ QA-RTS-VOID-1/2/3 rts 虚空语义
test('QA-RTS-VOID-1 rts 模式：虚空(state=2) 与 go 统一被当墙（PRD#7 分期语义待确认）', () => {
  // 形状：左上 8×8 可落子；在 (10,10) 放一个真正的虚空（x），其余形状外
  const shape = [];
  for (let y = 0; y < 32; y++) { let row = ''; for (let x = 0; x < 32; x++) row += (x < 8 && y < 8) ? '#' : (x === 10 && y === 10 ? 'x' : '.'); shape.push(row); }
  const w = freshWorld(21, { mode: 'rts', board: mkBoard(32, 32, shape.join('/')) });
  // 事实行为（已验证）：引擎统一把虚空当墙，rts 与 go 无差异（void=2 → isWall）。
  // 这与 PRD#7 分期"rts 虚空本期不生效/不被当墙"的措辞存在落差 → 见报告 RISK-1。
  assert.equal(w._isWall(10, 10), true, '(10,10) 虚空为墙');
  assert.equal(w._isPlayableWorld(10 * 6, 10 * 6), false, 'rts 下虚空世界格不可通行（引擎统一语义）');
});

test('QA-RTS-VOID-2 rts 模式：形状外(state=0) 仍被当墙（裁外部形状生效）', () => {
  const shape = [];
  for (let y = 0; y < 32; y++) { let row = ''; for (let x = 0; x < 32; x++) row += (x < 8 && y < 8) ? '#' : '.'; shape.push(row); }
  const w = freshWorld(22, { mode: 'rts', board: mkBoard(32, 32, shape.join('/')) });
  assert.equal(w._isPlayableWorld(20 * 6, 20 * 6), false, 'rts 下形状外仍不可通行（裁剪生效）');
});

test('QA-RTS-VOID-3 go 模式：虚空被当墙（完整支持虚空格，与 rts 对照）', () => {
  const w = seatedGo(23, { board: mkBoard(7, 3, '###x###/#######/#######') });
  assert.equal(w._isPlayable(3, 0), false, 'go 模式虚空被当墙（完整支持）');
});
