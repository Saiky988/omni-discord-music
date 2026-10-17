import { SlashCommandBuilder } from '../utils/discordSdk.js';
import { buildLoopEmbed, buildInvalidInputEmbed } from '../utils/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('loop')
  .setDescription('Set the repeat/loop mode for the queue')
  .setDMPermission(false)
  .addStringOption((option) =>
    option
      .setName('mode')
      .setDescription('Loop mode: off, track, or queue')
      .setRequired(true)
      .addChoices(
        { name: 'Off', value: 'off' },
        { name: 'Current Track', value: 'track' },
        { name: 'Entire Queue', value: 'queue' }
      )
  );

export const aliases = ['repeat'];
export const requiresVoice = true;
export const requiresSameVoice = true;
export const defer = false;

export async function execute(context) {
  const { guildId, args, options, queueManager } = context;

  const mode = options?.getString
    ? options.getString('mode', true)
    : (Array.isArray(args) && args[0] ? String(args[0]).trim().toLowerCase() : '');

  if (!mode) {
    return {
      isError: true,
      embeds: [buildInvalidInputEmbed('Usage: `/loop <off|track|queue>` or `!loop <off|track|queue>`')]
    };
  }

  const result = queueManager.setLoopMode(guildId, mode);
  return {
    embeds: [buildLoopEmbed(result.loopMode)]
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
