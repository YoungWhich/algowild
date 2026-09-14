// scripts/tick_cadence_probe.mjs — 单 tick 归属实测探针（M1 验收）
// 用法：先起服务（PORT=17001），再跑本脚本：
//   node scripts/tick_cadence_probe.mjs <baseUrl>
// 注册→建世界→建房→WS hello，采样 ~1.3s 的 snap，打印相邻 snap 的 tick 差分布。
// 期望：单 tick 修正后 相邻 snap tick 差 ≈ 1（修复前双 tick ≈ 2，实机 ~32 tick/s）。
import { WebSocket } from 'ws';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.argv[2] || 'http://127.0.0.1:17001';
const BASE_URL = new URL(BASE);

async function req(method, path, body, token = null) {
  let url = BASE + path;
  if (token) { const sep = url.includes('?') ? '&' : '?'; url += sep + 'token=' + encodeURIComponent(token); }
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => null);
  if (!j || j.code !== 0) throw new Error(`api ${method} ${path} -> ${r.status} ${j && j.message}`);
  return j.data;
}

const main = async () => {
  const suffix = Date.now();
  const reg = await req('POST', '/api/auth/register', { username: 'cad_' + suffix, password: 'password123' });
  const token = reg.token;
  const w = await req('POST', '/api/worlds', { name: 'cad', seed: 42 }, token);
  const worldId = w.worldId;
  await req('POST', '/api/rooms', { worldId }, token);

  const wsUrl = `${BASE_URL.protocol === 'https:' ? 'wss:' : 'ws:'}//${BASE_URL.host}/ws`;
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.send(JSON.stringify({ type: 'hello', data: { token, worldId } }));

  const ticks = [];
  const stamps = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'snap') {
      ticks.push(m.data.tick);
      stamps.push(Date.now());
    }
  });
  // 等首个 snap，再采样 1300ms
  for (let i = 0; i < 50 && ticks.length === 0; i++) await sleep(100);
  const t0 = Date.now();
  while (Date.now() - t0 < 1300) await sleep(50);
  ws.close();

  if (ticks.length < 5) { console.log('FAIL: too few snaps', ticks.length); process.exit(2); }
  const diffs = [];
  for (let i = 1; i < ticks.length; i++) diffs.push(ticks[i] - ticks[i - 1]);
  const countOf = {};
  for (const d of diffs) countOf[d] = (countOf[d] || 0) + 1;
  const spanMs = stamps[stamps.length - 1] - stamps[0];
  const ticksInSpan = ticks[ticks.length - 1] - ticks[0];
  const tickRate = (ticksInSpan / spanMs) * 1000;
  const snaps = ticks.length;
  console.log('[snap ticks]', ticks.slice(0, 12).join(', '), (ticks.length > 12 ? '…' : ''));
  console.log('[diff dist]', JSON.stringify(countOf));
  console.log(`[stats] snaps=${snaps} span=${spanMs}ms tickDelta=${ticksInSpan} ~${tickRate.toFixed(1)} tick/s`);
  const dom = diffs.reduce((a, b) => (countOf[a] >= (countOf[b] || 0) ? a : b));
  console.log(dom === 1 ? 'PASS: 相邻 snap tick 差主值 = 1（单 tick 生效）' : `NOTE: 主值 ${dom}（期望 1，原双 tick 为 2）`);
};
main().catch((e) => { console.error(e); process.exit(1); });
