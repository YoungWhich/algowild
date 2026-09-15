// qa_rts_ai_capture_probe.mjs
// ---------------------------------------------------------------------------
// 验收探针：验证 rts `stepAI` 这次改动后，AI 真的能占领区域（regionsOwned >= 1），
// 而不只是"不报错"。
//
// 改动核心：旧实现"单颗落子（康威必死）"永远占不下区 → 改为"在目标区中心顺序种
// 2x2 可存活团"，配合更强的战斗/发育/决策频率。
//
// 复现服务器 tick 循环：每 tick 调用 world.tickOnce()，它内部依次执行
//   - stepAI(this, this.intentQueue)   // 注入 AI 决策到 IntentQueue
//   - drain intents + applyImpulse     // 把意图应用到 world
//   - 生命棋盘演化 / Voronoi 归属 / _updateRegionControl(写入 regionsOwned)
// 即与服务器（net.js / index.js 的 w.tickOnce()）逐拍一致。
//
// 确定性：固定世界种子 SEED + 固定 AI 创建 rng（mulberry32(AI_RNG_SEED)），
// 结果可复现。
// ---------------------------------------------------------------------------
import { World, loadKernels } from './server/engine.js';
import { makeAIPlayer } from './server/ai.js';
import { mulberry32 } from './server/util.js';

const SEED = 12345;          // 世界种子：决定 terrain/resources/voronoi/tide（确定性）
const AI_RNG_SEED = 123;     // AI 玩家创建用的确定性 rng
const N = 3000;              // 跑 3000 tick（150s @ 20TPS）
const REPORT_EVERY = 500;    // 每 500 tick 打印一次快照

await loadKernels();         // 必须：stepAI 的 A* / 领地归属的 voronoi 都需要内核

// 1) 建一个 rts 世界（与测试一致：new World(id, ownerId, seed, { mode: 'rts' })）
const w = new World('qa-capture', 'owner', SEED, { mode: 'rts' });
w.started = true;            // 模拟"开始游戏"
w._skipAIFill = true;        // 不自动补 AI（手动加）

// 2) 用 makeAIPlayer 加 2 个 AI 玩家（确定性 rng），并补上 era 初始化（与 addAI 一致）
const aiRng = mulberry32(AI_RNG_SEED);
const ais = [];
for (let i = 0; i < 2; i++) {
  const ai = makeAIPlayer(w, aiRng);
  World._stampStartEra(ai);  // 同步 addAI 的纪元初始化（_speedCap/_seedMul 等）
  ais.push(ai);
}

console.log(`[setup] world seed=${SEED}, aiRng seed=${AI_RNG_SEED}, AIs=${ais.map(a => a.name).join(',')}`);
console.log(`[setup] tickOnce() 内部即 stepAI+apply，逐拍复现服务器循环\n`);

let errors = 0;
let firstCaptureTick = -1;
let maxRegionsAnyAI = 0;

for (let t = 0; t < N; t++) {
  try {
    w.tickOnce();
  } catch (e) {
    errors++;
    console.error(`[ERROR] tick ${t} threw:`, e && e.stack ? e.stack : e);
    if (errors > 5) { console.error('[ERROR] 错误过多，提前终止'); break; }
  }

  // 追踪：首个 AI 占区 tick / 历史最大占区数
  for (const ai of ais) {
    if (ai.regionsOwned >= 1 && firstCaptureTick < 0) firstCaptureTick = t;
    if (ai.regionsOwned > maxRegionsAnyAI) maxRegionsAnyAI = ai.regionsOwned;
  }

  if ((t + 1) % REPORT_EVERY === 0 || t === N - 1) {
    const parts = [`tick=${(t + 1).toString().padStart(4)}`];
    for (const ai of ais) {
      const g = ai._aiGoal;
      const goalInfo = g ? `goal(r=${g.r},placed=${g.placed.size}/4)` : 'noGoal';
      parts.push(
        `${ai.name}: regions=${ai.regionsOwned} lifeCells=${ai.lifeCells} ` +
        `seeds=${ai.seeds} alive=${ai.alive} ${goalInfo} @(${ai.x.toFixed(1)},${ai.y.toFixed(1)})`
      );
    }
    console.log(parts.join(' | '));
  }
}

// ---- 最终断言 ----
const anyCaptured = ais.some(ai => ai.regionsOwned >= 1);

console.log('\n===== QA RTS AI CAPTURE PROBE =====');
console.log(`world seed=${SEED}, aiRng seed=${AI_RNG_SEED}, ticks=${N}`);
console.log(`errors=${errors}, firstCaptureTick=${firstCaptureTick}, maxRegionsAnyAI=${maxRegionsAnyAI}`);
console.log(`anyCaptured(regionsOwned>=1)=${anyCaptured}`);
for (const ai of ais) {
  console.log(
    `  ${ai.name}: regionsOwned=${ai.regionsOwned}, lifeCells=${ai.lifeCells}, ` +
    `seeds=${ai.seeds}, alive=${ai.alive}, deaths=${ai.deaths || 0}, lost=${ai.lost}`
  );
}

if (errors > 0) {
  console.log('\nRESULT: FAIL — 运行期抛错 ' + errors + ' 次（见上方 ERROR）');
  process.exitCode = 1;
} else if (anyCaptured) {
  console.log('\nRESULT: PASS — 至少一个 AI 成功占领区域 (regionsOwned>=1)');
  process.exitCode = 0;
} else {
  console.log('\nRESULT: FAIL — 跑满 3000 tick 仍无任何 AI 占下区域');
  process.exitCode = 1;
}
