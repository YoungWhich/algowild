// public/modes/weiqi.js — 标准围棋（weiqi）前端视图（渲染 / 输入 / HUD 入口）。
//
// 由 public/modes/index.js 登记 kind，在 client.js 顶部 import 并由 VIEWS 分派。
// 依赖注入工厂：client.js 传入 env，本模块自包含，**不反向依赖 client.js**。
//
// 后端把本模式快照切片注入到 snap 的 **.go** 字段（engine.snapshot() 的模式字段名固定为 go），
// 故统一读 state.world.go（含 size / board / turn / passes / ko / score / result / komi）。
//
// 交互：点击交叉点 → 立即落一子；另有「停一手(pass)」按钮；双方连续 pass → 终局数子。

const WEIQI_N = 19;    // 与后端 World.WEIQI_SIZE 一致（兜底）
const WEIQI_WALL = 99;  // 容器内"墙"哨兵（形状外/虚空，落在阵营号 1..8 之外）：与后端 World.WEIQI_WALL 一致

/**
 * 构造围棋视图。
 * @param {object} env { ctx, cv, state, $, toast, modal, escapeHtml, sameId, sendIntent, setModeVisibility }
 * @returns {{render:Function, hud:Function, input:{onMouseDown:Function}}}
 */
export function createWeiqiView(env) {
  const { ctx, cv, state, $, toast, modal, escapeHtml, sameId, sendIntent, setModeVisibility } = env;

  function slice() { return (state.world && state.world.go) || null; }
  function boardN() { const g = slice(); return (g && g.size) || WEIQI_N; }

  /** 是否正在输入框（聊天）中打字——此时不得劫持按键。 */
  function isTyping() {
    return typeof document !== 'undefined' && document.activeElement
      && document.activeElement.tagName === 'INPUT';
  }

  /** 停一手（pass）——HUD「停一手」按钮与 P 键**共用**同一处理路径。 */
  function passMove() {
    const g = slice();
    const uid = state.user && state.user.id;
    if (g && g.phase === 'over') { toast('对局已结束'); return; }
    if (g && g.turn != null && !sameId(g.turn, uid)) { toast('还没轮到你 · 等待对手'); return; }
    sendIntent({ weiqi: { pass: true } });
    toast('已停一手（Pass）');
  }

  /** 认输——HUD「认输」按钮与 R 键**共用**同一处理路径。 */
  function resign() {
    const g = slice();
    if (g && g.phase === 'over') { toast('对局已结束'); return; }
    if (typeof window === 'undefined' || !window.confirm || window.confirm('确定认输？本局将直接判负。')) {
      sendIntent({ weiqi: { resign: true } });
      toast('已认输');
    }
  }

  /**
   * 键盘处理（由 client.js 的 keydown 按 VIEWS 表分派）。
   * 最小键位：P = 停一手（pass）、R = 认输（均与各自 HUD 按钮同路径）。
   * @returns {boolean} true = 已认领本次按键（client.js 应终止后续通用键位处理）
   */
  function onKeyDown(e) {
    if (!e || isTyping()) return false;
    const k = e.key ? e.key.toLowerCase() : '';
    if (k === 'p') { if (e.preventDefault) e.preventDefault(); passMove(); return true; }
    if (k === 'r') { if (e.preventDefault) e.preventDefault(); resign(); return true; }
    return false;
  }

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

  function drawStone(x, y, f) {
    const r = 0.44;
    ctx.beginPath();
    ctx.arc(x + 0.5, y + 0.5, r, 0, Math.PI * 2);
    if (f === 1) {
      const grd = ctx.createRadialGradient(x + 0.34, y + 0.34, 0.06, x + 0.5, y + 0.5, r);
      grd.addColorStop(0, '#6b7280'); grd.addColorStop(1, '#05080b');
      ctx.fillStyle = grd;
    } else {
      const grd = ctx.createRadialGradient(x + 0.34, y + 0.34, 0.06, x + 0.5, y + 0.5, r);
      grd.addColorStop(0, '#ffffff'); grd.addColorStop(1, '#c7ccd4');
      ctx.fillStyle = grd;
    }
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 0.03;
    ctx.stroke();
  }

  function render() {
    const N = boardN();
    const g = slice();
    const w = cv.width, h = cv.height;
    const { scale, cx, cy } = transform();
    ctx.save();
    ctx.fillStyle = '#0a0d12'; ctx.fillRect(0, 0, w, h);
    ctx.translate(cx, cy); ctx.scale(scale, scale);
    // 棋盘（木色）
    ctx.fillStyle = '#d9b482';
    ctx.fillRect(0, 0, N, N);
    // 网格线
    ctx.strokeStyle = 'rgba(40,26,12,0.7)';
    ctx.lineWidth = Math.max(1 / scale, 0.02);
    for (let i = 0; i < N; i++) {
      ctx.beginPath(); ctx.moveTo(i + 0.5, 0.5); ctx.lineTo(i + 0.5, N - 0.5); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0.5, i + 0.5); ctx.lineTo(N - 0.5, i + 0.5); ctx.stroke();
    }
    // 外框
    ctx.strokeStyle = 'rgba(40,26,12,0.95)';
    ctx.lineWidth = Math.max(2 / scale, 0.05);
    ctx.strokeRect(0.5, 0.5, N - 1, N - 1);
    // 星位（19×19 标准 9 个）
    ctx.fillStyle = 'rgba(30,18,8,0.85)';
    for (const [sx, sy] of [[3, 3], [9, 3], [15, 3], [3, 9], [9, 9], [15, 9], [3, 15], [9, 15], [15, 15]]) {
      if (sx < N && sy < N) { ctx.beginPath(); ctx.arc(sx + 0.5, sy + 0.5, 0.09, 0, Math.PI * 2); ctx.fill(); }
    }
    // 棋子 + 墙（形状外/虚空）
    const board = g && g.board;
    if (board) {
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const v = board[y * N + x];
          if (v === WEIQI_WALL) {
            ctx.fillStyle = '#21262d';
            ctx.fillRect(x, y, 1, 1);
          } else if (v === 1 || v === 2) {
            drawStone(x, y, v);
          }
        }
      }
    }
    // 最后一手：金框
    if (g && g.lastMove) {
      ctx.strokeStyle = '#ffd479';
      ctx.lineWidth = Math.max(2 / scale, 0.06);
      ctx.strokeRect(g.lastMove.x + 0.1, g.lastMove.y + 0.1, 0.8, 0.8);
    }
    // 劫禁着：红圈
    if (g && g.ko) {
      ctx.strokeStyle = 'rgba(255,107,107,0.9)';
      ctx.lineWidth = Math.max(2 / scale, 0.06);
      ctx.beginPath(); ctx.arc(g.ko.x + 0.5, g.ko.y + 0.5, 0.3, 0, Math.PI * 2); ctx.stroke();
    }
    // 悬停预览（墙/虚空 → 不预览）
    if (state.mouse.has && g && g.phase !== 'over') {
      const c = screenToCell(state.mouse.sx, state.mouse.sy);
      if (c.lx >= 0 && c.ly >= 0 && c.lx < N && c.ly < N) {
        const cellV = board ? board[c.ly * N + c.lx] : 0;
        if (cellV === WEIQI_WALL) {
          // 墙/虚空：不显示落子预览
        } else {
          const myF = myFaction();
          if (!cellV) {
            ctx.globalAlpha = 0.45;
            ctx.beginPath(); ctx.arc(c.lx + 0.5, c.ly + 0.5, 0.44, 0, Math.PI * 2);
            ctx.fillStyle = myF === 2 ? '#ffffff' : '#111820';
            ctx.fill(); ctx.globalAlpha = 1;
          }
          ctx.strokeStyle = '#ffd479';
          ctx.lineWidth = Math.max(2 / scale, 0.05);
          ctx.strokeRect(c.lx + 0.06, c.ly + 0.06, 0.88, 0.88);
        }
      }
    }
    ctx.restore();
  }

  function myFaction() {
    const g = slice();
    const uid = state.user && state.user.id;
    if (!g || uid == null) return 0;
    const hit = (g.seats || []).find((s) => sameId(s.playerId, uid));
    return hit ? hit.faction : 0;
  }

  function fmtScore(v) { return (Math.round(v * 2) / 2).toString(); }

  function hud() {
    const goh = $('go-hud'), gres = $('go-res');
    if (!goh) return;
    setModeVisibility(true);
    const sh = $('score-hud'); if (sh) sh.style.display = 'none';
    const w = state.world;
    const g = (w && w.go) || {};
    const N = boardN();
    const uid = state.user && state.user.id;
    const myTurn = g.turn != null && sameId(g.turn, uid);
    const seats = Array.isArray(g.seats) ? g.seats : [];
    const phaseTxt = g.phase === 'over' ? '终局' : (myTurn ? '▶ 轮到你' : '等待对手…');
    const score = g.score || {};
    const seatHtml = seats.length
      ? seats.map((s) => {
        const me = s.playerId != null && sameId(s.playerId, uid);
        const dot = s.lost ? '✕' : (s.isTurn ? '▶' : '●');
        const val = (s.score != null) ? fmtScore(s.score) : '—';
        return `<span style="white-space:nowrap${me ? ';text-decoration:underline' : ''}">`
          + `<span style="color:${s.color || '#888'}">${dot}</span> ${escapeHtml(s.name)}<b> ${val}</b>`
          + `${s.isAI ? '<span class="dim">(电脑)</span>' : (s.botControlled ? '<span class="dim">(代打)</span>' : '')}</span>`;
      }).join('<span class="dim"> · </span>')
      : '<span class="dim">等待玩家就座</span>';

    goh.style.display = 'flex';
    goh.innerHTML =
      `<span class="go-title">标准围棋 · ${N}×${N}</span>` +
      `<span>第 <b>${g.moveNo || 0}</b> 手</span>` +
      `<span class="go-turn">${phaseTxt}</span>` +
      `<span>中国规则数子 · 贴目 <b>${g.komi != null ? g.komi : 7.5}</b></span>` +
      `<span>连续停手 <b>${g.passes || 0}</b>/2</span>` +
      `<span style="margin-left:auto;display:inline-flex;gap:4px;flex-wrap:wrap;max-width:52%">${seatHtml}</span>` +
      `<span class="go-actions">` +
        `<button id="wq-pass">停一手<span class="key">P</span></button>` +
        `<button id="wq-resign" style="background:#7a2b2b;border-color:#7a2b2b;color:#fff">认输</button>` +
      `</span>`;

    const bp = $('wq-pass');
    if (bp) bp.onclick = () => passMove();
    const br = $('wq-resign');
    if (br) br.onclick = () => resign();

    if (gres) {
      gres.style.display = '';
      let html = '';
      html += `<div class="stat"><span>黑（子 + 空点）</span><b>${fmtScore(score.black != null ? score.black : 0)}</b></div>`;
      html += `<div class="stat"><span>白（子 + 空点 + 贴目）</span><b>${fmtScore(score.white != null ? score.white : 0)}</b></div>`;
      html += `<div class="stat"><span>贴目</span><b>${g.komi != null ? g.komi : 7.5}</b></div>`;
      html += `<div class="stat"><span>提子（黑/白）</span><b>${(g.captured && g.captured.black) || 0}/${(g.captured && g.captured.white) || 0}</b></div>`;
      if (g.result) {
        const win = g.result.winner != null && sameId(g.result.winner, uid);
        const draw = g.result.winner == null;
        const reasonCn = { pass: '双方停手（数子）', resign: '对方认输' }[g.result.reason] || g.result.reason;
        html += `<div style="margin-top:6px;color:${draw ? '#ffd479' : (win ? '#3fb950' : '#ff6b6b')}">`
          + `<b>${draw ? '平局' : (win ? '你胜' : '你负')}</b> · ${escapeHtml(reasonCn)}</div>`;
      }
      gres.innerHTML = html;
    }

    // 终局弹窗（一次）· 中国规则数子
    if (g.result && !state._weiqiResultShown) {
      state._weiqiResultShown = true;
      const win = g.result.winner != null && sameId(g.result.winner, uid);
      const draw = g.result.winner == null;
      const reasonCn = { pass: '双方停手（数子）', resign: '对方认输' }[g.result.reason] || g.result.reason;
      modal('围棋 · 对局结束', `
        <div style="font-size:14px;line-height:1.9">
          <div style="color:${draw ? '#ffd479' : (win ? '#3fb950' : '#ff6b6b')};font-weight:600;margin-bottom:6px">
            ${draw ? '平局（分差 0）' : (win ? '🏆 你赢了' : '💀 你输了')}
          </div>
          <div style="color:#8b949e;font-size:12px;margin-bottom:4px">终局方式：${escapeHtml(reasonCn)} · 中国规则：子数 + 围住空点</div>
          <div>黑 <b>${fmtScore(g.result.black)}</b> （子 ${g.result.blackStones} + 空 ${g.result.blackTerr}）</div>
          <div>白 <b>${fmtScore(g.result.white)}</b> （子 ${g.result.whiteStones} + 空 ${g.result.whiteTerr} + 贴目 ${g.result.komi}）</div>
          ${!draw ? `<div style="margin-top:4px">${win ? '获胜：' : '负于：'}${escapeHtml(g.result.winnerName || '对手')}</div>` : ''}
          <div style="margin-top:6px;color:#8b949e;font-size:12px">手数 ${g.result.moves} · 无演化（纯围棋规则）</div>
        </div>
      `);
    }
  }

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
    if (cellV === WEIQI_WALL) { toast('此处不可落子（形状外 / 虚空）'); return; }
    if (cellV) { toast('此处已有棋子'); return; }
    if (g.ko && g.ko.x === x && g.ko.y === y) { toast('劫禁着 · 先在他处应一手'); return; }
    sendIntent({ weiqi: { lx: x, ly: y } });
  }

  return { render, hud, input: { onMouseDown, onKeyDown } };
}

export default createWeiqiView;
