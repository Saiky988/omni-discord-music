import { fileURLToPath } from 'node:url';
import { REST, Routes } from './utils/discordSdk.js';
import { loadConfig } from './config.js';
import { getSerializedSlashCommands } from './commands/index.js';
import { Logger } from './utils/logger.js';

/**
 * Deploy slash commands to Discord API and automatically clear duplicate scopes
 * so commands never show up twice (Guild + Global duplicates).
 *
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env=process.env]
 * @param {object} [options.restClient]
 * @param {object} [options.logger]
 * @param {boolean} [options.clearDuplicateScope]
 */
export async function deploySlashCommands(options = {}) {
  const env = options.env || process.env;
  const cfg = loadConfig(env, {
    requireCredentials: true
  });
  const log = options.logger || new Logger({ level: cfg.LOG_LEVEL, component: 'deploy-commands' });

  const commandPayloads = getSerializedSlashCommands();
  const rest = options.restClient || new REST({ version: '10' }).setToken(cfg.DISCORD_TOKEN);
  const shouldClearDuplicateScope = options.clearDuplicateScope ?? !options.restClient;
  const forceGlobal = String(env.DEPLOY_GLOBAL || '').trim().toLowerCase() === 'true';

  if (cfg.DISCORD_GUILD_ID && !forceGlobal) {
    // When running in production CLI without DEPLOY_GLOBAL=true, deploy Global commands AND clear
    // the Guild-scoped duplicate commands if clearDuplicateScope is enabled so Top.gg multi-server
    // deployments work everywhere AND the test server never sees 2x duplicate slash commands!
    if (shouldClearDuplicateScope) {
      const globalRoute = Routes.applicationCommands(cfg.DISCORD_CLIENT_ID);
      const guildRoute = Routes.applicationGuildCommands(cfg.DISCORD_CLIENT_ID, cfg.DISCORD_GUILD_ID);

      log.info('Clearing guild-scoped duplicate commands and deploying global slash commands (Top.gg ready)', {
        clientId: cfg.DISCORD_CLIENT_ID,
        clearedGuildId: cfg.DISCORD_GUILD_ID,
        commandCount: commandPayloads.length
      });

      await rest.put(guildRoute, { body: [] }).catch((err) => {
        log.warn('Could not clear guild-scoped commands', {
          guildId: cfg.DISCORD_GUILD_ID,
          error: err.message
        });
      });

      const result = await rest.put(globalRoute, { body: commandPayloads });
      log.info('Successfully registered global slash commands and removed guild duplicates', {
        registeredCount: Array.isArray(result) ? result.length : commandPayloads.length
      });

      return {
        scope: 'global',
        guildId: cfg.DISCORD_GUILD_ID,
        commands: commandPayloads
      };
    }

    const route = Routes.applicationGuildCommands(cfg.DISCORD_CLIENT_ID, cfg.DISCORD_GUILD_ID);
    log.info('Deploying guild-scoped slash commands', {
      clientId: cfg.DISCORD_CLIENT_ID,
      guildId: cfg.DISCORD_GUILD_ID,
      commandCount: commandPayloads.length
    });

    const result = await rest.put(route, { body: commandPayloads });
    log.info('Successfully registered guild slash commands', {
      guildId: cfg.DISCORD_GUILD_ID,
      registeredCount: Array.isArray(result) ? result.length : commandPayloads.length
    });
    return {
      scope: 'guild',
      guildId: cfg.DISCORD_GUILD_ID,
      commands: commandPayloads
    };
  }

  const route = Routes.applicationCommands(cfg.DISCORD_CLIENT_ID);
  log.info('Deploying global slash commands', {
    clientId: cfg.DISCORD_CLIENT_ID,
    commandCount: commandPayloads.length
  });

  if (shouldClearDuplicateScope && cfg.DISCORD_GUILD_ID) {
    const guildRoute = Routes.applicationGuildCommands(cfg.DISCORD_CLIENT_ID, cfg.DISCORD_GUILD_ID);
    await rest.put(guildRoute, { body: [] }).catch(() => {});
  }

  const result = await rest.put(route, { body: commandPayloads });
  log.info('Successfully registered global slash commands', {
    registeredCount: Array.isArray(result) ? result.length : commandPayloads.length
  });

  return {
    scope: 'global',
    guildId: null,
    commands: commandPayloads
  };
}

const isMainModule =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  deploySlashCommands().catch((err) => {
    const log = new Logger({ level: 'error', component: 'deploy-commands' });
    log.error('Failed to deploy slash commands', {
      code: err.code,
      message: err.message
    });
    process.exitCode = 1;
  });
}
