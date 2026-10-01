#!/usr/bin/env bash
# Drives the Mac Catalyst build without taking over the user's mouse or keyboard.
# The app runs in the background (open -g); only its own window is captured.
# Needs Accessibility + Screen Recording permission for the calling terminal.
#
#   tools/mac-app.sh launch            start the built app in the background
#   tools/mac-app.sh shot <name>       capture the main window to screenshots/<name>.png
#   tools/mac-app.sh menu <Menu> <Item>  run a menu command, e.g. menu View Tasks
#   tools/mac-app.sh press "<AX label>"  press an element by accessibility label
#   tools/mac-app.sh dump              list labelled accessibility elements
#   tools/mac-app.sh size <w> <h>      resize the main window (points)
#   tools/mac-app.sh menus             print the app's menu bar
#   tools/mac-app.sh quit              quit the app
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PLAN="$(dirname "$HERE")"
APP="${VEYRAN_MAC_APP:-$PLAN/../../apps/mobile/ios/build/Catalyst/Build/Products/Release-maccatalyst/Notesnook.app}"
BIN="${TMPDIR:-/tmp}/veyran-mac-tools"
mkdir -p "$BIN"
[[ -x "$BIN/winlist" ]] || swiftc -O "$HERE/winlist.swift" -o "$BIN/winlist"
[[ -x "$BIN/axpress" ]] || swiftc -O "$HERE/axpress.swift" -o "$BIN/axpress"

pid() { pgrep -f "Release-maccatalyst/Notesnook.app/Contents/MacOS/Notesnook" | head -1; }
win() { "$BIN/winlist" veyra | awk '$4==0 && $NF=="1" && $(NF-2)>300 {print $1; exit}'; }
sysev() { osascript -e "tell application \"System Events\" to tell (first process whose unix id is $(pid)) to $1"; }

case "${1:-}" in
  launch) open -g -a "$APP"; sleep 10; echo "pid $(pid) window $(win)";;
  shot)   mkdir -p "$PLAN/screenshots"; screencapture -x -o -l"$(win)" "$PLAN/screenshots/$2.png"; echo "$PLAN/screenshots/$2.png";;
  menu)   sysev "click menu item \"$3\" of menu 1 of menu bar item \"$2\" of menu bar 1" >/dev/null; sleep 2;;
  press)  "$BIN/axpress" "$(pid)" "$2" "${3:-0}"; sleep 2;;
  dump)   "$BIN/axpress" "$(pid)" --dump;;
  size)   sysev "set size of window 1 to {$2, $3}"; sleep 2;;
  menus)  sysev "get name of every menu item of menu 1 of every menu bar item of menu bar 1";;
  quit)   kill "$(pid)";;
  *) sed -n '2,14p' "$0"; exit 1;;
esac
