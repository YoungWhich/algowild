// tests/live_e2e_v5.mjs — verify deployed v5 endpoints return JSON (uses global fetch)
const BASE = 'https://752e26356a6d4d6cbd627957753a5952.app.workbuddy.link';

async function req(method, path, body, headers = {}) {
  // Deploy reverse-proxy hijacks Authorization header; use ?token= for auth endpoints.
  let url = BASE + path;
  if (headers['X-Auth-Bypass']) {
    const t = headers['X-Auth-Bypass'];
    delete headers['X-Auth-Bypass'];
    const sep = url.includes('?') ? '&' : '?';
    url = `${url}${sep}token=${encodeURIComponent(t)}`;
  }
  const init = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  };
  if (body) init.body = JSON.stringify(body);
  const res = await fetch(url, init);
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  return { status: res.status, ct, body: text };
}

const SUFFIX = Date.now();
const RESULTS = [];
function check(label, ok, info) { RESULTS.push({ label, ok, info }); console.log((ok ? '✓ ' : '✗ ') + label, info || ''); }

const main = async () => {
  const h = await req('GET', '/healthz');
  check('healthz', h.status === 200 && h.ct.includes('application/json'), h.status + ' ' + h.ct);

  const reg = await req('POST', '/api/auth/register', { username: 'v5test_' + SUFFIX, password: 'password123' });
  const regJson = JSON.parse(reg.body);
  check('register', reg.status === 200 && regJson.code === 0, reg.status + ' ' + reg.ct);
  const token = regJson.data.token;

  const meta = await req('GET', '/api/meta');
  const metaJson = JSON.parse(meta.body);
  check('GET /api/meta', meta.status === 200 && metaJson.code === 0 && metaJson.data.kernels === 46, meta.status + ' ' + meta.ct);

  // Use ?token= to bypass reverse-proxy Authorization header hijack.
  const me = await req('GET', '/api/me', null, { 'X-Auth-Bypass': token });
  check('GET /me', me.status === 200 && JSON.parse(me.body).code === 0, me.status + ' ' + me.ct);

  const w = await req('POST', '/api/worlds', { name: 'v5test', seed: 42 }, { 'X-Auth-Bypass': token });
  check('POST /worlds', w.status === 200 && JSON.parse(w.body).code === 0, w.status + ' ' + w.ct);
  const worldId = JSON.parse(w.body).data.worldId;

  const r = await req('POST', '/api/rooms', { worldId }, { 'X-Auth-Bypass': token });
  check('POST /rooms', r.status === 200 && JSON.parse(r.body).code === 0, r.status + ' ' + r.ct);
  const code = JSON.parse(r.body).data.code;

  const g = await req('GET', '/api/rooms/' + code);
  const gJson = JSON.parse(g.body);
  check('GET /rooms/:code', g.status === 200 && gJson.code === 0, g.status + ' ' + g.ct);
  check('  maxPlayers=4', gJson.data.maxPlayers === 4, 'got ' + gJson.data.maxPlayers);

  const j = await req('POST', '/api/rooms/' + code + '/join', {}, { 'X-Auth-Bypass': token });
  const jJson = JSON.parse(j.body);
  check('POST /rooms/:code/join', j.status === 200 && jJson.code === 0, j.status + ' ' + j.ct);
  check('  you.isAI=false', jJson.data.you && jJson.data.you.isAI === false);
  const players = jJson.data.snap.players;
  const aiCount = players.filter(p => p.isAI).length;
  check('  3 AI filler spawned', aiCount === 3, 'got ' + aiCount + ' AI');

  const spa = await req('GET', '/');
  check('GET / (SPA)', spa.status === 200 && spa.body.includes('涌现之地'), spa.status + ' ' + spa.ct);

  const pass = RESULTS.filter(r => r.ok).length;
  console.log(`\n${'='.repeat(40)}\nResult: ${pass}/${RESULTS.length} checks passed\n${'='.repeat(40)}`);
  process.exit(pass === RESULTS.length ? 0 : 1);
};

main().catch((e) => { console.error(e); process.exit(1); });
