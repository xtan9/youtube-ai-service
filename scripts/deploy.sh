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

# Poll until health resolves one way or the other. Snapshotting after a
# fixed sleep would misclassify a still-starting container (start_period
# is 20s on the app, 45s on tailscale-exit) as a failed deploy.
echo "Waiting for youtube-ai-service to become healthy..."
deadline=$(( SECONDS + 180 ))
while (( SECONDS < deadline )); do
  health="$(docker inspect --format='{{.State.Health.Status}}' youtube-ai-service 2>/dev/null || echo missing)"
  case "$health" in
    healthy) break ;;
    unhealthy)
      echo "youtube-ai-service reported unhealthy"
      docker compose logs --tail 60
      exit 1
      ;;
    missing)
      echo "youtube-ai-service container not found (docker inspect failed)"
      docker compose ps
      exit 1
      ;;
    # starting|"" — keep polling
  esac
  sleep 3
done

if [[ "$health" != "healthy" ]]; then
  echo "Timed out waiting for youtube-ai-service to become healthy (last=$health)"
  docker compose logs --tail 60
  exit 1
fi

echo "youtube-ai-service healthy. Running post-deploy smoke tests..."
./scripts/post-deploy-smoke.sh

echo "Deploy successful"
