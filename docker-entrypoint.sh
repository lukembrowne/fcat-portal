#!/bin/sh
set -e

# nextjs user home is /nonexistent — override so Python libs can write config/cache
export HOME=/tmp/ml-home
export MPLCONFIGDIR=/tmp/matplotlib-config
export YOLO_CONFIG_DIR=/tmp/Ultralytics

# Run ML venv setup in background so the app starts immediately
# ML will become available once the setup completes (~2-5 min on first run)
echo "[entrypoint] Starting ML venv setup in background..."
sh scripts/ensure-ml-venv.sh &

# Start the Next.js server
exec node server.js
