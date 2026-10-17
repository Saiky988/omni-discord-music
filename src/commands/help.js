import { SlashCommandBuilder, EmbedBuilder } from '../utils/discordSdk.js';
import config from '../config.js';
import { EmbedColors } from '../utils/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('List all available music commands and usage examples')
  .setDMPermission(false);

export const aliases = ['h', 'commands'];
export const requiresVoice = false;
export const requiresSameVoice = false;
export const defer = false;

export async function execute(context) {
  const prefix = context.config?.PREFIX || config.PREFIX || '!';

  const embed = new EmbedBuilder()
    .setColor(EmbedColors.PRIMARY)
    .setTitle('Omni Discord Music — Commands')
    .setDescription(
      `Supports both Discord slash commands (\`/play\`) and prefix commands (\`${prefix}play\`).`
    )
    .addFields(
      {
        name: '`/play <query>` or `' + prefix + 'play <query>`',
        value: 'Play or queue a track/playlist from YouTube, YouTube Music, Spotify, Apple Music, SoundCloud, TikTok, Douyin, Facebook, Instagram, or a direct audio link.',
        inline: false
      },
      {
        name: '`/pause` / `/resume`',
        value: `Pause or resume the active track (\`${prefix}pause\`, \`${prefix}resume\`).`,
        inline: true
      },
      {
        name: '`/skip` / `/stop`',
        value: `Skip the current track or stop and clear the queue (\`${prefix}skip\`, \`${prefix}stop\`).`,
        inline: true
      },
      {
        name: '`/queue [page]` / `/nowplaying`',
        value: `Inspect upcoming tracks or the active track (\`${prefix}queue\`, \`${prefix}np\`).`,
        inline: true
      },
      {
        name: '`/volume <0-200>` / `/loop <off|track|queue>`',
        value: `Adjust server volume or set loop mode (\`${prefix}volume 100\`, \`${prefix}loop track\`).`,
        inline: true
      }
    )
    .setTimestamp();

  return {
    embeds: [embed]
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
