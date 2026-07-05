#!/usr/bin/env bash
# 改完后端代码后一键上线：重新构建 → 重启自启 job。
#   ./deploy/redeploy.sh
# prod 模式跑的是预编译的 dist，改代码不会自动生效，用这条重新部署。
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
BACKEND="$ROOT/backend"

echo "📦 重新构建"
cd "$BACKEND"
npm install --no-audit      # 依赖变了才有活干，没变几乎瞬间
npx prisma generate
npm run build

echo "🔄 重启 com.fit"
launchctl kickstart -k "gui/$(id -u)/com.fit"

echo ""
echo "✓ 已重新部署。日志: tail -f $ROOT/.data/launchd.log"
