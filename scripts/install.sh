#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${1:-web}"
ACTION="${2:-install}"
ARCHIVE="$PROJECT_DIR/dist/dsh-three-pane-0.5.1.tgz"
APP='/Applications/DeepSeek Harness.app/Contents'

if [[ "$PROFILE" == 'desktop' ]]; then
  echo 'DeepSeek Harness Desktop 专门管理 desktop profile，不能通过 CLI 安装或卸载。' >&2
  echo '请在应用中打开「插件 → 添加插件 → 安装第三方插件」，输入以下本地包路径：' >&2
  echo "$ARCHIVE" >&2
  exit 2
fi

run_dsh() {
  if command -v dsh >/dev/null 2>&1; then
    dsh "$@"
  elif [[ -x "$APP/MacOS/DeepSeek Harness" ]]; then
    ELECTRON_RUN_AS_NODE=1 "$APP/MacOS/DeepSeek Harness" \
      "$APP/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" "$@"
  else
    echo '未找到 dsh 命令或 DeepSeek Harness.app。请先安装并启动 Harness。' >&2
    exit 1
  fi
}

if [[ "$ACTION" == 'remove' ]]; then
  run_dsh plugin --profile "$PROFILE" remove dsh-three-pane
elif [[ "$ACTION" == 'install' ]]; then
  if [[ ! -f "$ARCHIVE" ]]; then
    echo "未找到安装包：$ARCHIVE。请先在项目目录运行 npm run check 和 npm pack --pack-destination dist。" >&2
    exit 1
  fi
  run_dsh plugin --profile "$PROFILE" add "$ARCHIVE"
else
  echo '用法：bash scripts/install.sh [desktop|其他 profile 名称] [install|remove]' >&2
  exit 1
fi
echo '完成。请重新启动 Harness，使客户端插件重新加载。'
