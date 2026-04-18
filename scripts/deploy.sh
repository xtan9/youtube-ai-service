#!/usr/bin/env bash
# Deploy or update youtube-ai-service on VPS.
# Rebuilds the image and restarts the container.
#
# Wrapped in flock so two concurrent deploys (e.g. workflow_dispatch racing
# a workflow_run trigger) can't interleave docker-compose state on the host.
# GHA's `concurrency` group serializes GHA jobs but not VPS-side processes.

set -euo pipefail

LOCK_FILE="/var/lock/youtube-ai-deploy.lock"

exec {LOCK_FD}>"$LOCK_FILE"
if ! flock --exclusive --nonblock "$LOCK_FD"; then
  echo "Another deploy is already in progress (lock: $LOCK_FILE); aborting."
  exit 1
fi

cd "$(dirname "$0")/.."

echo "Building youtube-ai-service image..."
docker compose build

echo "Restarting container..."
docker compose up -d

echo "Waiting for health check..."
sleep 10

if docker compose ps | grep -q "healthy"; then
  echo "Deploy successful - container healthy"
else
  echo "WARNING: Container not yet healthy"
  docker compose logs --tail 20
  exit 1
fi
