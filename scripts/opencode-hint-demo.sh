#!/usr/bin/env bash
# SPDX-License-Identifier: MulanPSL-2.0
#
# Launch the user's normal opencode TUI with the local plugin injected through an
# extra config file. Global config (providers, credentials, existing plugins) is
# left untouched: OPENCODE_CONFIG is merged by opencode 1.18.x.
#
# The plugin's opt-in trace is written to a scratch JSONL file; run
# `npm run hint:watch` in another terminal to see the decoded hints live.
#
# Usage:
#   bash scripts/opencode-hint-demo.sh [--no-build] [--keep-trace] [--dir <path>] [-- <opencode args>]
#
# The trace path is printed on startup and defaults to
# $TMPDIR/opencode-agent-hints-demo/trace.jsonl.
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
BASE=${AGENT_HINTS_DEMO_DIR:-${TMPDIR:-/tmp}/opencode-agent-hints-demo}
BUILD=1
KEEP=0
OPENCODE_BIN=${OPENCODE_BIN:-opencode}
opencode_args=()

while [ $# -gt 0 ]; do
  case "$1" in
    --no-build) BUILD=0; shift ;;
    --keep-trace) KEEP=1; shift ;;
    --dir)
      [ $# -ge 2 ] || { echo "--dir needs a path" >&2; exit 2; }
      BASE=$2
      shift 2
      ;;
    --help | -h)
      sed -n '4,15p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    --)
      shift
      opencode_args=("$@")
      break
      ;;
    *)
      opencode_args+=("$1")
      shift
      ;;
  esac
done

if [ ! -f "$REPO/dist/index.js" ] || [ "$BUILD" = "1" ]; then
  npm --prefix "$REPO" run build >/dev/null
fi

umask 077
mkdir -p "$BASE"
chmod 700 "$BASE"

TRACE=$BASE/trace.jsonl
if [ "$KEEP" = "0" ]; then
  : > "$TRACE"
fi
chmod 600 "$TRACE" 2>/dev/null || true

INJECT=$BASE/opencode.json
node -e '
const fs = require("fs")
const [repo, trace, out] = process.argv.slice(1)
const config = {
  plugin: [[repo, { trace: { enabled: true, file: trace } }]],
}
fs.writeFileSync(out, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
' "$REPO" "$TRACE" "$INJECT"

echo "· plugin   $REPO"
echo "· config   $INJECT (OPENCODE_CONFIG, merged with your normal config)"
echo "· trace    $TRACE"
echo "· viewer   npm run hint:watch"
echo

exec env OPENCODE_CONFIG="$INJECT" AGENT_HINTS_TRACE_FILE="$TRACE" "$OPENCODE_BIN" "${opencode_args[@]}"
