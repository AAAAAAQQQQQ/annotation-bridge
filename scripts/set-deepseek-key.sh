#!/bin/bash
# 把 DeepSeek API key 写进 DSH 的「Harness home」env 文件（默认 ~/.dsh/.env）。
#
# - 交互式输入（不回显），也可以 DEEPSEEK_API_KEY=... 传进来
# - 文件 chmod 600，且不在任何 git 仓库里
# - 只替换 DEEPSEEK_API_KEY 这一行，其它变量保留
set -euo pipefail
ENV_FILE="${DSH_ENV_FILE:-$HOME/.dsh/.env}"

KEY="${DEEPSEEK_API_KEY:-}"
if [ -z "$KEY" ]; then
  if [ -t 0 ]; then
    printf 'DeepSeek API key (sk-...): '
    stty -echo 2>/dev/null || true
    IFS= read -r KEY
    stty echo 2>/dev/null || true
    echo
  else
    IFS= read -r KEY
  fi
fi
if [ -z "$KEY" ]; then
  echo "empty key, nothing written" >&2
  exit 1
fi

mkdir -p "$(dirname "$ENV_FILE")"
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"

tmp="$(mktemp)"
grep -v '^DEEPSEEK_API_KEY=' "$ENV_FILE" > "$tmp" 2>/dev/null || true
printf 'DEEPSEEK_API_KEY=%s\n' "$KEY" >> "$tmp"
mv "$tmp" "$ENV_FILE"
chmod 600 "$ENV_FILE"

echo "已写入 $ENV_FILE (mode 600)"
echo "验证：dsh --profile headless --json '只回复 ok'"
