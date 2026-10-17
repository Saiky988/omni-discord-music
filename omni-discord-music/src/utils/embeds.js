import { EmbedBuilder } from './discordSdk.js';

/**
 * Consistent Discord Embed builders and safe text formatting helpers.
 * Neutralizes user-controlled markdown/mentions and enforces Discord embed size limits.
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
  spotify: 'Spotify (Resolved)',
  apple_music: 'Apple Music (Resolved)',
  soundcloud: 'SoundCloud',
  tiktok: 'TikTok',
  douyin: 'Douyin',
  facebook: 'Facebook',
  instagram: 'Instagram',
  direct_media: 'Direct Media'
});

const LOOP_LABELS = Object.freeze({
  off: 'Off',
  track: 'Track',
  queue: 'Queue'
});

/**
 * Escape user-controlled text so it cannot trigger @everyone/@here mentions,
 * misleading masked links, or runaway formatting blocks.
 *
 * @param {unknown} text
 * @param {number} [maxLength=256]
 * @returns {string}
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
    .replace(/([*_~`|\\[\]()])/g, '\\$1')
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
 *
 * @param {number | null | undefined} seconds
 * @param {boolean} [isLive=false]
 * @returns {string}
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

export function formatSourceLabel(source, isFallback = false) {
  const base = SOURCE_LABELS[source] || sanitizeDisplayText(source || 'Unknown', 40);
  if (isFallback && !base.includes('(Resolved)')) {
    return `${base} (Fallback)`;
  }
  return base;
}

export function formatLoopMode(loopMode) {
  return LOOP_LABELS[loopMode] || 'Off';
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

function applySafeUrl(embed, url) {
  if (!url || typeof url !== 'string') {
    return;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      embed.setURL(parsed.toString());
    }
  } catch {
    // Ignore malformed URLs
  }
}

export function buildNowPlayingEmbed(track, queueState = {}) {
  const title = sanitizeDisplayText(track?.title || 'Untitled Track', 220);
  const artist = track?.artist ? sanitizeDisplayText(track.artist, 120) : 'Unknown Artist';
  const requester = sanitizeDisplayText(track?.requestedBy || 'Unknown', 80);
  const duration = formatDuration(track?.duration, track?.isLive);
  const source = formatSourceLabel(track?.source, track?.isFallback);
  const loopMode = formatLoopMode(queueState.loopMode);
  const volume = queueState.volume !== undefined ? `${queueState.volume}%` : '80%';

  const embed = new EmbedBuilder()
    .setColor(EmbedColors.PLAYING)
    .setTitle('Now Playing')
    .setDescription(
      track?.webpageUrl
        ? `**[${title}](${track.webpageUrl})**`
        : `**${title}**`
    )
    .addFields(
      { name: 'Artist / Channel', value: artist, inline: true },
      { name: 'Duration', value: duration, inline: true },
      { name: 'Source', value: source, inline: true },
      { name: 'Requested By', value: requester, inline: true },
      { name: 'Loop Mode', value: loopMode, inline: true },
      { name: 'Volume', value: volume, inline: true }
    )
    .setTimestamp();

  applySafeUrl(embed, track?.webpageUrl);
  applySafeThumbnail(embed, track?.thumbnail);
  return embed;
}

export function buildTrackQueuedEmbed(track, position, queueState = {}) {
  const title = sanitizeDisplayText(track?.title || 'Untitled Track', 220);
  const artist = track?.artist ? sanitizeDisplayText(track.artist, 120) : 'Unknown Artist';
  const requester = sanitizeDisplayText(track?.requestedBy || 'Unknown', 80);
  const duration = formatDuration(track?.duration, track?.isLive);
  const source = formatSourceLabel(track?.source, track?.isFallback);
  const loopMode = formatLoopMode(queueState.loopMode);

  const embed = new EmbedBuilder()
    .setColor(EmbedColors.PRIMARY)
    .setTitle('Added to Queue')
    .setDescription(
      track?.webpageUrl
        ? `**[${title}](${track.webpageUrl})**`
        : `**${title}**`
    )
    .addFields(
      { name: 'Artist / Channel', value: artist, inline: true },
      { name: 'Duration', value: duration, inline: true },
      { name: 'Source', value: source, inline: true },
      { name: 'Queue Position', value: `#${position}`, inline: true },
      { name: 'Requested By', value: requester, inline: true },
      { name: 'Loop Mode', value: loopMode, inline: true }
    )
    .setTimestamp();

  applySafeUrl(embed, track?.webpageUrl);
  applySafeThumbnail(embed, track?.thumbnail);
  return embed;
}

export function buildPlaylistAddedEmbed(playlistInfo, queueResult, queueState = {}) {
  const title = sanitizeDisplayText(playlistInfo?.title || 'Playlist', 200);
  const source = formatSourceLabel(playlistInfo?.source);
  const requester = sanitizeDisplayText(playlistInfo?.requestedBy || 'Unknown', 80);
  const addedCount = queueResult.addedCount ?? 0;
  const skippedCount = (playlistInfo?.skippedTracks ?? 0) + (queueResult.droppedByQueueLimit ?? 0);
  const startedNow = Boolean(queueResult.startedPlayback);

  const statusText = startedNow
    ? 'Started playing first track and queued the remaining tracks.'
    : 'Queued all accepted tracks behind current playback.';

  const embed = new EmbedBuilder()
    .setColor(EmbedColors.SUCCESS)
    .setTitle('Playlist Added')
    .setDescription(`**${title}**\n${statusText}`)
    .addFields(
      { name: 'Tracks Queued', value: String(addedCount), inline: true },
      { name: 'Tracks Skipped', value: String(skippedCount), inline: true },
      { name: 'Source', value: source, inline: true },
      { name: 'Requested By', value: requester, inline: true },
      { name: 'Loop Mode', value: formatLoopMode(queueState.loopMode), inline: true },
      { name: 'Total in Queue', value: String(queueState.upcomingCount ?? addedCount), inline: true }
    )
    .setTimestamp();

  applySafeUrl(embed, playlistInfo?.webpageUrl);
  applySafeThumbnail(embed, playlistInfo?.thumbnail);
  return embed;
}

export function buildPausedEmbed(track, queueState = {}) {
  const title = sanitizeDisplayText(track?.title || 'Current Track', 220);
  return new EmbedBuilder()
    .setColor(EmbedColors.PAUSED)
    .setTitle('Playback Paused')
    .setDescription(`Paused **${title}**.`)
    .addFields(
      { name: 'Loop Mode', value: formatLoopMode(queueState.loopMode), inline: true },
      { name: 'Upcoming Tracks', value: String(queueState.upcomingCount ?? 0), inline: true }
    )
    .setTimestamp();
}

export function buildResumedEmbed(track, queueState = {}) {
  const title = sanitizeDisplayText(track?.title || 'Current Track', 220);
  return new EmbedBuilder()
    .setColor(EmbedColors.PLAYING)
    .setTitle('Playback Resumed')
    .setDescription(`Resumed **${title}**.`)
    .addFields(
      { name: 'Loop Mode', value: formatLoopMode(queueState.loopMode), inline: true },
      { name: 'Upcoming Tracks', value: String(queueState.upcomingCount ?? 0), inline: true }
    )
    .setTimestamp();
}

export function buildSkippedEmbed(skippedTrack, nextTrack, queueState = {}) {
  const skippedTitle = sanitizeDisplayText(skippedTrack?.title || 'Track', 200);
  const nextDescription = nextTrack
    ? `Up next: **${sanitizeDisplayText(nextTrack.title, 180)}**`
    : 'The queue is now empty.';

  return new EmbedBuilder()
    .setColor(EmbedColors.INFO)
    .setTitle('Track Skipped')
    .setDescription(`Skipped **${skippedTitle}**.\n${nextDescription}`)
    .addFields(
      { name: 'Loop Mode', value: formatLoopMode(queueState.loopMode), inline: true },
      { name: 'Remaining in Queue', value: String(queueState.upcomingCount ?? 0), inline: true }
    )
    .setTimestamp();
}

export function buildStoppedEmbed(clearedCount = 0) {
  return new EmbedBuilder()
    .setColor(EmbedColors.WARNING)
    .setTitle('Playback Stopped')
    .setDescription(
      `Stopped playback, disabled loop mode, and cleared **${clearedCount}** queued track(s).`
    )
    .setTimestamp();
}

export function buildQueueEmbed(snapshot, page = 1, pageSize = 10) {
  const current = snapshot.currentTrack;
  const tracks = Array.isArray(snapshot.tracks) ? snapshot.tracks : [];
  const totalPages = Math.max(1, Math.ceil(tracks.length / pageSize));
  const safePage = Math.min(Math.max(1, Number.parseInt(String(page), 10) || 1), totalPages);
  const startIdx = (safePage - 1) * pageSize;
  const slice = tracks.slice(startIdx, startIdx + pageSize);

  const nowPlayingBlock = current
    ? `**Now Playing:** ${sanitizeDisplayText(current.title, 160)} \`[${formatDuration(current.duration, current.isLive)}]\` — *Requested by ${sanitizeDisplayText(current.requestedBy, 50)}*`
    : '**Now Playing:** Nothing is currently playing.';

  let upcomingBlock = 'No upcoming tracks in queue.';
  if (slice.length > 0) {
    upcomingBlock = slice
      .map((item, idx) => {
        const pos = startIdx + idx + 1;
        const tTitle = sanitizeDisplayText(item.title, 110);
        const dur = formatDuration(item.duration, item.isLive);
        const req = sanitizeDisplayText(item.requestedBy || 'Unknown', 40);
        return `\`${pos}.\` **${tTitle}** \`[${dur}]\` • ${req}`;
      })
      .join('\n');
  }

  const description = `${nowPlayingBlock}\n\n**Upcoming Tracks:**\n${upcomingBlock}`.slice(0, 4000);

  return new EmbedBuilder()
    .setColor(EmbedColors.PRIMARY)
    .setTitle('Server Music Queue')
    .setDescription(description)
    .addFields(
      { name: 'Status', value: sanitizeDisplayText(snapshot.state || 'idle', 32), inline: true },
      { name: 'Queued Tracks', value: String(tracks.length), inline: true },
      { name: 'Loop Mode', value: formatLoopMode(snapshot.loopMode), inline: true },
      { name: 'Volume', value: `${snapshot.volume ?? 80}%`, inline: true }
    )
    .setFooter({ text: `Page ${safePage} of ${totalPages}` })
    .setTimestamp();
}

export function buildVolumeEmbed(volume, maxVolume = 200) {
  return new EmbedBuilder()
    .setColor(EmbedColors.INFO)
    .setTitle('Volume Updated')
    .setDescription(`Playback volume set to **${volume}%** (Max: ${maxVolume}%).`)
    .setTimestamp();
}

export function buildLoopEmbed(loopMode) {
  return new EmbedBuilder()
    .setColor(EmbedColors.INFO)
    .setTitle('Loop Mode Updated')
    .setDescription(`Loop mode is now set to **${formatLoopMode(loopMode)}**.`)
    .setTimestamp();
}

export function buildErrorEmbed(title, message) {
  return new EmbedBuilder()
    .setColor(EmbedColors.ERROR)
    .setTitle(sanitizeDisplayText(title || 'Error', 120))
    .setDescription(sanitizeDisplayText(message || 'An unexpected error occurred.', 1500))
    .setTimestamp();
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
  const safeTitle = trackTitle ? sanitizeDisplayText(trackTitle, 140) : 'requested track';
  return buildErrorEmbed('Audio Extraction Failed', `Failed to play **${safeTitle}**: ${sanitizeDisplayText(detail, 500)}`);
}

export function buildConnectionRecoveryFailureEmbed(
  detail = 'Voice connection was interrupted and could not be recovered. The queue has been cleared.'
) {
  return buildErrorEmbed('Voice Connection Lost', detail);
}
