#!/usr/bin/env bash
# 卸载 fit 后端的开机自启。不动 DB 容器和 tunnel。
set -euo pipefail
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
plist="com.fit.plist"

launchctl unload "$LAUNCH_AGENTS/$plist" 2>/dev/null || true
rm -f "$LAUNCH_AGENTS/$plist"
echo "✓ 已卸载 com.fit(DB 容器与 tunnel 未动)"
