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
# Catches ENOENT-class failures where a Python-only package was installed
# but no binary exists on PATH (e.g. `pip install faster-whisper` gives
# you the library but no CLI). Verifying `--version` from the same shell
# `execFile` uses catches venv PATH drift, package renames, and image
# misconfigurations before any user request hits them.
if ! docker exec youtube-ai-service whisper-ctranslate2 --version >/dev/null 2>&1; then
  echo "[smoke] FAIL: whisper-ctranslate2 not reachable from app container"
  docker exec youtube-ai-service whisper-ctranslate2 --version 2>&1 | tail -5 || true
  exit 1
fi
echo "[smoke] OK: whisper-ctranslate2 reachable"

echo "[smoke] GROQ_API_KEY: verifying the secret reached the container env"
# A missing secret means the route falls through to local Whisper at any
# length — works for short clips but defeats the purpose of the Groq
# rollout. Loud failure here so a forgotten GitHub-secret rotation can't
# silently degrade prod to slow CPU transcription.
if ! docker exec youtube-ai-service sh -c '[ -n "$GROQ_API_KEY" ]'; then
  echo "[smoke] FAIL: GROQ_API_KEY not populated in youtube-ai-service container env"
  exit 1
fi
echo "[smoke] OK: GROQ_API_KEY present"

echo "[smoke] Groq direct egress: verifying the internal forwarder reaches Groq"
# The app shares the residential Tailscale namespace for YouTube. Large Groq
# uploads reset on that route, so production points GROQ_API_URL at a bridge-
# network forwarder whose own egress is the VPS. The models call is cheap and
# proves DNS, Docker routing, TLS, auth forwarding, and Groq availability
# without consuming audio transcription quota.
forwarder_ip="$(docker exec yt-ai-groq-forwarder wget -q -O - https://api.ipify.org || echo unknown)"
if [[ "$forwarder_ip" == "unknown" || "$forwarder_ip" != "$vps_ip" ]]; then
  echo "[smoke] FAIL: Groq forwarder egress=$forwarder_ip; expected direct VPS egress=$vps_ip"
  exit 1
fi
if ! docker exec youtube-ai-service node -e "
const url = new URL(process.env.GROQ_API_URL);
if (url.hostname !== 'groq-forwarder') {
  console.error('unexpected GROQ_API_URL host', url.hostname);
  process.exit(1);
}
url.pathname = '/openai/v1/models';
fetch(url, {
  headers: { Authorization: 'Bearer ' + process.env.GROQ_API_KEY },
}).then(async r => {
  if (!r.ok) { console.error('status', r.status, await r.text()); process.exit(1); }
  process.exit(0);
}).catch(e => { console.error(e.message); process.exit(1); });
" 2>&1; then
  echo "[smoke] FAIL: Groq models endpoint not reachable through direct-egress forwarder"
  docker logs yt-ai-groq-forwarder --tail 40 || true
  exit 1
fi
echo "[smoke] OK: Groq forwarder egress=$forwarder_ip (VPS direct) and API returned 200"

echo "[smoke] pot-provider: verifying HTTP listener is reachable from the app container"
if ! docker exec youtube-ai-service node -e "require('http').get('http://127.0.0.1:4416/ping', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"; then
  echo "[smoke] FAIL: pot-provider /ping not reachable from app container"
  docker logs yt-ai-pot-provider --tail 40 || true
  exit 1
fi
echo "[smoke] OK: pot-provider /ping returned 200"

echo "[smoke] captions: end-to-end fetch for a known-captioned public video"
# Asserts three invariants at once: residential egress is routing
# (youtube-transcript-plus can reach YouTube), YouTube does not treat
# the caller as a datacenter (caption tracks aren't stripped from the
# watch-page response), and the route's 200 contract holds. A failure
# here means the cheap caption path is degraded and the expensive
# Whisper path will start carrying traffic it shouldn't.
# Guard: if VPS_API_KEY isn't injected into compose env, the smoke
# would fail with a misleading 401.
if ! docker exec youtube-ai-service sh -c '[ -n "$VPS_API_KEY" ]'; then
  echo "[smoke] FAIL: VPS_API_KEY not populated in youtube-ai-service container env"
  exit 1
fi
if ! docker exec youtube-ai-service node -e "
const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
fetch('http://localhost:3001/captions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + process.env.VPS_API_KEY,
  },
  body: JSON.stringify({ youtube_url: url }),
}).then(async r => {
  if (!r.ok) { console.error('status', r.status, await r.text()); process.exit(1); }
  const j = await r.json();
  if (!j.transcript || j.transcript.length < 50) {
    console.error('transcript too short:', j.transcript?.length); process.exit(1);
  }
  process.exit(0);
}).catch(e => { console.error(e.message); process.exit(1); });
" 2>&1; then
  echo "[smoke] FAIL: /captions end-to-end check failed"
  exit 1
fi
echo "[smoke] OK: /captions returned a real transcript"

echo "[smoke] yt-dlp: complete media download from a known short public video"
# Metadata extraction can succeed while the signed googlevideo URL still
# returns HTTP 403. A 10 KiB `--test` probe is insufficient: mweb URLs have
# served that first Range and then rejected the complete request. Download the
# full audio stream so this check covers the player client, EJS challenge
# solver, CDN URL, and sustained media transfer.
# dQw4w9WgXcQ is "Never Gonna Give You Up" — chosen because it has been
# public, captioned, and monetized for 15+ years, so it will not be
# age-gated, private, or region-restricted in any plausible future.
smoke_video="https://www.youtube.com/watch?v=dQw4w9WgXcQ"
if ! docker exec -e SMOKE_VIDEO="$smoke_video" youtube-ai-service sh -ec '
    probe_dir="$(mktemp -d /tmp/ytai-media-smoke.XXXXXX)"
    trap '\''rm -rf "$probe_dir"'\'' EXIT
    yt-dlp --no-playlist \
      --js-runtimes deno \
      --extractor-args "youtube:player_client=web_embedded" \
      --extractor-args "youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416" \
      -f "249/250/bestaudio[ext=webm]/bestaudio" \
      -o "$probe_dir/probe.%(ext)s" \
      "$SMOKE_VIDEO" >/dev/null 2>&1
    find "$probe_dir" -type f -size +0c -print -quit | grep -q .
  '; then
  echo "[smoke] FAIL: complete yt-dlp media download failed"
  docker exec youtube-ai-service yt-dlp --version || true
  docker exec youtube-ai-service deno --version || true
  exit 1
fi
echo "[smoke] OK: complete yt-dlp media download succeeded"

echo "[smoke] all checks passed"
