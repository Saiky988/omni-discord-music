# Omni Discord Music (`omni-discord-music`)

![Node.js](https://img.shields.io/badge/node-%3E%3D18.18%20(20%20LTS%20Recommended)-339933?logo=node.js&logoColor=white)
![Discord.js](https://img.shields.io/badge/discord.js-v14-5865F2?logo=discord&logoColor=white)
![Module System](https://img.shields.io/badge/module-ESM-F7DF1E?logo=javascript&logoColor=black)
![License](https://img.shields.io/badge/license-MIT-blue)

**Omni Discord Music** (`omni-discord-music`) is a production-grade, open-source, multi-guild Discord music bot built with Node.js (ESM), `discord.js` v14, `@discordjs/voice`, `play-dl`, `yt-dlp`, and `ffmpeg`.

It provides deterministic per-guild audio queues, dual command interfaces (`/slash` and `!prefix` sharing a single execution pipeline), zero-buffering raw PCM audio streaming (`s16le`, 48 kHz, stereo), strict SSRF and command-injection protections, and idempotent child-process lifecycle management.

---

## Feature Matrix

| Capability | Implementation Details |
| :--- | :--- |
| **Dual Command Interfaces** | Discord Slash Commands (`/play`, `/skip`, `/queue`, etc.) and Prefix Commands (`!play`, `!skip`, `!queue`, etc.) routed through one unified handler and permission gate |
| **Multi-Guild Isolation** | Independent `GuildQueue`, `AudioPlayer`, `VoiceConnection`, active `sessionId`, loop state, volume state, and idle disconnect timer per guild |
| **Zero-Buffering PCM Pipeline** | Native `child_process.spawn` (`shell: false`) piping `yt-dlp` `stdout` into `ffmpeg` `stdin` (`s16le`, `48000` Hz, `2` channels) into `@discordjs/voice` `StreamType.Raw` with backpressure propagation |
| **Multi-Platform Resolution** | YouTube, YouTube Music, Spotify (metadata to playable search fallback), Apple Music (metadata to playable search fallback), SoundCloud, TikTok, Douyin, Facebook, Instagram, and validated direct media URLs |
| **Loop & Queue Modes** | `off` (FIFO), `track` (replay active track without queue duplication), and `queue` (append naturally finished tracks to the tail in FIFO order) |
| **Process & Stream Safety** | Session-tagged pipelines, idempotent cleanup, `SIGTERM` to `SIGKILL` escalation timeouts, and protection against stale process events corrupting subsequent tracks |
| **Security & SSRF Protection** | Strict hostname boundary checks, protocol filtering, IPv4/IPv6 loopback/private/link-local/CGNAT/IMDS blocking, obfuscated IP rejection, redirect hop revalidation, and CLI flag-injection prevention |
| **Structured Observability** | JSON structured logger with severity filtering (`debug`, `info`, `warn`, `error`, `silent`) and automatic token/cookie/signed-URL redaction |

---

## Architecture Overview

```text
omni-discord-music/
├── .env.example              # Documented environment variable template
├── .gitignore                # Excludes secrets, node_modules, logs, and temp artifacts
├── LICENSE                   # MIT License
├── README.md                 # Complete setup, operational, and security documentation
├── package.json              # ESM package manifest and scripts
├── ecosystem.config.js       # PM2 single-instance fork-mode production config
├── Dockerfile                # Hardened Debian Bookworm Node 20 LTS image with ffmpeg & verified yt-dlp
├── docker-compose.yml        # Single-service container deployment configuration
├── src/
│   ├── config.js             # Startup environment parser, bounds validator, and secret redactor
│   ├── index.js              # Bot client entrypoint, event wiring, and graceful shutdown
│   ├── deploy-commands.js    # Guild/Global Discord Slash Command registration script
│   ├── commands/
│   │   ├── index.js          # Command loader, validator, permission checks, slash & prefix router
│   │   ├── play.js           # /play and !play
│   │   ├── pause.js          # /pause and !pause
│   │   ├── resume.js         # /resume and !resume
│   │   ├── skip.js           # /skip and !skip
│   │   ├── stop.js           # /stop and !stop
│   │   ├── queue.js          # /queue and !queue (paginated)
│   │   ├── volume.js         # /volume and !volume
│   │   ├── loop.js           # /loop and !loop
│   │   ├── nowplaying.js     # /nowplaying and !nowplaying
│   │   └── help.js           # /help and !help
│   ├── services/
│   │   ├── resolver.js       # Source detection, metadata extraction, playlist bounding, and fallback search
│   │   ├── streamer.js       # yt-dlp -> ffmpeg PCM pipeline and idempotent child-process lifecycle
│   │   └── queueManager.js   # Per-guild state machine, loop progression, recovery, and idle timers
│   └── utils/
│       ├── discordSdk.js     # Upstream discord.js / @discordjs/voice / play-dl loader with offline test support
│       ├── embeds.js         # Standardized Discord embeds and mention/markdown sanitization
│       ├── errors.js         # Typed application error hierarchy and error codes
│       ├── logger.js         # Structured JSON logger with secret and query-signature redaction
│       └── urlSafety.js      # Hostname boundary matcher, SSRF IP/DNS validator, and redirect verifier
└── tests/
    ├── resolver.test.js      # URL validation, SSRF, hostname spoofing, platform & playlist tests
    ├── streamer.test.js      # Spawn lifecycle, PCM piping, error codes, EPIPE, and idempotent cleanup tests
    ├── queueManager.test.js  # Guild isolation, FIFO, loop modes, skip/stop, idle timer, and failure tests
    └── commands.test.js      # Command loading, slash serialization, config validation, and parity tests
```

### Playback Data Flow

1. **Command Ingestion (`src/commands/index.js`)**: A user invokes `/play` or `!play`. The unified command handler validates guild presence, user voice channel membership, channel match against any active bot connection, and `Connect`/`Speak` permissions.
2. **Source Resolution (`src/services/resolver.js`)**: Input is trimmed and classified. Plain-text queries are resolved into concrete playable URLs before reaching the streaming engine. URLs undergo strict hostname boundary verification and SSRF checks (`src/utils/urlSafety.js`). Spotify and Apple Music links are resolved for metadata (`title`, `artist`, `duration`, `thumbnail`) and mapped to a playable YouTube or SoundCloud stream with `isFallback: true`.
3. **Queue Management (`src/services/queueManager.js`)**: The guild's isolated `GuildQueue` ensures the `VoiceConnection` is in `VoiceConnectionStatus.Ready` via `entersState()`. If idle, playback starts immediately; otherwise tracks are appended up to `MAX_QUEUE_SIZE`.
4. **Audio Streaming (`src/services/streamer.js`)**: `createAudioStream()` spawns `yt-dlp` (`-f bestaudio/best --no-playlist --quiet -o - <url>`) and pipes `stdout` directly into `ffmpeg` (`-i pipe:0 -analyzeduration 0 -loglevel 0 -f s16le -ar 48000 -ac 2 pipe:1`). The resulting PCM stream is wrapped in a `@discordjs/voice` `AudioResource` with `StreamType.Raw` and `inlineVolume: true`.
5. **Lifecycle & Cleanup**: Every playback session receives a unique `sessionId`. When a track finishes naturally, is skipped, fails, or is stopped, `cleanup()` idempotently unpipes and destroys streams, sends `SIGTERM` to child processes, and escalates to `SIGKILL` if any child remains alive past `PROCESS_KILL_TIMEOUT_MS`.

---

## Supported and Partially Supported Sources

| Source Platform | Single Track | Playlists / Albums | Resolution Mechanism & Notes |
| :--- | :--- | :--- | :--- |
| **YouTube & YouTube Music** | Supported | Supported (up to `MAX_PLAYLIST_TRACKS`) | Direct extraction via `yt-dlp`; search queries resolved via `play-dl` or `ytsearch1:` |
| **Spotify** | Supported | Supported (Albums & Playlists) | Metadata resolved via `play-dl` / Spotify oEmbed, then mapped to a playable YouTube/SoundCloud source (`isFallback: true`). Does **not** stream DRM audio directly from Spotify |
| **Apple Music** | Supported | Supported (Albums & Playlists) | Metadata resolved via iTunes Lookup API / configured resolver and mapped to a playable YouTube/SoundCloud stream (`isFallback: true`) |
| **SoundCloud** | Supported | Supported (`/sets/`) | Direct extraction via `yt-dlp` and search fallback via `scsearch1:` |
| **TikTok & Douyin** | Supported (Public posts with audio) | N/A | Extracts audio from public video posts and slide posts that expose a playable audio stream. Silent photo carousels without an extractable audio track are rejected with a clear user notice |
| **Facebook & Instagram** | Partially Supported (Public media) | N/A | Publicly accessible reels/videos supported by `yt-dlp` without authentication or DRM |
| **Direct Media Links** | `.mp3`, `.m4a`, `.flac`, `.wav`, `.ogg`, `.opus`, `.m3u8` | N/A | Validated against SSRF rules, DNS resolution checks, redirect revalidation, and `Content-Type` header inspection before streaming |

---

## Prerequisites

- **Node.js**: Node.js `20.x` LTS recommended (compatible with Node.js `>=18.18.0`).
- **FFmpeg**: System `ffmpeg` binary accessible on `PATH` (or configured via `FFMPEG_PATH`).
- **yt-dlp**: Up-to-date `yt-dlp` executable accessible on `PATH` (or configured via `YTDLP_PATH`), plus `python3` if using the standalone zipimport script (`yt-dlp`).
- **Build Tools (only when prebuilt native binaries are unavailable)**: C/C++ compiler toolchain (`build-essential`, `python3`) for `@discordjs/opus` and `sodium-native`.

### Installing Prerequisites

#### Node.js (20 LTS)
```bash
# Ubuntu / Debian via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v && npm -v
```

#### FFmpeg
```bash
# Ubuntu / Debian
sudo apt-get update && sudo apt-get install -y ffmpeg

# macOS (Homebrew)
brew install ffmpeg

ffmpeg -version
```

#### yt-dlp Installation and Safe Updating
Install `yt-dlp` from the official GitHub release and verify its SHA-256 checksum:
```bash
YTDLP_VERSION="2024.10.22"
sudo curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp" -o /usr/local/bin/yt-dlp.new
curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/SHA2-256SUMS" -o /tmp/SHA2-256SUMS
grep "  yt-dlp$" /tmp/SHA2-256SUMS | awk '{print $1 "  /usr/local/bin/yt-dlp.new"}' | sha256sum -c -
sudo chmod a+rx /usr/local/bin/yt-dlp.new
sudo mv -f /usr/local/bin/yt-dlp.new /usr/local/bin/yt-dlp
rm -f /tmp/SHA2-256SUMS
yt-dlp --version
```

**Safe Updating in Production**:
Never overwrite `/usr/local/bin/yt-dlp` in-place via `curl -o /usr/local/bin/yt-dlp` while the bot is running, as writing directly to an open executable can trigger `ETXTBSY` ("Text file busy") or corrupt a concurrent spawn. Always download to a temporary file on the same filesystem (`/usr/local/bin/yt-dlp.tmp`), verify the checksum, `chmod +x`, and atomically replace via `mv -f /usr/local/bin/yt-dlp.tmp /usr/local/bin/yt-dlp` (POSIX `rename(2)` is atomic and safe even while existing processes run).

Example weekly host cron job (`/etc/cron.d/update-ytdlp`, for bare-metal/PM2 hosts):
```cron
0 4 * * 0 root /usr/local/bin/yt-dlp -U >/var/log/ytdlp-update.log 2>&1
```
*(For Docker deployments, rebuild the container image with the updated `YTDLP_VERSION` build argument rather than mutating binaries inside a running container.)*

---

## Discord Developer Portal Setup

1. Navigate to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**.
2. Copy the **Application ID** and set it as `DISCORD_CLIENT_ID` in your `.env`.
3. Open the **Bot** tab:
   - Click **Reset Token** (or copy your existing bot token) and set it as `DISCORD_TOKEN` in `.env`.
   - Under **Privileged Gateway Intents**, enable **Message Content Intent** (required for `!` prefix commands).
4. Open **OAuth2 -> URL Generator**:
   - Select Scopes: `bot` and `applications.commands`.
   - Select Bot Permissions:
     - `View Channels`
     - `Send Messages`
     - `Embed Links`
     - `Read Message History`
     - `Connect`
     - `Speak`
   - Copy the generated URL and invite the bot to your Discord server.

### Required Gateway Intents
- `GatewayIntentBits.Guilds`
- `GatewayIntentBits.GuildVoiceStates`
- `GatewayIntentBits.GuildMessages`
- `GatewayIntentBits.MessageContent`

---

## Environment Configuration (`.env`)

Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

| Variable | Required | Default | Description |
| :--- | :---: | :---: | :--- |
| `DISCORD_TOKEN` | **Yes** | — | Discord Bot Token |
| `DISCORD_CLIENT_ID` | **Yes** | — | Discord Application Snowflake ID |
| `DISCORD_GUILD_ID` | No | *(empty)* | Development Guild ID for instant guild-scoped command deployment |
| `PREFIX` | No | `!` | Prefix for text commands (1–5 non-whitespace chars) |
| `DEFAULT_VOLUME` | No | `80` | Initial volume percentage per guild (`0..MAX_VOLUME`) |
| `MAX_VOLUME` | No | `200` | Maximum allowed volume percentage (`1..500`) |
| `IDLE_TIMEOUT_MS` | No | `180000` | Inactivity timeout in ms before leaving voice (3 minutes) |
| `MAX_QUEUE_SIZE` | No | `500` | Maximum upcoming tracks queued per guild |
| `MAX_PLAYLIST_TRACKS` | No | `100` | Maximum tracks imported from a single playlist/album |
| `MAX_TRACK_DURATION_SECONDS` | No | `14400` | Maximum duration for non-live tracks (4 hours) |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, `error`, or `silent` |
| `YTDLP_PATH` | No | `yt-dlp` | Path or executable name for `yt-dlp` |
| `FFMPEG_PATH` | No | `ffmpeg` | Path or executable name for `ffmpeg` |
| `RESOLVE_TIMEOUT_MS` | No | `20000` | Timeout in ms for metadata resolution |
| `STREAM_SPAWN_TIMEOUT_MS` | No | `15000` | Timeout in ms for stream startup |
| `PROCESS_KILL_TIMEOUT_MS` | No | `5000` | Grace period in ms before `SIGTERM` escalates to `SIGKILL` |
| `VOICE_READY_TIMEOUT_MS` | No | `20000` | Timeout in ms waiting for `VoiceConnectionStatus.Ready` |
| `VOICE_RECONNECT_ATTEMPTS` | No | `3` | Bounded automatic reconnection attempts on voice disconnect |
| `MAX_CONSECUTIVE_FAILURES` | No | `3` | Consecutive track extraction failures before halting auto-advance |
| `PLAYLIST_CONCURRENCY` | No | `3` | Bounded parallel workers when mapping playlists |
| `METADATA_CACHE_TTL_MS` | No | `300000` | Metadata cache TTL in ms (5 minutes) |
| `METADATA_CACHE_MAX_ENTRIES` | No | `250` | Maximum entries in bounded LRU metadata cache |
| `ALLOW_HTTP_MEDIA` | No | `false` | Allow plain `http://` URLs for direct media |

---

## Local Installation & Slash Command Deployment

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env and set DISCORD_TOKEN and DISCORD_CLIENT_ID

# 3. Register slash commands (guild-scoped if DISCORD_GUILD_ID is set, global otherwise)
npm run deploy-commands

# 4. Start in development mode (with nodemon) or production mode
npm run dev
# or
npm start
```

---

## Production Deployment

> **Important**: Docker Compose and PM2 are **alternative** deployment methods. Never run both Docker and host PM2 simultaneously with the same `DISCORD_TOKEN`, as running two instances causes duplicate responses and voice gateway conflicts.

### Option A: Docker & Docker Compose
```bash
# 1. Prepare .env
cp .env.example .env

# 2. Deploy slash commands using the container
docker compose run --rm omni-music npm run deploy-commands

# 3. Build and start the service in detached mode
docker compose up -d --build

# 4. View structured logs
docker compose logs -f omni-music
```

### Option B: PM2 Process Manager (Host Deployment)
`ecosystem.config.js` runs the bot in `fork` mode with `instances: 1` (never `cluster` mode, since Discord voice connections and players are stateful in-memory per guild).
```bash
# 1. Install dependencies and deploy commands
npm ci --omit=dev
npm run deploy-commands

# 2. Start with PM2
npx pm2 start ecosystem.config.js

# 3. Save PM2 process list and enable startup service
npx pm2 save
npx pm2 logs omni-discord-music
```

---

## Command Reference

All commands work identically via `/` slash commands and the configured prefix (`!` by default).

| Slash Command | Prefix Command & Aliases | Voice Required | Description |
| :--- | :--- | :---: | :--- |
| `/play query:<input>` | `!play <input>` (`!p`) | Yes | Resolve a URL or search query, join voice, and play or enqueue |
| `/pause` | `!pause` | Yes (Same channel) | Pause the currently playing track |
| `/resume` | `!resume` (`!unpause`) | Yes (Same channel) | Resume a paused track without recreating the player or stream |
| `/skip` | `!skip` (`!s`, `!next`) | Yes (Same channel) | Skip the current track and advance to the next queued track |
| `/stop` | `!stop` (`!leave`, `!clear`) | Yes (Same channel) | Stop playback, clear queue, reset loop mode to `off`, kill child processes, and start idle timer |
| `/queue [page:<1..100>]` | `!queue [page]` (`!q`) | No | Display the active track, paginated upcoming tracks (10/page), loop state, and volume |
| `/nowplaying` | `!nowplaying` (`!np`) | No | Display detailed metadata for the currently playing track |
| `/volume level:<0..200>` | `!volume <0..200>` (`!vol`, `!v`) | Yes (Same channel) | Adjust per-guild inline volume immediately for active and upcoming tracks |
| `/loop mode:<off\|track\|queue>` | `!loop <off\|track\|queue>` (`!repeat`) | Yes (Same channel) | Set queue loop mode (`off`, `track`, or `queue`) |
| `/help` | `!help` (`!h`, `!commands`) | No | Display available commands and usage syntax |

---

## Queue, Loop, and Lifecycle Behavior

- **Natural Track Completion**:
  - `off`: Removes the finished track and starts the next track in FIFO order.
  - `track`: Replays the finished track without duplicating it in the upcoming queue array.
  - `queue`: Appends the finished track to the end of the queue and starts the next track in FIFO order.
- **Explicit Skip (`/skip`)**: Disposes the active stream session and advances to the next track. Even if `loop` is set to `track`, skipping advances past the current track instead of replaying it.
- **Explicit Stop (`/stop`)**: Clears all queued tracks, resets `loopMode` to `off`, terminates active `yt-dlp`/`ffmpeg` child processes, and starts the 3-minute (`IDLE_TIMEOUT_MS`) disconnect timer.
- **Track Extraction Failure**: Increments the guild's `consecutiveFailures` counter, notifies the text channel, and skips to the next track (never re-looping a failed track). If failures reach `MAX_CONSECUTIVE_FAILURES` (default `3`), auto-advancement halts cleanly and the idle timer starts.
- **Idle Disconnect**: After `IDLE_TIMEOUT_MS` (default `180000` ms / 3 minutes) with no active playback, the bot destroys the voice connection and removes the guild queue from memory. Adding a new track cancels the idle timer immediately.

---

## Security Considerations

- **No Shell Interpolation**: Child processes (`yt-dlp` and `ffmpeg`) are spawned strictly via `child_process.spawn(executable, argsArray, { shell: false })`. User inputs starting with `-` are rejected before process creation to prevent CLI flag injection.
- **SSRF Protection**: `src/utils/urlSafety.js` enforces HTTPS by default, blocks embedded URL credentials, blocks `localhost`/`.local`/`.internal` hostnames, rejects IPv4/IPv6 loopback, private (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`), link-local (`169.254/16`, `fe80::/10`), cloud metadata (`169.254.169.254`), CGNAT, and obfuscated integer/octal/hex IP literals. Direct media URLs undergo DNS verification and manual redirect-hop revalidation.
- **Secret Redaction**: `src/config.js` and `src/utils/logger.js` redact `DISCORD_TOKEN`, bearer tokens, cookies, and signed URL query parameters (`sig`, `signature`, `token`, `hdnea`, `X-Amz-Signature`, etc.) from all logs and error outputs.

---

## Known Limitations

- **DRM & Private Content**: The bot does not bypass authentication, paywalls, DRM, or age/region blocks. Spotify and Apple Music links are resolved via metadata and matched to publicly playable YouTube/SoundCloud streams rather than streaming encrypted audio directly from Spotify or Apple Music.
- **TikTok / Douyin Photo Carousels**: While video posts and slide posts with an exposed audio stream are supported, silent photo carousels without an independently extractable audio stream cannot be played and will return an `UnsupportedMediaError` embed.
- **Extractor Upstream Changes**: Social platforms (TikTok, Douyin, Instagram, Facebook, YouTube) periodically change their web payloads. Keeping `yt-dlp` updated is required for continued extraction reliability.

---

## Testing and Validation

Run the automated unit test suite (requires no live Discord connection or external credentials):
```bash
npm test
```

The test suite (`tests/*.test.js`) uses Node's built-in `node:test` runner and dependency injection to validate:
- **Resolver (`tests/resolver.test.js`)**: YouTube, YouTube Music, Spotify, Apple Music, SoundCloud, TikTok, Douyin, direct media, playlist truncation, hostname spoofing (`evil-youtube.com`), and SSRF/private-network rejection.
- **Streamer (`tests/streamer.test.js`)**: `yt-dlp` + `ffmpeg` argument arrays, PCM streaming, `ENOENT` missing binaries, non-zero exit codes, premature EOF, broken pipes (`EPIPE`), cancellation, and idempotent process cleanup.
- **Queue Manager (`tests/queueManager.test.js`)**: Multi-guild isolation, FIFO progression, `track` and `queue` loop modes, skip/stop semantics, duplicate advancement prevention, idle timers, bounded consecutive failures, stale session events, and voice reconnection.
- **Commands & Config (`tests/commands.test.js`)**: Command module loading, Discord API v10 SlashCommand JSON serialization, slash/prefix handler parity, and startup config validation.

---

## Troubleshooting & Diagnostics

- **`The yt-dlp binary is missing or not executable`**: Verify `yt-dlp --version` works on your host or set `YTDLP_PATH=/full/path/to/yt-dlp` in `.env`.
- **`Prefix commands (!play) are ignored`**: Enable **Message Content Intent** under the **Bot** tab in the Discord Developer Portal.
- **`Slash commands (/play) do not appear in Discord`**: Run `npm run deploy-commands`. Setting `DISCORD_GUILD_ID` registers commands in your test server immediately; global commands can take up to 1 hour to propagate across Discord.
- **`Voice connection times out before reaching Ready`**: Ensure the bot role has `Connect` and `Speak` permissions in the target voice channel and that UDP outbound traffic is permitted by your firewall.

---

## Contributing & License

Contributions, bug reports, and pull requests are welcome. Please ensure `npm test` passes and no secrets or `.env` files are included before opening a pull request.

Licensed under the [MIT License](./LICENSE).
