import { SlashCommandBuilder } from '../utils/discordSdk.js';
import { buildSpeedEmbed } from '../utils/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('speed')
  .setDescription('Adjust playback speed multiplier (0.5x to 2.0x, default 1.0x)')
  .setDMPermission(false)
  .addNumberOption((option) =>
    option
      .setName('rate')
      .setDescription('Playback speed multiplier between 0.5 and 2.0 (1.0 = normal)')
      .setRequired(true)
      .setMinValue(0.5)
      .setMaxValue(2.0)
  );

export const aliases = ['tempo', 'rate'];
export const requiresVoice = true;
export const requiresSameVoice = true;
export const defer = false;

export async function execute(context) {
  const { guildId, args, options, queueManager } = context;

  let rawSpeed = null;
  if (options?.getNumber) {
    rawSpeed = options.getNumber('rate', true);
  } else if (options?.getString) {
    rawSpeed = options.getString('rate', false);
  } else if (Array.isArray(args) && args.length > 0) {
    rawSpeed = String(args[0]).trim();
  } else {
    const snap = queueManager.getSnapshot(guildId);
    return {
      embeds: [buildSpeedEmbed(snap.filters?.speed ?? 1.0)]
    };
  }

  const result = await queueManager.setSpeed(guildId, rawSpeed);
  return {
    embeds: [buildSpeedEmbed(result.speed)]
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
