#!/usr/bin/env bash
# SPDX-License-Identifier: MulanPSL-2.0
#
# Headless end-to-end verification of the Agent Hint wire contract.
#
# Starts a scripted OpenAI-compatible upstream, runs real `opencode run` /
# `opencode serve` processes against it with the built plugin loaded, and asserts
# on the captured requests (X-Agent-Hint contents, manage placeholders, ordering,
# msg_offset == wire message count).
#
# Usage: bash e2e/run.sh [A|B|C|all]
set -euo pipefail

cd "$(dirname "$0")/.."
REPO=$(pwd)
TMP="$REPO/e2e/.tmp"
PHASES=${1:-all}

npm run build >/dev/null

rm -rf "$TMP"
mkdir -p "$TMP"

OPENCODE=${OPENCODE_BIN:-opencode}
MODEL=mock/mock-model

fail() { echo "✗ $*" >&2; exit 1; }
note() { echo "· $*"; }

make_project() { # $1 = root
  local root=$1
  mkdir -p "$root/cfg" "$root/data" "$root/state" "$root/proj"
  node -e "require('fs').writeFileSync('$root/proj/seed.txt', 'seed line\n'.repeat(400))"
}

write_config() { # $1 = root, $2 = port, $3 = extra options json
  local root=$1 port=$2 extra=${3:-{\}}
  cat > "$root/proj/opencode.json" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "plugin": [["$REPO", $extra]],
  "provider": {
    "mock": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Mock",
      "options": { "baseURL": "http://127.0.0.1:$port/v1", "apiKey": "test" },
      "models": { "mock-model": { "name": "Mock", "limit": { "context": 200000, "output": 8192 } } }
    }
  }
}
EOF
}

MOCK_PID=""
MOCK_PORT=""
start_mock() { # $1 = capture file, $2 = mode
  node "$REPO/e2e/mock-upstream.mjs" --capture "$1" --mode "$2" > "$1.mock.log" 2>&1 &
  MOCK_PID=$!
  for _ in $(seq 1 100); do
    grep -q '^PORT=' "$1.mock.log" 2>/dev/null && break
    sleep 0.05
  done
  MOCK_PORT=$(sed -n 's/^PORT=//p' "$1.mock.log" | head -1)
  [ -n "$MOCK_PORT" ] || fail "mock upstream did not start"
}

stop_mock() {
  if [ -n "$MOCK_PID" ]; then
    kill "$MOCK_PID" 2>/dev/null || true
    wait "$MOCK_PID" 2>/dev/null || true
  fi
  MOCK_PID=""
}

SERVE_PID=""
stop_serve() {
  if [ -n "$SERVE_PID" ]; then
    kill "$SERVE_PID" 2>/dev/null || true
    wait "$SERVE_PID" 2>/dev/null || true
  fi
  SERVE_PID=""
}

export_env() { # $1 = root
  local root=$1
  export XDG_CONFIG_HOME="$root/cfg"
  export XDG_DATA_HOME="$root/data"
  export XDG_STATE_HOME="$root/state"
  export OPENCODE_DISABLE_EXTERNAL_SKILLS=1
  export OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1
}

trace_option() { # $1 = root
  echo "{\"trace\":{\"enabled\":true,\"file\":\"$1/trace.jsonl\"}}"
}

run_opencode() { # $1 = root, rest = args
  local root=$1
  shift
  ( cd "$root/proj" && timeout 180 "$OPENCODE" run --auto -m "$MODEL" "$@" ) >> "$root/run.log" 2>&1 \
    || fail "opencode run failed; see $root/run.log"
}

run_opencode_tolerant() { # expected non-zero exit: the surfaced overflow error
  local root=$1
  shift
  ( cd "$root/proj" && timeout 180 "$OPENCODE" run --auto -m "$MODEL" "$@" ) >> "$root/run.log" 2>&1 || true
}

verify() { # $1 = phase, $2 = capture
  node "$REPO/e2e/verify.mjs" "$1" "$2"
}

phase_a() {
  local root="$TMP/A"
  note "phase A: fresh session, then adoption in a new process"
  make_project "$root"
  export_env "$root"

  start_mock "$root/cap-A1.jsonl" A
  write_config "$root" "$MOCK_PORT" "$(trace_option "$root")"
  run_opencode "$root" "please read seed.txt"
  sleep 0.2
  stop_mock
  verify A1 "$root/cap-A1.jsonl"

  start_mock "$root/cap-A2.jsonl" A
  write_config "$root" "$MOCK_PORT" "$(trace_option "$root")"
  run_opencode "$root" --continue "please read seed.txt again"
  sleep 0.2
  stop_mock
  verify A2 "$root/cap-A2.jsonl"
}

phase_b() {
  local root="$TMP/B"
  note "phase B: two sessions in one server (headless pause/resume)"
  make_project "$root"
  export_env "$root"

  start_mock "$root/cap-B.jsonl" B
  write_config "$root" "$MOCK_PORT" "$(trace_option "$root")"
  local port
  port=$(node -e "const net=require('net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
  ( cd "$root/proj" && exec setsid "$OPENCODE" serve --hostname 127.0.0.1 --port "$port" > "$root/serve.log" 2>&1 < /dev/null ) &
  SERVE_PID=$!
  for _ in $(seq 1 400); do
    grep -q "server listening" "$root/serve.log" 2>/dev/null && break
    sleep 0.05
  done
  sleep 0.5
  local url=http://127.0.0.1:$port
  ( cd "$root/proj" && XDG_DATA_HOME="$root/data-client" timeout 180 "$OPENCODE" run --attach "$url" --auto -m "$MODEL" "first session" ) >> "$root/run.log" 2>&1 || fail "run 1 failed"
  sleep 0.5
  ( cd "$root/proj" && XDG_DATA_HOME="$root/data-client" timeout 180 "$OPENCODE" run --attach "$url" --auto -m "$MODEL" "second session" ) >> "$root/run.log" 2>&1 || fail "run 2 failed"
  sleep 0.5
  local session_a
  session_a=$(node -e "const fs=require('fs');const rows=fs.readFileSync('$root/cap-B.jsonl','utf8').trim().split('\n').map(JSON.parse);const first=rows.find(r=>r.tools&&r.tools.length);process.stdout.write(first.sessionHeader)")
  note "session A = $session_a"
  ( cd "$root/proj" && XDG_DATA_HOME="$root/data-client" timeout 180 "$OPENCODE" run --attach "$url" --auto -m "$MODEL" --session "$session_a" "back to the first session" ) >> "$root/run.log" 2>&1 || fail "run 3 failed"
  sleep 0.5
  stop_serve
  sleep 0.3
  stop_mock
  verify B "$root/cap-B.jsonl"
}

phase_c() {
  local root="$TMP/C"
  note "phase C: provider context overflow, compaction and retry"
  make_project "$root"
  export_env "$root"

  start_mock "$root/cap-C.jsonl" C
  write_config "$root" "$MOCK_PORT" "$(trace_option "$root")"
  run_opencode_tolerant "$root" "start a long task"
  sleep 0.2
  stop_mock
  verify C "$root/cap-C.jsonl"
}

signal_tui() { # $1 = root, $2 = type, $3 = session id
  local root=$1 type=$2 session=$3
  node --input-type=module - "$root" "$type" "$session" "$REPO" <<'NODE'
import fs from "node:fs"
import path from "node:path"
const root = process.argv[2]
const type = process.argv[3]
const sessionID = process.argv[4]
const repo = process.argv[5]
const { instanceFilePath } = await import(path.join(repo, "dist", "ipc.js"))
const file = instanceFilePath(path.join(root, "proj"))
if (!fs.existsSync(file)) { console.error("no instance file"); process.exit(1) }
const instance = JSON.parse(fs.readFileSync(file, "utf8"))
fetch(`http://127.0.0.1:${instance.port}/signal`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: instance.token, type, sessionID }),
}).then(async (response) => {
  if (!response.ok) { console.error(`signal failed: ${response.status}`); process.exit(1) }
  console.log(`signal ${type} ${sessionID.slice(0, 12)} delivered`)
})
NODE
}

phase_d() {
  local root="$TMP/D"
  note "phase D: TUI focus signals over the loopback channel"
  make_project "$root"
  export_env "$root"
  start_mock "$root/cap-D.jsonl" B
  write_config "$root" "$MOCK_PORT" "$(trace_option "$root")"
  local port
  port=$(node -e "const net=require('net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
  ( cd "$root/proj" && exec setsid "$OPENCODE" serve --hostname 127.0.0.1 --port "$port" > "$root/serve.log" 2>&1 < /dev/null ) &
  SERVE_PID=$!
  for _ in $(seq 1 400); do
    grep -q "server listening" "$root/serve.log" 2>/dev/null && break
    sleep 0.05
  done
  sleep 0.5
  local url=http://127.0.0.1:$port
  ( cd "$root/proj" && XDG_DATA_HOME="$root/data-client" timeout 180 "$OPENCODE" run --attach "$url" --auto -m "$MODEL" "focus session" ) >> "$root/run.log" 2>&1 || fail "run failed"
  sleep 0.5
  local session
  session=$(node -e "const fs=require('fs');const rows=fs.readFileSync('$root/cap-D.jsonl','utf8').trim().split('\n').map(JSON.parse);const first=rows.find(r=>r.tools&&r.tools.length);process.stdout.write(first.sessionHeader)")
  note "session = $session"
  signal_tui "$root" focus "$session"
  signal_tui "$root" blur "$session"
  sleep 0.5
  signal_tui "$root" focus "$session"
  sleep 0.5
  stop_serve
  sleep 0.3
  stop_mock
  verify D "$root/cap-D.jsonl"
}

trap 'stop_mock; stop_serve' EXIT

case "$PHASES" in
  A) phase_a ;;
  B) phase_b ;;
  C) phase_c ;;
  D) phase_d ;;
  all) phase_a; phase_b; phase_c; phase_d ;;
  *) fail "unknown phase: $PHASES" ;;
esac

echo "✓ e2e $PHASES passed"
