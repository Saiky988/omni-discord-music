import { SlashCommandBuilder } from '../utils/discordSdk.js';
import { buildNightcoreEmbed } from '../utils/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('nightcore')
  .setDescription('Toggle or set Nightcore audio effect (1.25x pitch and tempo)')
  .setDMPermission(false)
  .addStringOption((option) =>
    option
      .setName('mode')
      .setDescription('Enable or disable Nightcore (leave empty to toggle)')
      .setRequired(false)
      .addChoices(
        { name: 'On', value: 'on' },
        { name: 'Off', value: 'off' }
      )
  );

export const aliases = ['nc'];
export const requiresVoice = true;
export const requiresSameVoice = true;
export const defer = false;

export async function execute(context) {
  const { guildId, args, options, queueManager } = context;

  let mode = null;
  if (options?.getString) {
    mode = options.getString('mode', false);
  } else if (Array.isArray(args) && args.length > 0) {
    mode = String(args[0]).trim();
  }

  const result = await queueManager.setNightcore(guildId, mode);
  return {
    embeds: [buildNightcoreEmbed(result.nightcore)]
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