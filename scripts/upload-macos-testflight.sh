#!/usr/bin/env bash
# FENCED: do not use this Electron uploader for the private VeyraN macOS release.
#
# App Store Connect record 6813860928 (bundle id com.ozel0t.note.notesnookpencil)
# must ship the native Mac Catalyst VeyraN three-column UI, not Electron. This
# path uploaded the old Electron "VeyraN-<build>-arm64.pkg" to that shared record
# and could still overwrite the current native Catalyst build.
#
# There is intentionally no override flag or environment variable: the Electron
# upload path is retired for this record so the wrong UI cannot be shipped again
# by accident.
#
# Canonical Mac release path:
#   scripts/build-pencil-testflight.sh --mac --upload
set -euo pipefail

echo "error: scripts/upload-macos-testflight.sh is disabled." >&2
echo "       App Store Connect record 6813860928 (com.ozel0t.note.notesnookpencil)" >&2
echo "       must ship the native Mac Catalyst VeyraN UI, not Electron." >&2
echo "       Use: scripts/build-pencil-testflight.sh --mac --upload" >&2
exit 1
