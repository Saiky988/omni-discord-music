import { SlashCommandBuilder } from '../utils/discordSdk.js';
import { buildNowPlayingEmbed, buildErrorEmbed } from '../utils/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('nowplaying')
  .setDescription('Display details about the currently playing track')
  .setDMPermission(false);

export const aliases = ['np', 'current'];
export const requiresVoice = false;
export const requiresSameVoice = false;
export const defer = false;

export async function execute(context) {
  const { guildId, queueManager } = context;
  const snapshot = queueManager.getSnapshot(guildId);

  if (!snapshot.currentTrack) {
    return {
      isError: true,
      embeds: [buildErrorEmbed('Nothing Playing', 'There is no track currently playing in this server.')]
    };
  }

  return {
    embeds: [buildNowPlayingEmbed(snapshot.currentTrack, snapshot)]
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
