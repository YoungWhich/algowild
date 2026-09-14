// scripts/net_keepalive_probe.mjs — 心跳兜底 + 断线宽限（M2/M3 服务端侧）实测
// 用法：起服务后 node scripts/net_keepalive_probe.mjs http://127.0.0.1:17001
// 1) WS hello 后每 10s 发 heartbeat，挂机 ~32s，断言不被 30s 超时踢线
// 2) 断开后等 ~16s（>15s 宽限），GET /worlds/:id 断言离场真人已被 removePlayer
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
  const reg = await req('POST', '/api/auth/register', { username: 'ka_' + suffix, password: 'password123' });
  const token = reg.token;
  const me = reg.user;
  const w = await req('POST', '/api/worlds', { name: 'ka', seed: 7 }, token);
  const worldId = w.worldId;
  await req('POST', '/api/rooms', { worldId }, token);

  const wsUrl = `${BASE_URL.protocol === 'https:' ? 'wss:' : 'ws:'}//${BASE_URL.host}/ws`;
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.send(JSON.stringify({ type: 'hello', data: { token, worldId } }));
  let closed = null;
  ws.on('close', (code) => { closed = code; });

  // 等 hello 完成并收到 snap
  let got = false;
  ws.on('message', (raw) => { if (JSON.parse(raw.toString()).type === 'snap') got = true; });
  for (let i = 0; i < 50 && !got; i++) await sleep(100);

  // 每 10s 心跳，挂机 32s（服务端 30s 无消息即 4003 踢线）
  const hb = setInterval(() => { try { ws.send(JSON.stringify({ type: 'heartbeat' })); } catch {} }, 10000);
  await sleep(32000);
  clearInterval(hb);
  const aliveAfter32s = closed === null && ws.readyState === 1;
  console.log(aliveAfter32s ? 'PASS: 心跳挂机 32s 未被踢线（4003 未触发）' : `FAIL: 被踢 code=${closed}`);
  ws.close();
  await sleep(200);

  // 断线 >15s 宽限 → 真人被移除（GET world 快照核对 players）
  await sleep(16000);
  const snap = await req('GET', `/api/worlds/${worldId}`, null, token);
  const stillThere = (snap.players || []).some((p) => String(p.id) === String(me.id));
  console.log(stillThere ? 'FAIL: 宽限后真人仍在 players（未 removePlayer）' : 'PASS: 断线超宽限后真人已 removePlayer');
  process.exit(aliveAfter32s && !stillThere ? 0 : 1);
};
main().catch((e) => { console.error(e); process.exit(1); });
