import { SlashCommandBuilder } from '../utils/discordSdk.js';
import { buildStoppedEmbed } from '../utils/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('stop')
  .setDescription('Stop playback, clear the queue, and reset loop mode')
  .setDMPermission(false);

export const aliases = ['leave', 'clear'];
export const requiresVoice = true;
export const requiresSameVoice = true;
export const defer = false;

export async function execute(context) {
  const { guildId, queueManager } = context;
  const result = await queueManager.stop(guildId);

  return {
    embeds: [buildStoppedEmbed(result.clearedCount)]
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
