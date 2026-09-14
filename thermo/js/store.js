/* ============================================================
   store.js — 数据层
   金额一律以「分」(integer cents) 存储，杜绝浮点误差
   数据落在 localStorage，永不上传
   ============================================================ */

const KEY = 'thermo.v1';

export const CATS = {
  expense: [
    { id: 'food',    name: '餐饮', icon: '🍜', color: '#ff7a59' },
    { id: 'transit', name: '交通', icon: '🚇', color: '#4ea8de' },
    { id: 'shop',    name: '购物', icon: '🛍️', color: '#c77dff' },
    { id: 'home',    name: '居住', icon: '🏠', color: '#ffd166' },
    { id: 'fun',     name: '娱乐', icon: '🎮', color: '#06d6a0' },
    { id: 'health',  name: '医疗', icon: '💊', color: '#ef476f' },
    { id: 'study',   name: '学习', icon: '📚', color: '#118ab2' },
    { id: 'social',  name: '人情', icon: '🎁', color: '#f78c6b' },
    { id: 'travel',  name: '旅行', icon: '✈️', color: '#73c2fb' },
    { id: 'other',   name: '其他', icon: '📦', color: '#8a93a8' },
  ],
  income: [
    { id: 'salary', name: '工资', icon: '💰', color: '#2fd39f' },
    { id: 'side',   name: '副业', icon: '🧰', color: '#7c5cff' },
    { id: 'invest', name: '理财', icon: '📈', color: '#ffb020' },
    { id: 'gift',   name: '红包', icon: '🧧', color: '#ff6a3d' },
    { id: 'otherin',name: '其他', icon: '✨', color: '#8a93a8' },
  ],
};

/** 温度色阶：-2 冰冷（后悔）→ +2 滚烫（值得） */
export const TEMP = {
  '-2': { name: '冰冷', icon: '❄️', color: '#3d8bff', desc: '花完就后悔' },
  '-1': { name: '微凉', icon: '🌤', color: '#3fc7d4', desc: '有点小亏' },
  '0':  { name: '平淡', icon: '•',  color: '#8a93a8', desc: '该花的钱' },
  '1':  { name: '温热', icon: '☀︎', color: '#ffb020', desc: '花得还行' },
  '2':  { name: '滚烫', icon: '🔥', color: '#ff6a3d', desc: '太值了' },
};

export const catOf = (type, id) => CATS[type].find(c => c.id === id) || CATS[type].at(-1);

/* ---------------- 基础读写 ---------------- */

let state = { records: [], budget: 0, seeded: false };

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) state = { ...state, ...JSON.parse(raw) };
  } catch (e) { console.warn('读取失败，使用空账本', e); }
  if (!state.seeded) { state.records = seed(); state.budget = 1200000; state.seeded = true; save(); }
  return state;
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); }
  catch (e) { console.warn('本地存储写入失败', e); }
}

export const all = () => state.records.slice().sort((a, b) =>
  (b.date + b.ts).localeCompare(a.date + b.ts));

export function add(rec) {
  const r = {
    id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    type: rec.type, amount: rec.amount, category: rec.category,
    note: (rec.note || '').trim(), date: rec.date,
    temp: rec.type === 'expense' ? (rec.temp ?? 0) : null,
    ts: Date.now(),
  };
  state.records.push(r); save(); return r;
}

export function remove(id) {
  state.records = state.records.filter(r => r.id !== id); save();
}

export function replaceAll(records, budget) {
  state.records = records;
  if (typeof budget === 'number') state.budget = budget;
  save();
}

export const getBudget = () => state.budget || 0;
export function setBudget(v) { state.budget = Math.max(0, Math.round(v)); save(); }

/* ---------------- 聚合 ---------------- */

export const monthOf = d => d.slice(0, 7);
export const todayStr = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD
export const curMonth = () => todayStr().slice(0, 7);

export function shiftMonth(m, delta) {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(y, mo - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export const inMonth = (m) => all().filter(r => monthOf(r.date) === m);

/** 单月统计 */
export function monthStat(m) {
  const rs = inMonth(m);
  let expense = 0, income = 0;
  const byCat = {}, days = new Array(32).fill(0);
  for (const r of rs) {
    if (r.type === 'expense') {
      expense += r.amount;
      byCat[r.category] = (byCat[r.category] || 0) + r.amount;
      days[+r.date.slice(8, 10)] += r.amount;
    } else income += r.amount;
  }
  return { month: m, expense, income, balance: income - expense, byCat, days, count: rs.length, records: rs };
}

/** 近 n 个月（含当前月） */
export function recentMonths(n = 6) {
  const out = []; let m = curMonth();
  for (let i = 0; i < n; i++) { out.unshift(m); m = shiftMonth(m, -1); }
  return out;
}

/** 某月每天支出，用于热力图 */
export function dailyTotal(dateStr) {
  return all().filter(r => r.type === 'expense' && r.date === dateStr)
              .reduce((s, r) => s + r.amount, 0);
}

/* ---------------- 格式化 ---------------- */
export function yuan(cents, opt = {}) {
  const v = cents / 100;
  const s = Math.abs(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (opt.sign === false ? '' : (v < 0 ? '-' : '')) + '¥' + s;
}
export const yuan0 = c => '¥' + Math.round(c / 100).toLocaleString('zh-CN');
export const parseAmount = s => Math.round(parseFloat(s || 0) * 100);

/* ---------------- 演示数据 ---------------- */
/* 固定种子 LCG：保证每次生成的账本一致，截图/演示可复现 */
function seed() {
  let s = 20260910;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

  const NOTES = {
    food:    ['食堂', '外卖·麻辣烫', '和同事拼饭', '早餐', '咖啡', '火锅', '便利店'],
    transit: ['地铁', '打车回家', '共享单车', '高铁票'],
    shop:    ['日用品', '冲动买的耳机', '衣服', '直播间下单', '手机壳'],
    home:    ['房租', '水电燃气', '宽带费', '洗衣液'],
    fun:     ['电影票', '游戏充值', 'livehouse', '健身房月卡'],
    health:  ['感冒药', '体检', '挂号费'],
    study:   ['技术书', '线上课程', '考试报名'],
    social:  ['同事结婚随礼', '给妈妈买礼物', '请朋友吃饭'],
    travel:  ['周末民宿', '机票', '景区门票'],
    other:   ['杂项', '忘了记什么'],
  };
  // 每个分类的「温度倾向」：负数=容易后悔
  const TEMP_BIAS = { food: -0.6, transit: 0.1, shop: -1.4, home: 0.2, fun: 0.3,
                      health: -0.2, study: 1.5, social: 0.8, travel: 1.6, other: -0.3 };
  // 每个分类的单笔金额区间（元）
  const RANGE = { food: [15, 90], transit: [4, 60], shop: [39, 480], home: [80, 2600],
                  fun: [25, 220], health: [20, 400], study: [30, 300], social: [100, 800],
                  travel: [120, 1500], other: [10, 120] };

  const out = [];
  const today = new Date();
  let base = Date.now();

  for (let back = 4; back >= 0; back--) {
    const d = new Date(today.getFullYear(), today.getMonth() - back, 1);
    const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    const isCur = back === 0;
    const last = isCur ? today.getDate() : daysInMonth;
    const n = isCur ? Math.round(last * 1.15) : Math.round(daysInMonth * 0.95);

    for (let i = 0; i < n; i++) {
      const day = 1 + Math.floor(rnd() * last);
      const pool = Object.keys(NOTES);
      // 越冷门的分类出现概率越低
      const cat = pool[Math.floor(rnd() * pool.length)];
      const [lo, hi] = RANGE[cat];
      let amount = lo + rnd() * (hi - lo);
      if (cat === 'home' && rnd() > 0.6) amount = 2600 + rnd() * 300; // 房租（元）
      amount = Math.round(amount) * 100;

      // 温度 = 分类倾向 + 噪声，夹在 [-2, 2]
      let t = TEMP_BIAS[cat] + (rnd() - 0.5) * 2.4;
      t = Math.max(-2, Math.min(2, Math.round(t)));

      out.push({
        id: 's' + (out.length).toString(36),
        type: 'expense', amount, category: cat,
        note: NOTES[cat][Math.floor(rnd() * NOTES[cat].length)],
        date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
        temp: t, ts: base - out.length * 1000,
      });
    }
    // 每月工资 + 偶尔副业
    out.push({
      id: 's' + out.length.toString(36), type: 'income', amount: 1680000,
      category: 'salary', note: '月薪',
      date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-10`,
      temp: null, ts: base - out.length * 1000,
    });
    if (rnd() > 0.4) {
      out.push({
        id: 's' + out.length.toString(36), type: 'income',
        amount: Math.round((80 + rnd() * 220) * 100), category: 'side', note: '接的私活',
        date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(1 + Math.floor(rnd() * last)).padStart(2, '0')}`,
        temp: null, ts: base - out.length * 1000,
      });
    }
  }
  return out;
}
