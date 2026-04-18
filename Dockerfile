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

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv ffmpeg curl unzip ca-certificates \
    && python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir faster-whisper yt-dlp \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

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
