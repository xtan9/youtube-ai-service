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
# Empty RHS (e.g. `TS_AUTHKEY=` when the GitHub secret is unset) is skipped
# so a rotated-then-cleared secret doesn't wipe a still-valid .env entry.
# Keys are validated (uppercase + digits + underscore) to prevent regex
# injection when matching against the file.

set -euo pipefail

ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env"
LOCK_FILE="${ENV_FILE}.lock"

# flock guards against two overlapping deploys (workflow_dispatch racing a
# workflow_run, or a human running this during a pipeline deploy) from
# interleaving read/write and corrupting the file. `--timeout=30` ensures a
# stuck lockholder (killed mid-run without releasing) doesn't wedge every
# subsequent deploy silently — we'd rather fail loudly after 30s.
exec {LOCK_FD}>"$LOCK_FILE"
if ! flock --exclusive --timeout=30 "$LOCK_FD"; then
  echo "update-env.sh: could not acquire $LOCK_FILE within 30s (held by another deploy?)" >&2
  exit 1
fi

touch "$ENV_FILE"
chmod 600 "$ENV_FILE"

for pair in "$@"; do
  key="${pair%%=*}"
  value="${pair#*=}"

  # Key hardening: must be [A-Z_][A-Z0-9_]*. Prevents a caller from passing
  # a key with regex metacharacters (`.`, `*`) that would make the match
  # below overreach, and documents that .env keys are ENV-style identifiers.
  if ! [[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]]; then
    echo "update-env.sh: invalid key '$key' (must match ^[A-Z_][A-Z0-9_]*\$)" >&2
    exit 1
  fi

  # Skip empty values — the secret simply isn't being rotated this run.
  # Tailscale state is persisted in the docker volume; the authkey is only
  # consulted on first container start, so an unset GitHub secret on a
  # subsequent deploy should leave the existing .env line alone. Log the
  # skip so the operator can distinguish "secret not rotated" from "secret
  # deliberately cleared" when auditing a deploy log.
  if [[ -z "$value" ]]; then
    echo "update-env.sh: skipping $key (empty value)" >&2
    continue
  fi

  # mktemp in the same directory as the target so `mv` becomes a true
  # rename(2) — atomic. /tmp is often a separate filesystem on hardened
  # hosts, turning `mv` into copy+unlink, which can leave a truncated
  # .env on crash.
  tmp="$(mktemp "${ENV_FILE}.XXXXXX")"
  chmod 600 "$tmp"

  # Case-pattern prefix match (anchored at start of line) handles `=` in
  # values correctly (base64 padding, URL query strings).
  found=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      "${key}="*)
        printf '%s=%s\n' "$key" "$value"
        found=1
        ;;
      *) printf '%s\n' "$line" ;;
    esac
  done <"$ENV_FILE" >"$tmp"

  if [[ "$found" -eq 0 ]]; then
    printf '%s=%s\n' "$key" "$value" >>"$tmp"
  fi

  mv "$tmp" "$ENV_FILE"
done
