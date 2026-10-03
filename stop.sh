#!/bin/bash
# Stops the Dicom Viewer server.
PID=$(lsof -ti :8765 -sTCP:LISTEN 2>/dev/null)
if [ -z "$PID" ]; then
  echo "Not running."
else
  kill "$PID"
  echo "Stopped."
fi
