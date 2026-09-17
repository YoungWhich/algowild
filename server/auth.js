// server/auth.js — bcrypt + JWT
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { usersRepo } from './db/index.js';
import { isStaffRole } from './roles.js';

const JWT_SECRET = process.env.JWT_SECRET || 'algowild-dev-secret-not-for-prod';
const JWT_EXPIRES = '7d';

export async function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}
export async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

export function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}
export function verifyToken(tok) {
  try { return jwt.verify(tok, JWT_SECRET); } catch { return null; }
}

// Accept the token from multiple sources. The deploy reverse-proxy hijacks the
// Authorization header (injects its own token), so we trust the query param,
// request body and x-auth-token FIRST and only fall back to Authorization last.
// The WS path carries the token in the hello message body.
export function authMiddleware(req, res, next) {
  let tok = null;
  if (req.query && req.query.token) tok = String(req.query.token);
  if (!tok && req.body && req.body.token) tok = req.body.token;
  if (!tok && req.headers['x-auth-token']) tok = req.headers['x-auth-token'];
  if (!tok) {
    const h = req.headers['authorization'] || '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (m) tok = m[1];
  }
  if (!tok) return res.status(401).json({ code: 401, message: 'missing token', data: null });
  const decoded = verifyToken(tok);
  if (!decoded) return res.status(401).json({ code: 401, message: 'invalid token', data: null });
  req.user = decoded;
  next();
}

export function passwordOk(p) {
  if (typeof p !== 'string') return false;
  if (p.length < 6) return false;
  if (p.length > 64) return false;
  return true;
}
export function usernameOk(u) {
  if (typeof u !== 'string') return false;
  if (u.length < 3 || u.length > 32) return false;
  if (!/^[a-zA-Z0-9_\-]+$/.test(u)) return false;
  return true;
}

/**
 * 该用户当前是否处于"生效中的封禁"。
 * @param {object|null} user users 行（含 banned / banned_until）
 * @returns {boolean} true = 正在被封禁
 */
export function isBanActive(user) {
  if (!user || !user.banned) return false;
  // banned_until 为 0 / null / undefined → 永久封禁
  if (!user.banned_until) return true;
  return user.banned_until > Date.now();
}

/**
 * 管理后台鉴权中间件（只读也算后台成员）。假定 authMiddleware 已先行执行（req.user 存在）。
 * 以库中的最新 role 为准，避免旧 token 内嵌 role 失真。
 * 只读管理员也放行（能看不能改）；player 一律拒绝。改权限另行判定，见 server/roles.js 的层级。
 */
export function requireAdmin(req, res, next) {
  const u = usersRepo.byIdFull(req.user && req.user.id);
  if (!u || !isStaffRole(u.role)) {
    return res.status(403).json({ code: 403, message: 'forbidden', data: null });
  }
  req.me = u; // 内部使用（含 passhash，绝不能出现在响应里）
  next();
}