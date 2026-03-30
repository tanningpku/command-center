#!/usr/bin/env bash
# ios-build-daemon.sh — Polls git repo for new commits, auto-builds, reports to CC gateway.
# Runs on the Mac as a background process.
#
# Usage:
#   ios-build-daemon.sh start   — Start daemon in background
#   ios-build-daemon.sh stop    — Stop daemon
#   ios-build-daemon.sh status  — Check if running
#   ios-build-daemon.sh run     — Run in foreground (for debugging)
set -euo pipefail

# ── Config ─────────────────────────────────────────────────────────
REPO_DIR="${IOS_BUILD_REPO:-$HOME/code/command-center}"
POLL_INTERVAL="${IOS_BUILD_POLL:-30}"
SIMULATOR="${IOS_BUILD_SIM:-iPhone 17 Pro}"
CC_GATEWAY="${CC_GATEWAY_URL:-http://192.168.86.24:3300}"
CC_PROJECT="${CC_PROJECT:-command-center}"
CC_THREAD="${CC_BUILD_THREAD:-}"  # Auto-created if empty

PID_FILE="$HOME/.ios-build-daemon.pid"
LOG_FILE="$HOME/.ios-build-daemon.log"
BUILD_NUM_FILE="$HOME/.ios-build-daemon.buildnum"

# ── Helpers ────────────────────────────────────────────────────────

log() {
  echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

notify_gateway() {
  local text="$1"
  if [ -z "$CC_THREAD" ]; then return; fi
  curl -s -X POST "$CC_GATEWAY/api/message" \
    -H 'Content-Type: application/json' \
    -H "X-Project-Id: $CC_PROJECT" \
    -H 'X-Agent-Id: ios-build-daemon' \
    -d "$(jq -n --arg thread "$CC_THREAD" --arg text "$text" --arg sender "ios-build-daemon" --arg source "daemon" '{thread_id: $thread, text: $text, sender: $sender, source: $source}')" \
    >/dev/null 2>&1 || true
}

next_build_num() {
  local num=1
  if [ -f "$BUILD_NUM_FILE" ]; then
    num=$(( $(cat "$BUILD_NUM_FILE") + 1 ))
  fi
  echo "$num" > "$BUILD_NUM_FILE"
  echo "$num"
}

# ── Build logic ────────────────────────────────────────────────────

do_build() {
  local commit_sha="$1"
  local commit_msg="$2"
  local build_num
  build_num=$(next_build_num)

  log "Build #$build_num starting (${commit_sha:0:7}: $commit_msg)"
  notify_gateway "Build #$build_num starting (${commit_sha:0:7}: $commit_msg)"

  local start_time
  start_time=$(date +%s)

  # Pull
  cd "$REPO_DIR"
  if ! git pull --ff-only >> "$LOG_FILE" 2>&1; then
    log "Build #$build_num FAILED: git pull error"
    notify_gateway "Build #$build_num FAILED: git pull error"
    return 1
  fi

  # XcodeGen
  cd "$REPO_DIR/ios"
  if ! xcodegen generate >> "$LOG_FILE" 2>&1; then
    log "Build #$build_num FAILED: xcodegen error"
    notify_gateway "Build #$build_num FAILED: xcodegen generate failed"
    return 1
  fi

  # xcodebuild
  local build_output
  build_output=$(xcodebuild \
    -project CommandCenter.xcodeproj \
    -scheme CommandCenter \
    -destination "platform=iOS Simulator,name=$SIMULATOR" \
    build 2>&1) || true

  local end_time
  end_time=$(date +%s)
  local duration=$(( end_time - start_time ))

  if echo "$build_output" | grep -q "BUILD SUCCEEDED"; then
    log "Build #$build_num SUCCEEDED (${duration}s)"
    notify_gateway "Build #$build_num SUCCEEDED (${duration}s) — ${commit_sha:0:7}: $commit_msg"
    return 0
  else
    # Extract errors
    local errors
    errors=$(echo "$build_output" | grep -E "error:" | head -10)
    local error_count
    error_count=$(echo "$build_output" | grep -cE "error:" || echo "0")

    log "Build #$build_num FAILED (${duration}s, $error_count errors)"
    echo "$errors" >> "$LOG_FILE"

    local msg="Build #$build_num FAILED (${duration}s, $error_count errors) — ${commit_sha:0:7}: $commit_msg"
    if [ -n "$errors" ]; then
      msg="$msg\n\nErrors:\n$errors"
    fi
    notify_gateway "$msg"
    return 1
  fi
}

# ── Poll loop ──────────────────────────────────────────────────────

run_daemon() {
  log "Daemon started (poll=${POLL_INTERVAL}s, repo=$REPO_DIR, sim=$SIMULATOR)"
  notify_gateway "iOS build daemon started (polling every ${POLL_INTERVAL}s)"

  cd "$REPO_DIR"
  local last_sha
  last_sha=$(git rev-parse HEAD 2>/dev/null || echo "none")
  log "Initial HEAD: ${last_sha:0:7}"

  while true; do
    # Fetch latest from remote
    git fetch origin main --quiet 2>/dev/null || true

    local remote_sha
    remote_sha=$(git rev-parse origin/main 2>/dev/null || echo "none")

    if [ "$remote_sha" != "$last_sha" ] && [ "$remote_sha" != "none" ]; then
      local commit_msg
      commit_msg=$(git log --format='%s' -1 origin/main 2>/dev/null || echo "unknown")

      log "New commit detected: ${remote_sha:0:7} ($commit_msg)"
      do_build "$remote_sha" "$commit_msg"
      last_sha="$remote_sha"
    fi

    sleep "$POLL_INTERVAL"
  done
}

# ── Commands ───────────────────────────────────────────────────────

case "${1:-run}" in
  start)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "Daemon already running (PID $(cat "$PID_FILE"))"
      exit 0
    fi
    echo "Starting iOS build daemon..."
    nohup "$0" run >> "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    echo "Daemon started (PID $!, log: $LOG_FILE)"
    ;;

  stop)
    if [ -f "$PID_FILE" ]; then
      PID=$(cat "$PID_FILE")
      if kill -0 "$PID" 2>/dev/null; then
        kill "$PID"
        rm -f "$PID_FILE"
        echo "Daemon stopped (PID $PID)"
      else
        rm -f "$PID_FILE"
        echo "Daemon was not running (stale PID file removed)"
      fi
    else
      echo "Daemon is not running (no PID file)"
    fi
    ;;

  status)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "Daemon running (PID $(cat "$PID_FILE"))"
      echo "Log: $LOG_FILE"
      echo "Last 5 log lines:"
      tail -5 "$LOG_FILE" 2>/dev/null || echo "  (no log yet)"
    else
      echo "Daemon is not running"
    fi
    ;;

  run)
    run_daemon
    ;;

  *)
    echo "Usage: $0 {start|stop|status|run}"
    exit 2
    ;;
esac
