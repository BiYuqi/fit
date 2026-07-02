# 一键部署方案：Cloudflare Tunnel + 自定义域名

## 架构

```
iPhone (Xcode 安装)
    │
    │  https://fit-api.refinely.app
    ▼
Cloudflare Tunnel (已有: market-cap-radar)
    │
    │  localhost:3000
    ▼
Mac 后端 (fastify + prisma + postgres)
```

一个脚本拉起全部：DB → 后端 → Tunnel 公网暴露。前端走 Xcode USB 直装。

---

## Step 1: 配 DNS（一次性的，30 秒）

在 Cloudflare Dashboard → 你的域名 `refinely.app` → DNS：

| 类型 | 名称 | 目标 |
|------|------|------|
| CNAME | `fit-api` | `27360821-0661-445d-b247-8ae8b7f8ea8a.cfargotunnel.com` |

（Tunnel UUID 来自 `cloudflared tunnel list` 的输出，已有）

---

## Step 2: 加 Tunnel ingress（一次性的）

编辑 `~/.cloudflared/config.yml`，在现有 ingress 列表里加一条：

```yaml
tunnel: 27360821-0661-445d-b247-8ae8b7f8ea8a
credentials-file: /Users/0xbyte/.cloudflared/27360821-0661-445d-b247-8ae8b7f8ea8a.json

ingress:
  - hostname: radar.refinely.app
    service: http://localhost:9257
  - hostname: radar-api.refinely.app
    service: http://localhost:9256
  # ↓ 新增
  - hostname: fit-api.refinely.app
    service: http://localhost:3000
  # ↑ 新增
  - service: http_status:404
```

然后重启 tunnel：

```bash
sudo cloudflared tunnel stop market-cap-radar
cloudflared tunnel run market-cap-radar
```

（如果 tunnel 是以 service 方式跑的，先 `sudo launchctl unload` 再 `load`）

---

## Step 3: 新建一键部署脚本

在项目根目录新建 `deploy.sh`：

```bash
#!/usr/bin/env bash
# 一键部署：DB + 后端 + Cloudflare Tunnel
# 手机端通过 https://fit-api.refinely.app 访问
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
BACKEND="$ROOT/backend"
BACKEND_PID=""

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
  
  # 释放端口
  lsof -ti :3000 | xargs kill -9 2>/dev/null || true
  
  echo "🚀 启动后端 :3000"
  (cd "$BACKEND" && npm run dev) & BACKEND_PID=$!
  sleep 2
}

# ── Tunnel ────────────────────────────────────
ensure_tunnel() {
  if pgrep -f "cloudflared tunnel run market-cap-radar" >/dev/null; then
    echo "🟢 Tunnel 已在运行"
  else
    echo "🌐 启动 Cloudflare Tunnel"
    cloudflared tunnel run market-cap-radar &
    sleep 3
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
echo "   API:  https://fit-api.refinely.app"
echo "   Ctrl+C 停止后端"
echo ""
echo "📱 前端安装："
echo "   cd frontend"
echo "   EXPO_PUBLIC_API_URL=https://fit-api.refinely.app npx expo run:ios --device"

wait "$BACKEND_PID"
```

---

## Step 4: 前端环境变量

在 `frontend/.env` 里固定 API 地址（Xcode build 会读这个）：

```bash
# frontend/.env
EXPO_PUBLIC_API_URL=https://fit-api.refinely.app
```

创建后，后续 `npx expo run:ios --device` 自动用这个 URL，不用每次手打。

---

## 日常使用

```bash
# Mac 上
./deploy.sh          # 一键部署后端 + tunnel

# 前端改代码后重新装手机
cd frontend && npx expo run:ios --device

# 如果只是 JS 层热更（不改原生）
cd frontend && npx expo start --dev-client
```

Tunnel 只要 Mac 不关机就一直活着。出门拿手机打开 App 就能用。
