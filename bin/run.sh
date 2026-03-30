#!/usr/bin/env bash
# run.sh — Auto-restart harness for the Command Center gateway
#
# Usage:
#   bin/run.sh              Run compiled (node dist/index.js)
#   bin/run.sh --dev        Run dev mode (npx tsx index.ts)
#   bin/run.sh --max-restarts N  Give up after N consecutive failures (default: unlimited)
#
# Restarts on crash with exponential backoff (1s → 2s → 4s → ... → 60s max).
# Backoff resets after the process runs successfully for 30s.
# Forwards SIGINT/SIGTERM to the child and exits cleanly (no restart).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Config ─────────────────────────────────────────────────────────
DEV_MODE=false
MAX_RESTARTS=0  # 0 = unlimited
BACKOFF_INITIAL=1
BACKOFF_MAX=60
HEALTHY_THRESHOLD=30  # seconds before considering the process stable

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dev)            DEV_MODE=true; shift;;
    --max-restarts)
      [ -z "${2:-}" ] && { echo "Error: --max-restarts requires a number" >&2; exit 2; }
      [[ "$2" =~ ^[0-9]+$ ]] || { echo "Error: --max-restarts must be a positive integer" >&2; exit 2; }
      MAX_RESTARTS="$2"; shift 2;;
    *)                echo "Unknown flag: $1" >&2; exit 2;;
  esac
done

# ── State ──────────────────────────────────────────────────────────
CHILD_PID=""
BACKOFF="$BACKOFF_INITIAL"
RESTART_COUNT=0
INTENTIONAL_EXIT=false

log() {
  echo "[run.sh $(date '+%H:%M:%S')] $*"
}

# ── Signal handling ────────────────────────────────────────────────
cleanup() {
  INTENTIONAL_EXIT=true
  if [ -n "$CHILD_PID" ] && kill -0 "$CHILD_PID" 2>/dev/null; then
    log "Forwarding signal to process $CHILD_PID"
    kill -TERM "$CHILD_PID" 2>/dev/null || true
    wait "$CHILD_PID" 2>/dev/null || true
  fi
  log "Exiting"
  exit 0
}

trap cleanup SIGINT SIGTERM

# ── Build command ──────────────────────────────────────────────────
cd "$PROJECT_DIR"

if [ "$DEV_MODE" = "true" ]; then
  CMD="npx tsx index.ts"
else
  CMD="node dist/index.js"
fi

# ── Main loop ──────────────────────────────────────────────────────
log "Starting Command Center (mode: $([ "$DEV_MODE" = "true" ] && echo dev || echo production))"
log "Backoff: ${BACKOFF_INITIAL}s initial, ${BACKOFF_MAX}s max, reset after ${HEALTHY_THRESHOLD}s healthy"

while true; do
  START_TIME=$(date +%s)
  log "Launching: $CMD"

  $CMD &
  CHILD_PID=$!
  set +e
  wait "$CHILD_PID" 2>/dev/null
  EXIT_CODE=$?
  set -e
  CHILD_PID=""

  # Don't restart on intentional shutdown
  if [ "$INTENTIONAL_EXIT" = "true" ]; then
    exit 0
  fi

  ELAPSED=$(( $(date +%s) - START_TIME ))

  # If the process ran long enough, it was healthy — reset backoff
  if [ "$ELAPSED" -ge "$HEALTHY_THRESHOLD" ]; then
    BACKOFF="$BACKOFF_INITIAL"
    RESTART_COUNT=0
    log "Process exited (code $EXIT_CODE) after ${ELAPSED}s (was healthy). Restarting in ${BACKOFF}s..."
  else
    RESTART_COUNT=$(( RESTART_COUNT + 1 ))
    log "Process crashed (code $EXIT_CODE) after ${ELAPSED}s. Restart #$RESTART_COUNT in ${BACKOFF}s..."
  fi

  # Check max restarts
  if [ "$MAX_RESTARTS" -gt 0 ] && [ "$RESTART_COUNT" -ge "$MAX_RESTARTS" ]; then
    log "Reached max consecutive restarts ($MAX_RESTARTS). Giving up."
    exit 1
  fi

  sleep "$BACKOFF"

  # Exponential backoff on crash only (double, cap at max); healthy exits stay at initial
  if [ "$ELAPSED" -lt "$HEALTHY_THRESHOLD" ]; then
    BACKOFF=$(( BACKOFF * 2 ))
    if [ "$BACKOFF" -gt "$BACKOFF_MAX" ]; then
      BACKOFF="$BACKOFF_MAX"
    fi
  fi
done
