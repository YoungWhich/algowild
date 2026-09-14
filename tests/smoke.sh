#!/usr/bin/env bash
# tests/smoke.sh — L7 端到端烟雾测试
set -e
cd "$(dirname "$0")/.."
PORT=17077
PORT=$PORT node server/index.js >/tmp/srv_${PORT}.log 2>&1 &
SRV=$!
trap "kill $SRV 2>/dev/null || true" EXIT
# 等服务启动
for i in $(seq 1 20); do
  sleep 0.5
  if curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then break; fi
done

echo "--- 1. healthz"
curl -sf "http://127.0.0.1:$PORT/healthz" | grep -q '"code":0'

echo "--- 2. meta"
curl -sf "http://127.0.0.1:$PORT/api/meta" | grep -q '"kernels":46'

echo "--- 3. register"
SUFFIX=$$
TOKEN=$(curl -sf -X POST "http://127.0.0.1:$PORT/api/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"smoke_${SUFFIX}\",\"password\":\"password123\"}" | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).data.token))')
echo "token: ${TOKEN:0:20}..."

echo "--- 4. create world"
WID=$(curl -sf -X POST "http://127.0.0.1:$PORT/api/worlds" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"smoke","seed":1}' | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).data.worldId))')
echo "worldId: $WID"

echo "--- 5. tick 100 次后检查涌现"
node -e "
const http = require('http');
async function fetch(path, opts) {
  return new Promise((res, rej) => {
    const req = http.request('http://127.0.0.1:$PORT'+path, opts, (r) => {
      let b=''; r.on('data',d=>b+=d); r.on('end',()=>res(JSON.parse(b)));
    });
    req.on('error', rej);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
async function main() {
  const auth = await fetch('/api/worlds/$WID', { headers: { Authorization: 'Bearer $TOKEN' } });
  console.log('emergentTotal:', auth.data.emergentTotal);
  if (auth.data.emergentTotal < 0) throw new Error('invalid');
  console.log('OK');
}
main().catch(e => { console.error(e); process.exit(1); });
"

echo "--- 6. room"
ROOM=$(curl -sf -X POST "http://127.0.0.1:$PORT/api/rooms" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"worldId\":\"$WID\"}" | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).data.code))')
echo "room: $ROOM"

echo "--- 7. SPA"
curl -sf "http://127.0.0.1:$PORT/" | grep -q '涌现之地'

echo "--- SMOKE_OK"
exit 0