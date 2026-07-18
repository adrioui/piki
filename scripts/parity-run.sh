#!/usr/bin/env bash
# Behavioral comparison harness: run mag and pi against the same proxy model.
set -uo pipefail

PROXY="${MAG_PROXY_ENDPOINT:-http://localhost:8317/api/v1}"
MODEL="${PARITY_MODEL:-cline-pass/glm-5.2}"
PROMPT="${1:-Say exactly: PONG}"
OUT_DIR="${2:-/tmp/parity-$(date +%s)}"
mkdir -p "$OUT_DIR"

export MAGNITUDE_ENDPOINT="$PROXY"
export MAGNITUDE_API_KEY="${MAGNITUDE_API_KEY:-anything}"

echo "=== Running mag (magnitude alpha22) ==="
mag -p "$PROMPT" --model "$MODEL" > "$OUT_DIR/mag.out" 2> "$OUT_DIR/mag.err" || true
echo "mag exit=$?  -> $OUT_DIR/mag.out"

echo "=== Running pi (piki) ==="
cd /var/home/adrifadilah/Tooling/piki
NODE_ENV=test PIKI_MODEL="$MODEL" \
  ./pi-test.sh -p "$PROMPT" > "$OUT_DIR/pi.out" 2> "$OUT_DIR/pi.err" || true
echo "pi exit=$?  -> $OUT_DIR/pi.out"

echo "=== Diff (mag vs pi normalized) ==="
echo "--- MAG OUT ---"; cat "$OUT_DIR/mag.out"
echo "--- PI OUT ---"; cat "$OUT_DIR/pi.out"
