import { SlashCommandBuilder } from '../utils/discordSdk.js';
import { buildSkippedEmbed } from '../utils/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('skip')
  .setDescription('Skip the currently playing track')
  .setDMPermission(false);

export const aliases = ['s', 'next'];
export const requiresVoice = true;
export const requiresSameVoice = true;
export const defer = false;

export async function execute(context) {
  const { guildId, queueManager } = context;
  const result = await queueManager.skip(guildId);

  return {
    embeds: [
      buildSkippedEmbed(result.skippedTrack, result.nextTrack, result.snapshot)
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
