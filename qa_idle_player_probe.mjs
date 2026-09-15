// qa_idle_player_probe.mjs — 诊断探针："玩家站着不动就能赢" 的根因定位
// ---------------------------------------------------------------------------
// 场景：1 个真人玩家（**完全不给任何输入，模拟挂机**）+ 2 个 AI。
// 目标：跑到 60000 tick（50 分钟 @20TPS），记录：
//   - 哪一方、在第几 tick、因为哪条 winReason 先触发胜利
//   - 玩家的 era / regionsOwned / score / stock（看"不动"能拿到多少收益）
//   - AI 的 era / regionsOwned / score
//   - 潮汐捕食者（hostile 实体）是否真的出现、数量如何
// 只诊断，不改任何源码。确定性：固定种子，可复现。
// ---------------------------------------------------------------------------
import { World, loadKernels } from './server/engine.js';
import { makeAIPlayer } from './server/ai.js';
import { mulberry32 } from './server/util.js';

const SEED = 12345;
const AI_RNG_SEED = 123;
const N = 60000;
const REPORT_EVERY = 5000;

await loadKernels();

const w = new World('qa-idle', 'owner', SEED, { mode: 'rts' });
w.started = true;
w._skipAIFill = true;

// 1) 真人玩家（挂机）：用最接近入场的路径加入，但不发任何 intent
const human = w.addPlayer('human_1', '挂机玩家');
// 2) 两个 AI
const aiRng = mulberry32(AI_RNG_SEED);
const ais = [];
for (let i = 0; i < 2; i++) {
  const ai = makeAIPlayer(w, aiRng);
  World._stampStartEra(ai);
  ais.push(ai);
}

console.log(`[setup] seed=${SEED} ticks=${N} 玩家=${human.name}(挂机) AIs=${ais.map(a => a.name).join(',')}`);
console.log(`[setup] 胜利线: territory(era>=3 & regions>=${World.TERRITORY_WIN}) | economy(lead>=600 & regions>=10 & era>=3 持续1800t) | singularity(6资源各>=30) | survival(仅剩1方且原有多方)\n`);

const evLog = [];
let winner = null;

for (let t = 0; t < N; t++) {
  const { events } = w.tickOnce();
  for (const ev of events || []) {
    if (ev.type === 'victory') {
      evLog.push({ tick: t, playerId: ev.playerId, reason: ev.reason });
      if (!winner) winner = { tick: t, playerId: ev.playerId, reason: ev.reason };
    }
    if (ev.type === 'eliminated') {
      evLog.push({ tick: t, playerId: ev.playerId, reason: 'eliminated:' + ev.reason });
    }
    if (ev.type === 'tide_surge' && t < 100) evLog.push({ tick: t, reason: 'tide_surge#' + ev.surge });
  }
  if (winner) break;

  if ((t + 1) % REPORT_EVERY === 0) {
    const hostileN = w.entities.filter(e => e.faction === 'hostile' && e.hp > 0).length;
    const totalEnt = w.entities.length;
    const p = human;
    const stock = p._stock || {};
    const stockSum = Object.values(stock).reduce((a, b) => a + b, 0);
    console.log(
      `t=${String(t + 1).padStart(5)} | 玩家: era=${p.era}(${p.eraName}) regions=${p.regionsOwned} life=${p.lifeCells} score=${p.score} stockSum=${stockSum} alive=${p.alive}` +
      ` | hostile实体=${hostileN}/${totalEnt} | tide=${w.tide.phase}` +
      ` | AIs: ` + ais.map(a => `${a.name.slice(0, 6)}:era${a.era}/r${a.regionsOwned}/s${a.score}${a.lost ? '(OUT)' : ''}`).join(' ')
    );
  }
}

console.log('\n===== QA IDLE PLAYER PROBE =====');
console.log(`winner=${winner ? JSON.stringify(winner) : 'none (未在 ' + N + ' tick 内结束)'}`);
if (winner) {
  const who = winner.playerId === human.id ? '★玩家(挂机)' : (ais.find(a => a.id === winner.playerId)?.name || winner.playerId);
  console.log(`谁赢了: ${who}, 原因=${winner.reason}, tick=${winner.tick} (${(winner.tick / 20 / 60).toFixed(1)} 分钟)`);
}
console.log('关键事件(前20条):');
for (const e of evLog.slice(0, 20)) console.log('  ', JSON.stringify(e));

const p = human;
const stock = p._stock || {};
console.log('\n玩家最终:', JSON.stringify({
  won: p.won, lost: p.lost, winReason: p.winReason, era: p.era, eraName: p.eraName,
  regionsOwned: p.regionsOwned, lifeCells: p.lifeCells, score: p.score,
  aliveTicks: p.aliveTicks, stockSum: Object.values(stock).reduce((a, b) => a + b, 0),
}));
for (const a of ais) {
  console.log(`AI ${a.name}:`, JSON.stringify({ won: a.won, lost: a.lost, winReason: a.winReason, era: a.era, regionsOwned: a.regionsOwned, lifeCells: a.lifeCells, score: a.score }));
}
