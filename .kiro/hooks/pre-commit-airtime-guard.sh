#!/usr/bin/env bash
# Pre-commit airtime guard.
#
# Parses every *.schema.json (staged files by default, or paths given as
# arguments) with `ghostc check` and exits non-zero if any message's frame
# exceeds the airtime budget (4.0 s / 32 wire bytes at the 64 bps baseline),
# if the payload exceeds 52 bytes, or if a schema is invalid.
#
# Install (from the repo root):
#   cp .kiro/hooks/pre-commit-airtime-guard.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
# Or run it by hand:
#   bash .kiro/hooks/pre-commit-airtime-guard.sh [file.schema.json ...]
#
# Fails closed: if the compiler cannot be run, the commit is blocked.

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

files=()
if [ "$#" -gt 0 ]; then
  for arg in "$@"; do files+=("$arg"); done
else
  while IFS= read -r line; do
    [ -n "$line" ] && files+=("$line")
  done < <(git diff --cached --name-only --diff-filter=ACM | grep -E '\.schema\.json$' || true)
fi

if [ "${#files[@]}" -eq 0 ]; then
  exit 0
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "airtime-guard: pnpm not found; cannot verify airtime budget." >&2
  exit 1
fi

echo "airtime-guard: checking ${#files[@]} schema file(s)..."
if ! pnpm --silent exec tsx packages/schema-compiler/bin/ghostc.ts check "${files[@]}"; then
  echo "" >&2
  echo "airtime-guard: commit blocked. A schema exceeds the 4.0 s airtime budget (or is invalid)." >&2
  echo "Shrink the payload: narrow fields with quantizedInt, use booleans, or drop fields." >&2
  exit 1
fi

echo "airtime-guard: all schemas within budget."
