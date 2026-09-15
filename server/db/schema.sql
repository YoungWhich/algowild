-- server/db/schema.sql
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE,
  passhash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  -- 管理员控制台相关列（对已存在的旧库由 migrate() 用 ALTER 补列）
  role TEXT NOT NULL DEFAULT 'player',     -- 'player' | 'admin'
  banned INTEGER NOT NULL DEFAULT 0,       -- 0 = 正常，1 = 已封禁
  ban_reason TEXT,                         -- 封禁原因
  banned_at INTEGER,                       -- 封禁时间（ms）
  banned_until INTEGER,                    -- 解封时间（ms）；0 或 NULL = 永久
  last_login INTEGER                       -- 最近登录时间（ms）
);

-- 管理员操作审计（只增不改；CREATE TABLE IF NOT EXISTS，无需 migrate 补列）
CREATE TABLE IF NOT EXISTS admin_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER,
  actor_name TEXT,
  action TEXT NOT NULL,
  target_id INTEGER,
  target_name TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS worlds (
  id TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  seed INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS world_players (
  world_id TEXT NOT NULL,
  player_id INTEGER NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (world_id, player_id),
  FOREIGN KEY (world_id) REFERENCES worlds(id),
  FOREIGN KEY (player_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS rooms (
  code TEXT PRIMARY KEY,
  world_id TEXT NOT NULL DEFAULT '',
  owner_id INTEGER NOT NULL,
  max_players INTEGER NOT NULL DEFAULT 8,
  visibility TEXT NOT NULL DEFAULT 'public',
  passhash TEXT,
  name TEXT,
  mode TEXT,
  -- 房间玩法设置（房主设定；旧库由 migrate() 补列）
  stones_per_turn INTEGER,      -- 回合制每回合最多落几颗（1..16）
  lonely_death_delay INTEGER,   -- 孤子等无法存活单位宽限几回合才死（0..10）
  -- 胜利条件（房主设定；JSON 串；旧库由 migrate() 补列；NULL = 回退默认）
  victory_lines TEXT,           -- JSON: {"territory":true,"economy":false,...}
  victory_thresholds TEXT,      -- JSON: {"territoryRegions":16,...}
  -- 可编辑棋盘形状（房主设定；JSON: {w,h,shape}；旧库由 migrate() 补列；NULL = 回退默认矩形）
  board TEXT,
  go_limits TEXT,               -- JSON: {maxMoves,turnMs,maxTimeouts}（go 模式限制）
  created_at INTEGER NOT NULL,
  closed_at INTEGER,
  FOREIGN KEY (owner_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS saves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  world_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (world_id) REFERENCES worlds(id)
);

CREATE TABLE IF NOT EXISTS scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  world_id TEXT NOT NULL,
  score INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (world_id) REFERENCES worlds(id)
);

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);