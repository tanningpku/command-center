#!/usr/bin/env bash
# ios-build.sh — SSH to Mac and run iOS build via XcodeGen + xcodebuild
# Usage: ios-build.sh [--host user@host] [--repo-dir /path/to/repo] [--pull] [--verbose]
set -euo pipefail

# ── Defaults ────────────────────────────────────────────────────────
SSH_HOST="${IOS_BUILD_HOST:-ntan@192.168.86.28}"
REPO_DIR="${IOS_BUILD_REPO:-\$HOME/code/command-center}"
DO_PULL=true
VERBOSE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)     SSH_HOST="$2"; shift 2;;
    --repo-dir) REPO_DIR="$2"; shift 2;;
    --no-pull)  DO_PULL=false; shift;;
    --verbose)  VERBOSE=true; shift;;
    *)          echo "Unknown flag: $1" >&2; exit 2;;
  esac
done

# ── Build the remote command ────────────────────────────────────────
REMOTE_SCRIPT=$(cat <<'REMOTE_EOF'
set -e

REPO_DIR="__REPO_DIR__"
DO_PULL="__DO_PULL__"

cd "$REPO_DIR" || { echo "CCBUILD_ERROR: Cannot cd to $REPO_DIR"; exit 1; }

# Git pull if requested
if [ "$DO_PULL" = "true" ]; then
  echo "CCBUILD_STEP: git pull"
  git pull --ff-only 2>&1 || { echo "CCBUILD_ERROR: git pull failed"; exit 1; }
fi

cd ios || { echo "CCBUILD_ERROR: Cannot cd to ios/"; exit 1; }

# XcodeGen
echo "CCBUILD_STEP: xcodegen generate"
if ! command -v xcodegen &>/dev/null; then
  echo "CCBUILD_ERROR: xcodegen not found. Install with: brew install xcodegen"
  exit 1
fi
xcodegen generate 2>&1 || { echo "CCBUILD_ERROR: xcodegen generate failed"; exit 1; }

# xcodebuild
echo "CCBUILD_STEP: xcodebuild"
BUILD_OUTPUT=$(xcodebuild \
  -project CommandCenter.xcodeproj \
  -scheme CommandCenter \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  build 2>&1) || true

echo "$BUILD_OUTPUT"

# Parse result
if echo "$BUILD_OUTPUT" | grep -q "BUILD SUCCEEDED"; then
  echo "CCBUILD_RESULT: SUCCESS"
  exit 0
elif echo "$BUILD_OUTPUT" | grep -q "BUILD FAILED"; then
  echo "CCBUILD_RESULT: FAILED"
  # Extract error lines
  echo "CCBUILD_ERRORS_BEGIN"
  echo "$BUILD_OUTPUT" | grep -E "error:" | head -20
  echo "CCBUILD_ERRORS_END"
  exit 1
else
  echo "CCBUILD_RESULT: UNKNOWN"
  echo "CCBUILD_ERRORS_BEGIN"
  echo "$BUILD_OUTPUT" | tail -30
  echo "CCBUILD_ERRORS_END"
  exit 1
fi
REMOTE_EOF
)

# Substitute variables into remote script
REMOTE_SCRIPT="${REMOTE_SCRIPT//__REPO_DIR__/$REPO_DIR}"
REMOTE_SCRIPT="${REMOTE_SCRIPT//__DO_PULL__/$DO_PULL}"

# ── Execute via SSH ─────────────────────────────────────────────────
echo "[ios-build] Connecting to $SSH_HOST..."
echo "[ios-build] Repo: $REPO_DIR"
echo "[ios-build] Pull: $DO_PULL"
echo ""

if [ "$VERBOSE" = "true" ]; then
  ssh -o ConnectTimeout=10 -o BatchMode=yes "$SSH_HOST" bash -s <<< "$REMOTE_SCRIPT" 2>&1
  EXIT_CODE=$?
else
  # Capture output, show only build markers and errors
  OUTPUT=$(ssh -o ConnectTimeout=10 -o BatchMode=yes "$SSH_HOST" bash -s <<< "$REMOTE_SCRIPT" 2>&1) || true
  EXIT_CODE=${PIPESTATUS[0]:-$?}

  # Show step progress
  echo "$OUTPUT" | grep "^CCBUILD_STEP:" | sed 's/CCBUILD_STEP: /[ios-build] /'

  # Show result
  RESULT_LINE=$(echo "$OUTPUT" | grep "^CCBUILD_RESULT:" | tail -1)
  if [ -n "$RESULT_LINE" ]; then
    RESULT="${RESULT_LINE#CCBUILD_RESULT: }"
    echo ""
    if [ "$RESULT" = "SUCCESS" ]; then
      echo "[ios-build] BUILD SUCCEEDED"
    else
      echo "[ios-build] BUILD FAILED"
      echo ""
      # Extract errors between markers
      echo "$OUTPUT" | sed -n '/^CCBUILD_ERRORS_BEGIN$/,/^CCBUILD_ERRORS_END$/p' | grep -v "^CCBUILD_ERRORS_"
    fi
  else
    # No result marker — check for SSH/connection errors
    ERROR_LINE=$(echo "$OUTPUT" | grep "^CCBUILD_ERROR:" | head -1)
    if [ -n "$ERROR_LINE" ]; then
      echo "[ios-build] ERROR: ${ERROR_LINE#CCBUILD_ERROR: }"
    else
      echo "[ios-build] ERROR: Build did not complete. Output:"
      echo "$OUTPUT" | tail -20
    fi
    EXIT_CODE=1
  fi
fi

exit $EXIT_CODE
