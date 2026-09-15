// tests/board_editor.test.mjs — 可编辑棋盘（形状 + 虚空格）BE-01 ~ BE-22
//
// 覆盖：
//   BE-01/02  三态常量与 isWall 纯函数语义（越界 ∪ 形状外 ∪ 虚空 → 墙）
//   BE-03     默认零变化：board=null → 与现状矩形逐字节等价（不回归底线）
//   BE-04     位图编解码往返（encode/decode round-trip）
//   BE-05     normBoard 归一/钳制/拒绝（E1/E2/E3/E12）
//   BE-06     6 个预设模板（rect/cross/castle/twins/ring/islands）合法且形状各异
//   BE-07     随机岛屿确定性：同 seed 同形（禁 Math.random，IR-3a）
//   BE-08     虚空格阻断连通：go 气 / 提子（Q2=a 虚空=墙）
//   BE-09     虚空落子被拒（reason='oob'）
//   BE-10     _lifeStep/_goEvolveOnce：墙格永不诞生（next=0）
//   BE-11     go AI 绝不落到虚空/形状外（Q6=a）
//   BE-12     rts 出生点：自选 pick / 随机 random（形状感知）
//   BE-13     已开始房间锁定形状：PATCH 返回 code=403 board_locked（服务端强制，Q3=a）
//   BE-14     建房/建世界/房间信息透传 board
//   BE-15     snapshot：settings.board 每帧携带 + boardMap 低频
//   BE-16     rts 世界保持 192×192，位图叠加
//   BE-17     铁律 IR-3a：go.js/ai.js 不含 Math.random / Date.now（与 GM-17 同集合）
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createRouter } from '../server/routes.js';
import { signToken } from '../server/auth.js';
import { initDB, usersRepo, roomsRepo } from '../server/db/index.js';
import { World, loadKernels } from '../server/engine.js';
import { activeWorlds } from '../server/worldhub.js';
import { createRoom, roomInfo, normBoard, setRoomSettings, getRoom } from '../server/rooms.js';
import { goAIMove } from '../server/ai.js';

await initDB();
await loadKernels();

async function setupApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createRouter());
  return app;
}

let seq = 0;
function newUser(prefix = 'u') {
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
  const w = new World('be_' + seed + '_' + (seq++), 1, seed, opts || {});
  w._skipAIFill = true;
  return w;
}
function seatedGo(seed = 42, opts) {
  const w = new World('beGo' + seed + '_' + (seq++), 1, seed, Object.assign({ mode: 'go' }, opts || {}));
  w._skipAIFill = true;
  w.addPlayer(1, 'Black');
  w.addPlayer(2, 'White');
  w._goInit();
  return w;
}
// 构造一个 board 配置对象（'#'=可落子 'x'=虚空 '.'=形状外）。
function mkBoard(w, h, shape) { return { w, h, shape }; }

// ============================================================ BE-01/02 三态 + isWall
test('BE-01 三态常量：SHAPE_OUT=0 / SHAPE_PLAY=1 / SHAPE_VOID=2', () => {
  assert.equal(World.SHAPE_OUT, 0);
  assert.equal(World.SHAPE_PLAY, 1);
  assert.equal(World.SHAPE_VOID, 2);
  assert.deepEqual(World.SHAPE_CHARS, { '.': 0, '#': 1, 'x': 2 });
  assert.deepEqual(World.SHAPE_CHARS_INV, ['.', '#', 'x']);
});

test('BE-02 isWall 纯函数：越界∪形状外∪虚空 → true；仅可落子 → false', () => {
  // 3×2 位图： (0,0)='#', (1,0)='x'(void), (2,0)='.', (0,1)='#',(1,1)='#',(2,1)='#'
  const w = 3, h = 2;
  const bmp = new Uint8Array([1, 2, 0, 1, 1, 1]);
  assert.equal(World.isWall(bmp, w, h, 0, 0), false, '可落子 → 非墙');
  assert.equal(World.isWall(bmp, w, h, 1, 0), true, '虚空 → 墙');
  assert.equal(World.isWall(bmp, w, h, 2, 0), true, '形状外 → 墙');
  assert.equal(World.isWall(bmp, w, h, 0, 1), false);
  assert.equal(World.isWall(bmp, w, h, -1, 0), true, '越界(左) → 墙');
  assert.equal(World.isWall(bmp, w, h, 0, -1), true, '越界(上) → 墙');
  assert.equal(World.isWall(bmp, w, h, 3, 0), true, '越界(右) → 墙');
  assert.equal(World.isWall(bmp, w, h, 0, 2), true, '越界(下) → 墙');
  // 形状外(0) 与 虚空(2) 在"墙"语义上完全等价
  assert.equal(World.isWall(bmp, w, h, 1, 0), World.isWall(bmp, w, h, 2, 0), '虚空与形状外同为墙');
});

// ============================================================ BE-03 默认零变化
test('BE-03 默认零变化：board=null → _isWall 逐字节等价矩形越界判定', () => {
  const w = freshWorld(1);   // 未传 board
  assert.equal(w.board, null, 'board=null');
  assert.equal(w._bmp, null, '_bmp=null');
  const LW = World.LIFE_W;
  const legacy = (lx, ly) => (lx < 0 || ly < 0 || lx >= LW || ly >= LW);
  for (let ly = -1; ly <= LW; ly++) {
    for (let lx = -1; lx <= LW; lx++) {
      assert.equal(w._isWall(lx, ly), legacy(lx, ly), `(${lx},${ly}) 等价`);
    }
  }
  assert.equal(w._isPlayableWorld(0, 0), true);
  assert.equal(w._isPlayableWorld(191, 191), true);
});

test('BE-03 默认零变化：normBoard(null/undefined/"") → null（回矩形）', () => {
  assert.equal(normBoard(null, 'rts'), null);
  assert.equal(normBoard(undefined, 'go'), null);
  assert.equal(normBoard('', 'rts'), null);
});

// ============================================================ BE-04 编解码往返
test('BE-04 位图编解码往返：encode → decode 恒等', () => {
  const w = 4, h = 3;
  const grid = [
    [1, 1, 1, 1],
    [1, 2, 0, 1],
    [0, 1, 1, 2],
  ];
  const s = World.encodeBoard(w, h, grid);
  assert.equal(s, '####/#x.#/.##x', '行优先 / 分隔，. # x');
  const cfg = mkBoard(w, h, s);
  const bmp = World.decodeBoard(cfg);
  assert.equal(bmp.length, w * h);
  for (let ly = 0; ly < h; ly++) {
    for (let lx = 0; lx < w; lx++) {
      assert.equal(bmp[ly * w + lx], grid[ly][lx], `(${lx},${ly}) 往返一致`);
    }
  }
  // 非法字符宽容 → 形状外
  const bad = World.decodeBoard(mkBoard(3, 1, '#?x'));
  assert.equal(bad[0], 1); assert.equal(bad[1], 0); assert.equal(bad[2], 2);
});

// ============================================================ BE-05 normBoard 归一/拒绝
test('BE-05 normBoard：合法保留；非法/null/JSON 坏 → null', () => {
  assert.deepEqual(normBoard(mkBoard(3, 2, '###/#x#'), 'rts'), { w: 3, h: 2, shape: '###/#x#' });
  assert.deepEqual(normBoard(JSON.stringify(mkBoard(2, 2, '##/#x')), 'go'), { w: 2, h: 2, shape: '##/#x' });
  assert.equal(normBoard(null, 'rts'), null);
  assert.equal(normBoard('{bad', 'rts'), null);
  // 行数不符 → null（E2）
  assert.equal(normBoard(mkBoard(2, 3, '##/#x'), 'rts'), null, '行数不足 → 拒绝');
  // 列数不符 → null（E2）：w=3 但第二行仅 2 列
  assert.equal(normBoard(mkBoard(3, 2, '###/#x'), 'rts'), null, '列数不符 → 拒绝');
  // 全形状外（无可落子）→ null（E3）
  assert.equal(normBoard(mkBoard(2, 2, 'xx/xx'), 'rts'), null, '全虚空 → 拒绝');
  assert.equal(normBoard(mkBoard(2, 2, '../x.'), 'rts'), null, '无任何可落子 → 拒绝');
  // 尺寸越界钳制：w=0 → 回退默认 → null
  assert.equal(normBoard(mkBoard(0, 2, '/'), 'rts'), null, 'w=0 → 拒绝');
  // 超上限钳制：w=999 → 钳到 100，但与 shape 列数不符 → 拒绝
  assert.equal(normBoard(mkBoard(999, 1, '#'), 'rts'), null, 'w 超限且列数不符 → 拒绝');
});

// ============================================================ BE-06 预设模板
test('BE-06 六预设模板：全部合法、非全空、形状互不相同', () => {
  const keys = ['rect', 'cross', 'castle', 'twins', 'ring', 'islands'];
  const shapes = {};
  for (const k of keys) {
    const b = World.presetBoard(k, 24, 24, 12345);
    assert.ok(b, `${k} 生成成功`);
    assert.equal(b.w, 24); assert.equal(b.h, 24);
    const bmp = World.decodeBoard(b);
    let play = 0, voidN = 0;
    for (const v of bmp) { if (v === 1) play++; else if (v === 2) voidN++; }
    assert.ok(play > 0, `${k} 至少一个可落子格`);
    shapes[k] = b.shape;
  }
  const uniq = new Set(Object.values(shapes));
  assert.ok(uniq.size >= 4, `模板形状应多样化，实际唯一 ${uniq.size} 个`);
  const rect = World.decodeBoard(World.presetBoard('rect', 8, 8, 1));
  assert.ok([...rect].every(v => v === 1), 'rect 全可落子');
  const ring = World.decodeBoard(World.presetBoard('ring', 20, 20, 1));
  assert.ok([...ring].some(v => v === 2), 'ring 含虚空（中空）');
  assert.deepEqual(World.presetBoard('nope', 8, 8, 1).shape, World.presetBoard('rect', 8, 8, 1).shape, '非法 id 回退 rect');
});

// ============================================================ BE-07 预设确定性
test('BE-07 随机岛屿确定性：同 seed 同形，异 seed 可能不同（IR-3a）', () => {
  const a1 = World.presetBoard('islands', 40, 40, 777);
  const a2 = World.presetBoard('islands', 40, 40, 777);
  assert.equal(a1.shape, a2.shape, '同 seed 同尺寸 → 形状完全一致');
  for (let i = 0; i < 5; i++) {
    assert.equal(World.presetBoard('islands', 40, 40, 777).shape, a1.shape, '重复调用稳定');
  }
  const a3 = World.presetBoard('islands', 40, 40, 888);
  assert.notEqual(a1.shape, a3.shape, '异 seed 形状不同');
});

// ============================================================ BE-08 虚空阻断连通
test('BE-08 虚空=墙：被墙四面包围的子 0 气（Q2=a）', () => {
  // 3×3 棋盘：仅中心 (1,1) 可落子，4-邻全形状外 → 落子后 0 气
  const shape = '.../.#./...';
  const w = seatedGo(11, { board: mkBoard(3, 3, shape) });
  const L = w._life;
  const B = w.go.blackF;
  for (let x = 0; x < 32; x++) for (let y = 0; y < 32; y++) L[x][y] = 0;
  assert.equal(w._isWall(1, 0), true, '(1,0) 形状外 → 墙');
  assert.equal(w._isWall(0, 1), true, '(0,1) 形状外 → 墙');
  assert.equal(w._isWall(1, 1), false, '(1,1) 可落子');
  // 直接布子（_goLiberties 要求该格非空才统计气）
  L[1][1] = B;
  const libs = w._goLiberties(1, 1);
  assert.ok(typeof libs === 'number', '_goLiberties 返回气数(number)');
  assert.equal(libs, 0, '四面皆墙 → 0 气');
});

test('BE-08 虚空=墙：墙把两块可落子区隔断（不误连）', () => {
  const shape = '###x###';   // 1 行 7 列：中间 x 隔断左右
  const w = seatedGo(12, { board: mkBoard(7, 1, shape) });
  assert.equal(w._isWall(3, 0), true, '(3,0) 虚空隔断');
  assert.equal(w._isPlayable(0, 0), true);
  assert.equal(w._isPlayable(6, 0), true);
  assert.equal(w._isPlayable(3, 0), false, '隔断格不可落子');
});

// ============================================================ BE-09 虚空落子被拒
test('BE-09 虚空/形状外落子被拒：reason=oob', () => {
  const shape = '###x###/#######';  // (3,0) 虚空
  const w = seatedGo(13, { board: mkBoard(7, 2, shape) });
  const B = w.go.blackF;
  const r1 = w._goPlay(B, 3, 0, []);   // 落在虚空
  assert.equal(r1.ok, false, '虚空落子应被拒');
  assert.equal(r1.reason, 'oob', 'reason=oob（复用越界错误码）');
  const r2 = w._goPlay(B, 0, 5, []);   // 落在形状外（越界）
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'oob');
});

// ============================================================ BE-10 墙格永不诞生
test('BE-10 演化：墙格永不诞生（next=0）', () => {
  const shape = '###x###/#######/#######';  // (3,0) 虚空
  const w = seatedGo(14, { board: mkBoard(7, 3, shape) });
  const L = w._life;
  const B = w.go.blackF;
  for (let x = 0; x < 32; x++) for (let y = 0; y < 32; y++) L[x][y] = 0;
  L[2][0] = B; L[4][0] = B;   // 虚空两侧各一子（制造"本应诞生"的康威条件）
  w._goEvolveOnce();
  assert.equal(L[3][0], 0, '虚空格 (3,0) 演化后仍为 0（永不诞生）');
  for (let i = 0; i < 5; i++) w._goEvolveOnce();
  assert.equal(L[3][0], 0, '多轮后虚空格仍为 0');
});

test('BE-10 rts _lifeStep：墙格永不诞生', () => {
  const shape = '###x###/#######/#######';
  const w = freshWorld(15, { mode: 'rts', board: mkBoard(7, 3, shape) });
  w._lifeInit();
  const L = w._life;
  for (let x = 0; x < 32; x++) for (let y = 0; y < 32; y++) L[x][y] = 2; // 2 = 某势力
  L[3][0] = 0;
  w._lifeStep();
  assert.equal(L[3][0], 0, '虚空格 _lifeStep 后仍为 0');
});

// ============================================================ BE-11 go AI 不落虚空
test('BE-11 go AI 绝不落到虚空/形状外（Q6=a）', () => {
  const p = World.presetBoard('cross', 32, 32, 1);
  const w = seatedGo(16, { board: { w: p.w, h: p.h, shape: p.shape } });
  const B = w.go.blackF;
  let play = 0;
  for (let x = 0; x < 32; x++) for (let y = 0; y < 32; y++) if (!w._isWall(x, y)) play++;
  assert.ok(play > 0, '十字棋盘存在可落子点');
  for (let i = 0; i < 30; i++) {
    const mv = goAIMove(w, B);
    if (!mv || mv.pass) break;            // 无可行着 / 全员 pass → 停止
    assert.ok(Array.isArray(mv.moves) && mv.moves.length > 0, 'AI 返回着法列表');
    for (const m of mv.moves) {
      assert.ok(!w._isWall(m.lx, m.ly), `AI 第 ${i} 步落到墙格 (${m.lx},${m.ly})`);
    }
  }
});

// ============================================================ BE-12 rts 出生点
test('BE-12 rts 出生点自选(pick)：落在指定可落子世界格', () => {
  const shape = [];
  for (let y = 0; y < 32; y++) {
    let row = '';
    for (let x = 0; x < 32; x++) row += (x < 8 && y < 8) ? '#' : '.';
    shape.push(row);
  }
  const board = mkBoard(32, 32, shape.join('/'));
  const w = freshWorld(17, { mode: 'rts', board, spawnMode: 'pick', spawnXY: { x: 12, y: 12 } });
  w.addPlayer(1, 'P1');
  const p = Object.values(w.players)[0];
  assert.ok(p, '玩家已加入');
  assert.ok(w._isPlayableWorld(p.x, p.y), `出生点 (${p.x},${p.y}) 可通行`);
  assert.ok(p.x < 48 && p.y < 48, '出生点在可落子区域（左上 8×8 生命格）');
});

test('BE-12 rts 出生点随机(random)：形状外不生成', () => {
  const shape = [];
  for (let y = 0; y < 32; y++) {
    let row = '';
    for (let x = 0; x < 32; x++) row += (x >= 24 && y < 8) ? '#' : '.';
    shape.push(row);
  }
  const board = mkBoard(32, 32, shape.join('/'));
  const w = freshWorld(18, { mode: 'rts', board, spawnMode: 'random' });
  for (let i = 1; i <= 3; i++) w.addPlayer(i, 'P' + i);
  for (const p of Object.values(w.players)) {
    assert.ok(w._isPlayableWorld(p.x, p.y), `随机出生点 (${p.x},${p.y}) 可通行`);
    assert.ok(p.x >= 24 * 6, '随机出生点落在右上可落子区（x≥144）');
  }
});

// ============================================================ BE-13 已开始锁定
test('BE-13 已开始房间锁定形状：PATCH → code=403 board_locked（服务端强制，Q3=a）', async () => {
  const app = await setupApp();
  const u = newUser('host');
  const r = await call(app, 'POST', '/api/rooms', { mode: 'rts', maxPlayers: 4, visibility: 'public' }, u.token);
  assert.equal(r.status, 200, '建房成功');
  const code = r.body.data.code;   // 房间号在 data.code
  const wres = await call(app, 'POST', `/api/rooms/${code}/world`, { mode: 'rts' }, u.token);
  assert.equal(wres.status, 200, '建世界成功');
  const sres = await call(app, 'POST', `/api/rooms/${code}/start`, {}, u.token);
  assert.equal(sres.status, 200, '开始成功');
  const patch = await call(app, 'PATCH', `/api/rooms/${code}/settings`,
    { board: mkBoard(4, 4, '####/####/####/####') }, u.token);
  assert.equal(patch.status, 200, 'HTTP 仍 200（业务码在 body）');
  assert.equal(patch.body.code, 403, '业务码 403');
  assert.equal(patch.body.message, 'board_locked', '错误码 board_locked');
});

test('BE-13 未开始房间可改形状（PATCH → 200 + 回读一致）', async () => {
  const app = await setupApp();
  const u = newUser('host2');
  const r = await call(app, 'POST', '/api/rooms', { mode: 'go', maxPlayers: 2, visibility: 'public' }, u.token);
  const code = r.body.data.code;
  const board = mkBoard(6, 6, '######/#xxxx#/#x##x#/#x##x#/#xxxx#/######');
  const patch = await call(app, 'PATCH', `/api/rooms/${code}/settings`, { board }, u.token);
  assert.equal(patch.status, 200, '未开始 → 允许改形状');
  assert.deepEqual(patch.body.data.board, board, '返回归一后的 board');
  const info = await call(app, 'GET', `/api/rooms/${code}`, null, u.token);
  assert.deepEqual(info.body.data.board, board, '房间信息携带 board');
});

// ============================================================ BE-14 透传
test('BE-14 建房携带 board：createRoom 透传 + roomInfo 回显；非法 board 回 null', async () => {
  const board = mkBoard(4, 4, '####/#xx#/#xx#/####');
  const room = await createRoom({ mode: 'rts', maxPlayers: 4, visibility: 'public', board });
  assert.deepEqual(room.board, board, 'createRoom 契约：board 透传');
  const info = roomInfo(room);
  assert.deepEqual(info.board, board, 'roomInfo 携带 board');
  const room2 = await createRoom({ mode: 'rts', maxPlayers: 4, visibility: 'public', board: { w: 3, h: 3, shape: 'xx' } });
  assert.equal(room2.board, null, '非法 board 归一为 null');
});

test('BE-14 建世界透传 board：POST /rooms/:code/world → 世界运行时可判定墙', async () => {
  const app = await setupApp();
  const u = newUser('host4');
  const rows = [];
  for (let y = 0; y < 32; y++) {
    let row = '';
    for (let x = 0; x < 32; x++) row += (x < 10 && y < 10) ? '#' : '.';
    rows.push(row);
  }
  const board = mkBoard(32, 32, rows.join('/'));
  const r = await call(app, 'POST', '/api/rooms', { mode: 'rts', maxPlayers: 4, visibility: 'public', board }, u.token);
  const code = r.body.data.code;   // 房间号在 data.code
  const wres = await call(app, 'POST', `/api/rooms/${code}/world`, { mode: 'rts' }, u.token);
  assert.equal(wres.status, 200, '建世界成功');
  const worldId = wres.body.data.worldId;
  assert.ok(worldId, '返回 worldId');
  const world = activeWorlds.get(worldId);
  assert.ok(world, '世界已注册');
  // 房间携带的 board 已透传进世界运行时位图（房间记录为权威）
  assert.deepEqual(world.board, board, '世界实例 board 由房间透传');
  assert.equal(world._isWall(20, 20), true, '(20,20) 形状外 → 墙');
  assert.equal(world._isWall(2, 2), false, '(2,2) 可落子');
});

// ============================================================ BE-15 snapshot
test('BE-15 snapshot：settings.board 每帧携带 + boardMap 低频', () => {
  const board = mkBoard(4, 4, '####/#xx#/#xx#/####');
  const w = freshWorld(19, { mode: 'rts', board });
  const s0 = w.snapshot();
  assert.deepEqual(s0.settings.board, board, 'settings.board 每帧携带');
  assert.ok(s0.boardMap, 'tick<=1 下发 boardMap');
  assert.equal(typeof s0.boardMap, 'string', 'boardMap 是紧凑串（非 100×100 数组）');
  w.tick = 5;
  w._boardMapSentRev = w._boardRev;
  const s1 = w.snapshot();
  assert.equal(s1.boardMap, null, '无变更 → boardMap 不下发');
  w._compileBoard(mkBoard(4, 4, '####/####/####/####'));
  w.tick = 6;
  const s2 = w.snapshot();
  assert.ok(s2.boardMap, '形状变更后 boardMap 重新下发');
});

// ============================================================ BE-16 rts 世界尺寸
test('BE-16 rts 世界保持 192×192（位图仅为叠加）', () => {
  const rows = [];
  for (let y = 0; y < 32; y++) {
    let row = '';
    for (let x = 0; x < 32; x++) row += (x < 10 && y < 10) ? '#' : '.';
    rows.push(row);
  }
  const board = mkBoard(32, 32, rows.join('/'));
  const w = freshWorld(20, { mode: 'rts', board });
  assert.equal(w.terrain.length, 192, '世界宽 192 不变');
  assert.equal(w.terrain[0].length, 192, '世界高 192 不变');
  assert.equal(w._boardW, 32, '位图宽 32（生命格粒度）');
  assert.equal(w._boardH, 32, '位图高 32');
  assert.equal(w._isPlayableWorld(0, 0), true, '左上可通行');
  assert.equal(w._isPlayableWorld(150, 150), false, '右下（形状外）不可通行');
});

// ============================================================ BE-17 铁律 IR-3a
// 与既有 GM-17（tests/go_mode.test.mjs）同集合：仅扫描确定性关键模拟文件 go.js / ai.js。
// 说明：engine.js 构造函数中 `this.created = Date.now()` 为元数据时间戳，不参与模拟确定性，
// 不在任何既有 guard 集合内（GM-17 / kernels L0-03 均不扫 engine.js），故此测试与之一致。
test('BE-17 IR-3a：go.js / ai.js 不含 Math.random / Date.now（模拟确定性关键文件）', async () => {
  const fs = await import('node:fs');
  const files = ['server/go.js', 'server/ai.js'];
  for (const f of files) {
    let src = fs.readFileSync(f, 'utf8');
    src = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/Math\.random\s*\(/.test(src), `${f} 不得含 Math.random()`);
    assert.ok(!/Date\.now\s*\(/.test(src), `${f} 不得含 Date.now()`);
  }
});
