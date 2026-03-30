#!/usr/bin/env bash
# ci.sh — Local CI: TypeScript validation + optional iOS build
# Usage:
#   bin/ci.sh              Run TS validation + optional iOS build
#   bin/ci.sh --ts-only    Run TS validation only
#   bin/ci.sh --install-hook  Install as pre-push git hook
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SSH_HOST="${IOS_BUILD_HOST:-ntan@192.168.86.28}"
TS_ONLY=false
INSTALL_HOOK=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ts-only)       TS_ONLY=true; shift;;
    --install-hook)  INSTALL_HOOK=true; shift;;
    *)               echo "Unknown flag: $1" >&2; exit 2;;
  esac
done

# ── Install hook mode ──────────────────────────────────────────────
if [ "$INSTALL_HOOK" = "true" ]; then
  HOOK_PATH="$PROJECT_DIR/.git/hooks/pre-push"
  cat > "$HOOK_PATH" <<'HOOK'
#!/usr/bin/env bash
# Pre-push hook: run TypeScript validation before pushing
echo "[pre-push] Running TypeScript validation..."
cd "$(git rev-parse --show-toplevel)"
npx tsc --noEmit || { echo "[pre-push] Type check failed — push aborted"; exit 1; }
npm run build || { echo "[pre-push] Build failed — push aborted"; exit 1; }
echo "[pre-push] All checks passed"
HOOK
  chmod +x "$HOOK_PATH"
  echo "Pre-push hook installed at $HOOK_PATH"
  exit 0
fi

# ── Stage 1: TypeScript validation ─────────────────────────────────
cd "$PROJECT_DIR"
echo "━━━ Stage 1: TypeScript Validation ━━━"
echo ""

echo "[ci] Type checking (tsc --noEmit)..."
if npx tsc --noEmit; then
  echo "[ci] Type check passed"
else
  echo "[ci] Type check FAILED"
  exit 1
fi

echo ""
echo "[ci] Building (npm run build)..."
if npm run build; then
  echo "[ci] Build passed"
else
  echo "[ci] Build FAILED"
  exit 1
fi

echo ""
echo "━━━ Stage 1: PASSED ━━━"

if [ "$TS_ONLY" = "true" ]; then
  echo ""
  echo "[ci] Skipping iOS build (--ts-only)"
  exit 0
fi

# ── Stage 2: Optional iOS build ───────────────────────────────────
echo ""
echo "━━━ Stage 2: iOS Build (optional) ━━━"
echo ""

echo "[ci] Pinging Mac Mini ($SSH_HOST)..."
HOST_IP="${SSH_HOST#*@}"
if ! ping -c 1 -W 2 "$HOST_IP" >/dev/null 2>&1; then
  echo "[ci] WARNING: Mac Mini ($HOST_IP) is not reachable — skipping iOS build"
  echo "[ci] This is expected when not on the local network"
  exit 0
fi

echo "[ci] Mac Mini is reachable, running iOS build..."
if "$SCRIPT_DIR/ios-build.sh"; then
  echo ""
  echo "━━━ Stage 2: PASSED ━━━"
else
  echo ""
  echo "━━━ Stage 2: FAILED ━━━"
  exit 1
fi

echo ""
echo "━━━ All stages passed ━━━"
