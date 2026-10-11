#!/usr/bin/env bash
# FENCED: do not use this Electron builder for the private VeyraN macOS release.
#
# App Store Connect record 6813860928 (bundle id com.ozel0t.note.notesnookpencil)
# must ship the native Mac Catalyst VeyraN three-column UI, not Electron. This
# path previously re-uploaded an Electron build (5.4.16 / 1791567256) over the
# native Catalyst build for the same record.
#
# There is intentionally no override flag or environment variable: the Electron
# release path is retired for this record so the wrong UI cannot be shipped
# again by accident.
#
# Canonical Mac release path (--bump is iOS-only, do not pass it for a Mac build):
#   scripts/build-pencil-testflight.sh --mac [--upload]
set -euo pipefail

echo "error: scripts/build-macos-testflight.sh is disabled." >&2
echo "       App Store Connect record 6813860928 (com.ozel0t.note.notesnookpencil)" >&2
echo "       must ship the native Mac Catalyst VeyraN UI, not Electron." >&2
echo "       Use: scripts/build-pencil-testflight.sh --mac --upload" >&2
exit 1
