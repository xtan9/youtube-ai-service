#!/usr/bin/env bash
# Post-deploy smoke tests. Verifies the invariants this deploy's architecture
# depends on, so a silent degradation (Tailscale failed open to direct
# egress, pot-provider crashed, wrong exit node) turns the deploy red
# instead of silently shipping a broken app.
#
# Exits non-zero on any check failure. Invoked by deploy.sh after the app
# healthcheck passes; the GHA deploy job surfaces the failure via its
# existing failure-alert step.

set -euo pipefail

echo "[smoke] egress IP: verifying yt-dlp traffic routes through the home exit node"
# If Tailscale lost its route (authkey expired, exit node offline), yt-dlp
# would silently fall back to direct egress from the VPS IP, which YouTube
# flags as a datacenter and returns "Sign in to confirm you're not a bot"
# (HTTP 403/429 on player responses). Fail loudly here so a degraded stack
# doesn't ship.
vps_ip="$(curl -sS --max-time 10 https://api.ipify.org || echo unknown)"
# Don't suppress docker exec stderr — if the container is missing or
# dockerd is unreachable, the operator needs that signal, not "unknown".
container_ip="$(docker exec youtube-ai-service curl -sS --max-time 10 https://api.ipify.org || echo unknown)"
if [[ "$vps_ip" == "unknown" || "$container_ip" == "unknown" ]]; then
  echo "[smoke] egress-IP check inconclusive (vps=$vps_ip container=$container_ip); failing closed"
  exit 1
fi
if [[ "$container_ip" == "$vps_ip" ]]; then
  echo "[smoke] FAIL: container egresses from VPS IP ($vps_ip) — exit node not routing"
  echo "[smoke] Tailscale state:"
  docker exec yt-ai-tailscale-exit tailscale status || true
  exit 1
fi
echo "[smoke] OK: VPS egress=$vps_ip, container egress=$container_ip (residential)"

echo "[smoke] whisper-ctranslate2: verifying the CLI binary is on PATH inside the app container"
# The original transcribe outage (PR #6) was a latent ENOENT on a missing
# CLI — pip installed `faster-whisper` the library, but no `faster-whisper`
# binary existed. Verifying `--version` from a shell that matches the one
# `execFile` uses catches venv PATH drift, package renames, and image
# misconfigurations before any user hits them.
if ! docker exec youtube-ai-service whisper-ctranslate2 --version >/dev/null 2>&1; then
  echo "[smoke] FAIL: whisper-ctranslate2 not reachable from app container"
  docker exec youtube-ai-service whisper-ctranslate2 --version 2>&1 | tail -5 || true
  exit 1
fi
echo "[smoke] OK: whisper-ctranslate2 reachable"

echo "[smoke] pot-provider: verifying HTTP listener is reachable from the app container"
if ! docker exec youtube-ai-service node -e "require('http').get('http://127.0.0.1:4416/ping', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"; then
  echo "[smoke] FAIL: pot-provider /ping not reachable from app container"
  docker logs yt-ai-pot-provider --tail 40 || true
  exit 1
fi
echo "[smoke] OK: pot-provider /ping returned 200"

echo "[smoke] yt-dlp: end-to-end extraction of a known-captioned public video"
# `--dump-json --skip-download` exercises the full extraction path — player_client
# cascade, PO Token fetch, signature decoding — without actually downloading
# media. Catches PO Token plugin regressions, exit-node auth failures, and
# YouTube-side schema drift at deploy time rather than at first-user-request.
# dQw4w9WgXcQ is "Never Gonna Give You Up" — chosen because it has been
# public, captioned, and monetized for 15+ years, so it will not be
# age-gated, private, or region-restricted in any plausible future.
smoke_video="https://www.youtube.com/watch?v=dQw4w9WgXcQ"
if ! docker exec youtube-ai-service yt-dlp --dump-json --skip-download \
    --extractor-args "youtube:player_client=web_safari,mweb,android_vr" \
    --extractor-args "youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416" \
    "$smoke_video" >/dev/null 2>&1; then
  echo "[smoke] FAIL: yt-dlp extraction failed for $smoke_video"
  docker exec youtube-ai-service yt-dlp --dump-json --skip-download \
      --extractor-args "youtube:player_client=web_safari,mweb,android_vr" \
      --extractor-args "youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416" \
      "$smoke_video" 2>&1 | tail -20 || true
  exit 1
fi
echo "[smoke] OK: yt-dlp extraction succeeded"

echo "[smoke] all checks passed"
