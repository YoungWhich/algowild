// public/modes/gomoku.js — 五子棋（gomoku）前端视图（渲染 / 输入 / HUD 入口）。
//
// 由 public/modes/index.js 登记 kind，在 client.js 顶部 import 并由 VIEWS 分派。
// 采用"依赖注入工厂"：client.js 传入 env（ctx/cv/state/工具函数），本模块自包含，**不反向依赖 client.js**。
//
// 后端把本模式的快照切片注入到 snap 的 **.go** 字段（engine.snapshot() 的模式字段名固定为 go），
// 故这里统一读 state.world.go（含 size / board / turn / seats / result）。
//
// 约定：本模块只读 env，不修改 client.js 的主干状态机。落子走"点击棋盘 → 立即发 intent"（五子棋无预选）。

const GOMOKU_N = 15;    // 与后端 World.GOMOKU_SIZE 一致（兜底）
const GOMOKU_WALL = 99;  // 容器内"墙"哨兵（形状外/虚空，落在阵营号 1..8 之外）：与后端 World.GOMOKU_WALL 一致

/**
 * 构造五子棋视图。
 * @param {object} env { ctx, cv, state, $, toast, modal, escapeHtml, sameId, sendIntent, setModeVisibility }
 * @returns {{render:Function, hud:Function, input:{onMouseDown:Function}}}
 */
export function createGomokuView(env) {
  const { ctx, cv, state, $, toast, modal, escapeHtml, sameId, sendIntent, setModeVisibility } = env;

  function slice() { return (state.world && state.world.go) || null; }
  function boardN() { const g = slice(); return (g && g.size) || GOMOKU_N; }

  /** 是否正在输入框（聊天）中打字——此时不得劫持按键。 */
  function isTyping() {
    return typeof document !== 'undefined' && document.activeElement
      && document.activeElement.tagName === 'INPUT';
  }

  /** 认输（HUD 按钮与 R 键**共用**同一处理路径：确认后发 gomoku.resign 意图）。 */
  function resign() {
    const g = slice();
    if (g && g.phase === 'over') { toast('对局已结束'); return; }
    if (typeof window === 'undefined' || !window.confirm || window.confirm('确定认输？本局将直接判负。')) {
      sendIntent({ gomoku: { resign: true } });
      toast('已认输');
    }
  }

  /**
   * 键盘处理（由 client.js 的 keydown 按 VIEWS 表分派）。
   * 最小键位：R = 认输（与 HUD"认输"按钮同路径）。UI 模式下棋盘落子仍走鼠标点击，无 pass。
   * @returns {boolean} true = 已认领本次按键（client.js 应终止后续通用键位处理）
   */
  function onKeyDown(e) {
    if (!e || isTyping()) return false;
    const k = e.key ? e.key.toLowerCase() : '';
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

  function drawStone(x, y, f, scale) {
    const r = 0.42;
    ctx.beginPath();
    ctx.arc(x + 0.5, y + 0.5, r, 0, Math.PI * 2);
    if (f === 1) {
      const grd = ctx.createRadialGradient(x + 0.36, y + 0.36, 0.05, x + 0.5, y + 0.5, r);
      grd.addColorStop(0, '#6b7280'); grd.addColorStop(1, '#0b0f14');
      ctx.fillStyle = grd;
    } else {
      const grd = ctx.createRadialGradient(x + 0.36, y + 0.36, 0.05, x + 0.5, y + 0.5, r);
      grd.addColorStop(0, '#ffffff'); grd.addColorStop(1, '#c7ccd4');
      ctx.fillStyle = grd;
    }
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 0.04 / Math.max(scale, 0.001) * scale;
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
    ctx.fillStyle = '#d7b07a';
    ctx.fillRect(0, 0, N, N);
    // 网格线（棋盘线画在交叉点上）
    ctx.strokeStyle = 'rgba(40,26,12,0.65)';
    ctx.lineWidth = Math.max(1 / scale, 0.02);
    for (let i = 0; i < N; i++) {
      ctx.beginPath(); ctx.moveTo(i + 0.5, 0.5); ctx.lineTo(i + 0.5, N - 0.5); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0.5, i + 0.5); ctx.lineTo(N - 0.5, i + 0.5); ctx.stroke();
    }
    // 外框
    ctx.strokeStyle = 'rgba(40,26,12,0.9)';
    ctx.lineWidth = Math.max(2 / scale, 0.04);
    ctx.strokeRect(0.5, 0.5, N - 1, N - 1);
    // 星位（15×15 标准 5 个）
    ctx.fillStyle = 'rgba(30,18,8,0.85)';
    const star = [[3, 3], [11, 3], [7, 7], [3, 11], [11, 11]];
    for (const [sx, sy] of star) {
      if (sx < N && sy < N) { ctx.beginPath(); ctx.arc(sx + 0.5, sy + 0.5, 0.1, 0, Math.PI * 2); ctx.fill(); }
    }
    // 棋子 + 墙（形状外/虚空）
    const board = g && g.board;
    if (board) {
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const v = board[y * N + x];
          if (v === GOMOKU_WALL) {
            ctx.fillStyle = '#21262d';
            ctx.fillRect(x, y, 1, 1);
            ctx.strokeStyle = 'rgba(88,166,255,0.25)';
            ctx.lineWidth = Math.max(1 / scale, 0.02);
            ctx.strokeRect(x + 0.5, y + 0.5, 0, 0);
          } else if (v === 1 || v === 2) {
            drawStone(x, y, v, scale);
          }
        }
      }
    }
    // 最后一手：金色方框
    if (g && g.lastMove) {
      ctx.strokeStyle = '#ffd479';
      ctx.lineWidth = Math.max(2 / scale, 0.05);
      ctx.strokeRect(g.lastMove.x + 0.08, g.lastMove.y + 0.08, 0.84, 0.84);
    }
    // 悬停预览：空格 → 半透明我方子；墙 → 不预览
    if (state.mouse.has && g && g.phase !== 'over') {
      const c = screenToCell(state.mouse.sx, state.mouse.sy);
      if (c.lx >= 0 && c.ly >= 0 && c.lx < N && c.ly < N) {
        const cellV = board ? board[c.ly * N + c.lx] : 0;
        if (cellV === GOMOKU_WALL) {
          // 墙/虚空：不显示落子预览
        } else if (!cellV) {
          const myF = myFaction();
          ctx.globalAlpha = 0.45;
          ctx.beginPath(); ctx.arc(c.lx + 0.5, c.ly + 0.5, 0.42, 0, Math.PI * 2);
          ctx.fillStyle = myF === 2 ? '#ffffff' : '#111820';
          ctx.fill(); ctx.globalAlpha = 1;
        } else {
          ctx.strokeStyle = 'rgba(255,107,107,0.85)';
          ctx.lineWidth = Math.max(2 / scale, 0.05);
          ctx.strokeRect(c.lx + 0.08, c.ly + 0.08, 0.84, 0.84);
        }
      }
    }
    ctx.restore();
  }

  function myFaction() {
    const g = slice();
    const uid = state.user && state.user.id;
    if (!g || uid == null) return 0;
    const seats = g.seats || [];
    const hit = seats.find((s) => sameId(s.playerId, uid));
    if (hit) return hit.faction;
    return 0;
  }

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
    const seats = Array.isArray(g.seats) ? g.seats.slice() : [];
    const phaseTxt = g.phase === 'over' ? '终局' : (myTurn ? '▶ 轮到你' : '等待对手…');
    const seatHtml = seats.length
      ? seats.map((s) => {
        const me = s.playerId != null && sameId(s.playerId, uid);
        const dot = s.lost ? '✕' : (s.isTurn ? '▶' : '●');
        return `<span style="white-space:nowrap${me ? ';text-decoration:underline' : ''}">`
          + `<span style="color:${s.color || '#888'}">${dot}</span> ${escapeHtml(s.name)}`
          + `${s.isAI ? '<span class="dim">(电脑)</span>' : (s.botControlled ? '<span class="dim">(代打)</span>' : '')}</span>`;
      }).join('<span class="dim"> · </span>')
      : '<span class="dim">等待玩家就座</span>';

    goh.style.display = 'flex';
    goh.innerHTML =
      `<span class="go-title">五子棋 · ${N}×${N}</span>` +
      `<span>第 <b>${(g.moveNo || 0) + 1}</b> 手</span>` +
      `<span class="go-turn">${phaseTxt}</span>` +
      `<span>先连成 <b>5</b> 子者胜<span class="dim"> · 无禁手</span></span>` +
      `<span style="margin-left:auto;display:inline-flex;gap:4px;flex-wrap:wrap;max-width:56%">${seatHtml}</span>` +
      `<span class="go-actions">` +
        `<button id="gm-resign" style="background:#7a2b2b;border-color:#7a2b2b;color:#fff">认输</button>` +
      `</span>`;

    const br = $('gm-resign');
    if (br) br.onclick = () => resign();

    if (gres) {
      gres.style.display = '';
      const winnerName = g.result && g.result.winnerName ? g.result.winnerName : null;
      let html = '';
      if (seats.length) {
        html = seats.map((s, i) => {
          const me = s.playerId != null && sameId(s.playerId, uid);
          const tag = s.lost ? '<span style="color:#ff6b6b">认输</span>' : (s.isTurn ? '<span style="color:#ffd479">行动中</span>' : '');
          return `<div class="stat"><span>${i + 1}. ${me ? '▶ ' : ''}<span style="color:${s.color || '#888'}">●</span> ${escapeHtml(s.name)}</span><b>${tag}</b></div>`;
        }).join('');
      }
      html += `<div class="stat"><span>规则</span><b>${N}×${N} · 五连</b></div>`;
      if (g.result) {
        const win = g.result.winner != null && sameId(g.result.winner, uid);
        const draw = g.result.winner == null;
        const reasonCn = { five: '五连成线', resign: '对方认输', draw: '盘满平局', no_move: '无子可下' }[g.result.reason] || g.result.reason;
        html += `<div style="margin-top:6px;color:${draw ? '#ffd479' : (win ? '#3fb950' : '#ff6b6b')}">`
          + `<b>${draw ? '平局' : (win ? '你胜' : '你负')}</b> · ${escapeHtml(reasonCn)}</div>`;
      }
      gres.innerHTML = html;
    }

    // 终局弹窗（一次）
    if (g.result && !state._gomokuResultShown) {
      state._gomokuResultShown = true;
      const win = g.result.winner != null && sameId(g.result.winner, uid);
      const draw = g.result.winner == null;
      const reasonCn = { five: '五连成线', resign: '对方认输', draw: '盘满平局', no_move: '无子可下' }[g.result.reason] || g.result.reason;
      modal('五子棋 · 对局结束', `
        <div style="font-size:14px;line-height:1.9">
          <div style="color:${draw ? '#ffd479' : (win ? '#3fb950' : '#ff6b6b')};font-weight:600;margin-bottom:6px">
            ${draw ? '平局' : (win ? '🏆 你赢了' : '💀 你输了')}
          </div>
          <div style="color:#8b949e;font-size:12px">终局方式：${escapeHtml(reasonCn)} · 共 ${g.result.moves} 手</div>
          ${!draw ? `<div>${win ? '获胜：' : '负于：'}${escapeHtml(g.result.winnerName || '对手')}</div>` : ''}
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
    if (cellV === GOMOKU_WALL) { toast('此处不可落子（形状外 / 虚空）'); return; }
    if (cellV) { toast('此处已有棋子'); return; }
    sendIntent({ gomoku: { lx: x, ly: y } });
  }

  return { render, hud, input: { onMouseDown, onKeyDown } };
}

export default createGomokuView;
