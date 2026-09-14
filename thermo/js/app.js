/* ============================================================
   app.js — 交互与渲染
   ============================================================ */

import * as S from './store.js';
import * as C from './charts.js';
import { buildInsights, catTemp, overallTemp, tempDesc, tempDistribution } from './insights.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let view = 'dash';
let month = S.curMonth();
const draft = { type: 'expense', cat: 'food', temp: 0, amount: '', note: '', date: S.todayStr() };
let filters = { type: 'all', cat: 'all', temp: 'all', q: '' };

/* ---------------- Toast ---------------- */
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 2200);
}

/* ---------------- 视图切换 ---------------- */
const TITLES = {
  dash: ['概览', '这个月的钱，流向了哪里'],
  flow: ['流水', '每一笔都留痕'],
  stats: ['统计', '把数字摊开看'],
  report: ['温度报告', '钱花得值不值，账本会说话'],
};

function setView(v) {
  view = v;
  $$('.view').forEach(s => s.classList.toggle('is-active', s.id === 'view-' + v));
  $$('.navitem').forEach(b => b.classList.toggle('is-active', b.dataset.view === v));
  $$('.tab[data-view]').forEach(b => b.classList.toggle('is-active', b.dataset.view === v));
  $('#page-title').textContent = TITLES[v][0];
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function setMonth(m) { month = m; render(); }

/* ---------------- 渲染总入口 ---------------- */
function render() {
  const [y, mo] = month.split('-');
  $('#m-label').textContent = `${y} 年 ${+mo} 月`;
  const d = new Date();
  const dim = new Date(+y, +mo, 0).getDate();
  $('#page-sub').textContent = `${TITLES[view][1]} · 共 ${dim} 天`;
  $('#m-next').disabled = false;
  ({ dash: renderDash, flow: renderFlow, stats: renderStats, report: renderReport })[view]();
}

/* ---------------- 概览 ---------------- */
function renderDash() {
  const st = S.monthStat(month);
  const prev = S.monthStat(S.shiftMonth(month, -1));

  $('#d-expense').textContent = S.yuan(st.expense);
  $('#d-income').textContent = S.yuan(st.income);
  $('#d-balance').textContent = S.yuan(st.balance, { sign: false });
  $('#d-balance').className = 'stat-val ' + (st.balance < 0 ? 'exp' : 'inc');

  const foot = (cur, pv) => {
    if (!pv) return '上月无数据';
    const d = cur - pv, r = (Math.abs(d) / pv * 100).toFixed(0);
    return d >= 0 ? `较上月 ↑${r}%` : `较上月 ↓${r}%`;
  };
  $('#d-expense-foot').textContent = foot(st.expense, prev.expense);
  $('#d-income-foot').textContent = foot(st.income, prev.income);
  $('#d-balance-foot').textContent = st.balance >= 0 ? '还有余粮' : '这个月超支了';

  // 预算环
  const budget = S.getBudget();
  if (budget > 0) {
    const p = st.expense / budget;
    const over = p > 1;
    $('#d-ring').innerHTML = '';
    C.ring($('#d-ring'), {
      percent: p, top: Math.round(p * 100) + '%', bottom: '预算已用',
      color: p > .85 ? '#ffb020' : '#7c5cff', over,
    });
    $('#d-budget-chip').textContent = '月预算 ' + S.yuan0(budget);
    $('#d-total').textContent = S.yuan0(budget);
    $('#d-used').textContent = S.yuan0(st.expense);
    $('#d-left').textContent = S.yuan0(Math.max(0, budget - st.expense));
    const dim = new Date(+month.slice(0, 4), +month.slice(5, 7), 0).getDate();
    const passed = month === S.curMonth() ? +S.todayStr().slice(8, 10) : dim;
    const restDays = Math.max(1, dim - passed + (month === S.curMonth() ? 1 : 0));
    $('#d-daily').textContent = S.yuan0(Math.max(0, Math.round((budget - st.expense) / restDays)));
    $('#d-pace').textContent = over
      ? '⚠️ 已超预算，接下来的每一笔都在透支'
      : (p > .8 ? '⚠️ 预算快见底了' : '节奏还算健康');
  } else {
    $('#d-ring').innerHTML = `<div style="display:grid;place-items:center;height:100%;color:#5f6779;font-size:12px;text-align:center;line-height:1.7">
      点左侧<br>「设置月预算」<br>开始控流</div>`;
    $('#d-budget-chip').textContent = '未设置';
    $('#d-total').textContent = '¥—'; $('#d-used').textContent = S.yuan0(st.expense);
    $('#d-left').textContent = '¥—'; $('#d-daily').textContent = '¥—';
    $('#d-pace').textContent = '设置预算后才能评估花钱节奏';
  }

  // 每日柱
  const dim = new Date(+month.slice(0, 4), +month.slice(5, 7), 0).getDate();
  const todayDay = month === S.curMonth() ? +S.todayStr().slice(8, 10) : dim;
  C.spark($('#d-spark'), st.days.slice(1, dim + 1), todayDay);
  const activeDays = st.days.filter(x => x > 0).length;
  $('#d-avg').textContent = `日均 ¥${(st.expense / 100 / Math.max(1, activeDays)).toFixed(0)} · ${activeDays} 天有支出`;

  // 最近 6 条
  const recent = S.inMonth(month).slice(0, 6);
  $('#d-recent').innerHTML = recent.length ? recent.map(rowHTML).join('')
    : `<div class="empty"><span class="e-ico">🫧</span><p>这个月还是空的，点右下角记一笔</p></div>`;
}

function rowHTML(r) {
  const c = S.catOf(r.type, r.category);
  const t = r.temp !== null && r.temp !== undefined ? S.TEMP[String(r.temp)] : null;
  return `<div class="ritem">
    <div class="ri-ico">${c.icon}</div>
    <div class="ri-mid">
      <div class="ri-cat">${c.name}${t ? `<span class="temp-dot" style="background:${t.color}" title="${t.name}"></span>` : ''}</div>
      <div class="ri-note">${esc(r.note) || '—'}</div>
    </div>
    <div class="ri-right">
      <div class="ri-amt ${r.type}">${r.type === 'expense' ? '-' : '+'}${S.yuan(r.amount, { sign: false })}</div>
      <div class="ri-date">${r.date.slice(5)}</div>
    </div>
  </div>`;
}

/* ---------------- 流水 ---------------- */
function renderFlow() {
  // 分类下拉
  const sel = $('#f-cat');
  const keep = sel.value;
  sel.innerHTML = '<option value="all">全部分类</option>' +
    ['expense', 'income'].map(t =>
      S.CATS[t].map(c => `<option value="${c.id}">${t === 'expense' ? '支出' : '收入'} · ${c.name}</option>`).join('')
    ).join('');
  sel.value = keep || 'all';

  let rs = S.inMonth(month);
  if (filters.type !== 'all') rs = rs.filter(r => r.type === filters.type);
  if (filters.cat !== 'all') rs = rs.filter(r => r.category === filters.cat);
  if (filters.temp !== 'all') rs = rs.filter(r => (r.temp ?? 0) === +filters.temp);
  if (filters.q) {
    const q = filters.q.toLowerCase();
    rs = rs.filter(r => (r.note || '').toLowerCase().includes(q) ||
      S.catOf(r.type, r.category).name.includes(q));
  }

  const box = $('#f-list');
  if (!rs.length) {
    box.innerHTML = `<div class="empty"><span class="e-ico">🔍</span><p>没有符合条件的记录</p></div>`;
    return;
  }
  const groups = {};
  rs.forEach(r => (groups[r.date] ||= []).push(r));
  box.innerHTML = Object.keys(groups).sort((a, b) => b.localeCompare(a)).map(date => {
    const g = groups[date];
    const exp = g.filter(r => r.type === 'expense').reduce((s, r) => s + r.amount, 0);
    const inc = g.filter(r => r.type === 'income').reduce((s, r) => s + r.amount, 0);
    return `<div class="day-group">
      <div class="day-head">
        <div class="dh-l"><b>${date.slice(5).replace('-', ' / ')}</b> ${dayLabel(date)}</div>
        <div class="dh-r">${exp ? '支出 ' + S.yuan(exp, { sign: false }) : ''}${inc ? ' · 收入 ' + S.yuan(inc, { sign: false }) : ''}</div>
      </div>
      ${g.map(r => `<div class="fitem" data-id="${r.id}">
        <div class="ri-ico">${S.catOf(r.type, r.category).icon}</div>
        <div class="ri-mid">
          <div class="ri-cat">${S.catOf(r.type, r.category).name}${r.temp !== null && r.temp !== undefined ? `<span class="temp-dot" style="background:${S.TEMP[String(r.temp)].color}" title="${S.TEMP[String(r.temp)].name}"></span>` : ''}</div>
          <div class="ri-note">${esc(r.note) || '—'}</div>
        </div>
        <div class="ri-right">
          <div class="ri-amt ${r.type}">${r.type === 'expense' ? '-' : '+'}${S.yuan(r.amount, { sign: false })}</div>
        </div>
        <button class="del" title="删除">×</button>
      </div>`).join('')}
    </div>`;
  }).join('');
}

function dayLabel(date) {
  const t = S.todayStr();
  if (date === t) return '· 今天';
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (date === y.toLocaleDateString('sv-SE')) return '· 昨天';
  return '· 周' + '日一二三四五六'[new Date(date).getDay()];
}

/* ---------------- 统计 ---------------- */
function renderStats() {
  const st = S.monthStat(month);
  const cats = catTemp(st.records).filter(c => c.sum > 0);
  const total = cats.reduce((s, c) => s + c.sum, 0);

  C.donut($('#s-donut'), cats.map(c => ({ name: c.name, value: c.sum, color: c.color })),
    S.yuan0(total), st.month.slice(5) + ' 月支出');
  $('#s-cat-chip').textContent = `${cats.length} 个分类 · 共 ${st.records.filter(r => r.type === 'expense').length} 笔`;
  $('#s-legend').innerHTML = cats.length ? cats.slice(0, 7).map(c => `
    <div class="lg">
      <span class="dot" style="background:${c.color}"></span>
      <span class="lg-n">${c.icon} ${c.name}</span>
      <span class="lg-v">${S.yuan0(c.sum)}</span>
      <span class="lg-p">${total ? ((c.sum / total) * 100).toFixed(0) : 0}%</span>
    </div>`).join('') : `<div class="empty" style="padding:20px"><p>暂无数据</p></div>`;

  // 近 6 月
  const data = S.recentMonths(6).map(m => {
    const s = S.monthStat(m);
    return { label: +m.slice(5, 7) + '月', expense: s.expense, income: s.income };
  });
  C.trend($('#s-trend'), data);

  // 排行
  const max = cats[0]?.sum || 1;
  $('#s-rank').innerHTML = cats.length ? cats.map((c, i) => `
    <div class="rk">
      <span class="rk-i">${String(i + 1).padStart(2, '0')}</span>
      <span class="rk-n">${c.icon} ${c.name} <span style="color:#5f6779;font-size:11.5px">${c.n} 笔</span></span>
      <span class="rk-v">${S.yuan0(c.sum)}</span>
      <span class="rk-bar"><i style="width:${(c.sum / max) * 100}%;background:linear-gradient(90deg,${c.color},${c.color}55)"></i></span>
    </div>`).join('') : `<div class="empty"><p>暂无支出</p></div>`;

  // 热力图
  const daily = {};
  S.all().forEach(r => {
    if (r.type === 'expense') daily[r.date] = (daily[r.date] || 0) + r.amount;
  });
  C.heat($('#s-heat'), daily, 16);
}

/* ---------------- 温度报告 ---------------- */
function renderReport() {
  const st = S.monthStat(month);
  const ex = st.records.filter(r => r.type === 'expense');
  const ot = overallTemp(ex);

  if (!ex.length) {
    $('#r-temp-val').textContent = '—';
    $('#r-temp-desc').textContent = '这个月还没有支出';
    $('#r-insights').innerHTML = `<div class="empty"><span class="e-ico">🌡️</span><p>记几笔之后，这里会长出一份报告</p></div>`;
    ['#r-gauge', '#r-tempbars', '#r-dist', '#r-best', '#r-worst'].forEach(s => $(s).innerHTML = '');
    return;
  }

  const [mood, desc] = tempDesc(ot.weighted);
  $('#r-temp-val').textContent = ot.weighted.toFixed(2);
  $('#r-temp-val').style.color = C.TEMPCOLOR(ot.weighted);
  $('#r-temp-desc').textContent = `${mood} · ${desc}`;
  C.gauge($('#r-gauge'), ot.weighted, mood);

  $('#r-insights').innerHTML = buildInsights(month, S.getBudget())
    .map(i => `<div class="ins"><span class="ins-i">${i.icon}</span><div class="ins-t">${i.text}</div></div>`).join('');

  // 分类温度条
  const cats = catTemp(ex).filter(c => c.n >= 1).sort((a, b) => b.avg - a.avg);
  $('#r-tempbars').innerHTML = cats.length ? cats.slice(0, 8).map(c => {
    const w = Math.abs(c.avg) / 2 * 50;
    const left = c.avg >= 0 ? 50 : 50 - w;
    return `<div class="tbar">
      <span class="tbar-n">${c.icon} ${c.name}</span>
      <div class="tbar-track">
        <div class="tbar-mid"></div>
        <div class="tbar-fill" style="left:${left}%;width:${Math.max(1.5, w)}%;background:${C.TEMPCOLOR(c.avg)}"></div>
      </div>
      <span class="tbar-v">${c.avg.toFixed(1)}</span>
    </div>`;
  }).join('') : '';

  // 温度分布
  const dist = tempDistribution(ex);
  const maxN = Math.max(1, ...dist.map(d => d.n));
  $('#r-dist').innerHTML = dist.map(d => `
    <div class="dist-row">
      <span class="dist-n">${d.icon} ${d.name}</span>
      <div class="dist-track"><div class="dist-fill" style="width:${(d.n / maxN) * 100}%;background:${d.color}"></div></div>
      <span class="dist-v">${d.n} 笔</span>
    </div>`).join('');

  // 最值 / 最后悔
  const sorted = ex.slice().sort((a, b) => (b.temp ?? 0) - (a.temp ?? 0) || b.amount - a.amount);
  const poleHTML = r => {
    if (!r) return `<div class="empty" style="padding:16px"><p>—</p></div>`;
    const c = S.catOf('expense', r.category);
    return `<div class="pb-amt" style="color:${C.TEMPCOLOR(r.temp)}">${S.yuan(r.amount)}</div>
      <div class="pb-cat">${c.icon} ${c.name} · ${r.date.slice(5)} · ${S.TEMP[String(r.temp)].name}</div>
      <div class="pb-note">「${esc(r.note) || '没写备注'}」</div>`;
  };
  $('#r-best').innerHTML = poleHTML(sorted[0]);
  $('#r-worst').innerHTML = poleHTML(sorted.length > 1 ? sorted.at(-1) : null);
}

/* ============================================================
   记一笔 抽屉
   ============================================================ */
function renderCats() {
  $('#a-cats').innerHTML = S.CATS[draft.type].map(c =>
    `<button class="cat-b${c.id === draft.cat ? ' is-active' : ''}" data-cat="${c.id}">
      <i>${c.icon}</i><span>${c.name}</span></button>`).join('');
}

function openSheet() {
  draft.amount = ''; draft.note = ''; draft.date = S.todayStr(); draft.temp = 0;
  draft.type = 'expense'; draft.cat = 'food';
  $('#a-note').value = ''; $('#a-date').value = draft.date;
  $('#a-amount').textContent = '0';
  syncTypeUI();
  renderCats();
  $('#mask').classList.add('on'); $('#sheet').classList.add('on');
  setTimeout(() => $('#sheet').querySelector('.keypad button')?.focus(), 50);
}
function closeSheet() { $('#mask').classList.remove('on'); $('#sheet').classList.remove('on'); }

function syncTypeUI() {
  $$('#a-type .seg-b').forEach(b => b.classList.toggle('is-active', b.dataset.type === draft.type));
  $('#a-temp').style.display = draft.type === 'expense' ? '' : 'none';
  $('#sheet-title').textContent = draft.type === 'expense' ? '花了一笔' : '进了一笔';
}

function pushKey(k) {
  if (k === 'del') draft.amount = draft.amount.slice(0, -1);
  else if (k === '.') { if (!draft.amount.includes('.')) draft.amount = (draft.amount || '0') + '.'; }
  else {
    if (draft.amount.includes('.')) {
      const dec = draft.amount.split('.')[1];
      if (dec.length >= 2) return;
    }
    if (draft.amount.replace('.', '').length >= 9) return;
    draft.amount = draft.amount === '0' ? k : draft.amount + k;
  }
  $('#a-amount').textContent = draft.amount === '' ? '0' : draft.amount;
}

function saveRecord() {
  const cents = S.parseAmount(draft.amount);
  if (cents <= 0) { toast('先输个金额吧'); return; }
  const r = S.add({
    type: draft.type, amount: cents, category: draft.cat,
    note: $('#a-note').value, date: $('#a-date').value || S.todayStr(),
    temp: draft.type === 'expense' ? draft.temp : null,
  });
  if (S.monthOf(r.date) !== month) month = S.monthOf(r.date);
  closeSheet();
  render();
  toast(`已记下 ${S.yuan(r.amount)} · ${S.catOf(r.type, r.category).name}${draft.type === 'expense' ? ' · ' + S.TEMP[String(r.temp)].name : ''}`);
}

/* ============================================================
   数据管理
   ============================================================ */
function download(name, text, mime) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function exportJSON() {
  download(`温度账本-${S.todayStr()}.json`,
    JSON.stringify({ app: 'thermo', version: 1, budget: S.getBudget(), records: S.all() }, null, 2),
    'application/json');
  toast('已导出 JSON');
}

function exportCSV() {
  const head = '日期,类型,分类,金额(元),备注,温度\n';
  const body = S.all().map(r => {
    const t = r.temp === null || r.temp === undefined ? '' : S.TEMP[String(r.temp)].name;
    return [r.date, r.type === 'expense' ? '支出' : '收入', S.catOf(r.type, r.category).name,
      (r.amount / 100).toFixed(2), `"${(r.note || '').replace(/"/g, '""')}"`, t].join(',');
  }).join('\n');
  download(`温度账本-${S.todayStr()}.csv`, '\uFEFF' + head + body, 'text/csv;charset=utf-8');
  toast('已导出 CSV');
}

function importJSON(file) {
  const fr = new FileReader();
  fr.onload = () => {
    try {
      const j = JSON.parse(fr.result);
      const rs = Array.isArray(j) ? j : j.records;
      if (!Array.isArray(rs)) throw new Error('格式不对');
      if (!confirm(`将导入 ${rs.length} 条记录，覆盖当前账本，继续？`)) return;
      S.replaceAll(rs, j.budget ?? 0);
      month = S.curMonth(); render();
      toast(`导入成功 · ${rs.length} 条`);
    } catch (e) { toast('导入失败：不是有效的账本文件'); }
  };
  fr.readAsText(file);
}

/* ============================================================
   事件绑定
   ============================================================ */
function bind() {
  $$('.navitem, .tab[data-view], .link-btn').forEach(b =>
    b.addEventListener('click', () => setView(b.dataset.view)));

  $('#m-prev').addEventListener('click', () => setMonth(S.shiftMonth(month, -1)));
  $('#m-next').addEventListener('click', () => setMonth(S.shiftMonth(month, 1)));

  $('#fab').addEventListener('click', openSheet);
  $('#fab2').addEventListener('click', openSheet);
  $('#sheet-close').addEventListener('click', closeSheet);
  $('#mask').addEventListener('click', closeSheet);

  $$('#a-type .seg-b').forEach(b => b.addEventListener('click', () => {
    draft.type = b.dataset.type; draft.cat = S.CATS[draft.type][0].id;
    syncTypeUI(); renderCats();
  }));

  $('#a-cats').addEventListener('click', e => {
    const btn = e.target.closest('.cat-b'); if (!btn) return;
    draft.cat = btn.dataset.cat; renderCats();
  });

  $('#a-temp').addEventListener('click', e => {
    const btn = e.target.closest('.tp'); if (!btn) return;
    draft.temp = +btn.dataset.t;
    $$('#a-temp .tp').forEach(b => b.classList.toggle('is-active', b === btn));
  });

  $('#a-keys').addEventListener('click', e => {
    const btn = e.target.closest('button'); if (!btn) return;
    pushKey(btn.dataset.k);
  });
  $('#a-save').addEventListener('click', saveRecord);

  // 流水筛选
  $('#f-search').addEventListener('input', e => { filters.q = e.target.value.trim(); renderFlow(); });
  $('#f-cat').addEventListener('change', e => { filters.cat = e.target.value; renderFlow(); });
  $('#f-temp').addEventListener('change', e => { filters.temp = e.target.value; renderFlow(); });
  $$('#f-type .seg-b').forEach(b => b.addEventListener('click', () => {
    filters.type = b.dataset.type;
    $$('#f-type .seg-b').forEach(x => x.classList.toggle('is-active', x === b));
    renderFlow();
  }));
  $('#f-list').addEventListener('click', e => {
    const del = e.target.closest('.del'); if (!del) return;
    const id = del.closest('.fitem').dataset.id;
    if (!confirm('删除这一笔？')) return;
    S.remove(id); render(); toast('已删除');
  });

  // 数据
  $('#btn-budget').addEventListener('click', () => {
    const v = prompt('月预算（元）', (S.getBudget() / 100) || 6000);
    if (v === null) return;
    const c = S.parseAmount(v);
    S.setBudget(c);
    render(); toast(c > 0 ? `月预算已设为 ${S.yuan0(c)}` : '已取消预算');
  });
  $('#btn-export').addEventListener('click', exportJSON);
  $('#btn-csv').addEventListener('click', exportCSV);
  $('#btn-import').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', e => {
    const f = e.target.files[0]; if (f) importJSON(f);
    e.target.value = '';
  });
  $('#btn-reset').addEventListener('click', () => {
    if (!confirm('清空所有记录？此操作不可恢复。')) return;
    S.replaceAll([], S.getBudget()); render(); toast('账本已清空');
  });

  // 快捷键
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeSheet();
    if ($('#sheet').classList.contains('on')) {
      if (/^[0-9]$/.test(e.key)) pushKey(e.key);
      else if (e.key === '.') pushKey('.');
      else if (e.key === 'Backspace') { e.preventDefault(); pushKey('del'); }
      else if (e.key === 'Enter') saveRecord();
      return;
    }
    if ((e.key === 'n' || e.key === 'N') && !/input|select|textarea/i.test(document.activeElement.tagName)) {
      e.preventDefault(); openSheet();
    }
  });
}

/* ---------------- 启动 ---------------- */
S.load();
bind();
setView('dash');
