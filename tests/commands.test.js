import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_COMMAND_MODULES,
  loadCommands,
  getSerializedSlashCommands,
  createCommandHandler
} from '../src/commands/index.js';
import { loadConfig, getSafeConfigSummary } from '../src/config.js';
import { deploySlashCommands } from '../src/deploy-commands.js';
import { redactSensitiveString } from '../src/utils/logger.js';

test('Commands — all required and additional command modules load and serialize cleanly', () => {
  const { commands, aliases } = loadCommands(ALL_COMMAND_MODULES);

  const requiredNames = ['play', 'pause', 'resume', 'skip', 'stop', 'queue', 'volume', 'loop', 'bassboost', 'nightcore', 'speed', 'nowplaying', 'help'];
  for (const name of requiredNames) {
    assert.ok(commands.has(name), `Expected command "${name}" to be registered`);
  }

  assert.equal(aliases.get('p'), 'play');
  assert.equal(aliases.get('s'), 'skip');
  assert.equal(aliases.get('q'), 'queue');
  assert.equal(aliases.get('np'), 'nowplaying');
  assert.equal(aliases.get('bb'), 'bassboost');
  assert.equal(aliases.get('nc'), 'nightcore');
  assert.equal(aliases.get('tempo'), 'speed');

  const serialized = getSerializedSlashCommands();
  assert.equal(serialized.length, requiredNames.length);
  for (const cmd of serialized) {
    assert.equal(typeof cmd.name, 'string');
    assert.equal(typeof cmd.description, 'string');
    assert.equal(cmd.dm_permission, false);
    assert.ok(Array.isArray(cmd.options));
  }
});

test('Commands — slash and prefix interfaces share identical business logic and permission checks', async () => {
  const calls = [];
  const mockResolver = {
    async resolve(query, { requestedBy }) {
      calls.push({ step: 'resolve', query, requestedBy });
      return {
        kind: 'track',
        track: {
          title: 'Test Song',
          artist: 'Test Artist',
          query: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          source: 'youtube',
          duration: 120,
          webpageUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          isLive: false,
          requestedBy
        }
      };
    }
  };

  const mockQueueManager = {
    getSnapshot() {
      return {
        exists: false,
        voiceChannelId: null,
        currentTrack: null,
        upcomingCount: 0,
        loopMode: 'off',
        volume: 80
      };
    },
    async enqueue(guildId, track, opts) {
      calls.push({ step: 'enqueue', guildId, trackTitle: track.title, voiceChannelId: opts.voiceChannelId });
      return {
        startedPlayback: true,
        activeTrack: track,
        addedCount: 1,
        droppedByQueueLimit: 0,
        queuePosition: 0,
        snapshot: { loopMode: 'off', volume: 80, upcomingCount: 0 }
      };
    }
  };

  const handler = createCommandHandler({
    resolver: mockResolver,
    queueManager: mockQueueManager,
    config: { PREFIX: '!', MAX_VOLUME: 200 }
  });

  // 1. Slash command invocation (/play)
  let deferred = false;
  let editedReply = null;
  await handler.handleSlashInteraction({
    commandName: 'play',
    guild: { id: 'guild-100' },
    member: { voice: { channel: { id: 'vc-100' } } },
    user: { id: 'u1', tag: 'slashuser#0001' },
    options: { getString: () => 'daft punk' },
    deferReply: async () => {
      deferred = true;
    },
    editReply: async (payload) => {
      editedReply = payload;
    }
  });

  assert.equal(deferred, true);
  assert.ok(editedReply?.embeds?.length === 1);
  assert.equal(editedReply.embeds[0].toJSON().title, 'Now Playing');

  // 2. Prefix command invocation (!play)
  let prefixReply = null;
  await handler.handlePrefixMessage({
    content: '!play daft punk',
    author: { id: 'u2', tag: 'prefixuser#0002', bot: false },
    guild: { id: 'guild-100' },
    member: { voice: { channel: { id: 'vc-100' } } },
    reply: async (payload) => {
      prefixReply = payload;
    }
  });

  assert.ok(prefixReply?.embeds?.length === 1);
  assert.equal(prefixReply.embeds[0].toJSON().title, 'Now Playing');
  assert.equal(calls.length, 4);
});

test('Config & Security — validates required variables, bounds, and redacts secrets', () => {
  assert.throws(() =>
    loadConfig({ DISCORD_TOKEN: '', DISCORD_CLIENT_ID: '123456789012345678' }, { requireCredentials: true, loadDotEnv: false })
  );

  assert.throws(() =>
    loadConfig(
      {
        DISCORD_TOKEN: 'real_looking_bot_token_1234567890',
        DISCORD_CLIENT_ID: '123456789012345678',
        DEFAULT_VOLUME: '250',
        MAX_VOLUME: '200'
      },
      { requireCredentials: true, loadDotEnv: false }
    )
  );

  const validCfg = loadConfig(
    {
      DISCORD_TOKEN: 'valid_test_token_value_1234567890',
      DISCORD_CLIENT_ID: '123456789012345678',
      IDLE_TIMEOUT_MS: '180000'
    },
    { requireCredentials: true, loadDotEnv: false }
  );

  const summary = getSafeConfigSummary(validCfg);
  assert.equal(summary.DISCORD_TOKEN, '[REDACTED]');
  assert.equal(JSON.stringify(validCfg).includes('valid_test_token_value_1234567890'), false);

  const redactedUrl = redactSensitiveString('https://cdn.example.com/audio.mp3?token=my_secret_999&sig=abcd1234');
  assert.equal(redactedUrl.includes('my_secret_999'), false);
  assert.equal(redactedUrl.includes('abcd1234'), false);
});

test('Deploy Commands — registers guild-scoped or global slash commands cleanly', async () => {
  const routesCalled = [];
  const mockRest = {
    async put(route, { body }) {
      routesCalled.push({ route, count: body.length });
      return body;
    }
  };

  const guildDeploy = await deploySlashCommands({
    env: {
      DISCORD_TOKEN: 'valid_test_token_value_1234567890',
      DISCORD_CLIENT_ID: '123456789012345678',
      DISCORD_GUILD_ID: '987654321098765432',
      LOG_LEVEL: 'silent'
    },
    restClient: mockRest
  });
  assert.equal(guildDeploy.scope, 'guild');

  const globalDeploy = await deploySlashCommands({
    env: {
      DISCORD_TOKEN: 'valid_test_token_value_1234567890',
      DISCORD_CLIENT_ID: '123456789012345678',
      LOG_LEVEL: 'silent'
    },
    restClient: mockRest
  });
  assert.equal(globalDeploy.scope, 'global');
  assert.equal(routesCalled.length, 2);
});
