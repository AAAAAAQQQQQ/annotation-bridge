#!/bin/bash
# 构建并安装「标注投递.app」到 ~/Applications。
# 用 Homebrew python3 + PyObjC 跑菜单栏；不需要 Xcode、不需要编译。
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${APP_PATH:-$HOME/Applications/标注投递.app}"

# Finder 启动时 PATH 很干净，必须写死解释器绝对路径
PY=""
for c in /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
  if [ -x "$c" ] && "$c" -c 'import AppKit' >/dev/null 2>&1; then PY="$c"; break; fi
done
if [ -z "$PY" ]; then
  echo "❌ 找不到带 PyObjC 的 python3" >&2
  echo "   brew install python3 && /opt/homebrew/bin/python3 -m pip install pyobjc" >&2
  exit 1
fi

echo "==> 解释器 $PY"
echo "==> 组装 $APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$ROOT/app/Info.plist" "$APP/Contents/Info.plist"
cp "$ROOT/app/app.py" "$APP/Contents/Resources/app.py"

cat > "$APP/Contents/MacOS/AnnotationBridge" <<SH
#!/bin/bash
HERE="\$(cd "\$(dirname "\$0")/.." && pwd)"
LOG="\$HOME/Library/Logs/annotation-bridge-app.log"
# CLI 模式保持 stdout 干净（给脚本用）；GUI 模式把异常写进日志
case "\$1" in
  --*) exec "$PY" "\$HERE/Resources/app.py" "\$@" ;;
  *)   echo "\$(date '+%Y-%m-%d %H:%M:%S') launcher: \$0 \$@" >> "\$LOG"
       exec "$PY" "\$HERE/Resources/app.py" "\$@" >> "\$LOG" 2>&1 ;;
esac
SH
chmod +x "$APP/Contents/MacOS/AnnotationBridge"

# 图标：拿扩展已有的 png 生成 .icns
ICONSET="$(mktemp -d)/AppIcon.iconset"
mkdir -p "$ICONSET"
SRC="$ROOT/extension/icons/icon128.png"
[ -f "$SRC" ] || SRC="$ROOT/extension/icons/icon48.png"
sips -z 16 16     "$SRC" --out "$ICONSET/icon_16x16.png"       >/dev/null
sips -z 32 32     "$SRC" --out "$ICONSET/icon_16x16@2x.png"    >/dev/null
sips -z 32 32     "$SRC" --out "$ICONSET/icon_32x32.png"       >/dev/null
sips -z 64 64     "$SRC" --out "$ICONSET/icon_32x32@2x.png"    >/dev/null
sips -z 128 128   "$SRC" --out "$ICONSET/icon_128x128.png"     >/dev/null
sips -z 256 256   "$SRC" --out "$ICONSET/icon_128x128@2x.png"  >/dev/null
sips -z 256 256   "$SRC" --out "$ICONSET/icon_256x256.png"     >/dev/null
sips -z 512 512   "$SRC" --out "$ICONSET/icon_256x256@2x.png"  >/dev/null
sips -z 512 512   "$SRC" --out "$ICONSET/icon_512x512.png"     >/dev/null
sips -z 1024 1024 "$SRC" --out "$ICONSET/icon_512x512@2x.png"  >/dev/null
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns" 2>/dev/null || true
rm -rf "$(dirname "$ICONSET")"

codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
# 反复重新构建后 LaunchServices 可能还记着旧包，刷新一下，否则 open 会“没反应”
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -f "$APP" >/dev/null 2>&1 || true

echo "==> 完成：$APP"
echo "    命令行："
echo "      \"$APP/Contents/MacOS/AnnotationBridge\" --status"
echo "      \"$APP/Contents/MacOS/AnnotationBridge\" --open-panel"
