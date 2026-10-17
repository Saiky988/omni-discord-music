import fs from 'node:fs';
import path from 'node:path';
import { ConfigValidationError } from './utils/errors.js';

const VALID_LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error', 'silent']);
const PLACEHOLDER_PATTERNS = [
  /^your[_-]/i,
  /^insert[_-]/i,
  /^replace[_-]/i,
  /^<.*>$/,
  /^xxx+$/i,
  /^example/i,
  /^token_here$/i
];

/**
 * Parse a .env file from disk without requiring external packages,
 * populating missing keys in the target environment object.
 *
 * @param {string} envFilePath
 * @param {Record<string, string | undefined>} targetEnv
 */
export function loadDotEnvFile(envFilePath = path.resolve(process.cwd(), '.env'), targetEnv = process.env) {
  if (!fs.existsSync(envFilePath)) {
    return false;
  }

  const content = fs.readFileSync(envFilePath, 'utf8');
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const normalized = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eqIndex = normalized.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }

    const key = normalized.slice(0, eqIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    let value = normalized.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      const commentIdx = value.indexOf(' #');
      if (commentIdx !== -1) {
        value = value.slice(0, commentIdx).trim();
      }
    }

    if (targetEnv[key] === undefined) {
      targetEnv[key] = value;
    }
  }

  return true;
}

/**
 * Parse an integer configuration variable with strict validation and bounds checking.
 */
export function parseIntOption(name, rawValue, defaultValue, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') {
    return defaultValue;
  }

  const str = String(rawValue).trim();
  if (!/^-?\d+$/.test(str)) {
    throw new ConfigValidationError(`Invalid integer for ${name}: must be a whole number.`, {
      setting: name
    });
  }

  const parsed = Number.parseInt(str, 10);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigValidationError(
      `Out-of-range value for ${name}: expected integer between ${min} and ${max}.`,
      { setting: name, min, max }
    );
  }

  return parsed;
}

/**
 * Parse a boolean configuration variable explicitly.
 */
export function parseBooleanOption(name, rawValue, defaultValue) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') {
    return defaultValue;
  }

  const normalized = String(rawValue).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['false', '0', 'no', 'off'].includes(normalized)) {
    return false;
  }

  throw new ConfigValidationError(
    `Invalid boolean for ${name}: expected true/false, 1/0, or yes/no.`,
    { setting: name }
  );
}

function isPlaceholderSecret(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return true;
  }
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function validateSnowflake(name, value, required = false) {
  const trimmed = value ? String(value).trim() : '';
  if (!trimmed) {
    if (required) {
      throw new ConfigValidationError(`Missing required configuration: ${name}.`, {
        setting: name
      });
    }
    return null;
  }

  if (isPlaceholderSecret(trimmed) || !/^\d{15,22}$/.test(trimmed)) {
    throw new ConfigValidationError(
      `Invalid ${name}: must be a valid Discord Snowflake ID (15-22 digits).`,
      { setting: name }
    );
  }

  return trimmed;
}

/**
 * Load and validate configuration from an environment object.
 *
 * @param {Record<string, string | undefined>} [env=process.env]
 * @param {object} [options]
 * @param {boolean} [options.requireCredentials=true]
 * @param {boolean} [options.loadDotEnv=true]
 * @param {string} [options.dotEnvPath]
 */
export function loadConfig(env = process.env, options = {}) {
  const {
    requireCredentials = true,
    loadDotEnv = true,
    dotEnvPath = path.resolve(process.cwd(), '.env')
  } = options;

  if (loadDotEnv && env === process.env) {
    loadDotEnvFile(dotEnvPath, env);
  }

  const rawToken = env.DISCORD_TOKEN ? String(env.DISCORD_TOKEN).trim() : '';
  if (requireCredentials) {
    if (!rawToken || isPlaceholderSecret(rawToken) || rawToken.length < 20) {
      throw new ConfigValidationError(
        'Missing or invalid DISCORD_TOKEN. Set a valid bot token in your environment or .env file.',
        { setting: 'DISCORD_TOKEN' }
      );
    }
  }

  const clientId = validateSnowflake(
    'DISCORD_CLIENT_ID',
    env.DISCORD_CLIENT_ID,
    requireCredentials
  );

  const guildId = validateSnowflake(
    'DISCORD_GUILD_ID',
    env.DISCORD_GUILD_ID,
    false
  );

  const prefix = env.PREFIX !== undefined && String(env.PREFIX).trim() !== ''
    ? String(env.PREFIX).trim()
    : '!';

  if (prefix.length > 5 || /\s/.test(prefix)) {
    throw new ConfigValidationError(
      'Invalid PREFIX: must be 1 to 5 non-whitespace characters.',
      { setting: 'PREFIX' }
    );
  }

  const maxVolume = parseIntOption('MAX_VOLUME', env.MAX_VOLUME, 200, { min: 1, max: 500 });
  const defaultVolume = parseIntOption('DEFAULT_VOLUME', env.DEFAULT_VOLUME, 80, {
    min: 0,
    max: maxVolume
  });

  const idleTimeoutMs = parseIntOption('IDLE_TIMEOUT_MS', env.IDLE_TIMEOUT_MS, 180000, {
    min: 1000,
    max: 86400000
  });

  const maxQueueSize = parseIntOption('MAX_QUEUE_SIZE', env.MAX_QUEUE_SIZE, 500, {
    min: 1,
    max: 10000
  });

  const maxPlaylistTracks = parseIntOption(
    'MAX_PLAYLIST_TRACKS',
    env.MAX_PLAYLIST_TRACKS,
    100,
    { min: 1, max: 1000 }
  );

  const maxTrackDurationSeconds = parseIntOption(
    'MAX_TRACK_DURATION_SECONDS',
    env.MAX_TRACK_DURATION_SECONDS,
    14400,
    { min: 10, max: 86400 }
  );

  const logLevel = (env.LOG_LEVEL ? String(env.LOG_LEVEL).trim().toLowerCase() : 'info');
  if (!VALID_LOG_LEVELS.has(logLevel)) {
    throw new ConfigValidationError(
      `Invalid LOG_LEVEL "${logLevel}": expected one of ${Array.from(VALID_LOG_LEVELS).join(', ')}.`,
      { setting: 'LOG_LEVEL' }
    );
  }

  const ytdlpPath = env.YTDLP_PATH && String(env.YTDLP_PATH).trim()
    ? String(env.YTDLP_PATH).trim()
    : 'yt-dlp';

  const ffmpegPath = env.FFMPEG_PATH && String(env.FFMPEG_PATH).trim()
    ? String(env.FFMPEG_PATH).trim()
    : 'ffmpeg';

  if (/[\0\r\n]/.test(ytdlpPath) || /[\0\r\n]/.test(ffmpegPath)) {
    throw new ConfigValidationError(
      'Invalid executable path in YTDLP_PATH or FFMPEG_PATH.',
      { setting: 'YTDLP_PATH/FFMPEG_PATH' }
    );
  }

  const resolveTimeoutMs = parseIntOption('RESOLVE_TIMEOUT_MS', env.RESOLVE_TIMEOUT_MS, 20000, {
    min: 1000,
    max: 120000
  });

  const streamSpawnTimeoutMs = parseIntOption(
    'STREAM_SPAWN_TIMEOUT_MS',
    env.STREAM_SPAWN_TIMEOUT_MS,
    15000,
    { min: 500, max: 120000 }
  );

  const processKillTimeoutMs = parseIntOption(
    'PROCESS_KILL_TIMEOUT_MS',
    env.PROCESS_KILL_TIMEOUT_MS,
    5000,
    { min: 100, max: 60000 }
  );

  const voiceReadyTimeoutMs = parseIntOption(
    'VOICE_READY_TIMEOUT_MS',
    env.VOICE_READY_TIMEOUT_MS,
    20000,
    { min: 1000, max: 120000 }
  );

  const voiceReconnectAttempts = parseIntOption(
    'VOICE_RECONNECT_ATTEMPTS',
    env.VOICE_RECONNECT_ATTEMPTS,
    3,
    { min: 0, max: 10 }
  );

  const maxConsecutiveFailures = parseIntOption(
    'MAX_CONSECUTIVE_FAILURES',
    env.MAX_CONSECUTIVE_FAILURES,
    3,
    { min: 1, max: 20 }
  );

  const playlistConcurrency = parseIntOption(
    'PLAYLIST_CONCURRENCY',
    env.PLAYLIST_CONCURRENCY,
    3,
    { min: 1, max: 10 }
  );

  const metadataCacheTtlMs = parseIntOption(
    'METADATA_CACHE_TTL_MS',
    env.METADATA_CACHE_TTL_MS,
    300000,
    { min: 0, max: 86400000 }
  );

  const metadataCacheMaxEntries = parseIntOption(
    'METADATA_CACHE_MAX_ENTRIES',
    env.METADATA_CACHE_MAX_ENTRIES,
    250,
    { min: 1, max: 5000 }
  );

  const allowHttpMedia = parseBooleanOption('ALLOW_HTTP_MEDIA', env.ALLOW_HTTP_MEDIA, false);

  const configObj = {
    DISCORD_TOKEN: rawToken || null,
    DISCORD_CLIENT_ID: clientId,
    DISCORD_GUILD_ID: guildId,
    PREFIX: prefix,
    DEFAULT_VOLUME: defaultVolume,
    MAX_VOLUME: maxVolume,
    IDLE_TIMEOUT_MS: idleTimeoutMs,
    MAX_QUEUE_SIZE: maxQueueSize,
    MAX_PLAYLIST_TRACKS: maxPlaylistTracks,
    MAX_TRACK_DURATION_SECONDS: maxTrackDurationSeconds,
    LOG_LEVEL: logLevel,
    YTDLP_PATH: ytdlpPath,
    FFMPEG_PATH: ffmpegPath,
    RESOLVE_TIMEOUT_MS: resolveTimeoutMs,
    STREAM_SPAWN_TIMEOUT_MS: streamSpawnTimeoutMs,
    PROCESS_KILL_TIMEOUT_MS: processKillTimeoutMs,
    VOICE_READY_TIMEOUT_MS: voiceReadyTimeoutMs,
    VOICE_RECONNECT_ATTEMPTS: voiceReconnectAttempts,
    MAX_CONSECUTIVE_FAILURES: maxConsecutiveFailures,
    PLAYLIST_CONCURRENCY: playlistConcurrency,
    METADATA_CACHE_TTL_MS: metadataCacheTtlMs,
    METADATA_CACHE_MAX_ENTRIES: metadataCacheMaxEntries,
    ALLOW_HTTP_MEDIA: allowHttpMedia
  };

  Object.defineProperty(configObj, 'toJSON', {
    enumerable: false,
    value: () => getSafeConfigSummary(configObj)
  });

  return Object.freeze(configObj);
}

/**
 * Return a safe summary of the configuration with secrets redacted.
 */
export function getSafeConfigSummary(cfg) {
  return {
    DISCORD_TOKEN: cfg.DISCORD_TOKEN ? '[REDACTED]' : null,
    DISCORD_CLIENT_ID: cfg.DISCORD_CLIENT_ID,
    DISCORD_GUILD_ID: cfg.DISCORD_GUILD_ID,
    PREFIX: cfg.PREFIX,
    DEFAULT_VOLUME: cfg.DEFAULT_VOLUME,
    MAX_VOLUME: cfg.MAX_VOLUME,
    IDLE_TIMEOUT_MS: cfg.IDLE_TIMEOUT_MS,
    MAX_QUEUE_SIZE: cfg.MAX_QUEUE_SIZE,
    MAX_PLAYLIST_TRACKS: cfg.MAX_PLAYLIST_TRACKS,
    MAX_TRACK_DURATION_SECONDS: cfg.MAX_TRACK_DURATION_SECONDS,
    LOG_LEVEL: cfg.LOG_LEVEL,
    YTDLP_PATH: cfg.YTDLP_PATH,
    FFMPEG_PATH: cfg.FFMPEG_PATH,
    RESOLVE_TIMEOUT_MS: cfg.RESOLVE_TIMEOUT_MS,
    STREAM_SPAWN_TIMEOUT_MS: cfg.STREAM_SPAWN_TIMEOUT_MS,
    PROCESS_KILL_TIMEOUT_MS: cfg.PROCESS_KILL_TIMEOUT_MS,
    VOICE_READY_TIMEOUT_MS: cfg.VOICE_READY_TIMEOUT_MS,
    VOICE_RECONNECT_ATTEMPTS: cfg.VOICE_RECONNECT_ATTEMPTS,
    MAX_CONSECUTIVE_FAILURES: cfg.MAX_CONSECUTIVE_FAILURES,
    PLAYLIST_CONCURRENCY: cfg.PLAYLIST_CONCURRENCY,
    ALLOW_HTTP_MEDIA: cfg.ALLOW_HTTP_MEDIA
  };
}

const isTestEnv =
  process.env.NODE_ENV === 'test' ||
  Boolean(process.env.NODE_TEST_CONTEXT) ||
  process.execArgv.some((arg) => arg.startsWith('--test')) ||
  Boolean(process.argv[1] && /\.test\.m?js$/.test(process.argv[1])) ||
  process.env.OMNI_ALLOW_UNCONFIGURED === 'true';

export const config = loadConfig(process.env, {
  requireCredentials: !isTestEnv,
  loadDotEnv: !isTestEnv
});

export default config;
