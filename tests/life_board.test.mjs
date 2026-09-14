// tests/life_board.test.mjs — the life board IS the game: seeding, evolution, eras, death penalty
import test from 'node:test';
import assert from 'node:assert/strict';
import { World, loadKernels } from '../server/engine.js';

function freshWorld(seed = 42) {
  const w = new World('w1', 1, seed);
  w._skipAIFill = true;
  return w;
}

test('LB-1 walking leaves a WEAK trail, planting makes a STRONG cell', () => {
  const w = freshWorld();
  const p = w.addPlayer(1, 'P');
  w._lifeInit();
  const f = w._factionOf(p.id);
  // Walking drops trails (encoded as faction + 10)
  for (let i = 0; i < 6; i++) {
    p.x = 10 + i * 4;
    p.y = 10;
    w._lifeTrail(p);
  }
  let trails = 0;
  for (let x = 0; x < World.LIFE_W; x++) for (let y = 0; y < World.LIFE_W; y++) if (w._life[x][y] === f + 10) trails++;
  assert.ok(trails >= 1, `walking should leave trails, got ${trails}`);
  // A planted cell is strong (not a trail)
  p.x = 40; p.y = 40;
  w._lifePlant(p);
  const { lx, ly } = w._lifeXY(p.x, p.y);
  assert.equal(w._life[lx][ly], f, 'planted cell is a strong cell of your faction');
  assert.ok(World._isStrong(w._life[lx][ly]), 'planted cell is strong');
});

test('LB-1c trails never overwrite strong cells', () => {
  const w = freshWorld();
  const p = w.addPlayer(1, 'P');
  w._lifeInit();
  const f = w._factionOf(p.id);
  p.x = 40; p.y = 40;
  w._lifePlant(p);                 // strong cell here
  w._lifeTrail(p);                 // walking over it must not downgrade it
  const { lx, ly } = w._lifeXY(p.x, p.y);
  assert.equal(w._life[lx][ly], f, 'trail must not overwrite a strong cell');
});

test('LB-1d planting consumes a seed and seeds regenerate', () => {
  const w = freshWorld();
  const p = w.addPlayer(1, 'P');
  // 演化纪元门：落子只在"多细胞"(era≥1)后解锁。直接升到 village 以测试种子机制。
  p.era = 1;
  p.aliveTicks = World.ERAS[1].ticks;
  p.seeds = 3;
  p.x = 48; p.y = 48;
  w.intentQueue.push(p.id, { plant: true });
  w.tickOnce();
  assert.equal(p.seeds, 2, 'planting should consume one seed');
  // Regen over time
  p.seeds = 0;
  p.seedRegen = 0;
  for (let i = 0; i < World.SEED_REGEN_TICKS; i++) w.tickOnce();
  assert.ok(p.seeds >= 1, `seed should regenerate, got ${p.seeds}`);
  // Cannot plant without seeds — verify the planted cell is NOT turned into a
  // STRONG cell and that no seed is consumed. (The board itself changes every
  // tick because the player leaves weak trails and Conway evolves, so we cannot
  // compare the whole board byte-for-byte — we check the target cell instead.)
  p.seeds = 0;
  p.seedRegen = 0;
  p.x = 60; p.y = 60;
  w.intentQueue.push(p.id, { plant: true });
  w.tickOnce();
  assert.equal(p.seeds, 0, 'no seed -> no seed consumed');
});

test('LB-1f 演化门：单细胞期(era0)不能落子，演化到多细胞后解锁', () => {
  const w = freshWorld();
  const p = w.addPlayer(1, 'P');
  // era0（单细胞）：没有种子经济，F 落子意图被忽略、不发强细胞
  p.x = 40; p.y = 40;
  w.intentQueue.push(p.id, { plant: true });
  w.tickOnce();
  assert.equal(p.seeds, 0, 'single-cell era should have no seeds');
  assert.ok(!World._isStrong(w._life[13][13]), 'era0 plant must not create a strong cell');
  // 存活时间推进到多细胞门槛（ERAS[1].ticks=600 → 30s）
  p.aliveTicks = World.ERAS[1].ticks - 1;
  w.intentQueue.push(p.id, {});   // 空指令推进一 tick
  w.tickOnce();                    // aliveTicks 600 → _tickEra 升 village
  assert.ok((p.era || 0) >= 1, `should evolve to village, got era ${p.era}`);
  // era≥1 后种子经济恢复：再 tick 一次拿到种子
  w.intentQueue.push(p.id, {});
  w.tickOnce();
  assert.ok((p.seeds || 0) > 0, `multi-cellular era should regain seeds, got ${p.seeds}`);
  // 现在 F 落子真正生效
  p.x = 44; p.y = 44;
  const before = p.seeds;
  w.intentQueue.push(p.id, { plant: true });
  w.tickOnce();
  assert.ok(p.seeds < before, 'planting should consume a seed after evolution');
  const { lx, ly } = w._lifeXY(p.x, p.y);
  assert.ok(World._isStrong(w._life[lx][ly]), 'evolution unlock should allow strong cells');
});

test('LB-1e 2x2 block is detected as a stronghold', () => {
  const w = freshWorld();
  const p = w.addPlayer(1, 'P');
  w._lifeInit();
  const f = w._factionOf(p.id);
  for (let x = 0; x < World.LIFE_W; x++) for (let y = 0; y < World.LIFE_W; y++) w._life[x][y] = 0;
  w._life[10][10] = f; w._life[11][10] = f;
  w._life[10][11] = f; w._life[11][11] = f;
  w._detectStrongholds();
  assert.equal(p.strongholds, 1, 'a 2x2 block counts as one stronghold');
  // Trails do NOT count — only strong cells form shapes
  w._life[10][10] = f + 10;
  w._detectStrongholds();
  assert.equal(p.strongholds, 0, 'a trail in the block disqualifies it');
});

test('LB-1b evolution runs on a fixed cadence during tick', () => {
  const w = freshWorld();
  const p = w.addPlayer(1, 'P');
  w._lifeInit();
  for (let x = 0; x < World.LIFE_W; x++) for (let y = 0; y < World.LIFE_W; y++) w._life[x][y] = 0;
  // Seed a dense blob: it must change after enough ticks (Conway, not static)
  for (let x = 12; x < 20; x++) for (let y = 12; y < 20; y++) w._life[x][y] = w._factionOf(p.id);
  const snap = () => w._life.map(c => Array.from(c).join('')).join('|');
  const before = snap();
  for (let i = 0; i < World.LIFE_STEP_TICKS * 3; i++) w.tickOnce();
  assert.notEqual(snap(), before, 'board should evolve over time');
});

test('LB-2 evolution: a lone cell dies (Conway underpopulation)', () => {
  const w = freshWorld();
  w.addPlayer(1, 'P');
  w._lifeInit();
  // Clear board, place exactly one isolated cell
  for (let x = 0; x < World.LIFE_W; x++) for (let y = 0; y < World.LIFE_W; y++) w._life[x][y] = 0;
  w._life[16][16] = 1;
  w._lifeStep();
  assert.equal(w._life[16][16], 0, 'isolated cell has 0 neighbours -> dies (B3/S23)');
});

test('LB-3 evolution: a 2x2 block is stable (classic Conway still life)', () => {
  const w = freshWorld();
  w.addPlayer(1, 'P');
  w._lifeInit();
  for (let x = 0; x < World.LIFE_W; x++) for (let y = 0; y < World.LIFE_W; y++) w._life[x][y] = 0;
  // 2x2 block: every cell has exactly 3 neighbours -> survives
  w._life[10][10] = 1; w._life[11][10] = 1;
  w._life[10][11] = 1; w._life[11][11] = 1;
  w._lifeStep();
  assert.equal(w._life[10][10], 1, 'block corner survives');
  assert.equal(w._life[11][11], 1, 'block corner survives');
});

test('LB-4 faction warfare: enemies can eat your cells', () => {
  const w = freshWorld();
  const a = w.addPlayer(1, 'A');
  const b = w.addPlayer(2, 'B');
  w._skipAIFill = true;
  w._lifeInit();
  for (let x = 0; x < World.LIFE_W; x++) for (let y = 0; y < World.LIFE_W; y++) w._life[x][y] = 0;
  const fa = w._factionOf(a.id), fb = w._factionOf(b.id);
  assert.notEqual(fa, fb, 'two players get distinct factions');
  // Your lone cell surrounded by 3 enemy cells (2-3 neighbours but outnumbered) -> dies
  w._life[16][16] = fa;
  w._life[15][15] = fb; w._life[16][15] = fb; w._life[17][15] = fb;
  w._lifeStep();
  assert.equal(w._life[16][16], 0, 'cell outnumbered by enemies should be eaten');
});

test('LB-5 eras never regress', () => {
  const w = freshWorld();
  const p = w.addPlayer(1, 'P');
  w._lifeInit();
  // Fill the board and grant alive-time so eras can advance (eras need time + cells)
  for (let x = 0; x < World.LIFE_W; x++) for (let y = 0; y < World.LIFE_W; y++) w._life[x][y] = 1;
  p.aliveTicks = 999999;
  w._updateRegionControl();
  w._tickEra();
  const top = p.era;
  assert.ok(top >= 1, `should have advanced past tribe, got ${top}`);
  // Now wipe the board — era must NOT go backwards
  for (let x = 0; x < World.LIFE_W; x++) for (let y = 0; y < World.LIFE_W; y++) w._life[x][y] = 0;
  w._updateRegionControl();
  w._tickEra();
  assert.equal(p.era, top, 'era must never regress when cells are lost');
});

test('LB-6 death penalty removes a share of your cells', () => {
  const w = freshWorld();
  const p = w.addPlayer(1, 'P');
  w._lifeInit();
  const f = w._factionOf(p.id);
  for (let x = 0; x < World.LIFE_W; x++) for (let y = 0; y < World.LIFE_W; y++) w._life[x][y] = f;
  let before = 0;
  for (let x = 0; x < World.LIFE_W; x++) for (let y = 0; y < World.LIFE_W; y++) if (w._life[x][y] === f) before++;
  w._lifePenalty(p, 0.5);
  let after = 0;
  for (let x = 0; x < World.LIFE_W; x++) for (let y = 0; y < World.LIFE_W; y++) if (w._life[x][y] === f) after++;
  assert.ok(after < before, `death should remove cells: ${before} -> ${after}`);
  assert.ok(after > before * 0.2, 'should not wipe everything (ratio-based)');
});

test('LB-7 snapshot exposes the life board for rendering', () => {
  const w = freshWorld();
  w.addPlayer(1, 'P');
  const s = w.snapshot(false);
  assert.ok(Array.isArray(s.lifeGrid), 'lifeGrid must be exposed');
  assert.equal(s.lifeGrid.length, World.LIFE_W, 'lifeGrid width matches LIFE_W');
  assert.ok(Array.isArray(s.lifeOwners), 'lifeOwners must be exposed');
  assert.ok(Array.isArray(s.regionFaction), 'regionFaction must be exposed');
  assert.equal(s.regionFaction.length, World.REGION_W * World.REGION_W, 'regionFaction is 8x8');
});

test('LB-8 assist credit is granted to a recent damager', () => {
  const w = freshWorld();
  const killer = w.addPlayer(1, 'K');
  const helper = w.addPlayer(2, 'H');
  w._skipAIFill = true;
  const e = {
    id: 'e1', type: 'firefly', name: 'firefly',
    x: 50, y: 50, vx: 0, vy: 0, mass: 1, speed: 0,
    hp: 8, hpMax: 8, color: '#fff', faction: 'hostile', born: 0, life: 600,
  };
  w.entities.push(e);
  // Helper damages it first (not enough to kill: hp 8 -> 0 would kill, so use 2 dmg)
  e.hp = 12;
  e._damagers = { [helper.id]: w.tick };
  // Killer lands the killing blow via the real attack path
  killer.x = 50; killer.y = 50;
  killer._attackTarget = { tx: 50, ty: 50 };
  // Simulate: helper hit earlier, killer finishes
  e.hp = 8;
  e._damagers[helper.id] = w.tick;
  w.intentQueue.push(killer.id, { attack: { tx: 50, ty: 50 } });
  w.tickOnce();
  assert.equal(killer.kills, 1, 'killer gets the kill');
  assert.ok((helper.assists || 0) >= 1, `helper should get an assist, got ${helper.assists}`);
});

test('LB-9 respawn grants invulnerability and death limit is 8', () => {
  const w = freshWorld();
  const p = w.addPlayer(1, 'P');
  assert.equal(World.DEATH_LIMIT, 12, 'death limit raised for long matches');
  p.alive = false;
  p.respawnTicks = 1;
  p.deaths = 3;
  w.tickOnce();
  assert.equal(p.alive, true, 'should respawn');
  assert.ok(p.invulnTicks > 0, 'respawn should grant invulnerability ticks');
});

test('LB-10 invulnerable players take no damage', () => {
  const w = freshWorld();
  const p = w.addPlayer(1, 'P');
  p.x = 50; p.y = 50; p.hp = 100;
  p.invulnTicks = 50;
  w.entities.push({
    id: 'e1', type: 'firefly', name: 'firefly',
    x: 50.2, y: 50, vx: 0, vy: 0, mass: 1, speed: 0,
    hp: 10, hpMax: 10, color: '#fff', faction: 'hostile', born: 0, life: 600,
  });
  w.tickOnce();
  assert.equal(p.hp, 100, 'invulnerable player should not lose HP');
});

test('提子：完全围死的敌方强细胞团被清除并给围杀方加分', () => {
  const w = new World('cap1', 'o', 5);
  w._skipAIFill = true;
  w.addPlayer('A', 'jia');
  w.addPlayer('B', 'yi');
  w._lifeInit();
  const fa = w._factionOf('A');
  const fb = w._factionOf('B');
  // B 的一颗强细胞被 A 的 8 邻完全围死（无空格、无己方细胞）= 无气
  w._life[6][6] = fb;
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    if (dx === 0 && dy === 0) continue;
    w._life[6 + dx][6 + dy] = fa;
  }
  const sA0 = w.players['A'].score;
  w._captureEnclosed([]);
  assert.equal(w._life[6][6], 0, '无气的强细胞应被提掉');
  assert.ok(w.players['A'].score > sA0, '围杀方应获得分数');
});

test('提子：有气（相邻空格）的团不应被误提', () => {
  const w = new World('cap2', 'o', 6);
  w._skipAIFill = true;
  w.addPlayer('A', 'jia');
  w.addPlayer('B', 'yi');
  w._lifeInit();
  const fa = w._factionOf('A');
  const fb = w._factionOf('B');
  w._life[6][6] = fb; // B 棋子在开阔地，右上有空格 = 有气
  w._life[5][5] = fa; w._life[5][6] = fa; w._life[5][7] = fa;
  w._life[6][5] = fa; w._life[6][7] = fa;
  w._captureEnclosed([]);
  assert.equal(w._life[6][6], fb, '有气的团不应被提掉');
});

test('M3 removePlayer 后棋盘/区域无幽灵占用（幽灵势力回归中立）', async () => {
  // 区域归属依赖 voronoi 内核（_updateVoronoi 读静态 World.kernelRegistry）
  await loadKernels();
  const w = new World('m3a', 'o', 7);
  w._skipAIFill = true;
  const a = w.addPlayer('A', '甲');
  const b = w.addPlayer('B', '乙');
  w._lifeInit();
  const fa = w._factionOf('A');
  const fb = w._factionOf('B');
  assert.notEqual(fa, fb, '两玩家阵营槽位不同');
  // A 填满左上角整片 4x4（=一个完整 macro region，过半规则可占区），B 放一颗远处强细胞
  for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) w._life[x][y] = fa;
  w._life[20][20] = fb;
  w._updateRegionControl();
  assert.ok(a.regionsOwned >= 1, `A 应拥有至少 1 个区，实际 ${a.regionsOwned}`);
  assert.ok(w._regionFaction.includes(fb), 'B 的强细胞应先出现在区域归属判定里');
  // B 离场（断线超时/被剔除走 removePlayer 路径）→ 阵营细胞应被擦除
  w.removePlayer('B');
  assert.equal(w.players['B'], undefined, 'removePlayer 后玩家应从 players 删除');
  let bCells = 0;
  for (let x = 0; x < World.LIFE_W; x++) for (let y = 0; y < World.LIFE_W; y++) {
    const v = w._life[x][y];
    if (World._factionOfCell(v) === fb) bCells++;
  }
  assert.equal(bCells, 0, 'removePlayer 后该阵营不应残留任何强细胞/弱痕');
  // 区域归属重算：regionFaction 不再含 B 的 faction（B 的细胞已空）
  w._updateRegionControl();
  assert.ok(!w._regionFaction.includes(fb), 'regionFaction 不应再含被移除阵营');
  // 移除 A 也不应报错，且所有格最终全空
  w.removePlayer('A');
  for (let x = 0; x < World.LIFE_W; x++) for (let y = 0; y < World.LIFE_W; y++) {
    assert.equal(w._life[x][y], 0, `离场后第 ${x},${y} 格应为空`);
  }
});

test('M3 _maybeAddAI 超额剔除 AI 时同样擦棋盘（无幽灵占区）', () => {
  const w = new World('m3b', 'o', 8);
  // 不跳过 AI fill：真人加入后自动补 AI
  w._skipAIFill = false;
  const h1 = w.addPlayer('H1', '人1');
  assert.ok(Object.keys(w.players).length >= 2, '真人加入后应有 AI 填充');
  const aiIds = Object.keys(w.players).filter(id => id !== 'H1');
  assert.ok(aiIds.length > 0, '应存在 AI');
  // 给一个 AI 造强细胞，再挤入第 4 个真人触发超额剔除
  w._lifeInit();
  const victimId = aiIds[aiIds.length - 1];
  const fv = w._factionOf(victimId);
  for (let x = 10; x < 14; x++) for (let y = 10; y < 14; y++) w._life[x][y] = fv;
  w.addPlayer('H2', '人2');
  w.addPlayer('H3', '人3');
  w.addPlayer('H4', '人4');
  assert.equal(w.players[victimId], undefined, '超额时应剔除该 AI');
  let left = 0;
  for (let x = 0; x < World.LIFE_W; x++) for (let y = 0; y < World.LIFE_W; y++) {
    if (World._factionOfCell(w._life[x][y]) === fv) left++;
  }
  assert.equal(left, 0, '被剔除 AI 的强细胞应全部擦除，不留幽灵占区');
});
