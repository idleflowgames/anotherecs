#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${BUILDKITE_TAG:-}" ]]; then
  echo "No git tag present; skipping npm publish steps."
  exit 0
fi

cat <<'YAML' | buildkite-agent pipeline upload
steps:
  - block: ":npm: publish @idleflowgames/anotherecs"
    key: publish-approval
    prompt: "Publish the tagged package version to npm?"

  - label: ":npm: publish"
    key: publish
    depends_on: publish-approval
    command: .buildkite/scripts/publish-npm.sh
    timeout_in_minutes: 15
    secrets:
      - NPM_TOKEN
YAML
