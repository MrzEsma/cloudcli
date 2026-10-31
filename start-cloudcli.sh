#!/bin/bash
# Double-click launcher (Linux): run ./start-cloudcli.sh from the extracted folder.
cd "$(dirname "$0")" || exit 1
if [ ! -x "runtime/bin/node" ]; then
  echo "runtime/bin/node missing — re-extract the whole ZIP."
  exit 1
fi
exec "./runtime/bin/node" "desktop/bootstrap.mjs"
