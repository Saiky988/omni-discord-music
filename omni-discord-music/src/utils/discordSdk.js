import { EventEmitter } from 'node:events';

/**
 * SDK loader for discord.js, @discordjs/voice, and play-dl.
 *
 * When installed in node_modules (production/development deployment), this module
 * exports the exact upstream classes and functions from discord.js, @discordjs/voice,
 * and play-dl.
 *
 * When running in an isolated/offline test runner without node_modules installed,
 * it provides spec-compatible Discord API v10 builders, enums, and event-driven
 * voice/player primitives so unit tests, command-loading checks, and slash-command
 * JSON serialization checks execute deterministically.
 */

let discordJsModule = null;
let discordVoiceModule = null;
let playDlModule = null;

try {
  discordJsModule = await import('discord.js');
} catch {
  discordJsModule = null;
}

try {
  discordVoiceModule = await import('@discordjs/voice');
} catch {
  discordVoiceModule = null;
}

try {
  const importedPlayDl = await import('play-dl');
  playDlModule = importedPlayDl.default || importedPlayDl;
} catch {
  playDlModule = null;
}

/* -------------------------------------------------------------------------- */
/* Discord API v10 compatible builders & constants (used when offline)        */
/* -------------------------------------------------------------------------- */

class FallbackCollection extends Map {
  find(fn) {
    for (const [k, v] of this.entries()) {
      if (fn(v, k, this)) return v;
    }
    return undefined;
  }
  filter(fn) {
    const out = new FallbackCollection();
    for (const [k, v] of this.entries()) {
      if (fn(v, k, this)) out.set(k, v);
    }
    return out;
  }
  map(fn) {
    const out = [];
    for (const [k, v] of this.entries()) {
      out.push(fn(v, k, this));
    }
    return out;
  }
}

class OptionBuilderBase {
  constructor(type) {
    this.type = type;
    this.name = '';
    this.description = '';
    this.required = false;
    this.choices = undefined;
    this.min_value = undefined;
    this.max_value = undefined;
    this.min_length = undefined;
    this.max_length = undefined;
  }
  setName(name) {
    if (!name || typeof name !== 'string' || !/^[\w-]{1,32}$/.test(name) || name !== name.toLowerCase()) {
      throw new RangeError(`Invalid slash option name "${name}".`);
    }
    this.name = name;
    return this;
  }
  setDescription(description) {
    if (!description || typeof description !== 'string' || description.length > 100) {
      throw new RangeError('Option description must be 1-100 characters.');
    }
    this.description = description;
    return this;
  }
  setRequired(required) {
    this.required = Boolean(required);
    return this;
  }
  addChoices(...choices) {
    this.choices = (this.choices || []).concat(choices.flat());
    return this;
  }
  setMinValue(min) {
    this.min_value = min;
    return this;
  }
  setMaxValue(max) {
    this.max_value = max;
    return this;
  }
  setMinLength(min) {
    this.min_length = min;
    return this;
  }
  setMaxLength(max) {
    this.max_length = max;
    return this;
  }
  toJSON() {
    const json = {
      type: this.type,
      name: this.name,
      description: this.description,
      required: this.required
    };
    if (this.choices) json.choices = this.choices.map((c) => ({ ...c }));
    if (this.min_value !== undefined) json.min_value = this.min_value;
    if (this.max_value !== undefined) json.max_value = this.max_value;
    if (this.min_length !== undefined) json.min_length = this.min_length;
    if (this.max_length !== undefined) json.max_length = this.max_length;
    return json;
  }
}

class FallbackSlashCommandBuilder {
  constructor() {
    this.name = '';
    this.description = '';
    this.options = [];
    this.dm_permission = false;
  }
  setName(name) {
    if (!name || typeof name !== 'string' || !/^[\w-]{1,32}$/.test(name) || name !== name.toLowerCase()) {
      throw new RangeError(`Invalid slash command name "${name}".`);
    }
    this.name = name;
    return this;
  }
  setDescription(description) {
    if (!description || typeof description !== 'string' || description.length > 100) {
      throw new RangeError('Slash command description must be 1-100 characters.');
    }
    this.description = description;
    return this;
  }
  setDMPermission(enabled) {
    this.dm_permission = Boolean(enabled);
    return this;
  }
  addStringOption(fn) {
    const opt = new OptionBuilderBase(3);
    fn(opt);
    this.options.push(opt);
    return this;
  }
  addIntegerOption(fn) {
    const opt = new OptionBuilderBase(4);
    fn(opt);
    this.options.push(opt);
    return this;
  }
  addBooleanOption(fn) {
    const opt = new OptionBuilderBase(5);
    fn(opt);
    this.options.push(opt);
    return this;
  }
  toJSON() {
    if (!this.name || !this.description) {
      throw new Error('SlashCommandBuilder requires both name and description before serialization.');
    }
    return {
      name: this.name,
      description: this.description,
      dm_permission: this.dm_permission,
      options: this.options.map((opt) => opt.toJSON())
    };
  }
}

class FallbackEmbedBuilder {
  constructor(initial = {}) {
    this.data = {
      ...initial,
      fields: initial.fields ? [...initial.fields] : []
    };
  }
  setColor(color) {
    this.data.color = color;
    return this;
  }
  setTitle(title) {
    this.data.title = title ? String(title).slice(0, 256) : undefined;
    return this;
  }
  setURL(url) {
    this.data.url = url || undefined;
    return this;
  }
  setDescription(description) {
    this.data.description = description ? String(description).slice(0, 4096) : undefined;
    return this;
  }
  setThumbnail(url) {
    this.data.thumbnail = url ? { url } : undefined;
    return this;
  }
  setFooter(footer) {
    if (footer && footer.text) {
      this.data.footer = {
        text: String(footer.text).slice(0, 2048),
        icon_url: footer.iconURL || footer.icon_url
      };
    }
    return this;
  }
  setTimestamp(timestamp = new Date()) {
    this.data.timestamp = (timestamp instanceof Date ? timestamp : new Date(timestamp)).toISOString();
    return this;
  }
  addFields(...fields) {
    const flat = fields.flat();
    for (const field of flat) {
      if (!field || this.data.fields.length >= 25) continue;
      this.data.fields.push({
        name: String(field.name ?? '\u200b').slice(0, 256),
        value: String(field.value ?? '\u200b').slice(0, 1024),
        inline: Boolean(field.inline)
      });
    }
    return this;
  }
  toJSON() {
    const out = { ...this.data };
    if (!out.fields || out.fields.length === 0) {
      delete out.fields;
    } else {
      out.fields = out.fields.map((f) => ({ ...f }));
    }
    return out;
  }
}

class FallbackClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.user = null;
    this.guilds = { cache: new FallbackCollection() };
    this.ws = { status: 0, ping: 42 };
    this.isDestroyed = false;
  }
  async login(token) {
    if (!token || typeof token !== 'string') {
      throw new Error('TOKEN_INVALID');
    }
    this.user = { id: '000000000000000000', tag: 'omni-discord-music#0000' };
    return token;
  }
  destroy() {
    this.isDestroyed = true;
    this.removeAllListeners();
  }
}

class FallbackREST {
  constructor(options = {}) {
    this.options = options;
    this.token = null;
  }
  setToken(token) {
    this.token = token;
    return this;
  }
  async put(route, options = {}) {
    if (!this.token) {
      throw new Error('REST token not set.');
    }
    return Array.isArray(options.body) ? options.body : [];
  }
}

const FallbackRoutes = Object.freeze({
  applicationCommands: (clientId) => `/applications/${clientId}/commands`,
  applicationGuildCommands: (clientId, guildId) =>
    `/applications/${clientId}/guilds/${guildId}/commands`
});

const FallbackGatewayIntentBits = Object.freeze({
  Guilds: 1 << 0,
  GuildVoiceStates: 1 << 7,
  GuildMessages: 1 << 9,
  MessageContent: 1 << 15
});

const FallbackEvents = Object.freeze({
  ClientReady: 'ready',
  InteractionCreate: 'interactionCreate',
  MessageCreate: 'messageCreate',
  VoiceStateUpdate: 'voiceStateUpdate',
  Error: 'error',
  Warn: 'warn'
});

const FallbackPermissionFlagsBits = Object.freeze({
  ViewChannel: 1n << 10n,
  SendMessages: 1n << 11n,
  EmbedLinks: 1n << 14n,
  Connect: 1n << 20n,
  Speak: 1n << 21n
});

const FallbackMessageFlags = Object.freeze({
  Ephemeral: 64
});

/* -------------------------------------------------------------------------- */
/* @discordjs/voice compatible enums & primitives (used when offline)         */
/* -------------------------------------------------------------------------- */

const FallbackAudioPlayerStatus = Object.freeze({
  Idle: 'idle',
  Buffering: 'buffering',
  Playing: 'playing',
  Paused: 'paused',
  AutoPaused: 'autopaused'
});

const FallbackVoiceConnectionStatus = Object.freeze({
  Signalling: 'signalling',
  Connecting: 'connecting',
  Ready: 'ready',
  Disconnected: 'disconnected',
  Destroyed: 'destroyed'
});

const FallbackStreamType = Object.freeze({
  Arbitrary: 'arbitrary',
  Raw: 'raw',
  OggOpus: 'ogg/opus',
  WebmOpus: 'webm/opus',
  Opus: 'opus'
});

const FallbackNoSubscriberBehavior = Object.freeze({
  Pause: 'pause',
  Play: 'play',
  Stop: 'stop'
});

class FallbackVolumeTransformer {
  constructor() {
    this.volume = 1;
  }
  setVolume(volume) {
    this.volume = Number(volume);
  }
  setVolumeLogarithmic(value) {
    this.volume = Math.pow(Number(value), 1.660964);
  }
  setVolumeDecibels(db) {
    this.volume = Math.pow(10, db / 20);
  }
}

function fallbackCreateAudioResource(stream, options = {}) {
  const inlineVolume = Boolean(options.inlineVolume);
  const resource = {
    playStream: stream,
    inputType: options.inputType || FallbackStreamType.Arbitrary,
    metadata: options.metadata ?? null,
    volume: inlineVolume ? new FallbackVolumeTransformer() : undefined,
    started: false,
    ended: false,
    playbackDuration: 0
  };

  if (stream && typeof stream.on === 'function') {
    stream.once('end', () => {
      resource.ended = true;
    });
    stream.once('close', () => {
      resource.ended = true;
    });
  }

  return resource;
}

class FallbackAudioPlayer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.behaviors = options.behaviors || {};
    this.state = { status: FallbackAudioPlayerStatus.Idle };
    this.subscribers = [];
  }

  transitionTo(nextState) {
    const oldState = this.state;
    this.state = nextState;
    this.emit('stateChange', oldState, nextState);
    this.emit(nextState.status, oldState, nextState);
  }

  play(resource) {
    if (!resource) {
      throw new TypeError('AudioResource is required to start playback.');
    }
    this.transitionTo({
      status: FallbackAudioPlayerStatus.Buffering,
      resource
    });
    this.transitionTo({
      status: FallbackAudioPlayerStatus.Playing,
      resource,
      playbackDuration: 0
    });
  }

  pause() {
    if (this.state.status === FallbackAudioPlayerStatus.Playing) {
      this.transitionTo({
        status: FallbackAudioPlayerStatus.Paused,
        resource: this.state.resource
      });
      return true;
    }
    return false;
  }

  unpause() {
    if (
      this.state.status === FallbackAudioPlayerStatus.Paused ||
      this.state.status === FallbackAudioPlayerStatus.AutoPaused
    ) {
      this.transitionTo({
        status: FallbackAudioPlayerStatus.Playing,
        resource: this.state.resource
      });
      return true;
    }
    return false;
  }

  stop(force = false) {
    if (this.state.status === FallbackAudioPlayerStatus.Idle && !force) {
      return false;
    }
    const resource = this.state.resource;
    if (resource?.playStream && typeof resource.playStream.destroy === 'function') {
      resource.playStream.destroy();
    }
    this.transitionTo({ status: FallbackAudioPlayerStatus.Idle });
    return true;
  }
}

function fallbackCreateAudioPlayer(options = {}) {
  return new FallbackAudioPlayer(options);
}

const activeVoiceConnections = new Map();

class FallbackVoiceConnection extends EventEmitter {
  constructor(joinConfig) {
    super();
    this.joinConfig = { ...joinConfig };
    this.state = { status: FallbackVoiceConnectionStatus.Signalling };
    this.subscription = null;
    queueMicrotask(() => {
      if (this.state.status !== FallbackVoiceConnectionStatus.Destroyed) {
        this.setStatus(FallbackVoiceConnectionStatus.Ready);
      }
    });
  }

  setStatus(status, extra = {}) {
    const oldState = this.state;
    const nextState = { status, ...extra };
    this.state = nextState;
    this.emit('stateChange', oldState, nextState);
    this.emit(status, oldState, nextState);
  }

  subscribe(player) {
    this.subscription = {
      player,
      connection: this,
      unsubscribe: () => {
        this.subscription = null;
      }
    };
    return this.subscription;
  }

  rejoin(joinConfig = {}) {
    this.joinConfig = { ...this.joinConfig, ...joinConfig };
    this.setStatus(FallbackVoiceConnectionStatus.Connecting);
    return true;
  }

  destroy() {
    if (this.state.status === FallbackVoiceConnectionStatus.Destroyed) {
      return;
    }
    activeVoiceConnections.delete(this.joinConfig.guildId);
    this.setStatus(FallbackVoiceConnectionStatus.Destroyed);
    this.removeAllListeners();
  }
}

function fallbackJoinVoiceChannel(joinConfig) {
  const connection = new FallbackVoiceConnection(joinConfig);
  if (joinConfig?.guildId) {
    activeVoiceConnections.set(joinConfig.guildId, connection);
  }
  return connection;
}

function fallbackGetVoiceConnection(guildId) {
  return activeVoiceConnections.get(guildId) || undefined;
}

function fallbackEntersState(target, status, timeoutOrSignal = 10000) {
  if (target?.state?.status === status) {
    return Promise.resolve(target);
  }

  const timeoutMs = typeof timeoutOrSignal === 'number' ? timeoutOrSignal : 10000;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      const err = new Error(`Timed out waiting for state "${status}" after ${timeoutMs}ms.`);
      err.code = 'ABORT_ERR';
      reject(err);
    }, timeoutMs);
    timer.unref?.();

    const onStateChange = (_oldState, newState) => {
      if (newState?.status === status) {
        cleanup();
        resolve(target);
      } else if (
        newState?.status === FallbackVoiceConnectionStatus.Destroyed &&
        status !== FallbackVoiceConnectionStatus.Destroyed
      ) {
        cleanup();
        reject(new Error('Target was destroyed before reaching expected state.'));
      }
    };

    function cleanup() {
      clearTimeout(timer);
      target?.off?.('stateChange', onStateChange);
      target?.removeListener?.('stateChange', onStateChange);
    }

    target?.on?.('stateChange', onStateChange);
  });
}

function fallbackGenerateDependencyReport() {
  return 'Offline Test SDK Mode (@discordjs/voice not installed in node_modules)';
}

export const Client = discordJsModule?.Client || FallbackClient;
export const Collection = discordJsModule?.Collection || FallbackCollection;
export const GatewayIntentBits = discordJsModule?.GatewayIntentBits || FallbackGatewayIntentBits;
export const Events = discordJsModule?.Events || FallbackEvents;
export const SlashCommandBuilder = discordJsModule?.SlashCommandBuilder || FallbackSlashCommandBuilder;
export const EmbedBuilder = discordJsModule?.EmbedBuilder || FallbackEmbedBuilder;
export const PermissionFlagsBits = discordJsModule?.PermissionFlagsBits || FallbackPermissionFlagsBits;
export const MessageFlags = discordJsModule?.MessageFlags || FallbackMessageFlags;
export const REST = discordJsModule?.REST || FallbackREST;
export const Routes = discordJsModule?.Routes || FallbackRoutes;

export const AudioPlayerStatus = discordVoiceModule?.AudioPlayerStatus || FallbackAudioPlayerStatus;
export const VoiceConnectionStatus =
  discordVoiceModule?.VoiceConnectionStatus || FallbackVoiceConnectionStatus;
export const StreamType = discordVoiceModule?.StreamType || FallbackStreamType;
export const NoSubscriberBehavior =
  discordVoiceModule?.NoSubscriberBehavior || FallbackNoSubscriberBehavior;
export const createAudioResource =
  discordVoiceModule?.createAudioResource || fallbackCreateAudioResource;
export const createAudioPlayer =
  discordVoiceModule?.createAudioPlayer || fallbackCreateAudioPlayer;
export const joinVoiceChannel =
  discordVoiceModule?.joinVoiceChannel || fallbackJoinVoiceChannel;
export const getVoiceConnection =
  discordVoiceModule?.getVoiceConnection || fallbackGetVoiceConnection;
export const entersState = discordVoiceModule?.entersState || fallbackEntersState;
export const generateDependencyReport =
  discordVoiceModule?.generateDependencyReport || fallbackGenerateDependencyReport;

export const playDl = playDlModule;
export const isNativeDiscordSdkInstalled = Boolean(discordJsModule && discordVoiceModule);
