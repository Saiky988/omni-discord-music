import { SlashCommandBuilder } from '../utils/discordSdk.js';
import {
  buildNowPlayingEmbed,
  buildTrackQueuedEmbed,
  buildPlaylistAddedEmbed,
  buildInvalidInputEmbed
} from '../utils/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('play')
  .setDescription('Play a track or playlist from a URL or search query')
  .setDMPermission(false)
  .addStringOption((option) =>
    option
      .setName('query')
      .setDescription('Media URL (YouTube, Spotify, Apple Music, SoundCloud, TikTok, etc.) or search query')
      .setRequired(true)
      .setMinLength(2)
      .setMaxLength(1000)
  );

export const aliases = ['p'];
export const requiresVoice = true;
export const requiresSameVoice = false;
export const defer = true;

/**
 * Shared execution handler for /play and !play.
 *
 * @param {object} context Normalized command execution context
 */
export async function execute(context) {
  const {
    guildId,
    voiceChannelId,
    textChannelId,
    textChannel,
    adapterCreator,
    requesterTag,
    args,
    options,
    resolver,
    queueManager
  } = context;

  const rawQuery = options?.getString
    ? options.getString('query', true)
    : (Array.isArray(args) ? args.join(' ').trim() : '');

  if (!rawQuery) {
    return {
      embeds: [buildInvalidInputEmbed('Usage: `/play <url or search query>` or `!play <url or search query>`')]
    };
  }

  // Validate voice channel match BEFORE resolving if the bot is already active in another channel
  const existingSnapshot = queueManager.getSnapshot(guildId);
  if (
    existingSnapshot.exists &&
    existingSnapshot.voiceChannelId &&
    existingSnapshot.voiceChannelId !== voiceChannelId &&
    (existingSnapshot.currentTrack || existingSnapshot.upcomingCount > 0)
  ) {
    return {
      isError: true,
      embeds: [
        buildInvalidInputEmbed('You must be in the same voice channel as the bot to queue or play tracks.')
      ]
    };
  }

  const resolved = await resolver.resolve(rawQuery, {
    requestedBy: requesterTag
  });

  if (resolved.kind === 'playlist') {
    const queueResult = await queueManager.enqueue(guildId, resolved.tracks, {
      voiceChannelId,
      textChannelId,
      textChannel,
      adapterCreator
    });

    return {
      embeds: [
        buildPlaylistAddedEmbed(resolved, queueResult, queueResult.snapshot)
      ]
    };
  }

  const track = resolved.track || resolved;
  const queueResult = await queueManager.enqueue(guildId, track, {
    voiceChannelId,
    textChannelId,
    textChannel,
    adapterCreator
  });

  if (queueResult.startedPlayback) {
    return {
      embeds: [
        buildNowPlayingEmbed(track, queueResult.snapshot)
      ]
    };
  }

  return {
    embeds: [
      buildTrackQueuedEmbed(track, queueResult.queuePosition, queueResult.snapshot)
    ]
  };
}

export default {
  data,
  aliases,
  requiresVoice,
  requiresSameVoice,
  defer,
  execute
};
