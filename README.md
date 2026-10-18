# Omni Discord Music

Production-grade, open-source Discord music bot built with **Node.js 22+**, **discord.js v14**, **@discordjs/voice v0.19+ (DAVE E2EE ready)**, **yt-dlp**, and **FFmpeg**.

Designed for instant response times (**Lazy Resolution**), studio-grade 48kHz PCM audio with real-time filter hot-reloading (**Bassboost**, **Nightcore**, **Speed**), multi-platform media extraction, and direct device file playback.

---

## 1. Key Features

- **Dual Command Interface & Interactive Controls**
  - Full parity between Discord Slash Commands (`/play`, `/bassboost`, `/help`) and Prefix Commands (`n!play`, `n!bb`, `n!help` or `!play`).
  - Clean, icon-free, mobile-optimized embeds with interactive player buttons (**Pause / Resume**, **Skip**, **Loop: Off / Track / Queue**, **Queue**, **Stop**).
  - Automatic bot presence status set to **Listening to n!help** on startup (`BOT_STATUS=n!help`).

- **Device Audio/Video File Playback (`/play file` & `n!play file`)**
  - **Slash Upload (`/play file:<attachment>`)**: Select and upload any audio or video file (`.mp3`, `.m4a`, `.wav`, `.flac`, `.ogg`, `.opus`, `.mp4`, `.webm`, `.mov`) directly from your phone or computer.
  - **Interactive Prefix Upload (`n!play file`)**: Type `n!play file` in chat; the bot replies immediately and waits up to **60 seconds** for you to upload your audio/video file in the channel (type `cancel` to abort).
  - **Direct Message Attachment (`n!play` + file)**: Attach an audio file directly to the `n!play` message for one-step playback.

- **Lazy Resolution & Instant Embed Reply (~150ms)**
  - **Metadata-First Fast Path**: When you play a Spotify/Apple Music track, album, or 100-track playlist, or a YouTube/TikTok link, the bot fetches lightweight metadata (`title`, `artist`, `thumbnail`, `duration`) first and replies with the Discord embed **immediately**.
  - **Just-In-Time Stream Resolution**: Queued tracks remain lightweight metadata objects until right before playback.
  - **Next-Track Background Prefetch**: While the current track is playing, `QueueManager` automatically pre-resolves **only the immediately upcoming track** (`queue.tracks[0]`) in the background so track transitions are seamless with zero wasted CPU/network work.

- **Studio-Grade 48kHz Audio & Real-Time Filter Hot-Reloading**
  - **32-Tap `swr` Resampling + Soft Limiter**: Converts audio to 48kHz 16-bit stereo PCM (`s16le`) using a 32-tap linear-interpolation resampler, `+3.5dB` baseline presence boost, and `alimiter` ceiling protection (`0.95`) to eliminate clipping or distortion even at 200% volume.
  - **Live Mid-Track Filter Switching**: Toggling `/bassboost`, `/nightcore`, or `/speed` automatically calculates the current elapsed playback second (`seekSeconds`) and hot-reloads the FFmpeg filter pipeline at the exact same position in the song.
  - **IPv4-First Direct Streaming**: Streams TikTok, Discord CDN (`cdn.discordapp.com`), and direct media links via Node.js IPv4 HTTP streams piped into `ffmpeg -i pipe:0`, preventing 4-minute IPv6 connection hangs and Cloudflare/CDN `403 Forbidden` errors.

---

## 2. Command Reference

All commands work via Slash (`/command`) and Prefix (`n!command` or `!command`).

### 2.1 Playback & Device File Upload
| Slash Command | Prefix Command & Shortcuts | Description |
| :--- | :--- | :--- |
| `/play query:<text or url>` | `n!play <text or url>`, `n!p` | Play or queue a track/playlist from a search query or URL |
| `/play file:<attachment>` | `n!play` *(with attached file)* | Upload an audio/video file directly from your device to play |
| — | `n!play file` | Bot prompts and waits 60s for you to upload an audio/video file |

### 2.2 Playback Controls & Queue
| Slash Command | Prefix Command & Shortcuts | Description |
| :--- | :--- | :--- |
| `/pause` | `n!pause` | Pause the currently playing track |
| `/resume` | `n!resume` | Resume a paused track |
| `/skip` | `n!skip`, `n!s` | Skip the current track and play the next track in queue |
| `/stop` | `n!stop` | Stop playback and clear the server queue |
| `/queue [page]` | `n!queue [page]`, `n!q` | View the active track and paginated upcoming queue |
| `/nowplaying` | `n!nowplaying`, `n!np` | Display the active track card and interactive control buttons |

### 2.3 Volume, Loop & Real-Time Audio Effects
| Slash Command | Prefix Command & Shortcuts | Parameters | Description |
| :--- | :--- | :--- | :--- |
| `/volume <level>` | `n!volume`, `n!vol`, `n!v` | `0` – `200` | Adjust server playback volume (default `100%`) |
| `/loop <mode>` | `n!loop` | `off`, `track`, `queue` | Set repeat mode for the server queue |
| `/bassboost [level]` | `n!bassboost`, `n!bb`, `n!bass` | `off`, `low`, `medium`, `high`, `extreme` | Boost sub-bass (`60Hz`) and punch (`110Hz`) from `+5dB` to `+17dB` (omit level to toggle) |
| `/nightcore [mode]` | `n!nightcore`, `n!nc` | `on`, `off` | Toggle 1.25x pitch + tempo Nightcore effect |
| `/speed <rate>` | `n!speed`, `n!tempo`, `n!rate` | `0.5` – `2.0` (`off` = `1.0x`) | Adjust playback speed between `0.5x` (slowed) and `2.0x` |
| `/help` | `n!help`, `n!h`, `n!commands` | — | Show the detailed command guide |

---

## 3. Supported Media Sources

1. **YouTube & YouTube Music**: Direct video URLs, YouTube Shorts, YouTube Music links, playlists, and plain-text search queries.
2. **Spotify**: Track, Album, and Playlist URLs (`open.spotify.com`, `spotify.link`). Uses duration-scored candidate matching (`selectBestSearchCandidate`) to ensure exact official audio matches.
3. **Apple Music**: Track, Album, and Playlist URLs (`music.apple.com`).
4. **SoundCloud**: Track URLs, Sets/Playlists, mobile share shortlinks (`on.soundcloud.com` auto-extracting the shared single track instead of a 50-track station), and search fallback.
5. **TikTok & Douyin**: Full URLs and mobile shortlinks (`vt.tiktok.com`, `vm.tiktok.com`) with fresh signed stream extraction at playback time.
6. **Facebook & Instagram**: Public video and reel URLs containing playable audio tracks.
7. **Discord CDN & Direct Media Files**: Uploaded device files and direct HTTPS media links (`.mp3`, `.m4a`, `.flac`, `.wav`, `.ogg`, `.opus`, `.aac`, `.mp4`, `.webm`, `.m3u8`).

---

## 4. System Requirements & Installation

### 4.1 Prerequisites
- **Node.js**: `>= 22.12.0` (Required by `@snazzah/davey` for Discord's mandatory DAVE End-to-End Encrypted voice handshakes).
- **FFmpeg**: Installed on system `PATH` (`apt install -y ffmpeg`).
- **yt-dlp**: Latest release installed on system `PATH` (`yt-dlp -U`).
- **Firewall**: Outbound UDP (ports `50000-65535`) and TCP `443` open for Discord Voice WebRTC/RTP.

### 4.2 Setup & Run
```bash
cd /omni-discord-music
npm install
cp .env.example .env
# Edit .env with your DISCORD_TOKEN, DISCORD_CLIENT_ID, and optional DISCORD_GUILD_ID
npm run deploy-commands
npm start
```

---

## 5. Environment Variables (`.env`)

| Variable | Default | Description |
| :--- | :--- | :--- |
| `DISCORD_TOKEN` | *(Required)* | Discord Bot Token from the Discord Developer Portal |
| `DISCORD_CLIENT_ID` | *(Required)* | Discord Application Client ID |
| `DISCORD_GUILD_ID` | *(Optional)* | Server ID for instant guild-scoped slash command deployment |
| `PREFIX` | `!` | Prefix for text commands (note: `n!` is always accepted alongside `PREFIX`) |
| `BOT_STATUS` | `n!help` | Activity status displayed on the bot profile (`Listening to n!help`) |
| `DEFAULT_VOLUME` | `100` | Initial server playback volume percentage |
| `MAX_VOLUME` | `200` | Maximum allowed volume percentage |
| `IDLE_TIMEOUT_MS` | `180000` | Disconnect after 3 minutes of inactivity |
| `MAX_QUEUE_SIZE` | `500` | Maximum tracks allowed per guild queue |
| `MAX_PLAYLIST_TRACKS` | `100` | Maximum tracks imported from a single playlist |
| `VOICE_READY_TIMEOUT_MS` | `20000` | Timeout (ms) waiting for Discord Voice `Ready` state |
| `ALLOW_HTTP_MEDIA` | `false` | Set to `true` only if you need non-TLS `http://` direct media links |

---

## 6. Project Structure

```text
omni-discord-music/
├── .env.example
├── Dockerfile
├── docker-compose.yml
├── package.json
├── README.md
├── src/
│   ├── index.js                # Bot entry point, IPv4-first DNS, DAVE check, n!help status
│   ├── config.js               # Environment loader & validation
│   ├── deploy-commands.js      # Slash command registration script
│   ├── commands/
│   │   ├── index.js            # Unified command & button router
│   │   ├── play.js             # /play, !play, /play file:, and interactive n!play file handler
│   │   ├── pause.js
│   │   ├── resume.js
│   │   ├── skip.js
│   │   ├── stop.js
│   │   ├── queue.js
│   │   ├── volume.js
│   │   ├── loop.js
│   │   ├── bassboost.js        # /bassboost & n!bb real-time sub-bass filter command
│   │   ├── nightcore.js        # /nightcore & n!nc 1.25x pitch + tempo command
│   │   ├── speed.js            # /speed & n!tempo playback rate multiplier command
│   │   ├── nowplaying.js
│   │   └── help.js             # Clean, structured command guide without backtick clutter
│   ├── services/
│   │   ├── resolver.js         # Multi-platform metadata & Lazy Resolution engine
│   │   ├── streamer.js         # IPv4 HTTP pipe + yt-dlp -> FFmpeg 48kHz audio filter pipeline
│   │   └── queueManager.js     # Per-guild state, JIT lazy resolution, next-track prefetch, filter hot-reload
│   └── utils/
│       ├── discordSdk.js       # Discord.js v14 / @discordjs/voice SDK loader
│       ├── embeds.js           # Icon-free mobile-friendly embed & button builders
│       ├── errors.js           # Structured error hierarchy
│       ├── logger.js           # Structured JSON logger with secret redaction
│       └── urlSafety.js        # SSRF protection, domain validation & media probing
└── tests/
    ├── commands.test.js
    ├── queueManager.test.js
    ├── resolver.test.js
    └── streamer.test.js
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
