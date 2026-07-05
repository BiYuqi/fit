#!/usr/bin/env bash
# launchd 开机自启入口：起 DB → migrate → 以 prod 模式跑后端(node dist)。
# 只管 DB + 后端；tunnel 由 market-cap-radar 的 launchd 共享守护，这里不碰。
#
# 关键：launchd 不加载登录 shell 的 PATH，且 node 走 nvm，必须手动补齐工具链，
# 否则找不到 docker / node / npx / lsof。
set -euo pipefail

# ── 工具链 PATH ───────────────────────────────
#   docker → /usr/local/bin, cloudflared → /opt/homebrew/bin, lsof → /usr/sbin
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/bin"
# node 走 nvm 的 default 版本(升级 node 也不失效，比写死路径稳)
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use default >/dev/null 2>&1 || true

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="$ROOT/backend"

# ── DB 容器 ───────────────────────────────────
if docker ps --format '{{.Names}}' | grep -q '^fit-pg$'; then
  echo "🟢 数据库已在运行"
elif docker ps -a --format '{{.Names}}' | grep -q '^fit-pg$'; then
  echo "🟢 启动已有数据库容器"
  docker start fit-pg >/dev/null
else
  echo "🟢 创建数据库容器"
  docker run --name fit-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=fit -p 5432:5432 -d postgres:16 >/dev/null
fi

# 等 DB 就绪(Docker Desktop 冷启动时 daemon 可能还没热，KeepAlive 会兜底重试)
for i in $(seq 1 30); do
  docker exec fit-pg pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done

cd "$BACKEND"

# ── 迁移(建表/加索引，幂等) ────────────────────
echo "🗃  prisma migrate deploy"
npx prisma migrate deploy

# ── 起后端(prod) ──────────────────────────────
# 释放端口，防止上一个实例残留
lsof -ti :9300 | xargs kill -9 2>/dev/null || true

echo "🚀 后端(prod) :9300"
# dist 由 install-launchd.sh / redeploy.sh 构建；这里只运行，不 build。
# exec 把 PID 交给 launchd，KeepAlive 才能正确守护/重启。
exec node dist/index.js
