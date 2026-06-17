#!/usr/bin/env bash
# QA pass: prism-dev refresh across harnesses + MCP ownership checks.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGINS="${PRISM_PLUGINS:-$HOME/Projects/prism-plugins}"
PRISM_DEV="${PRISM_DEV:-prism-dev}"
SANDBOX="${SANDBOX:-$(mktemp -d /tmp/prism-qa-all.XXXXXX)}"
REPORT="$SANDBOX/qa-report.md"

export PRISM_HOME="$SANDBOX/prism-home"
export PRISM_MCP_DISABLE_LAUNCHD=1

# MCP owner plugins (canonical tools / CLI wrappers — not orbit consumers)
OWNERS=(
  agent-foundations booth forge grok-agent hotmart-cli meta-ads-cli
  package-authoring quasar tower typefully-cli workflows
)
# Orbit consumers that must NOT get their own MCP runtime dir
CONSUMERS=(
  atelier beacon cartography manual showcase scribe survey funnel oracle
)

COMPILE_HARNESSES=(
  codex-cli opencode amp-code hermes cursor claude-code grok
  factory-droid antigravity-cli kimi-code pi
)

mkdir -p "$SANDBOX/roots"
echo "$SANDBOX" > /tmp/prism-qa-sandbox-latest.txt

log() { echo "$*" | tee -a "$REPORT"; }
section() { echo "" >> "$REPORT"; echo "## $1" >> "$REPORT"; echo "" >> "$REPORT"; }
pass() { log "- ✅ $1"; }
fail() { log "- ❌ $1"; FAILURES=$((FAILURES + 1)); }
warn() { log "- ⚠️ $1"; }

FAILURES=0

{
  echo "# prism-dev harness QA report"
  echo ""
  echo "Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "Sandbox: \`$SANDBOX\`"
  echo "Plugins: \`$PLUGINS\`"
  echo "PRISM_DEV: \`$PRISM_DEV\`"
} > "$REPORT"

section "Baseline"
if (cd "$ROOT" && bun run typecheck >> "$SANDBOX/typecheck.log" 2>&1); then
  pass "typecheck"
else
  fail "typecheck (see $SANDBOX/typecheck.log)"
fi

if (cd "$ROOT" && bun test src/compile/tool-bindings.test.ts src/compile/amp-code-ownership.test.ts \
  src/compile/mcp-ownership-pipeline.test.ts src/compile/mcp-ownership-backpressure.test.ts \
  >> "$SANDBOX/unit-tests.log" 2>&1); then
  pass "ownership unit tests (9)"
else
  fail "ownership unit tests (see $SANDBOX/unit-tests.log)"
fi

section "Compile refresh per harness (--compile-only)"

for harness in "${COMPILE_HARNESSES[@]}"; do
  out="$SANDBOX/roots/$harness"
  mkdir -p "$out"
  logfile="$SANDBOX/refresh-$harness.log"
  if (cd "$ROOT" && $PRISM_DEV refresh --plugins "$PLUGINS" \
    --harness "$harness" --scope global \
    --compile-root "$out" --compile-only \
    > "$logfile" 2>&1); then
    if rg -q "All plugin refreshes completed successfully" "$logfile" 2>/dev/null \
      || rg -q "Successful refreshes: 78" "$logfile" 2>/dev/null; then
      summary=$(rg "Successful refreshes:" "$logfile" 2>/dev/null | tail -1 || echo "ok")
      pass "$harness refresh — $summary"
    else
      fail "$harness refresh incomplete (log: $logfile)"
      tail -8 "$logfile" >> "$REPORT" 2>/dev/null || true
    fi
  else
    fail "$harness refresh exited non-zero (log: $logfile)"
    tail -8 "$logfile" >> "$REPORT" 2>/dev/null || true
  fi
done

section "MCP runtime ownership (shared PRISM_HOME)"

mcp_count=$(ls -1 "$PRISM_HOME/runtime/mcp" 2>/dev/null | wc -l | tr -d ' ')
if [[ "$mcp_count" == "11" ]]; then
  pass "runtime/mcp dir count = 11"
else
  fail "runtime/mcp dir count = $mcp_count (expected 11)"
fi

for owner in "${OWNERS[@]}"; do
  if [[ -d "$PRISM_HOME/runtime/mcp/$owner" ]]; then
    pass "owner runtime present: $owner"
  else
    fail "missing owner runtime: $owner"
  fi
done

for consumer in "${CONSUMERS[@]}"; do
  if [[ -d "$PRISM_HOME/runtime/mcp/$consumer" ]]; then
    fail "consumer façade runtime should be absent: $consumer"
  else
    pass "no consumer façade: $consumer"
  fi
done

section "MCP HTTP handshake (sample owners)"

mcp_handshake() {
  local name=$1 port=$2
  local INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"qa","version":"0"}}}'
  local SESSION
  SESSION=$(curl -s -D - -o /dev/null -X POST "http://127.0.0.1:$port/mcp" \
    -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
    -d "$INIT" 2>/dev/null | tr -d '\r' | rg -i '^mcp-session-id:' | awk '{print $2}' || true)
  if [[ -z "$SESSION" ]]; then
    fail "$name MCP initialize failed (port $port)"
    return
  fi
  local LIST='{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
  local count
  count=$(curl -s -X POST "http://127.0.0.1:$port/mcp" \
    -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
    -H "Mcp-Session-Id: $SESSION" -d "$LIST" 2>/dev/null \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('result',{}).get('tools',[])))" 2>/dev/null || echo "ERR")
  if [[ "$count" =~ ^[0-9]+$ ]] && [[ "$count" -gt 0 ]]; then
    pass "$name tools/list = $count tools (port $port)"
  else
    fail "$name tools/list failed (port $port, got $count)"
  fi
}

# Start a few representative daemons
for sample in tower booth workflows; do
  plug="$PLUGINS/$sample"
  if [[ -d "$plug" ]]; then
    (cd "$ROOT" && $PRISM_DEV mcp serve "$plug" --harness codex-cli --port auto >> "$SANDBOX/mcp-serve.log" 2>&1) || true
  fi
done

for sample in tower booth workflows; do
  rt="$PRISM_HOME/runtime/mcp/$sample/runtime.json"
  if [[ -f "$rt" ]]; then
    port=$(python3 -c "import json; print(json.load(open('$rt'))['port'])")
    health=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$port/healthz" 2>/dev/null || echo "000")
    if [[ "$health" == "200" ]]; then
      mcp_handshake "$sample" "$port"
    else
      fail "$sample healthz = $health (port $port)"
    fi
  fi
done

section "Harness-specific spot checks"

# Codex: 11 global MCP servers, no atelier
codex_cfg="$SANDBOX/roots/codex-cli/config.toml"
if [[ -f "$codex_cfg" ]]; then
  srv=$(rg -c '^\["mcp_servers"\.' "$codex_cfg" 2>/dev/null || echo 0)
  if [[ "$srv" == "11" ]]; then
    pass "codex-cli config.toml MCP servers = 11"
  else
    fail "codex-cli config.toml MCP servers = $srv (expected 11)"
  fi
  if rg -q 'prism-generated-atelier' "$codex_cfg" 2>/dev/null; then
    fail "codex-cli references prism-generated-atelier"
  else
    pass "codex-cli no atelier MCP façade"
  fi
  if rg -q 'prism-generated-tower' "$SANDBOX/roots/codex-cli/agents/atelier-orchestrator.toml" 2>/dev/null; then
    pass "codex atelier-orchestrator references owner tower"
  else
    warn "codex atelier-orchestrator tower ref not found (agent may differ)"
  fi
else
  fail "codex-cli config.toml missing"
fi

# OpenCode: 11 generated plugins, no atelier self-plugin
oc_plugins="$SANDBOX/roots/opencode/plugins"
if [[ -d "$oc_plugins" ]]; then
  oc_count=$(find "$oc_plugins" -maxdepth 1 -type d -name 'prism-generated-*' 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$oc_count" == "11" ]]; then
    pass "opencode owner runtime plugins = 11"
  else
    fail "opencode owner runtime plugins = $oc_count (expected 11)"
  fi
  if [[ -d "$oc_plugins/prism-generated-atelier" ]]; then
    fail "opencode has prism-generated-atelier self-plugin"
  else
    pass "opencode no atelier self-plugin"
  fi
else
  fail "opencode plugins dir missing"
fi

# Amp: consumer slim, owner fat
amp_atelier="$SANDBOX/roots/amp-code/plugins/prism-generated-atelier.ts"
amp_tower="$SANDBOX/roots/amp-code/plugins/prism-generated-tower.ts"
if [[ -f "$amp_atelier" ]]; then
  sz=$(wc -c < "$amp_atelier" | tr -d ' ')
  tower_inline=$(rg -c 'tower_' "$amp_atelier" 2>/dev/null || echo 0)
  if [[ "$sz" -lt 50000 ]] && [[ "$tower_inline" == "0" ]]; then
    pass "amp atelier plugin slim (${sz}b, no tower tools)"
  else
    fail "amp atelier plugin bloated (${sz}b, tower_matches=$tower_inline)"
  fi
else
  pass "amp atelier has no plugin (commands-only elsewhere) or pruned"
fi
if [[ -f "$amp_tower" ]]; then
  tools=$(rg -c 'createToolDefinition\("tower_' "$amp_tower" 2>/dev/null || echo 0)
  if [[ "$tools" -ge 15 ]]; then
    pass "amp tower owner plugin has $tools tower tools"
  else
    fail "amp tower owner thin ($tools tools)"
  fi
fi

# Hermes: config patch, 11 servers
hermes_cfg="$SANDBOX/roots/hermes/config.yaml"
if [[ -f "$hermes_cfg" ]]; then
  h_srv=$(rg -c 'prism-generated-' "$hermes_cfg" 2>/dev/null | head -1 || echo 0)
  if [[ "$h_srv" -ge 10 ]]; then
    pass "hermes config.yaml has prism-generated MCP entries"
  else
    fail "hermes config.yaml sparse MCP entries"
  fi
  if rg -q 'prism-generated-beacon' "$hermes_cfg" 2>/dev/null; then
    fail "hermes has beacon MCP façade"
  else
    pass "hermes no beacon façade"
  fi
fi

# Cursor: mcp.json patch
cursor_mcp="$SANDBOX/roots/cursor/mcp.json"
if [[ -f "$cursor_mcp" ]]; then
  c_srv=$(python3 -c "import json; d=json.load(open('$cursor_mcp')); print(len([k for k in d.get('mcpServers',{}) if k.startswith('prism-generated-')]))" 2>/dev/null || echo ERR)
  # Cursor is tools-only; forge/package-authoring synthetics are not in cursor targets today.
  if [[ "$c_srv" =~ ^[0-9]+$ ]] && [[ "$c_srv" -ge 9 ]]; then
    pass "cursor mcp.json prism servers = $c_srv (tools-only subset)"
  else
    fail "cursor mcp.json prism servers = $c_srv"
  fi
fi

# Consumer plugin bundles may exist for agents/skills; MCP sections must stay empty.
for harness in claude-code grok factory-droid; do
  case "$harness" in
    claude-code) mcp_rel="skills/prism-generated-atelier/.mcp.json" ;;
    grok) mcp_rel="plugins/prism-generated-atelier/.mcp.json" ;;
    factory-droid) mcp_rel="plugins/prism-generated-atelier/mcp.json" ;;
  esac
  mcp_file="$SANDBOX/roots/$harness/$mcp_rel"
  if [[ -f "$mcp_file" ]]; then
    empty=$(python3 -c "import json; d=json.load(open('$mcp_file')); print(len(d.get('mcpServers',{})))" 2>/dev/null || echo ERR)
    if [[ "$empty" == "0" ]]; then
      pass "$harness atelier bundle has empty mcpServers"
    else
      fail "$harness atelier bundle mcpServers count = $empty"
    fi
  fi
done

section "Idempotency (codex second refresh)"

codex_log="$SANDBOX/refresh-codex-idempotent.log"
if (cd "$ROOT" && $PRISM_DEV refresh --plugins "$PLUGINS" \
  --harness codex-cli --scope global \
  --compile-root "$SANDBOX/roots/codex-cli" --compile-only \
  > "$codex_log" 2>&1); then
  writes=$(rg -c '^[[:space:]]*(create|patch|repair|update)[[:space:]]' "$codex_log" 2>/dev/null || echo 0)
  skips=$(rg -c '^[[:space:]]*skip[[:space:]]' "$codex_log" 2>/dev/null || echo 0)
  if [[ "$writes" == "0" ]] || [[ "$skips" -gt 100 ]]; then
    pass "codex second refresh mostly skip (skips=$skips)"
  else
    warn "codex second refresh had writes=$writes skips=$skips"
  fi
else
  fail "codex idempotent refresh failed"
fi

section "Summary"
if [[ "$FAILURES" -eq 0 ]]; then
  log "**QA PASS** — 0 failures"
else
  log "**QA FAIL** — $FAILURES failure(s)"
fi

# Cleanup sample MCP daemons
for sample in tower booth workflows; do
  plug="$PLUGINS/$sample"
  (cd "$ROOT" && $PRISM_DEV mcp stop "$plug" --harness codex-cli >> "$SANDBOX/mcp-stop.log" 2>&1) || true
done

echo ""
echo "Report: $REPORT"
exit "$FAILURES"
