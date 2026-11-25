#!/usr/bin/env bash
# SPDX-License-Identifier: MulanPSL-2.0
#
# Real-gateway end-to-end run: opencode → agent-hint-watcher (MITM) → gateway.
# The watcher decodes the X-Agent-Hint header and records the wire shape; the
# gateway is the real one from the user's opencode config, so this proves the
# header survives a real provider round trip.
#
# Secrets never leave the scratch dir: the API key is read from the user's config,
# written into the scratch opencode.json, and never echoed.
#
# Usage: bash e2e/real-gateway.sh [model]
set -euo pipefail

cd "$(dirname "$0")/.."
REPO=$(pwd)
TMP="$REPO/e2e/.tmp/real"
MODEL=${1:-火山AI网关/volcengine/deepseek-v4.1-flash}
WATCHER=${WATCHER:-$HOME/agent-hint-watcher/agent-hint-watcher.mjs}
LISTEN=${LISTEN:-8898}
CONFIG=${OPENCODE_GLOBAL_CONFIG:-$HOME/.config/opencode/opencode.jsonc}

[ -f "$WATCHER" ] || { echo "watcher not found: $WATCHER" >&2; exit 1; }
[ -f "$CONFIG" ] || { echo "opencode config not found: $CONFIG" >&2; exit 1; }
npm run build >/dev/null

rm -rf "$TMP"
mkdir -p "$TMP/cfg" "$TMP/data" "$TMP/state" "$TMP/proj"
node -e "require('fs').writeFileSync('$TMP/proj/seed.txt', ('agent hint real gateway run\n').repeat(120))"

PROVIDER=${MODEL%%/*}
READ_CONFIG=$CONFIG node - "$TMP" "$PROVIDER" "$MODEL" "$LISTEN" "$REPO" <<'NODE'
const fs = require("fs")
const path = require("path")
const [tmp, providerID, model, listen, repo] = process.argv.slice(2)
const strip = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/,(\s*[}\]])/g, "$1")
const config = JSON.parse(strip(fs.readFileSync(process.env.READ_CONFIG, "utf8")))
const provider = config.provider?.[providerID]
if (!provider) {
  console.error(`provider "${providerID}" not found in the opencode config`)
  process.exit(1)
}
const baseURL = provider.options?.baseURL
const apiKey = provider.options?.apiKey
if (!baseURL || !apiKey) {
  console.error(`provider "${providerID}" needs options.baseURL and options.apiKey`)
  process.exit(1)
}
const host = new URL(baseURL).host
const modelID = model.slice(providerID.length + 1)
const scratch = {
  $schema: "https://opencode.ai/config.json",
  plugin: [[repo, { trace: { enabled: true, file: path.join(tmp, "trace.jsonl") } }]],
  provider: {
    [providerID]: {
      npm: provider.npm,
      name: provider.name,
      options: { baseURL: `http://127.0.0.1:${listen}/v1`, apiKey },
      models: { [modelID]: provider.models?.[modelID] ?? { name: modelID } },
    },
  },
}
fs.writeFileSync(path.join(tmp, "proj", "opencode.json"), JSON.stringify(scratch, null, 2))
fs.writeFileSync(path.join(tmp, "upstream.txt"), host)
NODE
UPSTREAM=$(cat "$TMP/upstream.txt")
echo "· upstream $UPSTREAM · model $MODEL"

node "$WATCHER" --upstream "$UPSTREAM" --listen "$LISTEN" --capture "$TMP/cap.jsonl" --capture-body > "$TMP/watcher.log" 2>&1 &
WATCH_PID=$!
trap 'kill $WATCH_PID 2>/dev/null || true' EXIT
sleep 1

export XDG_CONFIG_HOME="$TMP/cfg"
export XDG_DATA_HOME="$TMP/data"
export XDG_STATE_HOME="$TMP/state"
export OPENCODE_DISABLE_EXTERNAL_SKILLS=1
export OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1
cd "$TMP/proj"
timeout 300 opencode run --auto -m "$MODEL" "Read seed.txt with the read tool, then tell me how many lines it has." \
  > "$TMP/run.log" 2>&1 || echo "· opencode run exited non-zero (see e2e/.tmp/real/run.log)"
sleep 1
kill $WATCH_PID 2>/dev/null || true
wait $WATCH_PID 2>/dev/null || true

cd "$REPO"
node e2e/verify-real.mjs "$TMP/cap.jsonl" "$TMP/evidence.jsonl" "$TMP/trace.jsonl"
