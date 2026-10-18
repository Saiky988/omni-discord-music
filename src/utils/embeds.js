import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} from './discordSdk.js';

/**
 * Clean, icon-free, mobile-first Discord Embed builders and interactive control bar.
 */

export const EmbedColors = Object.freeze({
  PRIMARY: 0x5865f2,
  SUCCESS: 0x2ecc71,
  PLAYING: 0x1db954,
  PAUSED: 0xf1c40f,
  WARNING: 0xe67e22,
  ERROR: 0xe74c3c,
  INFO: 0x3498db
});

const SOURCE_LABELS = Object.freeze({
  youtube: 'YouTube',
  youtube_music: 'YouTube Music',
  spotify: 'Spotify',
  apple_music: 'Apple Music',
  soundcloud: 'SoundCloud',
  tiktok: 'TikTok',
  douyin: 'Douyin',
  facebook: 'Facebook',
  instagram: 'Instagram',
  direct_media: 'Direct Audio'
});

const LOOP_LABELS = Object.freeze({
  off: 'Off',
  track: 'Track',
  queue: 'Queue'
});

const BASSBOOST_LABELS = Object.freeze({
  off: 'Off',
  low: 'Low (+5dB)',
  medium: 'Medium (+9dB)',
  high: 'High (+13dB)',
  extreme: 'Extreme (+17dB)'
});

/**
 * Sanitize user-controlled text so it cannot trigger @everyone/@here mentions,
 * break markdown links, or create runaway formatting blocks, without leaving
 * visible backslash escapes like \(Demo\) inside link titles.
 */
export function sanitizeDisplayText(text, maxLength = 256) {
  if (text === null || text === undefined) {
    return 'Unknown';
  }

  const cleaned = String(text)
    .replace(/[\0\r\n]+/g, ' ')
    .replace(/@(everyone|here)/gi, '@\u200b$1')
    .replace(/<@!?(\d+)>/g, '@user')
    .replace(/<@&(\d+)>/g, '@role')
    .replace(/\[/g, '(')
    .replace(/\]/g, ')')
    .replace(/[*_~`|\\]/g, '')
    .trim();

  if (!cleaned) {
    return 'Unknown';
  }

  if (cleaned.length <= maxLength) {
    return cleaned;
  }

  return `${cleaned.slice(0, Math.max(1, maxLength - 1))}…`;
}

/**
 * Format duration in seconds into MM:SS or HH:MM:SS.
 */
export function formatDuration(seconds, isLive = false) {
  if (isLive) {
    return 'LIVE';
  }
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return 'Unknown';
  }

  const total = Math.floor(seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export function formatSourceLabel(source) {
  return SOURCE_LABELS[source] || sanitizeDisplayText(source || 'Music', 32);
}

export function formatLoopMode(loopMode) {
  return LOOP_LABELS[loopMode] || 'Off';
}

export function formatBassboostLabel(level) {
  return BASSBOOST_LABELS[level] || 'Off';
}

function applySafeThumbnail(embed, thumbnailUrl) {
  if (!thumbnailUrl || typeof thumbnailUrl !== 'string') {
    return;
  }
  try {
    const parsed = new URL(thumbnailUrl);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      embed.setThumbnail(parsed.toString());
    }
  } catch {
    // Ignore malformed thumbnail URLs
  }
}

/**
 * Build clean, text-only interactive player control buttons (no icons/emojis).
 */
export function buildPlayerControlRow(queueState = {}) {
  const isPaused = queueState.state === 'paused' || queueState.state === 'autopaused';
  const loopMode = queueState.loopMode || 'off';

  const pauseResumeBtn = new ButtonBuilder()
    .setCustomId('music:toggle_pause')
    .setLabel(isPaused ? 'Resume' : 'Pause')
    .setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Secondary);

  const skipBtn = new ButtonBuilder()
    .setCustomId('music:skip')
    .setLabel('Skip')
    .setStyle(ButtonStyle.Secondary);

  const loopLabel =
    loopMode === 'track'
      ? 'Loop: Track'
      : loopMode === 'queue'
        ? 'Loop: Queue'
        : 'Loop: Off';

  const loopBtn = new ButtonBuilder()
    .setCustomId('music:cycle_loop')
    .setLabel(loopLabel)
    .setStyle(loopMode === 'off' ? ButtonStyle.Secondary : ButtonStyle.Primary);

  const queueBtn = new ButtonBuilder()
    .setCustomId('music:queue')
    .setLabel('Queue')
    .setStyle(ButtonStyle.Secondary);

  const stopBtn = new ButtonBuilder()
    .setCustomId('music:stop')
    .setLabel('Stop')
    .setStyle(ButtonStyle.Danger);

  return new ActionRowBuilder().addComponents(
    pauseResumeBtn,
    skipBtn,
    loopBtn,
    queueBtn,
    stopBtn
  );
}

/**
 * Compact, icon-free Now Playing card.
 */
export function buildNowPlayingEmbed(track, queueState = {}) {
  const title = sanitizeDisplayText(track?.title || 'Untitled Track', 140);
  const artist = track?.artist ? sanitizeDisplayText(track.artist, 60) : null;
  const requester = sanitizeDisplayText(track?.requestedBy || 'Unknown', 50);
  const duration = formatDuration(track?.duration, track?.isLive);
  const source = formatSourceLabel(track?.source);

  const titleLine = track?.webpageUrl
    ? `**[${title}](${track.webpageUrl})**`
    : `**${title}**`;

  const pills = [];
  if (artist) pills.push(`\`${artist}\``);
  pills.push(`\`${duration}\``);
  if (queueState.loopMode && queueState.loopMode !== 'off') {
    pills.push(`\`Loop: ${formatLoopMode(queueState.loopMode)}\``);
  }
  const filters = queueState.filters;
  if (filters) {
    if (filters.bassboost && filters.bassboost !== 'off') {
      pills.push(`\`Bass: ${filters.bassboost.toUpperCase()}\``);
    }
    if (filters.nightcore) {
      pills.push('`Nightcore`');
    }
    if (Number.isFinite(filters.speed) && Math.abs(filters.speed - 1.0) >= 0.01) {
      pills.push(`\`Speed: ${filters.speed}x\``);
    }
  }
  if (queueState.upcomingCount > 0) {
    pills.push(`\`+${queueState.upcomingCount} in queue\``);
  }

  const embed = new EmbedBuilder()
    .setColor(EmbedColors.PLAYING)
    .setAuthor({ name: `Now Playing  •  ${source}` })
    .setTitle('Now Playing')
    .setDescription(`${titleLine}\n${pills.join('  •  ')}`)
    .setFooter({ text: `Requested by ${requester}` });

  applySafeThumbnail(embed, track?.thumbnail);
  return embed;
}

/**
 * Compact, icon-free Added to Queue card.
 */
export function buildTrackQueuedEmbed(track, position, _queueState = {}) {
  const title = sanitizeDisplayText(track?.title || 'Untitled Track', 140);
  const artist = track?.artist ? sanitizeDisplayText(track.artist, 60) : null;
  const requester = sanitizeDisplayText(track?.requestedBy || 'Unknown', 50);
  const duration = formatDuration(track?.duration, track?.isLive);
  const source = formatSourceLabel(track?.source);

  const titleLine = track?.webpageUrl
    ? `**[${title}](${track.webpageUrl})**`
    : `**${title}**`;

  const pills = [];
  if (artist) pills.push(`\`${artist}\``);
  pills.push(`\`${duration}\``);
  pills.push(`\`#${position} in queue\``);

  const embed = new EmbedBuilder()
    .setColor(EmbedColors.PRIMARY)
    .setAuthor({ name: `Added to Queue  •  ${source}` })
    .setTitle('Added to Queue')
    .setDescription(`${titleLine}\n${pills.join('  •  ')}`)
    .setFooter({ text: `Requested by ${requester}` });

  applySafeThumbnail(embed, track?.thumbnail);
  return embed;
}

/**
 * Compact, icon-free Playlist Added card.
 */
export function buildPlaylistAddedEmbed(playlistInfo, queueResult, queueState = {}) {
  const title = sanitizeDisplayText(playlistInfo?.title || 'Playlist', 140);
  const source = formatSourceLabel(playlistInfo?.source);
  const requester = sanitizeDisplayText(playlistInfo?.requestedBy || 'Unknown', 50);
  const addedCount = playlistInfo?.totalQueuedCount ?? queueResult.addedCount ?? 0;
  const skippedCount = (playlistInfo?.skippedTracks ?? 0) + (queueResult.droppedByQueueLimit ?? 0);

  const titleLine = playlistInfo?.webpageUrl
    ? `**[${title}](${playlistInfo.webpageUrl})**`
    : `**${title}**`;

  const summaryParts = [`Queued **${addedCount}** tracks`];
  if (skippedCount > 0) {
    summaryParts.push(`*(${skippedCount} skipped)*`);
  }
  if (playlistInfo?.backgroundLoadingCount > 0) {
    summaryParts.push(`• \`loading ${playlistInfo.backgroundLoadingCount} in background\``);
  } else if (queueState.upcomingCount > 0) {
    summaryParts.push(`• \`${queueState.upcomingCount} waiting\``);
  }

  const embed = new EmbedBuilder()
    .setColor(EmbedColors.SUCCESS)
    .setAuthor({ name: `Playlist Added  •  ${source}` })
    .setTitle('Playlist Added')
    .setDescription(`${titleLine}\n${summaryParts.join(' ')}`)
    .setFooter({ text: `Requested by ${requester}` });

  applySafeThumbnail(embed, playlistInfo?.thumbnail);
  return embed;
}

export function buildPausedEmbed(track) {
  const title = sanitizeDisplayText(track?.title || 'Current Track', 140);
  return new EmbedBuilder()
    .setColor(EmbedColors.PAUSED)
    .setDescription(`**Paused** — ${title}`);
}

export function buildResumedEmbed(track) {
  const title = sanitizeDisplayText(track?.title || 'Current Track', 140);
  return new EmbedBuilder()
    .setColor(EmbedColors.PLAYING)
    .setDescription(`**Resumed** — ${title}`);
}

export function buildSkippedEmbed(skippedTrack, nextTrack) {
  const skippedTitle = sanitizeDisplayText(skippedTrack?.title || 'Track', 120);
  const nextLine = nextTrack
    ? `\nNext: **${sanitizeDisplayText(nextTrack.title, 120)}** \`[${formatDuration(nextTrack.duration, nextTrack.isLive)}]\``
    : '\nQueue is now empty.';

  return new EmbedBuilder()
    .setColor(EmbedColors.INFO)
    .setDescription(`**Skipped** — ${skippedTitle}${nextLine}`);
}

export function buildStoppedEmbed(clearedCount = 0) {
  const suffix = clearedCount > 0 ? ` and cleared **${clearedCount}** queued track(s)` : '';
  return new EmbedBuilder()
    .setColor(EmbedColors.WARNING)
    .setDescription(`**Stopped playback**${suffix}.`);
}

export function buildQueueEmbed(snapshot, page = 1, pageSize = 10) {
  const current = snapshot.currentTrack;
  const tracks = Array.isArray(snapshot.tracks) ? snapshot.tracks : [];
  const totalPages = Math.max(1, Math.ceil(tracks.length / pageSize));
  const safePage = Math.min(Math.max(1, Number.parseInt(String(page), 10) || 1), totalPages);
  const startIdx = (safePage - 1) * pageSize;
  const slice = tracks.slice(startIdx, startIdx + pageSize);

  const nowPlayingBlock = current
    ? `**Now Playing**\n**[${sanitizeDisplayText(current.title, 110)}](${current.webpageUrl || 'https://discord.com'})** \`${formatDuration(current.duration, current.isLive)}\``
    : '**Nothing is currently playing.**';

  let upcomingBlock = '*No upcoming tracks in queue.*';
  if (slice.length > 0) {
    upcomingBlock = slice
      .map((item, idx) => {
        const pos = startIdx + idx + 1;
        const tTitle = sanitizeDisplayText(item.title, 85);
        const dur = formatDuration(item.duration, item.isLive);
        return `\`${pos}.\` ${tTitle} \`${dur}\``;
      })
      .join('\n');
  }

  const description = `${nowPlayingBlock}\n\n**Up Next (${tracks.length})**\n${upcomingBlock}`.slice(0, 4000);
  const footerPills = [`Page ${safePage}/${totalPages}`];
  if (snapshot.loopMode && snapshot.loopMode !== 'off') {
    footerPills.push(`Loop: ${formatLoopMode(snapshot.loopMode)}`);
  }
  footerPills.push(`Volume: ${snapshot.volume ?? 100}%`);

  return new EmbedBuilder()
    .setColor(EmbedColors.PRIMARY)
    .setAuthor({ name: 'Server Queue' })
    .setDescription(description)
    .setFooter({ text: footerPills.join('  •  ') });
}

export function buildVolumeEmbed(volume, maxVolume = 200) {
  return new EmbedBuilder()
    .setColor(EmbedColors.INFO)
    .setDescription(`**Volume:** \`${volume}%\` *(Max: ${maxVolume}%)*`);
}

export function buildLoopEmbed(loopMode) {
  return new EmbedBuilder()
    .setColor(EmbedColors.INFO)
    .setDescription(`**Loop Mode:** \`${formatLoopMode(loopMode)}\``);
}

export function buildBassboostEmbed(level) {
  return new EmbedBuilder()
    .setColor(level === 'off' ? EmbedColors.INFO : EmbedColors.SUCCESS)
    .setDescription(`**Bassboost:** \`${formatBassboostLabel(level)}\``);
}

export function buildNightcoreEmbed(enabled) {
  return new EmbedBuilder()
    .setColor(enabled ? EmbedColors.SUCCESS : EmbedColors.INFO)
    .setDescription(`**Nightcore:** \`${enabled ? 'On (1.25x Pitch + Tempo)' : 'Off'}\``);
}

export function buildSpeedEmbed(speed) {
  return new EmbedBuilder()
    .setColor(Math.abs(speed - 1.0) < 0.01 ? EmbedColors.INFO : EmbedColors.SUCCESS)
    .setDescription(`**Playback Speed:** \`${speed}x\``);
}

export function buildErrorEmbed(title, message) {
  return new EmbedBuilder()
    .setColor(EmbedColors.ERROR)
    .setDescription(`**${sanitizeDisplayText(title || 'Notice', 80)}** — ${sanitizeDisplayText(message || 'An unexpected error occurred.', 600)}`);
}

export function buildNoPermissionEmbed(detail = 'You do not have permission to perform this action.') {
  return buildErrorEmbed('Permission Denied', detail);
}

export function buildInvalidInputEmbed(detail = 'Please provide a valid search query or supported media URL.') {
  return buildErrorEmbed('Invalid Input', detail);
}

export function buildUnsupportedSourceEmbed(detail = 'The requested URL or media source is not supported.') {
  return buildErrorEmbed('Unsupported Source', detail);
}

export function buildExtractionFailureEmbed(trackTitle, detail = 'Could not extract playable audio for this track.') {
  const safeTitle = trackTitle ? sanitizeDisplayText(trackTitle, 110) : 'requested track';
  return buildErrorEmbed('Playback Skipped', `Could not play **${safeTitle}**: ${sanitizeDisplayText(detail, 300)}`);
}

export function buildConnectionRecoveryFailureEmbed(
  detail = 'Voice connection was interrupted and could not be recovered.'
) {
  return buildErrorEmbed('Voice Disconnected', detail);
}

export function buildFileUploadPromptEmbed(timeoutSeconds = 60) {
  return new EmbedBuilder()
    .setColor(EmbedColors.PRIMARY)
    .setAuthor({ name: 'Upload Audio File' })
    .setDescription(
      `Please upload an audio or video file (.mp3, .m4a, .wav, .flac, .ogg, .mp4) from your device in this channel within **${timeoutSeconds} seconds**.\nType **cancel** to abort.`
    );
}
