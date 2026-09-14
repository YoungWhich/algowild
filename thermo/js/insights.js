/* ============================================================
   insights.js — 「账本说」温度报告生成器
   纯规则引擎：不接任何大模型，本地即时算、可解释
   ============================================================ */

import { CATS, TEMP, catOf, yuan, monthStat, shiftMonth, curMonth, todayStr } from './store.js';

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const b = s => `<b>${s}</b>`;

/** 按分类算平均温度与总额 */
export function catTemp(records) {
  const map = {};
  for (const r of records) {
    if (r.type !== 'expense') continue;
    (map[r.category] ||= { sum: 0, n: 0, tsum: 0 });
    map[r.category].sum += r.amount;
    map[r.category].n += 1;
    map[r.category].tsum += (r.temp || 0);
  }
  return Object.entries(map).map(([id, v]) => ({
    id, name: catOf('expense', id).name, icon: catOf('expense', id).icon,
    color: catOf('expense', id).color,
    sum: v.sum, n: v.n, avg: v.tsum / v.n,
  })).sort((a, c) => c.sum - a.sum);
}

export function overallTemp(records) {
  const ex = records.filter(r => r.type === 'expense');
  if (!ex.length) return { avg: 0, n: 0, weighted: 0 };
  const tsum = ex.reduce((s, r) => s + (r.temp || 0), 0);
  // 金额加权温度：花得多的笔权重大
  const wsum = ex.reduce((s, r) => s + (r.temp || 0) * r.amount, 0);
  const total = ex.reduce((s, r) => s + r.amount, 0) || 1;
  return { avg: tsum / ex.length, weighted: wsum / total, n: ex.length };
}

export function tempDesc(v) {
  if (v <= -1.5) return ['冰冷 ❄️', '这个月的钱，花得有点憋屈。'];
  if (v <= -0.6) return ['偏凉 🌤', '大部分是「该花但不太爽」的钱。'];
  if (v < 0.35) return ['常温 ·', '理性、平稳，没什么大起大落。'];
  if (v < 1.0) return ['温热 ☀︎', '多数钱花在了让你开心的地方。'];
  return ['滚烫 🔥', '这个月，钱花得很值。'];
}

/** 主入口：返回洞察卡片数组 */
export function buildInsights(month, budget) {
  const st = monthStat(month);
  const prev = monthStat(shiftMonth(month, -1));
  const ex = st.records.filter(r => r.type === 'expense');
  const out = [];
  if (!ex.length) {
    return [{ icon: '🌱', text: `这个月还没有支出记录。点右下角 <b>＋</b> 记下第一笔吧。` }];
  }

  const ot = overallTemp(ex);
  const cats = catTemp(ex);
  const [mood, moodDesc] = tempDesc(ot.weighted);

  /* 1. 总评 */
  out.push({
    icon: '🌡️',
    text: `本月共 <b>${ex.length}</b> 笔支出，合计 ${b(yuan(st.expense))}，加权体温 <b>${mood}</b>（${ot.weighted.toFixed(2)}）。${moodDesc}`,
  });

  /* 2. 最大头 */
  const top = cats[0];
  const pct = ((top.sum / st.expense) * 100).toFixed(0);
  out.push({
    icon: top.icon,
    text: `<b>${top.name}</b> 是这个月的大头：${b(yuan(top.sum))}，占支出 <b>${pct}%</b>，平均温度 <span class="${top.avg >= 0 ? 'hot' : 'cold'}">${top.avg.toFixed(2)}</span>。`,
  });

  /* 3. 最该反省的：金额高 + 温度低 */
  const regret = cats.filter(c => c.sum > st.expense * 0.06).sort((a, c) => a.avg - c.avg)[0];
  if (regret && regret.avg < 0.4) {
    out.push({
      icon: '💧',
      text: `花得最多却最不开心的是 <b>${regret.name}</b>：${b(yuan(regret.sum))}，平均温度只有 <span class="cold">${regret.avg.toFixed(2)}</span>。下个月可以先从这里砍一刀。`,
    });
  }

  /* 4. 最值得的 */
  const best = cats.filter(c => c.n >= 2).sort((a, c) => c.avg - a.avg)[0];
  if (best && best.avg >= 0.8) {
    out.push({
      icon: '🔥',
      text: `<b>${best.name}</b> 是本月幸福效率冠军：${b(yuan(best.sum))} 换来了 <span class="hot">${best.avg.toFixed(2)}</span> 的平均温度。这类钱，值得继续花。`,
    });
  }

  /* 5. 环比 */
  if (prev.expense > 0) {
    const diff = st.expense - prev.expense;
    const rate = ((diff / prev.expense) * 100).toFixed(0);
    const d = new Date();
    const isCur = month === curMonth();
    const daysPassed = isCur ? +todayStr().slice(8, 10) : new Date(+month.slice(0, 4), +month.slice(5, 7), 0).getDate();
    const dim = new Date(+month.slice(0, 4), +month.slice(5, 7), 0).getDate();
    if (isCur) {
      const pace = Math.round(st.expense / daysPassed * dim);
      const pdiff = pace - prev.expense;
      const prate = Math.abs(pdiff / prev.expense * 100).toFixed(0);
      out.push({
        icon: pdiff > 0 ? '📈' : '📉',
        text: `按已过 <b>${daysPassed}/${dim}</b> 天的速度，月底预计支出 ${b(yuan(pace))}，比上月${pdiff > 0 ? '多' : '少'} <b>${prate}%</b>。`,
      });
    } else {
      out.push({
        icon: diff > 0 ? '📈' : '📉',
        text: `相比上月${diff > 0 ? '多花' : '少花'}了 ${b(yuan(Math.abs(diff)))}（${diff > 0 ? '+' : '-'}${Math.abs(rate)}%）。`,
      });
    }
  }

  /* 6. 预算 */
  if (budget > 0) {
    const p = st.expense / budget;
    if (p > 1) {
      out.push({ icon: '🚨', text: `已超出预算 ${b(yuan(st.expense - budget))}（用了 <b>${(p * 100).toFixed(0)}%</b>）。是时候踩一脚刹车了。` });
    } else if (month === curMonth()) {
      const d = new Date();
      const dim = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      const left = dim - +todayStr().slice(8, 10) + 1;
      out.push({
        icon: '🎯',
        text: `预算已用 <b>${(p * 100).toFixed(0)}%</b>，还剩 ${b(yuan(budget - st.expense))}，摊到剩下 <b>${left}</b> 天是每天 ${b(yuan(Math.round((budget - st.expense) / left)))}。`,
      });
    }
  }

  /* 7. 小钱黑洞 */
  const tiny = ex.filter(r => r.amount < 3000);
  if (tiny.length >= 5) {
    const s = tiny.reduce((a, r) => a + r.amount, 0);
    out.push({
      icon: '🕳️',
      text: `有 <b>${tiny.length}</b> 笔不到 30 元的小钱，加起来 ${b(yuan(s))}，占支出 <b>${((s / st.expense) * 100).toFixed(0)}%</b>。钱往往是这样溜走的。`,
    });
  }

  /* 8. 疯狂的一天 */
  const dayIdx = st.days.indexOf(Math.max(...st.days));
  const maxDay = Math.max(...st.days);
  if (maxDay > 0 && dayIdx > 0) {
    out.push({
      icon: '💥',
      text: `<b>${dayIdx} 号</b> 是本月最猛的一天，单日花掉 ${b(yuan(maxDay))}，占全月 <b>${((maxDay / st.expense) * 100).toFixed(0)}%</b>。`,
    });
  }

  /* 9. 工作日 vs 周末 */
  const we = ex.filter(r => [0, 6].includes(new Date(r.date).getDay()));
  if (we.length && ex.length) {
    const weSum = we.reduce((a, r) => a + r.amount, 0);
    const wep = (weSum / st.expense) * 100;
    if (wep > 40) {
      out.push({ icon: '🌙', text: `周末花掉了全月的 <b>${wep.toFixed(0)}%</b>，工作日反而更省钱。` });
    }
  }

  return out.slice(0, 6);
}

/** 温度分布（按笔数） */
export function tempDistribution(records) {
  const ex = records.filter(r => r.type === 'expense');
  const total = ex.length || 1;
  return [2, 1, 0, -1, -2].map(t => {
    const n = ex.filter(r => (r.temp || 0) === t).length;
    return { t, n, p: n / total, ...TEMP[String(t)] };
  });
}
