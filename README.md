# youtube-ai-service

Lightweight transcription microservice. Part of the YouTube AI Chat stack.

## Endpoints

- `POST /transcribe` — Download audio via yt-dlp and transcribe with faster-whisper. Requires `Authorization: Bearer <VPS_API_KEY>`.
- `GET /health` — Health check (unauthenticated).

## Tech

Node.js 22, Hono, Python (faster-whisper), yt-dlp, ffmpeg. Runs in Docker.

## Local Development

```bash
npm install
npm run dev
```

## Deployment

Pushes to `main` trigger the GitHub Actions workflow that SSHes into the VPS, pulls, and runs `scripts/deploy.sh`.

**Required GitHub secrets:**
- `SERVER_HOST` — VPS hostname or IP
- `SERVER_SSH_KEY` — SSH private key with access to `/opt/youtube-ai-service` on the VPS

**VPS setup (one-time):**

```bash
git clone <repo> /opt/youtube-ai-service
cd /opt/youtube-ai-service
cp .env.example .env
# Edit .env to set VPS_API_KEY
./scripts/deploy.sh
```

## Auth

`VPS_API_KEY` is a shared secret between this service and the Next.js API route that calls it. Keep it out of the repo.
