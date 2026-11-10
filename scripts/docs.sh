#!/usr/bin/env bash
# Regenerate SDK reference artifacts and validate the Mintlify docs site.
#
# Usage:
#   scripts/docs.sh
#
# Requires: Python with sphinx/httpx/websockets, Node 20.17+ (for the mint CLI).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Prefer the repository docs virtualenv when it exists.
if [ -x "$ROOT/.venv-docs/bin/python" ]; then
  PYTHON="$ROOT/.venv-docs/bin/python"
else
  PYTHON="${PYTHON:-python3}"
fi

echo "==> Python SDK reference (Sphinx JSON)"
rm -rf "$ROOT/docs/sdk-artifacts/python"
PYTHONPATH="$ROOT/python" "$PYTHON" -m sphinx -b json \
  "$ROOT/python/docs/source" "$ROOT/docs/sdk-artifacts/python"

# Keep only the .fjson pages Mintlify consumes. Sphinx also writes pickles and
# static site scaffolding that embed build-machine paths and are not needed.
find "$ROOT/docs/sdk-artifacts/python" -type f ! -name '*.fjson' -delete
find "$ROOT/docs/sdk-artifacts/python" -type d -empty -delete

echo "==> TypeScript SDK reference (TypeDoc JSON)"
cd "$ROOT/typescript"
if [ ! -d node_modules ]; then
  npm ci
fi
npm run docs:typedoc

echo "==> Mintlify validation"
cd "$ROOT/docs"
npx -y mint@latest validate

echo "==> Mintlify broken links"
npx -y mint@latest broken-links

echo "==> Docs build complete"
