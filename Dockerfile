# ============================================================================
# Production Dockerfile — omni-discord-music
# Uses Node.js 20 LTS (Debian Bookworm Slim), FFmpeg, Python 3, tini, and a
# pinned official yt-dlp release verified via SHA256 checksum.
# ============================================================================

FROM node:20-bookworm-slim AS base

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    YTDLP_VERSION=2024.10.22

# Install runtime dependencies (ffmpeg, python3 for yt-dlp, ca-certificates, curl, tini)
# and build toolchain required only if @discordjs/opus or sodium-native compiles from source
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

# Copy package manifests first to leverage Docker layer caching
COPY package*.json ./

# Install production dependencies (uses npm ci when package-lock.json is present)
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund; \
    else \
      npm install --omit=dev --no-audit --no-fund; \
    fi \
    && npm cache clean --force

# Remove build-only compilers after native addons are built to minimize attack surface
RUN apt-get purge -y --auto-remove build-essential python3-dev pkg-config libtool autoconf automake \
    && rm -rf /var/lib/apt/lists/*

# Copy application source files (never copy .env; see docker-compose.yml)
COPY src ./src
COPY LICENSE README.md ./

# Ensure non-root execution
RUN chown -R node:node /app
USER node

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
