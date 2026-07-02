#!/usr/bin/env bash
# 构建 iOS App 并安装到已连接的 iPhone
# 自动使用 Cloudflare Tunnel 公网地址作为 API
set -euo pipefail

FRONTEND="$(cd "$(dirname "$0")" && pwd)"
TUNNEL_URL="https://fit-api.refinely.app"

echo "📱 构建 iOS App → iPhone"
echo "   API: ${TUNNEL_URL}"
echo ""

cd "$FRONTEND"
EXPO_PUBLIC_API_URL="${TUNNEL_URL}" npx expo run:ios --device
