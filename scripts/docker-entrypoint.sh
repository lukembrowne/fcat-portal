#!/bin/sh
set -e

# Ensure backup directory exists with correct ownership
mkdir -p /app/data/backups
chown nextjs:nodejs /app/data/backups

# Start crond in background (reads /etc/crontabs/nextjs, runs jobs as nextjs)
crond -b -l 8

# Drop privileges and exec the main command as nextjs
exec su-exec nextjs "$@"
