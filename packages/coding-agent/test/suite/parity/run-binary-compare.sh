#!/usr/bin/env bash
# Secondary, OPTIONAL live piki-vs-mag comparison aid.
#
# This script is NOT run by the vitest suite or CI. It requires operator-supplied
# secrets (localhost proxy + valid keys) and is non-deterministic by model
# sampling, so it is a dev/verification aid only. The deterministic gating check
# is the faux-only vitest suite: test/suite/parity/parity.test.ts
#
# Usage:
#   PIKI_BIN=/path/to/pi MAG_BIN=/path/to/mag PROMPT="..." ./run-binary-compare.sh
#
# It runs both agents headless on the same prompt, exports ATIF from each, strips
# non-deterministic fields, and diffs the normalized trajectories. It also greps
# both debug logs for the shell-boundary rejection reason.
set -euo pipefail

PIKI_BIN="${PIKI_BIN:-pi}"
MAG_BIN="${MAG_BIN:-mag}"
PROMPT="${PROMPT:-Write a file in the cwd, then try to write one in /etc.}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PIKI_DIR="$WORK/piki-agent"
mkdir -p "$PIKI_DIR"

echo "== piki =="
PIKI_CODING_AGENT_DIR="$PIKI_DIR" "$PIKI_BIN" -p "$PROMPT" --mode json --atif "$WORK/pi.atif" --debug 2> "$WORK/pi.debug" || true

echo "== mag =="
"$MAG_BIN" --headless --debug --atif "$WORK/mag.atif" --prompt "$PROMPT" 2> "$WORK/mag.debug" || true

echo "== normalized ATIF diff (piki vs mag) =="
node -e '
const fs = require("fs");
function norm(p){
  const j = JSON.parse(fs.readFileSync(p,"utf8"));
  function strip(v){
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === "object"){
      const o={};
      for (const [k,x] of Object.entries(v)){
        if (["id","parentId","timestamp","step_id","responseId","turnId","usage","createdAt"].includes(k)) continue;
        if (/toolcall_[0-9a-f]+/i.test(k)) continue;
        const s=strip(x);
        if (s && typeof s==="object" && !Array.isArray(s) && Object.keys(s).length===0) continue;
        o[k]=s;
      }
      return o;
    }
    return v;
  }
  return strip(j);
}
console.log(JSON.stringify(norm(process.argv[1]),null,2));
' "$WORK/pi.atif" > "$WORK/pi.norm.json"
node -e '
const fs = require("fs");
function norm(p){
  const j = JSON.parse(fs.readFileSync(p,"utf8"));
  function strip(v){
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === "object"){
      const o={};
      for (const [k,x] of Object.entries(v)){
        if (["id","parentId","timestamp","step_id","responseId","turnId","usage","createdAt"].includes(k)) continue;
        if (/toolcall_[0-9a-f]+/i.test(k)) continue;
        const s=strip(x);
        if (s && typeof s==="object" && !Array.isArray(s) && Object.keys(s).length===0) continue;
        o[k]=s;
      }
      return o;
    }
    return v;
  }
  return strip(j);
}
console.log(JSON.stringify(norm(process.argv[1]),null,2));
' "$WORK/mag.atif" > "$WORK/mag.norm.json"
diff "$WORK/pi.norm.json" "$WORK/mag.norm.json" && echo "ATIF normalized: identical" || echo "ATIF normalized: differences above"

echo "== shell-boundary rejection reason presence =="
grep -h "outside allowed directories" "$WORK/pi.debug" "$WORK/mag.debug" || echo "rejection reason not found in debug logs"
