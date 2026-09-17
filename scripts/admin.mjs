// scripts/admin.mjs — 管理员本地 CLI
//
// 用法（在项目根目录执行）：
//   node scripts/admin.mjs list
//   node scripts/admin.mjs grant <username> [player|readonly|admin|superadmin]  # 默认 admin
//   node scripts/admin.mjs revoke <username>         # 降为玩家（不能撤销最后一个可写管理员）
//   node scripts/admin.mjs ban <username> [hours]    # 封禁（省略 hours 或 0 = 永久）
//   node scripts/admin.mjs unban <username>          # 解封
//   node scripts/admin.mjs delete <username>         # 硬删除 + 级联清理
//
// 默认使用文件库 ./server/data/game.db（可用 DB_PATH 环境变量覆盖）。
// 注意：DB_PATH 必须在 import db 模块**之前**设置（模块加载时读取一次）。

process.env.DB_PATH = process.env.DB_PATH || './server/data/game.db';

const { initDB, usersRepo, adminRepo, dbType_ } = await import('../server/db/index.js');
const { isWriterRole, roleLabel, normalizeRole } = await import('../server/roles.js');

const args = process.argv.slice(2);
const cmd = (args[0] || 'list').toLowerCase();
const username = args[1];
const hours = args[2] != null ? Number(args[2]) : 0;

function fail(msg) { console.error('✗ ' + msg); process.exitCode = 1; }
function ok(msg) { console.log('✓ ' + msg); }

function findUser(name) {
  if (!name) return null;
  return usersRepo.byUsername(String(name));
}

function fmt(u) {
  const role = u.role || 'player';
  const ban = u.banned
    ? ('已封禁' + (u.banned_until ? (' 至 ' + new Date(u.banned_until).toLocaleString()) : '（永久）'))
    : '正常';
  return `#${u.id}\t${u.username}\t[${role} / ${roleLabel(role)}]\t${ban}\t注册:${new Date(u.created_at).toLocaleString()}`;
}

try {
  await initDB();
  console.log(`[db] ${dbType_()} @ ${process.env.DB_PATH}`);

  switch (cmd) {
    case 'list': {
      const { rows, total } = usersRepo.listAll({ limit: 200, offset: 0 });
      console.log(`用户总数: ${total}`);
      if (!rows.length) console.log('（暂无用户，去注册第一个账号将自动成为管理员）');
      for (const u of rows) console.log(fmt(u));
      break;
    }

    case 'grant': {
      const u = findUser(username);
      if (!u) { fail(`用户不存在: ${username}`); break; }
      const role = normalizeRole(String(args[2] || 'admin').trim());
      if (String(args[2] || 'admin').trim() !== role) { fail(`非法角色值: ${args[2]}（可选 player/readonly/admin/superadmin）`); break; }
      usersRepo.setRole(u.id, role);
      adminRepo.log({ action: 'cli_grant', targetId: u.id, targetName: u.username, detail: JSON.stringify({ role, via: 'scripts/admin.mjs' }) });
      ok(`已将 ${u.username} 设为${roleLabel(role)}（${role}）`);
      break;
    }

    case 'revoke': {
      const u = findUser(username);
      if (!u) { fail(`用户不存在: ${username}`); break; }
      const admins = usersRepo.count().admins;
      if (isWriterRole(u.role) && admins <= 1) { fail('不能撤销系统中最后一个可写管理员（admin / superadmin）'); break; }
      usersRepo.setRole(u.id, 'player');
      adminRepo.log({ action: 'cli_revoke', targetId: u.id, targetName: u.username, detail: 'via scripts/admin.mjs' });
      ok(`已取消 ${u.username} 的管理员身份`);
      break;
    }

    case 'ban': {
      const u = findUser(username);
      if (!u) { fail(`用户不存在: ${username}`); break; }
      const dur = (Number.isFinite(hours) && hours > 0) ? hours : 0;
      const until = dur > 0 ? Date.now() + dur * 3600 * 1000 : 0;
      usersRepo.setBan(u.id, { banned: true, reason: 'CLI 封禁', until });
      adminRepo.log({ action: 'cli_ban', targetId: u.id, targetName: u.username, detail: JSON.stringify({ durationHours: dur, until }) });
      ok(`已封禁 ${u.username}${dur > 0 ? `（${dur} 小时）` : '（永久）'}`);
      break;
    }

    case 'unban': {
      const u = findUser(username);
      if (!u) { fail(`用户不存在: ${username}`); break; }
      usersRepo.setBan(u.id, { banned: false });
      adminRepo.log({ action: 'cli_unban', targetId: u.id, targetName: u.username, detail: 'via scripts/admin.mjs' });
      ok(`已解封 ${u.username}`);
      break;
    }

    case 'delete': {
      const u = findUser(username);
      if (!u) { fail(`用户不存在: ${username}`); break; }
      const admins = usersRepo.count().admins;
      if (isWriterRole(u.role) && admins <= 1) { fail('不能删除系统中最后一个可写管理员（admin / superadmin）'); break; }
      adminRepo.log({ action: 'cli_delete', targetId: u.id, targetName: u.username, detail: 'via scripts/admin.mjs' });
      const r = usersRepo.remove(u.id);
      ok(`已删除 ${u.username}（清理: ${JSON.stringify(r.cleaned)}）`);
      break;
    }

    default:
      console.log('用法:');
      console.log('  node scripts/admin.mjs list');
      console.log('  node scripts/admin.mjs grant <username> [role]');
      console.log('  node scripts/admin.mjs revoke <username>');
      console.log('  node scripts/admin.mjs ban <username> [hours]');
      console.log('  node scripts/admin.mjs unban <username>');
      console.log('  node scripts/admin.mjs delete <username>');
      break;
  }
} catch (e) {
  console.error('✗ 执行失败:', e && (e.stack || e.message || e));
  process.exitCode = 1;
}
