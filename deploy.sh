#!/bin/bash
# deploy.sh - Deploy fcat-portal to DigitalOcean droplet
#
# Usage:
#   ./deploy.sh              # Deploy and rebuild container
#   ./deploy.sh --quick      # Deploy without rebuilding (config/data changes only)
#   ./deploy.sh --logs       # Deploy and tail logs
#
# First-time server setup:
#   1. ssh digitalocean
#   2. mkdir -p /root/opt/fcat-portal/data
#   3. cd /root/opt && git clone https://github.com/lukembrowne/fcat-portal.git
#   4. nano /root/opt/fcat-portal/.env   # add production secrets (see .env.example)
#   5. touch /root/opt/fcat-portal/data/allowed_external_emails.txt
#   6. Google Cloud Console: add https://portal.fcat-ecuador.org/oauth2/callback as redirect URI
#   7. DNS: add A record for portal.fcat-ecuador.org → droplet IP
#   8. cp /root/opt/fcat-portal/nginx/portal.fcat-ecuador.org /etc/nginx/sites-available/
#      ln -s /etc/nginx/sites-available/portal.fcat-ecuador.org /etc/nginx/sites-enabled/
#      nginx -t && systemctl reload nginx
#   9. certbot --nginx -d portal.fcat-ecuador.org
#  10. ./deploy.sh from your local machine

set -e

SERVER="digitalocean"
SERVER_PATH="/root/opt/fcat-portal"

echo "Deploying fcat-portal to production..."
read -p "Continue? [y/N] " confirm
if [[ "$confirm" != [yY] ]]; then
    echo "Aborted."
    exit 0
fi

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

# Ensure backup directory exists
ssh "$SERVER" "mkdir -p ${SERVER_PATH}/data/backups"

# Sync the nginx vhost. This used to be a manual first-time-setup step, so the
# live config silently drifted from the repo: the /_next/static/ and
# /biochoco-overview/ auth exemptions added for the public overview page were
# never copied over, and every logged-out visitor got the oauth sign-in HTML in
# place of the page's JS bundles and images. Only reloads when the file changed,
# and `nginx -t` gates the reload so a bad config can never take the site down.
echo ""
echo "Syncing nginx config..."
ssh "$SERVER" "cd ${SERVER_PATH} && \
    if cmp -s nginx/portal.fcat-ecuador.org /etc/nginx/sites-available/portal.fcat-ecuador.org; then \
        echo '  nginx config already up to date'; \
    else \
        cp /etc/nginx/sites-available/portal.fcat-ecuador.org /etc/nginx/sites-available/portal.fcat-ecuador.org.bak && \
        cp nginx/portal.fcat-ecuador.org /etc/nginx/sites-available/portal.fcat-ecuador.org && \
        if nginx -t; then \
            systemctl reload nginx && echo '  nginx config updated and reloaded'; \
        else \
            cp /etc/nginx/sites-available/portal.fcat-ecuador.org.bak /etc/nginx/sites-available/portal.fcat-ecuador.org && \
            echo '  nginx -t FAILED — rolled back, config unchanged' && exit 1; \
        fi; \
    fi"

# Run schema migrations (idempotent — safe to run every deploy)
echo ""
echo "Running schema migrations..."
ssh "$SERVER" "cd ${SERVER_PATH} && docker compose exec portal node scripts/push-schema.mjs"

echo ""
echo "Deployed! https://portal.fcat-ecuador.org"

if [ "$SHOW_LOGS" = true ]; then
    echo ""
    echo "Showing logs (Ctrl+C to exit)..."
    ssh "$SERVER" "cd ${SERVER_PATH} && docker compose logs -f --tail=50"
fi
