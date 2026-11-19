#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
export PATH="$HOME/.local/bin:$HOME/.local/node/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo '請先從 https://nodejs.org/ 安裝 Node.js 24 LTS，再重新開啟此安裝器。'
  exit 1
fi
echo 'Herdr Workbench：先預覽安裝範圍；登入與權限由你親自確認。'
exec node setup.mjs --confirm "$@"
