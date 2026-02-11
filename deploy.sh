#!/bin/bash
# deploy.sh - Deploy fcat-portal to DigitalOcean droplet
#
# Usage:
#   ./deploy.sh              # Deploy and rebuild container
#   ./deploy.sh --quick      # Deploy without rebuilding (config/data changes only)
#   ./deploy.sh --logs       # Deploy and tail logs
#
# First-time server setup:
#   ssh digitalocean
#   mkdir -p /root/opt/fcat-portal/data
#   cd /root/opt && git clone https://github.com/lukembrowne/fcat-portal.git
#   nano /root/opt/fcat-portal/.env   # add production secrets
#   # Then run ./deploy.sh from your local machine

set -e

SERVER="digitalocean"
SERVER_PATH="/root/opt/fcat-portal"

echo "Deploying fcat-portal..."

# Parse arguments
REBUILD="--build"
SHOW_LOGS=false

for arg in "$@"; do
    case $arg in
        --quick)
            REBUILD=""
            echo "  Quick deploy (no rebuild)"
            ;;
        --logs)
            SHOW_LOGS=true
            ;;
    esac
done

# Build separately so a build failure doesn't tear down the running container
if [ -n "$REBUILD" ]; then
    ssh -A "$SERVER" "cd ${SERVER_PATH} && git pull && docker compose build && docker compose up -d && docker compose ps"
else
    ssh -A "$SERVER" "cd ${SERVER_PATH} && git pull && docker compose up -d && docker compose ps"
fi

echo ""
echo "Deployed! https://portal.fcat-ecuador.org"

if [ "$SHOW_LOGS" = true ]; then
    echo ""
    echo "Showing logs (Ctrl+C to exit)..."
    ssh "$SERVER" "cd ${SERVER_PATH} && docker compose logs -f --tail=50"
fi
