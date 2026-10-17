import { SlashCommandBuilder } from '../utils/discordSdk.js';
import { buildResumedEmbed } from '../utils/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('resume')
  .setDescription('Resume the currently paused track')
  .setDMPermission(false);

export const aliases = ['unpause'];
export const requiresVoice = true;
export const requiresSameVoice = true;
export const defer = false;

export async function execute(context) {
  const { guildId, queueManager } = context;
  const result = queueManager.resume(guildId);

  return {
    embeds: [buildResumedEmbed(result.track, result.snapshot)]
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
