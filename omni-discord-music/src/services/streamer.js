import { spawn as defaultSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import crypto from 'node:crypto';
import config from '../config.js';
import { createAudioResource, StreamType } from '../utils/discordSdk.js';
import { logger as defaultLogger, redactSensitiveString } from '../utils/logger.js';
import {
  ErrorCodes,
  InvalidInputError,
  StreamExtractionError
} from '../utils/errors.js';
import { parseAndValidateUrl } from '../utils/urlSafety.js';

const MAX_STDERR_BYTES = 4096;
const DOCUMENTED_SEARCH_TARGET_PATTERN = /^(ytsearch1|scsearch1):[^\0\r\n]{2,500}$/;

/**
 * Validate the extraction target before passing it to yt-dlp.
 * Prevents arbitrary plain-text strings and command-line option injection.
 *
 * @param {string} targetQueryOrUrl
 * @param {object} [options]
 * @param {boolean} [options.allowHttp=false]
 * @returns {string}
 */
export function validateExtractionTarget(targetQueryOrUrl, options = {}) {
  if (!targetQueryOrUrl || typeof targetQueryOrUrl !== 'string') {
    throw new InvalidInputError(
      'Stream target must be a non-empty string.',
      'Cannot start audio stream without a valid media URL.'
    );
  }

  const trimmed = targetQueryOrUrl.trim();
  if (!trimmed || /[\0\r\n]/.test(trimmed)) {
    throw new InvalidInputError(
      'Stream target contains invalid control characters.',
      'Invalid stream target.'
    );
  }

  // Strictly block option injection (arguments starting with '-')
  if (trimmed.startsWith('-')) {
    throw new InvalidInputError(
      'Stream target cannot begin with a hyphen (-).',
      'Invalid stream target.'
    );
  }

  if (DOCUMENTED_SEARCH_TARGET_PATTERN.test(trimmed)) {
    return trimmed;
  }

  // Must be a validated URL (SSRF and protocol checked)
  const parsed = parseAndValidateUrl(trimmed, {
    allowHttp: Boolean(options.allowHttp ?? config.ALLOW_HTTP_MEDIA)
  });

  return parsed.toString();
}

/**
 * Build the baseline yt-dlp argument array required by Section 5.1.
 *
 * @param {string} validatedTarget
 * @returns {string[]}
 */
export function buildYtdlpArgs(validatedTarget) {
  return [
    '-f', 'bestaudio/best',
    '--no-playlist',
    '--quiet',
    '-o', '-',
    validatedTarget
  ];
}

/**
 * Build the baseline FFmpeg PCM output argument array required by Section 5.1.
 * Produces signed 16-bit little-endian PCM, 48 kHz, stereo.
 *
 * @returns {string[]}
 */
export function buildFfmpegArgs() {
  return [
    '-i', 'pipe:0',
    '-analyzeduration', '0',
    '-loglevel', '0',
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    'pipe:1'
  ];
}

/**
 * Append chunk to a bounded stderr diagnostic buffer while redacting secrets.
 */
function appendBoundedStderr(bufferState, chunk) {
  if (bufferState.bytes >= MAX_STDERR_BYTES) {
    return;
  }
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  const slice = buf.subarray(0, MAX_STDERR_BYTES - bufferState.bytes);
  bufferState.chunks.push(slice);
  bufferState.bytes += slice.length;
}

function formatBoundedStderr(bufferState) {
  if (bufferState.chunks.length === 0) {
    return '';
  }
  const raw = Buffer.concat(bufferState.chunks).toString('utf8').trim();
  return redactSensitiveString(raw);
}

/**
 * Terminate a child process safely with SIGTERM and escalate to SIGKILL only
 * if the process has not exited within killTimeoutMs.
 *
 * @param {import('node:child_process').ChildProcess | null} proc
 * @param {number} killTimeoutMs
 * @returns {Promise<void>}
 */
export function terminateProcessSafely(proc, killTimeoutMs = 2000) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
      resolve();
      return;
    }

    let settled = false;
    let escalationTimer = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (escalationTimer) {
        clearTimeout(escalationTimer);
        escalationTimer = null;
      }
      proc.removeListener?.('close', finish);
      proc.removeListener?.('exit', finish);
      proc.removeListener?.('error', finish);
      resolve();
    };

    proc.once?.('close', finish);
    proc.once?.('exit', finish);
    proc.once?.('error', finish);

    try {
      proc.kill('SIGTERM');
    } catch {
      finish();
      return;
    }

    if (proc.exitCode !== null || proc.signalCode !== null) {
      finish();
      return;
    }

    escalationTimer = setTimeout(() => {
      try {
        if (proc.exitCode === null && proc.signalCode === null) {
          proc.kill('SIGKILL');
        }
      } catch {
        // Ignore kill error
      }
      finish();
    }, killTimeoutMs);
  });
}

/**
 * Create a Discord-compatible PCM audio stream and AudioResource backed by
 * yt-dlp -> ffmpeg child processes with full lifecycle and backpressure management.
 *
 * @param {string} targetQueryOrUrl Validated URL or documented extractor search target
 * @param {object} [options]
 * @param {string} [options.sessionId] Optional caller-provided playback session ID
 * @param {number} [options.volume] Initial volume percentage (0..MAX_VOLUME)
 * @param {object} [options.metadata] Metadata to attach to the AudioResource
 * @param {Function} [options.spawnFn] Injectable child_process.spawn for unit testing
 * @param {Function} [options.createResourceFn] Injectable createAudioResource
 * @param {string} [options.ytdlpPath] Path to yt-dlp binary
 * @param {string} [options.ffmpegPath] Path to ffmpeg binary
 * @param {number} [options.killTimeoutMs] Timeout before escalating SIGTERM to SIGKILL
 * @param {boolean} [options.allowHttp] Allow http: URLs when configured
 * @param {object} [options.logger] Logger instance
 */
export async function createAudioStream(targetQueryOrUrl, options = {}) {
  const validatedTarget = validateExtractionTarget(targetQueryOrUrl, {
    allowHttp: options.allowHttp ?? config.ALLOW_HTTP_MEDIA
  });

  const sessionId = options.sessionId || crypto.randomUUID();
  const spawnFn = options.spawnFn || defaultSpawn;
  const createResourceFn = options.createResourceFn || createAudioResource;
  const ytdlpPath = options.ytdlpPath || config.YTDLP_PATH || 'yt-dlp';
  const ffmpegPath = options.ffmpegPath || config.FFMPEG_PATH || 'ffmpeg';
  const killTimeoutMs = options.killTimeoutMs ?? config.PROCESS_KILL_TIMEOUT_MS ?? 2000;
  const log = (options.logger || defaultLogger).child?.('streamer') || defaultLogger;

  const ytdlpArgs = buildYtdlpArgs(validatedTarget);
  const ffmpegArgs = buildFfmpegArgs();

  const events = new EventEmitter();
  const ytdlpStderr = { chunks: [], bytes: 0 };
  const ffmpegStderr = { chunks: [], bytes: 0 };

  let ytdlpProcess = null;
  let ffmpegProcess = null;
  const pcmStream = new PassThrough({ highWaterMark: 64 * 1024 });

  let status = 'starting'; // 'starting' | 'streaming' | 'completed' | 'cancelled' | 'failed'
  let cancelReason = null;
  let failureError = null;
  let ytdlpBytes = 0;
  let pcmBytes = 0;
  let ytdlpExited = false;
  let ffmpegExited = false;
  let ytdlpExitCode = null;
  let ffmpegExitCode = null;
  let cleanupPromise = null;

  function recordFailure(err) {
    if (status === 'cancelled' || status === 'completed' || status === 'failed') {
      return;
    }
    status = 'failed';
    failureError = err instanceof StreamExtractionError
      ? err
      : new StreamExtractionError(err.message || 'Audio stream pipeline failed.', {
          code: err.code === 'ENOENT' ? ErrorCodes.EXECUTABLE_MISSING : ErrorCodes.EXTRACTION_FAILED,
          userMessage:
            err.code === 'ENOENT'
              ? 'Required audio extractor executable (yt-dlp or ffmpeg) was not found.'
              : 'Audio extraction failed while streaming this track.',
          context: {
            sessionId,
            ytdlpExitCode,
            ffmpegExitCode,
            ytdlpStderr: formatBoundedStderr(ytdlpStderr),
            ffmpegStderr: formatBoundedStderr(ffmpegStderr)
          },
          cause: err
        });

    log.warn('Audio stream session failed', {
      sessionId,
      code: failureError.code,
      message: failureError.message,
      ytdlpExitCode,
      ffmpegExitCode
    });

    if (!pcmStream.destroyed) {
      pcmStream.destroy(failureError);
    }

    events.emit('failed', failureError, { sessionId });
    void cleanup('error');
  }

  function checkNaturalCompletion() {
    if (status === 'cancelled' || status === 'failed' || status === 'completed') {
      return;
    }

    if (ytdlpExited && ffmpegExited) {
      if (ytdlpExitCode === 0 && ffmpegExitCode === 0 && pcmBytes > 0) {
        status = 'completed';
        if (!pcmStream.writableEnded && !pcmStream.destroyed) {
          pcmStream.end();
        }
        events.emit('completed', { sessionId, pcmBytes, ytdlpBytes });
        void cleanup('completed');
      } else if (pcmBytes === 0) {
        recordFailure(
          new StreamExtractionError(
            `Audio pipeline closed prematurely with 0 PCM bytes (yt-dlp=${ytdlpExitCode}, ffmpeg=${ffmpegExitCode}).`,
            {
              code: ErrorCodes.STREAM_PREMATURE_EOF,
              userMessage: 'The media source ended before any audio data could be extracted.',
              context: {
                sessionId,
                ytdlpExitCode,
                ffmpegExitCode,
                ytdlpStderr: formatBoundedStderr(ytdlpStderr),
                ffmpegStderr: formatBoundedStderr(ffmpegStderr)
              }
            }
          )
        );
      } else {
        recordFailure(
          new StreamExtractionError(
            `Extractor exited abnormally (yt-dlp=${ytdlpExitCode}, ffmpeg=${ffmpegExitCode}).`,
            {
              code: ErrorCodes.EXTRACTION_FAILED,
              userMessage: 'Audio stream was interrupted unexpectedly.',
              context: {
                sessionId,
                ytdlpExitCode,
                ffmpegExitCode
              }
            }
          )
        );
      }
    }
  }

  /**
   * Idempotent cleanup of streams, event listeners, and child processes.
   *
   * @param {string} [reason='dispose']
   * @returns {Promise<{ sessionId: string, status: string, reason: string }>}
   */
  function cleanup(reason = 'dispose') {
    if (cleanupPromise) {
      return cleanupPromise;
    }

    if (status === 'starting' || status === 'streaming') {
      if (reason !== 'completed' && reason !== 'error') {
        status = 'cancelled';
        cancelReason = reason;
      }
    }

    cleanupPromise = (async () => {
      try {
        if (ytdlpProcess?.stdout && ffmpegProcess?.stdin) {
          try {
            ytdlpProcess.stdout.unpipe(ffmpegProcess.stdin);
          } catch {
            // Ignore unpipe errors
          }
        }

        if (ytdlpProcess?.stdout && !ytdlpProcess.stdout.destroyed) {
          ytdlpProcess.stdout.destroy();
        }
        if (ffmpegProcess?.stdin && !ffmpegProcess.stdin.destroyed) {
          ffmpegProcess.stdin.destroy();
        }
        if (ffmpegProcess?.stdout && !ffmpegProcess.stdout.destroyed) {
          ffmpegProcess.stdout.destroy();
        }
        if (!pcmStream.destroyed) {
          pcmStream.destroy();
        }

        await Promise.all([
          terminateProcessSafely(ytdlpProcess, killTimeoutMs),
          terminateProcessSafely(ffmpegProcess, killTimeoutMs)
        ]);
      } finally {
        events.emit('disposed', { sessionId, status, reason });
      }

      return { sessionId, status, reason };
    })();

    return cleanupPromise;
  }

  // 1. Spawn yt-dlp
  try {
    ytdlpProcess = spawnFn(ytdlpPath, ytdlpArgs, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
  } catch (err) {
    throw new StreamExtractionError(`Failed to spawn yt-dlp (${ytdlpPath}): ${err.message}`, {
      code: err.code === 'ENOENT' ? ErrorCodes.EXECUTABLE_MISSING : ErrorCodes.EXTRACTION_FAILED,
      userMessage: 'Could not start the yt-dlp audio extractor process.',
      context: { sessionId, executable: 'yt-dlp', errorCode: err.code },
      cause: err
    });
  }

  // 2. Spawn ffmpeg
  try {
    ffmpegProcess = spawnFn(ffmpegPath, ffmpegArgs, {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
  } catch (err) {
    await terminateProcessSafely(ytdlpProcess, killTimeoutMs);
    throw new StreamExtractionError(`Failed to spawn ffmpeg (${ffmpegPath}): ${err.message}`, {
      code: err.code === 'ENOENT' ? ErrorCodes.EXECUTABLE_MISSING : ErrorCodes.EXTRACTION_FAILED,
      userMessage: 'Could not start the FFmpeg audio transcoder process.',
      context: { sessionId, executable: 'ffmpeg', errorCode: err.code },
      cause: err
    });
  }

  // 3. Attach stderr listeners
  ytdlpProcess.stderr?.on('data', (chunk) => appendBoundedStderr(ytdlpStderr, chunk));
  ffmpegProcess.stderr?.on('data', (chunk) => appendBoundedStderr(ffmpegStderr, chunk));

  // 4. Attach process error listeners (e.g. async ENOENT)
  let immediateSpawnError = null;

  ytdlpProcess.on('error', (err) => {
    const wrapped = new StreamExtractionError(
      `yt-dlp process error (${err.code || 'UNKNOWN'}): ${err.message}`,
      {
        code: err.code === 'ENOENT' ? ErrorCodes.EXECUTABLE_MISSING : ErrorCodes.EXTRACTION_FAILED,
        userMessage:
          err.code === 'ENOENT'
            ? 'The yt-dlp binary is missing or not executable.'
            : 'Audio extractor process encountered an error.',
        context: { sessionId, executable: 'yt-dlp', errorCode: err.code },
        cause: err
      }
    );
    immediateSpawnError = immediateSpawnError || wrapped;
    recordFailure(wrapped);
  });

  ffmpegProcess.on('error', (err) => {
    const wrapped = new StreamExtractionError(
      `ffmpeg process error (${err.code || 'UNKNOWN'}): ${err.message}`,
      {
        code: err.code === 'ENOENT' ? ErrorCodes.EXECUTABLE_MISSING : ErrorCodes.EXTRACTION_FAILED,
        userMessage:
          err.code === 'ENOENT'
            ? 'The ffmpeg binary is missing or not executable.'
            : 'FFmpeg audio converter encountered an error.',
        context: { sessionId, executable: 'ffmpeg', errorCode: err.code },
        cause: err
      }
    );
    immediateSpawnError = immediateSpawnError || wrapped;
    recordFailure(wrapped);
  });

  // 5. Wire yt-dlp.stdout -> ffmpeg.stdin with backpressure & broken pipe handling
  if (ytdlpProcess.stdout && ffmpegProcess.stdin) {
    ytdlpProcess.stdout.on('data', (chunk) => {
      ytdlpBytes += chunk.length;
    });

    ytdlpProcess.stdout.on('error', (err) => {
      if (status === 'cancelled') return;
      recordFailure(
        new StreamExtractionError(`yt-dlp stdout stream error: ${err.message}`, {
          code: ErrorCodes.EXTRACTION_FAILED,
          context: { sessionId, errorCode: err.code },
          cause: err
        })
      );
    });

    ffmpegProcess.stdin.on('error', (err) => {
      if (status === 'cancelled' || status === 'completed') {
        return;
      }
      recordFailure(
        new StreamExtractionError(
          `FFmpeg stdin pipe error (${err.code || 'EPIPE'}): ${err.message}`,
          {
            code: ErrorCodes.EXTRACTION_FAILED,
            userMessage: 'Audio transcoding pipe broke unexpectedly.',
            context: { sessionId, errorCode: err.code },
            cause: err
          }
        )
      );
    });

    ytdlpProcess.stdout.pipe(ffmpegProcess.stdin);
  }

  // 6. Wire ffmpeg.stdout -> pcmStream with backpressure
  if (ffmpegProcess.stdout) {
    ffmpegProcess.stdout.on('data', (chunk) => {
      pcmBytes += chunk.length;
      if (status === 'starting') {
        status = 'streaming';
        events.emit('streaming', { sessionId, firstChunkBytes: chunk.length });
      }
    });

    ffmpegProcess.stdout.on('error', (err) => {
      if (status === 'cancelled') return;
      recordFailure(
        new StreamExtractionError(`FFmpeg stdout stream error: ${err.message}`, {
          code: ErrorCodes.EXTRACTION_FAILED,
          context: { sessionId, errorCode: err.code },
          cause: err
        })
      );
    });

    ffmpegProcess.stdout.pipe(pcmStream, { end: false });
  }

  pcmStream.on('error', () => {
    // Prevent unhandled error event on PassThrough stream when destroyed with an error
  });

  // 7. Handle process exit / close lifecycle
  ytdlpProcess.once('close', (code, signal) => {
    ytdlpExited = true;
    ytdlpExitCode = code ?? (signal ? -1 : 0);

    if (ffmpegProcess?.stdin && !ffmpegProcess.stdin.destroyed) {
      try {
        ffmpegProcess.stdin.end();
      } catch {
        // Ignore end error
      }
    }

    if (status === 'cancelled') {
      return;
    }

    if (ytdlpExitCode !== 0) {
      recordFailure(
        new StreamExtractionError(
          `yt-dlp exited with code ${ytdlpExitCode}: ${formatBoundedStderr(ytdlpStderr) || 'no stderr'}`,
          {
            code: ErrorCodes.EXTRACTION_FAILED,
            userMessage: 'Failed to download audio stream from source.',
            context: {
              sessionId,
              ytdlpExitCode,
              ytdlpStderr: formatBoundedStderr(ytdlpStderr)
            }
          }
        )
      );
      return;
    }

    checkNaturalCompletion();
  });

  ffmpegProcess.once('close', (code, signal) => {
    ffmpegExited = true;
    ffmpegExitCode = code ?? (signal ? -1 : 0);

    if (status === 'cancelled') {
      return;
    }

    if (ffmpegExitCode !== 0) {
      recordFailure(
        new StreamExtractionError(
          `ffmpeg exited with code ${ffmpegExitCode}: ${formatBoundedStderr(ffmpegStderr) || 'no stderr'}`,
          {
            code: ErrorCodes.EXTRACTION_FAILED,
            userMessage: 'FFmpeg failed to transcode the audio stream.',
            context: {
              sessionId,
              ffmpegExitCode,
              ffmpegStderr: formatBoundedStderr(ffmpegStderr)
            }
          }
        )
      );
      return;
    }

    if (ytdlpExited) {
      checkNaturalCompletion();
    } else if (pcmBytes === 0) {
      recordFailure(
        new StreamExtractionError('FFmpeg closed before receiving audio data.', {
          code: ErrorCodes.STREAM_PREMATURE_EOF,
          userMessage: 'Audio stream closed prematurely before playback could begin.',
          context: { sessionId }
        })
      );
    } else {
      status = 'completed';
      if (!pcmStream.writableEnded && !pcmStream.destroyed) {
        pcmStream.end();
      }
      events.emit('completed', { sessionId, pcmBytes, ytdlpBytes });
      void cleanup('completed');
    }
  });

  // Yield a microtask/immediate tick so synchronous/immediate ENOENT spawn errors surface right away
  await new Promise((resolve) => setImmediate(resolve));
  if (immediateSpawnError) {
    throw immediateSpawnError;
  }

  // 8. Construct the @discordjs/voice AudioResource with StreamType.Raw and inlineVolume
  const resource = createResourceFn(pcmStream, {
    inputType: StreamType.Raw,
    inlineVolume: true,
    metadata: {
      sessionId,
      ...(options.metadata || {})
    }
  });

  if (options.volume !== undefined && resource?.volume) {
    const normalizedVol = Math.max(0, Number(options.volume)) / 100;
    if (typeof resource.volume.setVolumeLogarithmic === 'function') {
      resource.volume.setVolumeLogarithmic(normalizedVol);
    } else if (typeof resource.volume.setVolume === 'function') {
      resource.volume.setVolume(normalizedVol);
    }
  }

  return {
    sessionId,
    resource,
    stream: pcmStream,
    ytdlpProcess,
    ffmpegProcess,
    events,
    cleanup,
    dispose: cleanup,
    getState() {
      return {
        sessionId,
        status,
        cancelReason,
        failureError,
        ytdlpBytes,
        pcmBytes,
        ytdlpExitCode,
        ffmpegExitCode,
        ytdlpStderr: formatBoundedStderr(ytdlpStderr),
        ffmpegStderr: formatBoundedStderr(ffmpegStderr)
      };
    }
  };
}

export default {
  createAudioStream,
  validateExtractionTarget,
  buildYtdlpArgs,
  buildFfmpegArgs,
  terminateProcessSafely
};
