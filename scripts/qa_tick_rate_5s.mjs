// scripts/qa_tick_rate_5s.mjs — QA 独立复核：5s 长窗 tick 速率实测（设计要求 20 TPS）
// 用法：node scripts/qa_tick_rate_5s.mjs http://127.0.0.1:17003 [windowMs]
// 输出：snap 数、相邻 tick 差分布、实测 tick/s、相邻 snap 的墙钟间隔分布（ms）
import { WebSocket } from 'ws';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.argv[2] || 'http://127.0.0.1:17003';
const WINDOW = Number(process.argv[3] || 5000);
const BASE_URL = new URL(BASE);

async function req(method, path, body, token = null) {
  let url = BASE + path;
  if (token) { const sep = url.includes('?') ? '&' : '?'; url += sep + 'token=' + encodeURIComponent(token); }
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => null);
  if (!j || j.code !== 0) throw new Error(`api ${method} ${path} -> ${r.status} ${j && j.message}`);
  return j.data;
}

const pct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

const main = async () => {
  const suffix = Date.now();
  const reg = await req('POST', '/api/auth/register', { username: 'qar_' + suffix, password: 'password123' });
  const token = reg.token;
  const w = await req('POST', '/api/worlds', { name: 'qar', seed: 11 }, token);
  const worldId = w.worldId;
  await req('POST', '/api/rooms', { worldId }, token);

  const ws = new WebSocket(`${BASE_URL.protocol === 'https:' ? 'wss:' : 'ws:'}//${BASE_URL.host}/ws`);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const ticks = [], stamps = [];
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.type === 'snap') { ticks.push(m.data.tick); stamps.push(performance.now()); } });
  ws.send(JSON.stringify({ type: 'hello', data: { token, worldId } }));
  for (let i = 0; i < 60 && ticks.length === 0; i++) await sleep(50);

  ticks.length = 0; stamps.length = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < WINDOW) await sleep(20);
  const wall = performance.now() - t0;
  ws.close();

  const diffs = [];
  for (let i = 1; i < ticks.length; i++) diffs.push(ticks[i] - ticks[i - 1]);
  const gaps = [];
  for (let i = 1; i < stamps.length; i++) gaps.push(stamps[i] - stamps[i - 1]);
  const countOf = {};
  for (const d of diffs) countOf[d] = (countOf[d] || 0) + 1;
  const tickDelta = ticks[ticks.length - 1] - ticks[0];
  const rate = (tickDelta / wall) * 1000;
  console.log(`[window] ${WINDOW}ms 实际墙钟 ${wall.toFixed(0)}ms`);
  console.log(`[snaps] ${ticks.length}  tick 跨度 ${tickDelta}`);
  console.log(`[tick diff dist] ${JSON.stringify(countOf)}`);
  console.log(`[snap gap ms] min=${Math.min(...gaps).toFixed(1)} p50=${pct(gaps, .5).toFixed(1)} p90=${pct(gaps, .9).toFixed(1)} p99=${pct(gaps, .99).toFixed(1)} max=${Math.max(...gaps).toFixed(1)} mean=${(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(1)}`);
  console.log(`[tick/s] ${rate.toFixed(2)}  (设计要求 20.00, 偏差 ${((rate / 20 - 1) * 100).toFixed(1)}%)`);
  const dom = diffs.reduce((a, b) => (countOf[a] >= (countOf[b] || 0) ? a : b));
  console.log(`[diff 主值] ${dom}`);
  console.log(rate >= 19 ? 'VERDICT: OK (>=19 tick/s)' : rate >= 17.5 ? 'VERDICT: WARN (17.5~19 tick/s，定时器漂移)' : 'VERDICT: FAIL (<17.5 tick/s，明显低于 20 TPS 设计)');
};
main().catch((e) => { console.error(e); process.exit(1); });
