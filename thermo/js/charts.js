/* ============================================================
   charts.js — 零依赖手写 SVG 图表
   不用任何 CDN / 图表库：离线可用、样式完全可控
   ============================================================ */

const NS = 'http://www.w3.org/2000/svg';
const mk = (tag, attrs = {}) => {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
};
const clear = el => { while (el.firstChild) el.removeChild(el.firstChild); };

/* ---------------- 1. 预算环 ---------------- */
export function ring(box, { percent, top, bottom, color = '#7c5cff', over = false }) {
  clear(box);
  const S = 132, C = 58, W = 13, R = (S - W) / 2 - 4;
  const circ = 2 * Math.PI * R;
  const p = Math.max(0, Math.min(1, percent));
  const svg = mk('svg', { viewBox: `0 0 ${S} ${S}`, width: '100%', height: '100%' });
  const g = mk('g', { transform: `translate(${S / 2},${S / 2}) rotate(-90)` });

  g.appendChild(mk('circle', { r: R, fill: 'none', stroke: 'rgba(255,255,255,.07)', 'stroke-width': W }));
  const arc = mk('circle', {
    r: R, fill: 'none', stroke: over ? '#ff5d5d' : color, 'stroke-width': W,
    'stroke-linecap': 'round', 'stroke-dasharray': circ,
    'stroke-dashoffset': circ * (1 - p),
  });
  arc.style.transition = 'stroke-dashoffset .8s cubic-bezier(.2,.8,.2,1)';
  if (!over) arc.setAttribute('filter', 'url(#rglow)');
  const defs = mk('defs');
  const f = mk('filter', { id: 'rglow', x: '-50%', y: '-50%', width: '200%', height: '200%' });
  f.appendChild(mk('feGaussianBlur', { stdDeviation: '3.5', result: 'b' }));
  const fm = mk('feMerge'); fm.appendChild(mk('feMergeNode', { in: 'b' }));
  fm.appendChild(mk('feMergeNode', { in: 'SourceGraphic' })); f.appendChild(fm);
  defs.appendChild(f); svg.appendChild(defs);
  g.appendChild(arc); svg.appendChild(g);

  const t1 = mk('text', { x: S / 2, y: C + 2, 'text-anchor': 'middle', fill: '#fff', 'font-size': '19', 'font-weight': '700' });
  t1.textContent = top;
  const t2 = mk('text', { x: S / 2, y: C + 19, 'text-anchor': 'middle', fill: '#8a93a8', 'font-size': '10.5' });
  t2.textContent = bottom;
  svg.appendChild(t1); svg.appendChild(t2);
  box.appendChild(svg);
}

/* ---------------- 2. 每日柱 ---------------- */
export function spark(box, days, maxDay) {
  clear(box);
  const max = Math.max(1, ...days);
  days.forEach((v, i) => {
    const d = document.createElement('div');
    d.className = 'sb' + (v === 0 ? ' zero' : '') + (i + 1 === maxDay ? ' today' : '');
    d.style.height = v === 0 ? '3px' : Math.max(6, (v / max) * 100) + '%';
    d.title = `${i + 1} 日 · ¥${(v / 100).toFixed(2)}`;
    box.appendChild(d);
  });
}

/* ---------------- 3. 分类甜甜圈 ---------------- */
export function donut(box, items, centerTop, centerBottom) {
  clear(box);
  const S = 168, W = 22, R = (S - W) / 2 - 2, C = 2 * Math.PI * R;
  const total = items.reduce((s, i) => s + i.value, 0) || 1;
  const svg = mk('svg', { viewBox: `0 0 ${S} ${S}`, width: '100%', height: '100%' });
  const g = mk('g', { transform: `translate(${S / 2},${S / 2}) rotate(-90)` });

  let offset = 0;
  items.forEach(it => {
    const len = (it.value / total) * C;
    const c = mk('circle', {
      r: R, fill: 'none', stroke: it.color, 'stroke-width': W,
      'stroke-dasharray': `${Math.max(0, len - 2.5)} ${C - Math.max(0, len - 2.5)}`,
      'stroke-dashoffset': -offset, 'stroke-linecap': 'butt',
    });
    const ttl = mk('title'); ttl.textContent = `${it.name} ¥${(it.value / 100).toFixed(2)}`;
    c.appendChild(ttl); g.appendChild(c);
    offset += len;
  });
  svg.appendChild(g);

  const t1 = mk('text', { x: S / 2, y: S / 2 - 1, 'text-anchor': 'middle', fill: '#fff', 'font-size': '15', 'font-weight': '700' });
  t1.textContent = centerTop;
  const t2 = mk('text', { x: S / 2, y: S / 2 + 14, 'text-anchor': 'middle', fill: '#8a93a8', 'font-size': '10' });
  t2.textContent = centerBottom;
  svg.appendChild(t1); svg.appendChild(t2);
  box.appendChild(svg);
}

/* ---------------- 4. 近 N 月柱 + 收入折线 ---------------- */
export function trend(box, data) {
  clear(box);
  const W = 520, H = 170, PL = 8, PB = 24, PT = 12;
  const svg = mk('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: '100%', preserveAspectRatio: 'xMidYMid meet' });
  const max = Math.max(1, ...data.map(d => Math.max(d.expense, d.income)));
  const innerH = H - PB - PT;
  const step = (W - PL * 2) / data.length;
  const bw = Math.min(30, step * 0.42);

  // 基线
  svg.appendChild(mk('line', { x1: PL, y1: PT + innerH, x2: W - PL, y2: PT + innerH, stroke: 'rgba(255,255,255,.08)', 'stroke-width': '1' }));

  const pts = [];
  data.forEach((d, i) => {
    const cx = PL + step * (i + 0.5);
    const h = (d.expense / max) * innerH;
    const r = mk('rect', {
      x: cx - bw / 2, y: PT + innerH - h, width: bw, height: Math.max(2, h),
      rx: Math.min(5, bw / 2), fill: 'url(#tgrad)',
    });
    const ttl = mk('title'); ttl.textContent = `${d.label} 支出 ¥${(d.expense / 100).toFixed(0)}`;
    r.appendChild(ttl); svg.appendChild(r);

    const ly = PT + innerH - (d.income / max) * innerH;
    pts.push([cx, ly]);
    const lb = mk('text', { x: cx, y: H - 7, 'text-anchor': 'middle', fill: '#5f6779', 'font-size': '10.5' });
    lb.textContent = d.label; svg.appendChild(lb);
  });

  // 收入折线
  if (pts.length > 1) {
    const path = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    svg.appendChild(mk('path', { d: path, fill: 'none', stroke: '#2fd39f', 'stroke-width': '2', 'stroke-linejoin': 'round', 'stroke-linecap': 'round', opacity: '.9' }));
    pts.forEach(p => svg.appendChild(mk('circle', { cx: p[0], cy: p[1], r: '3.2', fill: '#0d0f16', stroke: '#2fd39f', 'stroke-width': '2' })));
  }

  const defs = mk('defs');
  const lg = mk('linearGradient', { id: 'tgrad', x1: '0', y1: '0', x2: '0', y2: '1' });
  lg.appendChild(mk('stop', { offset: '0%', 'stop-color': '#ff7a59' }));
  lg.appendChild(mk('stop', { offset: '100%', 'stop-color': 'rgba(255,122,89,.22)' }));
  defs.appendChild(lg); svg.appendChild(defs);
  box.appendChild(svg);
}

/* ---------------- 5. 消费热力图（近 16 周） ---------------- */
export function heat(box, daily, weeks = 16) {
  clear(box);
  const wrap = document.createElement('div');
  const grid = document.createElement('div');
  grid.className = 'heat-grid';

  const today = new Date();
  // 回到本周日之前 weeks-1 周的周一
  const end = new Date(today);
  const start = new Date(today);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7) - (weeks - 1) * 7);

  const vals = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const key = d.toLocaleDateString('sv-SE');
    vals.push({ key, date: new Date(d), v: daily[key] || 0 });
  }
  const max = Math.max(1, ...vals.map(x => x.v));

  // 周日开头补空位
  const pad = (start.getDay() + 6) % 7;
  for (let i = 0; i < pad; i++) grid.appendChild(Object.assign(document.createElement('div'), { className: 'hc', style: 'visibility:hidden' }));

  const tk = today.toLocaleDateString('sv-SE');
  vals.forEach(x => {
    const c = document.createElement('div');
    const lv = x.v === 0 ? 0 : x.v / max < 0.25 ? 1 : x.v / max < 0.5 ? 2 : x.v / max < 0.75 ? 3 : 4;
    c.className = 'hc' + (lv ? ' l' + lv : '') + (x.key === tk ? ' today' : '');
    c.title = `${x.key} · ¥${(x.v / 100).toFixed(2)}`;
    grid.appendChild(c);
  });
  wrap.appendChild(grid);

  const lg = document.createElement('div');
  lg.className = 'heat-legend';
  lg.innerHTML = '<span>少</span>';
  ['', 'l1', 'l2', 'l3', 'l4'].forEach(c => {
    const i = document.createElement('i'); i.className = 'hc ' + c; lg.appendChild(i);
  });
  const s = document.createElement('span'); s.textContent = '多'; lg.appendChild(s);
  const t = document.createElement('span');
  t.style.marginLeft = 'auto'; t.textContent = `峰值 ¥${(max / 100).toFixed(0)}`;
  lg.appendChild(t);
  wrap.appendChild(lg);
  box.appendChild(wrap);
}

/* ---------------- 6. 温度仪表（半圆） ---------------- */
export function gauge(box, value /* -2 .. 2 */, label) {
  clear(box);
  const W = 280, H = 150, R = 96, CX = W / 2, CY = 128;
  const svg = mk('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: '100%' });
  const arc = (from, to, color, w, op = 1) => {
    const pt = (a) => [CX + R * Math.cos(Math.PI - a * Math.PI), CY - R * Math.sin(Math.PI - a * Math.PI)];
    const [x1, y1] = pt(from), [x2, y2] = pt(to);
    return mk('path', {
      d: `M${x1.toFixed(1)} ${y1.toFixed(1)} A${R} ${R} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`,
      fill: 'none', stroke: color, 'stroke-width': w, 'stroke-linecap': 'round', opacity: op,
    });
  };
  const SEGS = [[0, .25, '#3d8bff'], [.25, .5, '#3fc7d4'], [.5, .75, '#ffb020'], [.75, 1, '#ff6a3d']];
  SEGS.forEach(([a, b, c]) => svg.appendChild(arc(a, b, c, 13, .22)));
  const p = (value + 2) / 4;
  svg.appendChild(arc(0, Math.max(0.001, p), TEMPCOLOR(value), 13, 1));

  // 指针
  const ang = Math.PI - p * Math.PI;
  const px = CX + (R - 2) * Math.cos(ang), py = CY - (R - 2) * Math.sin(ang);
  svg.appendChild(mk('circle', { cx: px, cy: py, r: '7', fill: '#fff' }));
  svg.appendChild(mk('circle', { cx: CX, cy: CY, r: '5', fill: '#1b1e28', stroke: 'rgba(255,255,255,.25)' }));

  const t = mk('text', { x: CX, y: CY - 34, 'text-anchor': 'middle', fill: '#fff', 'font-size': '22', 'font-weight': '700' });
  t.textContent = label;
  svg.appendChild(t);
  box.appendChild(svg);
}

export function TEMPCOLOR(v) {
  const n = Number(v);
  if (n <= -1.5) return '#3d8bff';
  if (n < -0.5) return '#3fc7d4';
  if (n < 0.5) return '#8a93a8';
  if (n < 1.5) return '#ffb020';
  return '#ff6a3d';
}
