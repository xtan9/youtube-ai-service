#!/usr/bin/env bash
# Idempotently upsert KEY=VALUE pairs into /opt/youtube-ai-service/.env.
#
# Why this script exists: deploy.yml pipes Tailscale credentials from GitHub
# secrets into the VPS on every run, but other .env entries (VPS_API_KEY,
# bootstrap values) were written manually during initial VPS setup and must
# be preserved. A naive `cat > .env` would clobber them. This keeps .env as
# the single source of truth while letting the deploy update specific keys.
#
# Usage:
#   update-env.sh KEY1=VALUE1 KEY2=VALUE2 ...
# Empty values (e.g. TS_AUTHKEY= on a non-bootstrap deploy) are skipped so
# a rotated-then-cleared secret doesn't wipe a still-valid .env entry.

set -euo pipefail

ENV_FILE="$(dirname "$0")/../.env"
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"

for pair in "$@"; do
  key="${pair%%=*}"
  value="${pair#*=}"

  # Skip empty values — the secret simply isn't being rotated this run.
  # This lets post-bootstrap deploys omit TS_AUTHKEY without wiping the
  # existing value (Tailscale state is persisted in the docker volume
  # anyway; the authkey is only consulted on first container start).
  if [[ -z "$value" ]]; then
    continue
  fi

  if grep -q "^${key}=" "$ENV_FILE"; then
    # In-place rewrite of the existing line. Using a temp file avoids
    # sed -i portability issues and leaves the file atomic.
    tmp="$(mktemp)"
    awk -v k="$key" -v v="$value" \
      'BEGIN{FS=OFS="="} $1==k {print k"="v; next} {print}' \
      "$ENV_FILE" >"$tmp"
    mv "$tmp" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE"
  fi
done
