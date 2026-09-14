// live_exhaustive.mjs — exercise every API endpoint to find the 500 path
const U = process.env.URL;
const j = (p, opt) => fetch(U + p, opt).then(async r => ({ s: r.status, ct: r.headers.get('content-type'), body: await r.text() }));
const log = (name, r) => console.log(name.padEnd(36), r.s, r.ct, '|', r.body.slice(0, 200));
(async () => {
  const u = 'x' + Date.now();
  const reg = await j('/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: 'pw123456' }) });
  log('register', reg);
  if (reg.s !== 200) return;
  const tok = JSON.parse(reg.body).data.token;
  // /me
  log('GET /me', await j('/api/me?token=' + encodeURIComponent(tok)));
  // /worlds (POST + GET)
  const wld = await j('/api/worlds?token=' + encodeURIComponent(tok), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x', seed: 1 }) });
  log('POST /worlds', wld);
  const wid = JSON.parse(wld.body).data.worldId;
  log('GET /worlds/:id', await j('/api/worlds/' + wid + '?token=' + encodeURIComponent(tok)));
  log('POST /worlds/:id/save', await j('/api/worlds/' + wid + '/save?token=' + encodeURIComponent(tok), { method: 'POST', headers: { 'content-type': 'application/json' } }));
  log('GET /worlds/:id/saves', await j('/api/worlds/' + wid + '/saves?token=' + encodeURIComponent(tok)));
  log('POST /scores', await j('/api/scores?token=' + encodeURIComponent(tok), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ worldId: wid, score: 10 }) }));
  log('GET /scores/me', await j('/api/scores/me?token=' + encodeURIComponent(tok)));
  // /rooms
  const rm = await j('/api/rooms?token=' + encodeURIComponent(tok), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ worldId: wid }) });
  log('POST /rooms', rm);
  const code = JSON.parse(rm.body).data.code;
  log('GET /rooms/:code', await j('/api/rooms/' + code));
  log('POST /rooms/:code/join', await j('/api/rooms/' + code + '/join?token=' + encodeURIComponent(tok), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ playerId: u }) }));
  // Bad inputs
  log('POST /rooms (bad worldId)', await j('/api/rooms?token=' + encodeURIComponent(tok), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ worldId: 'nope' }) }));
  log('POST /rooms (no worldId)', await j('/api/rooms?token=' + encodeURIComponent(tok), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
  log('GET /rooms/missing', await j('/api/rooms/NOPE'));
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
