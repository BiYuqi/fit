#!/usr/bin/env bash
# AI 减脂助手 — 真·一键启动
#
#   ./start.sh          一条命令拉起全部：本地数据库 + 后端 + 前端
#   ./start.sh seed     仅重灌食物库
#   ./start.sh stop     停掉本地数据库容器
#
# 首次运行前：把 backend/.env.example 复制为 backend/.env，补 DEEPSEEK_API_KEY 与 JWT_SECRET
# （数据库那行已是本地默认，无需改）。需要已安装 Docker 与 Node 20+。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"
DATA_REPO="$ROOT/.data/china-food-composition-data"
DATA_DIR="$DATA_REPO/json_data_vision_251206_Qwen2-5-VL-72B-Instruct"
BACKEND_PID=""

need() { command -v "$1" >/dev/null 2>&1 || { echo "❌ 缺少 $1，请先安装"; exit 1; }; }

cleanup() {
  echo ""
  echo "🛑 正在停止后端..."
  [ -n "$BACKEND_PID" ] && kill "$BACKEND_PID" 2>/dev/null || true
  echo "（本地数据库容器仍在后台运行，如需停止：./start.sh stop）"
}
trap cleanup EXIT INT TERM

check_env() {
  need node; need npm; need git; need docker
  local major; major="$(node -v | sed 's/v\([0-9]*\).*/\1/')"
  [ "$major" -ge 20 ] || { echo "❌ 需要 Node >= 20，当前 $(node -v)"; exit 1; }
  [ -f "$BACKEND/.env" ] || { echo "❌ 缺少 backend/.env，请复制 backend/.env.example 并填写 DEEPSEEK_API_KEY/JWT_SECRET"; exit 1; }
}

start_db() {
  if docker ps --format '{{.Names}}' | grep -q '^fit-pg$'; then
    echo "🟢 数据库已在运行 (fit-pg)"
  elif docker ps -a --format '{{.Names}}' | grep -q '^fit-pg$'; then
    echo "🟢 启动数据库容器 (fit-pg)"; docker start fit-pg >/dev/null
  else
    echo "🟢 创建并启动数据库 (postgres:16, 端口 5432)"
    docker run --name fit-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=fit -p 5432:5432 -d postgres:16 >/dev/null
  fi
  echo -n "⏳ 等待数据库就绪"
  for i in $(seq 1 30); do
    if docker exec fit-pg pg_isready -U postgres >/dev/null 2>&1; then echo " ✓"; return; fi
    echo -n "."; sleep 1
  done
  echo ""; echo "❌ 数据库启动超时"; exit 1
}

prepare_backend() {
  echo "📦 安装后端依赖"
  (cd "$BACKEND" && npm install --no-audit 2>&1) || { echo "⚠️  后端依赖安装有警告，继续..."; }
  echo "🗃  数据库迁移"
  (cd "$BACKEND" && npx prisma migrate deploy && npx prisma generate) || { echo "❌ 数据库迁移失败"; exit 1; }
}

seed_food() {
  if [ ! -d "$DATA_DIR" ]; then
    echo "⬇️  拉取食物成分数据"; mkdir -p "$ROOT/.data"
    git clone --depth 1 https://github.com/Sanotsu/china-food-composition-data "$DATA_REPO" >/dev/null 2>&1
  fi
  echo "🍚 导入食物库"
  (cd "$BACKEND" && DATA_DIR="$DATA_DIR" npx tsx scripts/seed/seed_food_standard.ts)
}

SEED_FLAG="$ROOT/.data/.seed_done"

seed_if_empty() {
  if [ -f "$SEED_FLAG" ]; then
    echo "🍚 食物库已初始化，跳过导入"
  else
    echo "🍚 食物库为空，开始导入"
    seed_food
    mkdir -p "$ROOT/.data"
    touch "$SEED_FLAG"
  fi
}

prepare_frontend() {
  [ -d "$FRONTEND" ] || { echo "⚠️  frontend/ 不存在（T13 未执行），跳过前端启动。后端将单独运行。"; return 1; }
  echo "📦 安装前端依赖"
  (cd "$FRONTEND" && npm install --no-audit 2>&1) || { echo "⚠️  前端依赖安装有警告，继续..."; }
  return 0
}

kill_port() {
  local port="$1"
  local pids
  pids="$(lsof -ti :"$port" 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "🔪 释放端口 $port (pid $pids)"
    kill -9 $pids 2>/dev/null || true
    sleep 0.3
  fi
}

run_all() {
  check_env
  start_db
  prepare_backend
  seed_if_empty
  kill_port 3000
  echo "🚀 启动后端 (后台)"
  (cd "$BACKEND" && npm run dev) & BACKEND_PID=$!
  sleep 2
  if prepare_frontend; then
    kill_port 8081
    echo "🚀 启动前端 (前台，Ctrl+C 退出会一并关闭后端)"
    (cd "$FRONTEND" && npx expo start --clear)
  else
    echo "🚀 后端运行中 (Ctrl+C 退出)。等 T13 建好 frontend/ 后本脚本会自动一起拉起前端。"
    wait "$BACKEND_PID"
  fi
}

run_ios() {
  check_env
  start_db
  prepare_backend
  seed_if_empty
  kill_port 3000
  echo "🚀 启动后端 (后台)"
  (cd "$BACKEND" && npm run dev) & BACKEND_PID=$!
  sleep 2
  prepare_frontend
  kill_port 8081
  echo "📱 编译并启动 iOS 模拟器 (首次需要几分钟)"
  (cd "$FRONTEND" && npx expo run:ios)
}

case "${1:-all}" in
  all)  run_all ;;
  ios)  run_ios ;;
  seed) check_env; start_db; seed_food ;;
  stop) docker stop fit-pg >/dev/null 2>&1 && echo "已停止 fit-pg" || echo "fit-pg 未运行" ;;
  *)    echo "用法: ./start.sh [all|seed|ios|stop]"; exit 1 ;;
esac
