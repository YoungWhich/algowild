// public/modes/_template.js — 新增模式的**前端视图骨架**（分形模板）。
//
// ⚠️ 惰性模板：文件名以 `_` 开头，公网注册表 public/modes/index.js **不 import 它**，故永不被加载。
//    复制它来创建新模式：`node scripts/new-mode.mjs <id> <Label> [boardMax] [boardDefault]`
//    会以本文件为模板生成 public/modes/<id>.js，并在 public/modes/index.js 的 MODES 追加一条。
//
// 契约（与 client.js 的 VIEWS 分派一致）：
//   export function create<Template>View(env) → { render, hud, input?: { onMouseDown } }
//   · env 由 client.js 注入：{ ctx, cv, state, $, toast, modal, escapeHtml, sameId, sendIntent, setModeVisibility }
//     —— 本模块**只读 env**，不反向 import client.js（避免循环依赖）。
//   · render()  在 60fps 主循环里被调用：绘制画布。
//   · hud()     每帧更新浮层 HUD（可写 DOM）。
//   · input.onMouseDown(e, { sx, sy, wld })  棋盘点击 → 发 intent。
//   · 后端把本模式快照切片固定注入到 snap 的 **.go** 字段 → 这里读 state.world.go。
//
// 新增模式还需在 **client.js** 里做最后一步接线（脚手架会在结束时打印提醒）：
//   import { create<Template>View } from './modes/<id>.js';
//   const VIEWS = { …, <id>: create<Template>View(VIEW_ENV) };

const TEMPLATE_N = 8;     // 与后端 World.TEMPLATE_SIZE 一致（兜底）
const TEMPLATE_WALL = 3;  // 容器内"墙"哨兵：与后端 World.TEMPLATE_WALL 一致

/**
 * 构造本模式视图（依赖注入工厂）。
 * @param {object} env client.js 注入的运行时依赖
 * @returns {{render:Function, hud:Function, input:{onMouseDown:Function}}}
 */
export function createTemplateView(env) {
  const { ctx, cv, state, $, toast, escapeHtml, sameId, sendIntent, setModeVisibility } = env;

  function slice() { return (state.world && state.world.go) || null; }
  function boardN() { const g = slice(); return (g && g.size) || TEMPLATE_N; }

  // 棋盘 → 画布 坐标变换（正方形棋盘，居中缩放）。点击换算严格与之互逆。
  function transform() {
    const N = boardN();
    const scale = Math.min(cv.width / N, cv.height / N) * (state.zoom || 1);
    const cx = (cv.width - N * scale) / 2;
    const cy = (cv.height - N * scale) / 2;
    return { scale, cx, cy };
  }
  function screenToCell(sx, sy) {
    const N = boardN();
    const { scale, cx, cy } = transform();
    const fx = (sx - cx) / scale, fy = (sy - cy) / scale;
    return { lx: Math.floor(fx), ly: Math.floor(fy), fx, fy };
  }

  /** 本机玩家在本模式的阵营号（0 = 观战/未就座）。 */
  function myFaction() {
    const g = slice();
    const uid = state.user && state.user.id;
    if (!g || uid == null) return 0;
    const hit = (g.seats || []).find((s) => sameId(s.playerId, uid));
    return hit ? hit.faction : 0;
  }

  // 主循环渲染：清屏 → 变换 → 画棋盘/棋子/墙 → 恢复。
  function render() {
    const N = boardN();
    const g = slice();
    const { scale, cx, cy } = transform();
    ctx.save();
    ctx.fillStyle = '#0a0d12'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.translate(cx, cy); ctx.scale(scale, scale);
    // 棋盘底 + 网格
    ctx.fillStyle = '#d7b07a'; ctx.fillRect(0, 0, N, N);
    ctx.strokeStyle = 'rgba(40,26,12,0.65)';
    ctx.lineWidth = Math.max(1 / scale, 0.02);
    for (let i = 0; i < N; i++) {
      ctx.beginPath(); ctx.moveTo(i + 0.5, 0.5); ctx.lineTo(i + 0.5, N - 0.5); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0.5, i + 0.5); ctx.lineTo(N - 0.5, i + 0.5); ctx.stroke();
    }
    // 棋子 + 墙（形状外 / 虚空）
    const board = g && g.board;
    if (board) {
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const v = board[y * N + x];
          if (v === TEMPLATE_WALL) {
            ctx.fillStyle = '#21262d'; ctx.fillRect(x, y, 1, 1);
          } else if (v === 1 || v === 2) {
            ctx.beginPath(); ctx.arc(x + 0.5, y + 0.5, 0.42, 0, Math.PI * 2);
            ctx.fillStyle = v === 1 ? '#111820' : '#eef2f7'; ctx.fill();
          }
        }
      }
    }
    ctx.restore();
  }

  // HUD：更新浮层文本。setModeVisibility(true) 会隐藏 rts 面板。
  function hud() {
    const goh = $('go-hud');
    if (!goh) return;
    setModeVisibility(true);
    const sh = $('score-hud'); if (sh) sh.style.display = 'none';
    const g = slice() || {};
    const uid = state.user && state.user.id;
    const N = boardN();
    const myTurn = g.turn != null && sameId(g.turn, uid);
    goh.style.display = 'flex';
    goh.innerHTML =
      `<span class="go-title">${escapeHtml(String(g.label || '新模式'))} · ${N}×${N}</span>` +
      `<span>第 <b>${(g.played || 0) + 1}</b> 手</span>` +
      `<span class="go-turn">${g.phase === 'over' ? '终局' : (myTurn ? '▶ 轮到你' : '等待对手…')}</span>` +
      `<span class="go-actions">` +
        `<button id="tpl-resign" style="background:#7a2b2b;border-color:#7a2b2b;color:#fff">认输</button>` +
      `</span>`;
    const br = $('tpl-resign');
    if (br) br.onclick = () => {
      if (g.phase === 'over') { toast('对局已结束'); return; }
      if (window.confirm('确定认输？本局将直接判负。')) { sendIntent({ template: { resign: true } }); toast('已认输'); }
    };
  }

  // 输入：左键点棋盘 → 立即发 intent。（go 模式用预选；棋盘类新模式通常直接落子。）
  function onMouseDown(e, pos) {
    if (e.button !== 0) return;
    const g = slice();
    if (!g) return;
    const N = boardN();
    const uid = state.user && state.user.id;
    if (g.phase === 'over') { toast('对局已结束'); return; }
    if (g.turn != null && !sameId(g.turn, uid)) { toast('还没轮到你 · 等待对手'); return; }
    const c = screenToCell(pos.sx, pos.sy);
    const x = c.lx, y = c.ly;
    if (x < 0 || y < 0 || x >= N || y >= N) return;
    const cellV = g.board ? g.board[y * N + x] : 0;
    if (cellV === TEMPLATE_WALL) { toast('此处不可落子（形状外 / 虚空）'); return; }
    if (cellV) { toast('此处已有棋子'); return; }
    sendIntent({ template: { lx: x, ly: y } });
  }

  return { render, hud, input: { onMouseDown } };
}

export default createTemplateView;
