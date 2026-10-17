import { SlashCommandBuilder } from '../utils/discordSdk.js';
import config from '../config.js';
import { buildVolumeEmbed, buildInvalidInputEmbed } from '../utils/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('volume')
  .setDescription('Adjust or view the playback volume for this server')
  .setDMPermission(false)
  .addIntegerOption((option) =>
    option
      .setName('level')
      .setDescription(`Volume percentage (0 to ${config.MAX_VOLUME || 200})`)
      .setRequired(true)
      .setMinValue(0)
      .setMaxValue(config.MAX_VOLUME || 200)
  );

export const aliases = ['vol', 'v'];
export const requiresVoice = true;
export const requiresSameVoice = true;
export const defer = false;

export async function execute(context) {
  const { guildId, args, options, queueManager, config: runtimeConfig } = context;
  const maxVolume = runtimeConfig?.MAX_VOLUME ?? config.MAX_VOLUME ?? 200;

  let level;
  if (options?.getInteger) {
    level = options.getInteger('level', true);
  } else if (Array.isArray(args) && args[0] !== undefined) {
    if (!/^-?\d+$/.test(String(args[0]).trim())) {
      return {
        isError: true,
        embeds: [buildInvalidInputEmbed(`Please provide a whole number volume between 0 and ${maxVolume}.`)]
      };
    }
    level = Number.parseInt(String(args[0]).trim(), 10);
  } else {
    const snapshot = queueManager.getSnapshot(guildId);
    return {
      embeds: [buildVolumeEmbed(snapshot.volume, maxVolume)]
    };
  }

  const result = queueManager.setVolume(guildId, level);
  return {
    embeds: [buildVolumeEmbed(result.volume, maxVolume)]
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
