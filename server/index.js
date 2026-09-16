// server/index.js — 主入口
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { initDB, dbType_, setDbPath, usersRepo } from './db/index.js';
import { loadKernels, kernelRegistry } from './engine.js';
import { hashPassword } from './auth.js';
import { createRouter } from './routes.js';
import { attachWS, netManaged } from './net.js';
import { activeWorlds } from './worldhub.js';
import { startInactivePurgeScheduler, startEmptyRoomCleanupScheduler } from './maintenance.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 17000;

/**
 * 管理员"自举"：把 master 逃生账号从环境变量固化，避免部署在临时盘/内存库
 * （免费实例重启、沙箱回收）时因清盘丢失管理员通道。
 *
 * 仅当 MASTER_USERNAME 设置时才生效 —— 不配置则完全无副作用，不影响现有
 * 行为、也不影响测试（测试不调用 main()，且未设该变量会提前 return）。
 *
 * 关键点：MASTER_USERNAME / MASTER_PASSWORD 写在「平台环境变量」里（属平台配置，
 * 不在临时磁盘上），所以清盘后重启仍能读到 → 自动重建 master 账号。
 *   - 未设 MASTER_PASSWORD 时生成强随机密码并打印到启动日志（请妥善保存）；
 *   - 已存在但非 admin 时强制提权，保证逃生通道始终可用。
 */
async function bootstrapMaster() {
  const username = String(process.env.MASTER_USERNAME || '').trim();
  if (!username) return;
  try {
    const existing = usersRepo.byUsername(username);
    if (!existing) {
      const pw = String(process.env.MASTER_PASSWORD || '').trim() ||
        (crypto.randomBytes(9).toString('base64') + '!A1');
      const passhash = await hashPassword(pw);
      usersRepo.create(username, null, passhash);
      const u = usersRepo.byUsername(username);
      usersRepo.setRole(u.id, 'admin');
      console.log('[admin] bootstrap: created "' + username + '" as admin' +
        (process.env.MASTER_PASSWORD ? '' : '  (随机密码: ' + pw + ' — 请妥善保存)'));
    } else if (existing.role !== 'admin') {
      usersRepo.setRole(existing.id, 'admin');
      console.log('[admin] bootstrap: "' + username + '" 已存在，强制设为 admin');
    }
  } catch (e) {
    console.warn('[admin] bootstrap master 失败:', e && e.message);
  }
}

async function main() {
  // 1) DB —— 默认切到文件库以持久化用户；失败则回退内存，保证线上绝不因 DB 问题起不来。
  if (!process.env.DB_PATH) {
    process.env.DB_PATH = './server/data/game.db';
    setDbPath('./server/data/game.db');
  }
  let dbInfo;
  try {
    dbInfo = await initDB();
  } catch (e) {
    // 静默回退是危险的：线上若因磁盘/权限异常落到内存库，账号/房间/存档会在重启后全部丢失，
    // 而运维往往要到"用户回来发现号没了"才知道。故保留"绝不因 DB 起不来"的兜底，
    // 但把回退这件事喊出来（多行告警 + 排查指引）。
    console.warn('[db] file store init failed → fallback to :memory: —', e && e.message);
    console.warn('[db] !! 当前运行在【内存模式】：所有账号 / 房间 / 存档在服务重启后会全部丢失。');
    console.warn('[db]    排查：检查 DB_PATH 所指目录的写权限与磁盘空间；');
    console.warn('[db]          以 `node server/index.js` 启动时默认使用 ./server/data/game.db（可用 DB_PATH 覆盖）。');
    process.env.DB_PATH = ':memory:';
    setDbPath(':memory:');
    dbInfo = await initDB();
  }
  console.log('[db]', dbInfo.type, '(' + (process.env.DB_PATH || ':memory:') + ')');

  // 生产安全自检：JWT_SECRET 绝不能沿用仓库里的默认值。
  // auth.js 的兜底串是明写在源码里的公开字符串，未覆盖 = 任何人都能签发任意用户（含管理员）的令牌。
  if (!process.env.JWT_SECRET) {
    console.warn('[security] !! JWT_SECRET 未设置，当前使用源码内的默认密钥。');
    console.warn('[security]    任何人都能伪造登录令牌直接拿到管理员权限，等同于后台完全开放。');
    console.warn('[security]    上线前务必设置：JWT_SECRET=<至少 32 位随机串>');
  }

  // 管理员自举（master 逃生账号从环境变量重建；未配置 MASTER_USERNAME 则无副作用）。
  await bootstrapMaster();

  // 2) Kernels
  await loadKernels();
  console.log('[kernels]', kernelRegistry.size, 'loaded');

  // 3) Express
  const app = express();
  app.use(express.json({ limit: '32kb' }));
  app.use('/api', createRouter());

  // 静态前端（html/js/css 一律禁缓存：避免"改了却还在跑旧客户端"，这一点在排障时尤其重要）
  app.use(express.static(path.join(__dirname, '..', 'public'), {
    setHeaders: (res, filePath) => {
      if (/\.(html|js|css)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      }
    },
  }));

  // 健康
  app.get('/healthz', (req, res) => res.json({ code: 0, message: 'ok', data: { db: dbType_(), kernels: kernelRegistry.size } }));

  // 兜底路由（history fallback for SPA）
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path === '/ws') return next();
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  // Global error handler — any throw in async routes returns JSON, not HTML.
  app.use((err, req, res, next) => {
    console.error('[err]', err && (err.stack || err.message || err));
    if (res.headersSent) return;
    if (req.path.startsWith('/api') || req.path === '/ws') {
      res.status(500).json({ code: 500, message: 'server_error: ' + (err && err.message || 'unknown'), data: null });
    } else {
      res.status(500).json({ code: 500, message: 'server_error', data: null });
    }
  });

  // 4) HTTP + WS
  const server = http.createServer(app);
  attachWS(server);

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[server] http://0.0.0.0:${PORT}`);
    console.log(`[ws] ws://0.0.0.0:${PORT}/ws`);
  });

  // M5 进程防呆：记录未捕获异常堆栈；60s 窗内连续 5 次才退出，否则吞下继续
  // （配合 M1 的单世界 try/catch，模拟异常应已被隔离，不会触发计数）。
  let crashCount = 0;
  let crashWindowStart = 0;
  function guardUncaught(label, e) {
    console.error(label, e && (e.stack || e.message || e));
    const now = Date.now();
    if (now - crashWindowStart > 60000) { crashWindowStart = now; crashCount = 0; }
    crashCount++;
    if (crashCount >= 5) {
      console.error('[fatal] too many uncaught errors in 60s window — exiting');
      process.exit(1);
    }
  }
  process.on('uncaughtException', (e) => guardUncaught('[uncaughtException]', e));
  process.on('unhandledRejection', (e) => guardUncaught('[unhandledRejection]', e));

  // 启动后台 ticker（即使没有 ws 客户端，世界也前进）。
  // M1 单一 tick 归属：netManaged 里的世界由 net.js 的 WS 循环驱动，这里显式跳过，
  // 消除"同世界被两个 50ms ticker 双 tick"的节奏/确定性失真（原实机 ~32 tick/s）。
  // F2（QA P1-2）固定步长累加器：与 net.js 同款（16ms 采样 + 50ms 累加器）。
  // Windows 系统时钟把 setInterval(50) 量化到 62.5ms → 实机 ~16 TPS，
  // 这里同样改成累加器摊平，保证后台世界也是严格 20 TPS。
  const TICK_MS = 50;
  const SAMPLE_MS = 16;
  const MAX_CATCHUP = 3;
  const MAX_ACC_MS = 500;
  let bgLastAt = Date.now();
  let bgAcc = 0;
  setInterval(() => {
    const now = Date.now();
    bgAcc += now - bgLastAt;
    bgLastAt = now;
    if (bgAcc > MAX_ACC_MS) bgAcc = MAX_ACC_MS;
    let n = 0;
    while (bgAcc >= TICK_MS && n < MAX_CATCHUP) {
      bgAcc -= TICK_MS;
      n++;
      for (const w of activeWorlds.values()) {
        if (netManaged.has(w.worldId)) continue;
        if (w._mode.tickDriver !== 'realtime') continue;   // 非 realtime 模式（go 等）由 1s 计时循环驱动
        if (w.paused) continue;          // 房主暂停
        if (Object.keys(w.players).length === 0) continue;
        try { w.tickOnce(); } catch (e) { console.error('[tick]', w.worldId, e); }
      }
    }
  }, SAMPLE_MS);

  // interval 模式（go / gomoku / weiqi 等）：无人连接的世界（纯 AI 自对弈 / 等待连接）仍按 1s 推进。
  // 有 live WS 时由 net.js 的 1s 循环接管（避免双驱动）；这里只处理未被 net 管理的世界。
  // 主干只按注册表调用 intervalStep（回退 tick），不再硬编码 go 专属方法。
  setInterval(() => {
    for (const w of activeWorlds.values()) {
      if (w._mode.tickDriver !== 'interval') continue;   // 仅 interval 模式（go / gomoku / weiqi 等）走 1Hz 循环
      if (netManaged.has(w.worldId)) continue;
      if (w.paused) continue;          // 房主暂停
      if (Object.keys(w.players).length === 0) continue;
      const events = [];
      try {
        // 按注册表驱动 interval 的一步（含 AI）：优先 intervalStep，回退 tick。
        const step = w._mode.intervalStep || w._mode.tick;
        if (step) step(w, events);
      } catch (e) { console.error('[interval-tick]', w.worldId, e); }
    }
  }, 1000);

  // 账号维护：定期清理不活跃账号（阈值可在管理后台调整；默认 30 天；0 = 关闭）。
  // 纯基础设施定时器（unref），不影响 tick 循环。
  startInactivePurgeScheduler();
  console.log('[purge] inactive-account cleanup scheduler armed');
  // 空房间清理：定期回收无任何人类玩家的房间（大厅空等 / 对局内全是 AI 代打）。
  // 带宽限期（默认 5 分钟，存 meta: empty_room_grace_min），避免瞬间掉线误清。
  startEmptyRoomCleanupScheduler();
  console.log('[room-cleanup] empty-room cleanup scheduler armed');
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });