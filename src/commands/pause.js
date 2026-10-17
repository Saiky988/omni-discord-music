import { SlashCommandBuilder } from '../utils/discordSdk.js';
import { buildPausedEmbed } from '../utils/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('pause')
  .setDescription('Pause the currently playing track')
  .setDMPermission(false);

export const aliases = [];
export const requiresVoice = true;
export const requiresSameVoice = true;
export const defer = false;

export async function execute(context) {
  const { guildId, queueManager } = context;
  const result = queueManager.pause(guildId);

  return {
    embeds: [buildPausedEmbed(result.track, result.snapshot)]
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
