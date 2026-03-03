#!/usr/bin/env bash
# install-service.sh — build and register pump-fun-bot as a macOS LaunchAgent.
#
# Usage:
#   ./scripts/install-service.sh
#
# What it does:
#   1. Resolves the project root and the full path to the `node` binary.
#   2. Creates data/logs/ for stdout/stderr capture.
#   3. Compiles TypeScript (pnpm build).
#   4. Substitutes placeholders in launchd/com.pumpbot.plist and installs it
#      into ~/Library/LaunchAgents/.
#   5. Bootstraps (loads) the agent so it starts immediately and on every login.

set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve paths
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PLIST_TEMPLATE="${PROJECT_DIR}/launchd/com.pumpbot.plist"
AGENTS_DIR="${HOME}/Library/LaunchAgents"
INSTALLED_PLIST="${AGENTS_DIR}/com.pumpbot.plist"
LABEL="com.pumpbot"

NODE_BIN="$(command -v node 2>/dev/null || true)"
if [[ -z "${NODE_BIN}" ]]; then
  echo "❌  'node' not found in PATH. Install Node.js and try again." >&2
  exit 1
fi

echo "==> Project dir : ${PROJECT_DIR}"
echo "==> Node binary  : ${NODE_BIN}"

# ---------------------------------------------------------------------------
# Prepare data/logs directory
# ---------------------------------------------------------------------------

mkdir -p "${PROJECT_DIR}/data/logs"
echo "==> Log directory: ${PROJECT_DIR}/data/logs"

# ---------------------------------------------------------------------------
# Build TypeScript
# ---------------------------------------------------------------------------

echo "==> Building TypeScript…"
cd "${PROJECT_DIR}"
pnpm build

# ---------------------------------------------------------------------------
# Install the plist
# ---------------------------------------------------------------------------

mkdir -p "${AGENTS_DIR}"

# Substitute template tokens.
sed \
  -e "s|__NODE__|${NODE_BIN}|g" \
  -e "s|__PROJECT_DIR__|${PROJECT_DIR}|g" \
  -e "s|__PATH__|${PATH}|g" \
  "${PLIST_TEMPLATE}" > "${INSTALLED_PLIST}"

echo "==> Plist installed: ${INSTALLED_PLIST}"

# ---------------------------------------------------------------------------
# Load the agent
# ---------------------------------------------------------------------------

UID_NUM="$(id -u)"

# Bootout first in case an old version is already loaded (ignore errors).
launchctl bootout "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true

launchctl bootstrap "gui/${UID_NUM}" "${INSTALLED_PLIST}"

echo ""
echo "✅  pump-fun-bot is now running as a LaunchAgent."
echo ""
echo "Useful commands:"
echo "  Status  : launchctl print gui/${UID_NUM}/${LABEL}"
echo "  Logs    : tail -f ${PROJECT_DIR}/data/logs/stdout.log"
echo "  Errors  : tail -f ${PROJECT_DIR}/data/logs/stderr.log"
echo "  Stop    : launchctl kill TERM gui/${UID_NUM}/${LABEL}"
echo "  Start   : launchctl kickstart -k gui/${UID_NUM}/${LABEL}"
echo "  Remove  : ./scripts/uninstall-service.sh"
