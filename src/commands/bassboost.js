import { SlashCommandBuilder } from '../utils/discordSdk.js';
import { buildBassboostEmbed } from '../utils/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('bassboost')
  .setDescription('Set or toggle real-time bassboost filter (off, low, medium, high, extreme)')
  .setDMPermission(false)
  .addStringOption((option) =>
    option
      .setName('level')
      .setDescription('Bassboost intensity preset (leave empty to toggle)')
      .setRequired(false)
      .addChoices(
        { name: 'Off (Normal)', value: 'off' },
        { name: 'Low (+5dB)', value: 'low' },
        { name: 'Medium (+9dB)', value: 'medium' },
        { name: 'High (+13dB)', value: 'high' },
        { name: 'Extreme (+17dB)', value: 'extreme' }
      )
  );

export const aliases = ['bb', 'bass'];
export const requiresVoice = true;
export const requiresSameVoice = true;
export const defer = false;

export async function execute(context) {
  const { guildId, args, options, queueManager } = context;

  let rawLevel = null;
  if (options?.getString) {
    rawLevel = options.getString('level', false);
  } else if (Array.isArray(args) && args.length > 0) {
    rawLevel = String(args[0]).trim();
  }

  const result = await queueManager.setBassboost(guildId, rawLevel);
  return {
    embeds: [buildBassboostEmbed(result.bassboost)]
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
