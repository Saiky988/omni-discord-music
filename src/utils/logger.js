/**
 * Structured logger with severity filtering and automatic secret/signed-URL redaction.
 */

const LEVEL_PRIORITY = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100
});

const SENSITIVE_KEY_PATTERN = /(token|secret|password|cookie|authorization|auth|credential|api[-_]?key|signature|sig)/i;
const SENSITIVE_QUERY_PARAM_PATTERN = /([?&](?:sig|signature|token|access_token|auth|key|hdnea|expire|policy|cookie|session|X-Amz-Signature|X-Amz-Credential|X-Goog-Signature)=)[^&\s]+/gi;
const DISCORD_TOKEN_PATTERN = /\b[MN][A-Za-z\d]{20,}\.[\w-]{6}\.[\w-]{25,}\b/g;
const BEARER_PATTERN = /(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi;

/**
 * Redact tokens, signed media URL parameters, cookies, and authorization values from strings.
 *
 * @param {string} input
 * @returns {string}
 */
export function redactSensitiveString(input) {
  if (typeof input !== 'string' || input.length === 0) {
    return input;
  }

  return input
    .replace(DISCORD_TOKEN_PATTERN, '[REDACTED_DISCORD_TOKEN]')
    .replace(BEARER_PATTERN, '$1[REDACTED]')
    .replace(SENSITIVE_QUERY_PARAM_PATTERN, '$1[REDACTED]');
}

/**
 * Recursively sanitize metadata objects before logging.
 *
 * @param {unknown} value
 * @param {number} [depth=0]
 * @returns {unknown}
 */
export function sanitizeLogValue(value, depth = 0) {
  if (depth > 5) {
    return '[MaxDepth]';
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return redactSensitiveString(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactSensitiveString(value.message),
      code: value.code || undefined
    };
  }

  if (Array.isArray(value)) {
    return value.slice(0, 25).map((item) => sanitizeLogValue(item, depth + 1));
  }

  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = sanitizeLogValue(v, depth + 1);
      }
    }
    return out;
  }

  return String(value);
}

export class Logger {
  /**
   * @param {object} [options]
   * @param {string} [options.level='info']
   * @param {string} [options.component='app']
   * @param {{ log: Function, warn: Function, error: Function }} [options.sink=console]
   */
  constructor(options = {}) {
    this.level = options.level || process.env.LOG_LEVEL || 'info';
    this.component = options.component || 'omni-music';
    this.sink = options.sink || console;
  }

  setLevel(level) {
    if (LEVEL_PRIORITY[level] !== undefined) {
      this.level = level;
    }
  }

  child(component) {
    return new Logger({
      level: this.level,
      component: `${this.component}:${component}`,
      sink: this.sink
    });
  }

  shouldLog(severity) {
    const configuredPriority = LEVEL_PRIORITY[this.level] ?? LEVEL_PRIORITY.info;
    const messagePriority = LEVEL_PRIORITY[severity] ?? LEVEL_PRIORITY.info;
    return messagePriority >= configuredPriority;
  }

  write(severity, message, meta = undefined) {
    if (!this.shouldLog(severity)) {
      return;
    }

    const record = {
      timestamp: new Date().toISOString(),
      level: severity.toUpperCase(),
      component: this.component,
      message: redactSensitiveString(String(message))
    };

    if (meta !== undefined && meta !== null && Object.keys(meta).length > 0) {
      record.meta = sanitizeLogValue(meta);
    }

    const line = JSON.stringify(record);
    if (severity === 'error') {
      this.sink.error(line);
    } else if (severity === 'warn') {
      this.sink.warn(line);
    } else {
      this.sink.log(line);
    }
  }

  debug(message, meta) {
    this.write('debug', message, meta);
  }

  info(message, meta) {
    this.write('info', message, meta);
  }

  warn(message, meta) {
    this.write('warn', message, meta);
  }

  error(message, meta) {
    this.write('error', message, meta);
  }
}

export const logger = new Logger({
  level: process.env.NODE_ENV === 'test' ? (process.env.LOG_LEVEL || 'silent') : (process.env.LOG_LEVEL || 'info')
});

export default logger;
