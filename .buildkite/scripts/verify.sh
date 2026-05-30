#!/usr/bin/env bash
set -euo pipefail

source .buildkite/scripts/setup-node.sh

echo "--- :package: installing dependencies"
pnpm install --frozen-lockfile

echo "--- :typescript: verifying package"
pnpm verify:release
