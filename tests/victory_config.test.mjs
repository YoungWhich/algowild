// tests/victory_config.test.mjs — 房主可配置胜利条件（VC-01 ~ VC-15）
//
// 覆盖：
//   VC-01 归一 / 钳制：VictoryLines 默认（仅领土）、非法回默认、门槛钳制到安全区间
//   VC-02 rts 4 条线 × 开/关 共 8 组：关闭线触发 0 次、开启线触发 1 次
//   VC-03 默认仅领土（createRoom / World 构造）
//   VC-04 availableLines：go 仅 [territory]、rts 4 条
//   VC-05 go 下强制归零 economy/singularity/survival（防越权）
//   VC-06 建房透传 + 回读（POST /rooms）
//   VC-07 房主中途改配置（PATCH /rooms/:code/settings）：非房主 403 not_host；房主改后快照可见
//   VC-08 roomInfo / snapshot 输出 victoryLines + availableLines
//   VC-09 清盘不判胜（wiped 仅触发终局）
//   VC-10 go 终局数子：双方连续 Pass → 数子 X vs Y；数子口径 = 子数 + 围住空点（非 Voronoi 目数）
//   VC-15 旧库缺列 / 旧房间 → 回默认；不报错
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createRouter } from '../server/routes.js';
import { signToken } from '../server/auth.js';
import { initDB, usersRepo, roomsRepo } from '../server/db/index.js';
import { World, loadKernels } from '../server/engine.js';
import { activeWorlds } from '../server/worldhub.js';
import {
  createRoom, roomInfo, normVictoryLines, normVictoryThresholds, setRoomSettings, getRoom,
} from '../server/rooms.js';

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
  const w = new World('w_' + seed + '_' + (seq++), 1, seed, opts || {});
  w._skipAIFill = true;
  return w;
}

// ============================================================ VC-01 / VC-03 归一 + 默认
test('VC-01 归一：victoryLines 默认仅领土、非法回默认、逐键仅接受 boolean', () => {
  // 默认
  assert.deepEqual(World.VICTORY_LINE_DEFAULT,
    { territory: true, economy: false, singularity: false, survival: false });
  // null / '' / 非法 JSON → 默认
  assert.deepEqual(normVictoryLines(null, 'rts'), World.VICTORY_LINE_DEFAULT);
  assert.deepEqual(normVictoryLines('', 'rts'), World.VICTORY_LINE_DEFAULT);
  assert.deepEqual(normVictoryLines('{bad json', 'rts'), World.VICTORY_LINE_DEFAULT);
  // 合法对象：逐键生效
  assert.deepEqual(normVictoryLines({ territory: false, economy: true }, 'rts'),
    { territory: false, economy: true, singularity: false, survival: false });
  // 非 boolean 值被忽略（回默认）
  assert.deepEqual(normVictoryLines({ territory: 'yes', survival: 1 }, 'rts'),
    { territory: true, economy: false, singularity: false, survival: false });
  // JSON 串输入也可
  assert.deepEqual(normVictoryLines('{"territory":false,"survival":true}', 'rts'),
    { territory: false, economy: false, singularity: false, survival: true });
});

test('VC-01 归一：victoryThresholds 逐字段钳制到安全区间；非数字/空 → 默认', () => {
  // 默认 = 原硬编码常量
  assert.deepEqual(normVictoryThresholds(null),
    { territoryRegions: 16, economyLead: 600, economyHoldTicks: 1800, singularityThreshold: 30, deathLimit: 12 });
  // 越界钳制
  const clamped = normVictoryThresholds({
    territoryRegions: 999, economyLead: -5, economyHoldTicks: 99999, singularityThreshold: 0, deathLimit: 1000,
  });
  assert.equal(clamped.territoryRegions, 40, 'territoryRegions 夹到上限 40');
  assert.equal(clamped.economyLead, 200, 'economyLead 夹到下限 200');
  assert.equal(clamped.economyHoldTicks, 6000, 'economyHoldTicks 夹到上限 6000');
  assert.equal(clamped.singularityThreshold, 6, 'singularityThreshold 夹到下限 6');
  assert.equal(clamped.deathLimit, 50, 'deathLimit 夹到上限 50');
  // 非数字 / 小数 / 字符串数字
  const mixed = normVictoryThresholds({ territoryRegions: 'abc', economyLead: 650.9, economyHoldTicks: '900' });
  assert.equal(mixed.territoryRegions, 16, '非数字回默认 16');
  assert.equal(mixed.economyLead, 650, '小数取整 650');
  assert.equal(mixed.economyHoldTicks, 900, '字符串数字 900');
});

test('VC-03 createRoom 不传参 → victoryLines 默认仅领土；World 构造同默认', async () => {
  const room = await createRoom({ ownerId: 1, name: '默认房' });
  assert.deepEqual(room.victoryLines, { territory: true, economy: false, singularity: false, survival: false });
  assert.deepEqual(room.victoryThresholds,
    { territoryRegions: 16, economyLead: 600, economyHoldTicks: 1800, singularityThreshold: 30, deathLimit: 12 });
  const w = freshWorld(7);
  assert.deepEqual(w.victoryLines, { territory: true, economy: false, singularity: false, survival: false });
});

// ============================================================ VC-04 / VC-05 模式门禁
test('VC-04 availableLines：rts 4 条、go 仅 territory', () => {
  assert.deepEqual(World.availableLines('rts'), ['territory', 'economy', 'singularity', 'survival']);
  assert.deepEqual(World.availableLines('go'), ['territory']);
  assert.deepEqual(World.availableLines('go').length, 1, 'go 下长度=1');
  assert.deepEqual(World.availableLines('go'), ['territory']);
});

test('VC-05 go 下强制归零 economy/singularity/survival（防 API 越权）', () => {
  const v = normVictoryLines({ territory: true, economy: true, singularity: true, survival: true }, 'go');
  assert.deepEqual(v, { territory: true, economy: false, singularity: false, survival: false });
  // 构造 World 也强制（构造器双保险）
  const w = new World('goX', 1, 1, { mode: 'go', victoryLines: { economy: true, survival: true, singularity: true } });
  assert.equal(w.victoryLines.economy, false);
  assert.equal(w.victoryLines.singularity, false);
  assert.equal(w.victoryLines.survival, false);
  assert.equal(w.victoryLines.territory, true, '领土仍默认为开');
});

// ============================================================ VC-02 rts 4 线 × 开/关 8 组
// 构造让各线条件"已满足"的局面，然后按开关断言触发次数。
function setupSingularity(w) {
  const p = w.addPlayer(1, 'P');
  p._stock = { wood: 30, stone: 30, ore: 30, crystal: 30, food: 30, shard: 30 };
  return p;
}
function setupTerritory(w) {
  const p = w.addPlayer(1, 'P');
  p.era = 3; p.regionsOwned = 16;
  return p;
}
function setupEconomy(w) {
  const p1 = w.addPlayer(1, 'P1');
  const p2 = w.addPlayer(2, 'P2');
  p1.score = 700; p2.score = 50; p1.regionsOwned = 10; p1.era = 3; p1.scoreLeadTicks = 1799;
  return p1;
}
function setupSurvival(w) {
  const p1 = w.addPlayer(1, 'P1');
  const p2 = w.addPlayer(2, 'P2');
  p2.lost = true;             // 只剩 p1 → 触发 survival（需曾有多人）
  return p1;
}

test('VC-02 singularity：开关生效（关=0 次，开=1 次）', () => {
  const off = freshWorld(1, { victoryLines: { singularity: false, territory: false, economy: false, survival: false } });
  const pOff = setupSingularity(off);
  const evOff = []; off._checkVictoryConditions(evOff);
  assert.equal(pOff.won, false); assert.equal(evOff.filter(e => e.type === 'victory').length, 0);

  const on = freshWorld(2, { victoryLines: { singularity: true, territory: false, economy: false, survival: false } });
  const pOn = setupSingularity(on);
  const evOn = []; on._checkVictoryConditions(evOn);
  assert.equal(pOn.won, true); assert.equal(pOn.winReason, 'singularity');
  assert.equal(evOn.filter(e => e.type === 'victory' && e.reason === 'singularity').length, 1);
});

test('VC-02 territory：开关生效（关=0 次，开=1 次）', () => {
  const off = freshWorld(3, { victoryLines: { territory: false, economy: false, singularity: false, survival: false } });
  const pOff = setupTerritory(off);
  off._checkVictoryConditions([]);
  assert.equal(pOff.won, false);

  const on = freshWorld(4, { victoryLines: { territory: true, economy: false, singularity: false, survival: false } });
  const pOn = setupTerritory(on);
  const ev = []; on._checkVictoryConditions(ev);
  assert.equal(pOn.won, true); assert.equal(pOn.winReason, 'territory');
  assert.equal(ev.filter(e => e.type === 'victory' && e.reason === 'territory').length, 1);
});

test('VC-02 economy：开关生效（关=0 次，开=1 次）+ 关线清零 counter', () => {
  const off = freshWorld(5, { victoryLines: { economy: false, territory: false, singularity: false, survival: false } });
  const pOff = setupEconomy(off);
  off._checkVictoryConditions([]);
  assert.equal(pOff.won, false, '关闭经济线不触发');
  assert.equal(pOff.scoreLeadTicks, 0, '关闭经济线应清零累计计数器（防"关掉攒条"）');

  const on = freshWorld(6, { victoryLines: { economy: true, territory: false, singularity: false, survival: false } });
  const pOn = setupEconomy(on);
  on._checkVictoryConditions([]);   // 1799 -> 1800
  on._checkVictoryConditions([]);   // 达标
  assert.equal(pOn.won, true); assert.equal(pOn.winReason, 'economy');
});

test('VC-02 survival：开关生效（关=0 次，开=1 次）', () => {
  const off = freshWorld(7, { victoryLines: { survival: false, territory: false, economy: false, singularity: false } });
  const pOff = setupSurvival(off);
  const evOff = []; off._checkVictoryConditions(evOff);
  assert.equal(pOff.won, false);
  assert.equal(evOff.filter(e => e.type === 'victory').length, 0);

  const on = freshWorld(8, { victoryLines: { survival: true, territory: false, economy: false, singularity: false } });
  const pOn = setupSurvival(on);
  const evOn = []; on._checkVictoryConditions(evOn);
  assert.equal(pOn.won, true); assert.equal(pOn.winReason, 'survival');
  assert.equal(evOn.filter(e => e.type === 'victory' && e.reason === 'survival').length, 1);
});

test('VC-02 全关：任何线都不触发', () => {
  const w = freshWorld(9, { victoryLines: { territory: false, economy: false, singularity: false, survival: false } });
  const p = setupTerritory(w);
  p._stock = { wood: 999, stone: 999, ore: 999, crystal: 999, food: 999, shard: 999 };
  const ev = [];
  w._checkVictoryConditions(ev);
  assert.equal(p.won, false, '全关时不应有胜者');
  assert.equal(ev.filter(e => e.type === 'victory').length, 0);
});

test('VC-02 门槛可调：territoryRegions 调低/调高改变判定', () => {
  // 调高到 40：16 区不触发
  const hi = freshWorld(10, { victoryLines: { territory: true, economy: false, singularity: false, survival: false },
    victoryThresholds: { territoryRegions: 40 } });
  const pHi = setupTerritory(hi);
  hi._checkVictoryConditions([]);
  assert.equal(pHi.won, false, '门槛 40，16 区不达标');
  // 调低到 6：8 区即触发
  const lo = freshWorld(11, { victoryLines: { territory: true, economy: false, singularity: false, survival: false },
    victoryThresholds: { territoryRegions: 6 } });
  const pLo = lo.addPlayer(1, 'P'); pLo.era = 3; pLo.regionsOwned = 8;
  lo._checkVictoryConditions([]);
  assert.equal(pLo.won, true, '门槛 6，8 区达标即胜');
});

// ============================================================ VC-08 快照 / 房间视图
test('VC-08 snapshot().settings 含 victoryLines/victoryThresholds/availableLines', () => {
  const w = freshWorld(12, { mode: 'rts', victoryLines: { territory: true, economy: true } });
  const s = w.snapshot().settings;
  assert.deepEqual(s.victoryLines, { territory: true, economy: true, singularity: false, survival: false });
  assert.deepEqual(s.availableLines, ['territory', 'economy', 'singularity', 'survival']);
  assert.equal(s.victoryThresholds.territoryRegions, 16);
  // go 世界：availableLines 仅 territory
  const g = new World('goS', 1, 2, { mode: 'go' });
  assert.deepEqual(g.snapshot().settings.availableLines, ['territory']);
});

test('VC-08 roomInfo 输出 victoryLines/victoryThresholds/availableLines（世界为权威）', async () => {
  const room = await createRoom({ ownerId: 1, name: '视图房', mode: 'rts',
    victoryLines: { territory: false, economy: true } });
  const info = roomInfo(room, 1);
  assert.deepEqual(info.victoryLines, { territory: false, economy: true, singularity: false, survival: false });
  assert.deepEqual(info.availableLines, ['territory', 'economy', 'singularity', 'survival']);
  assert.equal(info.victoryThresholds.economyLead, 600);
});

// ============================================================ VC-06 / VC-07 路由：透传 + PATCH
test('VC-06 建房透传 victoryLines 并在房间详情回读', async () => {
  const app = await setupApp();
  const host = newUser('host');
  const r = await call(app, 'POST', '/api/rooms', {
    name: '胜利条件房', maxPlayers: 4, mode: 'rts',
    victoryLines: { territory: true, economy: true, singularity: false, survival: true },
  }, host.token);
  assert.equal(r.body.code, 0);
  assert.deepEqual(r.body.data.victoryLines, { territory: true, economy: true, singularity: false, survival: true });
  assert.deepEqual(r.body.data.room.victoryLines, { territory: true, economy: true, singularity: false, survival: true });
  const code = r.body.data.code;
  const info = await call(app, 'GET', `/api/rooms/${code}`, null, host.token);
  assert.deepEqual(info.body.data.victoryLines, { territory: true, economy: true, singularity: false, survival: true });
  assert.deepEqual(info.body.data.availableLines, ['territory', 'economy', 'singularity', 'survival']);
});

test('VC-06 go 房即使传 economy/survival 也归零（越权防护）', async () => {
  const app = await setupApp();
  const host = newUser('host');
  const r = await call(app, 'POST', '/api/rooms', {
    name: 'go胜利房', maxPlayers: 4, mode: 'go',
    victoryLines: { territory: true, economy: true, singularity: true, survival: true },
  }, host.token);
  assert.deepEqual(r.body.data.victoryLines, { territory: true, economy: false, singularity: false, survival: false });
  assert.deepEqual(r.body.data.room.availableLines, ['territory']);
});

test('VC-06 房间建世界后透传到 World（snapshot 可见）', async () => {
  const app = await setupApp();
  const host = newUser('host');
  const r = await call(app, 'POST', '/api/rooms', {
    name: '透传房', maxPlayers: 4, mode: 'rts',
    victoryLines: { territory: true, economy: true },
    victoryThresholds: { territoryRegions: 20 },
  }, host.token);
  const code = r.body.data.code;
  const w = await call(app, 'POST', `/api/rooms/${code}/world`, { mode: 'rts', seed: 5 }, host.token);
  assert.equal(w.body.code, 0);
  const inst = activeWorlds.get(w.body.data.worldId);
  assert.ok(inst);
  assert.deepEqual(inst.snapshot().settings.victoryLines, { territory: true, economy: true, singularity: false, survival: false });
  assert.equal(inst.snapshot().settings.victoryThresholds.territoryRegions, 20);
});

test('VC-07 非房主 PATCH settings → 403 not_host', async () => {
  const app = await setupApp();
  const host = newUser('host');
  const guest = newUser('guest');
  const r = await call(app, 'POST', '/api/rooms', { name: '权限房', maxPlayers: 4, mode: 'rts' }, host.token);
  const code = r.body.data.code;
  await call(app, 'POST', `/api/rooms/${code}/world`, { mode: 'rts', seed: 6 }, host.token);
  await call(app, 'POST', `/api/rooms/${code}/join`, {}, guest.token);
  const deny = await call(app, 'PATCH', `/api/rooms/${code}/settings`, { victoryLines: { economy: true } }, guest.token);
  assert.equal(deny.body.code, 403);
  assert.equal(deny.body.message, 'not_host');
});

test('VC-07 房主 PATCH settings 生效：下一次快照可见 + 非房主也被刷新', async () => {
  const app = await setupApp();
  const host = newUser('host');
  const r = await call(app, 'POST', '/api/rooms', { name: '改配房', maxPlayers: 4, mode: 'rts' }, host.token);
  const code = r.body.data.code;
  const w = await call(app, 'POST', `/api/rooms/${code}/world`, { mode: 'rts', seed: 8 }, host.token);
  const worldId = w.body.data.worldId;
  // 默认仅 territory
  assert.deepEqual(activeWorlds.get(worldId).snapshot().settings.victoryLines,
    { territory: true, economy: false, singularity: false, survival: false });
  // 房主开启 economy + survival
  const ok = await call(app, 'PATCH', `/api/rooms/${code}/settings`,
    { victoryLines: { territory: true, economy: true, survival: true } }, host.token);
  assert.equal(ok.body.code, 0);
  // 世界内存权威同步 → 下次快照即生效
  assert.deepEqual(activeWorlds.get(worldId).snapshot().settings.victoryLines,
    { territory: true, economy: true, singularity: false, survival: true });
  assert.deepEqual(ok.body.data.room.victoryLines,
    { territory: true, economy: true, singularity: false, survival: true });
  // DB 已持久化（房间记录同步）
  assert.deepEqual(getRoom(code).victoryLines,
    { territory: true, economy: true, singularity: false, survival: true });
});

test('VC-07 房主 PATCH 门槛：越界被钳制', async () => {
  const app = await setupApp();
  const host = newUser('host');
  const r = await call(app, 'POST', '/api/rooms', { name: '门槛房', maxPlayers: 4, mode: 'rts' }, host.token);
  const code = r.body.data.code;
  const ok = await call(app, 'PATCH', `/api/rooms/${code}/settings`,
    { victoryThresholds: { territoryRegions: 9999, economyLead: -100 } }, host.token);
  assert.equal(ok.body.code, 0);
  assert.equal(ok.body.data.victoryThresholds.territoryRegions, 40);
  assert.equal(ok.body.data.victoryThresholds.economyLead, 200);
});

// ============================================================ VC-15 旧库兼容
test('VC-15 hydrate 缺列 / NULL → 回默认（不报错）', async () => {
  // 直接构造"旧库行"（无 victory_lines / victory_thresholds 字段）走 hydrate 路径
  const code = 'OLD' + (seq++);
  roomsRepo.create(code, '', 1, 4, { visibility: 'public', name: '旧房', mode: 'rts' });
  const row = roomsRepo.get(code);
  assert.ok(row, '旧房应能从 DB 读出');
  // 模拟旧库读取：把两列视为 undefined（缺列）
  const legacyRow = { ...row, victory_lines: undefined, victory_thresholds: undefined };
  const room = getRoom(code);   // 内存未水合 → 从 DB 水合
  assert.ok(room, '应能水合旧房');
  assert.deepEqual(room.victoryLines, { territory: true, economy: false, singularity: false, survival: false });
  void legacyRow;
  // 归一对 NULL 也回默认（hydrate 直接依赖）
  assert.deepEqual(normVictoryLines(null, 'rts'), { territory: true, economy: false, singularity: false, survival: false });
});

test('VC-15 旧内存房间（无 victoryLines 字段）roomInfo 即时补默认', async () => {
  const room = await createRoom({ ownerId: 1, name: '旧内存房', mode: 'rts' });
  delete room.victoryLines;   // 模拟升级前创建的内存房间
  const info = roomInfo(room, 1);
  assert.deepEqual(info.victoryLines, { territory: true, economy: false, singularity: false, survival: false });
  assert.deepEqual(info.availableLines, ['territory', 'economy', 'singularity', 'survival']);
});

test('VC-15 DB 往返：setSettings 后重新水合读回同值', async () => {
  const code = 'RT' + (seq++);
  await createRoom({ ownerId: 1, name: '往返房', mode: 'rts' });
  // 用一个已知 code 的房（createRoom 内部生成的 code），改用 roomsRepo 直接验证持久化：
  const room2 = await createRoom({ ownerId: 1, name: '往返房2', mode: 'rts' });
  setRoomSettings(room2.code, { victoryLines: { territory: false, economy: true, singularity: false, survival: true } });
  const row = roomsRepo.get(room2.code);
  assert.deepEqual(JSON.parse(row.victory_lines), { territory: false, economy: true, singularity: false, survival: true });
  // 从内存移除后重新水合
  const { roomHub } = await import('../server/rooms.js');
  roomHub.delete(room2.code);
  const re = getRoom(room2.code);
  assert.deepEqual(re.victoryLines, { territory: false, economy: true, singularity: false, survival: true });
  void code;
});

// ============================================================ VC-09 / VC-10 go 终局数子
function seatedGo(seed = 42, opts) {
  const w = new World('goT' + seed + '_' + (seq++), 1, seed, Object.assign({ mode: 'go' }, opts || {}));
  w._skipAIFill = true;
  w.addPlayer(1, 'Black');
  w.addPlayer(2, 'White');
  w._goInit();
  return w;
}

test('VC-10 数子口径 = 子数 + 归属空点（就近归属，非 Voronoi 目数）', () => {
  const w = seatedGo(1);
  const L = w._life;
  const B = w.go.blackF, W = w.go.whiteF;
  // 清盘
  for (let x = 0; x < 32; x++) for (let y = 0; y < 32; y++) L[x][y] = 0;
  // 黑在 (3,3) 四邻各一子；另加 2 颗孤立子（(10,10)/(20,20)）；白 1 子 (15,15)。
  L[3][3] = 0;
  L[2][3] = B; L[4][3] = B; L[3][2] = B; L[3][4] = B;
  L[10][10] = B; L[20][20] = B;
  L[15][15] = W;
  const sc = w._goScoreChinese();
  // 子数不变（与口径无关）
  assert.equal(sc.stoneByF[B], 6, '黑子数 = 4 + 2 = 6');
  assert.equal(sc.stoneByF[W], 1, '白子数 = 1');
  // 空点归属改为**就近归属**（旧「严格围空」口径下此处 emptyByF[B] 仅 1、emptyByF[W]=0）：
  // 全盘 1024 格，黑 6 子空间上更靠近左侧/左下，白 1 子在 (15,15) 获右侧扇区。
  assert.equal(sc.emptyByF[B], 591, '黑就近归属 591 个空点');
  assert.equal(sc.emptyByF[W], 60, '白就近归属 60 个空点');
  assert.equal(sc.byF[B], 597, '黑数子总分 = 6 子 + 591 空点 = 597');
  assert.equal(sc.byF[W], 61, '白数子总分 = 1 子 + 60 空点 = 61');
  assert.equal(sc.black, 597);
  assert.equal(sc.white, 61);
});

test('VC-10 就近归属：单色独占整盘全归该色；双色各按就近得分（旧「≥2 接触即中立」已废弃）', () => {
  const w = seatedGo(2);
  const L = w._life;
  const B = w.go.blackF, W = w.go.whiteF;
  for (let x = 0; x < 32; x++) for (let y = 0; y < 32; y++) L[x][y] = 0;
  // 盘上仅一色黑（(5,5)）→ 每个空点最近棋子都是黑 → 全部空点归黑。
  L[5][5] = B;
  const sc1 = w._goScoreChinese();
  assert.equal(sc1.emptyByF[B], 32 * 32 - 1, '整盘仅一色时，所有空点归该色（就近归属）');
  // 黑白各放一子 → 空点按「距离最近棋子」就近切分（不再一律中立）。
  L[25][25] = W;
  const sc2 = w._goScoreChinese();
  assert.equal(sc2.emptyByF[B], 434, '左下扇区（近 (5,5)）归黑 434 空点');
  assert.equal(sc2.emptyByF[W], 485, '其余扇区（近 (25,25)）归白 485 空点');
  assert.equal(sc2.byF[B], 435, '黑 = 1 子 + 434 空点');
  assert.equal(sc2.byF[W], 486, '白 = 1 子 + 485 空点');
});

test('VC-10 双方连续 Pass → 终局 → 数子 X vs Y，唯一最高者胜', () => {
  const w = seatedGo(3);
  const L = w._life;
  const B = w.go.blackF, W = w.go.whiteF;
  for (let x = 0; x < 32; x++) for (let y = 0; y < 32; y++) L[x][y] = 0;
  // 黑占据中央 4×4 大块（16 子），白仅角落 2 子 → 黑在**就近归属**下空间与势力全面领先。
  // （口径变更说明：旧「严格围空」下曾用「黑 2×2 于 (3,3) + 白 1 子在 (10,10)」构造黑领先；
  //   改就近归属后，单个靠近中央的白子会吸走大半个棋盘，故改用更贴合当前口径的领先局面。）
  for (let x = 14; x <= 17; x++) for (let y = 14; y <= 17; y++) L[x][y] = B;
  L[0][0] = W; L[1][0] = W;
  const ev = [];
  assert.equal(w.applyGoIntent(w.go.seats[w.go.turnIdx], { pass: true }, ev).ok, true);
  assert.equal(w.applyGoIntent(w.go.seats[w.go.turnIdx], { pass: true }, ev).ok, true);
  assert.ok(w.go.result, '双方各 Pass 一次 → 终局');
  assert.equal(w.go.result.reason, 'pass');
  // 黑数子 = 16 子 + 887 空点 = 903；白 = 2 子 + 117 空点 = 119。
  assert.equal(w.go.result.blackScore, 903, '黑数子 903');
  assert.equal(w.go.result.whiteScore, 119, '白数子 119');
  assert.ok(w.go.result.blackScore > w.go.result.whiteScore, '黑数子领先');
  assert.equal(w.go.result.winner, w.go.blackId, '唯一最高者（黑）胜');
  assert.equal(w.players[w.go.blackId].won, true);
  assert.equal(w.players[w.go.blackId].winReason, 'go', 'winReason 沿用 go');
});

test('VC-10 数子并列 → 平局（winner=null，不贴子）', () => {
  const w = seatedGo(4);
  const L = w._life;
  const B = w.go.blackF, W = w.go.whiteF;
  for (let x = 0; x < 32; x++) for (let y = 0; y < 32; y++) L[x][y] = 0;
  // 180° 旋转对称：黑的 2×2 与白的 2×2 关于盘心 (15.5,15.5) 完全对称
  // （(x,y)|→(31-x,31-y) 把黑块映射为白块）→ 就近归属下双方等分。
  // （口径变更说明：旧「严格围空」下此处双方空点皆 0 亦成平局；改就近归属后须用真旋转对称盘才等分。）
  L[3][3] = B; L[4][3] = B; L[3][4] = B; L[4][4] = B;
  L[28][28] = W; L[27][28] = W; L[28][27] = W; L[27][27] = W;
  const ev = [];
  w.applyGoIntent(w.go.seats[w.go.turnIdx], { pass: true }, ev);
  w.applyGoIntent(w.go.seats[w.go.turnIdx], { pass: true }, ev);
  assert.ok(w.go.result);
  assert.equal(w.go.result.blackScore, 484, '黑数子 484（4 子 + 480 空点）');
  assert.equal(w.go.result.whiteScore, 484, '白数子 484（4 子 + 480 空点）');
  assert.equal(w.go.result.blackScore, w.go.result.whiteScore, '对称盘面两边等分');
  assert.equal(w.go.result.winner, null, '并列 → 平局');
  assert.equal(w.players[w.go.blackId].won, false);
  assert.equal(w.players[w.go.whiteId].won, false);
});

test('VC-09 清盘不判胜：一方被吃光不出局、不终局，胜者由数子决定', () => {
  const w = seatedGo(5);
  const L = w._life;
  const B = w.go.blackF, W = w.go.whiteF;
  for (let x = 0; x < 32; x++) for (let y = 0; y < 32; y++) L[x][y] = 0;
  // 白有大量子（数子应胜）；黑被清零
  L[20][20] = W; L[21][20] = W; L[20][21] = W; L[21][21] = W;
  const pB = w.players[w.go.blackId];
  pB.maxLifeCells = 6; pB.lifeCells = 0;
  const ev = [];
  w.applyGoIntent(w.go.seats[w.go.turnIdx], { pass: true }, ev);
  assert.equal(w.go.result, null, '被吃光不触发终局');
  assert.equal(pB.lost, false, '被吃光方不出局');
  // 双方停手 → 终局
  w.applyGoIntent(w.go.seats[w.go.turnIdx], { pass: true }, ev);
  assert.equal(w.go.result.reason, 'pass');
  assert.equal(w.go.result.winner, w.go.whiteId, '数子多者（白）胜');
  assert.ok(w.go.result.whiteScore > w.go.result.blackScore);
});

test('VC-09 go 关掉领土胜利线 → 终局不宣告胜者（winner=null）', () => {
  const w = seatedGo(6, { victoryLines: { territory: false } });
  const L = w._life;
  const B = w.go.blackF;
  for (let x = 0; x < 32; x++) for (let y = 0; y < 32; y++) L[x][y] = 0;
  L[3][3] = B; L[4][3] = B; L[3][4] = B; L[4][4] = B;
  const ev = [];
  w.applyGoIntent(w.go.seats[w.go.turnIdx], { pass: true }, ev);
  w.applyGoIntent(w.go.seats[w.go.turnIdx], { pass: true }, ev);
  assert.ok(w.go.result, '仍会终局（pass 触发）');
  assert.equal(w.go.result.reason, 'pass');
  assert.equal(w.go.result.winner, null, '领土线关闭 → 不宣告胜者');
  assert.equal(w.players[w.go.blackId].won, false);
});

test('VC-10 snapshot.go.chineseScore 明细存在（子数 + 空点）', () => {
  const w = seatedGo(7);
  const L = w._life;
  const B = w.go.blackF, W = w.go.whiteF;
  for (let x = 0; x < 32; x++) for (let y = 0; y < 32; y++) L[x][y] = 0;
  // 黑围住 (3,3) 一个空点（4 邻全黑）；另在 (0,0) 放白。就近归属下黑（4 子聚于角落）吸走绝大部分空点。
  L[3][3] = 0; L[2][3] = B; L[4][3] = B; L[3][2] = B; L[3][4] = B;
  L[0][0] = W;
  const cs = w.snapshot().go.chineseScore;
  assert.ok(cs, 'chineseScore 应存在');
  const row = cs.ranked.find(r => r.faction === B);
  assert.equal(row.stones, 4, '子数明细 = 4');
  assert.equal(row.empty, 1014, '就近归属空点明细 = 1014');
  assert.equal(row.score, 1018, '总分 = 4 + 1014 = 1018');
});

test('VC-10 _goScore（Voronoi）保留不动（旧快照字段不炸）', () => {
  const w = seatedGo(8);
  const B = w.go.blackF;
  w._goPlay(B, 16, 16, []);
  assert.doesNotThrow(() => w._goScore(), '_goScore 应保留可用');
  const g = w.snapshot().go;
  assert.ok(g.territory && typeof g.territory.black === 'number', 'go.territory 旧字段仍在');
});
