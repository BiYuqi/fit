#!/usr/bin/env bash
# 一键部署：DB + 后端 + Cloudflare Tunnel
# 手机端通过 https://fit-api.refinely.app 访问
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
BACKEND="$ROOT/backend"
BACKEND_PID=""
TUNNEL_NAME="market-cap-radar"

cleanup() {
  echo ""
  echo "🛑 正在停止后端..."
  [ -n "$BACKEND_PID" ] && kill "$BACKEND_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# ── 数据库 ────────────────────────────────────
start_db() {
  if docker ps --format '{{.Names}}' | grep -q '^fit-pg$'; then
    echo "🟢 数据库已在运行"
  elif docker ps -a --format '{{.Names}}' | grep -q '^fit-pg$'; then
    echo "🟢 启动已有数据库容器"
    docker start fit-pg >/dev/null
  else
    echo "🟢 创建数据库容器"
    docker run --name fit-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=fit -p 5432:5432 -d postgres:16 >/dev/null
  fi
}

# ── 后端 ──────────────────────────────────────
start_backend() {
  echo "📦 安装依赖"
  (cd "$BACKEND" && npm install --no-audit)

  echo "🗃  数据库迁移"
  (cd "$BACKEND" && npx prisma migrate deploy && npx prisma generate)

  lsof -ti :9300 | xargs kill -9 2>/dev/null || true

  echo "🚀 启动后端 :9300"
  (cd "$BACKEND" && npm run dev) & BACKEND_PID=$!
  sleep 2
}

# ── Tunnel ────────────────────────────────────
ensure_tunnel() {
  if pgrep -f "cloudflared tunnel run $TUNNEL_NAME" >/dev/null; then
    echo "🟢 Tunnel 已在运行"
  else
    echo "🌐 启动 Cloudflare Tunnel"
    cloudflared tunnel run "$TUNNEL_NAME" &
    sleep 3
    echo "🟢 Tunnel 已就绪"
  fi
}

# ── 主流程 ────────────────────────────────────
echo "╔══════════════════════════════════════╗"
echo "║  Fit 一键部署                        ║"
echo "║  后端 → https://fit-api.refinely.app ║"
echo "╚══════════════════════════════════════╝"

start_db
start_backend
ensure_tunnel

echo ""
echo "✅ 部署完成"
echo "   API: https://fit-api.refinely.app"
echo "   Ctrl+C 停止后端"
echo ""
echo "📱 前端安装（插上 iPhone 后执行）:"
echo "   cd frontend && npx expo run:ios --device"

wait "$BACKEND_PID"
