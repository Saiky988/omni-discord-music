/**
 * Custom error hierarchy for omni-discord-music.
 * Provides structured error codes, user-safe messages, and diagnostic metadata.
 */

export const ErrorCodes = Object.freeze({
  CONFIG_INVALID: 'ERR_CONFIG_INVALID',
  INVALID_INPUT: 'ERR_INVALID_INPUT',
  UNSAFE_URL: 'ERR_UNSAFE_URL',
  UNSUPPORTED_SOURCE: 'ERR_UNSUPPORTED_SOURCE',
  UNSUPPORTED_MEDIA: 'ERR_UNSUPPORTED_MEDIA',
  RESOLUTION_FAILED: 'ERR_RESOLUTION_FAILED',
  EXTRACTION_FAILED: 'ERR_EXTRACTION_FAILED',
  EXECUTABLE_MISSING: 'ERR_EXECUTABLE_MISSING',
  STREAM_PREMATURE_EOF: 'ERR_STREAM_PREMATURE_EOF',
  STREAM_CANCELLED: 'ERR_STREAM_CANCELLED',
  VOICE_NOT_CONNECTED: 'ERR_VOICE_NOT_CONNECTED',
  VOICE_CHANNEL_MISMATCH: 'ERR_VOICE_CHANNEL_MISMATCH',
  VOICE_PERMISSION_DENIED: 'ERR_VOICE_PERMISSION_DENIED',
  VOICE_RECOVERY_FAILED: 'ERR_VOICE_RECOVERY_FAILED',
  QUEUE_FULL: 'ERR_QUEUE_FULL',
  QUEUE_EMPTY: 'ERR_QUEUE_EMPTY',
  INVALID_STATE: 'ERR_INVALID_STATE',
  VOLUME_OUT_OF_RANGE: 'ERR_VOLUME_OUT_OF_RANGE',
  VOLUME_UNSUPPORTED: 'ERR_VOLUME_UNSUPPORTED',
  SHUTTING_DOWN: 'ERR_SHUTTING_DOWN'
});

export class AppError extends Error {
  /**
   * @param {string} message Internal/developer error message
   * @param {object} [options]
   * @param {string} [options.code] Error code from ErrorCodes
   * @param {string} [options.userMessage] Safe, concise message for Discord embeds
   * @param {Record<string, unknown>} [options.context] Non-sensitive metadata
   * @param {Error} [options.cause] Underlying error cause
   */
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = this.constructor.name;
    this.code = options.code || 'ERR_INTERNAL';
    this.userMessage = options.userMessage || message;
    this.context = options.context ? { ...options.context } : {};
    Error.captureStackTrace?.(this, this.constructor);
  }
}

export class ConfigValidationError extends AppError {
  constructor(message, context = {}) {
    super(message, {
      code: ErrorCodes.CONFIG_INVALID,
      userMessage: 'Bot configuration is invalid.',
      context
    });
  }
}

export class InvalidInputError extends AppError {
  constructor(message, userMessage = message, context = {}) {
    super(message, {
      code: ErrorCodes.INVALID_INPUT,
      userMessage,
      context
    });
  }
}

export class UnsafeUrlError extends AppError {
  constructor(message, userMessage = 'The provided URL was rejected by security policy.', context = {}) {
    super(message, {
      code: ErrorCodes.UNSAFE_URL,
      userMessage,
      context
    });
  }
}

export class UnsupportedSourceError extends AppError {
  constructor(message, userMessage = message, context = {}) {
    super(message, {
      code: ErrorCodes.UNSUPPORTED_SOURCE,
      userMessage,
      context
    });
  }
}

export class UnsupportedMediaError extends AppError {
  constructor(message, userMessage = message, context = {}) {
    super(message, {
      code: ErrorCodes.UNSUPPORTED_MEDIA,
      userMessage,
      context
    });
  }
}

export class ResolutionError extends AppError {
  constructor(message, userMessage = 'Failed to resolve media information from the requested source.', context = {}, cause = undefined) {
    super(message, {
      code: ErrorCodes.RESOLUTION_FAILED,
      userMessage,
      context,
      cause
    });
  }
}

export class StreamExtractionError extends AppError {
  constructor(message, options = {}) {
    super(message, {
      code: options.code || ErrorCodes.EXTRACTION_FAILED,
      userMessage: options.userMessage || 'Failed to extract a playable audio stream for this track.',
      context: options.context || {},
      cause: options.cause
    });
  }
}

export class QueueOperationError extends AppError {
  constructor(message, options = {}) {
    super(message, {
      code: options.code || ErrorCodes.INVALID_STATE,
      userMessage: options.userMessage || message,
      context: options.context || {},
      cause: options.cause
    });
  }
}
