#!/bin/bash
# Starts the Dicom Viewer server in the background and prints the URL to open.
cd "$(dirname "$0")"
export PATH="$PATH:/Users/mac/Library/Python/3.9/bin"

if lsof -i :8765 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Already running at http://127.0.0.1:8765"
  exit 0
fi

nohup python3 server.py 8765 > server.log 2>&1 &
disown
sleep 1
echo "Dicom Viewer running at http://127.0.0.1:8765"
echo "Open that link in your browser. Run stop.sh to shut it down."
