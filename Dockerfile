FROM node:22-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

FROM node:22-slim

# Enable pipefail for every RUN so a failing pipe component (e.g. a 503
# from an install.sh download) aborts the build instead of silently
# feeding a truncated script into the next stage.
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# `bgutil-ytdlp-pot-provider` is pinned to match the `pot-provider` sidecar
# image tag in docker-compose.yml. Client plugin and provider server talk a
# versioned protocol; letting pip float risks a silent mismatch where the
# plugin returns no PO Token and yt-dlp falls back to no-PO-Token mode,
# which YouTube rejects for player responses.
ARG BGUTIL_POT_VERSION=1.3.1
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv ffmpeg curl unzip ca-certificates \
    && python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir \
        faster-whisper \
        yt-dlp \
        "bgutil-ytdlp-pot-provider==${BGUTIL_POT_VERSION}" \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# `bgutil-ytdlp-pot-provider` is a yt-dlp plugin that fetches Proof-of-Origin
# tokens from the `pot-provider` sidecar container (see docker-compose.yml).
# YouTube enforces PO Tokens on multiple extraction paths; without them even
# cookied requests fail on many video IDs. Pairs with the
# `--extractor-args youtubepot-bgutilhttp:base_url=...` flag in ytdlp.ts.

# Install deno — yt-dlp warns "No supported JavaScript runtime could be
# found" without it, and some newer YouTube player clients need JS to
# solve nonce/signature challenges during extraction. Version pinned so
# a breaking deno release can't ship to prod on the next image rebuild.
ARG DENO_VERSION=v2.1.4
RUN curl -fsSL https://deno.land/install.sh | sh -s -- --yes ${DENO_VERSION} \
    && mv /root/.deno/bin/deno /usr/local/bin/deno \
    && deno --version

ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist

ENV PORT=3001
EXPOSE 3001

CMD ["node", "dist/index.js"]
