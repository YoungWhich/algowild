// server/net.js — WebSocket hub：12 个消息类型 + 延迟=惯性物理
import { WebSocketServer } from 'ws';
import { verifyToken, isBanActive } from './auth.js';
import { usersRepo } from './db/index.js';
import { activeWorlds } from './worldhub.js';
import { roomHub } from './rooms.js';
import { IntentQueue } from './intents.js';

// M1 单一 tick 归属：记录"由 WS 循环驱动"的 worldId。
// server/index.js 的后台 ticker 会跳过这些世界，只有无任何 WS 客户端的
// AI 世界仍由 index.js 驱动——彻底消除双 tick（原实机 ~32 tick/s、snap tick 差=2）。
export const netManaged = new Set();
// M3 断线宽限：玩家断开后其角色与领土保留这段时间；期内重新 hello（同 uid）即续用。
const GRACE_MS = 15000;

// WS 消息类型
const T = {
  HELLO: 'hello',           // C→S 鉴权
  WELCOME: 'welcome',       // S→C 接收
  SNAP: 'snap',             // S→C 世界摘要
  INTENT: 'intent',         // C→S 玩家指令
  ENTITY: 'entity',         // S→C 涌现事件
  EVENT: 'event',           // S→C 世界事件
  CHAT: 'chat',             // C↔S 文本
  HEARTBEAT: 'heartbeat',   // C↔S 心跳
  PONG: 'pong',             // S→C 心跳回包
  JOIN: 'join',             // C→S 加入房间
  LEAVE: 'leave',           // C→S 离开
  ERROR: 'error',           // S→C 错误
};

// WS close 码
const CLOSE = {
  AUTH_FAIL: 4001,
  KICKED: 4002,
  HEARTBEAT_TIMEOUT: 4003,
  ROOM_CLOSED: 4004,
  BANNED: 4004,   // 与 ROOM_CLOSED 同值：均为"强制离线"，客户端按 4004 统一处理
};

// 错误码
const ERR = {
  BAD_AUTH: 2001,
  BAD_INTENT: 2002,
  WORLD_NOT_FOUND: 2003,
  RATE_LIMIT: 2004,
  FORBIDDEN: 2005,
  PAYLOAD_TOO_BIG: 2006,
  UNKNOWN_TYPE: 2007,
};

// --- 模块级管理员钩子：由 attachWS 内部把闭包实现挂上来（避免把 sessions 暴露为全局可变状态） ---
let _kickImpl = null;      // (userId, reason, closeCode) => 被关闭的连接数
let _onlineImpl = null;    // () => number[] 在线用户 id

/**
 * 强制某用户所有在线 WS 会话下线（封禁/踢人用）。attachWS 未调用时为空操作。
 * @param {number} userId
 * @param {string} [reason]
 * @param {number} [closeCode]
 * @returns {number} 被关闭的连接数
 */
export function kickUser(userId, reason = 'kicked', closeCode = 4004) {
  if (!_kickImpl) return 0;
  try { return _kickImpl(userId, reason, closeCode); } catch (e) { return 0; }
}

/** 当前在线（已完成 hello 鉴权并进入某世界）的用户 id 列表（去重）。 */
export function onlineUserIds() {
  if (!_onlineImpl) return [];
  try { return _onlineImpl(); } catch (e) { return []; }
}

export function attachWS(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: 16 * 1024 });
  // 每房间的 intent queue（延迟=惯性在这里）
  const worldQueues = new Map(); // worldId -> Map<wsId, IntentQueue>
  // 断线宽限：worldId -> Map<userId, deadlineMs>
  const grace = new Map();
  // worldId -> Map<userId, Set<ws>>：跟踪每房每用户的活动连接，用于判断是否要开宽限
  const worldSessions = new Map();
  function addSession(worldId, userId, ws) {
    if (!worldSessions.has(worldId)) worldSessions.set(worldId, new Map());
    const byUser = worldSessions.get(worldId);
    if (!byUser.has(userId)) byUser.set(userId, new Set());
    byUser.get(userId).add(ws);
  }
  function removeSession(worldId, userId, ws) {
    const byUser = worldSessions.get(worldId);
    if (!byUser) return;
    const set = byUser.get(userId);
    if (set) { set.delete(ws); if (set.size === 0) byUser.delete(userId); }
    if (byUser.size === 0) worldSessions.delete(worldId);
  }
  function hasLiveSession(worldId, userId) {
    const byUser = worldSessions.get(worldId);
    if (!byUser) return false;
    const set = byUser.get(userId);
    if (!set) return false;
    for (const s of set) if (s.readyState === 1) return true;
    return false;
  }
  function cancelGrace(worldId, userId) {
    const gmap = grace.get(worldId);
    if (!gmap) return;
    gmap.delete(userId);
    if (gmap.size === 0) grace.delete(worldId);
  }

  // 把模块级钩子接到本闭包上（供 routes 的封禁/踢人调用）。
  _onlineImpl = () => {
    const ids = new Set();
    for (const byUser of worldSessions.values()) {
      for (const uid of byUser.keys()) ids.add(uid);
    }
    return [...ids];
  };
  _kickImpl = (userId, reason, closeCode) => {
    let n = 0;
    for (const byUser of worldSessions.values()) {
      const set = byUser.get(userId);
      if (!set) continue;
      for (const cws of Array.from(set)) {
        try { cws.send(JSON.stringify({ type: T.ERROR, data: { code: 4004, message: String(reason || 'kicked') } })); } catch {}
        try { cws.close(closeCode || 4004, String(reason || 'kicked').slice(0, 120)); } catch {}
        n++;
      }
    }
    // 同时清掉其宽限条目，避免"被踢后 15s 内又被当作掉线重连对象"
    for (const gmap of grace.values()) gmap.delete(userId);
    return n;
  };

  function getQueue(worldId) {
    if (!worldQueues.has(worldId)) worldQueues.set(worldId, new Map());
    return worldQueues.get(worldId);
  }

  // go 模式下的广播（单次序列化，同世界所有客户端复用同一字符串）。
  function broadcast(w) {
    const msg = JSON.stringify({ type: T.SNAP, data: w.snapshot(true) });
    for (const client of wss.clients) {
      if (client.readyState !== 1) continue;
      if (client.worldId !== w.worldId) continue;
      try { client.send(msg); } catch {}
    }
  }
  function broadcastEvents(w, events) {
    if (!events || !events.length) return;
    const msg = JSON.stringify({ type: T.EVENT, data: events });
    for (const client of wss.clients) {
      if (client.readyState !== 1) continue;
      if (client.worldId !== w.worldId) continue;
      try { client.send(msg); } catch {}
    }
  }
  // go 世界是否有任意 live WS 连接（供计时暂停判定）。
  function hasLiveClients(worldId) {
    for (const client of wss.clients) {
      if (client.readyState === 1 && client.worldId === worldId) return true;
    }
    return false;
  }

  wss.on('connection', (ws, req) => {
    let authed = null; // { userId, username }
    let worldId = null;
    let lastHeartbeat = Date.now();
    let intentCount = 0;
    let lastIntentAt = 0;

    // 心跳检测（30s）
    const hbTimer = setInterval(() => {
      if (Date.now() - lastHeartbeat > 30000) {
        try { ws.close(CLOSE.HEARTBEAT_TIMEOUT, 'heartbeat_timeout'); } catch {}
        clearInterval(hbTimer);
      }
    }, 5000);

    function send(type, data) {
      try { ws.send(JSON.stringify({ type, data })); } catch {}
    }
    function err(code, message) { send(T.ERROR, { code, message }); }

    ws.on('message', (raw) => {
      lastHeartbeat = Date.now();
      if (raw.length > 16 * 1024) { err(ERR.PAYLOAD_TOO_BIG, 'payload_too_big'); return; }
      let msg; try { msg = JSON.parse(raw.toString()); } catch { err(ERR.BAD_INTENT, 'bad_json'); return; }
      if (!msg || typeof msg.type !== 'string') { err(ERR.UNKNOWN_TYPE, 'unknown_type'); return; }
      // 频率限制
      const now = Date.now();
      if (now - lastIntentAt < 5) { intentCount++; if (intentCount > 100) { err(ERR.RATE_LIMIT, 'too_fast'); return; } }
      else { intentCount = 0; lastIntentAt = now; }

      switch (msg.type) {
        case T.HELLO: {
          const tok = msg.data && msg.data.token;
          const wid = msg.data && msg.data.worldId;
          const dec = verifyToken(tok || '');
          if (!dec) { err(ERR.BAD_AUTH, 'bad_token'); try { ws.close(CLOSE.AUTH_FAIL, 'bad_auth'); } catch {} return; }
          // 封禁拦截：已生效封禁的账号不得进入任何世界
          if (isBanActive(usersRepo.byIdFull(dec.id))) {
            err(ERR.BAD_AUTH, 'account_banned');
            try { ws.close(CLOSE.BANNED, 'banned'); } catch {}
            return;
          }
          const w = activeWorlds.get(wid);
          if (!w) { err(ERR.WORLD_NOT_FOUND, 'world_not_found'); return; }
          authed = { userId: dec.id, username: dec.username };
          worldId = wid;
          ws.worldId = wid;
          netManaged.add(worldId);
          addSession(worldId, authed.userId, ws);
          // 断线宽限内重连（同 uid）：取消宽限，addPlayer 幂等续用同一玩家对象
          cancelGrace(worldId, authed.userId);
          {
            // 席位规则：人类上限由房主设定（1..8），AI 不占人类名额；同 uid 重连幂等返回
            // 既有对象并**交还控制权**（掉线期间由电脑代打）。
            const already = !!w.players[authed.userId];
            const res = w.addPlayer(authed.userId, authed.username);
            if (!already && res && res.rejected) {
              err(ERR.FORBIDDEN, res.rejected);
              try { ws.close(CLOSE.KICKED, res.rejected); } catch {}
              return;
            }
          }
          // 给该 ws 分配一个 queue（每个连接一份，但共享同一 world）
          if (!getQueue(worldId).has(ws)) getQueue(worldId).set(ws, new IntentQueue());
          send(T.WELCOME, { worldId, tick: w.tick, you: w.players[authed.userId] });
          send(T.SNAP, w.snapshot(true));
          break;
        }
        case T.INTENT: {
          if (!authed || !worldId) { err(ERR.BAD_AUTH, 'not_authed'); return; }
          const intent = msg.data || {};
          const w = activeWorlds.get(worldId);
          // 世界默认开局暂停（POST /rooms/:code/world 设 w.paused=true），
          // 故"未开始不可动"由现有房主暂停机制统一处理：rts 不 tick、go 落子在 applyGoIntent 内拦截。
          // 此处不再额外按 started 拦截（先前那版属于过度改动）。
          // 模式意图路由：由注册表里的模式插件决定如何处理本意图。
          // go：直接 applyGoIntent（绕过 20TPS intentQueue），落子被拒的 go_reject 事件由插件压入 events；
          // rts 无 routeIntent → 落到底部入队逻辑（20TPS 常规路径）。
          if (w && w._mode && w._mode.routeIntent) {
            const events = [];
            const routed = w._mode.routeIntent(w, authed.userId, intent, events);
            if (routed.handled) {
              if (routed.silent) return;   // 插件声明"无需广播"（如 go 世界收到非 go 意图）
              const r = routed.result || {};
              if (!r.ok && r.reason) err(ERR.BAD_INTENT, String(r.reason));
              // 无论成功/被拒都广播最新快照（双方即时看到棋盘）
              broadcast(w);
              if (events.length) broadcastEvents(w, events);
              else broadcastEvents(w, w.events || []);
              return;
            }
          }
          // 校验 move
          if (intent.move) {
            const m = intent.move;
            if (typeof m.dx !== 'number' || typeof m.dy !== 'number' || !Number.isFinite(m.dx) || !Number.isFinite(m.dy)) {
              err(ERR.BAD_INTENT, 'bad_move'); return;
            }
          }
          const q = getQueue(worldId).get(ws);
          if (!q) return;
          // 故意把消息时间戳忽略：服务器只按到达时间 FIFO
          q.push(authed.userId, intent);
          break;
        }
        case T.CHAT: {
          if (!authed) return;
          const text = String((msg.data && msg.data.text) || '').slice(0, 200);
          if (!text) return;
          // M6 聊天按房间隔离：只发给同一 worldId 的客户端，杜绝跨房串聊
          for (const client of wss.clients) {
            if (client.readyState !== 1) continue;
            if (client.worldId !== worldId) continue;
            try { client.send(JSON.stringify({ type: T.CHAT, data: { from: authed.username, text } })); } catch {}
          }
          break;
        }
        case T.HEARTBEAT: {
          lastHeartbeat = Date.now();
          send(T.PONG, { ts: Date.now() });
          break;
        }
        case T.JOIN: {
          // 同 HELLO，简化为二次加入
          if (authed) return;
          const tok = msg.data && msg.data.token;
          const wid = msg.data && msg.data.worldId;
          const dec = verifyToken(tok || '');
          if (!dec) { err(ERR.BAD_AUTH, 'bad_token'); return; }
          // 封禁拦截：JOIN 与 HELLO 同规则
          if (isBanActive(usersRepo.byIdFull(dec.id))) {
            err(ERR.BAD_AUTH, 'account_banned');
            try { ws.close(CLOSE.BANNED, 'banned'); } catch {}
            return;
          }
          const w = activeWorlds.get(wid);
          if (!w) { err(ERR.WORLD_NOT_FOUND, 'world_not_found'); return; }
          authed = { userId: dec.id, username: dec.username };
          worldId = wid;
          ws.worldId = wid;
          netManaged.add(worldId);
          addSession(worldId, authed.userId, ws);
          cancelGrace(worldId, authed.userId);
          {
            // 与 HELLO 同一席位规则（人类上限由房主设定；AI 不占人类名额）
            const already = !!w.players[authed.userId];
            const res = w.addPlayer(authed.userId, authed.username);
            if (!already && res && res.rejected) {
              err(ERR.FORBIDDEN, res.rejected);
              try { ws.close(CLOSE.KICKED, res.rejected); } catch {}
              return;
            }
          }
          send(T.SNAP, w.snapshot(true));
          break;
        }
        case T.LEAVE: {
          try { ws.close(CLOSE.ROOM_CLOSED, 'leave'); } catch {}
          break;
        }
        default:
          err(ERR.UNKNOWN_TYPE, 'unknown_type');
      }
    });

    ws.on('close', () => {
      clearInterval(hbTimer);
      if (authed && worldId) {
        removeSession(worldId, authed.userId, ws);
        const q = getQueue(worldId);
        q.delete(ws);
        // M3 断线宽限：不立刻 removePlayer。若该用户还有其它活连接（如双标签页）
        // 则无需宽限；否则保留角色与领土 GRACE_MS，供快速重连续用。
        if (!hasLiveSession(worldId, authed.userId)) {
          // 大厅阶段：从 room.members 移除掉线者。members 只在 join 时 set、从不 delete，
          // 若不在这里清，roomHasHuman 会一直误判"有人"→ 空房间永远清不掉（Bug 2 根因）。
          for (const room of roomHub.values()) {
            if (room.worldId === worldId && room.members && room.members.has(authed.userId)) {
              room.members.delete(authed.userId);
              break;
            }
          }
          if (!grace.has(worldId)) grace.set(worldId, new Map());
          grace.get(worldId).set(authed.userId, Date.now() + GRACE_MS);
        }
      }
    });
    ws.on('error', () => { try { ws.close(); } catch {} });
  });

  // F2（QA P1-2）固定步长累加器 ticker。
  // 原实现 `setInterval(tick, 50)` 在 Windows 上被系统时钟（15.625ms 粒度）量化到
  // 62.5ms → 实机只有 ~16 TPS（设计 20），所有按 tick 计时的游戏文案（种子 2.25s、
  // 潮汐 50s、多细胞 30s…）在 Windows 上整体慢 25%。
  // 改法：16ms 高频采样 + 50ms 累加器。量化误差被摊平成"有的帧 0 tick、有的帧 1~2 tick"，
  // 长期平均严格 TICK 20 TPS，与操作系统无关。
  const TICK_MS = 50;        // 1000 / TICK_RATE(20)
  const SAMPLE_MS = 16;      // 高频采样，真实步长由累加器决定
  const MAX_CATCHUP = 3;     // 单帧最多补 3 tick，防雪崩
  const MAX_ACC_MS = 500;    // 长时间挂起（睡眠/断点）后丢弃积压，不追补历史
  let netLastAt = Date.now();
  let netAcc = 0;
  const netTicker = setInterval(() => {
    const now = Date.now();
    netAcc += now - netLastAt;
    netLastAt = now;
    if (netAcc > MAX_ACC_MS) netAcc = MAX_ACC_MS;

    // ---------- 以下逻辑每采样帧只跑一次（与补几个 tick 无关） ----------
    // 1) 宽限到期 → **由电脑接手**（不删除玩家：分数/棋盘/faction 全部保留，玩家回来即接回）
    for (const [wid, gmap] of grace) {
      if (gmap.size === 0) { grace.delete(wid); continue; }
      for (const [uid, deadline] of Array.from(gmap)) {
        if (now < deadline) continue;
        gmap.delete(uid);
        const w = activeWorlds.get(wid);
        if (w) {
          try {
            const p = w.players && w.players[uid];
            if (p && !p.isAI) {
              w.handOverToAI(uid);
              broadcastEvents(w, [{ type: 'bot_takeover', playerId: uid, name: p.name }]);
            } else if (p && p.isAI) {
              // 真 AI 才移除（理论上不会走到：AI 不会开 WS）
              w.removePlayer(uid);
            }
          } catch (e) { console.error('[grace] handOverToAI', wid, uid, e); }
        }
      }
      if (gmap.size === 0) grace.delete(wid);
    }

    // 2) 判定每个世界是否仍由 net 驱动（每帧一次），并收集本帧待 tick 的世界
    const tickList = [];
    for (const [worldId, queueMap] of Array.from(worldQueues)) {
      const w = activeWorlds.get(worldId);
      if (!w) { worldQueues.delete(worldId); netManaged.delete(worldId); continue; }

      // 世界是否仍由 net 驱动：有 live ws 或 有宽限中的玩家
      let live = false;
      for (const cws of queueMap.keys()) { if (cws.readyState === 1) { live = true; break; } }
      const gmap0 = grace.get(worldId);
      const inGrace = !!gmap0 && gmap0.size > 0;
      if (!live && !inGrace) {
        // F6（QA P3-5）：只要没有 live ws 且没有宽限中的玩家，就把驱动权交还 index.js。
        // 旧逻辑只在 humanCount===0 时交还 → "无人连但玩家对象还在"的世界既不被 net
        // 驱动也不被 index 驱动 → 永久冻结（冻结比原来的双 tick 严重得多）。
        netManaged.delete(worldId);
        if (queueMap.size === 0) worldQueues.delete(worldId);
        continue;
      }
      netManaged.add(worldId);
      // 非 realtime 模式（如 go / interval）不参与 20 TPS tick，由各自的 interval 循环驱动。
      if (w._mode.tickDriver !== 'realtime') continue;
      tickList.push([worldId, queueMap, w]);
    }

    // ---------- 以下逻辑每 tick 跑一次（补几 tick 就跑几次） ----------
    // 灌意图 → tick → 广播（每世界序列化一次）
    let n = 0;
    while (netAcc >= TICK_MS && n < MAX_CATCHUP) {
      netAcc -= TICK_MS;
      n++;
      for (const [worldId, queueMap, w] of tickList) {
        // 房主暂停：不灌意图、不 tick，但保留队列（FIFO 不丢，恢复后继续）。
        if (w.paused) continue;
        // 把每个 ws 队列的指令合并到 world.intentQueue
        for (const [cws, q] of queueMap) {
          if (cws.readyState !== 1) continue;
          const snap = q.snapshot();
          for (const playerId of Object.keys(snap)) {
            // 取该玩家的 pending，按 FIFO 写入 world
            const pending = q.drain(playerId);
            if (pending) w.intentQueue.push(playerId, { move: { dx: pending.jx, dy: pending.jy }, attack: pending.attack, build: pending.build, tech: pending.tech, dash: pending.dash, plant: pending.plant, chat: pending.chat });
          }
        }
        // tick 一次（单世界异常不拖垮进程）
        try {
          w.tickOnce();
        } catch (e) {
          console.error('[tick]', worldId, e);
        }
        // M4 广播单次序列化：同世界所有客户端复用同一份字符串
        const snapMsg = JSON.stringify({ type: T.SNAP, data: w.snapshot(true) });
        for (const [cws] of queueMap) {
          if (cws.readyState !== 1) continue;
          try { cws.send(snapMsg); } catch {}
        }
        // 广播事件（仅当有事件）
        if (w.events && w.events.length) {
          const evtMsg = JSON.stringify({ type: T.EVENT, data: w.events });
          for (const [cws] of queueMap) {
            if (cws.readyState !== 1) continue;
            try { cws.send(evtMsg); } catch {}
          }
        }
      }
    }
  }, SAMPLE_MS);
  // 不阻止进程退出（测试环境 attachWS 后可自然结束；线上由 http server 保活）
  if (typeof netTicker.unref === 'function') netTicker.unref();

  // interval 模式（go / gomoku / weiqi 等）：1 秒一次推进。计时暂停在 net 层判定（无任何 live WS 连接时冻结 turnTicks），
  // engine 不感知连接 —— 保持引擎纯函数式确定性。
  // 顺序：模式自己决定（如 go：AI 出手 → 推进计时 → 广播）；主干只按注册表调用 intervalStep（回退 tick），
  // 不再硬编码 go 专属方法 —— 新增 interval 模式零改动即可被驱动。
  const intervalTicker = setInterval(() => {
    for (const w of activeWorlds.values()) {
      if (w._mode.tickDriver !== 'interval') continue;   // 仅 interval 模式（go / gomoku / weiqi 等）走 1Hz 循环
      if (Object.keys(w.players).length === 0) continue;
      // 房主暂停：冻结计时与 AI（turnTicks 不推进，回来接着走）
      if (w.paused) continue;
      // 无 live WS 连接 → 冻结计时（不推进 turnTicks，也不让 AI 白走）
      if (!hasLiveClients(w.worldId)) continue;
      const events = [];
      let changed = false;
      try {
        // 按注册表驱动 interval 的一步（含 AI）：优先 intervalStep，回退 tick。
        const step = w._mode.intervalStep || w._mode.tick;
        if (step) { const r = step(w, events); changed = !(r && r.changed === false); }
      } catch (e) {
        console.error('[interval-tick]', w.worldId, e);
      }
      if (changed) {
        broadcast(w);
        broadcastEvents(w, events);
      }
    }
  }, 1000);
  if (typeof intervalTicker.unref === 'function') intervalTicker.unref();

  return wss;
}

export { T, CLOSE, ERR };