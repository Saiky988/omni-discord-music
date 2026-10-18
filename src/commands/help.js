import { SlashCommandBuilder, EmbedBuilder } from '../utils/discordSdk.js';
import config from '../config.js';
import { EmbedColors } from '../utils/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('View the complete guide for playback commands, audio filters, and file uploads')
  .setDMPermission(false);

export const aliases = ['h', 'commands'];
export const requiresVoice = false;
export const requiresSameVoice = false;
export const defer = false;

export async function execute(context) {
  const rawPrefix = context.config?.PREFIX || config.PREFIX || 'n!';
  const prefix = rawPrefix === '!' ? 'n!' : rawPrefix;

  const embed = new EmbedBuilder()
    .setColor(EmbedColors.PRIMARY)
    .setAuthor({ name: 'Nvirya Music  •  Command Guide' })
    .setTitle('Music Commands & Usage Guide')
    .setDescription(
      'Supports both Slash commands (**/play**) and Prefix commands (**' +
        prefix +
        'play**). You can also use the interactive control buttons directly below the active Now Playing card.'
    )
    .addFields(
      {
        name: '1. Music Playback & Device File Upload',
        value: [
          '• **/play query:** *song name or URL* — Play or queue a track or playlist.',
          '• **/play file:** *attachment* — Upload an audio or video file (.mp3, .m4a, .wav, .flac, .mp4) directly from your phone or PC.',
          '• **' + prefix + 'play** *song name or URL* (alias: **' + prefix + 'p**) — Quickly play music via text message.',
          '• **' + prefix + 'play file** — The bot will prompt you and wait 60 seconds for you to upload an audio/video file in the channel.'
        ].join('\n'),
        inline: false
      },
      {
        name: '2. Playback Controls',
        value: [
          '• **/pause**  |  **' + prefix + 'pause** — Pause the currently playing track.',
          '• **/resume**  |  **' + prefix + 'resume** — Resume a paused track.',
          '• **/skip**  |  **' + prefix + 'skip** (alias: **' + prefix + 's**) — Skip the current track and play the next one in queue.',
          '• **/stop**  |  **' + prefix + 'stop** — Stop playback and clear the entire queue.'
        ].join('\n'),
        inline: false
      },
      {
        name: '3. Queue & Track Status',
        value: [
          '• **/queue** *[page]*  |  **' + prefix + 'queue** (alias: **' + prefix + 'q**) — View the upcoming tracks in the server queue.',
          '• **/nowplaying**  |  **' + prefix + 'nowplaying** (alias: **' + prefix + 'np**) — Display the current track card with interactive buttons.'
        ].join('\n'),
        inline: false
      },
      {
        name: '4. Volume & Loop Mode',
        value: [
          '• **/volume** *0 - 200*  |  **' + prefix + 'vol** *level* — Adjust playback volume from 0% to 200% (default 100%).',
          '• **/loop** *off | track | queue*  |  **' + prefix + 'loop** — Disable loop (off), repeat current track (track), or repeat the entire queue (queue).'
        ].join('\n'),
        inline: false
      },
      {
        name: '5. Real-Time Audio Effects (Instant Mid-Track Switching)',
        value: [
          '• **/bassboost** *off | low | medium | high | extreme*  |  **' + prefix + 'bb** — Boost sub-bass across 4 presets (+5dB to +17dB), or type **' + prefix + 'bb** to quick-toggle.',
          '• **/nightcore** *on | off*  |  **' + prefix + 'nc** — Toggle the Nightcore audio effect (1.25x pitch and tempo).',
          '• **/speed** *0.5 - 2.0*  |  **' + prefix + 'speed** *rate* (alias: **' + prefix + 'tempo**) — Adjust playback speed from 0.5x (slowed) to 2.0x.'
        ].join('\n'),
        inline: false
      },
      {
        name: '6. Supported Platforms',
        value:
          'YouTube, YouTube Music, Spotify (Tracks/Albums/Playlists), Apple Music, SoundCloud, TikTok, Douyin, Facebook, Instagram, direct CDN links, and local audio/video files uploaded from your device.',
        inline: false
      }
    )
    .setFooter({ text: 'Type ' + prefix + 'help or /help anytime to view this command guide' });

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
