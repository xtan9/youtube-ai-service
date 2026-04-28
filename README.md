# youtube-ai-service

Lightweight transcription microservice. Part of the YouTube AI Chat stack.

## Endpoints

- `POST /metadata` — Extract video metadata (title, description, detected language, duration in seconds or `null`, available caption track codes) via `yt-dlp --dump-json`. Call this first so the orchestrator can pin caption + whisper language and avoid the default "pick tracks[0]" bug that produced wrong-language transcripts. `duration` lets callers fail fast on videos too long for the no-captions Whisper fallback to finish inside `VPS_TIMEOUT_MS`.
- `POST /captions` — Fetch YouTube auto-captions for a video. Accepts an optional `lang` (ISO 639-1 or BCP-47) that forwards to `youtube-transcript-plus` so a specific caption track is selected. Returns 200 with `{ transcript, source, language, title, channelName }` or 404 `{ error: "no_captions" }` if the track isn't available. Much cheaper than transcription — call this before `/transcribe`.
- `POST /transcribe` — Transcribe a YouTube video's audio. Primary path: download audio via yt-dlp, then post to [Groq](https://groq.com)'s `whisper-large-v3`. Falls back to local `whisper-ctranslate2` for audio ≤ `GROQ_LOCAL_FALLBACK_MAX_SECONDS` (default 180s) when Groq fails. Returns 503 when Groq fails and audio is over the fallback cap. Accepts an optional `lang` (ISO 639-1 / BCP-47) forwarded to whichever backend handles the request.
- `GET /health` — Health check (unauthenticated).

All data endpoints require `Authorization: Bearer <VPS_API_KEY>`.

### Environment variables

- `VPS_API_KEY` (required) — Bearer token clients must present.
- `GROQ_API_KEY` (required for primary transcription path) — when unset, the service silently falls through to local Whisper at any audio length.
- `GROQ_MODEL` (optional, default `whisper-large-v3`). Set to `whisper-large-v3-turbo` to trade accuracy for speed; the default favours accuracy because turbo hallucinates more on long silent stretches.
- `GROQ_TIMEOUT_MS` (optional, default 120000).
- `GROQ_LOCAL_FALLBACK_MAX_SECONDS` (optional, default 180) — audio cap above which we 503 instead of falling back to local Whisper after a Groq failure.
- `TS_AUTHKEY`, `TS_EXIT_NODE_HOSTNAME` — Tailscale exit-node config.

## Tech

Node.js 22, Hono, Python (faster-whisper), yt-dlp, ffmpeg, `eld` for text-based language detection (with a CJK Unicode-script fallback for short titles where eld is unreliable). Runs in Docker.

## Architecture

Three containers in one compose stack:

1. **`youtube-ai-service`** — the Node/Hono app itself
2. **`tailscale-exit`** — scoped Tailscale client. Routes all yt-dlp egress through a residential home device (exit node) so YouTube's datacenter-IP bot-wall doesn't fire
3. **`pot-provider`** — generates Proof-of-Origin tokens (`brainicism/bgutil-ytdlp-pot-provider`) that YouTube requires on many extraction paths

`youtube-ai-service` and `pot-provider` share `tailscale-exit`'s network namespace (`network_mode: service:tailscale-exit`), so:
- All three egress through the exit node (consistent caller identity)
- Port 3001 is published by `tailscale-exit`
- `pot-provider` is reachable at `127.0.0.1:4416` from inside the app container

## Local Development

```bash
npm install
npm run dev
```

Local dev does not bring up Tailscale or pot-provider — yt-dlp falls back to direct calls, which will hit YouTube's bot wall from most networks. Use production for anything beyond unit tests.

## Deployment

Pushes to `main` trigger the CI workflow; on success, Deploy SSHes into the VPS, pulls, and runs `scripts/deploy.sh`.

**Required GitHub secrets:**
- `SERVER_HOST` — VPS hostname or IP
- `SERVER_SSH_KEY` — SSH private key with access to `/opt/youtube-ai-service` on the VPS
- `TS_AUTHKEY` — Tailscale reusable auth key (create at https://login.tailscale.com/admin/settings/keys, tag `tag:vps`, expiry ~90 days, set a calendar reminder to rotate)
- `TS_EXIT_NODE_HOSTNAME` — Tailscale hostname of the home device acting as exit node (visible in the Tailscale admin console)

**Home-side setup (one-time):**

1. Install Tailscale on an always-on home device (old Mac laptop, Raspberry Pi, NAS).
2. Run `tailscale up --advertise-exit-node` (or toggle in the GUI).
3. In the [admin console](https://login.tailscale.com/admin/machines), find the device → "..." → Edit route settings → **Use as exit node**.
4. Note the device's Tailscale hostname — this is `TS_EXIT_NODE_HOSTNAME`.
5. Keep the device awake 24/7 (on macOS: `sudo pmset -c sleep 0 disablesleep 1`).

**VPS setup (one-time):**

```bash
git clone <repo> /opt/youtube-ai-service
cd /opt/youtube-ai-service
cp .env.example .env
# Edit .env to set VPS_API_KEY
./scripts/deploy.sh
```

The deploy pipeline writes `TS_AUTHKEY` and `TS_EXIT_NODE_HOSTNAME` into `.env` automatically via `scripts/update-env.sh`. VPS_API_KEY stays manual.

## Ops

**Verify egress goes through home IP:**
```bash
ssh root@<vps> docker compose exec youtube-ai-service curl -s https://ifconfig.me
# Should print your HOME IP, not the Hetzner IP.
```

**Check PO Token provider:**
```bash
ssh root@<vps> docker compose exec youtube-ai-service curl -s http://127.0.0.1:4416/ping
```

**Tailscale status:**
```bash
ssh root@<vps> docker compose exec tailscale-exit tailscale status
```

**When the home device goes offline:** yt-dlp fails (no egress through exit node). Captioned videos still work because the frontend tries caption extraction before falling back to the VPS. Bring the home device back online; the stack self-heals without a redeploy.

## Auth

`VPS_API_KEY` is a shared secret between this service and the Next.js API route that calls it. Keep it out of the repo.
