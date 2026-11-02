#!/bin/bash
# 安装 Chrome 原生消息宿主（一次性）。装完扩展就不需要任何端口/服务/开关。
set -e
ROOT="$HOME/Project/annotation-bridge"
EXT="$ROOT/extension"
HOST="$ROOT/host/run.sh"

# 未打包扩展的 ID = sha256(绝对路径) 前 16 字节，每个 nibble 映射到 a-p
ID=$(python3 - "$EXT" <<'PY'
import hashlib, sys
h = hashlib.sha256(sys.argv[1].encode()).hexdigest()[:32]
print(''.join(chr(ord('a') + int(c, 16)) for c in h))
PY
)

chmod +x "$HOST" "$ROOT/host/host.mjs"
mkdir -p "$HOME/Library/Logs"

write_manifest() {
  local dir="$1"
  mkdir -p "$dir"
  cat > "$dir/com.gjr.annotation_bridge.json" <<JSON
{
  "name": "com.gjr.annotation_bridge",
  "description": "annotation-bridge native host",
  "path": "$HOST",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$ID/"]
}
JSON
  echo "  → $dir/com.gjr.annotation_bridge.json"
}

echo "扩展 ID: $ID"
write_manifest "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
write_manifest "$HOME/Library/Application Support/Google/Chrome for Testing/NativeMessagingHosts"
write_manifest "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
echo "完成。重启 Chrome 后，扩展会直接拉起本地宿主，不再需要端口和 start.sh。"
echo
echo "注意：Chrome 的用户级宿主目录跟着 user-data-dir 走。"
echo "      如果你用 --user-data-dir=/x 启动，清单要放到 /x/NativeMessagingHosts/。"
echo "      验证：tail -f ~/Library/Logs/annotation-bridge-native.log，"
echo "      看到 'host 启动' 就是走通了原生通道。"
