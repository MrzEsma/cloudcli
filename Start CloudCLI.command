#!/bin/bash
# Double-click launcher (macOS). First run: right-click → Open if macOS asks.
cd "$(dirname "$0")" || exit 1
if [ ! -x "runtime/bin/node" ]; then
  echo "runtime/bin/node missing — re-extract the whole ZIP."
  read -r -p "Press Enter to close…" _
  exit 1
fi
exec "./runtime/bin/node" "desktop/bootstrap.mjs"
