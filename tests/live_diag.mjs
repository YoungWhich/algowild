// live_diag.mjs — diagnose which endpoint returns 500 HTML
const U = process.env.URL;
const j = (p, opt) => fetch(U + p, opt).then(async r => ({ s: r.status, ct: r.headers.get('content-type'), body: await r.text() }));
const log = (name, r) => console.log(name, r.s, r.ct, 'head=', r.body.slice(0, 140));
(async () => {
  const u = 'd' + Date.now();
  const reg = await j('/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: 'pw123456' }) });
  log('register', reg);
  if (reg.s !== 200) return;
  const tok = JSON.parse(reg.body).data.token;
  // /me
  log('me', await j('/api/me?token=' + encodeURIComponent(tok)));
  // /worlds POST
  const wld = await j('/api/worlds?token=' + encodeURIComponent(tok), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'd', seed: 1 }) });
  log('worlds', wld);
  if (wld.s !== 200) return;
  const wid = JSON.parse(wld.body).data.worldId;
  // /rooms POST
  log('rooms', await j('/api/rooms?token=' + encodeURIComponent(tok), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ worldId: wid }) }));
  // /rooms/:code/join POST (likely the suspect — the 500 line)
  // First get the code from the previous create
  const rm2 = await j('/api/rooms?token=' + encodeURIComponent(tok), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ worldId: wid }) });
  const code = JSON.parse(rm2.body).data && JSON.parse(rm2.body).data.code;
  if (code) {
    log('byCode', await j('/api/rooms/' + code));
    log('join', await j('/api/rooms/' + code + '/join?token=' + encodeURIComponent(tok), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ playerId: u }) }));
  }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
