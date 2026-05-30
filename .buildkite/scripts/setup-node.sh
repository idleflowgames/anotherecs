#!/usr/bin/env bash
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-24}"

if ! command -v mise >/dev/null 2>&1; then
  echo "--- :package: installing mise"
  curl -fsSL https://mise.run | sh
  export PATH="$HOME/.local/bin:$PATH"
fi

echo "--- :node: installing node@${NODE_VERSION}"
mise install "node@${NODE_VERSION}"
mise use --global "node@${NODE_VERSION}"
eval "$(mise env -s bash)"

echo "node: $(node --version)"

PNPM_VERSION=$(node -e "const pm = require('./package.json').packageManager; console.log(pm.split('@')[1].split('+')[0])")
echo "--- :pnpm: activating pnpm@${PNPM_VERSION}"
corepack enable
corepack prepare "pnpm@${PNPM_VERSION}" --activate
echo "pnpm: $(pnpm --version)"
