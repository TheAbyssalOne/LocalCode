#!/usr/bin/env bash
# Thin shim. All setup logic lives in scripts/setup.mjs so every platform runs one code path.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20+ is required. Install it from https://nodejs.org/ and re-run." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node.js 20+ is required; found $(node --version)." >&2
  exit 1
fi

exec node "$SCRIPT_DIR/setup.mjs" "$@"
