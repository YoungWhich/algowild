#!/usr/bin/env bash
# 一键在云服务器(Ubuntu/Debian)部署 algowild —— 摆脱 cpolar、不依赖你本机
# 用法：把本仓库弄到服务器上后，终端里 `bash deploy-cloud.sh`
set -e

echo "[1/5] 检查/安装 Node.js 22 ..."
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "[2/5] 进入项目目录并安装依赖 ..."
cd "$(dirname "$0")"
npm install

echo "[3/5] 生成安全环境变量 ..."
export PORT=17000
export JWT_SECRET="$(openssl rand -hex 32)"
export MASTER_USERNAME=admin
export MASTER_PASSWORD="$(openssl rand -base64 12)"

echo "[4/5] 用 pm2 常驻(断线/重启自动拉起) ..."
if ! command -v pm2 >/dev/null 2>&1; then sudo npm i -g pm2; fi
pm2 delete algowild 2>/dev/null || true
PORT="$PORT" JWT_SECRET="$JWT_SECRET" MASTER_USERNAME="$MASTER_USERNAME" MASTER_PASSWORD="$MASTER_PASSWORD" \
  pm2 start npm --name algowild -- start
pm2 save
sudo pm2 startup 2>/dev/null || true

echo "[5/5] 完成"
echo "--------------------------------------------------"
echo " 管理员账号 : $MASTER_USERNAME"
echo " 管理员密码 : $MASTER_PASSWORD   (请记好，重启后不变)"
echo " 开放端口   : $PORT  (云厂商控制台+系统防火墙都要放行)"
echo " 访问地址   : http://<你的服务器公网IP>:$PORT/"
echo "--------------------------------------------------"
echo "提示：DB 默认落在 ./server/data/game.db，重启不丢数据。"
echo "      node:sqlite/better-sqlite3 若没原生编译，会自动回退到 sql.js，不影响运行。"
