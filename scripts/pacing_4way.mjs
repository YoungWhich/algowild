// scripts/pacing_4way.mjs — 4 方抢地节奏探测（v7 长局目标 ≥30min/局）
// 把 4 个槽位全部当 AI 驱动（公平赛跑）：测"首个胜利何时出现 + 领土如何分布"。
// 运行：node scripts/pacing_4way.mjs [seed] [maxSeconds]
import { World, loadKernels } from '../server/engine.js';
import { makeAIPlayer } from '../server/ai.js';

await loadKernels();

function run(seed, maxSec) {
  const maxTicks = maxSec * 20;
  const w = new World('w' + seed, 1, seed);
  // 手动塞 4 个 AI（全 isAI=true，stepAI 会驱动全部）
  // 镜像引擎 _maybeAddAI：AI 也要 _stampStartEra（era0 单细胞起跑，30s 后演化解锁种子）
  for (let i = 0; i < 4; i++) {
    const ai = makeAIPlayer(w, w._rng);
    World._stampStartEra(ai);
    ai.isAI = true;
  }
  for (const p of Object.values(w.players)) { p.isAI = true; }

  let winner = null, losers = [];
  const report = { seed, maxSec, firstWinAt: null, regionShare: null, ended: 'none' };
  const t0 = Date.now();
  for (let t = 0; t < maxTicks; t++) {
    w.tickOnce();
    if (!winner) {
      winner = Object.values(w.players).find(p => p.won);
      if (winner) {
        report.firstWinAt = +(w.tick / 20).toFixed(1);
        report.winner = winner.name;
        report.winnerReason = winner.winReason;
        report.winnerRegions = winner.regionsOwned;
        report.winnerEra = winner.eraName;
        report.ended = 'victory';
      }
    }
    // 每 60s 记录一次领土分布，用于观察"是否真的在抢地"
    if (t % 1200 === 0 && t > 0) {
      const regs = Object.values(w.players).map(p => `${p.name}:${p.regionsOwned || 0}`).join(' ');
      if (t === 1200) report.t60 = regs;
      if (t === 7200) report.t360 = regs;      // 6min
      if (t === 21600) report.t1080 = regs;    // 18min
    }
  }
  if (!winner) {
    report.ended = 'timeout';
    report.tfinal = Object.values(w.players).map(p => `${p.name}:${p.regionsOwned || 0}`).join(' ');
  }
  report.runMs = Date.now() - t0;
  return report;
}

const seed = parseInt(process.argv[2] || '7', 10);
const maxSec = parseInt(process.argv[3] || '3000', 10); // 默认 50 分钟上限
console.log(JSON.stringify(run(seed, maxSec), null, 2));
