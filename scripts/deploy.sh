#!/usr/bin/env bash
# Deploy or update youtube-ai-service on VPS.
# Pulls latest code, rebuilds image, restarts container.

set -euo pipefail

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
