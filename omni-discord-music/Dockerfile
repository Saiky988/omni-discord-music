# ============================================================================
# Production Dockerfile — omni-discord-music
# Uses Node.js 22 LTS (Debian Bookworm Slim) required by @discordjs/voice 0.19+
# and @snazzah/davey (Discord DAVE E2EE protocol), FFmpeg, Python 3, tini, and
# a pinned official yt-dlp release.
# ============================================================================

FROM node:22-bookworm-slim AS base

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    YTDLP_VERSION=2026.08.19

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      ffmpeg \
      python3 \
      tini \
      build-essential \
      python3-dev \
      pkg-config \
      libtool \
      autoconf \
      automake \
    && curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp" -o /usr/local/bin/yt-dlp \
    && curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/SHA2-256SUMS" -o /tmp/SHA2-256SUMS \
    && grep "  yt-dlp$" /tmp/SHA2-256SUMS | awk '{print $1 "  /usr/local/bin/yt-dlp"}' | sha256sum -c - \
    && rm -f /tmp/SHA2-256SUMS \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && ffmpeg -version >/dev/null \
    && /usr/local/bin/yt-dlp --version >/dev/null \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund; \
    else \
      npm install --omit=dev --no-audit --no-fund; \
    fi \
    && npm cache clean --force

RUN apt-get purge -y --auto-remove build-essential python3-dev pkg-config libtool autoconf automake \
    && rm -rf /var/lib/apt/lists/*

COPY src ./src
COPY LICENSE README.md ./

RUN chown -R node:node /app
USER node

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
