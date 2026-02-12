#!/bin/sh
set -e

# Start crond in background (reads /etc/crontabs/nextjs, runs jobs as nextjs)
crond -b -l 8

# Drop privileges and exec the main command as nextjs
exec su-exec nextjs "$@"
