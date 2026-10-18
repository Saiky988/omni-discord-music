import { spawn as defaultSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';
import { logger as defaultLogger } from '../utils/logger.js';
import { playDl as defaultPlayDl } from '../utils/discordSdk.js';
import {
  InvalidInputError,
  UnsafeUrlError,
  UnsupportedSourceError,
  UnsupportedMediaError,
  ResolutionError
} from '../utils/errors.js';
import {
  parseAndValidateUrl,
  detectUrlPlatform,
  validateDirectMediaUrl,
  resolveRedirectUrlSafely,
  DIRECT_MEDIA_EXTENSIONS
} from '../utils/urlSafety.js';

export class BoundedMetadataCache {
  constructor({ maxEntries = 250, ttlMs = 300000 } = {}) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.store = new Map();
  }

  get(key) {
    if (this.ttlMs <= 0 || this.maxEntries <= 0) {
      return null;
    }
    const entry = this.store.get(key);
    if (!entry) {
      return null;
    }
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    this.store.delete(key);
    this.store.set(key, entry);
    return structuredClone(entry.value);
  }

  set(key, value) {
    if (this.ttlMs <= 0 || this.maxEntries <= 0) {
      return;
    }
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
      }
    }
    this.store.set(key, {
      value: structuredClone(value),
      expiresAt: Date.now() + this.ttlMs
    });
  }

  clear() {
    this.store.clear();
  }
}

export async function mapWithConcurrency(items, concurrency, mapper) {
  const limit = Math.max(1, Number.parseInt(String(concurrency), 10) || 3);
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await mapper(items[current], current);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

export function isUrlCandidate(input) {
  const trimmed = input.trim();
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    return true;
  }
  if (/^(javascript|data|vbscript|file|mailto|tel|about|blob|ws|wss|ftp|gopher|dict|ldap):/i.test(trimmed)) {
    return true;
  }
  return false;
}

export function extractYouTubeVideoId(parsedUrl) {
  const host = parsedUrl.hostname.toLowerCase();
  if (host === 'youtu.be') {
    const id = parsedUrl.pathname.split('/').filter(Boolean)[0];
    return id && /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : null;
  }
  const v = parsedUrl.searchParams.get('v');
  if (v && /^[A-Za-z0-9_-]{6,20}$/.test(v)) {
    return v;
  }
  const segments = parsedUrl.pathname.split('/').filter(Boolean);
  if ((segments[0] === 'shorts' || segments[0] === 'live' || segments[0] === 'embed') && segments[1]) {
    return /^[A-Za-z0-9_-]{6,20}$/.test(segments[1]) ? segments[1] : null;
  }
  return null;
}

export function canonicalizeYouTubeUrl(parsedUrl, platform) {
  const videoId = extractYouTubeVideoId(parsedUrl);
  if (!videoId) {
    return parsedUrl.toString();
  }
  if (platform === 'youtube_music') {
    return `https://music.youtube.com/watch?v=${videoId}`;
  }
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function resolveOptionalCookiesPath() {
  const envCookiePath = process.env.YTDLP_COOKIES_PATH?.trim();
  if (envCookiePath && fs.existsSync(envCookiePath)) {
    return envCookiePath;
  }
  const defaultCookiePath = path.resolve(process.cwd(), 'cookies.txt');
  if (fs.existsSync(defaultCookiePath)) {
    return defaultCookiePath;
  }
  return null;
}

export function createNormalizedTrack({
  title,
  artist = null,
  query,
  source,
  thumbnail = null,
  duration = null,
  webpageUrl = null,
  isLive = false,
  requestedBy = null,
  isFallback = false,
  originalSource = null,
  lazyResolve = false,
  lazySearchQuery = null
}) {
  const normalizedTitle = title && String(title).trim()
    ? String(title).trim()
    : 'Untitled Track';

  const normalizedDuration =
    duration !== null && duration !== undefined && Number.isFinite(Number(duration)) && Number(duration) >= 0
      ? Math.round(Number(duration))
      : null;

  return {
    title: normalizedTitle,
    artist: artist && String(artist).trim() ? String(artist).trim() : null,
    query: String(query).trim(),
    source: String(source || 'unknown'),
    thumbnail: thumbnail && String(thumbnail).trim() ? String(thumbnail).trim() : null,
    duration: normalizedDuration,
    webpageUrl: webpageUrl && String(webpageUrl).trim() ? String(webpageUrl).trim() : null,
    isLive: Boolean(isLive),
    requestedBy: requestedBy ?? null,
    isFallback: Boolean(isFallback),
    originalSource: originalSource || null,
    lazyResolve: Boolean(lazyResolve),
    lazySearchQuery: lazySearchQuery || null
  };
}

export function wrapSingleTrackResult(track, warnings = []) {
  return {
    kind: 'track',
    title: track.title,
    artist: track.artist,
    query: track.query,
    source: track.source,
    thumbnail: track.thumbnail,
    duration: track.duration,
    webpageUrl: track.webpageUrl,
    isLive: track.isLive,
    requestedBy: track.requestedBy,
    isFallback: track.isFallback,
    originalSource: track.originalSource,
    track,
    tracks: [track],
    playlist: null,
    warnings
  };
}

export function wrapPlaylistResult({
  title,
  source,
  webpageUrl = null,
  thumbnail = null,
  requestedBy = null,
  tracks = [],
  totalTracks = tracks.length,
  skippedTracks = 0,
  truncated = false,
  warnings = [],
  backgroundTasks = null,
  totalQueuedCount = undefined,
  backgroundLoadingCount = 0
}) {
  return {
    kind: 'playlist',
    title: title && String(title).trim() ? String(title).trim() : 'Playlist',
    source: String(source || 'unknown'),
    webpageUrl: webpageUrl || null,
    thumbnail: thumbnail || tracks[0]?.thumbnail || null,
    requestedBy: requestedBy ?? null,
    tracks,
    totalTracks,
    skippedTracks,
    truncated: Boolean(truncated),
    totalQueuedCount: totalQueuedCount ?? tracks.length,
    backgroundLoadingCount,
    backgroundTasks,
    playlist: {
      title: title && String(title).trim() ? String(title).trim() : 'Playlist',
      source: String(source || 'unknown'),
      webpageUrl: webpageUrl || null,
      thumbnail: thumbnail || tracks[0]?.thumbnail || null,
      totalTracks,
      skippedTracks,
      truncated: Boolean(truncated)
    },
    warnings
  };
}

function runYtdlpJsonProcess({
  spawnFn,
  ytdlpPath,
  args,
  timeoutMs
}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn(ytdlpPath, args, {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (err) {
      reject(
        new ResolutionError(
          `Failed to spawn yt-dlp metadata extractor: ${err.message}`,
          'Audio resolver executable could not be started.',
          { code: err.code },
          err
        )
      );
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const maxStdoutBytes = 32 * 1024 * 1024;
    const maxStderrBytes = 8192;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // Ignore kill error
      }
      reject(
        new ResolutionError(
          `yt-dlp metadata resolution timed out after ${timeoutMs}ms.`,
          'Timed out while fetching track information.'
        )
      );
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (stdoutBytes < maxStdoutBytes) {
        stdoutChunks.push(buf);
        stdoutBytes += buf.length;
      }
    });

    child.stderr?.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (stderrBytes < maxStderrBytes) {
        stderrChunks.push(buf.subarray(0, maxStderrBytes - stderrBytes));
        stderrBytes += buf.length;
      }
    });

    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const userMessage =
        err.code === 'ENOENT'
          ? 'The yt-dlp extractor binary is not installed on the server.'
          : 'Failed to execute media metadata extractor.';
      reject(new ResolutionError(`yt-dlp spawn error: ${err.message}`, userMessage, { code: err.code }, err));
    });

    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const stderrText = Buffer.concat(stderrChunks).toString('utf8').trim();
      if (code !== 0) {
        if (/no video formats|no audio|image|photo|slideshow/i.test(stderrText)) {
          reject(
            new UnsupportedMediaError(
              `Media does not contain an extractable audio stream: ${stderrText}`,
              'This post or photo carousel does not contain a playable audio stream.'
            )
          );
          return;
        }
        reject(
          new ResolutionError(
            `yt-dlp exited with code ${code}: ${stderrText || 'unknown error'}`,
            'Could not resolve playable media from the provided input.',
            { exitCode: code, stderr: stderrText }
          )
        );
        return;
      }

      const rawJson = Buffer.concat(stdoutChunks).toString('utf8').trim();
      if (!rawJson) {
        reject(
          new ResolutionError(
            'yt-dlp returned empty metadata output.',
            'No media results were found.'
          )
        );
        return;
      }

      try {
        const parsed = JSON.parse(rawJson);
        resolve(parsed);
      } catch (err) {
        reject(
          new ResolutionError(
            `Failed to parse yt-dlp JSON output: ${err.message}`,
            'Received malformed metadata from media extractor.',
            {},
            err
          )
        );
      }
    });
  });
}

export function createYtdlpMetadataExtractor({
  spawnFn = defaultSpawn,
  ytdlpPath = config.YTDLP_PATH,
  timeoutMs = config.RESOLVE_TIMEOUT_MS,
  maxPlaylistTracks = config.MAX_PLAYLIST_TRACKS,
  logger = defaultLogger
} = {}) {
  return async function extractWithYtdlp(target, { allowPlaylist = false } = {}) {
    if (!target || typeof target !== 'string' || target.startsWith('-')) {
      throw new InvalidInputError('Invalid extraction target.');
    }

    const cookiesPath = resolveOptionalCookiesPath();
    const baseArgs = [
      '--dump-single-json',
      '--no-warnings',
      '--no-check-certificates',
      '--geo-bypass',
      '--force-ipv4',
      '--skip-download'
    ];

    if (cookiesPath) {
      baseArgs.push('--cookies', cookiesPath);
    }

    if (allowPlaylist) {
      baseArgs.push('--flat-playlist', '--playlist-end', String(maxPlaylistTracks + 1));
    } else {
      baseArgs.push('--no-playlist', '--playlist-items', '1');
    }

    const firstAttemptArgs = [
      ...baseArgs,
      '--js-runtimes',
      'node',
      '--',
      target
    ];

    try {
      return await runYtdlpJsonProcess({
        spawnFn,
        ytdlpPath,
        args: firstAttemptArgs,
        timeoutMs
      });
    } catch (firstErr) {
      if (firstErr instanceof UnsupportedMediaError || firstErr?.context?.code === 'ENOENT') {
        throw firstErr;
      }

      logger.warn?.('Primary yt-dlp metadata extraction failed; retrying with fallback arguments', {
        target,
        error: firstErr.message
      });

      const isTikTok = target.includes('tiktok.com') || target.includes('douyin.com');
      const retryArgs = isTikTok
        ? [
            ...baseArgs,
            '--user-agent',
            'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
            '--',
            target
          ]
        : [
            ...baseArgs,
            '--ignore-no-formats-error',
            '--extractor-args',
            'youtube:player_client=android_vr,tv,web_safari,mweb,default',
            '--',
            target
          ];

      return runYtdlpJsonProcess({
        spawnFn,
        ytdlpPath,
        args: retryArgs,
        timeoutMs
      });
    }
  };
}

export function parseSpotifyUrlType(parsedUrl) {
  const segments = parsedUrl.pathname
    .split('/')
    .filter(Boolean)
    .filter((seg) => !/^intl-[a-z]{2}(-[a-z]{2})?$/i.test(seg) && seg !== 'embed');

  const type = segments[0]?.toLowerCase();
  const id = segments[1];

  if (['track', 'album', 'playlist'].includes(type) && id && /^[A-Za-z0-9]{10,40}$/.test(id)) {
    return { type, id };
  }
  return null;
}

export function parseAppleMusicUrlType(parsedUrl) {
  const segments = parsedUrl.pathname.split('/').filter(Boolean);
  const hasTrackParam = Boolean(parsedUrl.searchParams.get('i'));
  if (segments.includes('playlist')) {
    return { type: 'playlist', trackId: null };
  }
  if (segments.includes('song')) {
    return { type: 'track', trackId: segments[segments.length - 1] || null };
  }
  if (segments.includes('album')) {
    if (hasTrackParam) {
      return { type: 'track', trackId: parsedUrl.searchParams.get('i') };
    }
    return { type: 'album', trackId: null };
  }
  return null;
}

export function isPlaylistUrl(parsedUrl, platform) {
  if (platform === 'youtube' || platform === 'youtube_music') {
    if (parsedUrl.pathname === '/playlist' && parsedUrl.searchParams.has('list')) {
      return true;
    }
    if (!parsedUrl.searchParams.has('v') && parsedUrl.searchParams.has('list')) {
      return true;
    }
    return false;
  }

  if (platform === 'soundcloud') {
    const segments = parsedUrl.pathname.split('/').filter(Boolean);
    if (
      segments[0] === 'discover' &&
      segments[1] === 'sets' &&
      String(segments[2] || '').startsWith('track-stations:')
    ) {
      return false;
    }
    return segments.includes('sets');
  }

  return false;
}

export function assertPlayableAudioMetadata(meta, platform) {
  if (!meta || typeof meta !== 'object') {
    throw new ResolutionError('Empty metadata returned by extractor.');
  }

  if (Array.isArray(meta.formats) && meta.formats.length > 0) {
    const hasAudioFormat = meta.formats.some(
      (f) =>
        (f.acodec && f.acodec !== 'none') ||
        (typeof f.ext === 'string' && ['mp3', 'm4a', 'opus', 'ogg', 'wav', 'aac', 'flac', 'mp4', 'webm'].includes(f.ext)) ||
        Boolean(f.audio_ext && f.audio_ext !== 'none')
    );

    if (!hasAudioFormat) {
      throw new UnsupportedMediaError(
        `No playable audio stream found in ${platform} formats.`,
        `This ${platform} post does not contain a playable audio track (it may be a silent video or photo carousel).`
      );
    }
  } else if (meta.vcodec === 'none' && meta.acodec === 'none') {
    throw new UnsupportedMediaError(
      `No audio or video codec present on ${platform} media.`,
      `This ${platform} post does not expose a playable audio stream.`
    );
  }
}

export function selectBestSearchCandidate(candidates, originalMeta = null) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }
  if (!originalMeta || (!originalMeta.duration && !originalMeta.artist)) {
    return candidates[0];
  }

  const targetDuration = Number.isFinite(originalMeta.duration) ? originalMeta.duration : null;
  const targetArtist = (originalMeta.artist || '').toLowerCase().trim();
  const targetTitle = (originalMeta.title || '').toLowerCase().trim();

  let bestItem = candidates[0];
  let bestScore = -Infinity;

  for (let i = 0; i < candidates.length; i += 1) {
    const item = candidates[i];
    if (!item) continue;

    let score = -i * 2;
    const candTitle = String(item.title || '').toLowerCase();
    const candChannel = String(item.artist || item.channel?.name || item.uploader || '').toLowerCase();
    const candDuration = Number.isFinite(item.durationInSec)
      ? item.durationInSec
      : Number.isFinite(item.duration)
        ? item.duration
        : null;

    if (targetTitle && candTitle.includes(targetTitle)) {
      score += 20;
    }
    if (targetArtist) {
      const primaryArtist = targetArtist.split(',')[0].trim();
      if (primaryArtist && (candTitle.includes(primaryArtist) || candChannel.includes(primaryArtist))) {
        score += 35;
      } else {
        score -= 20;
      }
    }
    if (candChannel.includes('- topic') || candTitle.includes('official audio') || candTitle.includes('lyrics')) {
      score += 15;
    }

    if (targetDuration !== null && candDuration !== null) {
      const diff = Math.abs(candDuration - targetDuration);
      if (diff <= 5) {
        score += 40;
      } else if (diff <= 15) {
        score += 25;
      } else if (diff <= 45) {
        score += 5;
      } else {
        score -= Math.min(100, diff);
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestItem = item;
    }
  }

  return bestItem;
}

export class SourceResolver {
  constructor(options = {}) {
    this.config = options.config || config;
    this.logger = (options.logger || defaultLogger).child?.('resolver') || defaultLogger;
    this.playDl = options.playDl !== undefined ? options.playDl : defaultPlayDl;
    this.hasCustomYtdlpExtractor = Boolean(options.ytdlpExtract);
    this.ytdlpExtract =
      options.ytdlpExtract ||
      createYtdlpMetadataExtractor({
        spawnFn: options.spawnFn,
        ytdlpPath: this.config.YTDLP_PATH,
        timeoutMs: this.config.RESOLVE_TIMEOUT_MS,
        maxPlaylistTracks: this.config.MAX_PLAYLIST_TRACKS,
        logger: this.logger
      });
    this.spotifyMetadataResolver = options.spotifyMetadataResolver || null;
    this.appleMusicMetadataResolver = options.appleMusicMetadataResolver || null;
    this.directMediaValidator = options.directMediaValidator || validateDirectMediaUrl;
    this.redirectResolver = options.redirectResolver || resolveRedirectUrlSafely;
    this.cache =
      options.cache ||
      new BoundedMetadataCache({
        maxEntries: this.config.METADATA_CACHE_MAX_ENTRIES ?? 250,
        ttlMs: this.config.METADATA_CACHE_TTL_MS ?? 300000
      });
  }

  async resolve(rawInput, options = {}) {
    const requestedBy = options.requestedBy ?? null;
    const eagerFirstTrackOnly = Boolean(options.eagerFirstTrackOnly);
    const lazy = Boolean(options.lazy);

    if (typeof rawInput !== 'string') {
      throw new InvalidInputError(
        'Input must be a string.',
        'Please provide a valid track URL or search query.'
      );
    }

    const trimmed = rawInput.trim();
    if (!trimmed) {
      throw new InvalidInputError(
        'Input cannot be empty.',
        'Please provide a non-empty URL or search query.'
      );
    }

    if (trimmed.length > 1000 || /[\0\r\n]/.test(trimmed)) {
      throw new InvalidInputError(
        'Input exceeds maximum length or contains control characters.',
        'Your search query or URL is too long or contains invalid characters.'
      );
    }

    if (trimmed.startsWith('-')) {
      throw new InvalidInputError(
        'Input cannot start with a hyphen.',
        'Search queries and URLs cannot start with a hyphen (-).'
      );
    }

    if (isUrlCandidate(trimmed)) {
      const parsedUrl = parseAndValidateUrl(trimmed, {
        allowHttp: Boolean(this.config.ALLOW_HTTP_MEDIA)
      });
      return this.resolveUrl(parsedUrl, { requestedBy, eagerFirstTrackOnly, lazy });
    }

    if (
      /^[a-z0-9.-]+:\d+\//i.test(trimmed) ||
      /^(localhost|127\.0\.0\.1|169\.254\.169\.254|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+)([:/]|$)/i.test(trimmed)
    ) {
      throw new UnsafeUrlError(
        'Rejected bare internal address or malformed URL.',
        'Localhost and private network addresses are not permitted.'
      );
    }

    return this.resolveSearchQuery(trimmed, { requestedBy });
  }

  async resolveSearchQuery(queryText, { requestedBy = null, preferredFallback = 'youtube', originalMeta = null } = {}) {
    const cleanQuery = queryText.replace(/\s+/g, ' ').trim();
    if (!cleanQuery || cleanQuery.length < 2) {
      throw new InvalidInputError(
        'Search query is too short.',
        'Please enter at least 2 characters to search.'
      );
    }

    const cacheKey = `search:${preferredFallback}:${cleanQuery.toLowerCase()}:${originalMeta?.duration ?? ''}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      const track = createNormalizedTrack({
        ...cached,
        title: originalMeta?.title || cached.title,
        artist: originalMeta?.artist || cached.artist,
        source: originalMeta?.source || cached.source,
        thumbnail: originalMeta?.thumbnail || cached.thumbnail,
        duration: originalMeta?.duration ?? cached.duration,
        webpageUrl: originalMeta?.webpageUrl || cached.webpageUrl,
        requestedBy,
        isFallback: Boolean(originalMeta),
        originalSource: originalMeta?.source || null
      });
      return wrapSingleTrackResult(track);
    }

    if (this.playDl && typeof this.playDl.search === 'function' && preferredFallback === 'youtube') {
      try {
        const searchLimit = originalMeta ? 5 : 1;
        const results = await this.playDl.search(cleanQuery, {
          limit: searchLimit,
          source: { youtube: 'video' }
        });
        if (Array.isArray(results) && results.length > 0) {
          const item = selectBestSearchCandidate(results, originalMeta) || results[0];
          if (item?.url) {
            const validatedUrl = parseAndValidateUrl(item.url, { allowHttp: false }).toString();
            const baseData = {
              title: item.title || cleanQuery,
              artist: item.channel?.name || null,
              query: validatedUrl,
              source: 'youtube',
              thumbnail: item.thumbnails?.[0]?.url || null,
              duration: Number.isFinite(item.durationInSec) ? item.durationInSec : null,
              webpageUrl: validatedUrl,
              isLive: Boolean(item.live)
            };
            this.assertDurationAllowed(baseData.duration, baseData.isLive);
            this.cache.set(cacheKey, baseData);

            const track = createNormalizedTrack({
              ...baseData,
              title: originalMeta?.title || baseData.title,
              artist: originalMeta?.artist || baseData.artist,
              source: originalMeta?.source || baseData.source,
              thumbnail: originalMeta?.thumbnail || baseData.thumbnail,
              duration: originalMeta?.duration ?? baseData.duration,
              webpageUrl: originalMeta?.webpageUrl || baseData.webpageUrl,
              requestedBy,
              isFallback: Boolean(originalMeta),
              originalSource: originalMeta?.source || null
            });
            return wrapSingleTrackResult(track);
          }
        }
      } catch (err) {
        this.logger.debug('play-dl search failed, falling back to yt-dlp search', {
          query: cleanQuery,
          error: err.message
        });
      }
    }

    const searchPrefixes = preferredFallback === 'soundcloud'
      ? ['scsearch1', 'ytsearch1']
      : ['ytsearch1', 'scsearch1'];

    let lastError = null;
    for (const prefix of searchPrefixes) {
      try {
        const searchTarget = `${prefix}:${cleanQuery}`;
        const rawMeta = await this.ytdlpExtract(searchTarget, { allowPlaylist: false });
        const entries = Array.isArray(rawMeta?.entries) ? rawMeta.entries : [rawMeta];
        const entry = selectBestSearchCandidate(entries, originalMeta) || entries[0];
        if (!entry) {
          continue;
        }

        const resolvedUrl = entry.webpage_url || entry.original_url || entry.url;
        if (!resolvedUrl || typeof resolvedUrl !== 'string') {
          continue;
        }

        const safeUrl = parseAndValidateUrl(resolvedUrl, {
          allowHttp: Boolean(this.config.ALLOW_HTTP_MEDIA)
        }).toString();

        const resolvedSource = prefix.startsWith('scsearch') ? 'soundcloud' : 'youtube';
        const baseData = {
          title: entry.title || cleanQuery,
          artist: entry.artist || entry.uploader || entry.channel || null,
          query: safeUrl,
          source: resolvedSource,
          thumbnail: entry.thumbnail || entry.thumbnails?.[0]?.url || null,
          duration: Number.isFinite(entry.duration) ? entry.duration : null,
          webpageUrl: safeUrl,
          isLive: Boolean(entry.is_live)
        };

        this.assertDurationAllowed(baseData.duration, baseData.isLive);
        this.cache.set(cacheKey, baseData);

        const track = createNormalizedTrack({
          ...baseData,
          title: originalMeta?.title || baseData.title,
          artist: originalMeta?.artist || baseData.artist,
          source: originalMeta?.source || baseData.source,
          thumbnail: originalMeta?.thumbnail || baseData.thumbnail,
          duration: originalMeta?.duration ?? baseData.duration,
          webpageUrl: originalMeta?.webpageUrl || baseData.webpageUrl,
          requestedBy,
          isFallback: Boolean(originalMeta || prefix.startsWith('scsearch')),
          originalSource: originalMeta?.source || null
        });
        return wrapSingleTrackResult(track);
      } catch (err) {
        lastError = err;
        if (err instanceof InvalidInputError || err instanceof UnsupportedMediaError) {
          throw err;
        }
      }
    }

    throw new ResolutionError(
      `No playable results found for query "${cleanQuery}".`,
      `No playable tracks were found for "${cleanQuery}".`,
      { query: cleanQuery },
      lastError || undefined
    );
  }

  async normalizeIncomingUrl(parsedUrl, platform) {
    const host = parsedUrl.hostname.toLowerCase();

    if (
      host === 'on.soundcloud.com' ||
      host === 'vt.tiktok.com' ||
      host === 'vm.tiktok.com' ||
      host === 'spotify.link'
    ) {
      const resolved = await this.redirectResolver(parsedUrl, {
        allowHttp: Boolean(this.config.ALLOW_HTTP_MEDIA)
      });
      parsedUrl = resolved;
    }

    if (platform === 'soundcloud') {
      const cleaned = new URL(parsedUrl.toString());
      for (const key of ['si', 'in', 'ref', 'utm_source', 'utm_medium', 'utm_campaign']) {
        cleaned.searchParams.delete(key);
      }
      return cleaned;
    }

    if (platform === 'tiktok') {
      const cleaned = new URL(parsedUrl.toString());
      cleaned.search = '';
      cleaned.pathname = cleaned.pathname.replace(/\/photo\/(\d+)/, '/video/$1');
      return cleaned;
    }

    return parsedUrl;
  }

  async resolveUrl(parsedUrl, { requestedBy = null, eagerFirstTrackOnly = false, lazy = false } = {}) {
    let platform = detectUrlPlatform(parsedUrl);
    if (platform === 'unknown') {
      throw new UnsupportedSourceError(
        `Unsupported URL host or media format: ${parsedUrl.hostname}`,
        'That domain or link format is not supported. Supported sources include YouTube, YouTube Music, Spotify, Apple Music, SoundCloud, TikTok, Douyin, Facebook, Instagram, and direct audio links.'
      );
    }

    parsedUrl = await this.normalizeIncomingUrl(parsedUrl, platform);
    platform = detectUrlPlatform(parsedUrl) !== 'unknown' ? detectUrlPlatform(parsedUrl) : platform;

    if (platform === 'spotify') {
      return this.resolveSpotifyUrl(parsedUrl, { requestedBy, eagerFirstTrackOnly, lazy });
    }

    if (platform === 'apple_music') {
      return this.resolveAppleMusicUrl(parsedUrl, { requestedBy, eagerFirstTrackOnly, lazy });
    }

    if (platform === 'direct_media') {
      return this.resolveDirectMedia(parsedUrl, { requestedBy });
    }

    if (isPlaylistUrl(parsedUrl, platform)) {
      return this.resolveExtractorPlaylist(parsedUrl, platform, { requestedBy });
    }

    return this.resolveExtractorSingle(parsedUrl, platform, { requestedBy, lazy });
  }

  async resolveDirectMedia(parsedUrl, { requestedBy = null } = {}) {
    const validation = await this.directMediaValidator(parsedUrl, {
      allowHttp: Boolean(this.config.ALLOW_HTTP_MEDIA)
    });

    const finalUrl = validation.finalUrl || parsedUrl.toString();
    const baseName = decodeURIComponent(path.basename(new URL(finalUrl).pathname)) || 'Direct Audio Stream';
    const ext = DIRECT_MEDIA_EXTENSIONS.find((e) => baseName.toLowerCase().endsWith(e)) || '';
    const cleanTitle = ext ? baseName.slice(0, -ext.length) || baseName : baseName;

    const track = createNormalizedTrack({
      title: cleanTitle,
      artist: parsedUrl.hostname,
      query: finalUrl,
      source: 'direct_media',
      thumbnail: null,
      duration: null,
      webpageUrl: finalUrl,
      isLive: ext === '.m3u8',
      requestedBy
    });

    return wrapSingleTrackResult(track);
  }

  async fallbackResolveYouTubeMetadata(canonicalUrl, platform) {
    if (this.playDl && typeof this.playDl.video_basic_info === 'function') {
      try {
        const info = await this.playDl.video_basic_info(canonicalUrl);
        const details = info?.video_details;
        if (details?.title) {
          const duration = Number.isFinite(details.durationInSec) ? details.durationInSec : null;
          const isLive = Boolean(details.live);
          this.assertDurationAllowed(duration, isLive);
          return {
            title: details.title,
            artist: details.channel?.name || null,
            query: canonicalUrl,
            source: platform,
            thumbnail: details.thumbnails?.[0]?.url || null,
            duration,
            webpageUrl: canonicalUrl,
            isLive
          };
        }
      } catch (err) {
        this.logger.debug('play-dl video_basic_info fallback failed', {
          url: canonicalUrl,
          error: err.message
        });
      }
    }

    if (typeof globalThis.fetch === 'function') {
      try {
        const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(canonicalUrl)}&format=json`;
        const res = await globalThis.fetch(oembedUrl, {
          headers: { 'User-Agent': 'omni-discord-music/1.0' }
        });
        if (res.ok) {
          const data = await res.json();
          if (data?.title) {
            return {
              title: data.title,
              artist: data.author_name || null,
              query: canonicalUrl,
              source: platform,
              thumbnail: data.thumbnail_url || null,
              duration: null,
              webpageUrl: canonicalUrl,
              isLive: false
            };
          }
        }
      } catch (err) {
        this.logger.debug('YouTube oEmbed fallback failed', {
          url: canonicalUrl,
          error: err.message
        });
      }
    }

    return null;
  }

  async fallbackResolveTikTok(tiktokUrl) {
    if (typeof globalThis.fetch !== 'function') {
      return null;
    }

    try {
      const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(tiktokUrl)}`;
      const res = await globalThis.fetch(apiUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) omni-discord-music/1.0',
          Accept: 'application/json'
        }
      });

      if (!res.ok) {
        return null;
      }

      const payload = await res.json();
      const data = payload?.data;
      if (!data) {
        return null;
      }

      // Prefer signed CDN play/music stream URL over /video/media/play/ fallback
      const streamCandidate =
        data.play ||
        data.wmplay ||
        data.music_info?.play ||
        data.music ||
        (data.id ? `https://www.tikwm.com/video/media/play/${data.id}.mp4` : null);

      if (!streamCandidate || typeof streamCandidate !== 'string') {
        return null;
      }

      const resolvedCandidate = new URL(streamCandidate, 'https://www.tikwm.com').toString();
      const safeStreamUrl = parseAndValidateUrl(resolvedCandidate, {
        allowHttp: Boolean(this.config.ALLOW_HTTP_MEDIA)
      }).toString();

      const duration =
        Number.isFinite(Number(data.duration)) && Number(data.duration) > 0
          ? Math.round(Number(data.duration))
          : Number.isFinite(Number(data.music_info?.duration)) && Number(data.music_info?.duration) > 0
            ? Math.round(Number(data.music_info.duration))
            : null;

      this.assertDurationAllowed(duration, false);

      const rawThumb = data.cover || data.origin_cover || data.author?.avatar || null;
      let thumbnail = null;
      if (rawThumb && typeof rawThumb === 'string') {
        try {
          thumbnail = new URL(rawThumb, 'https://www.tikwm.com').toString();
        } catch {
          thumbnail = null;
        }
      }

      return {
        title: data.title || data.music_info?.title || 'TikTok Audio',
        artist: data.author?.nickname || data.author?.unique_id || data.music_info?.author || null,
        query: safeStreamUrl,
        source: 'tiktok',
        thumbnail,
        duration,
        webpageUrl: tiktokUrl,
        isLive: false
      };
    } catch (err) {
      this.logger.debug('TikTok API fallback failed', {
        url: tiktokUrl,
        error: err.message
      });
      return null;
    }
  }

  async resolveExtractorSingle(parsedUrl, platform, { requestedBy = null, lazy = false } = {}) {
    const isYt = platform === 'youtube' || platform === 'youtube_music';
    const urlStr = isYt
      ? canonicalizeYouTubeUrl(parsedUrl, platform)
      : parsedUrl.toString();

    const cacheKey = `url:${urlStr}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      const track = createNormalizedTrack({
        ...cached,
        requestedBy
      });
      return wrapSingleTrackResult(track);
    }

    // Fast metadata path for live commands: grab title/thumbnail via lightweight API first
    if (lazy && !this.hasCustomYtdlpExtractor) {
      if (isYt) {
        const fastYt = await this.fallbackResolveYouTubeMetadata(urlStr, platform);
        if (fastYt) {
          this.cache.set(cacheKey, fastYt);
          const track = createNormalizedTrack({
            ...fastYt,
            requestedBy
          });
          return wrapSingleTrackResult(track);
        }
      } else if (platform === 'tiktok') {
        const fastTikTok = await this.fallbackResolveTikTok(urlStr);
        if (fastTikTok) {
          this.cache.set(cacheKey, fastTikTok);
          const track = createNormalizedTrack({
            ...fastTikTok,
            requestedBy
          });
          return wrapSingleTrackResult(track);
        }
      }
    }

    let meta = null;
    let ytdlpError = null;

    try {
      meta = await this.ytdlpExtract(urlStr, { allowPlaylist: false });
    } catch (err) {
      ytdlpError = err;
      if (err instanceof UnsupportedMediaError || err instanceof InvalidInputError) {
        throw err;
      }
      this.logger.warn('yt-dlp metadata extraction failed on URL; checking platform fallback', {
        platform,
        url: urlStr,
        error: err.message
      });
    }

    if (!meta && isYt) {
      const fallbackData = await this.fallbackResolveYouTubeMetadata(urlStr, platform);
      if (fallbackData) {
        this.cache.set(cacheKey, fallbackData);
        const track = createNormalizedTrack({
          ...fallbackData,
          requestedBy
        });
        return wrapSingleTrackResult(track);
      }
      throw ytdlpError || new ResolutionError('Could not resolve YouTube track metadata.');
    }

    if (!meta && platform === 'tiktok') {
      const fallbackTikTok = await this.fallbackResolveTikTok(urlStr);
      if (fallbackTikTok) {
        this.cache.set(cacheKey, fallbackTikTok);
        const track = createNormalizedTrack({
          ...fallbackTikTok,
          requestedBy
        });
        return wrapSingleTrackResult(track);
      }
      throw ytdlpError || new ResolutionError('Could not resolve TikTok media.');
    }

    if (!meta) {
      throw ytdlpError || new ResolutionError('Could not resolve media metadata.');
    }

    if (meta?._type === 'playlist' && Array.isArray(meta.entries) && meta.entries.length > 0) {
      if (isPlaylistUrl(parsedUrl, platform)) {
        return this.buildPlaylistFromEntries(meta, platform, urlStr, requestedBy);
      }
      meta = meta.entries[0];
    }

    assertPlayableAudioMetadata(meta, platform);

    const duration = Number.isFinite(meta.duration) ? meta.duration : null;
    const isLive = Boolean(meta.is_live);
    this.assertDurationAllowed(duration, isLive);

    const webpageUrl = meta.webpage_url
      ? parseAndValidateUrl(meta.webpage_url, { allowHttp: Boolean(this.config.ALLOW_HTTP_MEDIA) }).toString()
      : urlStr;

    const streamQuery =
      platform === 'soundcloud' && webpageUrl
        ? webpageUrl
        : urlStr;

    const baseData = {
      title: meta.title || meta.fulltitle || `${platform} Track`,
      artist: meta.artist || meta.uploader || meta.channel || meta.creator || null,
      query: streamQuery,
      source: platform,
      thumbnail: meta.thumbnail || meta.thumbnails?.[0]?.url || null,
      duration,
      webpageUrl,
      isLive
    };

    this.cache.set(cacheKey, baseData);

    const track = createNormalizedTrack({
      ...baseData,
      requestedBy
    });

    return wrapSingleTrackResult(track);
  }

  async resolveExtractorPlaylist(parsedUrl, platform, { requestedBy = null } = {}) {
    const urlStr = parsedUrl.toString();
    const meta = await this.ytdlpExtract(urlStr, { allowPlaylist: true });

    if (!meta || !Array.isArray(meta.entries) || meta.entries.length === 0) {
      throw new ResolutionError(
        `Playlist at ${urlStr} contained no playable entries.`,
        'That playlist is empty, private, or contains no playable tracks.'
      );
    }

    return this.buildPlaylistFromEntries(meta, platform, urlStr, requestedBy);
  }

  buildPlaylistFromEntries(meta, platform, urlStr, requestedBy) {
    const rawEntries = Array.isArray(meta.entries) ? meta.entries : [];
    const maxTracks = this.config.MAX_PLAYLIST_TRACKS || 100;
    const truncated = rawEntries.length > maxTracks;
    const limitedEntries = rawEntries.slice(0, maxTracks);

    const tracks = [];
    let skippedTracks = truncated ? rawEntries.length - maxTracks : 0;
    const warnings = [];

    for (const entry of limitedEntries) {
      if (
        !entry ||
        entry.availability === 'private' ||
        entry.availability === 'unavailable' ||
        entry.title === '[Private video]' ||
        entry.title === '[Deleted video]'
      ) {
        skippedTracks += 1;
        continue;
      }

      let candidateUrl = entry.webpage_url || entry.url;
      if (!candidateUrl && entry.id && (platform === 'youtube' || platform === 'youtube_music')) {
        candidateUrl = `https://www.youtube.com/watch?v=${entry.id}`;
      }
      if (!candidateUrl) {
        skippedTracks += 1;
        continue;
      }

      try {
        const safeEntryUrl = parseAndValidateUrl(candidateUrl, {
          allowHttp: Boolean(this.config.ALLOW_HTTP_MEDIA)
        }).toString();

        const duration = Number.isFinite(entry.duration) ? entry.duration : null;
        if (
          duration !== null &&
          this.config.MAX_TRACK_DURATION_SECONDS &&
          duration > this.config.MAX_TRACK_DURATION_SECONDS
        ) {
          skippedTracks += 1;
          continue;
        }

        tracks.push(
          createNormalizedTrack({
            title: entry.title || 'SoundCloud Track',
            artist: entry.artist || entry.uploader || entry.channel || meta.uploader || null,
            query: safeEntryUrl,
            source: platform,
            thumbnail: entry.thumbnail || entry.thumbnails?.[0]?.url || meta.thumbnail || null,
            duration,
            webpageUrl: safeEntryUrl,
            isLive: Boolean(entry.is_live),
            requestedBy
          })
        );
      } catch {
        skippedTracks += 1;
      }
    }

    if (tracks.length === 0) {
      throw new ResolutionError(
        `No valid playable tracks remained in playlist ${urlStr}.`,
        'None of the tracks in that playlist are available for playback.'
      );
    }

    if (skippedTracks > 0) {
      warnings.push(`${skippedTracks} unavailable or excess track(s) were skipped.`);
    }

    return wrapPlaylistResult({
      title: meta.title || 'Playlist',
      source: platform,
      webpageUrl: urlStr,
      thumbnail: meta.thumbnail || tracks[0]?.thumbnail || null,
      requestedBy,
      tracks,
      totalTracks: rawEntries.length,
      skippedTracks,
      truncated,
      warnings
    });
  }

  async resolveSpotifyUrl(parsedUrl, { requestedBy = null, eagerFirstTrackOnly = false, lazy = false } = {}) {
    const classification = parseSpotifyUrlType(parsedUrl);
    if (!classification) {
      throw new InvalidInputError(
        `Unsupported Spotify URL path: ${parsedUrl.pathname}`,
        'Please provide a valid Spotify track, album, or playlist link.'
      );
    }

    const metadata = await this.fetchSpotifyMetadata(parsedUrl, classification);

    if (classification.type === 'track') {
      if (!metadata || !metadata.title) {
        throw new ResolutionError(
          'Could not extract Spotify track metadata.',
          'Failed to read metadata for that Spotify track.'
        );
      }
      const searchString = metadata.artist
        ? `${metadata.artist} - ${metadata.title} official audio`
        : `${metadata.title} official audio`;

      if (lazy) {
        this.assertDurationAllowed(metadata.duration ?? null, false);
        const lazyTrack = createNormalizedTrack({
          title: metadata.title,
          artist: metadata.artist || null,
          query: `ytsearch1:${searchString}`,
          source: 'spotify',
          thumbnail: metadata.thumbnail || null,
          duration: metadata.duration ?? null,
          webpageUrl: `https://open.spotify.com/track/${classification.id}`,
          requestedBy,
          isFallback: true,
          originalSource: 'spotify',
          lazyResolve: true,
          lazySearchQuery: searchString
        });
        return wrapSingleTrackResult(lazyTrack);
      }

      return this.resolveSearchQuery(searchString, {
        requestedBy,
        originalMeta: {
          title: metadata.title,
          artist: metadata.artist || null,
          source: 'spotify',
          thumbnail: metadata.thumbnail || null,
          duration: metadata.duration ?? null,
          webpageUrl: `https://open.spotify.com/track/${classification.id}`
        }
      });
    }

    return this.resolveMetadataCollection(metadata, {
      platform: 'spotify',
      webpageUrl: parsedUrl.toString(),
      requestedBy,
      eagerFirstTrackOnly,
      lazy
    });
  }

  async resolveAppleMusicUrl(parsedUrl, { requestedBy = null, eagerFirstTrackOnly = false, lazy = false } = {}) {
    const classification = parseAppleMusicUrlType(parsedUrl);
    if (!classification) {
      throw new InvalidInputError(
        `Unsupported Apple Music URL path: ${parsedUrl.pathname}`,
        'Please provide a valid Apple Music song, album, or playlist link.'
      );
    }

    const metadata = await this.fetchAppleMusicMetadata(parsedUrl, classification);

    if (classification.type === 'track') {
      if (!metadata || !metadata.title) {
        throw new ResolutionError(
          'Could not extract Apple Music track metadata.',
          'Failed to read metadata for that Apple Music track.'
        );
      }
      const searchString = metadata.artist
        ? `${metadata.artist} - ${metadata.title} official audio`
        : `${metadata.title} official audio`;

      if (lazy) {
        this.assertDurationAllowed(metadata.duration ?? null, false);
        const lazyTrack = createNormalizedTrack({
          title: metadata.title,
          artist: metadata.artist || null,
          query: `ytsearch1:${searchString}`,
          source: 'apple_music',
          thumbnail: metadata.thumbnail || null,
          duration: metadata.duration ?? null,
          webpageUrl: parsedUrl.toString(),
          requestedBy,
          isFallback: true,
          originalSource: 'apple_music',
          lazyResolve: true,
          lazySearchQuery: searchString
        });
        return wrapSingleTrackResult(lazyTrack);
      }

      return this.resolveSearchQuery(searchString, {
        requestedBy,
        originalMeta: {
          title: metadata.title,
          artist: metadata.artist || null,
          source: 'apple_music',
          thumbnail: metadata.thumbnail || null,
          duration: metadata.duration ?? null,
          webpageUrl: parsedUrl.toString()
        }
      });
    }

    return this.resolveMetadataCollection(metadata, {
      platform: 'apple_music',
      webpageUrl: parsedUrl.toString(),
      requestedBy,
      eagerFirstTrackOnly,
      lazy
    });
  }

  async resolveMetadataCollection(
    collectionMeta,
    { platform, webpageUrl, requestedBy, eagerFirstTrackOnly = false, lazy = false }
  ) {
    const rawItems = Array.isArray(collectionMeta?.tracks) ? collectionMeta.tracks : [];
    if (rawItems.length === 0) {
      throw new ResolutionError(
        `No tracks found in ${platform} collection.`,
        'That playlist or album appears to be empty or unavailable.'
      );
    }

    const maxTracks = this.config.MAX_PLAYLIST_TRACKS || 100;
    const truncated = rawItems.length > maxTracks;
    const slice = rawItems.slice(0, maxTracks);
    let skippedTracks = truncated ? rawItems.length - maxTracks : 0;
    const warnings = [];

    // Instant Lazy Resolution for playlists/albums: enqueue all tracks immediately with metadata
    // and resolve each track's playable stream just-in-time before playback!
    if (lazy) {
      const lazyTracks = [];
      for (const item of slice) {
        if (!item || item.unavailable || !item.title) {
          skippedTracks += 1;
          continue;
        }
        const duration = Number.isFinite(item.duration) ? item.duration : null;
        if (
          duration !== null &&
          this.config.MAX_TRACK_DURATION_SECONDS &&
          duration > this.config.MAX_TRACK_DURATION_SECONDS
        ) {
          skippedTracks += 1;
          continue;
        }
        const searchStr = item.artist
          ? `${item.artist} - ${item.title} official audio`
          : `${item.title} official audio`;

        lazyTracks.push(
          createNormalizedTrack({
            title: item.title,
            artist: item.artist || null,
            query: `ytsearch1:${searchStr}`,
            source: platform,
            thumbnail: item.thumbnail || collectionMeta.thumbnail || null,
            duration,
            webpageUrl: item.url || webpageUrl,
            requestedBy,
            isFallback: true,
            originalSource: platform,
            lazyResolve: true,
            lazySearchQuery: searchStr
          })
        );
      }

      if (lazyTracks.length === 0) {
        throw new ResolutionError(
          `Could not resolve any playable tracks for ${platform} collection.`,
          'None of the tracks in that collection are available for playback.'
        );
      }

      if (skippedTracks > 0) {
        warnings.push(`${skippedTracks} track(s) were unavailable or exceeded the playlist limit.`);
      }

      return wrapPlaylistResult({
        title: collectionMeta.title || `${platform === 'spotify' ? 'Spotify' : 'Apple Music'} Collection`,
        source: platform,
        webpageUrl,
        thumbnail: collectionMeta.thumbnail || lazyTracks[0]?.thumbnail || null,
        requestedBy,
        tracks: lazyTracks,
        totalTracks: rawItems.length,
        skippedTracks,
        truncated,
        warnings
      });
    }

    const resolveSingleCollectionItem = async (item) => {
      if (!item || item.unavailable || !item.title) {
        return null;
      }
      const searchStr = item.artist
        ? `${item.artist} - ${item.title} official audio`
        : `${item.title} official audio`;
      try {
        const resolved = await this.resolveSearchQuery(searchStr, {
          requestedBy,
          originalMeta: {
            title: item.title,
            artist: item.artist || null,
            source: platform,
            thumbnail: item.thumbnail || collectionMeta.thumbnail || null,
            duration: item.duration ?? null,
            webpageUrl: item.url || webpageUrl
          }
        });
        return resolved.track;
      } catch (err) {
        this.logger.warn(`Skipping unresolvable ${platform} playlist item`, {
          title: item.title,
          error: err.message
        });
        return null;
      }
    };

    // Fast path for live command execution: resolve ONLY the first playable track immediately
    // so playback and the Discord embed reply happen right away, and resolve remaining tracks in background!
    if (eagerFirstTrackOnly && slice.length > 1) {
      let firstTrack = null;
      let startIndex = 0;

      for (let i = 0; i < slice.length; i += 1) {
        startIndex = i + 1;
        const candidate = await resolveSingleCollectionItem(slice[i]);
        if (candidate) {
          firstTrack = candidate;
          break;
        }
        skippedTracks += 1;
      }

      if (!firstTrack) {
        throw new ResolutionError(
          `Could not resolve any playable tracks for ${platform} collection.`,
          'None of the tracks in that collection could be matched to a playable audio source.'
        );
      }

      const remainingSlice = slice.slice(startIndex);
      const validRemainingEstimate = remainingSlice.filter((item) => item && !item.unavailable && item.title).length;

      const backgroundTasks = async (onTrackResolved) => {
        await mapWithConcurrency(
          remainingSlice,
          this.config.PLAYLIST_CONCURRENCY || 3,
          async (item) => {
            const track = await resolveSingleCollectionItem(item);
            if (track && typeof onTrackResolved === 'function') {
              await onTrackResolved(track);
            }
          }
        );
      };

      return wrapPlaylistResult({
        title: collectionMeta.title || `${platform === 'spotify' ? 'Spotify' : 'Apple Music'} Collection`,
        source: platform,
        webpageUrl,
        thumbnail: collectionMeta.thumbnail || firstTrack.thumbnail || null,
        requestedBy,
        tracks: [firstTrack],
        totalTracks: rawItems.length,
        skippedTracks,
        truncated,
        totalQueuedCount: 1 + validRemainingEstimate,
        backgroundLoadingCount: validRemainingEstimate,
        backgroundTasks,
        warnings
      });
    }

    const mappedResults = await mapWithConcurrency(
      slice,
      this.config.PLAYLIST_CONCURRENCY || 3,
      resolveSingleCollectionItem
    );

    const tracks = [];
    for (const track of mappedResults) {
      if (track) {
        tracks.push(track);
      } else {
        skippedTracks += 1;
      }
    }

    if (tracks.length === 0) {
      throw new ResolutionError(
        `Could not resolve any playable tracks for ${platform} collection.`,
        'None of the tracks in that collection could be matched to a playable audio source.'
      );
    }

    if (skippedTracks > 0) {
      warnings.push(`${skippedTracks} track(s) were unavailable or exceeded the playlist limit.`);
    }

    return wrapPlaylistResult({
      title: collectionMeta.title || `${platform === 'spotify' ? 'Spotify' : 'Apple Music'} Collection`,
      source: platform,
      webpageUrl,
      thumbnail: collectionMeta.thumbnail || tracks[0]?.thumbnail || null,
      requestedBy,
      tracks,
      totalTracks: rawItems.length,
      skippedTracks,
      truncated,
      warnings
    });
  }

  async fetchSpotifyMetadata(parsedUrl, classification) {
    if (typeof this.spotifyMetadataResolver === 'function') {
      return this.spotifyMetadataResolver(parsedUrl, classification);
    }

    if (typeof globalThis.fetch === 'function') {
      try {
        const embedUrl = `https://open.spotify.com/embed/${classification.type}/${classification.id}`;
        const res = await globalThis.fetch(embedUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            Accept: 'text/html,application/xhtml+xml'
          }
        });

        if (res.ok) {
          const html = await res.text();
          const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
          if (nextDataMatch && nextDataMatch[1]) {
            const nextData = JSON.parse(nextDataMatch[1]);
            const entity = nextData?.props?.pageProps?.state?.data?.entity;
            if (entity) {
              const coverArt =
                entity.visualIdentity?.image?.[0]?.url ||
                entity.coverArt?.sources?.[0]?.url ||
                null;

              if (classification.type === 'track' && (entity.name || entity.title)) {
                const artists = Array.isArray(entity.artists)
                  ? entity.artists.map((a) => a.name).filter(Boolean).join(', ')
                  : entity.subtitle || null;
                const durationSec = Number.isFinite(entity.duration)
                  ? Math.round(entity.duration / 1000)
                  : null;

                return {
                  type: 'track',
                  title: entity.name || entity.title,
                  artist: artists,
                  duration: durationSec,
                  thumbnail: coverArt
                };
              }

              if (Array.isArray(entity.trackList) && entity.trackList.length > 0) {
                return {
                  type: classification.type,
                  title: entity.name || entity.title || 'Spotify Collection',
                  thumbnail: coverArt,
                  tracks: entity.trackList.map((item) => ({
                    title: item.title || null,
                    artist: item.subtitle || null,
                    duration: Number.isFinite(item.duration) ? Math.round(item.duration / 1000) : null,
                    thumbnail: coverArt,
                    url: item.uri?.startsWith('spotify:track:')
                      ? `https://open.spotify.com/track/${item.uri.split(':')[2]}`
                      : parsedUrl.toString(),
                    unavailable: !item.title || Boolean(item.isPlayable === false)
                  }))
                };
              }
            }
          }
        }
      } catch (err) {
        this.logger.debug('Spotify embed __NEXT_DATA__ parse failed, trying fallback', {
          error: err.message
        });
      }
    }

    if (this.playDl && typeof this.playDl.spotify === 'function') {
      try {
        if (this.playDl.is_expired?.()) {
          await this.playDl.refreshToken?.();
        }
        const spData = await this.playDl.spotify(parsedUrl.toString());
        if (spData) {
          if (spData.type === 'track') {
            return {
              type: 'track',
              title: spData.name,
              artist: spData.artists?.map((a) => a.name).join(', ') || null,
              duration: Number.isFinite(spData.durationInSec) ? spData.durationInSec : null,
              thumbnail: spData.thumbnail?.url || null
            };
          }
          const allTracks = await spData.all_tracks?.();
          if (Array.isArray(allTracks)) {
            return {
              type: classification.type,
              title: spData.name || 'Spotify Collection',
              thumbnail: spData.thumbnail?.url || null,
              tracks: allTracks.map((t) => ({
                title: t?.name || null,
                artist: t?.artists?.map((a) => a.name).join(', ') || null,
                duration: Number.isFinite(t?.durationInSec) ? t.durationInSec : null,
                thumbnail: t?.thumbnail?.url || null,
                url: t?.url || parsedUrl.toString(),
                unavailable: !t?.name
              }))
            };
          }
        }
      } catch (err) {
        this.logger.debug('play-dl Spotify metadata fetch failed, trying OpenGraph/oEmbed fallback', {
          error: err.message
        });
      }
    }

    if (classification.type === 'track' && typeof globalThis.fetch === 'function') {
      try {
        const cleanTrackUrl = `https://open.spotify.com/track/${classification.id}`;
        const oembedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(cleanTrackUrl)}`;
        const [oembedRes, pageRes] = await Promise.allSettled([
          globalThis.fetch(oembedUrl, { headers: { 'User-Agent': 'omni-discord-music/1.0' } }),
          globalThis.fetch(cleanTrackUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' }
          })
        ]);

        let title = null;
        let artist = null;
        let duration = null;
        let thumbnail = null;

        if (oembedRes.status === 'fulfilled' && oembedRes.value.ok) {
          const data = await oembedRes.value.json();
          title = data?.title || null;
          artist = data?.author_name || null;
          thumbnail = data?.thumbnail_url || null;
        }

        if (pageRes.status === 'fulfilled' && pageRes.value.ok) {
          const html = await pageRes.value.text();
          if (!title) {
            const ogTitle = html.match(/<meta property="og:title" content="([^"]+)"/i);
            if (ogTitle?.[1]) title = ogTitle[1];
          }
          if (!artist) {
            const musicianDesc = html.match(/<meta name="music:musician_description" content="([^"]+)"/i);
            const ogDesc = html.match(/<meta property="og:description" content="([^"]+)"/i);
            if (musicianDesc?.[1]) {
              artist = musicianDesc[1];
            } else if (ogDesc?.[1]) {
              artist = ogDesc[1].split('·')[0]?.trim() || null;
            }
          }
          const durMatch = html.match(/<meta name="music:duration" content="(\d+)"/i);
          if (durMatch?.[1]) {
            duration = Number.parseInt(durMatch[1], 10);
          }
        }

        if (title) {
          return {
            type: 'track',
            title,
            artist,
            duration,
            thumbnail
          };
        }
      } catch {
        // Handled below
      }
    }

    throw new ResolutionError(
      `Spotify metadata resolution unavailable for ${parsedUrl.toString()}.`,
      'Could not retrieve Spotify metadata. Ensure Spotify credentials or public metadata access is available.'
    );
  }

  async fetchAppleMusicMetadata(parsedUrl, classification) {
    if (typeof this.appleMusicMetadataResolver === 'function') {
      return this.appleMusicMetadataResolver(parsedUrl, classification);
    }

    const segments = parsedUrl.pathname.split('/').filter(Boolean);
    const country = /^[a-z]{2}$/i.test(segments[0] || '') ? segments[0].toLowerCase() : 'us';
    const lastSegment = segments[segments.length - 1] || '';
    const lookupId = classification.trackId || (/^\d+$/.test(lastSegment) ? lastSegment : null);

    if (lookupId && typeof globalThis.fetch === 'function') {
      try {
        const apiUrl = `https://itunes.apple.com/lookup?id=${encodeURIComponent(lookupId)}&country=${encodeURIComponent(country)}&entity=song`;
        const res = await globalThis.fetch(apiUrl, {
          headers: { 'User-Agent': 'omni-discord-music/1.0' }
        });
        if (res.ok) {
          const data = await res.json();
          const results = Array.isArray(data?.results) ? data.results : [];
          if (classification.type === 'track') {
            const trackItem = results.find((r) => r.wrapperType === 'track' || r.kind === 'song') || results[0];
            if (trackItem?.trackName) {
              return {
                type: 'track',
                title: trackItem.trackName,
                artist: trackItem.artistName || null,
                duration: trackItem.trackTimeMillis ? Math.round(trackItem.trackTimeMillis / 1000) : null,
                thumbnail: trackItem.artworkUrl100 || null
              };
            }
          } else if (results.length > 0) {
            const collection = results.find((r) => r.wrapperType === 'collection') || results[0];
            const songEntries = results.filter((r) => r.wrapperType === 'track' || r.kind === 'song');
            if (songEntries.length > 0) {
              return {
                type: classification.type,
                title: collection?.collectionName || 'Apple Music Album',
                thumbnail: collection?.artworkUrl100 || null,
                tracks: songEntries.map((song) => ({
                  title: song.trackName,
                  artist: song.artistName || null,
                  duration: song.trackTimeMillis ? Math.round(song.trackTimeMillis / 1000) : null,
                  thumbnail: song.artworkUrl100 || null,
                  url: song.trackViewUrl || parsedUrl.toString()
                }))
              };
            }
          }
        }
      } catch {
        // Fall through to error
      }
    }

    throw new ResolutionError(
      `Apple Music metadata resolution failed for ${parsedUrl.toString()}.`,
      'Could not resolve metadata for that Apple Music link.'
    );
  }

  assertDurationAllowed(durationSeconds, isLive = false) {
    if (isLive) {
      return;
    }
    const maxDuration = this.config.MAX_TRACK_DURATION_SECONDS;
    if (
      durationSeconds !== null &&
      durationSeconds !== undefined &&
      Number.isFinite(durationSeconds) &&
      maxDuration &&
      durationSeconds > maxDuration
    ) {
      throw new InvalidInputError(
        `Track duration (${durationSeconds}s) exceeds maximum allowed (${maxDuration}s).`,
        `This track is too long (${Math.round(durationSeconds / 60)} min). Maximum allowed duration is ${Math.round(maxDuration / 60)} minutes.`
      );
    }
  }
}

export const defaultResolver = new SourceResolver();

export async function resolveTrackOrPlaylist(input, options = {}) {
  return defaultResolver.resolve(input, options);
}

export default SourceResolver;
