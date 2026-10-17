import { fileURLToPath } from 'node:url';
import { REST, Routes } from './utils/discordSdk.js';
import { loadConfig } from './config.js';
import { getSerializedSlashCommands } from './commands/index.js';
import { Logger } from './utils/logger.js';

/**
 * Deploy slash commands to Discord API (guild-scoped when DISCORD_GUILD_ID is configured,
 * or global application commands otherwise).
 *
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env=process.env]
 * @param {object} [options.restClient]
 * @param {object} [options.logger]
 */
export async function deploySlashCommands(options = {}) {
  const cfg = loadConfig(options.env || process.env, {
    requireCredentials: true
  });
  const log = options.logger || new Logger({ level: cfg.LOG_LEVEL, component: 'deploy-commands' });

  const commandPayloads = getSerializedSlashCommands();
  const rest = options.restClient || new REST({ version: '10' }).setToken(cfg.DISCORD_TOKEN);

  if (cfg.DISCORD_GUILD_ID) {
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
