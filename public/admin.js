// public/admin.js — 涌现之地 管理后台（纯原生 JS，无框架、无构建）
// 复用 localStorage['algowild_token']；所有请求三通道带 token。
// 铁律：不依赖 Authorization 头（部署反代会劫持），以 ?token= + x-auth-token 为准。

const TOKEN_KEY = 'algowild_token';
const ADMIN_KEY = 'algowild_admin_key';   // 可选：管理员访问密钥（服务端设了 ADMIN_ACCESS_KEY 时必填）
const $ = (id) => document.getElementById(id);

// 当前登录管理员（/api/me 取回）
let me = null;

const state = {
  tab: 'overview',
  users: { page: 1, pageSize: 20, filter: 'all', q: '', total: 0, rows: [] },
  overview: null,
};

// ============== API ==============
async function api(method, path, body) {
  const token = localStorage.getItem(TOKEN_KEY);
  const headers = { 'Content-Type': 'application/json' };
  let url = path;
  if (token) {
    headers['Authorization'] = 'Bearer ' + token;   // 可带，但不可依赖
    headers['x-auth-token'] = token;
    url += (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
  }
  // 管理员访问密钥（可选，多通道发送，不依赖单一头）
  const adminKey = localStorage.getItem(ADMIN_KEY);
  if (adminKey) {
    headers['x-admin-key'] = adminKey;
    url += (url.includes('?') ? '&' : '?') + 'adminKey=' + encodeURIComponent(adminKey);
  }
  const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let j = null;
  try { j = await r.json(); } catch { j = null; }
  if (r.status === 401 || r.status === 403) {
    const e = new Error((j && j.message) || 'forbidden');
    e.status = r.status;
    throw e;
  }
  if (!j || j.code !== 0) throw new Error((j && j.message) || ('HTTP ' + r.status));
  return j.data;
}

// ============== UI 基础 ==============
let toastTimer = null;
function toast(msg, kind = 'ok') {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'show ' + (kind === 'error' ? 'error' : kind === 'warn' ? 'warn' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, 3200);
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtTime(ms) {
  if (!ms) return '—';
  try { return new Date(Number(ms)).toLocaleString(); } catch { return '—'; }
}
function fmtDur(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + ' 秒';
  if (s < 3600) return Math.floor(s / 60) + ' 分';
  if (s < 86400) return Math.floor(s / 3600) + ' 时 ' + Math.floor((s % 3600) / 60) + ' 分';
  return Math.floor(s / 86400) + ' 天 ' + Math.floor((s % 86400) / 3600) + ' 时';
}

// 通用对话框：fields = [{key,label,type,value,options,placeholder}]
function dialog({ title, fields = [], okText = '确定', danger = false }) {
  return new Promise((resolve) => {
    $('dlg-title').textContent = title;
    const wrap = $('dlg-fields');
    wrap.innerHTML = '';
    for (const f of fields) {
      const div = document.createElement('div');
      div.className = 'field';
      const lab = document.createElement('label');
      lab.textContent = f.label || f.key;
      div.appendChild(lab);
      let el;
      if (f.type === 'select') {
        el = document.createElement('select');
        for (const o of (f.options || [])) {
          const opt = document.createElement('option');
          opt.value = o.value;
          opt.textContent = o.label;
          if (String(o.value) === String(f.value)) opt.selected = true;
          el.appendChild(opt);
        }
      } else {
        el = document.createElement('input');
        el.type = f.type || 'text';
        if (f.value != null) el.value = f.value;
        if (f.placeholder) el.placeholder = f.placeholder;
      }
      el.dataset.key = f.key;
      div.appendChild(el);
      wrap.appendChild(div);
    }
    const overlay = $('overlay');
    const okBtn = $('dlg-ok');
    okBtn.textContent = okText;
    okBtn.className = danger ? 'danger' : 'primary';
    overlay.classList.add('show');

    const cleanup = () => {
      overlay.classList.remove('show');
      okBtn.onclick = null;
      $('dlg-cancel').onclick = null;
      overlay.onclick = null;
    };
    const collect = () => {
      const out = {};
      for (const el of wrap.querySelectorAll('[data-key]')) out[el.dataset.key] = el.value;
      return out;
    };
    $('dlg-cancel').onclick = () => { cleanup(); resolve(null); };
    overlay.onclick = (ev) => { if (ev.target === overlay) { cleanup(); resolve(null); } };
    okBtn.onclick = () => { const v = collect(); cleanup(); resolve(v); };
    const first = wrap.querySelector('input,select');
    if (first) first.focus();
  });
}

// ============== 渲染 ==============
function switchTab(tab) {
  state.tab = tab;
  for (const b of $('tabs').querySelectorAll('button')) b.classList.toggle('active', b.dataset.tab === tab);
  for (const s of document.querySelectorAll('.section')) s.classList.toggle('active', s.dataset.sec === tab);
  loadTab(tab).catch((e) => toast(e.message, 'error'));
}

async function loadTab(tab) {
  if (tab === 'overview') return renderOverview();
  if (tab === 'users') return renderUsers();
  if (tab === 'online') return renderOnline();
  if (tab === 'rooms') return renderRooms();
  if (tab === 'actions') return renderActions();
  if (tab === 'maintenance') return renderMaintenance();
}

// ---------- 维护（不活跃账号清理） ----------
async function renderMaintenance() {
  const d = await api('GET', '/api/admin/maintenance');
  $('m-days').value = String(d.inactiveDays);
  const pv = d.preview || { count: 0, candidates: [], disabled: false };
  const last = d.lastPurgeAt ? fmtTime(d.lastPurgeAt) : '从未';
  $('m-info').innerHTML = `当前阈值：<b>${d.inactiveDays}</b> 天${d.inactiveDays === 0 ? '（已关闭自动清理）' : ''}　·　上次清理：${esc(last)}　·　待清理：<b>${pv.count}</b> 个`;
  if (!pv.candidates || !pv.candidates.length) {
    $('m-preview').innerHTML = '<div class="empty">没有符合条件的不活跃账号</div>';
    return;
  }
  $('m-preview').innerHTML = `<table>
    <thead><tr><th>ID</th><th>用户名</th><th>注册时间</th><th>最近登录</th></tr></thead>
    <tbody>${pv.candidates.map((u) => `<tr>
      <td>${u.id}</td>
      <td>${esc(u.username)}</td>
      <td class="muted">${esc(fmtTime(u.created_at))}</td>
      <td class="muted">${esc(fmtTime(u.last_login))}</td>
    </tr>`).join('')}</tbody></table>`;
}

// ---------- 总览 ----------
async function fetchOverview() {
  const d = await api('GET', '/api/admin/overview');
  state.overview = d;
  return d;
}
async function renderOverview() {
  const d = await fetchOverview();
  const u = d.users || { total: 0, banned: 0, admins: 0 };
  const rooms = d.rooms || { total: 0, public: 0, private: 0 };
  const cards = [
    ['用户总数', u.total, ''],
    ['管理员', u.admins, 'warn-c'],
    ['已封禁', u.banned, 'err'],
    ['在线人数', d.online, 'ok'],
    ['房间总数', rooms.total, ''],
    ['公开房', rooms.public, ''],
    ['私密房', rooms.private, ''],
    ['世界数', d.worlds, ''],
    ['数据库', d.dbType || '—', ''],
    ['版本', d.version || '—', ''],
    ['运行时长', fmtDur(d.uptimeMs || 0), ''],
  ];
  $('overview-cards').innerHTML = cards.map(([k, v, cls]) =>
    `<div class="card"><div class="v ${cls}">${esc(v)}</div><div class="k">${esc(k)}</div></div>`
  ).join('');
}

// ---------- 玩家管理 ----------
async function fetchUsers() {
  const s = state.users;
  const qs = new URLSearchParams({
    page: String(s.page), pageSize: String(s.pageSize), filter: s.filter,
  });
  if (s.q) qs.set('q', s.q);
  const d = await api('GET', '/api/admin/users?' + qs.toString());
  s.rows = d.rows || [];
  s.total = d.total || 0;
  s.page = d.page || 1;
  s.pageSize = d.pageSize || s.pageSize;
  return d;
}
async function renderUsers() {
  await fetchUsers();
  const s = state.users;
  const rows = s.rows;
  const table = $('u-table-wrap');

  if (!rows.length) {
    table.innerHTML = '<div class="empty">没有匹配的用户</div>';
  } else {
    const body = rows.map((u) => {
      const isSelf = me && me.id === u.id;
      const roleTag = u.role === 'admin'
        ? '<span class="tag admin">管理员</span>'
        : '<span class="tag player">玩家</span>';
      let banTag;
      if (!u.banned) banTag = '<span class="tag normal">正常</span>';
      else {
        const forever = !u.banned_until;
        banTag = `<span class="tag banned" title="${esc(u.ban_reason || '')}">已封禁${forever ? '·永久' : '·至' + esc(fmtTime(u.banned_until))}</span>`;
      }
      const acts = [];
      if (!isSelf) {
        if (u.banned) acts.push(`<button class="ghost" data-act="unban" data-id="${u.id}" data-name="${esc(u.username)}">解封</button>`);
        else acts.push(`<button class="ghost warn" data-act="ban" data-id="${u.id}" data-name="${esc(u.username)}">封禁</button>`);
      }
      acts.push(`<button class="ghost" data-act="kick" data-id="${u.id}" data-name="${esc(u.username)}">踢下线</button>`);
      if (!isSelf) {
        if (u.role === 'admin') acts.push(`<button class="ghost" data-act="demote" data-id="${u.id}" data-name="${esc(u.username)}">取消管理员</button>`);
        else acts.push(`<button class="ghost" data-act="promote" data-id="${u.id}" data-name="${esc(u.username)}">设为管理员</button>`);
        acts.push(`<button class="ghost danger" data-act="delete" data-id="${u.id}" data-name="${esc(u.username)}">删除</button>`);
      } else {
        acts.push('<span class="muted" style="font-size:11px">（当前账号）</span>');
      }
      return `<tr>
        <td>${u.id}</td>
        <td data-uid="${u.id}" style="cursor:pointer;color:#58a6ff">${esc(u.username)}</td>
        <td>${roleTag}</td>
        <td>${banTag}</td>
        <td class="muted">${esc(fmtTime(u.created_at))}</td>
        <td class="muted">${esc(fmtTime(u.last_login))}</td>
        <td><div class="row" style="gap:4px">${acts.join('')}</div></td>
      </tr>`;
    }).join('');
    table.innerHTML = `<table>
      <thead><tr><th>ID</th><th>用户名</th><th>角色</th><th>状态</th><th>注册时间</th><th>最近登录</th><th>操作</th></tr></thead>
      <tbody>${body}</tbody></table>`;
  }

  const maxPage = Math.max(1, Math.ceil(s.total / s.pageSize));
  $('u-total').textContent = `共 ${s.total} 个用户`;
  $('u-page').textContent = `第 ${s.page} / ${maxPage} 页`;
  $('u-prev').disabled = s.page <= 1;
  $('u-next').disabled = s.page >= maxPage;
}

async function userAction(act, id, name) {
  id = Number(id);
  try {
    if (act === 'ban') {
      const v = await dialog({
        title: `封禁 ${name}`,
        okText: '确认封禁', danger: true,
        fields: [
          { key: 'reason', label: '封禁原因', type: 'text', value: '', placeholder: '例如：使用外挂 / 恶意刷屏' },
          { key: 'duration', label: '封禁时长', type: 'select', value: '0', options: [
            { value: '0', label: '永久' },
            { value: '1', label: '1 小时' },
            { value: '24', label: '1 天' },
            { value: '168', label: '7 天' },
          ] },
        ],
      });
      if (!v) return;
      const d = await api('POST', `/api/admin/users/${id}/ban`, { reason: v.reason, durationHours: Number(v.duration) });
      toast(`已封禁 ${name}（踢下线 ${d.kicked} 个会话）`);
    } else if (act === 'unban') {
      await api('POST', `/api/admin/users/${id}/unban`, {});
      toast(`已解封 ${name}`);
    } else if (act === 'kick') {
      const v = await dialog({ title: `将 ${name} 踢下线？`, okText: '踢下线', fields: [] });
      if (!v) return;
      const d = await api('POST', `/api/admin/users/${id}/kick`, {});
      toast(`已踢下线 ${name}（断开 ${d.kicked} 个会话）`);
    } else if (act === 'promote') {
      await api('POST', `/api/admin/users/${id}/role`, { role: 'admin' });
      toast(`已将 ${name} 设为管理员`);
    } else if (act === 'demote') {
      await api('POST', `/api/admin/users/${id}/role`, { role: 'player' });
      toast(`已取消 ${name} 的管理员身份`);
    } else if (act === 'delete') {
      const v = await dialog({
        title: `删除用户 ${name}`,
        okText: '永久删除', danger: true,
        fields: [{ key: 'confirmUsername', label: `输入用户名「${name}」以确认删除`, type: 'text', placeholder: name }],
      });
      if (!v) return;
      if (v.confirmUsername !== name) { toast('用户名不匹配，已取消删除', 'error'); return; }
      const d = await api('DELETE', `/api/admin/users/${id}`, { confirmUsername: v.confirmUsername });
      toast(`已删除 ${name}（级联清理完成）`);
    }
    await renderUsers();
    if (state.tab === 'overview') await renderOverview();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------- 在线 ----------
async function renderOnline() {
  const d = await fetchOverview();
  const list = d.onlineUsers || [];
  if (!list.length) { $('online-wrap').innerHTML = '<div class="empty">当前无在线玩家</div>'; return; }
  $('online-wrap').innerHTML = `<table>
    <thead><tr><th>ID</th><th>用户名</th><th>状态</th><th>操作</th></tr></thead>
    <tbody>${list.map((u) => `<tr>
      <td>${u.id}</td>
      <td>${esc(u.username)}</td>
      <td>${u.banned ? '<span class="tag banned">已封禁</span>' : '<span class="tag normal">在线</span>'}</td>
      <td><button class="ghost" data-kick="${u.id}" data-name="${esc(u.username)}">踢下线</button></td>
    </tr>`).join('')}</tbody></table>`;
}

// ---------- 房间 ----------
async function renderRooms() {
  const d = await api('GET', '/api/admin/rooms');
  const rooms = d.rooms || [];
  if (!rooms.length) { $('rooms-wrap').innerHTML = '<div class="empty">当前无房间</div>'; return; }
  $('rooms-wrap').innerHTML = `<table>
    <thead><tr><th>房间号</th><th>名称</th><th>模式</th><th>可见性</th><th>席位</th><th>人类/电脑</th><th>阶段</th><th>房主</th><th>操作</th></tr></thead>
    <tbody>${rooms.map((r) => `<tr>
      <td>${esc(r.code)}</td>
      <td>${esc(r.name)}</td>
      <td>${esc(r.mode || '—')}</td>
      <td>${r.visibility === 'private' ? '<span class="tag banned">私密</span>' : '<span class="tag player">公开</span>'}</td>
      <td>${r.seatCount}/${r.maxPlayers}</td>
      <td>${r.humanCount}H / ${r.aiCount}AI</td>
      <td>${esc(r.phase)}</td>
      <td>${esc(r.ownerName || ('#' + r.ownerId))}</td>
      <td><button class="ghost danger" data-close="${esc(r.code)}">强制关房</button></td>
    </tr>`).join('')}</tbody></table>`;
}

// ---------- 审计日志 ----------
const ACTION_LABEL = {
  ban: '封禁', unban: '解封', kick: '踢下线', set_role: '改角色', delete: '删除',
  close_room: '关闭房间', cli_grant: 'CLI设管理员', cli_revoke: 'CLI撤销管理员',
  cli_ban: 'CLI封禁', cli_unban: 'CLI解封', cli_delete: 'CLI删除',
  purge_inactive: '清理不活跃', set_inactive_days: '改清理阈值',
};
async function renderActions() {
  const d = await api('GET', '/api/admin/actions?limit=100');
  const rows = d.rows || [];
  if (!rows.length) { $('actions-wrap').innerHTML = '<div class="empty">暂无审计记录</div>'; return; }
  $('actions-wrap').innerHTML = `<table>
    <thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>目标</th><th>详情</th></tr></thead>
    <tbody>${rows.map((a) => `<tr>
      <td class="muted">${esc(fmtTime(a.created_at))}</td>
      <td>${esc(a.actor_name || '—')}</td>
      <td><span class="tag player">${esc(ACTION_LABEL[a.action] || a.action)}</span></td>
      <td>${esc(a.target_name || (a.target_id != null ? ('#' + a.target_id) : '—'))}</td>
      <td class="muted" style="font-size:12px">${esc(a.detail || '')}</td>
    </tr>`).join('')}</tbody></table>`;
}

// ============== 事件绑定 ==============
$('tabs').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-tab]');
  if (b) switchTab(b.dataset.tab);
});

$('overview-refresh').onclick = () => renderOverview().catch((e) => toast(e.message, 'error'));
$('online-refresh').onclick = () => renderOnline().catch((e) => toast(e.message, 'error'));
$('rooms-refresh').onclick = () => renderRooms().catch((e) => toast(e.message, 'error'));
$('actions-refresh').onclick = () => renderActions().catch((e) => toast(e.message, 'error'));
$('m-refresh').onclick = () => renderMaintenance().catch((e) => toast(e.message, 'error'));
$('m-save').onclick = async () => {
  try {
    const days = parseInt($('m-days').value, 10);
    if (!Number.isFinite(days) || days < 0) { toast('请输入 ≥ 0 的整数天数', 'error'); return; }
    const d = await api('POST', '/api/admin/maintenance/inactive-days', { days });
    toast(`已保存：不活跃阈值 = ${d.inactiveDays} 天`);
    await renderMaintenance();
  } catch (e) { toast(e.message, 'error'); }
};
$('m-purge').onclick = async () => {
  const v = await dialog({ title: '立即清理一次不活跃账号？', okText: '执行清理', danger: true, fields: [] });
  if (!v) return;
  try {
    const d = await api('POST', '/api/admin/maintenance/purge', {});
    if (d.disabled) toast('自动清理已关闭（阈值 0），未执行', 'warn');
    else toast(`已清理 ${d.removedCount} 个不活跃账号`);
    await renderMaintenance();
  } catch (e) { toast(e.message, 'error'); }
};

$('u-search').onclick = () => {
  state.users.q = $('u-q').value.trim();
  state.users.filter = $('u-filter').value;
  state.users.pageSize = parseInt($('u-pageSize').value, 10) || 20;
  state.users.page = 1;
  renderUsers().catch((e) => toast(e.message, 'error'));
};
$('u-q').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') $('u-search').click(); });
$('u-filter').onchange = () => $('u-search').click();
$('u-pageSize').onchange = () => $('u-search').click();
$('u-prev').onclick = () => { if (state.users.page > 1) { state.users.page--; renderUsers().catch((e) => toast(e.message, 'error')); } };
$('u-next').onclick = () => { state.users.page++; renderUsers().catch((e) => toast(e.message, 'error')); };

$('u-table-wrap').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-act]');
  if (b) userAction(b.dataset.act, b.dataset.id, b.dataset.name);
  // 点击用户名 → 查看详情
  const cell = ev.target.closest('td[data-uid]');
  if (cell) showUserDetail(cell.dataset.uid).catch((e) => toast(e.message, 'error'));
});
$('online-wrap').addEventListener('click', async (ev) => {
  const b = ev.target.closest('button[data-kick]');
  if (!b) return;
  const v = await dialog({ title: `将 ${b.dataset.name} 踢下线？`, okText: '踢下线', fields: [] });
  if (!v) return;
  try {
    const d = await api('POST', `/api/admin/users/${b.dataset.kick}/kick`, {});
    toast(`已踢下线 ${b.dataset.name}（断开 ${d.kicked} 个会话）`);
    await renderOnline();
  } catch (e) { toast(e.message, 'error'); }
});
$('rooms-wrap').addEventListener('click', async (ev) => {
  const b = ev.target.closest('button[data-close]');
  if (!b) return;
  const v = await dialog({ title: `确认强制关闭房间 ${b.dataset.close}？`, okText: '关闭房间', danger: true, fields: [] });
  if (!v) return;
  try {
    const d = await api('POST', `/api/admin/rooms/${encodeURIComponent(b.dataset.close)}/close`, {});
    toast(`已关闭房间 ${b.dataset.close}（断开 ${d.kicked} 个会话）`);
    await renderRooms();
  } catch (e) { toast(e.message, 'error'); }
});

async function showUserDetail(id) {
  const d = await api('GET', `/api/admin/users/${id}`);
  const u = d.user;
  const body = `
    <div class="field"><label>用户</label><div>#${u.id} ${esc(u.username)} · ${u.role === 'admin' ? '管理员' : '玩家'}</div></div>
    <div class="field"><label>状态</label><div>${u.banned ? ('已封禁' + (u.banned_until ? ' 至 ' + esc(fmtTime(u.banned_until)) : '（永久）') + (u.ban_reason ? ' · ' + esc(u.ban_reason) : '')) : '正常'}</div></div>
    <div class="field"><label>注册 / 最近登录</label><div class="muted">${esc(fmtTime(u.created_at))} / ${esc(fmtTime(u.last_login))}</div></div>
    <div class="field"><label>世界 (${d.worlds.length})</label><div class="muted">${d.worlds.map((w) => esc(w.name)).join('、') || '—'}</div></div>
    <div class="field"><label>房间 (${d.rooms.length})</label><div class="muted">${d.rooms.map((r) => esc(r.code)).join('、') || '—'}</div></div>
    <div class="field"><label>分数记录 (${d.scores.length})</label><div class="muted">${d.scores.map((s) => esc(s.score)).join('、') || '—'}</div></div>`;
  $('dlg-title').textContent = '用户详情';
  $('dlg-fields').innerHTML = body;
  $('dlg-ok').textContent = '关闭';
  $('dlg-ok').className = 'primary';
  const overlay = $('overlay');
  overlay.classList.add('show');
  const cleanup = () => { overlay.classList.remove('show'); $('dlg-ok').onclick = null; $('dlg-cancel').onclick = null; };
  $('dlg-ok').onclick = cleanup;
  $('dlg-cancel').onclick = cleanup;
}

// ============== 启动 ==============
async function boot() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) {
    $('gate-title').textContent = '未登录';
    $('gate-body').innerHTML = '未检测到登录凭证。请先前往 <a class="link" href="/">游戏首页</a> 登录后再访问本页面。';
    return;
  }
  // 校验身份 + 权限
  try {
    me = await api('GET', '/api/me');
  } catch (e) {
    if ((e.message || '').includes('admin_restricted')) {
      // 来源受限：提示填写管理员访问密钥（若服务端设了 ADMIN_ACCESS_KEY）
      $('gate-title').textContent = '管理员来源受限';
      $('gate-body').innerHTML = '当前设备/网络不在允许范围（管理员默认仅本机可用）。'
        + '若服务端已设置 ADMIN_ACCESS_KEY，请在下方填写密钥：'
        + '<div class="row" style="justify-content:center;margin-top:12px">'
        + '<input id="gate-key" placeholder="管理员访问密钥" style="min-width:240px" />'
        + '<button class="primary" id="gate-key-ok">使用密钥</button></div>';
      const btn = $('gate-key-ok');
      if (btn) btn.onclick = () => {
        const k = ($('gate-key').value || '').trim();
        if (k) { localStorage.setItem(ADMIN_KEY, k); location.reload(); }
      };
      return;
    }
    $('gate-title').textContent = '登录已失效';
    $('gate-body').innerHTML = (e.status === 4004 ? '账号已被封禁。' : '凭证无效或已过期。') + ' 请前往 <a class="link" href="/">游戏首页</a> 重新登录。';
    return;
  }
  if (!me || me.role !== 'admin') {
    $('gate-title').textContent = '无权限';
    $('gate-body').innerHTML = '当前账号不是管理员，无法访问管理后台。';
    return;
  }
  $('who').innerHTML = `已登录：<b>${esc(me.username)}</b>（管理员）`;
  $('gate').style.display = 'none';
  $('tabs').style.display = 'flex';
  $('content').style.display = 'block';
  switchTab('overview');
}

boot().catch((e) => {
  $('gate-title').textContent = '加载失败';
  $('gate-body').textContent = e.message;
});
