#!/usr/bin/env bash
# 启动本地 bridge（Chrome 扩展的后端）
set -euo pipefail
cd "$(dirname "$0")"

PORT="${BRIDGE_PORT:-47391}"

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "端口 $PORT 已被占用，可能 bridge 已在运行："
  curl -s --max-time 2 "http://127.0.0.1:$PORT/health" || true
  echo
  exit 0
fi

echo "启动 annotation-bridge on http://127.0.0.1:$PORT"
echo "（Ctrl-C 退出）"
echo
exec node bridge.mjs
