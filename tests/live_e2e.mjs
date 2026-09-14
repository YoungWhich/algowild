// live_e2e.mjs — final live verification
const U = process.env.URL;
if (!U) { console.error("set URL env"); process.exit(1); }
const j = (p, opt) => fetch(U + p, opt).then(async r => ({ s: r.status, ct: r.headers.get('content-type'), b: await r.text() }));
const mustJson = (label, raw) => {
  if (raw.s !== 200) { console.log(`FAIL ${label} status=${raw.s} body=${raw.b.slice(0,120)}`); return false; }
  if (!(raw.ct || '').includes('application/json')) { console.log(`FAIL ${label} ct=${raw.ct} body=${raw.b.slice(0,120)}`); return false; }
  try { JSON.parse(raw.b); console.log(`OK   ${label} ${raw.s} ${raw.ct}`); return true; }
  catch (e) { console.log(`FAIL ${label} json parse: ${e.message}`); return false; }
};
(async () => {
  const u = 'v' + Date.now();
  const reg = await j('/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: 'pw123456' }) });
  if (!mustJson('register', reg)) return;
  const tok = JSON.parse(reg.b).data.token;
  const me = await j('/api/me?token=' + encodeURIComponent(tok));
  mustJson('me', me);
  const wld = await j('/api/worlds?token=' + encodeURIComponent(tok), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'v', seed: 7 }) });
  mustJson('worlds', wld);
  const wid = JSON.parse(wld.b).data.worldId;
  const rm = await j('/api/rooms?token=' + encodeURIComponent(tok), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ worldId: wid }) });
  mustJson('rooms', rm);
  const code = JSON.parse(rm.b).data.code;
  const byCode = await j('/api/rooms/' + code);
  mustJson('byCode', byCode);
  const join = await j('/api/rooms/' + code + '/join?token=' + encodeURIComponent(tok), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ playerId: u }) });
  mustJson('join', join);
  console.log('PERMA-LINK => ' + U + '/?room=' + code);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
