import { SlashCommandBuilder } from '../utils/discordSdk.js';
import { buildQueueEmbed } from '../utils/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('queue')
  .setDescription('View the current track, upcoming queue, and playback state')
  .setDMPermission(false)
  .addIntegerOption((option) =>
    option
      .setName('page')
      .setDescription('Queue page number (10 tracks per page)')
      .setRequired(false)
      .setMinValue(1)
      .setMaxValue(100)
  );

export const aliases = ['q'];
export const requiresVoice = false;
export const requiresSameVoice = false;
export const defer = false;

export async function execute(context) {
  const { guildId, args, options, queueManager } = context;

  let page = 1;
  if (options?.getInteger) {
    page = options.getInteger('page', false) || 1;
  } else if (Array.isArray(args) && args[0]) {
    const parsed = Number.parseInt(args[0], 10);
    if (Number.isInteger(parsed) && parsed >= 1) {
      page = parsed;
    }
  }

  const snapshot = queueManager.getSnapshot(guildId);
  return {
    embeds: [buildQueueEmbed(snapshot, page, 10)]
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
