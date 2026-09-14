// scripts/qa_m3_wipe_probe.mjs — QA 独立复核：M3 阵营擦除的完整性 + _life 未初始化守卫
// 断言点：
//  1) removePlayer 后「强细胞」(v === f) 是否清零
//  2) removePlayer 后「弱痕/痕迹」(v === f + 10) 是否也清零（M3 代码注释声称"强细胞/弱痕"都擦）
//  3) _life 从未初始化时 removePlayer 是否安全（_lifeWipeFaction 的 if (!this._life) return）
import { World } from '../server/engine.js';

const results = [];
const check = (n, ok, d) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}: ${n} — ${d}`); };

// ---- 用例 1：正常对局后离场 ----
{
  const w = new World('w1', 1, 42);
  w._skipAIFill = true;
  w.addPlayer(1, 'P');
  // 让 P 移动留痕 + 触发演化出生强细胞
  for (let i = 0; i < 400; i++) {
    w.intentQueue.push(1, { move: { dx: Math.cos(i / 7), dy: Math.sin(i / 5) }, attack: null, build: null, tech: null, dash: null, plant: true, chat: null });
    w.tickOnce();
  }
  const f = w._factionOf(1);
  let strong = 0, trail = 0;
  for (let x = 0; x < w._life.length; x++) for (let y = 0; y < w._life.length; y++) {
    const v = w._life[x][y];
    if (v === f) strong++;
    else if (v === f + 10) trail++;
  }
  console.log(`[离场前] faction=${f} 强细胞=${strong} 弱痕=${trail}`);
  w.removePlayer(1);
  let s2 = 0, t2 = 0;
  for (let x = 0; x < w._life.length; x++) for (let y = 0; y < w._life.length; y++) {
    const v = w._life[x][y];
    if (v === f) s2++;
    else if (v === f + 10) t2++;
  }
  console.log(`[离场后] faction=${f} 强细胞=${s2} 弱痕=${t2}`);
  check('M3-a 强细胞被擦除', s2 === 0, `强细胞 ${strong} → ${s2}`);
  check('M3-b 弱痕(痕迹)也被擦除', t2 === 0, `弱痕 ${trail} → ${t2}  (未擦除=${t2} 格残留，会随 TRAIL_DECAY=0.35 自然枯萎，但非确定性擦除)`);
  check('M3-c players 已移除', !w.players[1], `players=${Object.keys(w.players).join(',')}`);
}

// ---- 用例 2：_life 从未初始化时离场 ----
{
  const w = new World('w2', 2, 7);
  w._skipAIFill = true;
  w.addPlayer(9, 'Q');
  const beforeInit = !w._life;
  let threw = null;
  try { w.removePlayer(9); } catch (e) { threw = e; }
  check('M3-d 未初始化棋盘时 removePlayer 不抛异常', !threw, `threw=${threw && threw.message}`);
  check('M3-e 守卫未为离场者新建 _life', beforeInit && !w._life, `_life=${w._life ? '已创建(泄漏阵营槽)' : 'null(符合预期)'}`);
  check('M3-f 玩家已移除', !w.players[9], `players=${Object.keys(w.players).join(',')}`);
}

const failed = results.filter(r => !r).length;
console.log(`\n[SUMMARY] ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
