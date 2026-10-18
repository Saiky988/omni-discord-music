import dns from 'node:dns';
dns.setDefaultResultOrder?.('ipv4first');
import { spawn as defaultSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import config from '../config.js';
import { createAudioResource, StreamType } from '../utils/discordSdk.js';
import { logger as defaultLogger, redactSensitiveString } from '../utils/logger.js';
import {
  ErrorCodes,
  InvalidInputError,
  StreamExtractionError
} from '../utils/errors.js';
import { parseAndValidateUrl, assertPublicDnsResolution } from '../utils/urlSafety.js';

const MAX_STDERR_BYTES = 4096;
const MAX_TEMP_MEDIA_BYTES = 100 * 1024 * 1024; // 100 MB cap for temp media spooling
const MIN_SUBSTANTIAL_PCM_BYTES = 48000 * 2 * 2 * 5; // 5 seconds of 48kHz stereo s16le PCM
const DOCUMENTED_SEARCH_TARGET_PATTERN = /^(ytsearch1|scsearch1):[^\0\r\n]{2,500}$/;

export const BASSBOOST_PRESETS = Object.freeze({
  off: null,
  low: 'bass=g=5:f=100:w=0.6',
  medium: 'bass=g=9:f=100:w=0.6,equalizer=f=65:t=q:w=1.2:g=4',
  high: 'bass=g=13:f=100:w=0.6,equalizer=f=60:t=q:w=1.2:g=6',
  extreme: 'bass=g=18:f=105:w=0.6,equalizer=f=60:t=q:w=1.1:g=8'
});

/**
 * Build the FFmpeg audio filter chain (-af) combining:
 * 1. High-precision 32-tap Sinc resampler to 48kHz
 * 2. Optional Bassboost (low / medium / high / extreme)
 * 3. Optional Nightcore (1.25x pitch + tempo via asetrate + aresample)
 * 4. Optional Speed multiplier (0.5x .. 2.0x via atempo)
 * 5. Floating-point pre-gain + brickwall lookahead limiter (alimiter) to prevent clipping/distortion
 *
 * @param {object} [filters]
 * @param {string} [filters.bassboost='off']
 * @param {boolean} [filters.nightcore=false]
 * @param {number} [filters.speed=1.0]
 * @returns {string}
 */
export function buildAudioFilterChain(filters = {}) {
  const chain = [
    'aresample=48000:resampler=swr:filter_size=32:phase_shift=10:linear_interp=1'
  ];

  const bassLevel = String(filters?.bassboost || 'off').toLowerCase();
  const bassFilter = BASSBOOST_PRESETS[bassLevel];
  if (bassFilter) {
    chain.push(bassFilter);
  }

  const nightcore = Boolean(filters?.nightcore);
  if (nightcore) {
    // 1.25x pitch + tempo shift, then resample back to exact 48000 Hz for Discord
    chain.push('asetrate=48000*1.25,aresample=48000:resampler=swr');
  }

  const rawSpeed = Number(filters?.speed ?? 1.0);
  if (Number.isFinite(rawSpeed) && Math.abs(rawSpeed - 1.0) >= 0.01) {
    const clampedSpeed = Math.min(2.0, Math.max(0.5, Number(rawSpeed.toFixed(2))));
    chain.push(`atempo=${clampedSpeed}`);
  }

  // Slightly reduce pre-gain when heavy bassboost is active so the limiter stays clean and punchy
  const preGain =
    bassLevel === 'extreme'
      ? '1.15'
      : bassLevel === 'high'
        ? '1.25'
        : '1.5';

  chain.push(`volume=${preGain}`);
  chain.push('alimiter=limit=0.95:level=disabled:attack=5:release=50');

  return chain.join(',');
}

export const HIGH_QUALITY_AUDIO_FILTER = buildAudioFilterChain();

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

  if (trimmed.startsWith('-')) {
    throw new InvalidInputError(
      'Stream target cannot begin with a hyphen (-).',
      'Invalid stream target.'
    );
  }

  if (DOCUMENTED_SEARCH_TARGET_PATTERN.test(trimmed)) {
    return trimmed;
  }

  const parsed = parseAndValidateUrl(trimmed, {
    allowHttp: Boolean(options.allowHttp ?? config.ALLOW_HTTP_MEDIA)
  });

  return parsed.toString();
}

/**
 * Build the yt-dlp argument array using universal format fallback ('bestaudio/best'),
 * Node.js EJS runtime ('--js-runtimes node'), and multi-client resilience.
 *
 * @param {string} validatedTarget
 * @returns {string[]}
 */
export function buildYtdlpArgs(validatedTarget) {
  const args = [
    '-f', 'bestaudio/best',
    '--no-playlist',
    '--quiet',
    '--no-warnings',
    '--no-check-certificates',
    '--geo-bypass',
    '--force-ipv4',
    '--js-runtimes', 'node',
    '--extractor-args', 'youtube:player_client=default,android_vr,tv,web_safari,mweb'
  ];

  const envCookiePath = process.env.YTDLP_COOKIES_PATH?.trim();
  const defaultCookiePath = path.resolve(process.cwd(), 'cookies.txt');
  if (envCookiePath && fs.existsSync(envCookiePath)) {
    args.push('--cookies', envCookiePath);
  } else if (fs.existsSync(defaultCookiePath)) {
    args.push('--cookies', defaultCookiePath);
  }

  args.push('-o', '-', validatedTarget);
  return args;
}

/**
 * Build the FFmpeg PCM output argument array with high-precision resampling,
 * optional DSP audio filters (bassboost, nightcore, speed), optional seek position,
 * and brickwall anti-clipping limiter.
 *
 * @param {string | null} [directInputUrl=null]
 * @param {object} [options]
 * @param {object} [options.filters]
 * @param {number} [options.seekSeconds=0]
 * @param {boolean} [options.isContainerPipe=false]
 * @param {boolean} [options.isLocalFile=false]
 * @returns {string[]}
 */
export function buildFfmpegArgs(directInputUrl = null, options = {}) {
  const filterChain = buildAudioFilterChain(options.filters);
  const seekSeconds =
    Number.isFinite(options.seekSeconds) && options.seekSeconds > 0
      ? Math.floor(options.seekSeconds)
      : 0;

  if (directInputUrl) {
    if (options.isLocalFile) {
      const args = [];
      if (seekSeconds > 0) {
        args.push('-ss', String(seekSeconds));
      }
      args.push(
        '-i', directInputUrl,
        '-vn',
        '-sn',
        '-dn',
        '-loglevel', '0',
        '-af', filterChain,
        '-f', 's16le',
        '-ar', '48000',
        '-ac', '2',
        'pipe:1'
      );
      return args;
    }

    const args = [
      '-user_agent',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5'
    ];
    if (seekSeconds > 0) {
      args.push('-ss', String(seekSeconds));
    }
    args.push(
      '-i', directInputUrl,
      '-vn',
      '-analyzeduration', '0',
      '-probesize', '32768',
      '-loglevel', '0',
      '-af', filterChain,
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
      'pipe:1'
    );
    return args;
  }

  const args = ['-i', 'pipe:0'];
  if (!options.isContainerPipe) {
    args.push(
      '-analyzeduration', '0',
      '-probesize', '32768'
    );
  }
  args.push('-loglevel', '0');

  if (seekSeconds > 0) {
    args.push('-ss', String(seekSeconds));
  }

  args.push(
    '-vn',
    '-af', filterChain,
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    'pipe:1'
  );

  return args;
}

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

function isTikTokOrDouyinWebpage(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return false;
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();
    return (
      host.endsWith('tiktok.com') ||
      host.endsWith('douyin.com') ||
      host.endsWith('iesdouyin.com')
    );
  } catch {
    return false;
  }
}

/**
 * Query TikWM API with automatic retry on 1-req/sec free rate limit (code === -1).
 */
async function fetchTikwmStreamUrls(webpageUrl, allowHttp = false) {
  if (typeof globalThis.fetch !== 'function' || !webpageUrl) {
    return [];
  }

  const browserHeaders = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Referer: 'https://www.tikwm.com/',
    Accept: 'application/json'
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 1150 * attempt));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    timer.unref?.();

    try {
      const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(webpageUrl)}`;
      const apiRes = await globalThis.fetch(apiUrl, {
        headers: browserHeaders,
        signal: controller.signal
      });
      clearTimeout(timer);

      if (!apiRes.ok) {
        continue;
      }

      const payload = await apiRes.json();
      if (payload?.code === -1) {
        // Free API rate limit (1 req/sec) — wait and retry
        continue;
      }

      const data = payload?.data;
      if (!data) {
        break;
      }

      const out = [];
      for (const rawUrl of [data.play, data.wmplay, data.music_info?.play, data.music]) {
        if (rawUrl && typeof rawUrl === 'string') {
          try {
            const resolved = new URL(rawUrl, 'https://www.tikwm.com').toString();
            const validated = parseAndValidateUrl(resolved, { allowHttp }).toString();
            if (!out.includes(validated)) {
              out.push(validated);
            }
          } catch {
            // Ignore malformed candidate
          }
        }
      }
      if (out.length > 0) {
        return out;
      }
    } catch {
      clearTimeout(timer);
    }
  }

  return [];
}

/**
 * Fallback extractor for Douyin / iesdouyin mobile share pages when TikWM is unavailable.
 */
async function fetchDouyinMobileStreamUrls(webpageUrl, allowHttp = false) {
  if (typeof globalThis.fetch !== 'function' || !webpageUrl) {
    return [];
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  timer.unref?.();

  try {
    const res = await globalThis.fetch(webpageUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
        Accept: 'text/html,application/xhtml+xml'
      },
      redirect: 'follow',
      signal: controller.signal
    });
    clearTimeout(timer);

    if (!res.ok) return [];
    const html = await res.text();
    const routerMatch = html.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
    if (!routerMatch?.[1]) return [];

    const routerData = JSON.parse(routerMatch[1]);
    const loaderData = routerData?.loaderData || {};
    const pageObj = Object.values(loaderData).find((v) => v?.videoInfoRes?.item_list?.[0]);
    const item = pageObj?.videoInfoRes?.item_list?.[0];
    const playUrls = item?.video?.play_addr?.url_list || [];
    const out = [];

    for (const raw of playUrls) {
      if (raw && typeof raw === 'string') {
        try {
          const clean = raw.replace('playwm', 'play');
          const validated = parseAndValidateUrl(clean, { allowHttp }).toString();
          if (!out.includes(validated)) {
            out.push(validated);
          }
        } catch {
          // Ignore invalid URL
        }
      }
    }
    return out;
  } catch {
    clearTimeout(timer);
    return [];
  }
}

/**
 * Download a TikTok, Douyin, Discord CDN, or direct media file to a temporary seekable file
 * in os.tmpdir(). Having FFmpeg read from a seekable local file instead of pipe:0:
 * 1) Prevents FFmpeg from failing with "moov atom not found" on non-faststart .mp4/.mov files
 *    (such as SnapVideo/mobile uploads on Discord CDN).
 * 2) Prevents TikTok/Discord CDNs from dropping idle/backpressured HTTP connections mid-song or on loop.
 */
async function downloadMediaToTempFile({
  webpageUrl,
  targetUrl,
  sessionId,
  allowHttp = false
}) {
  if (typeof globalThis.fetch !== 'function') {
    return null;
  }

  const candidates = [];

  // 1. If targetUrl is ALREADY a direct stream/CDN link (not a TikTok/Douyin post webpage),
  // try it first so we don't trigger a redundant TikWM API call right after resolver.js!
  if (targetUrl && !isTikTokOrDouyinWebpage(targetUrl)) {
    candidates.push(targetUrl);
  }

  // 2. Gather TikWM / Douyin fresh candidates on demand
  const pageUrl = isTikTokOrDouyinWebpage(webpageUrl)
    ? webpageUrl
    : isTikTokOrDouyinWebpage(targetUrl)
      ? targetUrl
      : null;

  const loadPageCandidates = async () => {
    if (!pageUrl) return [];
    const fresh = await fetchTikwmStreamUrls(pageUrl, allowHttp);
    if (fresh.length > 0) return fresh;
    if (pageUrl.includes('douyin.com') || pageUrl.includes('iesdouyin.com')) {
      return fetchDouyinMobileStreamUrls(pageUrl, allowHttp);
    }
    return [];
  };

  if (candidates.length === 0 && pageUrl) {
    const fresh = await loadPageCandidates();
    candidates.push(...fresh);
  }

  const attemptDownload = async (candidateUrl) => {
    const parsed = parseAndValidateUrl(candidateUrl, { allowHttp });
    await assertPublicDnsResolution(parsed.hostname);

    const isDouyin = candidateUrl.includes('snssdk.com') || candidateUrl.includes('douyin');
    const headers = {
      'User-Agent': isDouyin
        ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
        : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: '*/*'
    };
    if (candidateUrl.includes('tikwm.com') || candidateUrl.includes('tiktok')) {
      headers.Referer = 'https://www.tikwm.com/';
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    timeout.unref?.();

    const tempFilePath = path.join(os.tmpdir(), `omni-music-${sessionId}-${crypto.randomBytes(4).toString('hex')}.media`);

    try {
      const res = await globalThis.fetch(candidateUrl, {
        headers,
        redirect: 'follow',
        signal: controller.signal
      });

      const contentType = (res.headers?.get?.('content-type') || '').toLowerCase();
      if (!res.ok || !res.body || contentType.includes('text/html') || contentType.includes('application/json')) {
        clearTimeout(timeout);
        controller.abort();
        return null;
      }

      const contentLength = Number.parseInt(res.headers?.get?.('content-length') || '0', 10);
      if (Number.isFinite(contentLength) && contentLength > MAX_TEMP_MEDIA_BYTES) {
        clearTimeout(timeout);
        controller.abort();
        return null;
      }

      const nodeReadable = Readable.fromWeb(res.body);
      let writtenBytes = 0;
      nodeReadable.on('data', (chunk) => {
        writtenBytes += chunk.length;
        if (writtenBytes > MAX_TEMP_MEDIA_BYTES) {
          controller.abort();
        }
      });

      const fileWriteStream = fs.createWriteStream(tempFilePath, { mode: 0o600 });
      await pipeline(nodeReadable, fileWriteStream);
      clearTimeout(timeout);

      if (writtenBytes < 256) {
        await fs.promises.unlink(tempFilePath).catch(() => {});
        return null;
      }

      return { tempFilePath, bytes: writtenBytes };
    } catch {
      clearTimeout(timeout);
      controller.abort();
      await fs.promises.unlink(tempFilePath).catch(() => {});
      return null;
    }
  };

  for (const candidateUrl of candidates) {
    const downloaded = await attemptDownload(candidateUrl);
    if (downloaded) {
      return downloaded;
    }
  }

  // If the cached direct stream URL expired (e.g. when looping a TikTok/Douyin track minutes later),
  // fetch fresh signed stream URLs from the original post webpageUrl now!
  if (pageUrl && candidates.length > 0 && !candidates.includes(pageUrl)) {
    const refreshed = await loadPageCandidates();
    for (const candidateUrl of refreshed) {
      if (candidates.includes(candidateUrl)) continue;
      const downloaded = await attemptDownload(candidateUrl);
      if (downloaded) {
        return downloaded;
      }
    }
  }

  return null;
}

export async function createAudioStream(targetQueryOrUrl, options = {}) {
  const allowHttp = Boolean(options.allowHttp ?? config.ALLOW_HTTP_MEDIA);
  const validatedTarget = validateExtractionTarget(targetQueryOrUrl, { allowHttp });

  const sessionId = options.sessionId || crypto.randomUUID();
  const spawnFn = options.spawnFn || defaultSpawn;
  const createResourceFn = options.createResourceFn || createAudioResource;
  const ytdlpPath = options.ytdlpPath || config.YTDLP_PATH || 'yt-dlp';
  const ffmpegPath = options.ffmpegPath || config.FFMPEG_PATH || 'ffmpeg';
  const killTimeoutMs = options.killTimeoutMs ?? config.PROCESS_KILL_TIMEOUT_MS ?? 2000;
  const directFfmpeg = Boolean(options.directFfmpeg);
  const log = (options.logger || defaultLogger).child?.('streamer') || defaultLogger;

  const isLiveStream = Boolean(options.isLive) || validatedTarget.toLowerCase().includes('.m3u8');

  // For live production runs on TikTok, Douyin, Discord CDN, or direct media files,
  // download to a seekable temp file in os.tmpdir() so MP4 containers with trailing moov atoms
  // decode reliably and CDNs never drop throttled HTTP connections mid-song or on loop.
  const shouldDownloadToTempFile =
    spawnFn === defaultSpawn &&
    !isLiveStream &&
    (directFfmpeg ||
      options.source === 'tiktok' ||
      options.source === 'douyin' ||
      options.source === 'direct_media' ||
      validatedTarget.includes('tiktok.com') ||
      validatedTarget.includes('douyin.com') ||
      validatedTarget.includes('iesdouyin.com') ||
      validatedTarget.includes('tikwm.com') ||
      validatedTarget.includes('tiktokcdn.com') ||
      validatedTarget.includes('cdn.discordapp.com') ||
      validatedTarget.includes('media.discordapp.net'));

  let tempMediaFile = null;
  let downloadedBytes = 0;

  if (shouldDownloadToTempFile) {
    const downloadResult = await downloadMediaToTempFile({
      webpageUrl: options.webpageUrl || null,
      targetUrl: validatedTarget,
      sessionId,
      allowHttp
    });
    if (downloadResult?.tempFilePath) {
      tempMediaFile = downloadResult.tempFilePath;
      downloadedBytes = downloadResult.bytes || 0;
    }
  }

  const useLocalTempFile = Boolean(tempMediaFile);
  const effectiveDirectFfmpeg = directFfmpeg || useLocalTempFile;

  // If TikTok/Douyin temp download failed and we must fall back to yt-dlp, always pass the post webpageUrl
  // rather than an expired TikWM/CDN direct link.
  const ytdlpTarget =
    !effectiveDirectFfmpeg &&
    options.webpageUrl &&
    isTikTokOrDouyinWebpage(options.webpageUrl) &&
    !isTikTokOrDouyinWebpage(validatedTarget)
      ? validateExtractionTarget(options.webpageUrl, { allowHttp })
      : validatedTarget;

  const ytdlpArgs = effectiveDirectFfmpeg ? [] : buildYtdlpArgs(ytdlpTarget);

  const ffmpegInputTarget = useLocalTempFile
    ? tempMediaFile
    : effectiveDirectFfmpeg
      ? validatedTarget
      : null;

  const isProductionRealSpawn = spawnFn === defaultSpawn;
  const ffmpegArgs =
    options.filters || options.seekSeconds || useLocalTempFile || isProductionRealSpawn
      ? buildFfmpegArgs(ffmpegInputTarget, {
          filters: options.filters,
          seekSeconds: options.seekSeconds,
          isLocalFile: useLocalTempFile,
          isContainerPipe: !effectiveDirectFfmpeg && isProductionRealSpawn
        })
      : buildFfmpegArgs(ffmpegInputTarget);

  const events = new EventEmitter();
  const ytdlpStderr = { chunks: [], bytes: 0 };
  const ffmpegStderr = { chunks: [], bytes: 0 };

  let ytdlpProcess = null;
  let ffmpegProcess = null;
  // 1 MB buffer (~5.5s of 48kHz stereo PCM) prevents micro-stalls on yt-dlp/ffmpeg pipes
  const pcmStream = new PassThrough({ highWaterMark: 1024 * 1024 });

  let status = 'starting';
  let cancelReason = null;
  let failureError = null;
  let ytdlpBytes = downloadedBytes;
  let pcmBytes = 0;
  let ytdlpExited = effectiveDirectFfmpeg;
  let ffmpegExited = false;
  let ytdlpExitCode = effectiveDirectFfmpeg ? 0 : null;
  let ffmpegExitCode = null;
  let cleanupPromise = null;

  async function removeTempMediaFile() {
    if (!tempMediaFile) return;
    const fileToDelete = tempMediaFile;
    tempMediaFile = null;
    await fs.promises.unlink(fileToDelete).catch(() => {});
  }

  function completeSessionNaturally() {
    if (status === 'cancelled' || status === 'failed' || status === 'completed') {
      return;
    }
    status = 'completed';
    if (!pcmStream.writableEnded && !pcmStream.destroyed) {
      pcmStream.end();
    }
    events.emit('completed', { sessionId, pcmBytes, ytdlpBytes });
    void cleanup('completed');
  }

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
      if (ffmpegExitCode === 0 && pcmBytes > 0 && (ytdlpExitCode === 0 || pcmBytes >= MIN_SUBSTANTIAL_PCM_BYTES)) {
        completeSessionNaturally();
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

        // CRITICAL FIX: When reason === 'completed', do NOT destroy pcmStream while
        // @discordjs/voice's AudioPlayer is still reading the buffered tail audio!
        // Destroying pcmStream before it emits 'end' causes @discordjs/voice to throw
        // AudioPlayerError ("Premature close") right at the end of a track or loop!
        if (reason === 'completed') {
          if (pcmStream.readableEnded || pcmStream.destroyed) {
            if (!pcmStream.destroyed) pcmStream.destroy();
          } else {
            const drainTimer = setTimeout(() => {
              if (!pcmStream.destroyed) {
                pcmStream.destroy();
              }
            }, 15000);
            drainTimer.unref?.();
            pcmStream.once('end', () => clearTimeout(drainTimer));
            pcmStream.once('close', () => clearTimeout(drainTimer));
          }
        } else if (!pcmStream.destroyed) {
          pcmStream.destroy();
        }

        await Promise.all([
          terminateProcessSafely(ytdlpProcess, killTimeoutMs),
          terminateProcessSafely(ffmpegProcess, killTimeoutMs),
          removeTempMediaFile()
        ]);
      } finally {
        events.emit('disposed', { sessionId, status, reason });
      }

      return { sessionId, status, reason };
    })();

    return cleanupPromise;
  }

  if (!effectiveDirectFfmpeg) {
    try {
      ytdlpProcess = spawnFn(ytdlpPath, ytdlpArgs, {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (err) {
      await removeTempMediaFile();
      throw new StreamExtractionError(`Failed to spawn yt-dlp (${ytdlpPath}): ${err.message}`, {
        code: err.code === 'ENOENT' ? ErrorCodes.EXECUTABLE_MISSING : ErrorCodes.EXTRACTION_FAILED,
        userMessage: 'Could not start the yt-dlp audio extractor process.',
        context: { sessionId, executable: 'yt-dlp', errorCode: err.code },
        cause: err
      });
    }
  }

  try {
    ffmpegProcess = spawnFn(ffmpegPath, ffmpegArgs, {
      shell: false,
      stdio: [effectiveDirectFfmpeg ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
  } catch (err) {
    await Promise.all([
      terminateProcessSafely(ytdlpProcess, killTimeoutMs),
      removeTempMediaFile()
    ]);
    throw new StreamExtractionError(`Failed to spawn ffmpeg (${ffmpegPath}): ${err.message}`, {
      code: err.code === 'ENOENT' ? ErrorCodes.EXECUTABLE_MISSING : ErrorCodes.EXTRACTION_FAILED,
      userMessage: 'Could not start the FFmpeg audio transcoder process.',
      context: { sessionId, executable: 'ffmpeg', errorCode: err.code },
      cause: err
    });
  }

  ytdlpProcess?.stderr?.on('data', (chunk) => appendBoundedStderr(ytdlpStderr, chunk));
  ffmpegProcess.stderr?.on('data', (chunk) => appendBoundedStderr(ffmpegStderr, chunk));

  let immediateSpawnError = null;

  ytdlpProcess?.on('error', (err) => {
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

  if (ytdlpProcess?.stdout && ffmpegProcess.stdin) {
    ytdlpProcess.stdout.on('data', (chunk) => {
      ytdlpBytes += chunk.length;
    });

    ytdlpProcess.stdout.on('error', (err) => {
      if (status === 'cancelled' || status === 'completed' || pcmBytes >= MIN_SUBSTANTIAL_PCM_BYTES) {
        return;
      }
      recordFailure(
        new StreamExtractionError(`yt-dlp stdout stream error: ${err.message}`, {
          code: ErrorCodes.EXTRACTION_FAILED,
          context: { sessionId, errorCode: err.code },
          cause: err
        })
      );
    });

    ffmpegProcess.stdin.on('error', (err) => {
      if (status === 'cancelled' || status === 'completed' || pcmBytes >= MIN_SUBSTANTIAL_PCM_BYTES) {
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

  if (ffmpegProcess.stdout) {
    ffmpegProcess.stdout.on('data', (chunk) => {
      pcmBytes += chunk.length;
      if (status === 'starting') {
        status = 'streaming';
        events.emit('streaming', { sessionId, firstChunkBytes: chunk.length });
      }
    });

    ffmpegProcess.stdout.on('error', (err) => {
      if (status === 'cancelled' || status === 'completed') return;
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

  pcmStream.on('error', () => {});

  ytdlpProcess?.once('close', (code, signal) => {
    ytdlpExited = true;
    ytdlpExitCode = code ?? (signal ? -1 : 0);

    if (ffmpegProcess?.stdin && !ffmpegProcess.stdin.destroyed) {
      try {
        ffmpegProcess.stdin.end();
      } catch {
        // Ignore end error
      }
    }

    if (status === 'cancelled' || status === 'completed') {
      return;
    }

    if (ytdlpExitCode !== 0) {
      // If substantial audio was already decoded (e.g. >5s) and yt-dlp only hit a tail/EOF broken pipe,
      // let FFmpeg finish draining its remaining buffer rather than failing the track at the end!
      if (pcmBytes >= MIN_SUBSTANTIAL_PCM_BYTES) {
        ytdlpExitCode = 0;
        checkNaturalCompletion();
        return;
      }

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

    if (status === 'cancelled' || status === 'completed') {
      return;
    }

    if (ffmpegExitCode !== 0) {
      // If FFmpeg already transcoded substantial audio and exited on a trailing container warning,
      // treat as natural completion so end-of-track and Loop never break.
      if (pcmBytes >= MIN_SUBSTANTIAL_PCM_BYTES * 2) {
        ffmpegExitCode = 0;
        completeSessionNaturally();
        return;
      }

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
      completeSessionNaturally();
    }
  });

  await new Promise((resolve) => setImmediate(resolve));
  if (immediateSpawnError) {
    throw immediateSpawnError;
  }

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
    if (typeof resource.volume.setVolume === 'function') {
      resource.volume.setVolume(normalizedVol);
    } else if (typeof resource.volume.setVolumeLogarithmic === 'function') {
      resource.volume.setVolumeLogarithmic(normalizedVol);
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
  buildAudioFilterChain,
  terminateProcessSafely,
  HIGH_QUALITY_AUDIO_FILTER,
  BASSBOOST_PRESETS
};
