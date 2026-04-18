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
# interleaving read/write and corrupting the file.
exec {LOCK_FD}>"$LOCK_FILE"
flock --exclusive "$LOCK_FD"

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
  # subsequent deploy should leave the existing .env line alone.
  if [[ -z "$value" ]]; then
    continue
  fi

  # mktemp in the same directory as the target so `mv` becomes a true
  # rename(2) — atomic. /tmp is often a separate filesystem on hardened
  # hosts, turning `mv` into copy+unlink, which can leave a truncated
  # .env on crash.
  tmp="$(mktemp "${ENV_FILE}.XXXXXX")"
  # Keep group/world off the temp file from the start; `mv` preserves mode.
  chmod 600 "$tmp"

  # Case-pattern passthrough avoids awk's FS=OFS="=" handling of `=` in
  # values, which was a hazard with base64-padded secrets. POSIX sh
  # globbing on `"${key}="*` is a prefix match — anchored because the
  # pattern starts at the beginning of `$line`.
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
