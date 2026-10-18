import { SlashCommandBuilder } from '../utils/discordSdk.js';
import {
  buildNowPlayingEmbed,
  buildTrackQueuedEmbed,
  buildPlaylistAddedEmbed,
  buildInvalidInputEmbed,
  buildErrorEmbed,
  buildFileUploadPromptEmbed,
  buildPlayerControlRow
} from '../utils/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('play')
  .setDescription('Play a song from a search query, URL, or an uploaded audio/video file from your device')
  .setDMPermission(false)
  .addStringOption((option) =>
    option
      .setName('query')
      .setDescription('Song title or URL (YouTube, Spotify, Apple Music, SoundCloud, TikTok...)')
      .setRequired(false)
      .setMinLength(2)
      .setMaxLength(1000)
  )
  .addAttachmentOption((option) =>
    option
      .setName('file')
      .setDescription('Upload an audio/video file directly from your device (.mp3, .m4a, .wav, .flac, .ogg, .mp4...)')
      .setRequired(false)
  );

export const aliases = ['p'];
export const requiresVoice = true;
export const requiresSameVoice = false;
export const defer = true;

function extractFirstAttachment(attachments) {
  if (!attachments) return null;
  if (typeof attachments.first === 'function') {
    return attachments.first() || null;
  }
  if (attachments instanceof Map) {
    return attachments.values().next().value || null;
  }
  if (Array.isArray(attachments)) {
    return attachments[0] || null;
  }
  return null;
}

/**
 * Wait up to timeoutMs for the requesting user to upload an attachment or type "cancel" in the channel.
 */
async function waitForUserFileMessage({ textChannel, message, userId, timeoutMs = 60000 }) {
  if (!textChannel) {
    return { status: 'timeout', attachment: null, followUpMessage: null };
  }

  // 1. Prefer Discord.js TextChannel.awaitMessages when available
  if (typeof textChannel.awaitMessages === 'function') {
    try {
      const collected = await textChannel.awaitMessages({
        filter: (m) => {
          if (!m || m.author?.bot || (userId && m.author?.id !== userId)) {
            return false;
          }
          const txt = String(m.content || '').trim().toLowerCase();
          if (txt === 'cancel') {
            return true;
          }
          return Boolean(extractFirstAttachment(m.attachments));
        },
        max: 1,
        time: timeoutMs,
        errors: ['time']
      });

      const firstMsg = typeof collected?.first === 'function'
        ? collected.first()
        : (collected instanceof Map ? collected.values().next().value : null);

      if (!firstMsg) {
        return { status: 'timeout', attachment: null, followUpMessage: null };
      }

      const txt = String(firstMsg.content || '').trim().toLowerCase();
      if (txt === 'cancel') {
        return { status: 'cancelled', attachment: null, followUpMessage: firstMsg };
      }

      return {
        status: 'received',
        attachment: extractFirstAttachment(firstMsg.attachments),
        followUpMessage: firstMsg
      };
    } catch {
      return { status: 'timeout', attachment: null, followUpMessage: null };
    }
  }

  // 2. Fallback event listener on client or textChannel
  const emitter = message?.client || textChannel?.client || textChannel;
  if (!emitter || typeof emitter.on !== 'function') {
    return { status: 'timeout', attachment: null, followUpMessage: null };
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve({ status: 'timeout', attachment: null, followUpMessage: null });
    }, timeoutMs);
    timer.unref?.();

    const onMessage = (m) => {
      if (!m || m.author?.bot) return;
      if (textChannel.id && m.channelId && m.channelId !== textChannel.id) return;
      if (userId && m.author?.id !== userId) return;

      const txt = String(m.content || '').trim().toLowerCase();
      if (txt === 'cancel') {
        cleanup();
        resolve({ status: 'cancelled', attachment: null, followUpMessage: m });
        return;
      }

      const att = extractFirstAttachment(m.attachments);
      if (att) {
        cleanup();
        resolve({ status: 'received', attachment: att, followUpMessage: m });
      }
    };

    function cleanup() {
      clearTimeout(timer);
      emitter.off?.('messageCreate', onMessage);
      emitter.removeListener?.('messageCreate', onMessage);
    }

    emitter.on('messageCreate', onMessage);
  });
}

async function resolveAttachmentToTrack(resolver, attachment, requesterTag) {
  if (typeof resolver.resolveAttachment === 'function') {
    return resolver.resolveAttachment(attachment, { requestedBy: requesterTag });
  }
  const url = attachment?.url || attachment?.proxyURL;
  return resolver.resolve(url, { requestedBy: requesterTag, lazy: true });
}

export async function execute(context) {
  const {
    guildId,
    voiceChannelId,
    textChannelId,
    textChannel,
    adapterCreator,
    requesterTag,
    userId,
    message,
    args,
    options,
    resolver,
    queueManager,
    config: runtimeConfig,
    logger
  } = context;

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

  // 1. Check if a file attachment was provided directly via /play file:<attachment> or attached to !play / n!play
  const slashAttachment = options?.getAttachment ? options.getAttachment('file', false) : null;
  const messageAttachment = extractFirstAttachment(message?.attachments);
  const directAttachment = slashAttachment || messageAttachment;

  const rawQuery = options?.getString
    ? (options.getString('query', false) || '').trim()
    : (Array.isArray(args) ? args.join(' ').trim() : '');

  let resolved = null;

  if (directAttachment) {
    resolved = await resolveAttachmentToTrack(resolver, directAttachment, requesterTag);
  } else if (rawQuery.toLowerCase() === 'file') {
    // Interactive "n!play file" flow: send prompt and wait up to 60s for user to upload a file
    const waitSeconds = runtimeConfig?.FILE_UPLOAD_TIMEOUT_SECONDS || 60;
    const promptEmbed = buildFileUploadPromptEmbed(waitSeconds);

    let promptMessage = null;
    if (message && typeof message.reply === 'function') {
      promptMessage = await message.reply({ embeds: [promptEmbed] });
    } else if (textChannel && typeof textChannel.send === 'function') {
      promptMessage = await textChannel.send({ embeds: [promptEmbed] });
    }

    const waitResult = await waitForUserFileMessage({
      textChannel: textChannel || message?.channel,
      message,
      userId: userId || message?.author?.id,
      timeoutMs: waitSeconds * 1000
    });

    if (waitResult.status === 'cancelled') {
      const cancelEmbed = buildErrorEmbed('Upload Cancelled', 'Cancelled the audio file upload request.');
      if (promptMessage && typeof promptMessage.edit === 'function') {
        await promptMessage.edit({ embeds: [cancelEmbed] }).catch(() => {});
        return { alreadyReplied: true, embeds: [cancelEmbed] };
      }
      return { embeds: [cancelEmbed] };
    }

    if (waitResult.status !== 'received' || !waitResult.attachment) {
      const timeoutEmbed = buildErrorEmbed(
        'Upload Timed Out',
        `No audio file was uploaded within ${waitSeconds} seconds. Run **n!play file** again when you are ready.`
      );
      if (promptMessage && typeof promptMessage.edit === 'function') {
        await promptMessage.edit({ embeds: [timeoutEmbed] }).catch(() => {});
        return { alreadyReplied: true, embeds: [timeoutEmbed] };
      }
      return { embeds: [timeoutEmbed] };
    }

    resolved = await resolveAttachmentToTrack(resolver, waitResult.attachment, requesterTag);
    const track = resolved.track || resolved;
    const queueResult = await queueManager.enqueue(guildId, track, {
      voiceChannelId,
      textChannelId,
      textChannel,
      adapterCreator,
      asyncPlayback: true
    });

    const finalPayload = queueResult.startedPlayback
      ? {
          embeds: [buildNowPlayingEmbed(track, queueResult.snapshot)],
          components: [buildPlayerControlRow(queueResult.snapshot)]
        }
      : {
          embeds: [buildTrackQueuedEmbed(track, queueResult.queuePosition, queueResult.snapshot)]
        };

    if (waitResult.followUpMessage && typeof waitResult.followUpMessage.reply === 'function') {
      await waitResult.followUpMessage.reply(finalPayload).catch(() => {});
      return { alreadyReplied: true, ...finalPayload };
    }
    if (promptMessage && typeof promptMessage.edit === 'function') {
      await promptMessage.edit(finalPayload).catch(() => {});
      return { alreadyReplied: true, ...finalPayload };
    }
    return finalPayload;
  } else {
    if (!rawQuery) {
      return {
        isError: true,
        embeds: [
          buildInvalidInputEmbed(
            'Please provide a song title, a music URL, attach a file via **/play file:**, or type **n!play file** to upload from your device.'
          )
        ]
      };
    }

    resolved = await resolver.resolve(rawQuery, {
      requestedBy: requesterTag,
      eagerFirstTrackOnly: true,
      lazy: true
    });
  }

  if (resolved.kind === 'playlist') {
    const queueResult = await queueManager.enqueue(guildId, resolved.tracks, {
      voiceChannelId,
      textChannelId,
      textChannel,
      adapterCreator,
      asyncPlayback: true
    });

    if (typeof resolved.backgroundTasks === 'function') {
      void resolved
        .backgroundTasks(async (resolvedTrack) => {
          const currentQueue = queueManager.getQueue(guildId);
          if (!currentQueue || currentQueue.state === 'destroyed') {
            return false;
          }
          await queueManager.enqueue(guildId, resolvedTrack);
          return true;
        })
        .catch((err) => {
          logger?.warn?.('Background playlist track resolution error', {
            guildId,
            error: err.message
          });
        });
    }

    return {
      embeds: [buildPlaylistAddedEmbed(resolved, queueResult, queueResult.snapshot)],
      components: queueResult.startedPlayback
        ? [buildPlayerControlRow(queueResult.snapshot)]
        : []
    };
  }

  const track = resolved.track || resolved;
  const queueResult = await queueManager.enqueue(guildId, track, {
    voiceChannelId,
    textChannelId,
    textChannel,
    adapterCreator,
    asyncPlayback: true
  });

  if (queueResult.startedPlayback) {
    return {
      embeds: [buildNowPlayingEmbed(track, queueResult.snapshot)],
      components: [buildPlayerControlRow(queueResult.snapshot)]
    };
  }

  return {
    embeds: [buildTrackQueuedEmbed(track, queueResult.queuePosition, queueResult.snapshot)]
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