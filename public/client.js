// public/client.js — 零资源 SPA：Canvas2D + WS + REST
// 设计：登录 → 建世界/加入房间 → Canvas 渲染
// 铁律：延迟 = 惯性（服务器按到达顺序 FIFO 处理意图，客户端不模拟、不补偿延迟）

const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');

const state = {
  token: null,
  user: null,
  world: null,        // 当前 snap
  ws: null,
  roomCode: null,
  worldId: null,
  // 输入
  keys: new Set(),
  attackPressed: false,
  mouse: { sx: 0, sy: 0, wx: 0, wy: 0, has: false, down: false },
  moveTarget: null,   // 右键点选移动目标 {x,y}
  zoom: 1,            // 游戏内缩放（滚轮控制，锚定玩家）
  showDebug: false,   // 按 `0` 显示诊断读数（画布/相机/缩放实际数值，排障用）
  spectateIdx: 0,     // 观战模式：按 C 循环切视角
  fx: [],             // 轻量战场特效（ring/float）
  _prevHp: null,      // 上一帧血量（用于伤害飘字）
  _prevRegion: null,  // 上一帧区域归属（用于"易手闪烁"）
  _flashRegion: [],   // 区域易手闪烁队列 {x,y,color,age}
  showKeys: false,    // 按键绑定面板
  // 资源计数
  events: [],
  chat: [],
  seenBriefing: false, // 是否已看过 rts 任务简报
  seenGoBriefing: false, // 是否已看过 go 模式简报（FIX-1）
  _briefedFor: false,  // FIX-1：首个 snap 到达后是否已按模式分流弹过简报（只弹一次）
  mode: 'rts',         // 当前模式：'rts' | 'go'（go=回合制 · 演化棋）
  goEvent: 'calm',     // go 模式最近一次世界事件
  _goResultShown: false, // 终局面板是否已弹（防重复）
  _goReject: null,     // FIX-3(b)：非法落子留痕 {lx,ly,born}
  _goRejectToastAt: 0, // 非法落子 toast 节流（避免连点刷屏）
  _goPassArmed: false, // FIX-8：P 停一手的二次确认武装状态
  _goPassTimer: null,  // FIX-8：二次确认窗口定时器
  // 回合制「一回合多颗」：本回合已预选（尚未提交）的落子 [{lx,ly}, ...]
  goPending: [],
  _goPendingKey: null, // 预选所属回合标识（moveNo:turn），换回合时清空，避免把上一回合预选带过来
  // go 模式「虚拟演化预览」：假设其他玩家全部停手，推演我方结束回合后 N 回合的棋子蔓延。
  // 与真实棋子用不同颜色（青色虚拟格）区分；仅作提示——若他人落子，实际演化会不同。
  virtualPreview: true,   // 默认开启
  virtualRounds: 1,       // 默认推演 1 回合（上限 8）
};

// ============== API ==============
// Send the token over multiple channels. Some deploy reverse-proxies strip or
// rewrite the Authorization header, so we also pass it as x-auth-token and as a
// ?token= query param (query is never mangled by header-rewriting proxies).
async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  let url = path;
  if (state.token) {
    headers['Authorization'] = 'Bearer ' + state.token;
    headers['x-auth-token'] = state.token;
    const sep = url.includes('?') ? '&' : '?';
    url = url + sep + 'token=' + encodeURIComponent(state.token);
  }
  const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  // 401：令牌失效（最常见于重新发布后沙箱重建，旧的 localStorage 令牌作废）→ 清掉并强制回到登录。
  // 仅对业务接口这样做；登录/注册本身走 /api/auth/，不在此列（其 401 是"密码错"，应原样提示）。
  if (r.status === 401 && path.indexOf('/api/auth/') === -1) {
    state.token = null; state.user = null;
    try { localStorage.removeItem('algowild_token'); localStorage.removeItem('algowild_user'); } catch {}
    try { onLogout(); } catch {}
    const j = await r.json().catch(() => null);
    throw new Error((j && j.message) || '登录已失效，请重新登录');
  }
  const ct = r.headers.get('content-type') || '';
  if (ct.indexOf('application/json') === -1) {
    const head = (await r.text()).slice(0, 80);
    throw new Error('服务端返回非 JSON（HTTP ' + r.status + '）：' + head);
  }
  const j = await r.json();
  if (j && j.code !== 0) throw new Error(j.message || 'api_error');
  return j.data;
}

// ============== UI ==============
const $ = (id) => document.getElementById(id);
function toast(msg, ms = 1800) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(t._tid); t._tid = setTimeout(() => t.classList.remove('show'), ms);
}
function modal(title, body) {
  return new Promise((res) => {
    $('modal-title').textContent = title;
    $('modal-body').innerHTML = body;
    $('modal').style.display = 'flex';
    const ok = $('modal-ok');
    const close = () => {
      $('modal').style.display = 'none';
      ok.removeEventListener('click', close);
      $('modal').removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      res();
    };
    // 点背景遮罩或按 Esc 也能关（简报内容较长时确定按钮可能被挤出视口）
    const onBackdrop = (e) => { if (e.target === $('modal')) close(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    ok.addEventListener('click', close);
    $('modal').addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
  });
}

// First-time (and every-time the user wants) mission briefing. Shown after
// login so a new player knows what to do, what to press, and what makes this
// game different from MC/Civ.
async function showBriefing(force) {
  if (state.seenBriefing && !force) return;
  await modal('任务简报 · 涌现之地', `
    <div style="font-size:13px;line-height:1.6">
      <div style="color:#ffd479;margin-bottom:6px">🧬 你要在这一局里，从一颗细胞长成霸主</div>
      你从<b>一颗细胞</b>开始，靠 <kbd>WASD</kbd> 游动，走过的地方会留下细胞痕迹。细胞会自己生长：
      <b>单独 1 颗、或只挨着 1 颗的细胞会消失</b>；<b>≥3 颗连成一片（直线三连 / L 形）或 2×2 方块</b>才稳。
      你和 3 个 AI 从地图四角同时发育，最终争夺地盘。
      <div style="color:#ffd479;margin:10px 0 6px">🗺 怎么变强、怎么赢</div>
      · 约 30 秒后自动解锁 <kbd>F</kbd> 落子（在脚下种 <b>1 颗强细胞</b>），从此能主动圈地<br>
      · 随时间长，你会更快、种子回得更快，最终开放<b>领土胜利：占满 16 个区域即获胜</b><br>
      · 另有其他胜利路线（凑齐资源、经济领先、或把对手全部打光）<br>
      <div style="color:#ffd479;margin:10px 0 6px">🎮 操作</div>
      <kbd>WASD</kbd>/方向键 移动 · <kbd>Shift</kbd>+方向 <b>冲刺</b>（3s 充能）<br>
      <kbd>F</kbd> 落子（脚下种 1 颗强细胞，要成片/成块才稳）· <kbd>Q</kbd> 演化预览<br>
      <b>自动战斗</b>：靠近敌人或对手自动开火；踩到资源自动收集；对手血量打空即出局。<br>
      <kbd>鼠标左/右键</kbd> 点地图移动 · <kbd>Enter</kbd> 聊天 · <kbd>?</kbd> 看详细面板
    </div>
  `);
  state.seenBriefing = true;
}

let authMode = 'login';
function setAuthMode(m) {
  authMode = m;
  $('tab-login').classList.toggle('active', m === 'login');
  $('tab-reg').classList.toggle('active', m === 'reg');
}
$('tab-login').onclick = () => setAuthMode('login');
$('tab-reg').onclick = () => setAuthMode('reg');

$('auth-go').onclick = async () => {
  const u = $('auth-u').value.trim(); const p = $('auth-p').value;
  if (!u || !p) { $('auth-msg').textContent = '请填完整'; $('auth-msg').className = 'err'; return; }
  try {
    const data = await api('POST', `/api/auth/${authMode === 'login' ? 'login' : 'register'}`, { username: u, password: p });
    state.token = data.token; state.user = data.user;
    localStorage.setItem('algowild_token', state.token);
    localStorage.setItem('algowild_user', JSON.stringify(state.user));
    onLogin();
  } catch (e) {
    const msg = e.message === 'account_banned' ? '账号已被封禁，请联系管理员' : e.message;
    $('auth-msg').textContent = msg; $('auth-msg').className = 'err';
  }
};

// ============== 房间大厅（建房 → 建世界 → 开始；公开/私密 + 密码 + 搜索/列表） ==============
// 模型：房间是玩家的集合点。**先建房，后建世界**；不要求等玩家到齐；
// 玩家可中途加入；掉线由电脑接手；房主可暂停；任意玩家可存档；席位 1..8（电脑也占席位）。

function roomOpts() {
  const mp = parseInt(($('room-max') && $('room-max').value) || '4', 10);
  const mode = ($('world-mode') && $('world-mode').value) === 'go' ? 'go' : 'rts';
  return {
    name: ($('room-name') && $('room-name').value.trim()) || undefined,
    maxPlayers: Number.isFinite(mp) ? Math.max(1, Math.min(8, mp)) : 4,
    visibility: ($('room-vis') && $('room-vis').value) === 'private' ? 'private' : 'public',
    password: ($('room-pass') && $('room-pass').value) || undefined,
    mode,
    // 玩法设置（服务端会再钳制）：每回合落子数 1..16（默认 3）、死亡宽限回合 0..10（默认 0）
    stonesPerTurn: clampInt($('room-stones') && $('room-stones').value, 1, 16, 3),
    lonelyDeathDelay: clampInt($('room-delay') && $('room-delay').value, 0, 10, 0),
    // 胜利条件（房主勾选；服务端按模式再 gate）
    victoryLines: collectVictoryLines('victory-lines-build-list', mode),
    // 棋盘形状（可编辑棋盘）：null = 默认矩形；否则为序列化三态位图字符串
    // ⚠️ 必须传编辑器实例（boardBuildEditor），传元素 id 会永远得到 null。
    board: collectBoard(boardBuildEditor),
    // 回合制限制（手数上限 / 每手时限 / 超时判负次数；服务端按模式再 gate 并钳制）
    goLimits: collectGoLimits(),
  };
}
// 回合制限制：从建房弹窗读取（秒 → 毫秒）；非回合制模式返回 undefined（不落库，走服务端默认）。
function collectGoLimits() {
  const mode = ($('world-mode') && $('world-mode').value) === 'go' ? 'go' : 'rts';
  if (mode !== 'go') return undefined;
  return {
    maxMoves: clampInt($('golimits-moves') && $('golimits-moves').value, 20, 600, 150),
    turnMs: clampInt($('golimits-turn') && $('golimits-turn').value, 5, 300, 30) * 1000,
    maxTimeouts: clampInt($('golimits-timeouts') && $('golimits-timeouts').value, 1, 20, 3),
  };
}
// 回合制限制的中文摘要（用于只读展示）。
function goLimitsText(gl) {
  const n = normGoLimitsClient(gl);
  return `${n.maxMoves} 手 · 每手 ${Math.round(n.turnMs / 1000)} 秒 · 超时 ${n.maxTimeouts} 次判负`;
}
// 客户端侧归一（与服务端 World.normGoLimits 同规则；仅供展示，权威在服务端）。
function normGoLimitsClient(v) {
  const spec = {
    maxMoves: { dflt: 150, lo: 20, hi: 600 },
    turnMs: { dflt: 30000, lo: 5000, hi: 300000 },
    maxTimeouts: { dflt: 3, lo: 1, hi: 20 },
  };
  const o = (v && typeof v === 'object') ? v : {};
  const out = {};
  for (const [k, s] of Object.entries(spec)) out[k] = clampInt(o[k], s.lo, s.hi, s.dflt);
  return out;
}
// 整数钳制：非数字/空 → 默认；越界 → 钳到边界。
function clampInt(v, min, max, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

// ============== 可编辑棋盘（形状 + 虚空格）—— 前端画布编辑器 ==============
// 契约与后端 engine.js 完全一致：
//   三态：0=形状外/墙（SHAPE_OUT）· 1=可落子（SHAPE_PLAY）· 2=虚空/墙（SHAPE_VOID）
//   位图索引：行优先 bmp[ly*w + lx]
//   序列化：行优先，'.'=形状外 '#'=可落子 'x'=虚空，行间用 '/' 分隔（紧凑串）
//   null = 默认矩形（实时 rts：32×32 生命格遮罩 / 回合制 go：32×32 棋盘），服务端把 null 归一为默认矩形。
const BOARD_MAX = 100;         // 位图边长上限（含）
const BOARD_MIN = 1;           // 位图边长下限（含）
const BOARD_OUT = 0, BOARD_PLAY = 1, BOARD_VOID = 2;
const BOARD_CHAR = { 0: '.', 1: '#', 2: 'x' };
const BOARD_CHAR_INV = { '.': 0, '#': 1, 'x': 2 };
// UI 配色：形状外用深灰（墙体到底）· 虚空用红（可辨认的"洞"）· 可落子用绿
const BOARD_COLOR = {
  0: '#21262d',   // 形状外（墙）
  1: '#2ea043',   // 可落子
  2: '#f85149',   // 虚空（墙）
};

// 尺寸上限：rts 生命层恒 32（棋盘只做遮罩）；go 棋盘即棋盘 → 100。
function boardMaxForMode(mode) {
  // go：棋盘即棋盘（生命层随棋盘尺寸）→ 上限 100，与后端 World.BOARD_MAX 一致。
  // rts：生命层恒 32×32（1 生命格 = 6×6 世界格），棋盘只做遮罩 → 上限 32。
  return (mode === 'rts') ? 32 : 100;
}

// 位图 → 紧凑序列化串（行优先，'/' 分行）。
function encodeBoardClient(w, h, shape) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    let row = '';
    for (let x = 0; x < w; x++) row += (BOARD_CHAR[shape[y * w + x]] || '.');
    rows.push(row);
  }
  return rows.join('/');
}

// 紧凑序列化串 → 位图（容错：非法字符按形状外处理；缺行/缺列补形状外）。
// 返回 { w, h, shape } 或 null（无法解析）。
function decodeBoardClient(str) {
  if (typeof str !== 'string' || !str) return null;
  const rows = str.split('/');
  const h = rows.length;
  let w = 0;
  for (const r of rows) if (r.length > w) w = r.length;
  if (w < 1 || h < 1) return null;
  const shape = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const r = rows[y] || '';
    for (let x = 0; x < w; x++) {
      shape[y * w + x] = (BOARD_CHAR_INV[r[x]] !== undefined) ? BOARD_CHAR_INV[r[x]] : BOARD_OUT;
    }
  }
  return { w, h, shape };
}

// 归一棋盘：把服务端返回的 board（可能是对象 {w,h,shape} 或字符串或 null）转成
// 客户端内部 { w, h, shape(Uint8Array) }；null/非法 → 返回 null（= 默认矩形）。
function normBoardClient(raw) {
  if (!raw) return null;
  let w = 0, h = 0, shape = null;
  if (typeof raw === 'string') {
    const d = decodeBoardClient(raw);
    if (!d) return null;
    w = d.w; h = d.h; shape = d.shape;
  } else if (typeof raw === 'object') {
    w = clampInt(raw.w, 1, BOARD_MAX, 0);
    h = clampInt(raw.h, 1, BOARD_MAX, 0);
    if (!w || !h) return null;
    if (Array.isArray(raw.shape)) {
      shape = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) {
        const v = raw.shape[i];
        shape[i] = (v === 0 || v === 1 || v === 2) ? v : 0;
      }
    } else if (typeof raw.shape === 'string') {
      const d = decodeBoardClient(raw.shape);
      if (d && d.w === w && d.h === h) shape = d.shape;
    }
    if (!shape) return null;
  } else {
    return null;
  }
  // 全形状外 = 无意义（等价于空棋盘），归一为 null（服务端也拒绝）
  let any = false;
  for (let i = 0; i < shape.length; i++) if (shape[i] === BOARD_PLAY || shape[i] === BOARD_VOID) { any = true; break; }
  if (!any) return null;
  return { w, h, shape };
}

// 默认矩形位图（全可落子）。
function makeRectBoard(w, h) {
  const shape = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) shape[i] = BOARD_PLAY;
  return { w, h, shape };
}

// 形状转置/旋转 90°（顺时针）。
function rotateBoard90(b) {
  const { w, h, shape } = b;
  const nw = h, nh = w;
  const ns = new Uint8Array(nw * nh);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = h - 1 - y, ny = x;
      ns[ny * nw + nx] = shape[y * w + x];
    }
  }
  return { w: nw, h: nh, shape: ns };
}

// 6 个内置预设模板（与后端 BOARD_PRESETS 同名同形）。tpl=模板键，w/h=目标尺寸。
// 说明：前端只做"示意 + 初始值"，可落子区域按模板在 w×h 上等比生成；
// 真正权威的形状仍由服务端引擎计算/校验。
function boardPresetClient(tpl, w, h) {
  const out = new Uint8Array(w * h);
  const set = (x, y, v) => { if (x >= 0 && x < w && y >= 0 && y < h) out[y * w + x] = v; };
  for (let i = 0; i < w * h; i++) out[i] = BOARD_OUT;
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  if (tpl === 'rect') {
    for (let i = 0; i < w * h; i++) out[i] = BOARD_PLAY;
  } else if (tpl === 'cross') {
    const tw = Math.max(1, Math.round(w / 3)), th = Math.max(1, Math.round(h / 3));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (Math.abs(x - cx) <= tw / 2 || Math.abs(y - cy) <= th / 2) set(x, y, BOARD_PLAY);
    }
  } else if (tpl === 'castle') {
    const inset = Math.max(1, Math.round(Math.min(w, h) * 0.12));
    for (let y = inset; y < h - inset; y++) for (let x = inset; x < w - inset; x++) set(x, y, BOARD_PLAY);
    // 四角挖空（城垛感）
    const c = Math.max(1, Math.round(Math.min(w, h) * 0.15));
    for (let y = inset; y < inset + c; y++) for (let x = inset; x < inset + c; x++) { set(x, y, BOARD_OUT); set(w - 1 - x, y, BOARD_OUT); set(x, h - 1 - y, BOARD_OUT); set(w - 1 - x, h - 1 - y, BOARD_OUT); }
  } else if (tpl === 'twins') {
    const gap = Math.max(1, Math.round(w * 0.08));
    const half = Math.max(1, Math.floor((w - gap) / 2));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (x < half || x >= w - half) set(x, y, BOARD_PLAY);
    }
  } else if (tpl === 'ring') {
    const R = Math.min(w, h) / 2 - 0.5;
    const inner = R * 0.55;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= R && d >= inner) set(x, y, BOARD_PLAY);
    }
  } else if (tpl === 'islands') {
    // 确定性伪随机：mulberry32（与后端同算法，同 seed 同形；禁止 Math.random）
    const rng = mulberry32Client(0x9e3779b9);
    const n = Math.max(3, Math.round((w * h) / 260));
    for (let k = 0; k < n; k++) {
      const ix = Math.floor(rng() * w), iy = Math.floor(rng() * h);
      const rr = 1 + Math.floor(rng() * 2);
      for (let y = iy - rr; y <= iy + rr; y++) for (let x = ix - rr; x <= ix + rr; x++) {
        if (Math.hypot(x - ix, y - iy) <= rr) set(x, y, BOARD_PLAY);
      }
    }
  } else {
    for (let i = 0; i < w * h; i++) out[i] = BOARD_PLAY;
  }
  let any = false;
  for (let i = 0; i < w * h; i++) if (out[i] === BOARD_PLAY) { any = true; break; }
  if (!any) return makeRectBoard(w, h);
  return { w, h, shape: out };
}

// mulberry32：确定性伪随机（前端版，仅用于预设示意，禁止 Math.random）
function mulberry32Client(a) {
  a = a >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 预设显示名（与后端一致）
const BOARD_PRESET_LABELS = {
  rect: '矩形', cross: '十字', castle: '城堡', twins: '双子', ring: '环形', islands: '群岛',
};
const BOARD_PRESET_KEYS = ['rect', 'cross', 'castle', 'twins', 'ring', 'islands'];

// 棋盘编辑器组件：绑定到一个 canvas，负责绘制 + 交互（画/挖/擦/填/旋转/重置）。
// 用法：const ed = new BoardEditor(canvasEl, mode); ed.getBoard() → 归一棋盘或 null。
class BoardEditor {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {('rts'|'go')} mode
   * @param {{onChange?:Function}} [opts]
   */
  constructor(canvas, mode, opts) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.mode = mode === 'go' ? 'go' : 'rts';
    this.max = boardMaxForMode(this.mode);
    this.onChange = (opts && opts.onChange) || null;
    // 默认尺寸：rts / go 都是 32（rts 生命层上限即 32；go 可再调到 100）。
    const defN = this.mode === 'rts' ? 32 : 32;
    this.board = null;              // null = 默认矩形
    this.w = defN;
    this.h = defN;
    this.shape = null;              // Uint8Array，null 时惰性生成矩形
    this.tool = 'brush';            // brush | void | erase | fill
    this.dragging = false;
    this._bind();
    this._ensureShape();
    this._render();
  }
  // 惰性生成矩形形状。
  _ensureShape() {
    if (this.shape && this.shape.length === this.w * this.h) return;
    if (this.board) { this.shape = this.board.shape.slice(); }
    else { this.shape = new Uint8Array(this.w * this.h).fill(BOARD_PLAY); }
  }
  _bind() {
    const pos = (e) => {
      const r = this.cv.getBoundingClientRect();
      const px = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
      const py = (e.touches ? e.touches[0].clientY : e.clientY) - r.top;
      const x = Math.max(0, Math.min(this.w - 1, Math.floor(px / r.width * this.w)));
      const y = Math.max(0, Math.min(this.h - 1, Math.floor(py / r.height * this.h)));
      return { x, y };
    };
    const paintAt = (x, y) => {
      const v = this.tool === 'void' ? BOARD_VOID : (this.tool === 'erase' ? BOARD_OUT : BOARD_PLAY);
      if (this.shape[y * this.w + x] !== v) { this.shape[y * this.w + x] = v; this._dirty = true; }
    };
    const onDown = (e) => {
      e.preventDefault();
      const { x, y } = pos(e);
      if (this.tool === 'fill') {
        const v = (this.shape[y * this.w + x] === BOARD_PLAY) ? BOARD_PLAY : BOARD_PLAY;
        this._floodFill(x, y, v);
      } else { this.dragging = true; paintAt(x, y); }
      this._render();
      if (this.onChange) this.onChange(this);
    };
    const onMove = (e) => {
      if (!this.dragging) return;
      e.preventDefault();
      const { x, y } = pos(e);
      paintAt(x, y);
      this._render();
    };
    const onUp = () => {
      if (this.dragging && this.onChange) this.onChange(this);
      this.dragging = false;
    };
    this.cv.addEventListener('mousedown', onDown);
    this.cv.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    this.cv.addEventListener('touchstart', onDown, { passive: false });
    this.cv.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onUp);
  }
  // 4-邻域洪水填充：把与 (x,y) 同态的连通区域刷成 target。
  _floodFill(x, y, target) {
    const src = this.shape[y * this.w + x];
    if (src === target) return;
    const stack = [[x, y]];
    const seen = new Uint8Array(this.w * this.h);
    while (stack.length) {
      const [cx, cy] = stack.pop();
      const i = cy * this.w + cx;
      if (seen[i]) continue;
      if (this.shape[i] !== src) continue;
      seen[i] = 1;
      this.shape[i] = target;
      if (cx > 0) stack.push([cx - 1, cy]);
      if (cx < this.w - 1) stack.push([cx + 1, cy]);
      if (cy > 0) stack.push([cx, cy - 1]);
      if (cy < this.h - 1) stack.push([cx, cy + 1]);
    }
  }
  // 设置尺寸（重建/裁剪；越界像素默认形状外）。
  setSize(w, h) {
    w = clampInt(w, BOARD_MIN, this.max, this.w);
    h = clampInt(h, BOARD_MIN, this.max, this.h);
    const ns = new Uint8Array(w * h);
    for (let i = 0; i < ns.length; i++) ns[i] = BOARD_OUT;
    const ow = this.w, oh = this.h;
    for (let y = 0; y < Math.min(oh, h); y++) for (let x = 0; x < Math.min(ow, w); x++) {
      ns[y * w + x] = this.shape[y * ow + x];
    }
    this.w = w; this.h = h; this.shape = ns; this.board = null;
    this._render();
    if (this.onChange) this.onChange(this);
  }
  setTool(t) { this.tool = t; this._render(); }
  // 应用预设（在当前尺寸上）。
  setPreset(tpl) {
    const b = boardPresetClient(tpl, this.w, this.h);
    this.shape = b.shape; this.board = null;
    this._render();
    if (this.onChange) this.onChange(this);
  }
  rotate() {
    const b = rotateBoard90({ w: this.w, h: this.h, shape: this.shape });
    if (b.w > this.max || b.h > this.max) return false;   // 旋转后越界 → 拒绝
    this.w = b.w; this.h = b.h; this.shape = b.shape; this.board = null;
    this._render();
    if (this.onChange) this.onChange(this);
    return true;
  }
  // 重置为默认矩形（返回 null board = 默认）。
  reset() {
    this.board = null;
    this.shape = new Uint8Array(this.w * this.h).fill(BOARD_PLAY);
    this._render();
    if (this.onChange) this.onChange(this);
  }
  // 载入一个已归一棋盘（用于房内编辑已有形状）。
  load(raw, mode) {
    if (mode) { this.mode = mode === 'go' ? 'go' : 'rts'; this.max = boardMaxForMode(this.mode); }
    const b = normBoardClient(raw);
    if (!b) { this.board = null; this.shape = new Uint8Array(this.w * this.h).fill(BOARD_PLAY); }
    else { this.board = b; this.w = b.w; this.h = b.h; this.shape = b.shape.slice(); }
    this._render();
  }
  // 导出：若与"默认矩形"完全一致 → 返回 null（保持默认语义）；否则返回紧凑串。
  getBoard() {
    const isDefaultRect = this._isDefaultRect();
    if (isDefaultRect) return null;
    return encodeBoardClient(this.w, this.h, this.shape);
  }
  // 当前是否等于默认矩形（全可落子）。注意：这里默认矩形指"当前 w×h 全可落子"，
  // 但因为 null 语义是模式默认尺寸，只有当 w/h 等于模式默认尺寸时才等价 null。
  _isDefaultRect() {
    const defN = 32; // 前端 null 的示意默认边长（两种模式默认棋盘都是 32）
    if (this.w !== defN || this.h !== defN) return false;
    for (let i = 0; i < this.shape.length; i++) if (this.shape[i] !== BOARD_PLAY) return false;
    return true;
  }
  // 尺寸描述（用于 UI 文案）。
  infoText() {
    let play = 0, voidN = 0, out = 0;
    for (let i = 0; i < this.shape.length; i++) {
      const v = this.shape[i];
      if (v === BOARD_PLAY) play++; else if (v === BOARD_VOID) voidN++; else out++;
    }
    const isDef = this._isDefaultRect();
    const name = isDef ? '矩形（默认）' : `${this.w}×${this.h}`;
    return `形状：${name} · 可落子 ${play} · 虚空 ${voidN} · 形状外 ${out}`;
  }
  _render() {
    const { ctx, cv, w, h, shape } = this;
    const cw = w, ch = h;
    cv.width = cw; cv.height = ch;
    ctx.clearRect(0, 0, cw, ch);
    const cellPx = 1; // 1 逻辑像素/格（CSS 放大）
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const v = shape[y * w + x];
        ctx.fillStyle = BOARD_COLOR[v] || BOARD_COLOR[0];
        ctx.fillRect(x * cellPx, y * cellPx, cellPx, cellPx);
      }
    }
  }
}

// 从编辑器读 board（编辑器实例存在则返回紧凑串，否则 null）。
function collectBoard(editorVar) {
  return (editorVar && editorVar.getBoard) ? editorVar.getBoard() : null;
}

// 只读缩略图绘制（房内展示当前棋盘形状；从 board 归一对象或紧凑串绘制）。
function drawBoardThumb(canvas, rawBoard, mode) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const b = normBoardClient(rawBoard);
  const defN = (mode === 'go') ? 32 : 32;
  const w = b ? b.w : defN, h = b ? b.h : defN;
  canvas.width = w; canvas.height = h;
  ctx.clearRect(0, 0, w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = b ? b.shape[y * w + x] : BOARD_PLAY;
      ctx.fillStyle = BOARD_COLOR[v] || BOARD_COLOR[0];
      ctx.fillRect(x, y, 1, 1);
    }
  }
}

// 棋盘形状文本（HUD / 房间展示）。
function boardInfoText(rawBoard, mode) {
  const b = normBoardClient(rawBoard);
  if (!b) return (mode === 'go' ? '回合制' : '实时') + ' 默认矩形';
  let play = 0, voidN = 0;
  for (let i = 0; i < b.shape.length; i++) {
    if (b.shape[i] === BOARD_PLAY) play++; else if (b.shape[i] === BOARD_VOID) voidN++;
  }
  return `${b.w}×${b.h} · 可落子 ${play}` + (voidN ? ` · 虚空 ${voidN}` : '');
}

// ============== 胜利条件组件（建房弹窗 + 房内面板共用同一渲染/收集逻辑） ==============
// 各模式可用的胜利线（与后端 World.VICTORY_AVAILABLE 契约一致）。
const VICTORY_LINE_KEYS = ['territory', 'economy', 'singularity', 'survival'];
const VICTORY_AVAILABLE = {
  rts: ['territory', 'economy', 'singularity', 'survival'],
  go: ['territory'],
};
const VICTORY_LINE_DEFAULT = { territory: true, economy: false, singularity: false, survival: false };
const VICTORY_LABEL = {
  territory: { rts: '领土', go: '领土', descRts: '占满地图 16 区且进入帝国时代 → 胜', descGo: '双方停手后数子（子数 + 归属空点），多者胜' },
  economy: { rts: '经济', descRts: '领先 600 分并保持 90 秒 → 胜', descGo: '' },
  singularity: { rts: '采集', descRts: '六种资源各存满 30 → 胜', descGo: '' },
  survival: { rts: '灭族', descRts: '对手全部出局 → 胜', descGo: '' },
};
function availableVictoryLines(mode) { return VICTORY_AVAILABLE[mode] || VICTORY_AVAILABLE.rts; }
// 读取某模式下"胜利条件"勾选区当前状态（容器 id + 模式）。
function collectVictoryLines(containerId, mode) {
  const box = $(containerId);
  const out = { ...VICTORY_LINE_DEFAULT };
  if (!box) return normVictoryLinesClient(out, mode);
  for (const k of VICTORY_LINE_KEYS) {
    const el = box.querySelector('input[data-line="' + k + '"]');
    if (el) out[k] = !!el.checked;
  }
  return normVictoryLinesClient(out, mode);
}
// 客户端归一（与后端 normVictoryLines 同契约）：go 下强制只留 territory。
function normVictoryLinesClient(v, mode) {
  const out = { ...VICTORY_LINE_DEFAULT };
  if (v && typeof v === 'object') {
    for (const k of VICTORY_LINE_KEYS) if (typeof v[k] === 'boolean') out[k] = v[k];
  }
  const allow = availableVictoryLines(mode);
  for (const k of VICTORY_LINE_KEYS) if (!allow.includes(k)) out[k] = false;
  return out;
}
/**
 * 渲染"胜利条件"开关片段（建房弹窗 + 房内编辑弹窗共用）。
 * @param {string} containerId 容器元素 id
 * @param {('rts'|'go')} mode
 * @param {object} value 当前勾选值
 * @param {boolean} editable 是否可编辑（房内非房主 = 只读展示）
 */
function renderVictoryLines(containerId, mode, value, editable) {
  const box = $(containerId);
  if (!box) return;
  const v = normVictoryLinesClient(value, mode);
  const allow = availableVictoryLines(mode);
  box.innerHTML = allow.map(k => {
    const lab = VICTORY_LABEL[k] || { rts: k };
    const desc = mode === 'go' ? (lab.descGo || lab.descRts || '') : (lab.descRts || '');
    const cb = `<input type="checkbox" data-line="${k}" ${v[k] ? 'checked' : ''} ${editable ? '' : 'disabled'}>`;
    return `<label style="display:flex;gap:6px;align-items:center;padding:2px 0;cursor:${editable ? 'pointer' : 'default'}">`
      + cb + `<span>${escapeHtml(lab.rts)}</span>`
      + `<span style="color:#6e7681;font-size:11px">${escapeHtml(desc)}</span></label>`;
  }).join('');
  // 关闭的线（如切到 go 后 economy）→ 给一行灰字提示
  const dropped = VICTORY_LINE_KEYS.filter(k => allow.indexOf(k) === -1);
  if (dropped.length && mode === 'go') {
    box.innerHTML += `<div style="color:#6e7681;font-size:11px;margin-top:4px">回合制不支持「${dropped.map(k => VICTORY_LABEL[k].rts).join('、')}」，已取消勾选</div>`;
  }
}
// 胜利条件文本（HUD / 房间展示）：把 victoryLines 转成人类可读串。
function victoryLinesText(lines, mode) {
  const v = normVictoryLinesClient(lines || VICTORY_LINE_DEFAULT, mode);
  const names = availableVictoryLines(mode).filter(k => v[k]).map(k => VICTORY_LABEL[k].rts);
  if (!names.length) return '无（本局仅计时/手动结束）';
  return names.join(' · ');
}
// 模式切换时：重渲建房弹窗的胜利条件区（静默丢弃新模式不支持的项）
function onModeChange() {
  const mode = ($('world-mode') && $('world-mode').value) === 'go' ? 'go' : 'rts';
  const cur = collectVictoryLines('victory-lines-build-list', mode === 'go' ? 'rts' : 'go'); // 保留旧模式下的选择
  renderVictoryLines('victory-lines-build-list', mode, cur, true);
  // 棋盘尺寸上限随模式变化（rts 32 / go 100）→ 重建编辑器
  buildBoardEditor(mode);
  // 回合制限制区仅 go 模式显示
  const glBox = $('golimits-build-adv');
  if (glBox) glBox.style.display = (mode === 'go') ? '' : 'none';
}
if ($('room-vis')) $('room-vis').onchange = () => {
  const priv = $('room-vis').value === 'private';
  if ($('room-pass-row')) $('room-pass-row').style.display = priv ? 'flex' : 'none';
};
// 模式切换 → 重渲建房弹窗的胜利条件区（静默丢弃新模式不支持的项 + 灰字提示）
if ($('world-mode')) $('world-mode').onchange = () => onModeChange();
// 首次渲染建房弹窗的胜利条件区（默认仅勾「领土」）
if ($('victory-lines-build-list')) {
  renderVictoryLines('victory-lines-build-list', ($('world-mode') && $('world-mode').value) === 'go' ? 'go' : 'rts', VICTORY_LINE_DEFAULT, true);
}

// ============== 建房弹窗：棋盘形状编辑器（双入口之一） ==============
let boardBuildEditor = null;   // 建房弹窗的编辑器实例
// 刷新建房弹窗棋盘 UI 文案 + 预设按钮高亮。
function refreshBoardBuildInfo(tplKey) {
  if (!boardBuildEditor) return;
  if ($('board-build-info')) $('board-build-info').textContent = boardBuildEditor.infoText();
  const box = $('board-build-presets');
  if (box) {
    box.querySelectorAll('[data-tpl]').forEach(b => {
      const on = b.getAttribute('data-tpl') === tplKey;
      b.style.borderColor = on ? '#58a6ff' : '#30363d';
      b.style.color = on ? '#58a6ff' : '#c9d1d9';
    });
  }
  const curW = $('board-build-w'), curH = $('board-build-h');
  if (curW) { curW.value = boardBuildEditor.w; curW.max = boardBuildEditor.max; }
  if (curH) { curH.value = boardBuildEditor.h; curH.max = boardBuildEditor.max; }
}
// 重建（或首次创建）建房弹窗棋盘编辑器。
function buildBoardEditor(mode) {
  const canvas = $('board-build-canvas');
  if (!canvas) return;
  const m = mode === 'go' ? 'go' : 'rts';
  const prev = boardBuildEditor ? boardBuildEditor.getBoard() : null;
  boardBuildEditor = new BoardEditor(canvas, m, { onChange: () => refreshBoardBuildInfo() });
  if (prev) boardBuildEditor.load(prev, m);
  refreshBoardBuildInfo();
  // 预设按钮
  const box = $('board-build-presets');
  if (box && !box.dataset.bound) {
    box.dataset.bound = '1';
    box.innerHTML = BOARD_PRESET_KEYS.map(k =>
      `<button class="board-tool" data-tpl="${k}" style="flex:0 0 auto;padding:2px 8px">${BOARD_PRESET_LABELS[k]}</button>`
    ).join('');
    box.querySelectorAll('[data-tpl]').forEach(b => {
      b.onclick = () => { boardBuildEditor.setPreset(b.getAttribute('data-tpl')); refreshBoardBuildInfo(b.getAttribute('data-tpl')); };
    });
  }
  // 工具按钮（画/挖/擦/填）
  const toolBtns = [['board-build-brush', 'brush'], ['board-build-void', 'void'], ['board-build-erase', 'erase'], ['board-build-fill', 'fill']];
  toolBtns.forEach(([id, tool]) => {
    const b = $(id);
    if (b) b.onclick = () => {
      boardBuildEditor.setTool(tool);
      toolBtns.forEach(([bid]) => { const e = $(bid); if (e) { e.style.borderColor = '#30363d'; e.style.color = '#c9d1d9'; } });
      b.style.borderColor = '#58a6ff'; b.style.color = '#58a6ff';
    };
  });
  if ($('board-build-rotate')) $('board-build-rotate').onclick = () => { if (!boardBuildEditor.rotate()) toast('旋转后超出尺寸上限'); refreshBoardBuildInfo(); };
  if ($('board-build-reset')) $('board-build-reset').onclick = () => { boardBuildEditor.reset(); refreshBoardBuildInfo('rect'); };
  if ($('board-build-default')) $('board-build-default').onclick = () => {
    const m2 = m === 'rts' ? 32 : 32;
    boardBuildEditor.setSize(m2, m2); refreshBoardBuildInfo('rect');
  };
  if ($('board-build-w')) $('board-build-w').onchange = () => { boardBuildEditor.setSize(parseInt($('board-build-w').value, 10), boardBuildEditor.h); refreshBoardBuildInfo(); };
  if ($('board-build-h')) $('board-build-h').onchange = () => { boardBuildEditor.setSize(boardBuildEditor.w, parseInt($('board-build-h').value, 10)); refreshBoardBuildInfo(); };
  // 默认工具高亮
  if ($('board-build-brush')) { $('board-build-brush').style.borderColor = '#58a6ff'; $('board-build-brush').style.color = '#58a6ff'; }
}
if ($('board-build-canvas')) {
  buildBoardEditor(($('world-mode') && $('world-mode').value) === 'go' ? 'go' : 'rts');
}
// 回合制限制区：初始按当前模式显示/隐藏
if ($('golimits-build-adv')) {
  $('golimits-build-adv').style.display = (($('world-mode') && $('world-mode').value) === 'go') ? '' : 'none';
}

async function createRoomFlow() {
  const o = roomOpts();
  if (o.visibility === 'private' && !o.password) { toast('私密房间请先设置密码'); return; }
  try {
    const r = await api('POST', '/api/rooms', o);
    state.roomCode = r.code;
    state.mode = o.mode;
    $('room-msg').innerHTML = `<span class="ok">房间 ${r.code} 已创建（${r.maxPlayers} 席 · ${o.visibility === 'private' ? '私密' : '公开'}）</span>`;
    enterRoomPanel(r.room);
    refreshRoomList();
  } catch (e) { $('room-msg').innerHTML = `<span class="err">${escapeHtml(e.message)}</span>`; }
}

async function refreshRoomList() {
  const box = $('room-list');
  if (!box) return;
  try {
    const d = await api('GET', '/api/rooms');
    const rooms = d.rooms || [];
    if (!rooms.length) { box.innerHTML = '<span style="color:#6e7681">暂无公开房间 —— 点上面「建房」开一局</span>'; return; }
    box.innerHTML = rooms.map(r => `
      <div class="stat" style="cursor:pointer" data-code="${r.code}">
        <span>${escapeHtml(r.name || r.code)} · ${r.mode === 'go' ? '回合制' : '实时'}</span>
        <b>${r.seatCount}/${r.maxPlayers} · ${r.phase === 'lobby' ? '待建世界' : (r.started ? '进行中' : '已就绪')} ▸</b>
      </div>`).join('');
    box.querySelectorAll('[data-code]').forEach(el => {
      el.onclick = () => joinRoomByCode(el.getAttribute('data-code'));
    });
  } catch (e) { box.innerHTML = `<span class="err">${escapeHtml(e.message)}</span>`; }
}
if ($('room-list-refresh')) $('room-list-refresh').onclick = () => refreshRoomList();

if ($('room-search-btn')) $('room-search-btn').onclick = async () => {
  const code = (($('room-search') && $('room-search').value) || '').trim().toUpperCase();
  if (!code) { toast('请输入房间号'); return; }
  try {
    const info = await api('GET', `/api/rooms/search?code=${encodeURIComponent(code)}`);
    if (info.visibility === 'private') {
      const pw = window.prompt('私密房间 ' + info.code + ' 需要密码：') || '';
      if (!pw) return;
      await joinRoomByCode(info.code, pw);
    } else {
      await joinRoomByCode(info.code);
    }
  } catch (e) { $('room-msg').innerHTML = `<span class="err">${escapeHtml(e.message)}</span>`; }
};

if ($('create-room')) $('create-room').onclick = () => createRoomFlow();

// 单人开局：1 人 + 3 电脑（总席位 4）。先加入自己再补电脑，避免电脑把席位占满。
if ($('quick-room')) $('quick-room').onclick = async () => {
  const mode = ($('world-mode') && $('world-mode').value) === 'go' ? 'go' : 'rts';
  try {
    const r = await api('POST', '/api/rooms', {
      name: '快速开局', maxPlayers: 4, visibility: 'public', mode,
      stonesPerTurn: clampInt($('room-stones') && $('room-stones').value, 1, 16, 3),
      lonelyDeathDelay: clampInt($('room-delay') && $('room-delay').value, 0, 10, 0),
      victoryLines: collectVictoryLines('victory-lines-build-list', mode),
      board: collectBoard(boardBuildEditor),
      goLimits: collectGoLimits(),
    });
    state.roomCode = r.code;
    state.mode = mode;
    await api('POST', `/api/rooms/${r.code}/world`, { mode, board: collectBoard(boardBuildEditor) });
    const j = await api('POST', `/api/rooms/${r.code}/join`);       // 人类先入座
    state.worldId = j.worldId;
    state.mode = j.mode || mode;
    for (let i = 0; i < 3; i++) { try { await api('POST', `/api/rooms/${r.code}/ai`); } catch (e) { break; } }
    enterRoomPanel(j.room);
    joinWS();
  } catch (e) { toast('快速开局失败：' + e.message); }
};

// ---- 房间内（房主）控制 ----
if ($('lobby-build')) $('lobby-build').onclick = async () => {
  try {
    const mode = ($('world-mode') && $('world-mode').value) === 'go' ? 'go' : 'rts';
    const d = await api('POST', `/api/rooms/${state.roomCode}/world`, { mode });
    state.worldId = d.worldId; state.mode = d.mode;
    renderLobby(d.room); joinWS();
  } catch (e) { toast('建世界失败：' + e.message); }
};
if ($('lobby-start')) $('lobby-start').onclick = async () => {
  try { const d = await api('POST', `/api/rooms/${state.roomCode}/start`); renderLobby(d.room); toast('游戏已开始（可随时加入）'); }
  catch (e) { toast(e.message); }
};
if ($('lobby-add-ai')) $('lobby-add-ai').onclick = async () => {
  try { const d = await api('POST', `/api/rooms/${state.roomCode}/ai`); renderLobby(d.room); }
  catch (e) { toast('加电脑失败：' + e.message); }
};
if ($('lobby-remove-ai')) $('lobby-remove-ai').onclick = async () => {
  try {
    const info = state._roomInfo || await api('GET', `/api/rooms/${state.roomCode}`);
    const ai = (info.players || []).filter(p => p.isAI).pop();
    if (!ai) { toast('没有可移除的电脑玩家'); return; }
    const d = await api('DELETE', `/api/rooms/${state.roomCode}/ai/${encodeURIComponent(ai.id)}`);
    renderLobby(d.room);
  } catch (e) { toast('移除失败：' + e.message); }
};
if ($('lobby-pause')) $('lobby-pause').onclick = async () => {
  try {
    const cur = !!(state._roomInfo && state._roomInfo.paused);
    const d = await api('POST', `/api/rooms/${state.roomCode}/pause`, { paused: !cur });
    state._roomInfo = d.room;
    toast(d.paused ? '⏸ 已暂停（房主可恢复）' : '▶ 已恢复');
    renderLobby(d.room);
  } catch (e) { toast('暂停失败：' + e.message); }
};
if ($('lobby-save')) $('lobby-save').onclick = async () => {
  try { await api('POST', `/api/rooms/${state.roomCode}/save`); toast('✅ 已存档（任何玩家都可存档）'); }
  catch (e) { toast('存档失败：' + e.message); }
};
// 房主编辑胜利条件（弹小 modal → PATCH /rooms/:code/settings）
if ($('victory-edit')) $('victory-edit').onclick = async () => {
  if (!state.roomCode) { toast('先建房/进房'); return; }
  const info = state._roomInfo || await api('GET', `/api/rooms/${state.roomCode}`);
  const mode = info.mode === 'go' ? 'go' : 'rts';
  $('modal-title').textContent = mode === 'go' ? '编辑胜利条件 / 回合制限制（房主）' : '编辑胜利条件（房主）';
  const gl = normGoLimitsClient(info.goLimits);
  $('modal-body').innerHTML = `
    <div style="font-size:13px;line-height:1.6">
      <div style="color:#8b949e;font-size:12px;margin-bottom:6px">勾选本局启用的胜利条件（未勾选则不触发）</div>
      <div id="victory-lines-edit-list"></div>
      <div style="color:#6e7681;font-size:11px;margin-top:8px">
        开启一条当前已满足的线，将在下一拍即判定；本局无胜利条件（全不勾）时需手动结束。
      </div>
      ${mode === 'go' ? `
      <div style="margin-top:12px;padding-top:8px;border-top:1px solid #30363d">
        <div style="color:#8b949e;font-size:12px;margin-bottom:6px">回合制限制（改后下一局/下一步即生效）</div>
        <div class="row" style="align-items:center;gap:6px;flex-wrap:wrap">
          <span style="font-size:11px;color:#8b949e">手数上限</span>
          <input id="golimits-edit-moves" type="number" min="20" max="600" step="10" value="${gl.maxMoves}" style="flex:0 0 76px">
          <span style="font-size:11px;color:#8b949e">每手秒数</span>
          <input id="golimits-edit-turn" type="number" min="5" max="300" step="5" value="${Math.round(gl.turnMs / 1000)}" style="flex:0 0 76px">
          <span style="font-size:11px;color:#8b949e">超时判负次数</span>
          <input id="golimits-edit-timeouts" type="number" min="1" max="20" step="1" value="${gl.maxTimeouts}" style="flex:0 0 76px">
        </div>
      </div>` : ''}
    </div>`;
  renderVictoryLines('victory-lines-edit-list', mode, info.victoryLines, true);
  const ok = $('modal-ok');
  ok.textContent = '保存';
  $('modal').style.display = 'flex';
  const cleanup = () => {
    ok.removeEventListener('click', onOk);
    $('modal').removeEventListener('click', onBackdrop);
    document.removeEventListener('keydown', onKey);
    ok.textContent = '确定';
  };
  const doClose = () => { $('modal').style.display = 'none'; cleanup(); };
  const onBackdrop = (e) => { if (e.target === $('modal')) doClose(); };
  const onKey = (e) => { if (e.key === 'Escape') doClose(); };
  const onOk = async () => {
    const lines = collectVictoryLines('victory-lines-edit-list', mode);
    const payload = { victoryLines: lines };
    if (mode === 'go' && $('golimits-edit-moves')) {
      payload.goLimits = {
        maxMoves: clampInt($('golimits-edit-moves').value, 20, 600, 150),
        turnMs: clampInt($('golimits-edit-turn').value, 5, 300, 30) * 1000,
        maxTimeouts: clampInt($('golimits-edit-timeouts').value, 1, 20, 3),
      };
    }
    try {
      const d = await api('PATCH', `/api/rooms/${state.roomCode}/settings`, payload);
      state._roomInfo = d.room;
      renderLobby(d.room);
      toast('✅ 已更新设置');
      doClose();
    } catch (e) { toast('更新失败：' + e.message); }
  };
  ok.addEventListener('click', onOk);
  $('modal').addEventListener('click', onBackdrop);
  document.addEventListener('keydown', onKey);
};

// 房主编辑棋盘形状（弹 modal → PATCH /rooms/:code/settings { board }）
// 已开始的房间由服务端强制拒绝（403 board_locked，Q3=a）→ 此处按钮也会置灰。
if ($('board-edit')) $('board-edit').onclick = async () => {
  if (!state.roomCode) { toast('先建房/进房'); return; }
  const info = state._roomInfo || await api('GET', `/api/rooms/${state.roomCode}`);
  if (info.started) { toast('对局已开始，棋盘形状已锁定'); return; }
  const mode = info.mode === 'go' ? 'go' : 'rts';
  $('modal-title').textContent = '编辑棋盘形状（房主）';
  $('modal-body').innerHTML = `
    <div style="font-size:13px;line-height:1.6">
      <div style="color:#8b949e;font-size:12px;margin-bottom:6px">
        裁剪形状（形状外=墙）或挖出「虚空格」（虚空=墙，不可落子/不可被吃）。对局开始后不可再改。
      </div>
      <div id="board-edit-presets" class="row" style="flex-wrap:wrap;gap:4px;margin:4px 0"></div>
      <canvas id="board-edit-canvas" width="240" height="240"
              style="width:240px;height:240px;border:1px solid #30363d;border-radius:4px;background:#0d1117;touch-action:none"></canvas>
      <div class="row" style="gap:4px;margin-top:4px;flex-wrap:wrap">
        <button id="board-edit-brush"  class="board-tool">画●</button>
        <button id="board-edit-void"   class="board-tool">挖✕</button>
        <button id="board-edit-erase"  class="board-tool">擦除·</button>
        <button id="board-edit-fill"   class="board-tool">填充</button>
        <button id="board-edit-rotate" class="board-tool">旋转</button>
        <button id="board-edit-reset"  class="board-tool">重置</button>
      </div>
      <div class="row" style="gap:4px;margin-top:4px;align-items:center">
        <span style="font-size:11px;color:#8b949e">尺寸（推荐 16~48）</span>
        <input id="board-edit-w" type="number" min="1" max="100" step="1" style="flex:0 0 64px">
        <span style="font-size:11px;color:#8b949e">×</span>
        <input id="board-edit-h" type="number" min="1" max="100" step="1" style="flex:0 0 64px">
      </div>
      <div id="board-edit-info" style="color:#6e7681;font-size:11px;margin-top:6px"></div>
      <div style="color:#6e7681;font-size:11px;margin-top:2px">图例：<span style="color:#3fb950">●可落子</span> / <span style="color:#8b949e">·形状外(墙)</span> / <span style="color:#f85149">✕虚空(墙)</span></div>
    </div>`;
  const ed = new BoardEditor($('board-edit-canvas'), mode, { onChange: () => { if ($('board-edit-info')) $('board-edit-info').textContent = ed.infoText(); } });
  ed.load(info.board, mode);
  if ($('board-edit-w')) $('board-edit-w').value = ed.w;
  if ($('board-edit-h')) $('board-edit-h').value = ed.h;
  if ($('board-edit-info')) $('board-edit-info').textContent = ed.infoText();
  // 预设
  const pbox = $('board-edit-presets');
  if (pbox) {
    pbox.innerHTML = BOARD_PRESET_KEYS.map(k =>
      `<button class="board-tool" data-tpl="${k}" style="flex:0 0 auto;padding:2px 8px">${BOARD_PRESET_LABELS[k]}</button>`
    ).join('');
    pbox.querySelectorAll('[data-tpl]').forEach(b => {
      b.onclick = () => { ed.setPreset(b.getAttribute('data-tpl')); if ($('board-edit-info')) $('board-edit-info').textContent = ed.infoText(); };
    });
  }
  const tools = [['board-edit-brush', 'brush'], ['board-edit-void', 'void'], ['board-edit-erase', 'erase'], ['board-edit-fill', 'fill']];
  tools.forEach(([id, tool]) => {
    const b = $(id);
    if (b) b.onclick = () => {
      ed.setTool(tool);
      tools.forEach(([bid]) => { const e = $(bid); if (e) { e.style.borderColor = '#30363d'; e.style.color = '#c9d1d9'; } });
      b.style.borderColor = '#58a6ff'; b.style.color = '#58a6ff';
    };
  });
  if ($('board-edit-rotate')) $('board-edit-rotate').onclick = () => { if (!ed.rotate()) toast('旋转后超出尺寸上限'); if ($('board-edit-info')) $('board-edit-info').textContent = ed.infoText(); };
  if ($('board-edit-reset')) $('board-edit-reset').onclick = () => { ed.reset(); if ($('board-edit-info')) $('board-edit-info').textContent = ed.infoText(); };
  if ($('board-edit-w')) $('board-edit-w').onchange = () => { ed.setSize(parseInt($('board-edit-w').value, 10), ed.h); $('board-edit-w').value = ed.w; $('board-edit-w').max = ed.max; if ($('board-edit-info')) $('board-edit-info').textContent = ed.infoText(); };
  if ($('board-edit-h')) $('board-edit-h').onchange = () => { ed.setSize(ed.w, parseInt($('board-edit-h').value, 10)); $('board-edit-h').value = ed.h; $('board-edit-h').max = ed.max; if ($('board-edit-info')) $('board-edit-info').textContent = ed.infoText(); };
  if ($('board-edit-w')) $('board-edit-w').max = ed.max;
  if ($('board-edit-h')) $('board-edit-h').max = ed.max;
  if ($('board-edit-brush')) { $('board-edit-brush').style.borderColor = '#58a6ff'; $('board-edit-brush').style.color = '#58a6ff'; }
  const ok = $('modal-ok');
  ok.textContent = '保存';
  $('modal').style.display = 'flex';
  const cleanup = () => {
    ok.removeEventListener('click', onOk);
    $('modal').removeEventListener('click', onBackdrop);
    document.removeEventListener('keydown', onKey);
    ok.textContent = '确定';
  };
  const doClose = () => { $('modal').style.display = 'none'; cleanup(); };
  const onBackdrop = (e) => { if (e.target === $('modal')) doClose(); };
  const onKey = (e) => { if (e.key === 'Escape') doClose(); };
  const onOk = async () => {
    const board = ed.getBoard();
    try {
      const d = await api('PATCH', `/api/rooms/${state.roomCode}/settings`, { board });
      state._roomInfo = d.room;
      renderLobby(d.room);
      toast('✅ 已更新棋盘形状');
      doClose();
    } catch (e) { toast('更新失败：' + e.message); }
  };
  ok.addEventListener('click', onOk);
  $('modal').addEventListener('click', onBackdrop);
  document.addEventListener('keydown', onKey);
};

if ($('lobby-leave')) $('lobby-leave').onclick = () => {
  state.roomCode = null; state.worldId = null;
  if (state.ws) try { state.ws.close(); } catch {}
  $('room-panel').style.display = 'none';
  $('world-panel').style.display = 'block';
  refreshRoomList();
  toast('已离开房间（席位改由电脑接手）');
};

// 进入房间面板（世界可能尚未建立）
function enterRoomPanel(info) {
  $('room-panel').style.display = 'block';
  $('world-panel').style.display = 'none';
  if (state.roomCode) $('room-code').textContent = state.roomCode;
  renderLobby(info);
}

// 渲染房间面板：席位列表 + 房主控制按钮的显隐
function renderLobby(info) {
  if (!info) return;
  state._roomInfo = info;
  const isHost = !!(info.isOwner || (state.user && info.hostId === state.user.id));
  const phase = info.phase || 'lobby';
  if ($('room-phase')) {
    $('room-phase').textContent = phase === 'lobby' ? '待建世界'
      : phase === 'ready' ? '已就绪（未开始）'
      : phase === 'playing' ? (info.paused ? '进行中 · ⏸ 暂停' : '进行中')
      : phase === 'closed' ? '已关闭' : phase;
  }
  if ($('room-count')) $('room-count').textContent = `${info.seatCount || 0}/${info.maxPlayers || 0}`;
  if ($('room-slots')) $('room-slots').textContent = `${info.humanCount || 0} 人 + ${info.aiCount || 0} 电脑`;
  // 玩法设置展示（所有玩家可见；数值来自房间设置，建好世界后以世界为准）
  if ($('room-settings-info')) {
    const spt = Number.isInteger(info.stonesPerTurn) ? info.stonesPerTurn : 3;
    const ldd = Number.isInteger(info.lonelyDeathDelay) ? info.lonelyDeathDelay : 0;
    $('room-settings-info').textContent = `落子 ${spt} 颗/回合 · 死亡宽限 ${ldd} 回合`;
  }
  // 胜利条件展示（只读；房主可点[编辑]改）
  const vMode = info.mode === 'go' ? 'go' : 'rts';
  if ($('victory-info')) {
    $('victory-info').textContent = victoryLinesText(info.victoryLines, vMode)
      + (info.isOwner || (state.user && info.hostId === state.user.id) ? '' : '（房主设定）');
  }
  if ($('victory-edit-row')) {
    $('victory-edit-row').style.display = (isHost) ? 'flex' : 'none';
  }
  // 棋盘形状展示（只读缩略图；房主未开局可点[编辑]改；已开始则锁定灰显）
  if ($('board-info')) {
    $('board-info').textContent = boardInfoText(info.board, vMode)
      + (isHost ? '' : '（房主设定）');
  }
  if ($('board-thumb-row')) {
    const hasBoard = !!normBoardClient(info.board);
    $('board-thumb-row').style.display = hasBoard ? 'flex' : 'none';
    if (hasBoard) {
      drawBoardThumb($('board-thumb'), info.board, vMode);
      if ($('board-thumb-legend')) {
        $('board-thumb-legend').innerHTML =
          `<span style="color:#3fb950">●可落子</span><br>`
          + `<span style="color:#8b949e">·形状外(墙)</span><br>`
          + `<span style="color:#f85149">✕虚空(墙)</span>`;
      }
    }
  }
  if ($('board-edit-row')) {
    // 房主且未开始才可编辑；已开始 → 隐藏（服务端另有 403 board_locked 强制）
    $('board-edit-row').style.display = (isHost && !info.started) ? 'flex' : 'none';
  }
  if ($('board-edit') && info.started) { $('board-edit').disabled = true; }
  // 房主按钮
  if ($('lobby-build-row')) $('lobby-build-row').style.display = (isHost && phase === 'lobby') ? 'flex' : 'none';
  if ($('lobby-start-row')) $('lobby-start-row').style.display = (isHost && phase !== 'lobby' && !info.started) ? 'flex' : 'none';
  ['lobby-add-ai', 'lobby-remove-ai', 'lobby-pause'].forEach(id => {
    const el = $(id); if (el) { el.disabled = !isHost; el.style.opacity = isHost ? '1' : '.45'; }
  });
  if ($('lobby-pause')) $('lobby-pause').textContent = info.paused ? '恢复(房主)' : '暂停(房主)';
  // 席位列表
  const box = $('seat-list');
  if (box) {
    const ps = info.players || [];
    if (!ps.length) {
      box.innerHTML = '<span style="color:#6e7681">还没有人就座</span>';
    } else {
      box.innerHTML = ps.map(p => {
        const me = state.user && String(p.id) === String(state.user.id);
        const tag = p.botControlled ? '<span style="color:#ffa94d">电脑代打</span>'
          : p.isAI ? '<span style="color:#8b949e">电脑</span>' : '<span style="color:#3fb950">人类</span>';
        return `<div class="stat"><span>${me ? '▶ ' : ''}${escapeHtml(p.name)}</span><b>${tag}</b></div>`;
      }).join('');
    }
  }
}

// 在房间里但世界未建时，轮询房间状态（房主建好后自动带我进世界）
setInterval(async () => {
  if (!state.roomCode || state.worldId) return;
  if (!state.token) return;
  try {
    const info = await api('GET', `/api/rooms/${state.roomCode}`);
    renderLobby(info);
    if (info.worldId) {
      state.worldId = info.worldId;
      state.mode = info.mode || state.mode;
      const j = await api('POST', `/api/rooms/${state.roomCode}/join`);
      if (j && j.worldId) { state.worldId = j.worldId; renderLobby(j.room); joinWS(); }
    }
  } catch (e) { /* 静默：房间可能已关闭 */ }
}, 2500);

$('logout').onclick = () => {
  state.token = null; state.user = null; localStorage.clear();
  if (state.ws) try { state.ws.close(); } catch {}
  onLogout();
};

// 复制邀请链接（永久可分享：用房间码拼出 ?room= 链接；go 模式附带 ?mode=go）
$('copy-invite').onclick = async () => {
  if (!state.roomCode) { toast('先建房/进房'); return; }
  const modeQ = isGo() ? '&mode=go' : '';
  const link = `${location.origin}/?room=${state.roomCode}${modeQ}`;
  try { await navigator.clipboard.writeText(link); toast('已复制邀请链接'); }
  catch { toast('链接：' + link); }
};
$('briefing-btn').onclick = () => showBriefing(true);
const _goHelpBtn = $('go-help-btn');
if (_goHelpBtn) _goHelpBtn.onclick = () => showGoRules();

// go 模式规则速查（一屏讲完 R1~R3）
async function showGoRules() {
  await modal('规则速查 · 回合制 演化棋', `
    <div style="font-size:13px;line-height:1.7">
      <b style="color:#ffd479">目标</b>：在棋盘上（默认 32×32，房主可调至 100×100）每回合可在任意空格落<b>多颗</b>子（默认 3，房主可设 1~16），按围棋规则提子，
      随后全盘跑一步<b>康威演化</b>——你的细胞会自己往外长。终局按<b>数子</b>（你的子数 + 归属你的空点）多者胜，不贴子。
      <div style="margin-top:8px"><b style="color:#ffd479">规则</b></div>
      ① <b>落子</b>：点任意空格即可（不限于邻接）；<b>每回合可落多颗</b>（默认 3，房主可设 1~16）。也可<b>不落子 / 少落子</b>——摆完点 <b>【结束回合】</b>即可生效；<b>0 颗直接点【结束回合】= 停一手（Pass）</b>，少于上限也能随时结束回合。<br>
      ② <b>提子</b>：正交 4 邻无气（无空点）的敌团被整团提掉；<b>禁自杀</b>；<b>劫</b>需先在他处应一手。<br>
      ③ <b>演化</b>：空格 8 邻恰好 3 个活细胞 → 诞生（阵营取邻域多数派，平票由种子掷定）；
      已有细胞 8 邻为 2~3 存活，否则死亡（<b>单颗、2 颗相邻都不足 2 邻，会被吃掉</b>）；房主可设<b>死亡宽限 N 回合</b>（默认 0，最多 10）才死。<br>
      ④ <b>领地</b>：每个空点归「<b>离它最近的棋子</b>」那一方；两边一样近则该点<b>中立</b>。
      <b>得分 = 你的棋子数 + 归属你的空点数</b>（不贴子）。棋盘底色就是这套归属，与结算口径一致。<br>
      ⑤ <b>世界事件</b>：每 25 手抽一个（繁盛 / 寒潮 / 拥挤突变），只改本回合演化参数。<br>
      ⑥ <b>终局</b>：<b>全员连续停手</b>（Pass）后按数子结算；此外 <b>手数上限</b>（默认 150）、认输、<b>累计超时</b>（默认 3 次）也会进入终局，胜者仍由数子决定。<b>吃光对方不算赢</b>——被吃光只出局、其地盘归零，棋局照常继续；只有<b>只剩一方未出局</b>时才结束。（手数上限与超时次数房主可设）<br>
      ⑦ <b>预览</b>：按 <kbd>Q</kbd> 开演化预览——会把本回合预选子也算进去（绿=将新生 / 红×=将死）。<br>
      <div style="margin-top:8px;color:#8b949e;font-size:12px">
      每手倒计时（默认 30 秒，房主可设），超时自动停一手。同 seed + 手顺可完整复盘（逐手一致）。
      </div>
    </div>
  `);
}

// go 模式首屏简报（FIX-1）：一屏讲清"要干什么 / 怎么操作 / 跟 rts 有啥不一样 / 为什么不一样还很深"。
// 只弹一次（state.seenGoBriefing）。文案复用并扩写 #go-help-btn 的 R1~R6 速查。
async function showGoBriefing() {
  await modal('任务简报 · 回合制 演化棋（go）', `
    <div style="font-size:13px;line-height:1.7">
      <div style="color:#ffd479;margin-bottom:6px">🧩 你要干什么</div>
      棋盘（默认 32×32，房主可调至 100×100），两方轮流落子。<b>终局比谁的地盘（数子）多</b>——
      你落下的子会自己往外长，抢到的空地才算你的。
      <div style="color:#ffd479;margin:10px 0 6px">🖱 怎么操作</div>
      ① <b>轮到你就点棋盘任意空格落子</b>（位置完全自由，不限于邻接）；<b>每回合可落多颗</b>（默认 3，房主可设 1~16）。点棋盘<b>只入预选、绝不提交</b>——摆完点 <b>【结束回合（k/N）】</b>才整批落下并演化。<b>也可以不落子或少落子</b>：直接点【结束回合】= 停一手（Pass），少于上限也能随时结束回合。左键点已有幽灵子可取消那一颗，右键/Esc 撤销最后一颗；倒计时 ≤2s 会保护性自动提交当回合预选。<br>
      ② 键盘 <kbd>P</kbd> 停一手（pass）、<kbd>Q</kbd> 演化预览、<kbd>Ctrl</kbd>+<kbd>R</kbd> 认输；每手倒计时（默认 30 秒，房主可设）超时自动 pass。<br>
      ③ 左上角 HUD 显示手数、行动方与倒计时；轮到你时棋盘边框会亮起。
      <div style="color:#ffd479;margin:10px 0 6px">↔ 跟实时模式（rts）有啥不一样</div>
      没有移动、没有资源、没有单位、<b>没有强弱棋子</b>——你只做"选一个点、点下去"这一件事。
      rts 是同时步 + 走位开枪；这里是<b>轮流落子 + 全盘演化</b>。
      <div style="color:#ffd479;margin:10px 0 6px">🌱 为什么不一样，还很深</div>
      每回合落子后<b>全盘跑一步康威演化</b>，你的子会自己往外长；
      <b>每个空点归离它最近的棋子那一方</b>（两边一样近则中立）——棋盘底色就是这套归属，与终局结算完全一致。所以<b>先落子 = 占先机</b>，
      后来者要落得更近、或吃掉它，才能翻盘。围棋提子（正交 4 邻无气即被提）、禁自杀、劫禁着在这里都生效。
      <div style="margin-top:10px;color:#8b949e;font-size:12px">
      每 25 手出现一次世界事件——涨潮、寒潮、繁盛或不按常理的分裂。<b>内容不可预测，但同 seed + 手顺可完整复盘</b>。
      </div>
      <div style="margin-top:12px">
        <button id="go-brief-rules" style="width:100%">📖 规则速查</button>
      </div>
    </div>
  `);
  // 「规则速查」按钮：打开 #go-help-btn 同一面板（showGoRules）。模态内的按钮自行绑事件。
  const gbr = $('go-brief-rules');
  if (gbr) gbr.onclick = () => showGoRules();
  state.seenGoBriefing = true;
}

// 用房间码加入（打开他人分享的永久链接时调用）
async function joinRoomByCode(code, password) {
  // P2-7 深链 join 去重：restore 与 onLogin 可能双跑，这里防抖只 join 一次
  if (state._joining) return;
  state._joining = true;
  try {
    // 私密房间：先探测是否需要密码（搜索接口对私密房只回存在性与 hasPassword）
    let info = null;
    try { info = await api('GET', `/api/rooms/search?code=${encodeURIComponent(code)}`); } catch (e) { info = null; }
    let pass = password;
    if (info && info.visibility === 'private' && info.hasPassword && !pass) {
      pass = window.prompt('房间 ' + code + ' 需要密码：') || '';
      if (!pass) { state._joining = false; return; }
    }
    const r = await api('POST', `/api/rooms/${code}/join`, pass ? { password: pass } : {});
    state.roomCode = code;
    state.mode = r.mode || state.mode || 'rts';
    state.worldId = r.worldId || null;
    enterRoomPanel(r.room);
    if (r.waiting || !r.worldId) {
      toast('已进入房间大厅，等待房主建立世界…', 3200);
    } else {
      joinWS();
      toast('已加入房间 ' + code + '（可中途加入 · 掉线由电脑接手）', 3200);
    }
  } catch (e) { toast('进房失败：' + e.message); }
  finally { state._joining = false; }
}

// 聊天
$('chat-send').onclick = () => sendChat();
$('chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

function sendChat() {
  const t = $('chat-input').value.trim(); if (!t || !state.ws) return;
  state.ws.send(JSON.stringify({ type: 'chat', data: { text: t } }));
  $('chat-input').value = '';
}

// 指令立即发送：延迟 = 惯性，服务器按到达顺序 FIFO 处理，客户端不做任何人为延迟
function sendIntent(intent) {
  if (state.ws && state.ws.readyState === 1) {
    state.ws.send(JSON.stringify({ type: 'intent', data: intent }));
  }
}

// ============== 输入 ==============
window.addEventListener('keydown', (e) => {
  state.keys.add(e.key.toLowerCase());
  // go（回合制）模式：rts 的落子/冲刺/预览键全部无效。补上 go 专属键位
  // （简报里承诺过 P 停一手 / Ctrl+R 认输，必须真的可用 —— FIX-8）。
  if (isGo()) {
    // 焦点在输入框（聊天）时不劫持按键
    const typing = document.activeElement && document.activeElement.tagName === 'INPUT';
    const k = e.key.toLowerCase();
    if (!typing && e.key === 'Escape') {              // Esc = 撤销最后一颗待落子
      if (undoGoPending()) e.preventDefault();
      return;
    }
    if (!typing && e.key === 'Enter') {              // Enter = 结束回合（提交本回合预选）
      e.preventDefault();
      const go = state.world && state.world.go;
      const uid = state.user && state.user.id;
      if (go && go.phase === 'over') { toast('对局已结束'); return; }
      if (go && go.turn != null && !sameId(go.turn, uid)) { toast('还没轮到你 · 等待对手'); return; }
      const k = state.goPending ? state.goPending.length : 0;
      submitGoPending();
      toast(k > 0 ? `已落下 ${k} 颗并结束回合` : '不落子结束回合（停一手）');
      return;
    }
    if (!typing && k === 'p') {                       // P = 停一手（二次确认，防误触丢一手）
      e.preventDefault();
      const uid = state.user && state.user.id;
      const go = state.world && state.world.go;
      if (go && go.phase === 'over') { toast('对局已结束'); return; }
      if (go && go.turn != null && go.blackId != null && go.whiteId != null && !sameId(go.turn, uid)) {
        toast('还没轮到你 · 等待对手'); return;
      }
      if (!state._goPassArmed) {
        state._goPassArmed = true;
        toast('再按一次 P 确认停一手（2.5s 内有效）', 2500);
        clearTimeout(state._goPassTimer);
        state._goPassTimer = setTimeout(() => { state._goPassArmed = false; }, 2500);
      } else {
        state._goPassArmed = false;
        clearTimeout(state._goPassTimer);
        sendIntent({ go: { pass: true } });
        toast('已停一手（Pass）');
      }
      return;
    }
    if (!typing && k === 'r' && (e.ctrlKey || e.metaKey)) {   // Ctrl/Cmd+R = 认输
      e.preventDefault();   // 必须阻止浏览器刷新
      const go = state.world && state.world.go;
      if (go && go.phase === 'over') { toast('对局已结束'); return; }
      if (window.confirm('确定认输？本局将直接判负。')) {
        sendIntent({ go: { resign: true } });
        toast('已认输');
      }
      return;
    }
    if (!typing && k === 'q') {                       // Q = 演化预览（把本回合预选子也算进去）
      e.preventDefault();
      state.previewMode = !state.previewMode;
      toast(state.previewMode ? '演化预览 ON · 含本回合预选子（绿=将新生 / 红×=将死）' : '演化预览 OFF');
      return;
    }
    if (!typing && k === 'v') {                       // V = 虚拟演化预览（假设其余玩家停手，推演 N 回合）
      e.preventDefault();
      state.virtualPreview = !state.virtualPreview;
      toast(state.virtualPreview
        ? `虚拟演化预览 ON · 假设其余玩家停手，推演 ${state.virtualRounds || 1} 回合（青色=将蔓延/新生，红✕=将消失）`
        : '虚拟演化预览 OFF');
      return;
    }
    // 其它键在 go 模式下忽略（避免误发 rts intent）
    if (e.key.toLowerCase() === 'f' && !typing) e.preventDefault();
    return;
  }
  // F：落子（消耗 1 颗种子，在脚下种下 **1 格**强细胞；要自己摆成 ≥3 连片或 2×2 才稳）。按住不重复发送。
  // 自动攻击+自动收集已服务端处理，无需手动攻击/收集键。
  if (e.key.toLowerCase() === 'f' && !state._plantPressed) {
    state._plantPressed = true;
    const me = state.world && findMe();
    if (me && (me.seeds || 0) > 0) sendIntent({ plant: true });
    else if (me) toast('没有种子了 · 每 2.25 秒回 1 颗（最多 6）');
  }
  // Q：切换康威演化预览（看清下一步哪些细胞新生/死亡，落子前推演）
  if (e.key.toLowerCase() === 'q') {
    state.previewMode = !state.previewMode;
    toast(state.previewMode ? '演化预览 ON · 显示下一步演化' : '演化预览 OFF');
  }
  // C：出局/胜利后的观战视角循环（别在聊天框里触发）
  if (e.key.toLowerCase() === 'c' && isSpectator() &&
      (!document.activeElement || document.activeElement.tagName !== 'INPUT')) {
    state.spectateIdx = (state.spectateIdx || 0) + 1;
    const t = camTarget();
    toast('👁 观战：' + (t ? t.name : '？') + ' · 再按 C 切换', 1200);
  }
  if (e.shiftKey && !state._dashPressed) {
    state._dashPressed = true;
    // dash 方向：当前移动方向或鼠标方向
    let dx = 0, dy = 0;
    if (state.keys.has('w') || state.keys.has('arrowup')) dy -= 1;
    if (state.keys.has('s') || state.keys.has('arrowdown')) dy += 1;
    if (state.keys.has('a') || state.keys.has('arrowleft')) dx -= 1;
    if (state.keys.has('d') || state.keys.has('arrowright')) dx += 1;
    if (!dx && !dy && state.mouse.has) {
      const me = state.world && findMe();
      if (me) { dx = state.mouse.wx - me.x; dy = state.mouse.wy - me.y; }
    }
    if (dx || dy) sendIntent({ dash: { dx, dy } });
  }
  if (e.key === 'Enter' && document.activeElement !== $('chat-input')) { $('chat-input').focus(); }
});
window.addEventListener('keyup', (e) => {
  state.keys.delete(e.key.toLowerCase());
  if (e.key === 'Shift') state._dashPressed = false;
  if (e.key.toLowerCase() === 'f') state._plantPressed = false;
});

// ============== 鼠标 ==============
// 单一视口变换：render 与鼠标映射共用，杜绝"放大后棋盘错位"
// 以本地玩家为中心；state.zoom 提供游戏内缩放（0.5~4 倍，鼠标滚轮控制，锚定屏幕中心=玩家）

// 类型安全的 id 比较：服务端 playerId 可能是 number 也可能是 string
// （JWT/DB/序列化任一侧都可能变型），一律 String 比较避免静默失效。
function sameId(a, b) { return String(a) === String(b); }

// 关键：把"本地玩家"解析出来。必须类型安全（id 可能是 number 也可能是 string），
// 且**绝不能回落到 players[0]（那可能是 AI）**——否则相机就跟着一个 AI 跑，真人反而跑偏。
function findMe() {
  if (!state.world || !state.world.players) return null;
  const uid = state.user && state.user.id;
  if (uid == null) return null;
  return state.world.players.find(p => String(p.id) === String(uid)) || null;
}
// 观战模式：自己已胜利/出局（不再复活）时进入；相机改跟别的存活玩家
function isSpectator() {
  const me = findMe();
  return !!(me && (me.won || me.lost));
}
// 当前世界是否为回合制（go）模式。以 snap.mode 为准（服务端权威），state.mode 作为兜底。
function isGo() {
  return (state.world && state.world.mode === 'go') || state.mode === 'go';
}
// go 模式：我方阵营号（1..8，多方局每人一个阵营）。以 go.seats 为权威。
function goMyFaction() {
  const w = state.world;
  if (!w || !w.go) return 0;
  const uid = state.user && state.user.id;
  if (uid == null) return 0;
  const seats = w.go.seats;
  if (Array.isArray(seats) && seats.length) {
    const hit = seats.find(s => sameId(s.playerId, uid));
    if (hit) return hit.faction;
  }
  // 兼容旧两方快照
  if (w.go.blackId != null && sameId(w.go.blackId, uid)) return 1;
  if (w.go.whiteId != null && sameId(w.go.whiteId, uid)) return 2;
  return 0;
}
// 阵营 → 显示色（多方局用玩家自身颜色；回退到生命棋盘的阵营色板）
const GO_FACTION_COLORS = ['#111820', '#eef2f7', '#f0883e', '#a371f7', '#3fb950', '#58a6ff', '#f778ba', '#e3b341', '#7ee787'];
function goFactionColor(f) {
  const w = state.world;
  const seats = (w && w.go && w.go.seats) || [];
  const hit = seats.find(s => s.faction === f);
  if (hit && hit.color) return hit.color;
  return GO_FACTION_COLORS[f] || '#8b949e';
}
function goFactionName(f) {
  const w = state.world;
  const seats = (w && w.go && w.go.seats) || [];
  const hit = seats.find(s => s.faction === f);
  if (!hit) return '—';
  return hit.name + (hit.isAI ? ' (电脑)' : (hit.botControlled ? ' (电脑代打)' : ''));
}
// 本回合可落子数：优先 go.stonesPerTurn（服务端权威），回退 settings，再回退默认 3。
function goStonesPerTurn() {
  const w = state.world;
  const v = (w && w.go && Number.isInteger(w.go.stonesPerTurn)) ? w.go.stonesPerTurn
    : ((w && w.settings && Number.isInteger(w.settings.stonesPerTurn)) ? w.settings.stonesPerTurn : 3);
  return v;
}
// 结束本回合：把预选的落子整批提交。**预选为 0 时 = 不落子结束回合 = 停一手（pass）**。
// k=0 必须走 {go:{pass:true}} —— 服务端对 moves:[] 会判 bad_move，所以 0 颗只能走 pass。
// 支持 1..stonesPerTurn 任意颗（少于上限也能随时结束回合）。
function submitGoPending() {
  const moves = (state.goPending || []).map(p => ({ lx: p.lx, ly: p.ly }));
  state.goPending = [];
  if (moves.length === 0) sendIntent({ go: { pass: true } });
  else sendIntent({ go: { moves } });
  renderHud();
  return true;
}
// 撤销最后一颗预选（右键 / Esc）
function undoGoPending() {
  if (!state.goPending || !state.goPending.length) return false;
  state.goPending.pop();
  renderHud();
  return true;
}
// 相机目标：平时=自己；观战时=按 state.spectateIdx 循环的其它玩家
function camTarget() {
  const me = findMe();
  if (!me || !isSpectator()) return me;
  const ps = state.world.players || [];
  let cands = ps.filter(p => p.id !== me.id && p.alive !== false && !p.lost && !p.won);
  if (!cands.length) cands = ps.filter(p => p.id !== me.id); // 全出局/全胜：跟随剩下的人
  if (!cands.length) return me;
  const idx = ((state.spectateIdx || 0) % cands.length + cands.length) % cands.length;
  return cands[idx];
}
// 缩放：**覆盖式**（取 max）——任何屏幕比例下世界都铺满画布，不再出现宽屏两侧的大片黑边。
// （旧版用 min*0.95 → 宽屏只按高度适配，加上又跟着玩家居中，于是"地图偏向一边 + 一大片黑"。）
// 想看全图用滚轮缩小（state.zoom<1）：世界小于视口时玩家**仍居中**（两侧露出背景色）。
function viewScale() {
  const w = cv.width, h = cv.height;
  return Math.max(w / WORLD, h / WORLD) * (state.zoom || 1);
}
function viewTransform() {
  const me = camTarget();
  const w = cv.width, h = cv.height;
  const scale = viewScale();
  const worldPx = WORLD * scale;
  // 相机以玩家为中心，但**夹在世界范围内**：地图比视口大时，边缘不再露出黑边；
  // 地图比视口小（缩小看全图）时，直接居中。
  // 玩家**恒居中**；只有当地图比视口大时，才把相机夹在世界内（避免地图边缘露黑）。
  // ⚠️ 地图比视口小（缩小看全图）时**不夹**——旧版会改成"居中世界"，玩家一动就偏离屏幕中心（实测反馈）。
  let tx = me ? me.x : WORLD / 2;
  let ty = me ? me.y : WORLD / 2;
  if (worldPx >= w) { const half = (w / scale) / 2; tx = Math.min(Math.max(tx, half), WORLD - half); }
  if (worldPx >= h) { const half = (h / scale) / 2; ty = Math.min(Math.max(ty, half), WORLD - half); }
  return { scale, cx: w / 2 - tx * scale, cy: h / 2 - ty * scale };
}
// 把鼠标事件坐标（CSS 像素）换算成 canvas 后备缓冲坐标，
// 关键：乘上 cv.width/rect.width，浏览器缩放或 CSS 缩放都不会再错位
function eventToCanvas(e) {
  const r = cv.getBoundingClientRect();
  return {
    sx: (e.clientX - r.left) * (cv.width / r.width),
    sy: (e.clientY - r.top) * (cv.height / r.height),
  };
}
// 屏幕坐标 → 世界坐标
function screenToWorld(sx, sy) {
  const { scale, cx, cy } = viewTransform();
  return { x: (sx - cx) / scale, y: (sy - cy) / scale };
}

cv.addEventListener('mousemove', (e) => {
  const { sx, sy } = eventToCanvas(e);
  const wld = screenToWorld(sx, sy);
  state.mouse.sx = sx; state.mouse.sy = sy;
  state.mouse.wx = wld.x; state.mouse.wy = wld.y;
  state.mouse.has = true;
});

// 左键/右键：rts 模式 = 点哪走到哪（攻击已自动）；go 模式 = 点击空格落子
cv.addEventListener('mousedown', (e) => {
  if (!state.ws || state.ws.readyState !== 1) return;
  const { sx, sy } = eventToCanvas(e);
  const wld = screenToWorld(sx, sy);
  // go 模式：左键=预选（入 state.goPending，不提交）；左键点已有幽灵子=取消那一颗；
  // 右键=撤销最后一颗。客户端点击得到的是**世界坐标**，需 /LIFE_CELL 换算成生命格坐标。
  // 真正落子只在点【结束回合】或倒计时 ≤2s 保护性自动提交时整批发生。lifeGrid 以 [x][y] 索引，不转置。
  if (isGo()) {
    // 右键：撤销本回合最后一颗预选子
    if (e.button === 2) { if (!undoGoPending()) toast('没有可撤销的待落子'); return; }
    if (e.button !== 0) return;   // go 模式左键预选，右键撤销
    // 用 go 专属坐标换算（与 renderGo 的 goViewTransform 严格互逆），否则落子格会和渲染错位。
    const lw = (state.world && state.world.lifeW) || GO_BOARD;
    const cell = goScreenToCell(sx, sy);
    const lx = cell.lx, ly = cell.ly;
    if (lx < 0 || ly < 0 || lx >= lw || ly >= lw) return;
    const w = state.world;
    // 终局后 / 非我方回合：本地先给提示，服务端仍会兜底拒绝
    if (w && w.go && w.go.phase === 'over') { toast('对局已结束'); return; }
    const uid = state.user && state.user.id;
    if (w && w.go && w.go.turn != null && !sameId(w.go.turn, uid)) { toast('还没轮到你 · 等待对手'); return; }
    // 预选阶段本地校验：已有子 / 劫禁着（其余非法由服务端兜底）
    const grid = w && w.lifeGrid;
    if (grid && grid[lx] && grid[lx][ly]) { toast('此处已有棋子'); return; }
    if (w && w.go && w.go.ko && w.go.ko.lx === lx && w.go.ko.ly === ly) { toast('劫禁着 · 先在他处应一手'); return; }
    // 左键点已预选的幽灵子 → 取消那一颗（与"点空格新增预选"区分开：命中已有预选=删除，命中空格=新增）
    const pi = state.goPending.findIndex(p => p.lx === lx && p.ly === ly);
    if (pi >= 0) { state.goPending.splice(pi, 1); renderHud(); return; }
    const budget = goStonesPerTurn();
    if (state.goPending.length >= budget) { toast(`本回合最多落 ${budget} 颗`); return; }
    // 首次预选：记住所属回合（换回合/新快照时据此清空）
    if (!state.goPending.length) {
      state._goPendingKey = (w && w.go) ? ((Number(w.go.moveNo) || 0) + ':' + (w.go.turn == null ? '' : w.go.turn)) : null;
    }
    state.goPending.push({ lx: lx | 0, ly: ly | 0 });
    // 点棋盘**只入预选、绝不提交**：棋盘在点【结束回合】之前保持一动不动。
    renderHud();
    return;
  }
  if (e.button === 0 || e.button === 2) {
    state.moveTarget = { x: wld.x, y: wld.y };
  }
});
// 滚轮缩放地图（锚定屏幕中心=玩家），解决"地图太小/放大后错位"
cv.addEventListener('wheel', (e) => {
  e.preventDefault();
  const z = state.zoom || 1;
  const nz = Math.max(0.5, Math.min(4, z * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
  state.zoom = nz;
}, { passive: false });
// 屏蔽右键菜单，腾给"移动"用
cv.addEventListener('contextmenu', (e) => e.preventDefault());

// `?` 键切换按键绑定面板
window.addEventListener('keydown', (e) => {
  if (e.key === '?') { state.showKeys = !state.showKeys; renderKeyPanel(); }
});
// `0` 键切换诊断读数（排障）：把画布实际尺寸 / 相机 / 缩放 / 玩家位置 显示出来。
window.addEventListener('keydown', (e) => {
  if (e.key === '0') { state.showDebug = !state.showDebug; renderDebug(); }
});
function renderDebug() {
  let el = document.getElementById('debug-hud');
  if (!state.showDebug) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'debug-hud';
    el.style.cssText = 'position:absolute;left:8px;bottom:8px;font:11px/1.6 monospace;color:#9fb3c8;'
      + 'background:rgba(0,0,0,.68);padding:6px 9px;border:1px solid #30363d;border-radius:6px;'
      + 'white-space:pre;z-index:9;pointer-events:none';
    (cv.parentElement || document.body).appendChild(el);
  }
  const t = viewTransform();
  const me = findMe();
  const wrap = cv.parentElement;
  el.textContent =
    'win  ' + window.innerWidth + 'x' + window.innerHeight + '   dpr ' + (window.devicePixelRatio || 1) + '\n' +
    'cv   ' + cv.width + 'x' + cv.height + '   wrap ' + (wrap ? wrap.clientWidth + 'x' + wrap.clientHeight : '?') + '\n' +
    'zoom ' + (state.zoom || 1).toFixed(2) + '   scale ' + t.scale.toFixed(2) + '   cam ' + t.cx.toFixed(1) + ',' + t.cy.toFixed(1) + '\n' +
    'me   ' + (me ? (me.x.toFixed(1) + ',' + me.y.toFixed(1) + '  lost=' + !!me.lost + ' won=' + !!me.won) : 'null')
    + '   mode ' + (isGo() ? 'go' : 'rts');
}

// ============== WS ==============
// M2：心跳 + 客户端自动重连
//  - 每 10s 发一次 {type:'heartbeat'}（服务端 30s 超时踢线，心跳作为兜底不再被踢）
//  - onclose/onerror → 指数退避重连（1s→2s→4s→8s 封顶），同一时刻只允许一个重连定时器
//  - hello 连续失败 3 次且已有 roomCode → 先 POST /api/rooms/:code/join 拿回 worldId 再 hello
function sendWs(obj) {
  if (state.ws && state.ws.readyState === 1) { try { state.ws.send(JSON.stringify(obj)); } catch {} }
}
function clearReconnect() {
  if (state._reconnTimer) { clearTimeout(state._reconnTimer); state._reconnTimer = null; }
}
function scheduleReconnect() {
  if (!state.token || !state.worldId) return;   // 已登出：不再重连
  if (state._reconnTimer) return;               // 去重：同刻只有一个重连定时器
  const delay = state._reconnDelay || 1000;
  $('hud').innerHTML = '<b style="color:#ffd479">连接断开，重连中…</b>';
  state._reconnecting = true;
  state._reconnTimer = setTimeout(async () => {
    state._reconnTimer = null;
    // hello 连续失败 ≥3 次 → 先通过 REST join 重建/拿回 worldId（服务重启后深链也适用）
    if ((state._helloFails || 0) >= 3 && state.roomCode) {
      try {
        const r = await api('POST', `/api/rooms/${state.roomCode}/join`);
        if (r && r.worldId) { state.worldId = r.worldId; state._helloFails = 0; }
      } catch (e) { /* 保留旧 worldId，继续重试 */ }
    }
    state._reconnDelay = Math.min(8000, (state._reconnDelay || 1000) * 2);
    openSocket();
  }, delay);
}
function openSocket() {
  if (!state.worldId || !state.token) return;
  if (state.ws) { try { state.ws.close(); } catch {} }
  clearReconnect();
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  state.ws = ws;
  ws.onopen = () => {
    state._awaitingWelcome = true;
    // 心跳兜底：每 10s 一次，防止被服务端 30s 无消息踢线
    if (!state._hbTimer) {
      state._hbTimer = setInterval(() => {
        if (state.ws && state.ws.readyState === 1) {
          try { state.ws.send(JSON.stringify({ type: 'heartbeat' })); } catch {}
        }
      }, 10000);
    }
    ws.send(JSON.stringify({ type: 'hello', data: { token: state.token, worldId: state.worldId } }));
    $('room-panel').style.display = 'block';
    $('chatbox').style.display = 'flex';
    if (!state._everOpened) {
      state._everOpened = true;
      toast('已进入房间 · 分享链接给好友 → 算法信号密度上升、涌现更频繁', 3500);
    }
  };
  ws.onmessage = (ev) => {
    // F1 配套：已被 openSocket() 取代的旧连接，其迟到的消息一律丢弃，
    // 避免旧世界的 snap 覆盖当前世界（与 onclose 的自身份判断同一原则）。
    if (state.ws && state.ws !== ws) return;
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'welcome') {
      // P2-10：welcome 只含 {worldId,tick,you}，缺 players，绝不当作 snap 整体替换
      // state.world（否则进房瞬间画布闪「登录后开始游戏」）。真正渲染等随后的 snap。
      state._awaitingWelcome = false;
      state._helloFails = 0;
      state._reconnDelay = 1000;   // 连接成功 → 重置退避
      clearReconnect();            // F1 双保险：连接已确认健康，撤销任何在途重连定时器
      if (state._reconnecting) {
        state._reconnecting = false;
        toast('已重连 · 回到房间', 2200);
      }
      return;
    } else if (m.type === 'snap') {
      state.world = m.data;
      state.mode = m.data.mode || state.mode || 'rts';
      // 回合制：换回合（moveNo 变化）或轮到他方 → 清空本回合预选，避免把上一回合的选点带过来
      if (m.data && m.data.go) {
        const _g = m.data.go;
        const _uid = state.user && state.user.id;
        const _key = (Number(_g.moveNo) || 0) + ':' + (_g.turn == null ? '' : _g.turn);
        if (state.goPending.length && state._goPendingKey && state._goPendingKey !== _key) state.goPending = [];
        if (_g.turn != null && !sameId(_g.turn, _uid)) state.goPending = [];
      }
      // FIX-1：首个 snap 到达 → 模式已确定，按模式分流弹对应简报（只弹一次）。
      // go 世界弹 go 简报，rts 世界弹 rts 简报；纯浏览态已在 onLogin 弹过 rts，这里不重复。
      if (!state._briefedFor) {
        state._briefedFor = true;
        if (isGo()) {
          if (!state.seenGoBriefing) showGoBriefing();
        } else if (!state.seenBriefing) {
          showBriefing(false);
        }
      }
      renderHud();
    } else if (m.type === 'event') {
      const me = state.world && findMe();
      const now = Date.now();
      for (const ev of (m.data || [])) {
        // 落子成功反馈
        if (ev.type === 'plant' && me && sameId(ev.playerId, me.id)) {
          toast('落子成功 · 强细胞已种下', 1200);
          if (me) { addFxRing(me.x, me.y, me.color || '#5fd068', 2.6, 700); addFxFloat(me.x, me.y, '+1 强细胞', '#5fd068'); }
        }
        // 大氧化事件（世界级跃迁：无氧世界 → 有氧世界）
        if (ev.type === 'oxidation') {
          toast('🌊 大氧化事件：蓝细菌布满海面，大气第一次出现氧气——有氧代谢解锁：全体更快、抗吞噬更强、种子回速更高！', 6400);
          if (me) addFxRing(me.x, me.y, '#5ad1ff', 2.5, 1400);
        }
        // 演化里程碑：这条线 = 生物复杂性（单细胞→多细胞→动植物→生态系）
        if (ev.type === 'evolution' && me && sameId(ev.playerId, me.id)) {
          const unlock = {
            1: '🧬 演化完成：单细胞 → 多细胞纪：菌落学会"分工"，按 F 落子种出强细胞（组织）！',
            2: '🦴 演化完成：动植物纪：你成为完整异养生物——潮汐捕食者登场、争夺加剧（F 占地其实多细胞纪就开放了，边界随时可争夺）',
            3: '🌍 演化完成：生态系统纪：领土胜利开放，四谱系争夺生态位！',
          }[ev.era];
          if (unlock) {
            toast(ev.mutation ? unlock + ' 🧬 ' + ev.mutation : unlock, 5600);
            if (me) { addFxRing(me.x, me.y, '#ffd479', 2, 1000); addFxFloat(me.x, me.y, '晋级', '#ffd479'); }
          }
        }
        // 单细胞期按 F：还没演化出组织，给出下一步提示（节流，避免长按刷屏）
        if (ev.type === 'evolution_locked' && me && sameId(ev.playerId, me.id)) {
          if (!state._lastLockedToast || now - state._lastLockedToast > 2500) {
            state._lastLockedToast = now;
            toast('🧫 无氧单细胞还不能落子 —— 先游动留下痕迹，约 30 秒后演化出"组织"能力 (F)', 2400);
          }
        }
        // M9 capture（围棋提子）：我方围死 → 在被提团位置播环 + 飘字 + toast；敌方围死 → 淡提示
        if (ev.type === 'capture') {
          const n = Number(ev.cells) || 0;
          const pts = n * 5;
          if (me && sameId(ev.playerId, me.id)) {
            const cx = (Number(ev.lx) + 0.5) * LIFE_CELL;
            const cy = (Number(ev.ly) + 0.5) * LIFE_CELL;
            addFxRing(cx, cy, me.color || '#5fd068', 1.5, 900);
            addFxFloat(cx, cy, '提子 +' + pts, '#5fd068');
            toast('围死 ' + n + ' 子 · +' + pts + ' 分', 1800);
          } else if (!state._lastCapToast || now - state._lastCapToast > 3500) {
            state._lastCapToast = now;
            toast('⚔ 场上发生围杀：某谱系提掉 ' + n + ' 子', 1600);
          }
        }
        // M9 tide_boss / tide_storm：潮汐预警
        if (ev.type === 'tide_boss') {
          toast('🌊 潮汐首领出现：红色大敌来袭，注意集结防守！', 3600);
        } else if (ev.type === 'tide_storm') {
          toast('🌀 算法风暴：潮汐涌动加剧，扩张时留神！', 3600);
        }
        // M9 victory / eliminated：胜负 toast（字段防御性读取，缺失就用默认文案）
        if (ev.type === 'victory' && me && sameId(ev.playerId, me.id)) {
          // F7（QA P3-4）补齐 economy 的两个硬性前置条件（engine.js:968：
          // lead>=600 && regionsOwned>=10 && era>=3 连续 1800 tick），
          // 否则玩家会误以为纯分数领先就能赢。
          const reason = { singularity: '算法奇点（6 资源全 30）', territory: '领土胜利（生态纪 + 16 区）', economy: '经济领先（生态纪 + ≥10 区 + 领先 600 持续 90s）', survival: '存活胜利（其余谱系全出局）' }[ev.reason] || ev.reason || '';
          toast('🏆 胜利：' + (reason || '达成胜利条件'), 5600);
        }
        if (ev.type === 'eliminated' && me && sameId(ev.playerId, me.id)) {
          toast('☠ 你出局：' + ({ military: '12 次死亡' }[ev.reason] || ev.reason || '军事失败'), 5600);
        }
        // ---- go（回合制）事件 ----
        if (ev.type === 'go_move' && ev.captured > 0) {
          toast((sameId(ev.playerId, me && me.id) ? '你' : '对手') + '提子 ' + ev.captured + ' 个', 1600);
        }
        if (ev.type === 'go_world_event') {
          const cn = { flourish: '🌱 繁盛：本回合演化加速 ×2', frost: '❄ 寒潮：本回合暂停演化', mutate: '🔥 拥挤突变：诞生更拥挤（阈值 5）' }[ev.event] || '世界事件';
          toast(cn, 3200);
        }
        if (ev.type === 'go_timeout') {
          toast((sameId(ev.playerId, me && me.id) ? '你' : '对手') + '超时 · 自动停一手', 2200);
        }
        // FIX-3(b)：非法落子被拒 → 留红叉（只在拒绝我方落子时提示/留痕）
        if (ev.type === 'go_reject') {
          const mine = me && sameId(ev.playerId, me.id);
          if (mine) {
            state._goReject = { lx: Number(ev.lx), ly: Number(ev.ly), born: performance.now() };
            const rjCn = {
              occupied: '此处已有棋子',
              ko: '劫禁着 · 先在他处应一手',
              suicide: '不能自杀（落下去无气）',
              not_your_turn: '还没轮到你',
              too_many_stones: '本回合落子数超上限',
            }[ev.reason];
            // oob / bad_move / ended 不提示（点出界不算错误）；其余同原因 1.5s 节流
            if (rjCn && now - (state._goRejectToastAt || 0) > 1500) {
              state._goRejectToastAt = now;
              toast(rjCn, 1800);
            }
          }
        }
        if (ev.type === 'go_end') {
          // 通知由 snap → renderGoHud 的终局弹窗统一处理
          state._goResultShown = false;
        }
        // M9 combo：飘字「xN」（引擎在 combo>=3 时才发）
        if (ev.type === 'combo' && me && sameId(ev.playerId, me.id) && (Number(ev.combo) || 0) >= 3) {
          addFxFloat(me.x, me.y, Number(ev.combo) + 'x', '#ffd56b');
        }
      }
      renderHud();
    } else if (m.type === 'chat') {
      const c = m.data; state.chat.push(c);
      if (state.chat.length > 5) state.chat.shift();
      toast(`${c.from}: ${c.text}`);
    } else if (m.type === 'error') {
      // welcome 到达前收到的错误 = hello 失败一次（用于触发 REST 重建路径）
      if (state._awaitingWelcome) {
        state._helloFails = (state._helloFails || 0) + 1;
        state._awaitingWelcome = false;
      }
      toast('错误：' + (m.data && m.data.message));
    }
  };
  ws.onclose = () => {
    // F1（QA P1-1）重连风暴：只有"自己仍是当前连接"才允许拆状态并排重连。
    // openSocket() 会 close() 旧 ws 再 clearReconnect()；旧 ws 的 onclose 是异步触发的，
    // 若在这里无条件 scheduleReconnect()，就会在 clearReconnect() 之后再排一个定时器，
    // 1s 后 openSocket 又关掉刚建好的健康连接 → 自持拆建循环（HUD 反复闪"重连中"）。
    if (state.ws !== ws) return;
    if (state._hbTimer) { clearInterval(state._hbTimer); state._hbTimer = null; }
    state.ws = null;
    scheduleReconnect();
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
}
// 建房/进房统一入口（保留原名 joinWS 供 quick-room/joinRoomByCode 调用）
function joinWS() {
  state._everOpened = false;   // 主动新开 = 首次进房（意外断线走重连才会显示"已重连"）
  state._reconnDelay = 1000;
  state._reconnecting = false;
  openSocket();
}

// ============== 康威演化预览（客户端镜像服务端 _lifeStep，用于"落子前推演"）==============
// 这是把"算法当玩法"的核心呈现：玩家能看见下一步哪些细胞新生、哪些死亡，
// 以及脚下若落子会发生什么——棋类级别的推演能力。
const ERA_RESIST = [1.0, 1.5, 2.0, 3.0];
function _isStrongCell(v) { return v > 0 && v <= 8; }
function _factionOfCell(v) { return v > 10 ? v - 10 : v; }

// 确定性地推演一步 faction-aware Conway B3/S23（服务端随机凋零部分在此近似为"将死"）
function simulateLifeStep(grid, myFaction, myResist) {
  const W = grid.length;
  // 要塞掩码：2x2 同色强子块（双倍抗性）
  const sh = Array.from({ length: W }, () => new Uint8Array(W));
  for (let x = 0; x < W - 1; x++) for (let y = 0; y < W - 1; y++) {
    const a = grid[x][y];
    if (!_isStrongCell(a)) continue;
    if (a === grid[x + 1][y] && a === grid[x][y + 1] && a === grid[x + 1][y + 1]) {
      sh[x][y] = sh[x + 1][y] = sh[x][y + 1] = sh[x + 1][y + 1] = 1;
    }
  }
  const next = Array.from({ length: W }, () => new Int8Array(W));
  for (let x = 0; x < W; x++) for (let y = 0; y < W; y++) {
    const raw = grid[x][y];
    const curF = _factionOfCell(raw);
    let n = 0; const counts = {}; let allyStrongNear = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= W) continue;
      const v = grid[nx][ny]; if (!v) continue;
      n++;
      const f = _factionOfCell(v);
      counts[f] = (counts[f] || 0) + 1;
      if (_isStrongCell(v) && f === curF) allyStrongNear++;
    }
    if (raw) {
      const same = counts[curF] || 0;
      let enemy = 0; for (const f in counts) if (+f !== curF) enemy += counts[f];
      const anchor = sh[x][y] ? 2 : 1;
      const tol = same * ((curF === myFaction ? myResist : 1.0)) * anchor;
      let alive = (n === 2 || n === 3) && enemy <= tol;
      // 弱痕无同色强子支撑则凋零（服务端用随机概率，这里确定性地判为将死）
      if (alive && raw > 10 && allyStrongNear === 0) alive = false;
      next[x][y] = alive ? raw : 0;
    } else if (n === 3) {
      let bestF = 0, bestC = 0;
      for (const f in counts) if (counts[f] > bestC) { bestC = counts[f]; bestF = +f; }
      next[x][y] = bestF;
    } else next[x][y] = 0;
  }
  return next;
}

// 回合制一步演化推演：镜像服务端 go.js _goEvolveOnce（标准康威 B3/S23、非环形边界、
// 诞生阵营取 8 邻多数派）。若给定本回合预选 pending，则先把它们落到盘上（作为 myF），
// 并视作"本回合刚落"豁免死亡 —— 让玩家能判断这批摆下去站不站得住。
function simulateGoStep(grid, pending, myF) {
  const W = grid.length;
  const L = grid.map(col => Array.from(col));
  const placed = new Set();
  if (pending && myF > 0) {
    for (const p of pending) {
      if (p.lx < 0 || p.ly < 0 || p.lx >= W || p.ly >= W) continue;
      L[p.lx][p.ly] = myF;
      placed.add(p.lx * W + p.ly);
    }
  }
  const next = Array.from({ length: W }, () => new Int8Array(W));
  for (let x = 0; x < W; x++) for (let y = 0; y < W; y++) {
    const counts = new Array(9).fill(0); let n = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= W) continue;
      const f = _factionOfCell(L[nx][ny]);
      if (f > 0 && f < counts.length) { n++; counts[f]++; }
    }
    const cur = L[x][y];
    if (cur) {
      if (placed.has(x * W + y)) { next[x][y] = cur; continue; }   // 本回合刚落：豁免死亡
      next[x][y] = (n === 2 || n === 3) ? cur : 0;
    } else if (n === 3) {
      let bestF = 0, bestC = 0;
      for (let fi = 1; fi < counts.length; fi++) if (counts[fi] > bestC) { bestC = counts[fi]; bestF = fi; }
      next[x][y] = bestF;
    }
  }
  return { next, base: L };
}

// 多回合演化推演：在 simulateGoStep 之上叠加，模拟「我方结束回合、其余玩家全部停手」后
// 第 N 回合的盘面。第 1 步把预选子算进去（并豁免死亡），其后各步不再有新子、不再豁免，
// 纯靠演化规则自然蔓延/消亡。返回 { projected: 末态盘面, base: 当前盘+预选子 } 供视觉差分。
function simulateGoSteps(grid, pending, myF, rounds) {
  const r = Math.max(1, Math.min(8, rounds | 0 || 1));
  // base = 当前盘 + 本回合预选子（与 simulateGoStep 内部 applied 一致），用于判断"新增/消失"
  const base = simulateGoStep(grid, pending, myF).base;
  let proj = simulateGoStep(grid, pending, myF).next; // 第 1 步（含预选 + 豁免）
  for (let i = 1; i < r; i++) {
    proj = simulateGoStep(proj, null, myF).next;       // 第 2..N 步（无新子、无豁免）
  }
  return { projected: proj, base };
}

// 在已 translate/scale 的棋盘坐标系内画"下一步演化"预览（绿=将新生 / 红×=将死）。
// 与 rts 的 renderLifePreview 一致：把 state.goPending 的预选子也算进推演。
function renderGoPreview() {
  const w = state.world;
  if (!w) return;
  const lw = w.lifeW || GO_BOARD;
  const grid = w.lifeGrid;
  if (!grid || !grid.length) return;
  const myF = goMyFaction();
  if (myF <= 0) return;
  const { next, base } = simulateGoStep(grid, state.goPending, myF);
  for (let x = 0; x < lw; x++) for (let y = 0; y < lw; y++) {
    const b = base[x][y], nx = next[x][y];
    if (b === 0 && nx !== 0) {
      ctx.fillStyle = 'rgba(63,185,80,0.40)';
      ctx.fillRect(x + 0.08, y + 0.08, 0.84, 0.84);
    } else if (b !== 0 && nx === 0) {
      ctx.strokeStyle = 'rgba(255,107,107,0.85)';
      ctx.lineWidth = 0.08;
      ctx.beginPath();
      ctx.moveTo(x + 0.25, y + 0.25); ctx.lineTo(x + 0.75, y + 0.75);
      ctx.moveTo(x + 0.75, y + 0.25); ctx.lineTo(x + 0.25, y + 0.75);
      ctx.stroke();
    }
  }
}

// go 模式「虚拟演化预览」：用与真实棋子不同的青色虚拟格，标出"我方结束回合、其余玩家全部停手"
// 后第 N 回合棋子的变化——青色实心方块=将蔓延/新生，红色✕=将消失。纯提示：他人落子会改变真实结果。
// base = 当前盘 + 本回合预选子，projected = 推演末态。差分只针对我方阵营(myF)以聚焦"我的棋子去哪了"。
function renderGoVirtualPreview() {
  const w = state.world;
  if (!w) return;
  const g = w.go;
  if (!g || g.phase === 'over') return;
  const lw = w.lifeW || GO_BOARD;
  const grid = w.lifeGrid;
  if (!grid || !grid.length) return;
  const myF = goMyFaction();
  if (myF <= 0) return;
  const { projected, base } = simulateGoSteps(grid, state.goPending, myF, state.virtualRounds || 1);
  for (let x = 0; x < lw; x++) for (let y = 0; y < lw; y++) {
    const b = base[x][y], p = projected[x][y];
    if (p === myF && b !== myF) {
      // 将蔓延/新生：青色虚拟格（与真实棋子明显区分）
      ctx.fillStyle = 'rgba(56,201,240,0.55)';
      ctx.fillRect(x + 0.12, y + 0.12, 0.76, 0.76);
      ctx.strokeStyle = 'rgba(125,230,255,0.95)';
      ctx.lineWidth = 0.05;
      ctx.strokeRect(x + 0.12, y + 0.12, 0.76, 0.76);
    } else if (b === myF && p !== myF) {
      // 将消失：红色✕（与 Q 预览一致语义，但仅针对我方）
      ctx.strokeStyle = 'rgba(255,107,107,0.9)';
      ctx.lineWidth = 0.08;
      ctx.beginPath();
      ctx.moveTo(x + 0.24, y + 0.24); ctx.lineTo(x + 0.76, y + 0.76);
      ctx.moveTo(x + 0.76, y + 0.24); ctx.lineTo(x + 0.24, y + 0.76);
      ctx.stroke();
    }
  }
}

// 在已 translate/scale 的世界坐标系内绘制演化预览覆盖层
let _previewFrames = 0;
function renderLifePreview(me) {
  const lw = state.world.lifeW || 32;
  const cell = WORLD / lw;
  const grid = state.world.lifeGrid;
  if (!grid || !grid.length) return;
  const owners = state.world.lifeOwners || [];
  let myF = 0;
  for (let i = 0; i < owners.length; i++) if (sameId(owners[i], me.id)) { myF = i + 1; break; }
  const myResist = ERA_RESIST[me.era || 0] || 1.0;
  const tick = state.world.tick || 0;
  _previewFrames++;
  // M8(R6)：Q 预览推演由"每帧 2 次全盘"降为 每 4 帧 / lifeGrid 变化 时一次；
  // 帧间直接复用缓存的"新生/死亡/脚下落子"ops 绘制，视觉不变、计算省 ~3/4。
  const needRecalc = !state._previewCache || state._previewCache.tick !== tick || (_previewFrames & 3) === 0;
  if (needRecalc) {
    const g = grid.map(col => Array.from(col));
    const next = simulateLifeStep(g, myF, myResist);
    const births = [], deaths = [];
    for (let x = 0; x < lw; x++) for (let y = 0; y < lw; y++) {
      const cur = g[x][y], nxt = next[x][y];
      if (cur === 0 && nxt !== 0) births.push([x, y]);
      else if (cur !== 0 && nxt === 0) deaths.push([x, y]);
    }
    // 脚下落子推演：若有种子，显示"若在此落子，下一步会怎样"
    let foot = null;
    if ((me.seeds || 0) > 0 && myF > 0) {
      const lx = Math.max(0, Math.min(lw - 1, Math.floor(me.x / LIFE_CELL)));
      const ly = Math.max(0, Math.min(lw - 1, Math.floor(me.y / LIFE_CELL)));
      const g2 = g.map(col => col.slice());
      g2[lx][ly] = myF;
      const next2 = simulateLifeStep(g2, myF, myResist);
      const survives = _isStrongCell(next2[lx][ly]) && _factionOfCell(next2[lx][ly]) === myF;
      let births2 = 0;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const nx = lx + dx, ny = ly + dy;
        if (nx < 0 || ny < 0 || nx >= lw || ny >= lw) continue;
        if (g2[nx][ny] === 0 && next2[nx][ny] !== 0) births2++;
      }
      foot = { lx, ly, survives, births: births2 };
    }
    state._previewCache = { tick, births, deaths, foot };
  }
  const pc = state._previewCache;
  // 1) 全场下一步：新生(绿填充) / 死亡(红叉)
  for (const [x, y] of pc.births) {
    ctx.fillStyle = 'rgba(63,185,80,0.45)';
    ctx.fillRect(x * cell, y * cell, cell, cell);
  }
  for (const [x, y] of pc.deaths) {
    ctx.strokeStyle = 'rgba(255,107,107,0.85)';
    ctx.lineWidth = 0.25;
    ctx.beginPath();
    ctx.moveTo(x * cell, y * cell); ctx.lineTo((x + 1) * cell, (y + 1) * cell);
    ctx.moveTo((x + 1) * cell, y * cell); ctx.lineTo(x * cell, (y + 1) * cell);
    ctx.stroke();
  }
  // 2) 脚下落子推演
  if (pc.foot) {
    const { lx, ly, survives, births } = pc.foot;
    ctx.fillStyle = survives ? 'rgba(255,212,121,0.5)' : 'rgba(255,107,107,0.5)';
    ctx.fillRect(lx * cell, ly * cell, cell, cell);
    ctx.strokeStyle = survives ? '#ffd479' : '#ff6b6b';
    ctx.lineWidth = 0.18;
    ctx.strokeRect(lx * cell, ly * cell, cell, cell);
    ctx.fillStyle = '#fff'; ctx.font = '0.8px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(survives ? '落子✓存活' : '落子✗将死', (lx + 0.5) * cell, (ly - 0.4) * cell);
    if (births > 0) ctx.fillText('+' + births + ' 新生', (lx + 0.5) * cell, (ly + 1.7) * cell);
  }
}

// ============== Canvas 渲染 ==============
const WORLD = 192;       // 世界放大 2x（96→192），与服务端 util.js 一致
const LIFE_CELL = WORLD / 32; // 6：一个生命格占 6x6 世界格
const RES_PX = 2;        // 资源层离屏烘焙：2px / 世界格 → 384×384 小画布
const REGION_SIZE = 24;     // matches server World.REGION_SIZE（随世界放大）
const REGION_W = 8;         // matches server World.REGION_W
// Per-type visual signature for the 14 emergent units.
const TYPE_VISUAL = {
  firefly:   { shape: 'star6',  color: '#ffd56b' },
  pulse:     { shape: 'ring',   color: '#9be7ff' },
  crystal:   { shape: 'hex',    color: '#cfd8ff' },
  feather:   { shape: 'tri',    color: '#e6c8ff' },
  ant:       { shape: 'dot3',   color: '#ff9e6a' },
  sandbeast: { shape: 'big',    color: '#c2a37b' },
  fire:      { shape: 'flame',  color: '#ff6b3d' },
  vine:      { shape: 'zig',    color: '#9ee37a' },
  guardian:  { shape: 'diamond',color: '#7aa3ff' },
  keystone:  { shape: 'square', color: '#d0d4ff' },
  crystalite:{ shape: 'oct',    color: '#ff7be0' },
  vein:      { shape: 'lines',  color: '#cfa56b' },
  ring:      { shape: 'ring',   color: '#b39bff' },
  equalizer: { shape: 'cross',  color: '#dadada' },
};
// 画布"后备缓冲"尺寸必须 = 容器 CSS 尺寸。否则浏览器会把画布拉伸/挤扁 → 地图错位。
// 全屏切换（F11）时，resize 事件常在**布局完成前**触发，拿到的还是旧尺寸 → 这就是"一全屏就飘"。
// 三重保险：① resize；② fullscreenchange；③ ResizeObserver（布局后触发）；④ render() 每帧自校正。
function syncCanvasSize() {
  const el = cv.parentElement;
  if (!el) return;
  const w = el.clientWidth, h = el.clientHeight;
  if (w > 0 && h > 0 && (cv.width !== w || cv.height !== h)) { cv.width = w; cv.height = h; }
}
function resize() { syncCanvasSize(); }
window.addEventListener('resize', resize);
document.addEventListener('fullscreenchange', resize);         // F11 / 全屏切换
document.addEventListener('webkitfullscreenchange', resize);   // 旧 WebKit
if (typeof ResizeObserver !== 'undefined') {
  try { new ResizeObserver(resize).observe(cv.parentElement); } catch (e) { /* 忽略 */ }
}

const TERRAIN_COLORS = {
  0: '#0a0d12', 1: '#2a4a2c', 2: '#1a3a1c', 3: '#1a3a5a', 4: '#3a3a3a', 5: '#5a4a2a',
};
const RESOURCE_COLORS = {
  1: '#d9a441', // 木
  2: '#b6bcc4', // 石
  3: '#ef8a3c', // 矿
  4: '#5ad1ff', // 水晶
  5: '#5fd068', // 食物
};
const RESOURCE_NAMES = { 1: '木', 2: '石', 3: '矿', 4: '晶', 5: '食' };

// 颜色 + alpha：把 'hsl(H,S%,L%)' / '#rrggbb' 都转成带 alpha 的合法颜色串。
// 之前 p.color + '50' 拼到 hsl 串尾是非法颜色 → addColorStop 抛错、fillStyle 静默失效
// （Voronoi/团块/生命格/区域描边全 0 透明，所以你看到的就是"地图啥都没画"）。
function withAlpha(col, a) {
  if (!col) return col;
  a = Math.max(0, Math.min(1, +a));
  if (col[0] === '#') {
    const hex = col.length === 4
      ? col.slice(1).split('').map(c => c + c).join('')
      : col.slice(1);
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
  }
  // hsl(H, S%, L%) / hsla(...) / rgba(...) / rgb(...)
  if (col.startsWith('hsl(')) {
    return col.replace(/^hsl\(/, 'hsla(').replace(/\)\s*$/, ',' + a + ')');
  }
  if (col.startsWith('rgb(')) {
    return col.replace(/^rgb\(/, 'rgba(').replace(/\)\s*$/, ',' + a + ')');
  }
  return col; // hsla/rgba 之类已有 alpha，理论上不会再拼
}

// 把地形字符串(每字符 0-5)烘焙成一张 WORLD×WORLD 离屏画布，逐帧一次 drawImage
function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function buildTerrainCanvas(str) {
  if (!str || str.length < WORLD * WORLD) return null;
  const c = document.createElement('canvas'); c.width = WORLD; c.height = WORLD;
  const g = c.getContext('2d');
  const img = g.createImageData(WORLD, WORLD);
  for (let i = 0; i < WORLD * WORLD; i++) {
    const t = +str[i]; const o = i * 4;
    if (!t) { img.data[o + 3] = 0; continue; }   // 透明 → 底色透出
    const [r, gg, b] = hexToRgb(TERRAIN_COLORS[t] || '#1a1d24');
    img.data[o] = r; img.data[o + 1] = gg; img.data[o + 2] = b; img.data[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

// M8(R1) 资源层离屏烘焙：把所有资源点画到 384×384（2px/世界格）小画布，逐帧一次
// drawImage（按视口源矩形裁剪）。
// F4（QA P2-2）失效指纹：原来只用 resPoints.length，前提是"资源只减不增"——这个前提
// 不成立：engine.addPlayer → _seedOnboarding 每次进人新增最多 5 个资源点，若同一窗口内
// 恰好被采走同样多的点，则长度不变但内容已变 → 画面残留已被采走的幽灵资源、新资源迟到。
// 因此指纹改为「点数 + 坐标校验和」，任何内容变化都能捕获。
function resourceFingerprint(resPts) {
  const len = resPts.length;
  let sum = len * 31;
  // 正常对局 ~2400 个点：全量累加（约 2.4k 次轻量运算/帧，<0.05ms）；
  // 只有极端超大数组才退化为抽样，保证帧预算。
  const step = len > 20000 ? 7 : 1;
  for (let i = 0; i < len; i += step) {
    const p = resPts[i];
    if (!p) continue;
    sum = (sum + (Number(p[0]) || 0) + (Number(p[1]) || 0) * 3 + (Number(p[2]) || 0) * 7) | 0;
  }
  return len + ':' + sum;
}
function bakeResources(resPts) {
  const c = document.createElement('canvas'); c.width = WORLD * RES_PX; c.height = WORLD * RES_PX;
  const g = c.getContext('2d');
  for (const [rx, ry, rt] of resPts) {
    if (typeof rx !== 'number' || typeof ry !== 'number' || rx < 0 || ry < 0 || rx >= WORLD || ry >= WORLD) continue; // 防御：坏点跳过
    const px = rx * RES_PX + RES_PX / 2, py = ry * RES_PX + RES_PX / 2;
    g.fillStyle = RESOURCE_COLORS[rt] || '#ccc';
    g.beginPath();
    g.moveTo(px, py - 1.2); g.lineTo(px + 1.2, py); g.lineTo(px, py + 1.2); g.lineTo(px - 1.2, py);
    g.closePath(); g.fill();
  }
  state._resCanvas = c;
  state._resFp = resourceFingerprint(resPts);
}

// ============== go（回合制 · 演化棋）渲染 ==============
// 只有一个棋盘：32×32 生命格铺满 canvas（≥90% 宽），黑白棋子 + 最后一手标记 +
// 悬停预览子。不画地形/资源/涌现单位/玩家头像/潮汐/纪元。
const GO_BOARD = 32;   // 与服务端 World.GO_BOARD_W 一致
function goViewTransform() {
  const w = cv.width, h = cv.height;
  const scale = Math.min(w / GO_BOARD, h / GO_BOARD);
  const cx = (w - GO_BOARD * scale) / 2;
  const cy = (h - GO_BOARD * scale) / 2;
  return { scale, cx, cy };
}
// go 模式：把「canvas 后备缓冲坐标」换算成「生命格坐标」。
// 这是 renderGo() 所用 goViewTransform 的**严格互逆**——之前点击/悬停误用 rts 的
// screenToWorld（玩家居中+缩放），与棋盘实际渲染错位，导致"鼠标位置 vs 落子位置怪怪的"。
// 现在点击和悬停都用它，落子格与渲染格 1:1 对应。返回浮点 fx/fy 便于悬停高亮用。
function goScreenToCell(sx, sy) {
  const lw = (state.world && state.world.lifeW) || GO_BOARD;
  const { scale, cx, cy } = goViewTransform();
  const fx = (sx - cx) / scale;
  const fy = (sy - cy) / scale;
  return { lx: Math.floor(fx), ly: Math.floor(fy), fx, fy };
}
function renderGo() {
  const w = cv.width, h = cv.height;
  const lw = (state.world && state.world.lifeW) || GO_BOARD;
  const { scale, cx, cy } = goViewTransform();
  ctx.save();
  ctx.fillStyle = '#0a0d12'; ctx.fillRect(0, 0, w, h);
  ctx.translate(cx, cy); ctx.scale(scale, scale);
  // 棋盘底色（木质/深色棋盘格）
  ctx.fillStyle = '#1a1f27';
  ctx.fillRect(0, 0, lw, lw);
  // 网格线
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.lineWidth = 1 / scale;
  for (let i = 0; i <= lw; i++) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, lw); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(lw, i); ctx.stroke();
  }
  // 星位（天元 + 四星）微标记，纯装饰
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  const star = Math.max(0, Math.floor(lw / 2));
  for (const [sx, sy] of [[star, star], [3, 3], [lw - 4, 3], [3, lw - 4], [lw - 4, lw - 4]]) {
    ctx.beginPath(); ctx.arc(sx + 0.5, sy + 0.5, 0.12, 0, Math.PI * 2); ctx.fill();
  }
  // FIX-3(a)：画布级"轮到你"强提示 —— 棋盘外圈高亮边框（轮到你=我方色实线；等待=暗色）。
  // 不用闪烁动画（避免视觉噪音）。
  {
    const gw = state.world && state.world.go;
    const uid = state.user && state.user.id;
    const myTurnNow = !!(gw && gw.turn != null && sameId(gw.turn, uid) && gw.phase !== 'over');
    const myF2 = goMyFaction();
    // 多方：我方颜色直接取 seats 里自己的席位（含玩家自身色），不再依赖黑白两方字段
    const mySeat = (gw && Array.isArray(gw.seats)) ? gw.seats.find(s => s.playerId != null && sameId(s.playerId, uid)) : null;
    const myColor = (mySeat && mySeat.color) || (myF2 ? goFactionColor(myF2) : null);
    ctx.lineWidth = 3 / scale;
    ctx.strokeStyle = gw && gw.phase === 'over'
      ? 'rgba(120,120,120,0.5)'
      : (myTurnNow ? (myColor || '#3fb950') : 'rgba(90,100,115,0.65)');
    ctx.strokeRect(0.5 / scale, 0.5 / scale, lw - 1 / scale, lw - 1 / scale);
  }
  const g = state.world && state.world.go;
  const grid = state.world && state.world.lifeGrid;
  const owners = (state.world && state.world.lifeOwners) || [];
  const pidMap = new Map((state.world.players || []).map(p => [String(p.id), p]));
  // FIX-4：势力底色（Voronoi）从 0x33 提到 0x55（明显但仍让棋子可读）；
  // 归属为 0（中立）的格子保持极淡网格，让玩家看出"哪些空地还没主"。
  const ownerOfF = (f) => {
    const pid = owners[f - 1];
    return pid != null ? pidMap.get(String(pid)) : null;
  };
  if (state.world.lifeOwner) {
    const owner = state.world.lifeOwner;
    for (let lx = 0; lx < lw; lx++) {
      const oc = owner[lx]; if (!oc) continue;
      for (let ly = 0; ly < lw; ly++) {
        const f = oc[ly]; if (!f) continue;
        const p = ownerOfF(f);
        // 有主的格子：阵营色 0x55 底（每格 0.5px 内缩，露出极淡缝隙 → 更易分辨棋盘格）
        ctx.fillStyle = p ? withAlpha(p.color, 0x55 / 0xff) : 'rgba(120,120,120,0.14)';
        ctx.fillRect(lx + 0.04, ly + 0.04, 0.92, 0.92);
      }
    }
    // FIX-4：额外描一遍**势力边界线**（核心："谁先拓展到哪片空地就归谁"的可视化）。
    // 扫描每格的 4 邻，若归属不同 → 在该格边缘画 1px（设备像素）高亮线，用该格所属阵营色。
    ctx.lineWidth = 1 / scale;
    for (let lx = 0; lx < lw; lx++) {
      const oc = owner[lx]; if (!oc) continue;
      for (let ly = 0; ly < lw; ly++) {
        const f = oc[ly]; if (!f) continue;
        const p = ownerOfF(f);
        ctx.strokeStyle = p ? withAlpha(p.color, 0.95) : 'rgba(150,150,150,0.7)';
        const up = ly > 0 ? (owner[lx][ly - 1] || 0) : 0;
        const dn = ly < lw - 1 ? (owner[lx][ly + 1] || 0) : 0;
        const lf = lx > 0 ? (owner[lx - 1][ly] || 0) : 0;
        const rt = lx < lw - 1 ? (owner[lx + 1][ly] || 0) : 0;
        ctx.beginPath();
        if (up !== f) { ctx.moveTo(lx, ly); ctx.lineTo(lx + 1, ly); }
        if (dn !== f) { ctx.moveTo(lx, ly + 1); ctx.lineTo(lx + 1, ly + 1); }
        if (lf !== f) { ctx.moveTo(lx, ly); ctx.lineTo(lx, ly + 1); }
        if (rt !== f) { ctx.moveTo(lx + 1, ly); ctx.lineTo(lx + 1, ly + 1); }
        ctx.stroke();
      }
    }
  }
  // 棋子：黑=深色实心圆，白=浅色实心圆（无强弱之分，只有 0/1/2 编码）
  if (grid) {
    for (let lx = 0; lx < lw; lx++) {
      const col = grid[lx]; if (!col) continue;
      for (let ly = 0; ly < lw; ly++) {
        const f = col[ly];
        if (!f) continue;
        const ccx = lx + 0.5, ccy = ly + 0.5;
        ctx.beginPath(); ctx.arc(ccx, ccy, 0.42, 0, Math.PI * 2);
        // 多方（1..8）：每方用自己玩家对象的颜色；回退到阵营色板（不再硬编码黑白）
        const col2 = goFactionColor(f);
        ctx.fillStyle = col2;
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 0.06;
        ctx.stroke();
      }
    }
  }
  // 待落子（本回合预选，尚未提交）：半透明幽灵子 + 序号
  // （左键点空格加入 / 左键点已有幽灵子取消那一颗 / 右键·Esc 撤销最后一颗）
  if (state.goPending && state.goPending.length) {
    const myF = goMyFaction();
    const gcol = myF ? goFactionColor(myF) : '#8b949e';
    state.goPending.forEach((p, i) => {
      ctx.globalAlpha = 0.5;
      ctx.beginPath(); ctx.arc(p.lx + 0.5, p.ly + 0.5, 0.42, 0, Math.PI * 2);
      ctx.fillStyle = gcol; ctx.fill();
      ctx.globalAlpha = 0.95;
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 0.08; ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#0b0f14';
      ctx.font = '0.5px system-ui,sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), p.lx + 0.5, p.ly + 0.54);
    });
  }
  // 演化预览（Q）：把本回合预选子也算进推演，看这批摆下去站不站得住
  if (state.previewMode) renderGoPreview();
  // 虚拟演化预览（青色虚拟格）：假设其余玩家停手，推演结束回合后 N 回合我方棋子变化
  if (state.virtualPreview) renderGoVirtualPreview();
  // 最后一手：金色描边脉冲
  if (g && g.lastMove) {
    const pulse = 0.5 + 0.5 * Math.abs(Math.sin(performance.now() / 500));
    ctx.strokeStyle = 'rgba(255,212,121,' + (0.45 + 0.5 * pulse) + ')';
    ctx.lineWidth = 0.12 / 1;
    ctx.strokeRect(g.lastMove.lx + 0.06, g.lastMove.ly + 0.06, 0.88, 0.88);
  }
  // 劫禁着：红圈提示
  if (g && g.ko) {
    ctx.strokeStyle = 'rgba(255,107,107,0.9)';
    ctx.lineWidth = 0.08;
    ctx.beginPath(); ctx.arc(g.ko.lx + 0.5, g.ko.ly + 0.5, 0.3, 0, Math.PI * 2); ctx.stroke();
  }
  // 悬停预览：用 goScreenToCell（与点击、与 renderGo 完全一致的换算），保证"鼠标在哪、预选子就在哪"。
  // 增强指示：合法格画半透明预览子 + 高亮边 + 行列辅助线 + 坐标标签；非法格画红叉 + 红框。
  if (state.mouse.has && g && g.phase !== 'over') {
    const c = goScreenToCell(state.mouse.sx, state.mouse.sy);
    const mlx = c.lx, mly = c.ly;
    if (mlx >= 0 && mly >= 0 && mlx < lw && mly < lw) {
      const occ = (grid && grid[mlx] && grid[mlx][mly])
        || (state.goPending && state.goPending.some(p => p.lx === mlx && p.ly === mly));
      const myF = goMyFaction();
      if (!occ) {
        // 行列辅助线（贯穿棋盘，明确"这一行/列"）
        ctx.strokeStyle = 'rgba(255,213,121,0.18)'; ctx.lineWidth = 1 / scale;
        ctx.beginPath();
        ctx.moveTo(mlx + 0.5, 0); ctx.lineTo(mlx + 0.5, lw);
        ctx.moveTo(0, mly + 0.5); ctx.lineTo(lw, mly + 0.5);
        ctx.stroke();
        // 预览子
        ctx.globalAlpha = 0.55;
        ctx.beginPath(); ctx.arc(mlx + 0.5, mly + 0.5, 0.42, 0, Math.PI * 2);
        ctx.fillStyle = myF ? goFactionColor(myF) : '#8b949e';
        ctx.fill(); ctx.globalAlpha = 1;
        // 高亮边（亮金，明显框住落点）
        ctx.strokeStyle = '#ffd479'; ctx.lineWidth = 0.09;
        ctx.strokeRect(mlx + 0.04, mly + 0.04, 0.92, 0.92);
        // 坐标标签
        ctx.fillStyle = '#fff'; ctx.font = '0.42px system-ui,sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillText(`${mlx},${mly}`, mlx + 0.5, mly - 0.05);
      } else {
        // 非法（已有子/预选/劫禁）：红叉 + 红框
        ctx.strokeStyle = 'rgba(255,107,107,0.9)'; ctx.lineWidth = 0.12;
        ctx.beginPath();
        ctx.moveTo(mlx + 0.18, mly + 0.18); ctx.lineTo(mlx + 0.82, mly + 0.82);
        ctx.moveTo(mlx + 0.82, mly + 0.18); ctx.lineTo(mlx + 0.18, mly + 0.82);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255,107,107,0.9)'; ctx.lineWidth = 0.08;
        ctx.strokeRect(mlx + 0.04, mly + 0.04, 0.92, 0.92);
      }
    }
  }
  // FIX-3(b)：非法落子留痕 —— 被拒后在该点画 ~1.2s 红叉 + 淡红圈（来自 state._goReject）。
  if (state._goReject) {
    const rj = state._goReject;
    const age = (performance.now() - rj.born) / 1200;
    if (age >= 1) { state._goReject = null; }
    else {
      const a = 1 - age;
      ctx.globalAlpha = a;
      // 淡红圈
      ctx.strokeStyle = 'rgba(255,107,107,0.85)';
      ctx.lineWidth = 0.1;
      ctx.beginPath(); ctx.arc(rj.lx + 0.5, rj.ly + 0.5, 0.34, 0, Math.PI * 2); ctx.stroke();
      // 红叉
      ctx.lineWidth = 0.13;
      ctx.strokeStyle = '#ff6b6b';
      ctx.beginPath();
      ctx.moveTo(rj.lx + 0.2, rj.ly + 0.2); ctx.lineTo(rj.lx + 0.8, rj.ly + 0.8);
      ctx.moveTo(rj.lx + 0.8, rj.ly + 0.2); ctx.lineTo(rj.lx + 0.2, rj.ly + 0.8);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
  ctx.restore();
  // 终局结算面板（画布上方的 DOM 覆盖层由 renderHud 处理）
}

function render() {
  syncCanvasSize();   // 每帧校正后备缓冲尺寸：全屏/窗口缩放/DOM 变化任何时刻都不会再错位
  if (state.showDebug) renderDebug();
  const w = cv.width, h = cv.height;
  ctx.fillStyle = '#0a0d12'; ctx.fillRect(0, 0, w, h);
  if (!state.world || !state.world.players) {
    ctx.fillStyle = '#8b949e'; ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('登录后开始游戏', w / 2, h / 2);
    return;
  }
  try {  // 渲染异常隔离：任何一帧出 bug 都显示错误而不是整图黑屏
  // go（回合制 · 演化棋）模式：只画一个棋盘，不渲染地形/资源/涌现单位/玩家头像/潮汐/纪元。
  if (isGo()) { renderGo(); return; }
  // 视口：以本地玩家为中心（与鼠标映射共用 viewTransform，含游戏内缩放）
  const me = findMe();
  const { scale, cx, cy } = viewTransform();
  // M8(R2) pid→player Map：帧内一次构建，Voronoi/lifeGrid/blob 三段所有按 id 找玩家
  // 都改用 Map.get（String(id) 归一），消除每格 O(玩家数) 的 players.find。
  const pidMap = new Map((state.world.players || []).map(p => [String(p.id), p]));
  ctx.save();
  ctx.translate(cx, cy); ctx.scale(scale, scale);
  // 地形（真实下发）：离屏缓存，逐帧一次 blit，避免 9216 次 fillRect；
  // 此前地形被其后不透明的棋盘格整个盖住 → 永远看不见。现已修。
  if (state.world.terrainStr && state._terrainStrRef !== state.world.terrainStr) {
    state._terrainCanvas = buildTerrainCanvas(state.world.terrainStr);
    state._terrainStrRef = state.world.terrainStr;
  }
  if (state._terrainCanvas) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(state._terrainCanvas, 0, 0, WORLD, WORLD);
  }
  // 细网格：廉价空间参照（替代原来会盖住地形的不透明棋盘格）
  ctx.strokeStyle = 'rgba(255,255,255,0.035)'; ctx.lineWidth = 1 / scale;
  for (let g = 0; g <= WORLD; g += 8) {
    ctx.beginPath(); ctx.moveTo(g, 0); ctx.lineTo(g, WORLD); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, g); ctx.lineTo(WORLD, g); ctx.stroke();
  }
  // Voronoi 势力场：用 lifeOwner 给每个生命格铺一层淡淡的本势力色，形成平滑、
  // 可争夺的边界（距最近强细胞 INFLUENCE_R 内才归属，超出为中立透明）。
  if (state.world.lifeOwner && state.world.lifeOwners) {
    const LW = state.world.lifeW || 32;
    const cell = WORLD / LW;
    const owners = state.world.lifeOwners;
    const owner = state.world.lifeOwner;
    for (let lx = 0; lx < LW; lx++) {
      const oc = owner[lx]; if (!oc) continue;
      for (let ly = 0; ly < LW; ly++) {
        const f = oc[ly]; if (!f) continue;        // 0 = 中立，透明
        const pid = owners[f - 1];
        const p = pid ? pidMap.get(String(pid)) : null;
        if (!p) continue;
        ctx.fillStyle = withAlpha(p.color, 0x22/0xff);            // 极淡底色，仅作领地暗示
        ctx.fillRect(lx * cell, ly * cell, cell, cell);
      }
    }
  }
  // Life board: draw living cells with their owner's color — this is the visible
  // Conway evolution. Each life cell is 3x3 world cells.
  if (state.world.lifeGrid && state.world.lifeOwners) {    const LW = state.world.lifeW || 32;
    const cell = WORLD / LW;   // world units per life cell
    const owners = state.world.lifeOwners;
    // 菌落团块：先按阵营汇总强细胞的质心与数量（只有强细胞=组织才算"肉"）。
    // M8(R3)：质心/渐变只在该 snap.tick 变化时重算一次并缓存（每帧不再重复扫盘）。
    const grid = state.world.lifeGrid;
    const curTick = state.world.tick || 0;
    if (!state._blobCache || state._blobCache.tick !== curTick) {
      const blobs = {};
      for (let lx = 0; lx < LW; lx++) { const col = grid[lx]; if (!col) continue;
        for (let ly = 0; ly < LW; ly++) { const v = col[ly]; if (!v || v > 10) continue;
          const b = blobs[v] || (blobs[v] = { x: 0, y: 0, n: 0 }); b.x += lx; b.y += ly; b.n++; } }
      const list = [];
      for (const f in blobs) {
        const b = blobs[f]; if (b.n < 5) continue;
        const pid = owners[Number(f) - 1];
        const p = pid ? pidMap.get(String(pid)) : null;
        if (!p) continue;
        const ax = (b.x / b.n + 0.5) * cell, ay = (b.y / b.n + 0.5) * cell;
        const rad = (1.3 + Math.sqrt(b.n) * 0.5) * cell;   // 半径 ∝ √细胞数：看得见"长肉"
        const gg = ctx.createRadialGradient(ax, ay, cell * 0.15, ax, ay, rad);
        gg.addColorStop(0, withAlpha(p.color, 0x50/0xff)); gg.addColorStop(1, withAlpha(p.color, 0));
        list.push({ ax, ay, rad, grad: gg });
      }
      state._blobCache = { tick: curTick, list };
    }
    for (const b of state._blobCache.list) {
      ctx.fillStyle = b.grad; ctx.beginPath(); ctx.arc(b.ax, b.ay, b.rad, 0, Math.PI * 2); ctx.fill();
    }
    for (let lx = 0; lx < LW; lx++) {
      const col = grid[lx];
      if (!col) continue;
      for (let ly = 0; ly < LW; ly++) {
        const f = col[ly];
        if (!f) continue;
        // 弱痕编码为 faction+10（11~18），强细胞为 faction(1~8) —— 用 _factionOfCell 还原
        const faction = _factionOfCell(f);
        const pid = owners[faction - 1];
        const p = pid ? pidMap.get(String(pid)) : null;
        // 强细胞更实、弱痕(原生汤)更淡，但都带本势力颜色（修复此前全变灰的 bug）
        const alpha = f > 10 ? '55' : 'aa';
        ctx.fillStyle = p ? withAlpha(p.color, f > 10 ? 0x55/0xff : 0xaa/0xff) : 'rgba(102,102,102,0.4)';
        ctx.fillRect(lx * cell, ly * cell, cell, cell);
        // 强细胞中心高亮一点 → "组织"一眼可辨
        if (f <= 8 && p) {
          ctx.fillStyle = withAlpha(p.color, 0xdd/0xff);
          ctx.beginPath(); ctx.arc(lx * cell + cell / 2, ly * cell + cell / 2, cell * 0.18, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
  }
  // 棋子攻击命中提示（rts）：lifeHits=[[lx,ly,dmg]]，服务端本 tick 里"棋子主动攻击相邻敌方
  // 细胞"的落点。在被啃的活细胞格上叠一层红色脉冲，dmg 越大越实 —— 让"我的细胞正在吃对面"
  // 一眼可见（弱痕被直接吞噬、强细胞累积伤害直至击碎）。
  if (Array.isArray(state.world.lifeHits) && state.world.lifeHits.length) {
    const LW = state.world.lifeW || 32;
    const cell = WORLD / LW;
    const pulse = 0.55 + 0.45 * Math.abs(Math.sin(performance.now() / 260));
    for (let i = 0; i < state.world.lifeHits.length; i++) {
      const hit = state.world.lifeHits[i];
      if (!hit || hit.length < 2) continue;
      const hx = hit[0] | 0, hy = hit[1] | 0;
      if (hx < 0 || hy < 0 || hx >= LW || hy >= LW) continue;
      const dmg = Number(hit[2]) || 1;
      const a = Math.min(0.9, 0.3 + dmg * 0.2) * pulse;
      const pad = cell * 0.08;
      ctx.fillStyle = 'rgba(255,90,90,' + a.toFixed(3) + ')';
      ctx.fillRect(hx * cell + pad, hy * cell + pad, cell - pad * 2, cell - pad * 2);
      ctx.strokeStyle = 'rgba(255,190,190,' + (a * 0.9).toFixed(3) + ')';
      ctx.lineWidth = Math.max(1, cell * 0.06);
      ctx.strokeRect(hx * cell + pad, hy * cell + pad, cell - pad * 2, cell - pad * 2);
    }
  }
  // 8x8 region ownership (faction id per region) — brighter outline for owned areas + 易手闪烁
  if (state.world.regionFaction && state.world.lifeOwners) {
    const owners = state.world.lifeOwners;
    const cur = state.world.regionFaction;
    // 检测归属变化 → 生成"易手闪光"（博弈感：看到疆界在打架）
    if (!state._prevRegion) state._prevRegion = cur.slice();
    for (let r = 0; r < cur.length; r++) {
      if (state._prevRegion[r] === cur[r]) continue;
      if (cur[r]) {
        const pid = owners[cur[r] - 1];
        const pp = pid ? pidMap.get(String(pid)) : null;
        if (pp) state._flashRegion.push({ r, color: pp.color, age: 0 });
      }
    }
    state._prevRegion = cur.slice();
    for (let i = state._flashRegion.length - 1; i >= 0; i--) {
      state._flashRegion[i].age++;
      if (state._flashRegion[i].age > 20) state._flashRegion.splice(i, 1);
    }
    for (let r = 0; r < cur.length; r++) {
      const f = cur[r];
      if (!f) continue;
      const pid = owners[f - 1];
      const p = pid ? pidMap.get(String(pid)) : null;
      if (!p) continue;
      const rx = (r % REGION_W) * REGION_SIZE;
      const ry = Math.floor(r / REGION_W) * REGION_SIZE;
      ctx.strokeStyle = withAlpha(p.color, 0x99/0xff);
      ctx.lineWidth = 2 / scale;
      ctx.strokeRect(rx, ry, REGION_SIZE, REGION_SIZE);
    }
    // 易手闪光：新主色脉冲描边
    for (const fl of state._flashRegion) {
      const t = 1 - fl.age / 20;
      const rx = (fl.r % REGION_W) * REGION_SIZE;
      const ry = Math.floor(fl.r / REGION_W) * REGION_SIZE;
      ctx.globalAlpha = t;
      ctx.strokeStyle = fl.color;
      ctx.lineWidth = (3 + t * 3) / scale;
      ctx.strokeRect(rx + t * 1.5, ry + t * 1.5, REGION_SIZE - t * 3, REGION_SIZE - t * 3);
      ctx.globalAlpha = 1;
    }
  }
  // 资源点：离屏烘焙后按视口源矩形一次 drawImage（M8/R1）。
  // F4：失效指纹 = 点数 + 坐标校验和（不再只用 length，见 bakeResources 上方说明）；
  // 另每 20 帧强制刷新一次兜底（对超长数组抽样的残余窗口）。
  if (state.world.resPoints) {
    const resPts = state.world.resPoints;
    const resFp = resourceFingerprint(resPts);
    state._frame = (state._frame || 0) + 1;
    if (!state._resCanvas || state._resFp !== resFp || state._frame % 20 === 0) {
      bakeResources(resPts);
    }
    if (state._resCanvas) {
      ctx.imageSmoothingEnabled = false;
      const rp = RES_PX;
      // 视口世界范围 → 烘焙画布源像素矩形（含 1 世界格余量）
      const sxl = Math.max(0, Math.floor((0 - cx) / scale) - 1);
      const sxr = Math.min(WORLD, Math.ceil((w - cx) / scale) + 1);
      const syl = Math.max(0, Math.floor((0 - cy) / scale) - 1);
      const syr = Math.min(WORLD, Math.ceil((h - cy) / scale) + 1);
      if (sxl < sxr && syl < syr) {
        ctx.drawImage(state._resCanvas, sxl * rp, syl * rp, (sxr - sxl) * rp, (syr - syl) * rp, sxl, syl, sxr - sxl, syr - syl);
      }
    }
  }
  // 康威演化预览叠加层（Q 开启）：在生命棋盘之上画出下一步演化
  if (state.previewMode && me) renderLifePreview(me);
  // 涌现单位（M8/R4：视口裁剪，名字/HP 条上飘约 1 格，边距给 6 世界格足够）
  if (state.world.entities) {
    const eminX = (0 - cx) / scale - 6, emaxX = (w - cx) / scale + 6;
    const eminY = (0 - cy) / scale - 6, emaxY = (h - cy) / scale + 6;
    for (const e of state.world.entities) {
      if (e.x < eminX || e.x > emaxX || e.y < eminY || e.y > emaxY) continue;
      const vis = TYPE_VISUAL[e.type] || { shape: 'dot', color: e.color || '#fff' };
      const col = e.color || vis.color;
      const sz = e.mass > 1 ? 0.7 : 0.4;
      // 敌对：红色描边；中立：纯色
      ctx.lineWidth = 0.12;
      if (e.faction === 'hostile') {
        ctx.fillStyle = col;
        drawShape(e.x, e.y, sz, vis.shape);
        ctx.strokeStyle = '#ff3050';
        ctx.strokeRect(e.x - sz - 0.05, e.y - sz - 0.05, (sz + 0.05) * 2, (sz + 0.05) * 2);
      } else {
        ctx.fillStyle = col;
        drawShape(e.x, e.y, sz, vis.shape);
      }
      // HP bar
      if (e.hp < e.hpMax) {
        ctx.fillStyle = '#400';
        ctx.fillRect(e.x - 0.4, e.y - 0.7, 0.8, 0.1);
        ctx.fillStyle = e.faction === 'hostile' ? '#f33' : '#0c0';
        ctx.fillRect(e.x - 0.4, e.y - 0.7, 0.8 * (e.hp / e.hpMax), 0.1);
      }
      // 名字（小）
      ctx.fillStyle = '#dde'; ctx.font = '0.5px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(e.name, e.x, e.y - 1);
    }
  }
  // 玩家
  for (const p of state.world.players) {
    const alive = p.alive !== false;
    if (alive) {
      const isAI = p.isAI === true;
      const isMe = (p === me) && !isSpectator();  // 观战时不再标"你"
      // 玩家身体：白色发光圆 + 颜色边
      ctx.shadowColor = isAI ? '#bbbbbb' : '#ffffff';
      ctx.shadowBlur = isAI ? 4 : 8;
      ctx.fillStyle = isAI ? '#cccccc' : '#fff';
      ctx.beginPath(); ctx.arc(p.x, p.y, 0.55, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = p.color || '#fff';
      ctx.lineWidth = 0.15;
      ctx.stroke();
      if (isMe) {
        // 自己：醒目的绿色光环，永远一眼认出"你在哪、是否居中"
        ctx.strokeStyle = '#3fb950'; ctx.lineWidth = 0.22;
        ctx.beginPath(); ctx.arc(p.x, p.y, 0.95, 0, Math.PI * 2); ctx.stroke();
      }
      if (isAI) {
        // AI 标识：齿轮小标
        ctx.fillStyle = '#888';
        ctx.font = '0.5px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('⚙', p.x + 0.55, p.y - 0.55);
      }
      if (p.vx || p.vy) {
        ctx.strokeStyle = p.color || '#fff';
        ctx.lineWidth = 0.12;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + p.vx * 2.5, p.y + p.vy * 2.5);
        ctx.stroke();
      }
      ctx.fillStyle = '#fff'; ctx.font = '0.55px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText((isMe ? '◉ 你 ' : '') + p.name + ' · ' + p.score, p.x, p.y - 0.95);
      ctx.fillStyle = '#400'; ctx.fillRect(p.x - 0.5, p.y + 0.6, 1, 0.12);
      ctx.fillStyle = '#0c0'; ctx.fillRect(p.x - 0.5, p.y + 0.6, 1 * (p.hp / p.hpMax), 0.12);
      if (p.dashCharge < 1) {
        ctx.fillStyle = '#224'; ctx.fillRect(p.x - 0.5, p.y + 0.78, 1, 0.06);
        ctx.fillStyle = '#58a6ff';
        ctx.fillRect(p.x - 0.5, p.y + 0.78, 1 * (1 - p.dashCooldown / 60), 0.06);
      } else {
        ctx.fillStyle = '#58a6ff';
        ctx.fillRect(p.x - 0.5, p.y + 0.78, 1, 0.06);
      }
    } else {
      ctx.fillStyle = '#555';
      ctx.font = '0.6px sans-serif'; ctx.textAlign = 'center';
      const sec = Math.ceil((p.respawnTicks || 0) / 20);
      ctx.fillText('☠ ' + p.name + ' 复活 ' + sec + 's', p.x, p.y);
    }
  }
  ctx.restore();
  // ---- 屏幕外玩家指示：其他玩家（含 AI）在视野外时，画布边缘画箭头 + 距离，
  //      解决"我的 AI 电脑玩家呢？"——放大视野后 AI 常常在屏幕外，靠这个一眼定位。----
  if (state.world && state.world.players && me) {
    const pad = 24;
    for (const p of state.world.players) {
      if (String(p.id) === String(me.id)) continue;
      const sx = cx + p.x * scale, sy = cy + p.y * scale;
      if (sx >= 0 && sy >= 0 && sx <= w && sy <= h) continue;   // 已在视野内
      const ang = Math.atan2(sy - h / 2, sx - w / 2);
      const cosA = Math.cos(ang), sinA = Math.sin(ang);
      const t = Math.min(Math.abs((w / 2 - pad) / (cosA || 1e-6)), Math.abs((h / 2 - pad) / (sinA || 1e-6)));
      const ex = w / 2 + cosA * t, ey = h / 2 + sinA * t;
      const dist = Math.round(Math.hypot(p.x - me.x, p.y - me.y));
      const col = p.isAI ? '#c9d1d9' : (p.color || '#58a6ff');
      ctx.save();
      ctx.translate(ex, ey); ctx.rotate(ang);
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.moveTo(10, 0); ctx.lineTo(-6, -6); ctx.lineTo(-6, 6); ctx.closePath(); ctx.fill();
      ctx.restore();
      if (p.alive !== false) {
        const lx = ex - cosA * 22, ly = ey - sinA * 22;
        const lbl = (p.isAI ? 'AI ' : '') + String(p.name).slice(0, 6) + '  ' + dist;
        ctx.font = '11px system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.85)'; ctx.strokeText(lbl, lx, ly);
        ctx.fillStyle = col; ctx.fillText(lbl, lx, ly);
      }
    }
  }
  // 鼠标准星
  if (state.mouse.has) {
    const mx = cx + state.mouse.wx * scale, my = cy + state.mouse.wy * scale;
    ctx.strokeStyle = state.mouse.down ? '#ff6b3d' : '#ffd56b';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(mx, my, 6, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(mx - 9, my); ctx.lineTo(mx + 9, my);
    ctx.moveTo(mx, my - 9); ctx.lineTo(mx, my + 9); ctx.stroke();
  }
  // 右键移动目标
  if (state.moveTarget) {
    const mx = cx + state.moveTarget.x * scale, my = cy + state.moveTarget.y * scale;
    ctx.strokeStyle = '#3fb950'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(mx, my, 5, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(mx - 7, my); ctx.lineTo(mx + 7, my);
    ctx.moveTo(mx, my - 7); ctx.lineTo(mx, my + 7); ctx.stroke();
  }
  // ---- 伤害飘字：对比相邻帧血量，谁掉血就在谁头顶飘 "-N"（攻击可见性）----
  if (state.world && state.world.players) {
    const cur = {};
    const tickHp = (o, pre) => {
      if (!o || o.id == null || o.hp == null) return;
      const k = pre + String(o.id); cur[k] = o.hp;
      const prev = state._prevHp && state._prevHp[k];
      if (prev != null && o.hp < prev) addFxFloat(o.x, o.y, '-' + Math.round(prev - o.hp), '#ff6b6b');
    };
    for (const p of state.world.players) tickHp(p, 'pl:');
    for (const e of (state.world.entities || [])) tickHp(e, 'en:');
    state._prevHp = cur;
  } else state._prevHp = null;
  // ---- FX 播放：涟漪（世界格）与飘字（屏幕像素）----
  const fxNow = performance.now();
  state.fx = state.fx.filter(f => fxNow - f.born < f.life);
  for (const f of state.fx) {
    const age = (fxNow - f.born) / f.life;
    const px = cx + f.x * scale, py = cy + f.y * scale;
    if (f.kind === 'ring') {
      const rr = (0.7 + age * 1.7) * (f.size || 1) * LIFE_CELL * scale;
      ctx.globalAlpha = (1 - age) * 0.85;
      ctx.strokeStyle = f.color; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(px, py, rr, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    } else {
      ctx.globalAlpha = 1 - age * age;
      ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'center';
      ctx.fillStyle = f.color || '#fff';
      ctx.fillText(f.text, px, py - age * 34);
      ctx.globalAlpha = 1;
    }
  }
  // 屏层：潮汐警告 / 死亡提示 / 胜利 / 失败
  renderOverlay();
  // 演化预览图例
  if (state.previewMode) {
    const msg = '演化预览 ON · 绿=下一步新生  红×=将死  金色格=脚下落子推演（再按 Q 关闭）';
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, cv.height - 22, cv.width, 22);
    ctx.fillStyle = '#ffd479';
    ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(msg, cv.width / 2, cv.height - 7);
  }
  // 按键绑定面板
  if (state.showKeys) renderKeyPanel();
  } catch (err) {
    console.error('render error', err);
    try {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#0a0d12'; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.fillStyle = '#ff6b6b'; ctx.font = '13px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('⚠ 渲染异常：' + (err && err.message), cv.width / 2, cv.height / 2 - 40);
      ctx.fillStyle = '#8b949e'; ctx.font = '12px sans-serif';
      ctx.fillText('请把上面红字发我 · 可先 F5 刷新试试', cv.width / 2, cv.height / 2 - 18);
    } catch (_) {}
  }
}

function drawShape(x, y, sz, shape) {
  ctx.save();
  ctx.translate(x, y);
  switch (shape) {
    case 'star6': { // 6角星
      ctx.beginPath();
      for (let i = 0; i < 12; i++) {
        const r = i & 1 ? sz * 0.4 : sz;
        const a = (i / 12) * Math.PI * 2;
        ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.closePath(); ctx.fill();
      break;
    }
    case 'ring': { // 同心圆环
      ctx.beginPath(); ctx.arc(0, 0, sz, 0, Math.PI * 2); ctx.fill();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath(); ctx.arc(0, 0, sz * 0.5, 0, Math.PI * 2); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      break;
    }
    case 'hex': { // 六边形
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const px = Math.cos(a) * sz, py = Math.sin(a) * sz;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath(); ctx.fill();
      break;
    }
    case 'tri': { // 三角
      ctx.beginPath();
      ctx.moveTo(0, -sz);
      ctx.lineTo(sz, sz);
      ctx.lineTo(-sz, sz);
      ctx.closePath(); ctx.fill();
      break;
    }
    case 'dot3': { // 三个小点（蚁群）
      ctx.beginPath(); ctx.arc(-sz * 0.6, 0, sz * 0.4, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(sz * 0.6, 0, sz * 0.4, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(0, sz * 0.4, sz * 0.4, 0, Math.PI * 2); ctx.fill();
      break;
    }
    case 'big': { // 大圆
      ctx.beginPath(); ctx.arc(0, 0, sz * 1.2, 0, Math.PI * 2); ctx.fill();
      break;
    }
    case 'flame': { // 火焰（用三角 + 拖尾）
      ctx.beginPath();
      ctx.moveTo(0, -sz);
      ctx.quadraticCurveTo(sz, 0, sz * 0.4, sz);
      ctx.quadraticCurveTo(0, sz * 1.3, -sz * 0.4, sz);
      ctx.quadraticCurveTo(-sz, 0, 0, -sz);
      ctx.fill();
      break;
    }
    case 'zig': { // 锯齿
      ctx.beginPath();
      ctx.moveTo(-sz, sz * 0.3);
      for (let i = 0; i < 4; i++) {
        ctx.lineTo((i & 1 ? 1 : -1) * sz, -sz + i * 0.3);
      }
      ctx.lineTo(sz, sz * 0.3);
      ctx.lineTo(-sz, sz * 0.3);
      ctx.closePath(); ctx.fill();
      break;
    }
    case 'diamond': { // 菱形
      ctx.beginPath();
      ctx.moveTo(0, -sz); ctx.lineTo(sz, 0); ctx.lineTo(0, sz); ctx.lineTo(-sz, 0);
      ctx.closePath(); ctx.fill();
      break;
    }
    case 'square': { // 方块
      ctx.fillRect(-sz, -sz, sz * 2, sz * 2);
      break;
    }
    case 'oct': { // 八面体
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const px = Math.cos(a) * sz, py = Math.sin(a) * sz;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath(); ctx.fill();
      break;
    }
    case 'lines': { // 等高线
      ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 0.1;
      for (let i = 1; i <= 3; i++) {
        ctx.beginPath(); ctx.arc(0, 0, sz * i / 3, 0, Math.PI * 2); ctx.stroke();
      }
      break;
    }
    case 'cross': { // 十字
      ctx.fillRect(-sz, -sz * 0.3, sz * 2, sz * 0.6);
      ctx.fillRect(-sz * 0.3, -sz, sz * 0.6, sz * 2);
      break;
    }
    default: { // dot
      ctx.beginPath(); ctx.arc(0, 0, sz, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.restore();
}

// ============== 战场特效（轻量 FX）==============
function addFxRing(x, y, color, sizeCells, life) { state.fx.push({ kind: 'ring', x, y, color, size: sizeCells || 1, born: performance.now(), life: life || 700 }); }
function addFxFloat(x, y, text, color) { state.fx.push({ kind: 'float', x, y, text, color, born: performance.now(), life: 1100 }); }

function renderOverlay() {
  const w = cv.width, h = cv.height;
  // 潮汐警告
  const t = state.world.tide;
  if (t && t.phase === 'surge' && t.ticksToNext < 40) {
    // 进入下一阶段倒计时
  }
  if (t && t.phase === 'prep' && t.ticksToNext < 60) {
    // 准备期即将结束，下一波潮汐
    const sec = Math.ceil(t.ticksToNext / 20);
    ctx.fillStyle = 'rgba(255,80,80,0.4)';
    ctx.fillRect(0, 0, w, 6);
    ctx.fillStyle = '#ff6b6b';
    ctx.font = 'bold 18px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('⚠ 下一波潮汐  ' + sec + 's', w / 2, 28);
  }
  // 死亡黑边
  const me = findMe();
  if (me && me.alive === false) {
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#ff6b6b';
    ctx.font = 'bold 32px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('☠ 倒下  ' + Math.ceil((me.respawnTicks || 0) / 20) + 's', w / 2, h / 2);
  }
  // 受伤红边
  if (me && me.hitFlash > 0) {
    ctx.strokeStyle = 'rgba(255,80,80,0.9)';
    ctx.lineWidth = 6;
    ctx.strokeRect(0, 0, w, h);
  }
  // 胜利/失败 → 顶部横幅 + 观战（不再整屏盖黑幕，场上战斗继续可见）
  if (me && (me.won || me.lost)) {
    ctx.fillStyle = 'rgba(0,0,0,0.78)';
    ctx.fillRect(0, 0, w, 76);
    const reason = me.won ? me.winReason : me.lostReason;
    const reasonText = { singularity: '算法奇点（6 资源全 30）', territory: '领土胜利（生态系统纪 + 16 区）', economy: '经济领先（生态纪领先600持续90s）', survival: '存活胜利（其他 3 方全部出局）', military: '12 次死亡出局' }[reason] || reason;
    ctx.textAlign = 'left';
    ctx.fillStyle = me.won ? '#3fb950' : '#ff6b6b';
    ctx.font = 'bold 22px sans-serif';
    ctx.fillText(me.won ? '🏆 胜利' : '💀 出局', 16, 30);
    ctx.fillStyle = '#aab'; ctx.font = '13px sans-serif';
    ctx.fillText('原因：' + reasonText + ' · 击杀 ' + me.kills + ' · 分数 ' + me.score + ' · 最高连击 ' + (me.maxCombo || 0), 16, 52);
    const t = camTarget();
    ctx.textAlign = 'right'; ctx.fillStyle = '#ffd56b'; ctx.font = 'bold 15px sans-serif';
    ctx.fillText('👁 观战：' + (t ? t.name : '—') + (t && t.score != null ? ' · ' + t.score + '分' : '') + '   按 C 切换视角', w - 16, 32);
  }
  // 中央连击大字
  if (me && me.combo >= 3) {
    ctx.fillStyle = me.combo >= 10 ? '#ff6b3d' : me.combo >= 5 ? '#ffd56b' : '#3fb950';
    ctx.font = 'bold 48px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(me.combo + 'x COMBO', w / 2, h * 0.35);
  }
}

// ============== HUD ==============
function renderKeyPanel() {
  const w = cv.width, h = cv.height;
  const lines = [
    '涌现之地 · 演化纪元  (按 ? 关闭)',
    '──────────────────────────',
    '🧬 你从单细胞开始，游动留下痕迹，',
    '   细胞会自行繁衍演化（能力自动解锁）',
    '',
    '── 演化路线 ──',
    '  单细胞(0-30s)：只能移动，约 30s 自动演化',
    '  多细胞：解锁 F 落子（种强细胞=组织）',
    '  动植物：捕食者出现，领地边界可争夺',
    '  生态系统：领土胜开放（占 16 区）',
    '',
    '── 胜利（任一）──',
    '  领土：生态系统纪 + 16 区（主路线）',
    '  奇点：6 资源全 30 · 经济：生态纪后领先600持续90s+10区',
    '  存活：其余 3 方谱系全部出局',
    '',
    '── 操作 ──',
    'WASD / 方向键       移动',
    'Shift + 移动方向     冲刺（3s 充能）',
    '鼠标左/右键         点地图移动',
    'F                   落子（多细胞后解锁，种 1 颗强细胞；单颗/2 颗相邻会被吞，≥3 连片或 2×2 才稳）',
    'Q                   演化预览（看下一步新生/死亡）',
    '?                   关闭本面板',
    '',
    '── 机制 ──',
    '⚙ 你+3个AI谱系从四角同步演化，用同一套生命棋盘规则',
    '⚙ 走过留弱痕；F 种 1 颗强细胞（要自己摆 ≥3 连片或 2×2 才稳，单颗/2 颗相邻会被吞）',
    '⚙ 棋子会主动攻击相邻敌方细胞：弱痕直接吞噬、强细胞累积伤害直至击碎',
    '⚙ 领地=最近强细胞的 Voronoi 归属，边界平滑可争夺',
    '⚙ 2×2 要塞=器官：双倍抗吞噬、持续加分、互连成帝国网(MST)',
    '⚙ 同时步+重入：FIFO 处理 = 延迟=惯性',
    '⚙ 涌现单位由算法催生，敌对=红框',
    '⚙ 潮汐：动植物纪起约每 50s 一波敌对从边缘涌入（持续 20s）',
    '',
    '── 战术 ──',
    '· 单细胞期先四处游动留痕，等演化提示（约30s）',
    '· 种子每 2.25 秒回 1 颗（最多 6）：落子要省着用、想好位置',
    '· 2x2 同色强细胞=要塞，先立好根据地再向外扩张',
    '· 按 Q 开预览：绿=将新生、红×=将死，落子前先推演',
    '· AI 会抢 Voronoi 边界：它贴脸时落子把边界推回去',
    '· 动植物纪后潮汐会掏家，扩张与防御要平衡',
  ];
  const pw = 480, ph = lines.length * 16 + 20;
  const px = Math.max(8, Math.floor((w - pw) / 2));
  const py = Math.max(8, Math.floor((h - ph) / 2));
  ctx.fillStyle = 'rgba(10,13,18,0.92)';
  ctx.fillRect(px, py, pw, ph);
  ctx.strokeStyle = '#58a6ff'; ctx.strokeRect(px, py, pw, ph);
  ctx.font = '12px sans-serif'; ctx.textAlign = 'left';
  lines.forEach((ln, i) => {
    let color = '#c9d1d9';
    if (i === 0) color = '#58a6ff';
    else if (ln.startsWith('── ')) color = '#d2a8ff';
    else if (ln.startsWith('🎯') || ln.startsWith('⚙')) color = '#ffd479';
    else if (ln.startsWith('·')) color = '#3fb950';
    ctx.fillStyle = color;
    ctx.fillText(ln, px + 12, py + 18 + i * 16);
  });
  ctx.textAlign = 'center';
}

const ERA_CN = { tribe: '单细胞', village: '多细胞', city: '动植物', empire: '生态系统' };
// Must mirror World.ERAS in server/engine.js (requirement to reach the NEXT era)。
// 真值（engine.js L853-858，20 TPS 换算）：
//   era0→1 village: ticks 600   (30s)    + cells 0   + regions 0
//   era1→2 city:    ticks 5400  (270s)   + cells 60  + regions 2
//   era2→3 empire:  ticks 64000 (3200s)  + cells 140 + regions 8
const ERA_REQ = [
  { cells: 0,   regions: 0, secs: 30 },
  { cells: 60,  regions: 2, secs: 270 },
  { cells: 140, regions: 8, secs: 3200 },
];
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Score display: always-visible score, era, territory and KDA on the canvas.
function renderScoreHud() {
  const el = $('score-hud');
  if (!el) return;
  if (!state.world) { el.style.display = 'none'; return; }
  const me = findMe();
  if (!me) { el.style.display = 'none'; return; }
  el.style.display = '';
  const eraCn = ERA_CN[me.eraName] || me.eraName || '单细胞';
  const oxic = !!(state.world && state.world.oxic);
  const LAD = ['单细胞', '多细胞', '动植物', '生态系'];
  const axis = LAD.map((s, i) => (i === (me.era || 0))
    ? `<b style="color:#ffd479">${s}</b>` : `<span class="dim">${s}</span>`).join(' → ');
  const kda = `${me.kills || 0}/${me.deaths || 0}/${me.assists || 0}`;
  const seeds = me.seeds || 0;
  // 引擎 SEED_MAX=6（engine.js L508）：最多画 6 格
  const seedDots = '●'.repeat(Math.min(seeds, 6)) + '○'.repeat(Math.max(0, 6 - seeds));
  el.innerHTML =
    `<span class="big">${me.score || 0}</span><span class="dim">分数</span><br>` +
    `大气 <b style="color:${oxic ? '#5ad1ff' : '#e0a04a'}">${oxic ? '☁ 有氧纪' : '☉ 无氧纪'}</b> · ` +
    `时代 <b>${eraCn}</b><br>` +
    `<span class="dim">演化轴</span> ${axis}<br>` +
    `领地 <b>${me.regionsOwned || 0}</b><span class="dim">/16</span> · 细胞 <b>${me.lifeCells || 0}</b><br>` +
    `要塞 <b>${me.strongholds || 0}</b> · KDA <b>${kda}</b><br>` +
    (me.network
      ? `帝国网 <b style="color:#5dd56a">已连成 ✓</b> <span class="dim">要塞互连·加分</span><br>`
      : `帝国网 <span class="dim">未连成（凑近 2x2 要塞即成网）</span><br>`) +
    `<span class="dim">种子</span> <b style="color:${seeds > 0 ? '#ffd479' : '#ff6b6b'}">${seedDots}</b> <span class="dim">（F 落子）</span>`;
}

// Leaderboard: everyone sorted by territory first (领土战争里地盘=主指标),
// showing a live race bar toward the 16-region territory win.
function renderScoreBoard() {
  const el = $('score-board');
  if (!el || !state.world) return;
  const ps = [...(state.world.players || [])].sort((a, b) => (b.regionsOwned || 0) - (a.regionsOwned || 0) || (b.score || 0) - (a.score || 0));
  el.innerHTML = ps.map((p, i) => {
    const isMe = sameId(p.id, state.user?.id);
    const kda = `${p.kills || 0}/${p.deaths || 0}/${p.assists || 0}`;
    const eraCn = ERA_CN[p.eraName] || p.eraName || '单细胞';
    const reg = Math.min(16, p.regionsOwned || 0);
    const regPct = Math.round((reg / 16) * 100);
    const isLeader = i === 0 && ps.length > 1;
    const row = `background:${isMe ? '#1f6feb22' : 'transparent'};border-radius:3px;padding:2px 4px;margin:2px 0;border-left:3px solid ${isLeader ? '#ffd479' : 'transparent'}`;
    return `<div class="stat" style="${row}">` +
      `<span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${escapeHtml(p.color)};margin-right:5px"></span>` +
      `${i + 1}. ${escapeHtml(p.name)}${p.isAI ? ' <span class="dim">AI</span>' : ''}` +
      `${p.network ? ' <span title="帝国网已连成" style="color:#5dd56a">◇网</span>' : ''}</span>` +
      `<b>${p.regionsOwned || 0}<span class="dim">/16区</span></b></div>` +
      `<div style="height:3px;background:#222;border-radius:2px;margin:0 6px 2px 14px"><div style="height:3px;border-radius:2px;background:${escapeHtml(p.color)};width:${regPct}%"></div></div>` +
      `<div class="stat" style="margin-left:15px"><span class="dim">${eraCn} · 分数 ${p.score || 0}</span>` +
      `<b class="dim">${kda}</b></div>`;
  }).join('');
}

// go 模式 HUD：手数 / 行动方 / 30s 倒计时 / 影响半径呼吸 / 世界事件 / 比分面板。
// 同时隐藏全部 rts 元素（资源、涌现、潮汐、纪元、要塞、KDA、rts 帮助面板、简报入口等）。
// FIX-2：hide 列表补全 —— 用 *-row 版本一次性把"标签 + 值"整体藏掉（标签文字在 <b> 之外）。
function setGoVisibility(on) {
  const hide = ['stock-list', 'emergent-list', 'res-list', 'win-list', 'tide-info', 'room-emergent',
    'score-board', 'room-lat', 'hud',
    'rts-help', 'room-tick-row', 'tide-row', 'emergent-row', 'stock-label', 'briefing-btn',
    // rts 侧的"机制=惯性"整行（go 模式语义不同）
    'room-lat-row',
    // rts 侧的"领土榜/胜利条件进度/资源/已涌现"标题文字（go 模式不该出现 rts 文案）
    'score-board-label', 'win-list-label', 'res-list-label', 'emergent-list-label'];
  // 注意：room-count-row / room-slots-row / seat-list **不隐藏** —— 多方对局里
  // "席位 3/6 · 2 人 + 1 电脑"对 go 同样有意义（用户要求自定义人数 + 电脑占席位）。
  for (const id of hide) {
    const el = $(id);
    if (!el) continue;
    el.style.display = on ? 'none' : '';
  }
  // FIX-2(d)：go 模式下 #go-help-btn 所在的 #go-rules 必须可见可点。
  // 大厅改为登出式面板后，#go-rules 可能在 #world-panel（已隐藏）里 —— 这里把它
  // 移进 #room-panel（go 模式下房间面板是可见的），确保 go 玩家有自己的帮助入口。
  const grules = $('go-rules');
  if (grules) {
    if (on) {
      const rp = $('room-panel');
      if (rp && grules.parentElement !== rp) rp.appendChild(grules);
      grules.style.display = '';
    } else {
      grules.style.display = 'none';
    }
  }
  // 重新显示 rts 元素时，#hud 需要恢复（它本就有内容）
  if (!on) { const hud = $('hud'); if (hud) hud.style.display = ''; }
}
function renderGoHud() {
  const goh = $('go-hud');
  const gres = $('go-res');
  if (!goh) return;
  setGoVisibility(true);
  // 隐藏 rts 的 score-hud（改用 go-res）
  const sh = $('score-hud'); if (sh) sh.style.display = 'none';
  const grules = $('go-rules'); if (grules) grules.style.display = '';
  const w = state.world;
  const g = w.go || {};
  const uid = state.user && state.user.id;
  const myF = goMyFaction();
  const myTurn = g.turn != null && sameId(g.turn, uid);
  // 倒计时保护（团队要求）：轮到我、剩 ≤2s、且本回合有预选 → 自动整批提交，
  // 抢在服务端 30s 超时自动 pass 之前落下，避免玩家草稿白下。提交后 goPending 清空，不会重复触发。
  // 无预选则不动（sec<=5 保持视觉警示）。
  if (myTurn && g.phase !== 'over' && Math.ceil((g.msLeft || 0) / 1000) <= 2
      && state.goPending && state.goPending.length > 0) {
    submitGoPending();
  }
  const sc = g.territory || { black: 0, white: 0 };
  // 中国规则数子（子数 + 围住空点）总分为主显示口径；Voronoi 目数仅作旧口径兼容。
  const cs = g.chineseScore || null;
  const csByPid = {};
  if (cs && Array.isArray(cs.ranked)) for (const r of cs.ranked) csByPid[String(r.playerId)] = r.score;
  // 多方（2..8）：直接用 go.seats 的每席数子分；兼容旧两方快照
  const seats = Array.isArray(g.seats) ? g.seats.slice() : [];
  if (seats.length) seats.sort((a, b) => {
    const av = (csByPid[String(a.playerId)] != null ? csByPid[String(a.playerId)] : (a.territory || 0));
    const bv = (csByPid[String(b.playerId)] != null ? csByPid[String(b.playerId)] : (b.territory || 0));
    return bv - av;
  });
  const scoreHtml = seats.length
    ? seats.map(s => {
        const me = s.playerId != null && sameId(s.playerId, uid);
        const dot = s.lost ? '✕' : (s.isTurn ? '▶' : '●');
        const val = (csByPid[String(s.playerId)] != null) ? csByPid[String(s.playerId)] : (s.territory || 0);
        return `<span style="white-space:nowrap${me ? ';text-decoration:underline' : ''}">`
          + `<span style="color:${s.color || goFactionColor(s.faction)}">${dot}</span> `
          + `${escapeHtml(s.name)}<b> ${val}</b>`
          + `${s.botControlled ? '<span class="dim">(代打)</span>' : (s.isAI ? '<span class="dim">(电脑)</span>' : '')}</span>`;
      }).join('<span class="dim"> · </span>')
    : `<span>● 黑 <b>${cs ? (cs.black || 0) : (sc.black || 0)}</b>子 · ○ 白 <b>${cs ? (cs.white || 0) : (sc.white || 0)}</b>子</span>`;
  const sec = Math.ceil((g.msLeft || 0) / 1000);
  const evCn = { calm: '平静', flourish: '繁盛（演化 ×2）', frost: '寒潮（暂停演化）', mutate: '拥挤突变（阈值 5）' }[g.event] || '平静';
  const phaseTxt = g.phase === 'over' ? '终局' : (myTurn ? '▶ 轮到你' : '等待对手…');
  // 一回合 0..N 颗：本回合预算 + 已预选数。点棋盘**只入预选**（不提交），
  // 点【结束回合】才生效 —— k>0 整批落下并演化；**k=0 = 不落子结束回合 = 停一手（pass）**。
  // 少于上限也能随时结束回合（无"必须摆满"校验）。倒计时 ≤2s 且 k>0 时保护性自动提交。
  const stoneBudget = goStonesPerTurn();
  const pendingN = state.goPending ? state.goPending.length : 0;
  // FIX-5：环形倒计时。按 msLeft/每手时限 推 stroke-dashoffset（CSS transition 由每帧重算保证平滑，
  // 不使用 requestAnimationFrame —— 本项目渲染是 setInterval(render, 50)）。
  // 时限由服务端下发（房主可配，默认 30000ms）；缺省回 30s。
  const GO_TURN_MS = (g.turnMs && g.turnMs > 0) ? g.turnMs : 30000;
  const msLeft = Math.max(0, g.msLeft || 0);
  const frac = g.phase === 'over' ? 0 : Math.min(1, msLeft / GO_TURN_MS);
  const ringR = 9, ringC = 2 * Math.PI * ringR;
  const ringOff = ringC * (1 - frac);
  const ringCol = sec <= 2 ? '#ff6b6b' : (sec <= 5 ? '#ffa94d' : '#58a6ff');
  const ringSvg =
    `<svg width="26" height="26" viewBox="0 0 26 26" style="vertical-align:middle">` +
      `<circle cx="13" cy="13" r="${ringR}" fill="none" stroke="#30363d" stroke-width="3"></circle>` +
      `<circle cx="13" cy="13" r="${ringR}" fill="none" stroke="${g.phase === 'over' ? '#30363d' : ringCol}" stroke-width="3"` +
        ` stroke-linecap="round" stroke-dasharray="${ringC.toFixed(1)}" stroke-dashoffset="${ringOff.toFixed(1)}"` +
        ` transform="rotate(-90 13 13)" style="transition:stroke-dashoffset .25s linear"></circle>` +
    `</svg>`;
  goh.style.display = 'flex';
  goh.innerHTML =
    `<span class="go-title">涌现之地 · 回合制</span>` +
    `<span>第 <b>${g.moveNo || 1}</b> / ${g.maxMoves || 150} 手</span>` +
    `<span class="go-turn">${phaseTxt}</span>` +
    `<span style="display:inline-flex;align-items:center;gap:5px">${ringSvg}` +
      `<b style="color:${sec <= 5 ? '#ff6b6b' : '#ffd479'}">${g.phase === 'over' ? '—' : sec + 's'}</b></span>` +
    `<span>事件 <b>${evCn}</b></span>` +
    `<span>本回合可落 <b>${stoneBudget}</b> 颗<span class="dim"> · 已预选 ${pendingN}</span></span>` +
    `<span style="margin-left:auto;display:inline-flex;gap:4px;flex-wrap:wrap;max-width:56%">${scoreHtml}</span>` +
    `<span class="go-actions">` +
      `<button id="go-end-turn">结束回合（${pendingN > 0 ? pendingN + '/' + stoneBudget : '不落子'}）<span class="key">Enter</span></button>` +
      `<button id="go-pass">停一手<span class="key">P</span></button>` +
      `<button id="go-resign" style="background:#7a2b2b;border-color:#7a2b2b;color:#fff">认输<span class="key">Ctrl+R</span></button>` +
      `<span style="display:inline-flex;align-items:center;gap:3px;margin-left:6px">` +
        `<button id="go-vprev" class="${state.virtualPreview ? 'on' : ''}" title="虚拟演化预览：假设其余玩家停手，推演结束回合后 N 回合我方棋子变化">` +
          `虚拟预览<span class="key">V</span></button>` +
        `<button id="go-vprev-minus" title="减少推演回数">−</button>` +
        `<b style="min-width:14px;text-align:center">${state.virtualRounds || 1}</b>` +
        `<button id="go-vprev-plus" title="增加推演回数（上限 8）">＋</button>` +
      `</span>` +
    `</span>`;
  // 绑定按钮（每帧重建 innerHTML，故每次重新绑定）
  // 【结束回合】**永远可点**：k=0 = 不落子结束回合（= 停一手 pass）；1..N 颗 = 整批落下（少于上限也行）。
  const bc = $('go-end-turn'); if (bc) bc.onclick = () => {
    if (g.phase === 'over') { toast('对局已结束'); return; }
    if (!myTurn) { toast('还没轮到你 · 等待对手'); return; }
    const k = state.goPending ? state.goPending.length : 0;
    submitGoPending();
    toast(k > 0 ? `已落下 ${k} 颗并结束回合` : '不落子结束回合（停一手）');
  };
  // Pass 与【结束回合】在 k=0 时行为**完全相同**（都发 {go:{pass:true}}）—— 保留它只因 Go 玩家熟悉"Pass"一词。
  const bp = $('go-pass'); if (bp) bp.onclick = () => {
    if (g.phase === 'over') { toast('对局已结束'); return; }
    if (!myTurn) { toast('还没轮到你 · 等待对手'); return; }
    sendIntent({ go: { pass: true } }); toast('已停一手（Pass）');
  };
  const br = $('go-resign'); if (br) br.onclick = () => { sendIntent({ go: { resign: true } }); toast('已认输'); };
  // 虚拟演化预览：开关 + 回数调整（默认开 / 1 回合 / 上限 8）
  const bvp = $('go-vprev'); if (bvp) bvp.onclick = () => {
    state.virtualPreview = !state.virtualPreview;
    toast(state.virtualPreview
      ? `虚拟演化预览 ON · 假设其余玩家停手，推演 ${state.virtualRounds || 1} 回合（青色=将蔓延/新生，红✕=将消失）`
      : '虚拟演化预览 OFF');
  };
  const bvpMinus = $('go-vprev-minus'); if (bvpMinus) bvpMinus.onclick = () => {
    state.virtualRounds = Math.max(1, (state.virtualRounds || 1) - 1);
    toast(`虚拟预览推演 ${state.virtualRounds} 回合`);
  };
  const bvpPlus = $('go-vprev-plus'); if (bvpPlus) bvpPlus.onclick = () => {
    state.virtualRounds = Math.min(8, (state.virtualRounds || 1) + 1);
    toast(`虚拟预览推演 ${state.virtualRounds} 回合`);
  };
  // 比分/结果面板
  if (gres) {
    gres.style.display = '';
    // 多方（2..8）：列出全部席位数子总分并标出自己；兼容旧两方快照
    let html = '';
    if (seats.length) {
      const mySeat = seats.find(s => s.playerId != null && sameId(s.playerId, uid));
      html = seats.map((s, i) => {
        const me = s.playerId != null && sameId(s.playerId, uid);
        const tag = s.lost ? '<span style="color:#ff6b6b">出局</span>'
          : (s.isTurn ? '<span style="color:#ffd479">行动中</span>' : '');
        const val = (csByPid[String(s.playerId)] != null) ? csByPid[String(s.playerId)] : (s.territory || 0);
        return `<div class="stat"><span>${i + 1}. ${me ? '▶ ' : ''}<span style="color:${s.color || goFactionColor(s.faction)}">●</span> ${escapeHtml(s.name)}${s.isAI ? '<span class="dim"> 电脑</span>' : (s.botControlled ? '<span class="dim"> 代打</span>' : '')}</span>`
          + `<b>${val} 子 ${tag}</b></div>`;
      }).join('');
      if (mySeat) {
        const myVal = (csByPid[String(mySeat.playerId)] != null) ? csByPid[String(mySeat.playerId)] : (mySeat.territory || 0);
        html = `<div class="stat"><span>你</span><b>第 ${seats.indexOf(mySeat) + 1} 名 · ${myVal} 子</b></div>` + html;
      }
    } else {
      const mine = myF === 1 ? (cs ? (cs.black || 0) : (sc.black || 0)) : (myF === 2 ? (cs ? (cs.white || 0) : (sc.white || 0)) : 0);
      const theirs = myF === 1 ? (cs ? (cs.white || 0) : (sc.white || 0)) : (myF === 2 ? (cs ? (cs.black || 0) : (sc.black || 0)) : 0);
      html = `<div class="stat"><span>你</span><b>${mine} 子</b></div>` +
        `<div class="stat"><span>对手</span><b>${theirs} 子</b></div>`;
    }
    html += `<div class="stat"><span>奖惩图案</span><b>${g.bonusSeen || 0}</b></div>`;
    if (g.result) {
      const win = g.result.winner != null && sameId(g.result.winner, uid);
      const draw = g.result.winner == null;
      html += `<div style="margin-top:6px;color:${draw ? '#ffd479' : (win ? '#3fb950' : '#ff6b6b')}">` +
        `<b>${draw ? '平局' : (win ? '你胜' : '你负')}</b> · ${({ pass: '双方停手（数子结算）', max_moves: '手数上限', wiped: '一方被吃光', timeout: '超时判负', resign: '认输', last_standing: '只剩一方' }[g.result.reason]) || g.result.reason}</div>`;
    }
    gres.innerHTML = html;
  }
  // 终局弹窗（一次）· 中国规则数子结算
  if (g.result && !state._goResultShown) {
    state._goResultShown = true;
    const win = g.result.winner != null && sameId(g.result.winner, uid);
    const draw = g.result.winner == null;
    const wn = g.result.winnerName || '对手';
    const reasonCn = ({ pass: '双方停手（连续 Pass）', max_moves: '达到手数上限', wiped: '一方被吃光', timeout: '累计超时', resign: '认输', last_standing: '只剩一方' }[g.result.reason]) || g.result.reason;
    // 中国规则数子口径：自己的子数 + 围住的空点数 = 总分（多者胜，不贴子）
    const cs = g.chineseScore || {};
    const rank = (g.result.ranked && g.result.ranked.length) ? g.result.ranked : null;
    const fmtRow = (r, i) => {
      const total = (r.score != null) ? r.score : (r.territory || 0);
      const stones = (r.stones != null) ? r.stones : '?';
      const empty = (r.empty != null) ? r.empty : '?';
      return `${i + 1}. ${escapeHtml(r.name)} <b>${total}</b> 子（子 ${stones} + 空点 ${empty}）`;
    };
    const rankTxt = rank
      ? rank.map(fmtRow).join('<br>')
      : `● 黑 ${cs.black != null ? cs.black : (sc.black || 0)} 子 &nbsp; ○ 白 ${cs.white != null ? cs.white : (sc.white || 0)} 子`;
    modal('对局结束 · 数子结算（' + reasonCn + '）', `
      <div style="font-size:14px;line-height:1.8">
        <div style="color:${draw ? '#ffd479' : (win ? '#3fb950' : '#ff6b6b')};font-weight:600;margin-bottom:6px">
          ${draw ? '平局（并列，不贴子）' : (win ? '🏆 你赢了' : '💀 你输了')}
        </div>
        <div style="color:#8b949e;font-size:12px;margin-bottom:4px">终局方式：${escapeHtml(reasonCn)} · 中国规则：子数 + 围住的空点</div>
        ${rankTxt}<br>
        ${!draw ? (win ? '获胜：' : '负于：') + escapeHtml(wn) : '并列，无唯一胜者'}<br>
        <span style="color:#8b949e;font-size:12px">手数 ${g.result.moves} · ${(g.bonusSeen || 0)} 次图案奖</span>
        <div style="margin-top:8px;color:#8b949e;font-size:12px">吃光对方不算赢——只体现为其子数与占空点变少；胜负由数子决定。</div>
        <div style="margin-top:4px;color:#8b949e;font-size:12px">seed + 手顺可完整复盘（同 seed 逐手一致）</div>
      </div>
    `);
  }
}

// 胜利条件常驻行：文本 = snapshot.settings.victoryLines（后端权威），全关时提醒。
function renderVictoryHud() {
  const el = $('victory-hud');
  if (!el) return;
  const s = (state.world && state.world.settings) || {};
  const mode = isGo() ? 'go' : 'rts';
  const txt = victoryLinesText(s.victoryLines, mode);
  const none = txt.indexOf('无（') === 0;
  el.innerHTML = `胜利条件：<b>${escapeHtml(txt)}</b>`;
  el.style.display = 'block';
  el.style.color = none ? '#ffa94d' : '#e6edf3';
}

// 棋盘形状常驻行：文本 = snapshot.settings.board（后端权威）。默认矩形时也可显示（标注"默认矩形"）。
function renderBoardHud() {
  const el = $('board-hud');
  if (!el) return;
  const s = (state.world && state.world.settings) || {};
  const mode = isGo() ? 'go' : 'rts';
  const txt = boardInfoText(s.board, mode);
  el.innerHTML = `棋盘：<b>${escapeHtml(txt)}</b>`;
  el.style.display = 'block';
}

function renderHud() {
  if (!state.world) return;
  // 胜利条件常驻行（rts 与 go 都显示；文本严格来自 snapshot.settings.victoryLines）
  renderVictoryHud();
  // 棋盘形状常驻行（rts 与 go 都显示；默认矩形也标注）
  renderBoardHud();
  // go（回合制）模式：隐藏全部 rts 元素，只显示 go 专用 HUD。
  if (isGo()) { renderGoHud(); return; }
  // rts 模式：确保 go 专用元素隐藏
  const goh = $('go-hud'); if (goh) goh.style.display = 'none';
  const gres = $('go-res'); if (gres) gres.style.display = 'none';
  const grules = $('go-rules'); if (grules) grules.style.display = 'none';
  $('room-tick').textContent = state.world.tick || 0;
  $('room-emergent').textContent = state.world.emergentCount || 0;
  // 席位：人类 + 电脑（电脑也占席位），上限取房主设定的席位数
  const cap = state.world.seatCap || state.world.maxPlayers || 8;
  const seatN = state.world.seatCount != null ? state.world.seatCount : (state.world.players || []).length;
  $('room-count').textContent = seatN + '/' + cap;
  // 拆成 真人 / 电脑（让人清楚还剩几个真人位）
  const ps = state.world.players || [];
  const humans = ps.filter(p => !p.isAI).length;
  const box = $('room-slots');
  if (box) box.textContent = humans + ' 人 + ' + (ps.length - humans) + ' 电脑';
  // 席位明细（含"电脑代打"标记）
  const sl = $('seat-list');
  if (sl) {
    sl.innerHTML = ps.length ? ps.map(p => {
      const me = state.user && String(p.id) === String(state.user.id);
      const tag = p.botControlled ? '<span style="color:#ffa94d">电脑代打</span>'
        : p.isAI ? '<span style="color:#8b949e">电脑</span>' : '<span style="color:#3fb950">人类</span>';
      return `<div class="stat"><span>${me ? '▶ ' : ''}${escapeHtml(p.name)}</span><b>${tag}</b></div>`;
    }).join('') : '<span style="color:#6e7681">还没有人就座</span>';
  }
  if ($('room-phase')) {
    $('room-phase').textContent = state.world.paused ? '进行中 · ⏸ 暂停'
      : (state.world.started ? '进行中' : '已就绪（未开始）');
  }
  if ($('lobby-pause')) $('lobby-pause').textContent = state.world.paused ? '恢复(房主)' : '暂停(房主)';
  if ($('room-lat')) $('room-lat').textContent = '惯性';
  if (state.roomCode) $('room-code').textContent = state.roomCode;
  // 资源
  const tech = state.world.tech || {};
  $('res-list').innerHTML = ['wood', 'stone', 'ore', 'crystal', 'food'].map(k => `<div class="stat"><span>${k}</span><b>${tech[k] || 0}</b></div>`).join('');
  // 涌现
  const ents = state.world.entities || [];
  $('emergent-list').innerHTML = ents.slice(0, 8).map(e => `<div class="emergent"><b>${escapeHtml(e.name)}</b> · hp ${e.hp}/${e.hpMax}${e.faction === 'hostile' ? ' · ⚠敌' : ''}${e.effect ? ` · <span style="color:#9aa4b2">${escapeHtml(e.effect)}</span>` : ''}</div>`).join('');
  // 6 资源 + 胜利条件
  updateHudTarget(ents);
  updateWinHud();
  renderScoreHud();
  renderScoreBoard();
}

function updateWinHud() {
  const me = state.world && state.world.players && findMe();
  if (!me) return;
  const stock = me.stock || { wood: 0, stone: 0, ore: 0, crystal: 0, food: 0, shard: 0 };
  const items = [
    { k: 'wood',    label: '木',   max: 30 },
    { k: 'stone',   label: '石',   max: 30 },
    { k: 'ore',     label: '矿',   max: 30 },
    { k: 'crystal', label: '水晶', max: 30 },
    { k: 'food',    label: '食物', max: 30 },
    { k: 'shard',   label: '碎片', max: 30 },
  ];
  const html = items.map(it => {
    const v = stock[it.k] || 0;
    const pct = Math.min(100, Math.round((v / it.max) * 100));
    return `<div class="stat"><span>${it.label}</span><b>${v}/${it.max}</b><div style="background:#222;height:3px;border-radius:2px;margin-top:2px"><div style="background:#3fb950;height:3px;border-radius:2px;width:${pct}%"></div></div></div>`;
  }).join('');
  $('stock-list').innerHTML = html;
  // 胜利条件进度
  const regOwn = me.regionsOwned || 0;
  const lead = me.scoreLeadTicks || 0;
  const leadSec = Math.floor(lead / 20);
  // 胜利条件进度（时代 = 成长，达到帝国才可能领土获胜）
  const eraIdx = me.era || 0;
  const req = ERA_REQ[eraIdx];
  const aliveSec = Math.floor((me.aliveTicks || 0) / 20);
  const items2 = [
    { l: '时代', v: (ERA_CN[me.eraName] || '单细胞') + ' ' + eraIdx + '/3' },
    { l: '领地', v: regOwn + '/16' + (eraIdx >= 3 ? ' 可胜' : ' 需生态纪') },
    // P2-13：展示"升下一时代"所需的区门槛（N 与上方 ERA_REQ 同一常量）
    { l: '区门槛', v: req ? (regOwn + ' / 需 ' + req.regions + ' 区') : (regOwn + '/16') },
    { l: '细胞峰值', v: (me.maxLifeCells || 0) + (req ? ' / ' + req.cells : ' 满级') },
    { l: '存活', v: aliveSec + 's' + (req ? ' / ' + req.secs + 's' : '') },
    { l: '经济领先', v: leadSec + '/90s' },
    { l: '死亡', v: me.deaths + '/12' },
  ];
  $('win-list').innerHTML = items2.map(it => `<div class="stat"><span>${it.l}</span><b>${it.v}</b></div>`).join('');
  // 潮汐
  const t = state.world.tide;
  if (t) {
    const sec = Math.ceil((t.ticksToNext || 0) / 20);
    const phaseName = t.phase === 'prep' ? '准备' : t.phase === 'surge' ? '⚠潮汐' : '休息';
    $('tide-info').textContent = phaseName + ' ' + sec + 's';
  }
}

// Real-time objective HUD: point the player at the nearest frontier worth
// contesting (unowned/enemy Voronoi ground near my own cells), the nearest
// rival faction, and any nearby threat/unit — so the land war reads at a glance.
function updateHudTarget(ents) {
  const hud = $('hud');
  if (!hud) return;
  const me = findMe();
  // 找不到自己（极少见）就显示通用提示，绝不回落到 AI 的位置算方向
  const self = me;
  if (!self) {
    hud.innerHTML = state.roomCode
      ? `房间 <b>${state.roomCode}</b> · 用 <kbd>WASD</kbd> 移动 · <kbd>F</kbd> 落子 · <kbd>?</kbd> 玩法指南`
      : `用 <kbd>WASD</kbd> 移动 · <kbd>F</kbd> 落子占地 · <kbd>?</kbd> 看玩法指南`;
    return;
  }
  // 观战模式：自己已胜利/出局 → 跟着被观看的玩家报实时状态
  if (me && (me.won || me.lost)) {
    const t = camTarget();
    const eraCn = t && ERA_CN ? (ERA_CN[t.eraName] || t.eraName || '') : '';
    hud.innerHTML = (me.won ? '🏆 <b>已胜利</b>' : '💀 <b>已出局</b>') +
      ` · 观看 <b style="color:${t ? escapeHtml(t.color) : '#fff'}">${t ? escapeHtml(t.name) : '—'}</b>` +
      (eraCn ? ' · ' + eraCn : '') +
      ` · ${t ? t.regionsOwned || 0 : 0}/16区 · ${t ? t.score || 0 : 0}分` +
      `<br><kbd>C</kbd> 切换视角 · 本局 ${me.kills || 0}杀/${me.score || 0}分 · <kbd>?</kbd> 玩法指南`;
    return;
  }
  const dirOf = (dx, dy) => {
    if (Math.abs(dx) * 2 < Math.abs(dy)) return dy < 0 ? '北' : '南';
    if (Math.abs(dy) * 2 < Math.abs(dx)) return dx < 0 ? '西' : '东';
    return (dy < 0 ? '北' : '南') + (dx < 0 ? '西' : '东');
  };
  const lines = [];
  // My faction id = index in lifeOwners (+1). lifeOwner is the Voronoi partition.
  // M9：id 类型安全（lifeOwners 里可能是 number/string），用 sameId 找下标。
  const world = state.world;
  const lifeOwners = world && world.lifeOwners;
  const myF = lifeOwners ? lifeOwners.findIndex(o => sameId(o, state.user && state.user.id)) + 1 : 0;
  const L = world && world.lifeOwner;
  // M7.2(P1-2) 早局引导：一颗强细胞都没有时，绝不显示"脚下全是自己地盘"
  const noStrongCells = (me.lifeCells || 0) === 0;
  const singleCellHint = '🧫 单细胞期：四处游动留痕积累能量，约 30s 后演化解锁 <kbd>F</kbd> 落子；站到资源上自动收集、靠近敌人自动开火';
  const organHint = '🧫 已解锁组织：按 <kbd>F</kbd> 在脚下种下 <b>1 颗强细胞</b>（单颗/2 颗相邻会消失，要 <b>≥3 连片或 2×2</b> 才稳）；影响范围随纪元变大，被打崩会退化';
  if (myF > 0 && L) {
    const W = world.lifeW || 32;
    const mlx = Math.floor(self.x / LIFE_CELL), mly = Math.floor(self.y / LIFE_CELL);
    let best = null, bd = 1e9, kind = '';
    // scan a window around the player for the nearest frontier cell: not mine,
    // but touching a cell that IS mine (that's where F converts ground).
    const R = 6;
    for (let dx = -R; dx <= R; dx++) {
      for (let dy = -R; dy <= R; dy++) {
        const x = mlx + dx, y = mly + dy;
        if (x < 0 || y < 0 || x >= W || y >= W) continue;
        if (L[x][y] === myF) continue;
        // must border my influence
        let touch = false;
        for (let a = -1; a <= 1 && !touch; a++) for (let b = -1; b <= 1 && !touch; b++) {
          const nx = x + a, ny = y + b;
          if (nx >= 0 && ny >= 0 && nx < W && ny < W && L[nx][ny] === myF) touch = true;
        }
        if (!touch) continue;
        const d = (x - mlx) ** 2 + (y - mly) ** 2;
        if (d < bd) { bd = d; best = [x, y]; kind = L[x][y] === 0 ? '无主' : '敌方'; }
      }
    }
    if (best) {
      const [bx, by] = best;
      const wxd = bx * LIFE_CELL + LIFE_CELL / 2 - self.x, wyd = by * LIFE_CELL + LIFE_CELL / 2 - self.y;
      const step = Math.max(1, Math.round(Math.hypot(wxd, wyd)));
      const arrow = dirOf(wxd, wyd);
      lines.push(`🗺 最近<b>${kind}</b>边界: <b>${arrow} ${step}格</b> · 走到后按 <kbd>F</kbd> 落子占下`);
    } else if (noStrongCells) {
      lines.push((me.era || 0) === 0 ? singleCellHint : organHint);
    } else {
      lines.push(`🗺 脚下全是自己地盘 · 朝远处扩张，找 <kbd>无主</kbd> 或 <kbd>敌方</kbd> 边界`);
    }
  } else if (L && noStrongCells) {
    // 刚出生还没留过痕（myF=0）：同样给早局引导而非空 HUD
    lines.push((me.era || 0) === 0 ? singleCellHint : organHint);
  }
  // nearest rival faction player (the actual "opponent pieces")
  let rival = null, rivalD = 1e9;
  for (const p of (world && world.players) || []) {
    if (!p || p.id === self.id || !p.alive) continue;
    const d = Math.hypot(p.x - self.x, p.y - self.y);
    if (d < rivalD) { rivalD = d; rival = p; }
  }
  if (rival) {
    const arrow = dirOf(rival.x - self.x, rival.y - self.y);
    lines.push(`⚔ 对手: <b style="color:${escapeHtml(rival.color)}">${escapeHtml(rival.name)}</b> · ${arrow} ${Math.round(rivalD)}格 · ${rival.regionsOwned || 0}区`);
  }
  // nearest emergent unit / hostile
  let nearE = null, nearED = 1e9;
  for (const e of ents) {
    const d = Math.hypot(e.x - self.x, e.y - self.y);
    if (d < nearED) { nearED = d; nearE = e; }
  }
  if (nearE && nearED < 20) {
    const arrow = dirOf(nearE.x - self.x, nearE.y - self.y);
    const threat = (nearE.faction && nearE.faction !== 'neutral') ? '⚠ 敌对' : '🟢 中立';
    lines.push(`${threat} 涌现单位: <b>${escapeHtml(nearE.name)}</b> · ${arrow} ${Math.round(nearED)}格 · 靠近自动攻击`);
  }
  // nearest resource (now actually drawn on the map as colored diamonds)
  const rps = world && world.resPoints;
  if (rps && rps.length) {
    let nearR = null, nearRD = 1e9, nearRT = 0;
    for (const [rx, ry, rt] of rps) {
      const d = Math.hypot(rx - self.x, ry - self.y);
      if (d < nearRD) { nearRD = d; nearR = [rx, ry]; nearRT = rt; }
    }
    if (nearR && nearRD < 30) {
      const arrow = dirOf(nearR[0] - self.x, nearR[1] - self.y);
      lines.push(`⛏ 最近资源(<b>${RESOURCE_NAMES[nearRT] || '?'}</b>): ${arrow} ${Math.round(nearRD)}格 · 走到即自动收集`);
    }
  }
  hud.innerHTML = lines.join('<br>');
}

// ============== 主循环 ==============
function inputToIntent() {
  // go（回合制）模式：没有移动，落子由点击处理；不发送任何移动意图。
  if (isGo()) { state.moveTarget = null; return; }
  // 出局/胜利后进入观战：不再发送任何移动意图
  if (isSpectator()) { state.moveTarget = null; return; }
  let dx = 0, dy = 0;
  if (state.keys.has('w') || state.keys.has('arrowup')) dy -= 1;
  if (state.keys.has('s') || state.keys.has('arrowdown')) dy += 1;
  if (state.keys.has('a') || state.keys.has('arrowleft')) dx -= 1;
  if (state.keys.has('d') || state.keys.has('arrowright')) dx += 1;
  // 右键移动目标：朝目标走（WASD 同时按住则覆盖）
  if (state.moveTarget && state.world) {
    const me = findMe();
    if (me) {
      const tx = state.moveTarget.x - me.x, ty = state.moveTarget.y - me.y;
      const dist = Math.hypot(tx, ty);
      // 到站即清除：玩家停在目标上，避免反复抖动
      if (dist < 1.0) {
        state.moveTarget = null;
      } else {
        const inv = dist ? 1 / dist : 0;
        const vx = me.vx || 0, vy = me.vy || 0;
        // 目标速度：远处全速(1.6)，进入 8 格刹车区后线性降到 0 —— 接近目标主动减速，
        // 靠"反向冲量"抵消惯性，杜绝绕圈(spinning)。
        const BRAKE = 8;
        const desired = dist > BRAKE ? 1.6 : 1.6 * (dist / BRAKE);
        const dvx = tx * inv * desired, dvy = ty * inv * desired;
        // 服务器把 move 冲量归一化为单位向量，故只能用"方向"控制：
        // 令冲量方向 = (期望速度 - 当前速度*0.85)/IMPULSE_MOVE，靠近目标时即反向刹车
        const jx = (dvx - vx * 0.85) / 0.6;
        const jy = (dvy - vy * 0.85) / 0.6;
        dx += jx; dy += jy;
      }
    }
  }
  if (dx || dy) sendIntent({ move: { dx, dy } });
}

// 发送节流（每 50ms 一次）
setInterval(inputToIntent, 50);
setInterval(render, 50);

function onLogin() {
  $('auth-panel').style.display = 'none';
  $('user-panel').style.display = 'block';
  $('world-panel').style.display = 'block';
  $('me-name').textContent = state.user.username;
  $('me-id').textContent = state.user.id;
  // 管理员入口：仅 role==='admin' 显示（新标签页打开独立管理页）
  const adminEntry = $('admin-entry');
  if (adminEntry) adminEntry.style.display = (state.user && state.user.role === 'admin') ? 'flex' : 'none';
  $('hud').innerHTML = '已登录 · <span style="color:#58a6ff">等简报…</span>';
  // 若通过他人分享的永久链接进入，登录后立即加入该房间
  const params = new URLSearchParams(location.search);
  const code = params.get('room');
  // URL ?mode=go（GO-19）：自动把模式下拉选中为"回合制"，便于邀请链接直达。
  const urlMode = params.get('mode');
  if (urlMode === 'go') {
    const sel = $('world-mode');
    if (sel) sel.value = 'go';
    state.mode = 'go';
  }
  // FIX-1：不再在登录时无条件弹 rts 简报（此时还不知道玩家要进 rts 还是 go）。
  // 若通过邀请链接进入，先加入房间；简报统一挪到"首个 snap 到达、模式已确定"后分流弹出
  // （见 ws.onmessage 的 snap 分支）。仅在无 worldId 的纯浏览状态才即时弹 rts 简报，保持旧行为。
  if (code) joinRoomByCode(code.toUpperCase());
  else if (!state.worldId) showBriefing(false);
}
function onLogout() {
  $('auth-panel').style.display = 'block';
  $('user-panel').style.display = 'none';
  $('world-panel').style.display = 'none';
  $('room-panel').style.display = 'none';
  $('chatbox').style.display = 'none';
  const adminEntry = $('admin-entry');
  if (adminEntry) adminEntry.style.display = 'none';
  $('hud').innerHTML = '单机：移动 · 收集资源 · 等待涌现单位<br>联机：开房 → 分享码 → 加入';
}

// 自动恢复登录
(function restore() {
  const tok = localStorage.getItem('algowild_token');
  const usr = localStorage.getItem('algowild_user');
  if (tok && usr) {
    state.token = tok;
    try { state.user = JSON.parse(usr); } catch {}
    // 先校验令牌是否仍有效（重新发布后旧令牌可能作废）→ 无效则 api() 已清令牌并回到登录面板。
    // 同时用服务端最新的 role 刷新本地 user（管理入口依赖 role）。
    api('GET', '/api/me').then((me) => {
      if (me && me.id) {
        state.user = { id: me.id, username: me.username, role: me.role };
        try { localStorage.setItem('algowild_user', JSON.stringify(state.user)); } catch {}
      }
      onLogin();
    }).catch(() => { /* api() 已处理 401；封禁(4004)等则停留登录页 */ });
  }
})();
resize();