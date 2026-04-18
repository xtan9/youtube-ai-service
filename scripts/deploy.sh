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

echo "Restarting stack (youtube-ai-service + tailscale-exit + pot-provider)..."
docker compose up -d

echo "Waiting for health check..."
sleep 10

# Pin the health check to the youtube-ai-service container specifically.
# `docker compose ps | grep healthy` would match any sidecar with a
# healthcheck (there may be more in future), masking an unhealthy app.
health="$(docker inspect --format='{{.State.Health.Status}}' youtube-ai-service 2>/dev/null || echo missing)"
if [[ "$health" == "healthy" ]]; then
  echo "Deploy successful - youtube-ai-service healthy"
else
  echo "WARNING: youtube-ai-service health=$health"
  docker compose logs --tail 40
  exit 1
fi
