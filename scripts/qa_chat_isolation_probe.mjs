// scripts/qa_chat_isolation_probe.mjs — QA 独立复核：M6 聊天按 worldId 隔离（原跨房串聊）
// 两个用户分别在两个房间发消息，断言各自只收到本房间的聊天。
import { WebSocket } from 'ws';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.argv[2] || 'http://127.0.0.1:17003';
const BASE_URL = new URL(BASE);

async function req(method, path, body, token = null) {
  let url = BASE + path;
  if (token) { const sep = url.includes('?') ? '&' : '?'; url += sep + 'token=' + encodeURIComponent(token); }
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => null);
  if (!j || j.code !== 0) throw new Error(`api ${method} ${path} -> ${r.status} ${j && j.message}`);
  return j.data;
}
const wsUrl = `${BASE_URL.protocol === 'https:' ? 'wss:' : 'ws:'}//${BASE_URL.host}/ws`;

async function join(token, worldId, name) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const got = [];
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.type === 'chat') got.push(m.data); });
  ws.send(JSON.stringify({ type: 'hello', data: { token, worldId } }));
  await sleep(500);
  ws._got = got; ws._name = name;
  return ws;
}

const main = async () => {
  const s = Date.now();
  const a = await req('POST', '/api/auth/register', { username: 'cha_' + s, password: 'password123' });
  const b = await req('POST', '/api/auth/register', { username: 'chb_' + s, password: 'password123' });
  const wA = (await req('POST', '/api/worlds', { name: 'roomA', seed: 1 }, a.token)).worldId;
  const wB = (await req('POST', '/api/worlds', { name: 'roomB', seed: 2 }, b.token)).worldId;
  await req('POST', '/api/rooms', { worldId: wA }, a.token);
  await req('POST', '/api/rooms', { worldId: wB }, b.token);

  const wsA = await join(a.token, wA, 'A');
  const wsB = await join(b.token, wB, 'B');
  await sleep(500);

  // A 发一条；B 发一条
  wsA.send(JSON.stringify({ type: 'chat', data: { text: 'MSG-FROM-A' } }));
  wsB.send(JSON.stringify({ type: 'chat', data: { text: 'MSG-FROM-B' } }));
  await sleep(1200);

  const aGot = wsA._got.map(c => `${c.from}:${c.text}`);
  const bGot = wsB._got.map(c => `${c.from}:${c.text}`);
  console.log(`[A 收到] ${JSON.stringify(aGot)}`);
  console.log(`[B 收到] ${JSON.stringify(bGot)}`);

  const aOnlyOwn = aGot.length > 0 && aGot.every(s => s.includes('MSG-FROM-A'));
  const bOnlyOwn = bGot.length > 0 && bGot.every(s => s.includes('MSG-FROM-B'));
  console.log(aOnlyOwn ? 'PASS: M6-A 只收到本房聊天（未串到 B 房）' : 'FAIL: M6-A 收到跨房消息');
  console.log(bOnlyOwn ? 'PASS: M6-B 只收到本房聊天（未串到 A 房）' : 'FAIL: M6-B 收到跨房消息');

  wsA.close(); wsB.close(); await sleep(300);
  process.exit(aOnlyOwn && bOnlyOwn ? 0 : 1);
};
main().catch(e => { console.error(e); process.exit(1); });
