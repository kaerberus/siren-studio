#!/usr/bin/env bash
# Run every dev suite against an isolated bridge and a throwaway workspace, so
# your live editor and your real project are never touched.
#
#   tests/bootstrap.sh     # once: fetch Node + jsdom if missing
#   tests/run.sh
#
# Override with TEST_ROOT, TEST_PORT, TEST_WORKSPACE, TEST_BASE.
# The chat and permissions suites additionally need the OpenCode service running.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

export TEST_ROOT="${TEST_ROOT:-/tmp/opencode/mermaid-tests}"
export TEST_PORT="${TEST_PORT:-8788}"
export TEST_WORKSPACE="${TEST_WORKSPACE:-$TEST_ROOT/workspace}"
export TEST_BASE="${TEST_BASE:-http://127.0.0.1:$TEST_PORT}"

NODE="$(command -v node || true)"
[ -n "$NODE" ] || NODE="$HERE/.node/bin/node"
if [ ! -x "$NODE" ]; then
  echo "no node found - run tests/bootstrap.sh first" >&2
  exit 1
fi
if [ ! -d "$HERE/node_modules/jsdom" ]; then
  echo "jsdom not installed - run tests/bootstrap.sh first" >&2
  exit 1
fi

mkdir -p "$TEST_WORKSPACE"
# Seed a diagram at the root BEFORE the bridge starts, so the diagrams directory
# resolves to the project root (".") rather than the graphs/ default. The
# suites assume bare filenames.
if [ ! -f "$TEST_WORKSPACE/example.mmd" ]; then
  printf 'flowchart TD\n    A[Start] --> B{Ready?}\n    B -->|yes| C[Go]\n    B -->|no| A\n' \
    > "$TEST_WORKSPACE/example.mmd"
fi
if [ ! -f "$TEST_WORKSPACE/example.gaps.md" ]; then
  printf '# Example - design gaps\n\n## Open questions\n- [ ] Retry policy? - *default:* 3 attempts\n' \
  > "$TEST_WORKSPACE/example.gaps.md"
fi

BRIDGE_PID=""
cleanup() {
  if [ -n "$BRIDGE_PID" ]; then
    kill "$BRIDGE_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if curl -sf --max-time 2 "$TEST_BASE/health" >/dev/null 2>&1; then
  echo "using the bridge already listening on $TEST_BASE"
else
  echo "starting a test bridge on $TEST_BASE (project: $TEST_WORKSPACE)"
  ( cd "$ROOT" && exec python3 bridge/server.py --port "$TEST_PORT" \
      --project "$TEST_WORKSPACE" --no-browser ) > "$TEST_ROOT/bridge.log" 2>&1 &
  BRIDGE_PID=$!
  for _ in $(seq 1 40); do
    curl -sf --max-time 1 "$TEST_BASE/health" >/dev/null 2>&1 && break
    sleep 0.25
  done
  if ! curl -sf --max-time 2 "$TEST_BASE/health" >/dev/null 2>&1; then
    echo "test bridge did not come up; see $TEST_ROOT/bridge.log" >&2
    exit 1
  fi
fi

if ! curl -sf --max-time 5 "$TEST_BASE/api/config" \
     | grep -q '"ok": *true'; then
  echo "note: OpenCode does not look reachable; the chat and permissions suites"
  echo "      need it running (opencode service status)."
fi

cd "$HERE"
passed=0
failed=0
run() {
  local name="$1"; shift
  printf '%-16s ' "$name"
  local out
  if out="$("$@" 2>&1)"; then
    printf '%s\n' "$(printf '%s\n' "$out" | grep -aE '[0-9]+/[0-9]+ passed' | tail -1)"
    passed=$((passed + 1))
  else
    printf 'FAILED\n'
    printf '%s\n' "$out" | grep -aE '^FAIL' | head -5 | sed 's/^/    /'
    printf '%s\n' "$out" > "$TEST_ROOT/$name.fail.log"
    printf '    full output: %s\n' "$TEST_ROOT/$name.fail.log"
    failed=$((failed + 1))
  fi
}

run smoke        "$NODE" smoke.mjs
run smart-view   "$NODE" smart-view.mjs
run export       "$NODE" export-e2e.mjs
run project      python3 project-setup.py
run bridge-api   python3 plugin-bridge.py
run chat         "$NODE" chat-e2e.mjs
run permissions  python3 permissions-e2e.py

echo
echo "$passed passed, $failed failed"
[ "$failed" -eq 0 ]
