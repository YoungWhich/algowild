# 上线部署

## 启动

```
PORT=17000 node server/index.js
```

- HTTP 与 WebSocket 同端口： WebSocket 地址为 `ws://<host>:<port>/ws`。
- 需要 Node 20+（建议 22）。

### 环境变量怎么注入

服务**不会**自动读取 `.env` 文件，需二选一：

```
node --env-file=.env server/index.js      # Node 20.6+
```
或由 systemd / pm2 / Docker 直接注入环境变量。

仓库提供 `.env.example`，复制为 `.env` 后填写即可（`.env` 已在 `.gitignore` 中，不会被提交）。

---

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `17000` | HTTP 端口 |
| `JWT_SECRET` | 源码内默认字符串 | **必须设置**。不设的话等同于开放管理员权限，见下方"上线前检查" |
| `DB_PATH` | `./server/data/game.db` | 未设置时自动使用该文件库并已持久化。设为 `:memory:` 可强制内存模式 |
| `TRUST_PROXY` | 不信任 `X-Forwarded-For` | 部署在可信反向代理后设 `1` 才采信 XFF |
| `ADMIN_ALLOWED_IPS` | 仅 `127.0.0.1` | 管理后台来源白名单，支持 IP / CIDR / `*` |
| `ADMIN_ACCESS_KEY` | 空 | 设置后，管理登录与 `/admin/*` 需携带该密钥 |
| `ADMIN_USERNAMES` | 空 | 逗号分隔；列表内账号登录时自动授予管理员 |
| `MASTER_USERNAME` | 空 | 启动时自举的逃生管理员账号名 |
| `MASTER_PASSWORD` | 空 | 逃生账号密码；留空则随机生成并在启动日志打印 |

---

## 上线前检查

1. **设置 `JWT_SECRET`**（至少 32 位随机串）。
   未设置时服务会在日志中打印 `[security] !! JWT_SECRET 未设置`，此时任何人都能伪造登录令牌直接取得管理员权限。

2. **确认数据库处于文件模式**。
   启动日志形如：
   - `[db] node:sqlite (./server/data/game.db)` → 持久化正常。
   - `[db] !! 当前运行在【内存模式】` → 已回退到内存，**重启会丢失全部数据**，需检查目标目录的写权限与磁盘空间。
   出现该告警时日志会附带排查指引。

3. **远程管理**（可选）。
   默认仅允许本机访问管理后台。需要远程管理时设置 `ADMIN_ALLOWED_IPS`，并建议同时设置 `ADMIN_ACCESS_KEY`。

4. **反向代理**（如部署在 Nginx / 网关之后）。
   默认不信任 `X-Forwarded-For`。若需要正确的来源 IP，设 `TRUST_PROXY=1`，且必须由代理覆盖该请求头，否则来源限制可被伪造绕过。

---

## 健康检查

```
GET /api/meta
-> {"code":0,"message":"ok","data":{"db":"node:sqlite","version":"v4.0","kernels":46,"emergents":14}}
```

返回 `code: 0` 即服务正常。

---

## 数据与备份

- 数据库文件默认 `./server/data/game.db`，父目录不存在时会自动创建。
- 不活跃账号会自动清理，默认阈值 30 天，可在管理后台「维护」页调整（设 `0` 关闭）。管理员账号永不被清理。
- 备份：停服后复制 `game.db` 即可；迁移同样是整文件替换。
