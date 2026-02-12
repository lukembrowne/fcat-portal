#!/bin/sh
set -e

# Run ML venv setup in background so the app starts immediately
# ML will become available once the setup completes (~2-5 min on first run)
echo "[entrypoint] Starting ML venv setup in background..."
sh scripts/ensure-ml-venv.sh &

# Start the Next.js server
exec node server.js
