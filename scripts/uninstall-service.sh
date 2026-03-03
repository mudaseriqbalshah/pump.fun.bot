#!/usr/bin/env bash
# uninstall-service.sh — stop and remove the pump-fun-bot LaunchAgent.
#
# Usage:
#   ./scripts/uninstall-service.sh
#
# Logs in data/logs/ are preserved — delete them manually if desired.

set -euo pipefail

LABEL="com.pumpbot"
INSTALLED_PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
UID_NUM="$(id -u)"

# ---------------------------------------------------------------------------
# Bootout (stop + unregister)
# ---------------------------------------------------------------------------

if launchctl print "gui/${UID_NUM}/${LABEL}" &>/dev/null; then
  echo "==> Stopping and unloading ${LABEL}…"
  launchctl bootout "gui/${UID_NUM}/${LABEL}"
  echo "    Agent stopped."
else
  echo "==> ${LABEL} is not currently loaded — nothing to stop."
fi

# ---------------------------------------------------------------------------
# Remove plist
# ---------------------------------------------------------------------------

if [[ -f "${INSTALLED_PLIST}" ]]; then
  rm "${INSTALLED_PLIST}"
  echo "==> Removed ${INSTALLED_PLIST}"
else
  echo "==> Plist not found at ${INSTALLED_PLIST} — already removed."
fi

echo ""
echo "✅  pump-fun-bot LaunchAgent removed."
echo "    Logs (if any) are in data/logs/ — delete manually if no longer needed."
