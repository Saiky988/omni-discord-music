import dns from 'node:dns';
dns.setDefaultResultOrder?.('ipv4first');
import { fileURLToPath } from 'node:url';
import {
  Client,
  ActivityType,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  generateDependencyReport,
  isNativeDiscordSdkInstalled
} from './utils/discordSdk.js';
import { loadConfig, getSafeConfigSummary } from './config.js';
import { Logger } from './utils/logger.js';
import { SourceResolver } from './services/resolver.js';
import { QueueManager } from './services/queueManager.js';
import {
  createCommandHandler,
  getSerializedSlashCommands
} from './commands/index.js';

/**
 * Create and wire the Omni Discord Music bot application instance.
 *
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env=process.env]
 * @param {boolean} [options.requireCredentials=true]
 * @param {object} [options.client]
 */
export function createBotApplication(options = {}) {
  const cfg = loadConfig(options.env || process.env, {
    requireCredentials: options.requireCredentials ?? true
  });

  const log = options.logger || new Logger({
    level: cfg.LOG_LEVEL,
    component: 'omni-music'
  });

  const client =
    options.client ||
    new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
      ],
      presence: {
        activities: [
          {
            name: cfg.BOT_STATUS || 'n!help',
            type: ActivityType.Listening
          }
        ],
        status: 'online'
      }
    });

  const resolver =
    options.resolver ||
    new SourceResolver({
      config: cfg,
      logger: log
    });

  const queueManager =
    options.queueManager ||
    new QueueManager({
      config: cfg,
      logger: log,
      resolver
    });

  const commandHandler = createCommandHandler({
    config: cfg,
    logger: log,
    resolver,
    queueManager
  });

  let isShuttingDown = false;

  // Guard against duplicate listener attachment if a shared client instance is passed
  client.removeAllListeners?.(Events.ClientReady);
  client.removeAllListeners?.(Events.InteractionCreate);
  client.removeAllListeners?.(Events.MessageCreate);
  client.removeAllListeners?.(Events.VoiceStateUpdate);
  client.removeAllListeners?.('guildDelete');

  client.once(Events.ClientReady, async (readyClient) => {
    const botUser = readyClient?.user || client.user;
    try {
      botUser?.setActivity?.(cfg.BOT_STATUS || 'n!help', {
        type: ActivityType.Listening
      });
    } catch (err) {
      log.debug('Failed to set bot activity status', { error: err.message });
    }

    const depReport = typeof generateDependencyReport === 'function' ? generateDependencyReport() : '';
    const hasDaveSupport =
      depReport.includes('@snazzah/davey') && !depReport.includes('@snazzah/davey: not found');

    log.info('Discord client connected and ready', {
      botUser: readyClient?.user?.tag || client.user?.tag || 'unknown',
      commandsLoaded: commandHandler.commands.size,
      daveE2eeReady: hasDaveSupport,
      config: getSafeConfigSummary(cfg)
    });

    if (depReport && !hasDaveSupport && !depReport.includes('Offline Test SDK')) {
      log.warn(
        'Discord DAVE E2EE library (@snazzah/davey) is missing or @discordjs/voice is outdated (<0.19.0). Voice connections will stall in Connecting and time out waiting for Ready!',
        { dependencyReport: depReport }
      );
    } else if (cfg.LOG_LEVEL === 'debug' && depReport) {
      log.debug('Voice dependency report', { dependencyReport: depReport });
    }

    // Automatically synchronize Global commands and wipe any Guild-level duplicate slash commands
    // on startup so servers never see 2x duplicate commands and Top.gg servers always have commands!
    if (isNativeDiscordSdkInstalled && cfg.DISCORD_TOKEN && cfg.DISCORD_CLIENT_ID) {
      void (async () => {
        try {
          const rest = new REST({ version: '10' }).setToken(cfg.DISCORD_TOKEN);
          const payloads = getSerializedSlashCommands();

          await rest.put(Routes.applicationCommands(cfg.DISCORD_CLIENT_ID), {
            body: payloads
          });

          const guildIdsToClean = new Set();
          if (cfg.DISCORD_GUILD_ID) {
            guildIdsToClean.add(cfg.DISCORD_GUILD_ID);
          }
          const cachedGuilds = readyClient?.guilds?.cache || client.guilds?.cache;
          if (cachedGuilds && typeof cachedGuilds.keys === 'function') {
            for (const gId of cachedGuilds.keys()) {
              guildIdsToClean.add(gId);
            }
          }

          for (const gId of guildIdsToClean) {
            await rest
              .put(Routes.applicationGuildCommands(cfg.DISCORD_CLIENT_ID, gId), {
                body: []
              })
              .catch(() => {});
          }

          log.info('Synchronized global slash commands and cleared duplicate guild-scoped commands', {
            globalCommands: payloads.length,
            cleanedGuilds: guildIdsToClean.size
          });
        } catch (err) {
          log.warn('Automatic slash command deduplication on startup encountered an error', {
            error: err.message
          });
        }
      })();
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (isShuttingDown) {
      return;
    }
    await commandHandler.handleSlashInteraction(interaction);
  });

  client.on(Events.MessageCreate, async (message) => {
    if (isShuttingDown) {
      return;
    }
    await commandHandler.handlePrefixMessage(message);
  });

  client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
    const botId = client.user?.id;
    const guildId = oldState?.guild?.id || newState?.guild?.id;
    if (!guildId) {
      return;
    }

    // 1. Handle bot's own voice state changes
    if (botId && oldState?.id === botId) {
      if (oldState.channelId && !newState?.channelId) {
        log.info('Bot was disconnected from voice channel; cleaning up guild queue', {
          guildId
        });
        await queueManager.destroyGuildQueue(guildId, 'bot_kicked_from_voice');
        return;
      }
      if (newState?.channelId && oldState.channelId !== newState.channelId) {
        const queue = queueManager.getQueue(guildId);
        if (queue) {
          queue.voiceChannelId = newState.channelId;
        }
      }
    }

    // 2. Top.gg Multi-Server Safeguard: check if the bot's active voice channel became empty of humans
    const queue = queueManager.getQueue(guildId);
    if (!queue || !queue.voiceChannelId) {
      return;
    }

    const relevantChannel =
      oldState?.channelId === queue.voiceChannelId
        ? oldState.channel
        : newState?.channelId === queue.voiceChannelId
          ? newState.channel
          : null;

    if (relevantChannel?.members && typeof relevantChannel.members.filter === 'function') {
      const humanCount = relevantChannel.members.filter((m) => !m.user?.bot).size ?? 0;
      if (humanCount === 0) {
        queueManager.handleVoiceChannelEmpty(guildId);
      } else {
        queueManager.handleVoiceChannelPopulated(guildId);
      }
    }
  });

  // Top.gg Multi-Server Safeguard: clean up resources immediately if the bot is removed from a server
  client.on('guildDelete', async (guild) => {
    if (guild?.id) {
      log.info('Bot removed from guild; cleaning up queue', { guildId: guild.id });
      await queueManager.destroyGuildQueue(guild.id, 'guild_removed');
    }
  });

  client.on(Events.Error, (err) => {
    log.error('Discord client error', { error: err.message });
  });

  client.on(Events.Warn, (warning) => {
    log.warn('Discord client warning', { warning });
  });

  async function shutdown(signal = 'SIGTERM') {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;

    log.info('Initiating graceful shutdown', { signal });

    try {
      await queueManager.shutdownAll();
    } catch (err) {
      log.error('Error while shutting down guild queues', { error: err.message });
    }

    try {
      client.destroy();
    } catch (err) {
      log.error('Error while destroying Discord client', { error: err.message });
    }

    log.info('Graceful shutdown complete', { signal });
  }

  async function start() {
    log.info('Starting omni-discord-music', {
      config: getSafeConfigSummary(cfg)
    });
    await client.login(cfg.DISCORD_TOKEN);
    return { client, queueManager, resolver, commandHandler, shutdown };
  }

  return {
    config: cfg,
    logger: log,
    client,
    resolver,
    queueManager,
    commandHandler,
    start,
    shutdown
  };
}

const isMainModule =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  let app;
  try {
    app = createBotApplication();
  } catch (err) {
    const startupLogger = new Logger({ level: 'error', component: 'startup' });
    startupLogger.error('Configuration validation failed at startup', {
      code: err.code,
      message: err.message
    });
    process.exit(1);
  }

  const handleSignal = async (signal, exitCode = 0) => {
    const forceExitTimer = setTimeout(() => {
      process.exit(exitCode || 1);
    }, 10000);
    forceExitTimer.unref?.();

    await app.shutdown(signal);
    clearTimeout(forceExitTimer);
    process.exit(exitCode);
  };

  process.once('SIGINT', () => void handleSignal('SIGINT', 0));
  process.once('SIGTERM', () => void handleSignal('SIGTERM', 0));

  // Log unhandled rejections without crashing the entire multi-guild Top.gg bot
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    app.logger.error('Unhandled Promise Rejection caught', {
      error: err.message
    });
  });

  process.on('uncaughtException', (err) => {
    app.logger.error('Uncaught Exception — initiating controlled shutdown', {
      error: err.message
    });
    void handleSignal('uncaughtException', 1);
  });

  app.start().catch((err) => {
    app.logger.error('Failed to start Discord bot', {
      error: err.message
    });
    process.exit(1);
  });
}

export default createBotApplication;
