#!/usr/bin/env bash
# FENCED: superseded by scripts/build-pencil-testflight.sh --mac.
#
# This duplicate emitted the low incremental iOS build number (32) and archived
# into the shared VeyraN App Store Connect record 6813860928, and its comment
# referenced obsolete ".mac" bundle identifiers that no longer exist. Its export
# also did not pin the "Apple Distribution" signing identity, which made Mac App
# Store uploads fail with Transporter error 90284.
#
# The canonical Mac Catalyst release path is the --mac mode of the shared
# builder, which keeps the Unix-timestamp build scheme and the shared bundle id
# (--bump is iOS-only, do not pass it for a Mac build):
#   scripts/build-pencil-testflight.sh --mac [--upload]
set -euo pipefail

echo "error: scripts/build-catalyst-testflight.sh is superseded and disabled." >&2
echo "       Use: scripts/build-pencil-testflight.sh --mac --upload" >&2
exit 1
