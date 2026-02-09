#!/bin/bash
# Deploy fcat-portal to DigitalOcean droplet
# Build failure won't tear down the running container (build && up are separate)

set -e

SERVER="root@portal.fcat-ecuador.org"
SERVER_PATH="/root/opt/fcat-portal"

echo "Deploying fcat-portal..."
ssh -A "$SERVER" "cd $SERVER_PATH && git pull && docker compose build && docker compose up -d && docker compose ps"
echo "Done."
