#!/usr/bin/env bash
# On-schema-change hook: compile, check the 32-byte frame budget, run the property tests.
#
# Triggered by the Kiro hooks on-schema-created-pbt / on-schema-saved-pbt whenever a
# *.schema.json is created or saved. Can also be run by hand:
#   bash .kiro/hooks/on-schema-change-pbt.sh [path/to/X.schema.json ...]
#
# Steps (stops at the first failure, exit code 1):
#   1. ghostc compile          regenerate types.ts / serializers.ts / opcodes.ts
#   2. ghostc check            every frame must stay within 32 bytes and 4.0 s of airtime
#   3. run_pbt_suite           same runner as the ghost-mcp tool: round-trip, budget and ARQ properties
#
# Which schemas changed is only used for the log: compile and check always cover the whole
# schemas folder, because opcodes and names must stay unique across it.

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

schemas_dir="packages/schema-compiler/schemas"
max_frame_bytes=32

changed=()
if [ "$#" -gt 0 ]; then
  for arg in "$@"; do changed+=("$arg"); done
else
  # New (untracked) or modified schema files.
  while IFS= read -r line; do
    path="${line:3}"
    case "$path" in
      *.schema.json) changed+=("$path") ;;
    esac
  done < <(git status --porcelain --untracked-files=all)
fi

if [ "${#changed[@]}" -eq 0 ]; then
  echo "on-schema-change: no changed .schema.json files, nothing to do."
  exit 0
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "on-schema-change: pnpm not found; cannot verify the schemas." >&2
  exit 1
fi

echo "on-schema-change: ${#changed[@]} schema file(s): ${changed[*]}"

echo
echo "[1/3] ghostc compile"
if ! pnpm --silent compile; then
  echo "on-schema-change: compilation failed." >&2
  exit 1
fi

echo
echo "[2/3] frame budget (<= ${max_frame_bytes} bytes, <= 4.0 s)"
shopt -s nullglob
all_schemas=("$schemas_dir"/*.schema.json)
if ! pnpm --silent exec tsx packages/schema-compiler/bin/ghostc.ts check "${all_schemas[@]}"; then
  echo "on-schema-change: a frame exceeds ${max_frame_bytes} bytes or the airtime budget." >&2
  exit 1
fi
echo "all frames within ${max_frame_bytes} bytes"

echo
echo "[3/3] run_pbt_suite"
if ! pnpm --silent --filter @ghost-acoustics/ghost-mcp pbt; then
  echo "on-schema-change: property tests failed." >&2
  exit 1
fi

echo
echo "on-schema-change: OK"
