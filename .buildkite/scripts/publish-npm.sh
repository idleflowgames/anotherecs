#!/usr/bin/env bash
set -euo pipefail

source .buildkite/scripts/setup-node.sh

PACKAGE_NAME=$(node -p "require('./package.json').name")
PACKAGE_VERSION=$(node -p "require('./package.json').version")
EXPECTED_TAG="v${PACKAGE_VERSION}"

if [[ -z "${BUILDKITE_TAG:-}" ]]; then
  echo "Refusing to publish ${PACKAGE_NAME}: this build is not running for a git tag." >&2
  exit 1
fi

if [[ "${BUILDKITE_TAG}" != "${EXPECTED_TAG}" ]]; then
  echo "Refusing to publish ${PACKAGE_NAME}: tag ${BUILDKITE_TAG} does not match ${EXPECTED_TAG}." >&2
  exit 1
fi

if [[ -z "${NPM_TOKEN:-}" ]]; then
  echo "Refusing to publish ${PACKAGE_NAME}: Buildkite secret NPM_TOKEN is not available." >&2
  exit 1
fi

cleanup() {
  rm -f .npmrc
}
trap cleanup EXIT

printf '//registry.npmjs.org/:_authToken=%s\n' "${NPM_TOKEN}" > .npmrc

echo "--- :package: installing dependencies"
pnpm install --frozen-lockfile

echo "--- :white_check_mark: verifying ${PACKAGE_NAME}@${PACKAGE_VERSION}"
pnpm verify:release

echo "--- :npm: publishing ${PACKAGE_NAME}@${PACKAGE_VERSION}"
pnpm publish --access public --no-git-checks
