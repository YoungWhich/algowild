// scripts/qa_resource_fingerprint_probe.mjs — QA 独立复核：bakeResources 的"资源只减不增"前提是否成立
// 若存在任何"新增资源"路径，则按 resPoints.length 做失效指纹会在「同窗口内增 N 减 N」时失效。
import { World } from '../server/engine.js';

const count = (w) => w.resourcesFlat().filter(Boolean).length;

const w = new World('w1', 1, 42);
w._skipAIFill = true;
const c0 = count(w);
console.log(`[建世界后] 资源点数 = ${c0}`);

w.addPlayer(1, 'P');
const c1 = count(w);
console.log(`[addPlayer(真人)后] 资源点数 = ${c1}  Δ = ${c1 - c0}`);

w.addPlayer(2, 'Q');
const c2 = count(w);
console.log(`[addPlayer(第2人)后] 资源点数 = ${c2}  Δ = ${c2 - c1}`);

// 采集：模拟玩家走到资源格并采集
let gathered = 0;
for (let i = 0; i < 300 && gathered < 3; i++) {
  w.intentQueue.push(1, { move: { dx: Math.cos(i / 3), dy: Math.sin(i / 3) }, plant: false });
  const before = count(w);
  w.tickOnce();
  const d = before - count(w);
  if (d > 0) gathered += d;
}
const c3 = count(w);
console.log(`[采集 ${gathered} 个后] 资源点数 = ${c3}  Δ = ${c3 - c2}`);

// 关键场景：同一 20-tick 缓存窗口内「新增 N 个 + 采集 N 个」→ length 不变但内容变了
const w2 = new World('w2', 1, 7);
w2._skipAIFill = true;
const ptsA = w2._resourcePoints().map(p => p.join(',')).join('|');
const lenA = w2._resourcePoints().length;
w2.addPlayer(1, 'P');            // 新增最多 5 个资源
const lenMid = w2._resourcePoints().length;
const needRemove = lenMid - lenA;
let removed = 0;
for (let x = 0; x < 192 && removed < needRemove; x++) {
  for (let y = 0; y < 192 && removed < needRemove; y++) {
    if (w2.resources[x][y]) { w2.resources[x][y] = 0; removed++; }
  }
}
const ptsB = w2._resourcePoints().map(p => p.join(',')).join('|');
const lenB = w2._resourcePoints().length;
console.log(`\n[指纹失效场景] length: ${lenA} → ${lenB}（相同=${lenA === lenB}），内容相同=${ptsA === ptsB}`);
console.log(lenA === lenB && ptsA !== ptsB
  ? 'CONFIRMED: 「长度相同但内容不同」可复现 → 按 length 做失效指纹会漏更新（客户端有 20 帧强制刷新兜底，陈旧窗口 ≤ ~0.33s）'
  : '未复现长度相同内容不同的场景');
