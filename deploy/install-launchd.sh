#!/usr/bin/env bash
# 安装 fit 后端的开机自启(用户级 LaunchAgent，不需要 sudo)。
# 首次部署：装依赖 → 迁移 → 构建 dist → 注册并启动 launchd job。
#
# 前置：
#   1. Docker Desktop 已装，且建议在「系统设置→通用→登录项」设为开机自启，
#      否则 launchd 起来时 docker daemon 没就绪，DB 拉不起来(KeepAlive 会兜底重试)。
#   2. ~/.cloudflared/config.yml 里已加 fit-api → localhost:9300 的 ingress
#      (见 docs/DEPLOY.md Step 2)；tunnel 本体由 market-cap-radar 的 launchd 守护。
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
BACKEND="$ROOT/backend"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
plist="com.fit.plist"

echo "📦 构建后端(prod)"
cd "$BACKEND"
npm install --no-audit
npx prisma generate
npm run build

echo "📂 注册 LaunchAgent"
mkdir -p "$LAUNCH_AGENTS" "$ROOT/.data"
cp "$DIR/$plist" "$LAUNCH_AGENTS/$plist"
launchctl unload "$LAUNCH_AGENTS/$plist" 2>/dev/null || true
launchctl load "$LAUNCH_AGENTS/$plist"

echo ""
echo "✓ 已安装并启动 com.fit"
echo "  重启/重新登录会自动拉起后端。"
echo "  立即触发一次: launchctl kickstart -k gui/$(id -u)/com.fit"
echo "  查看状态:     launchctl list | grep com.fit"
echo "  日志:         tail -f $ROOT/.data/launchd.log"
