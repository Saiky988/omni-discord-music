import {
  Collection,
  PermissionFlagsBits,
  MessageFlags
} from '../utils/discordSdk.js';
import config from '../config.js';
import { defaultResolver } from '../services/resolver.js';
import { defaultQueueManager } from '../services/queueManager.js';
import { logger as defaultLogger } from '../utils/logger.js';
import {
  ErrorCodes,
  InvalidInputError,
  UnsafeUrlError,
  UnsupportedSourceError,
  UnsupportedMediaError
} from '../utils/errors.js';
import {
  buildErrorEmbed,
  buildNoPermissionEmbed,
  buildInvalidInputEmbed,
  buildUnsupportedSourceEmbed
} from '../utils/embeds.js';

import playCommand from './play.js';
import pauseCommand from './pause.js';
import resumeCommand from './resume.js';
import skipCommand from './skip.js';
import stopCommand from './stop.js';
import queueCommand from './queue.js';
import volumeCommand from './volume.js';
import loopCommand from './loop.js';
import nowplayingCommand from './nowplaying.js';
import helpCommand from './help.js';

export const ALL_COMMAND_MODULES = Object.freeze([
  playCommand,
  pauseCommand,
  resumeCommand,
  skipCommand,
  stopCommand,
  queueCommand,
  volumeCommand,
  loopCommand,
  nowplayingCommand,
  helpCommand
]);

/**
 * Validate a command module's structure and serialize its SlashCommandBuilder definition.
 *
 * @param {object} mod
 */
export function validateCommandModule(mod) {
  if (!mod || typeof mod !== 'object') {
    throw new Error('Command module must be an object.');
  }
  if (!mod.data || typeof mod.data.toJSON !== 'function') {
    throw new Error('Command module is missing a valid SlashCommandBuilder "data" export.');
  }
  if (typeof mod.execute !== 'function') {
    throw new Error(`Command "${mod.data.name || 'unknown'}" is missing an "execute" function.`);
  }

  const serialized = mod.data.toJSON();
  if (!serialized.name || !serialized.description) {
    throw new Error('Serialized command definition is missing name or description.');
  }

  return serialized;
}

/**
 * Load and validate all command modules into a primary Map and an alias lookup Map.
 */
export function loadCommands(modules = ALL_COMMAND_MODULES) {
  const commands = new Collection();
  const aliases = new Collection();

  for (const mod of modules) {
    const serialized = validateCommandModule(mod);
    const name = serialized.name.toLowerCase();

    if (commands.has(name)) {
      throw new Error(`Duplicate command name detected: "${name}".`);
    }

    commands.set(name, mod);

    if (Array.isArray(mod.aliases)) {
      for (const alias of mod.aliases) {
        const cleanAlias = String(alias).trim().toLowerCase();
        if (cleanAlias && !commands.has(cleanAlias)) {
          aliases.set(cleanAlias, name);
        }
      }
    }
  }

  return { commands, aliases };
}

/**
 * Serialize all registered slash command definitions for deployment to the Discord API.
 */
export function getSerializedSlashCommands(modules = ALL_COMMAND_MODULES) {
  return modules.map((mod) => validateCommandModule(mod));
}

/**
 * Map an application error into a user-safe Discord Embed response without leaking stack traces.
 */
export function mapErrorToEmbedResponse(err) {
  if (err instanceof InvalidInputError || err?.code === ErrorCodes.INVALID_INPUT || err?.code === ErrorCodes.VOLUME_OUT_OF_RANGE) {
    return {
      isError: true,
      embeds: [buildInvalidInputEmbed(err.userMessage || err.message)]
    };
  }

  if (
    err instanceof UnsafeUrlError ||
    err instanceof UnsupportedSourceError ||
    err instanceof UnsupportedMediaError ||
    err?.code === ErrorCodes.UNSAFE_URL ||
    err?.code === ErrorCodes.UNSUPPORTED_SOURCE ||
    err?.code === ErrorCodes.UNSUPPORTED_MEDIA
  ) {
    return {
      isError: true,
      embeds: [buildUnsupportedSourceEmbed(err.userMessage || err.message)]
    };
  }

  if (err?.code === ErrorCodes.VOICE_PERMISSION_DENIED) {
    return {
      isError: true,
      embeds: [buildNoPermissionEmbed(err.userMessage || err.message)]
    };
  }

  return {
    isError: true,
    embeds: [
      buildErrorEmbed(
        'Playback Notice',
        err?.userMessage || 'Could not complete that request. Please try again.'
      )
    ]
  };
}

/**
 * Check guild context, member voice channel state, and bot permissions before executing a command.
 */
export function verifyVoiceAndPermissions({
  command,
  guild,
  member,
  voiceChannel,
  queueManager
}) {
  if (!guild) {
    return {
      ok: false,
      response: {
        isError: true,
        embeds: [buildNoPermissionEmbed('Music commands can only be used inside a Discord server.')]
      }
    };
  }

  if (!command.requiresVoice) {
    return { ok: true };
  }

  if (!voiceChannel || !voiceChannel.id) {
    return {
      ok: false,
      response: {
        isError: true,
        embeds: [buildNoPermissionEmbed('You must join a voice channel before using this command.')]
      }
    };
  }

  const snapshot = queueManager.getSnapshot(guild.id);
  if (
    command.requiresSameVoice &&
    snapshot.exists &&
    snapshot.voiceChannelId &&
    snapshot.voiceChannelId !== voiceChannel.id
  ) {
    return {
      ok: false,
      response: {
        isError: true,
        embeds: [
          buildNoPermissionEmbed('You must be in the same voice channel as the bot to use this command.')
        ]
      }
    };
  }

  // Verify bot Connect and Speak permissions if permissionsFor is available on the channel
  const botMember = guild.members?.me;
  if (botMember && typeof voiceChannel.permissionsFor === 'function') {
    const perms = voiceChannel.permissionsFor(botMember);
    if (perms && typeof perms.has === 'function') {
      const canConnect = perms.has(PermissionFlagsBits.Connect);
      const canSpeak = perms.has(PermissionFlagsBits.Speak);
      if (!canConnect || !canSpeak) {
        return {
          ok: false,
          response: {
            isError: true,
            embeds: [
              buildNoPermissionEmbed(
                'I need both **Connect** and **Speak** permissions in your voice channel to play audio.'
              )
            ]
          }
        };
      }
    }
  }

  return { ok: true, member };
}

/**
 * Create a unified command dispatcher handling both slash interactions and prefix messages.
 */
export function createCommandHandler(options = {}) {
  const { commands, aliases } = loadCommands(options.modules || ALL_COMMAND_MODULES);
  const queueManager = options.queueManager || defaultQueueManager;
  const resolver = options.resolver || defaultResolver;
  const runtimeConfig = options.config || config;
  const log = (options.logger || defaultLogger).child?.('commands') || defaultLogger;

  function resolveCommand(nameOrAlias) {
    if (!nameOrAlias) return null;
    const key = String(nameOrAlias).trim().toLowerCase();
    return commands.get(key) || commands.get(aliases.get(key)) || null;
  }

  /**
   * Handle a Discord ChatInputCommandInteraction.
   */
  async function handleSlashInteraction(interaction) {
    if (!interaction || (typeof interaction.isChatInputCommand === 'function' && !interaction.isChatInputCommand())) {
      return null;
    }

    const command = resolveCommand(interaction.commandName);
    if (!command) {
      const unknownPayload = {
        embeds: [buildErrorEmbed('Unknown Command', `The command \`/${interaction.commandName}\` is not recognized.`)],
        flags: MessageFlags.Ephemeral
      };
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply?.(unknownPayload);
      }
      return unknownPayload;
    }

    const guild = interaction.guild;
    const member = interaction.member;
    const voiceChannel = member?.voice?.channel || null;

    const check = verifyVoiceAndPermissions({
      command,
      guild,
      member,
      voiceChannel,
      queueManager
    });

    if (!check.ok) {
      const errPayload = {
        embeds: check.response.embeds,
        flags: MessageFlags.Ephemeral
      };
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply?.(errPayload);
      }
      return errPayload;
    }

    let deferred = Boolean(interaction.deferred);
    if (command.defer && !interaction.replied && !deferred) {
      try {
        await interaction.deferReply();
        deferred = true;
      } catch (err) {
        log.warn('Failed to defer slash interaction (may have expired)', {
          commandName: interaction.commandName,
          error: err.message
        });
        return null;
      }
    }

    const context = {
      type: 'slash',
      guildId: guild.id,
      voiceChannelId: voiceChannel?.id || null,
      textChannelId: interaction.channelId || interaction.channel?.id || null,
      textChannel: interaction.channel || null,
      adapterCreator: guild.voiceAdapterCreator || null,
      requesterTag: interaction.user?.tag || interaction.user?.username || 'Discord User',
      options: interaction.options,
      args: [],
      resolver,
      queueManager,
      config: runtimeConfig,
      logger: log
    };

    let response;
    try {
      log.info('Executing slash command', {
        guildId: guild.id,
        command: command.data.name,
        userId: interaction.user?.id
      });
      response = await command.execute(context);
    } catch (err) {
      log.warn('Slash command execution failed', {
        guildId: guild.id,
        command: command.data.name,
        code: err.code,
        error: err.message
      });
      response = mapErrorToEmbedResponse(err);
    }

    try {
      if (deferred || interaction.deferred) {
        await interaction.editReply({ embeds: response.embeds });
      } else if (!interaction.replied) {
        await interaction.reply({
          embeds: response.embeds,
          ...(response.isError ? { flags: MessageFlags.Ephemeral } : {})
        });
      }
    } catch (err) {
      log.warn('Failed to send slash interaction response', {
        guildId: guild.id,
        command: command.data.name,
        error: err.message
      });
    }

    return response;
  }

  /**
   * Handle a prefix message command (e.g., !play <query>).
   */
  async function handlePrefixMessage(message) {
    if (!message || message.author?.bot || !message.content) {
      return null;
    }

    const prefix = runtimeConfig.PREFIX || '!';
    if (!message.content.startsWith(prefix)) {
      return null;
    }

    const withoutPrefix = message.content.slice(prefix.length).trim();
    if (!withoutPrefix) {
      return null;
    }

    const parts = withoutPrefix.split(/\s+/);
    const rawCommandName = parts[0].toLowerCase();
    const args = parts.slice(1);

    const command = resolveCommand(rawCommandName);
    if (!command) {
      return null;
    }

    const guild = message.guild;
    const member = message.member;
    const voiceChannel = member?.voice?.channel || null;

    const check = verifyVoiceAndPermissions({
      command,
      guild,
      member,
      voiceChannel,
      queueManager
    });

    if (!check.ok) {
      try {
        await message.reply?.({ embeds: check.response.embeds });
      } catch (err) {
        log.debug('Failed to reply to prefix command permission check', { error: err.message });
      }
      return check.response;
    }

    const context = {
      type: 'prefix',
      guildId: guild.id,
      voiceChannelId: voiceChannel?.id || null,
      textChannelId: message.channelId || message.channel?.id || null,
      textChannel: message.channel || null,
      adapterCreator: guild.voiceAdapterCreator || null,
      requesterTag: message.author?.tag || message.author?.username || 'Discord User',
      options: null,
      args,
      resolver,
      queueManager,
      config: runtimeConfig,
      logger: log
    };

    let response;
    try {
      log.info('Executing prefix command', {
        guildId: guild.id,
        command: command.data.name,
        userId: message.author?.id
      });
      response = await command.execute(context);
    } catch (err) {
      log.warn('Prefix command execution failed', {
        guildId: guild.id,
        command: command.data.name,
        code: err.code,
        error: err.message
      });
      response = mapErrorToEmbedResponse(err);
    }

    try {
      await message.reply?.({ embeds: response.embeds });
    } catch (err) {
      log.warn('Failed to send prefix command reply', {
        guildId: guild.id,
        command: command.data.name,
        error: err.message
      });
    }

    return response;
  }

  return {
    commands,
    aliases,
    resolveCommand,
    handleSlashInteraction,
    handlePrefixMessage
  };
}

export default {
  ALL_COMMAND_MODULES,
  loadCommands,
  validateCommandModule,
  getSerializedSlashCommands,
  createCommandHandler
};
