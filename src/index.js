import { fileURLToPath } from 'node:url';
import {
  Client,
  GatewayIntentBits,
  Events,
  generateDependencyReport
} from './utils/discordSdk.js';
import { loadConfig, getSafeConfigSummary } from './config.js';
import { Logger } from './utils/logger.js';
import { SourceResolver } from './services/resolver.js';
import { QueueManager } from './services/queueManager.js';
import { createCommandHandler } from './commands/index.js';

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
      ]
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
      logger: log
    });

  const commandHandler = createCommandHandler({
    config: cfg,
    logger: log,
    resolver,
    queueManager
  });

  let isShuttingDown = false;

  client.once(Events.ClientReady, (readyClient) => {
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
    if (!botId || oldState?.id !== botId) {
      return;
    }
    const guildId = oldState.guild?.id;
    if (guildId && oldState.channelId && !newState?.channelId) {
      log.info('Bot was disconnected from voice channel; cleaning up guild queue', {
        guildId
      });
      await queueManager.destroyGuildQueue(guildId, 'bot_kicked_from_voice');
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

  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    app.logger.error('Unhandled Promise Rejection — initiating controlled shutdown', {
      error: err.message
    });
    void handleSignal('unhandledRejection', 1);
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
