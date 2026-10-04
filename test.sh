#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$PWD/.test-browsers}"
if [[ ! -d node_modules/playwright ]]; then
  npm ci --ignore-scripts --cache "$PWD/.npm-cache"
fi
node node_modules/playwright/cli.js install firefox
node --check content.js
node --check background.js
npm test
