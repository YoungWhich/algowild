// tests/plant_ws_probe.mjs — 端到端验证：WS 发 {plant:true} 是否真正到达引擎
// 独立运行（不进 npm test）：node tests/plant_ws_probe.mjs
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 17099;
const BASE = `http://127.0.0.1:${PORT}`;
const NODE = 'C:/Users/JM/.workbuddy/binaries/node/versions/22.22.2-2/node.exe';

async function req(method, path, body, headers = {}, token = null) {
  let url = BASE + path;
  if (token) { const sep = url.includes('?') ? '&' : '?'; url += sep + 'token=' + encodeURIComponent(token); }
  const r = await fetch(url, {
    method, headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, j };
}

const main = async () => {
  const srv = spawn(NODE, ['server/index.js'], {
    cwd: 'D:/workspace/Game',
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stderr.on('data', d => process.stderr.write('[srv] ' + d));

  let ready = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await req('GET', '/healthz'); if (r.status === 200) { ready = true; break; } } catch {}
    await sleep(400);
  }
  if (!ready) { console.error('server not ready'); srv.kill(); process.exit(2); }
  console.log('[ok] server ready');

  const suffix = Date.now();
  const reg = await req('POST', '/api/auth/register', { username: 'pt_' + suffix, password: 'password123' });
  const token = reg.j.data.token;
  const w = await req('POST', '/api/worlds', { name: 'pt', seed: 42 }, {}, token);
  const worldId = w.j.data.worldId;
  const r = await req('POST', '/api/rooms', { worldId }, {}, token);
  const code = r.j.data.code;
  console.log('[ok] world+room', worldId, code);

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.send(JSON.stringify({ type: 'hello', data: { token, worldId } }));

  let lastSnap = null;
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'snap') lastSnap = m.data;
  });
  for (let i = 0; i < 50 && !lastSnap; i++) await sleep(100);

  const findMe = () => lastSnap && lastSnap.players.find(p => p.name && p.name.startsWith('pt_'));
  const m0 = findMe();
  const seeds0 = m0 ? m0.seeds : null, cells0 = m0 ? m0.lifeCells : null;
  console.log('[before] seeds=', seeds0, ' lifeCells=', cells0);

  // 连续发送 3 次落子意图
  for (let i = 0; i < 3; i++) { ws.send(JSON.stringify({ type: 'intent', data: { plant: true } })); await sleep(150); }
  await sleep(1500);
  const m1 = findMe();
  const seeds1 = m1 ? m1.seeds : null, cells1 = m1 ? m1.lifeCells : null;
  console.log('[after ] seeds=', seeds1, ' lifeCells=', cells1);

  // 通过"种子被消耗"判定 plant 意图已抵达引擎（孤立强细胞可能被康威下一拍吞噬，故以种子为准）
  const ok = seeds0 != null && seeds1 != null && seeds1 < seeds0;
  console.log(ok ? 'PASS: plant 意图经 net.js 转发抵达引擎并消耗种子' : 'FAIL: plant 无效果');
  ws.close(); srv.kill();
  process.exit(ok ? 0 : 1);
};
main().catch(e => { console.error(e); process.exit(1); });
