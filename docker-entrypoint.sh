#!/bin/sh
set -e

# nextjs user home is /nonexistent — override so Python libs can write config/cache
export HOME=/tmp/ml-home
export MPLCONFIGDIR=/tmp/matplotlib-config
export YOLO_CONFIG_DIR=/tmp/Ultralytics

# Persist torch hub model weights across container restarts.
# /app/data is a host bind mount, /tmp is wiped on every restart.
# Without this, MegaDetector V6 (~200MB) + AI4GAmazonRainforest (~188MB) re-download
# from the internet every time the model server boots, adding ~3 min to startup.
export TORCH_HOME=/app/data/ml-cache/torch
mkdir -p "$TORCH_HOME"

# Ensure backup directory exists
mkdir -p /app/data/backups

# Export env vars for cron jobs (Debian cron doesn't inherit Docker env)
echo "CRON_SECRET=${CRON_SECRET}" > /etc/cron.d/portal-env
chmod 0600 /etc/cron.d/portal-env

# Start cron daemon (Debian — auto-backgrounds, reads /etc/cron.d/)
cron

# Run ML venv setup in background so the app starts immediately
# ML will become available once the setup completes (~2-5 min on first run)
echo "[entrypoint] Starting ML venv setup in background..."
sh scripts/ensure-ml-venv.sh &

# Start the Next.js server via the log-tee supervisor.
# log-tee spawns server.js, mirrors all stdout/stderr to /app/data/logs/portal.log
# (rotated at 50MB), and forwards SIGTERM for graceful shutdown.
mkdir -p /app/data/logs
exec node scripts/log-tee.mjs
