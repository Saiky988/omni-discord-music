import { spawn as defaultSpawn } from 'node:child_process';
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
  DIRECT_MEDIA_EXTENSIONS
} from '../utils/urlSafety.js';

/**
 * Bounded TTL + LRU cache for resolved track/playlist metadata.
 */
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
    // Refresh LRU order
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

/**
 * Run async tasks with a strict concurrency cap while preserving deterministic input order.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<R>} mapper
 * @returns {Promise<R[]>}
 */
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

/**
 * Determine whether user input looks like a URL or URI scheme rather than a plain-text search query.
 */
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

/**
 * Normalize a single track into the canonical contract required across the bot.
 */
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
  originalSource = null
}) {
  const normalizedTitle = title && String(title).trim()
    ? String(title).trim()
    : 'Untitled Track';

  const normalizedDuration =
    duration !== null && duration !== undefined && Number.isFinite(Number(duration)) && Number(duration) >= 0
      ? Math.round(Number(duration))
      : null;

  const track = {
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
    originalSource: originalSource || null
  };

  return track;
}

/**
 * Wrap a single normalized track into a result envelope that exposes both top-level
 * single-track fields (title, query, source, thumbnail, duration, webpageUrl, isLive, requestedBy)
 * and explicit collection fields (kind: 'track', track, tracks: [track]).
 */
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

/**
 * Wrap multiple normalized tracks into an explicit playlist result contract.
 */
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
  warnings = []
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

/**
 * Default yt-dlp JSON metadata extractor using child_process.spawn with argument arrays.
 */
export function createYtdlpMetadataExtractor({
  spawnFn = defaultSpawn,
  ytdlpPath = config.YTDLP_PATH,
  timeoutMs = config.RESOLVE_TIMEOUT_MS,
  maxPlaylistTracks = config.MAX_PLAYLIST_TRACKS
} = {}) {
  return async function extractWithYtdlp(target, { allowPlaylist = false } = {}) {
    if (!target || typeof target !== 'string' || target.startsWith('-')) {
      throw new InvalidInputError('Invalid extraction target.');
    }

    const args = [
      '--dump-single-json',
      '--no-warnings',
      '--quiet',
      '--skip-download'
    ];

    if (allowPlaylist) {
      args.push('--flat-playlist', '--playlist-end', String(maxPlaylistTracks + 1));
    } else {
      args.push('--no-playlist');
    }

    args.push('--', target);

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
      const maxStdoutBytes = 5 * 1024 * 1024;
      const maxStderrBytes = 4096;
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          child.kill('SIGTERM');
        } catch {
          // Ignore kill errors
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
              'Could not resolve playable media from the provided input.'
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
  };
}

/**
 * Classify Spotify URL path into 'track' | 'album' | 'playlist'.
 */
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

/**
 * Classify Apple Music URL path into 'track' | 'album' | 'playlist'.
 */
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

/**
 * Determine whether a YouTube or SoundCloud URL represents a playlist.
 */
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
    return segments.includes('sets');
  }

  return false;
}

/**
 * Verify that yt-dlp metadata actually exposes an audio-capable format or stream
 * (protects against silent TikTok/Douyin photo carousels or image-only posts).
 */
export function assertPlayableAudioMetadata(meta, platform) {
  if (!meta || typeof meta !== 'object') {
    throw new ResolutionError('Empty metadata returned by extractor.');
  }

  if (Array.isArray(meta.formats) && meta.formats.length > 0) {
    const hasAudioFormat = meta.formats.some(
      (f) =>
        (f.acodec && f.acodec !== 'none') ||
        (typeof f.ext === 'string' && ['mp3', 'm4a', 'opus', 'ogg', 'wav', 'aac', 'flac'].includes(f.ext)) ||
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

/**
 * Create a configurable SourceResolver instance.
 * Supports full dependency injection for unit testing without live external services.
 */
export class SourceResolver {
  constructor(options = {}) {
    this.config = options.config || config;
    this.logger = (options.logger || defaultLogger).child?.('resolver') || defaultLogger;
    this.playDl = options.playDl !== undefined ? options.playDl : defaultPlayDl;
    this.ytdlpExtract =
      options.ytdlpExtract ||
      createYtdlpMetadataExtractor({
        spawnFn: options.spawnFn,
        ytdlpPath: this.config.YTDLP_PATH,
        timeoutMs: this.config.RESOLVE_TIMEOUT_MS,
        maxPlaylistTracks: this.config.MAX_PLAYLIST_TRACKS
      });
    this.spotifyMetadataResolver = options.spotifyMetadataResolver || null;
    this.appleMusicMetadataResolver = options.appleMusicMetadataResolver || null;
    this.directMediaValidator = options.directMediaValidator || validateDirectMediaUrl;
    this.cache =
      options.cache ||
      new BoundedMetadataCache({
        maxEntries: this.config.METADATA_CACHE_MAX_ENTRIES ?? 250,
        ttlMs: this.config.METADATA_CACHE_TTL_MS ?? 300000
      });
  }

  /**
   * Main entry point to resolve a user-supplied URL or search query.
   *
   * @param {string} rawInput
   * @param {object} [options]
   * @param {string} [options.requestedBy=null]
   * @returns {Promise<object>} Normalized track or playlist contract
   */
  async resolve(rawInput, options = {}) {
    const requestedBy = options.requestedBy ?? null;

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
      return this.resolveUrl(parsedUrl, { requestedBy });
    }

    // Check if the user passed something that looks like a bare internal host/IP exploit
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

  /**
   * Resolve a plain-text search query into a playable track via YouTube or SoundCloud search.
   */
  async resolveSearchQuery(queryText, { requestedBy = null, preferredFallback = 'youtube', originalMeta = null } = {}) {
    const cleanQuery = queryText.replace(/\s+/g, ' ').trim();
    if (!cleanQuery || cleanQuery.length < 2) {
      throw new InvalidInputError(
        'Search query is too short.',
        'Please enter at least 2 characters to search.'
      );
    }

    const cacheKey = `search:${preferredFallback}:${cleanQuery.toLowerCase()}`;
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

    // 1. Try play-dl YouTube search if available and healthy
    if (this.playDl && typeof this.playDl.search === 'function' && preferredFallback === 'youtube') {
      try {
        const results = await this.playDl.search(cleanQuery, {
          limit: 1,
          source: { youtube: 'video' }
        });
        if (Array.isArray(results) && results.length > 0 && results[0]?.url) {
          const item = results[0];
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
      } catch (err) {
        this.logger.debug('play-dl search failed, falling back to yt-dlp search', {
          query: cleanQuery,
          error: err.message
        });
      }
    }

    // 2. Extract via yt-dlp ytsearch1: or scsearch1:
    const searchPrefixes = preferredFallback === 'soundcloud'
      ? ['scsearch1', 'ytsearch1']
      : ['ytsearch1', 'scsearch1'];

    let lastError = null;
    for (const prefix of searchPrefixes) {
      try {
        const searchTarget = `${prefix}:${cleanQuery}`;
        const rawMeta = await this.ytdlpExtract(searchTarget, { allowPlaylist: false });
        const entry = Array.isArray(rawMeta?.entries) ? rawMeta.entries[0] : rawMeta;
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

        const resolvedSource = prefix === 'scsearch1' ? 'soundcloud' : 'youtube';
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
          isFallback: Boolean(originalMeta || prefix === 'scsearch1'),
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

  /**
   * Resolve a validated URL based on its detected platform.
   */
  async resolveUrl(parsedUrl, { requestedBy = null } = {}) {
    const platform = detectUrlPlatform(parsedUrl);
    if (platform === 'unknown') {
      throw new UnsupportedSourceError(
        `Unsupported URL host or media format: ${parsedUrl.hostname}`,
        'That domain or link format is not supported. Supported sources include YouTube, YouTube Music, Spotify, Apple Music, SoundCloud, TikTok, Douyin, Facebook, Instagram, and direct audio links.'
      );
    }

    if (platform === 'spotify') {
      return this.resolveSpotifyUrl(parsedUrl, { requestedBy });
    }

    if (platform === 'apple_music') {
      return this.resolveAppleMusicUrl(parsedUrl, { requestedBy });
    }

    if (platform === 'direct_media') {
      return this.resolveDirectMedia(parsedUrl, { requestedBy });
    }

    if (isPlaylistUrl(parsedUrl, platform)) {
      return this.resolveExtractorPlaylist(parsedUrl, platform, { requestedBy });
    }

    return this.resolveExtractorSingle(parsedUrl, platform, { requestedBy });
  }

  /**
   * Resolve a direct media URL (.mp3, .m4a, .flac, .wav, .ogg, .opus, .m3u8) after SSRF and header checks.
   */
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

  /**
   * Resolve a single track URL from YouTube, YouTube Music, SoundCloud, TikTok, Douyin, Facebook, or Instagram.
   */
  async resolveExtractorSingle(parsedUrl, platform, { requestedBy = null } = {}) {
    const urlStr = parsedUrl.toString();
    const cacheKey = `url:${urlStr}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      const track = createNormalizedTrack({
        ...cached,
        requestedBy
      });
      return wrapSingleTrackResult(track);
    }

    const meta = await this.ytdlpExtract(urlStr, { allowPlaylist: false });

    if (meta?._type === 'playlist' && Array.isArray(meta.entries)) {
      return this.buildPlaylistFromEntries(meta, platform, urlStr, requestedBy);
    }

    assertPlayableAudioMetadata(meta, platform);

    const duration = Number.isFinite(meta.duration) ? meta.duration : null;
    const isLive = Boolean(meta.is_live);
    this.assertDurationAllowed(duration, isLive);

    const webpageUrl = meta.webpage_url
      ? parseAndValidateUrl(meta.webpage_url, { allowHttp: Boolean(this.config.ALLOW_HTTP_MEDIA) }).toString()
      : urlStr;

    const baseData = {
      title: meta.title || meta.fulltitle || `${platform} Track`,
      artist: meta.artist || meta.uploader || meta.channel || meta.creator || null,
      query: urlStr,
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

  /**
   * Resolve a YouTube / YouTube Music / SoundCloud playlist URL.
   */
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
            title: entry.title || 'Untitled Track',
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

  /**
   * Resolve Spotify track, album, or playlist URLs.
   */
  async resolveSpotifyUrl(parsedUrl, { requestedBy = null } = {}) {
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
        ? `${metadata.artist} - ${metadata.title}`
        : metadata.title;

      return this.resolveSearchQuery(searchString, {
        requestedBy,
        originalMeta: {
          title: metadata.title,
          artist: metadata.artist || null,
          source: 'spotify',
          thumbnail: metadata.thumbnail || null,
          duration: metadata.duration ?? null,
          webpageUrl: parsedUrl.toString()
        }
      });
    }

    return this.resolveMetadataCollection(metadata, {
      platform: 'spotify',
      webpageUrl: parsedUrl.toString(),
      requestedBy
    });
  }

  /**
   * Resolve Apple Music track, album, or playlist URLs.
   */
  async resolveAppleMusicUrl(parsedUrl, { requestedBy = null } = {}) {
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
        ? `${metadata.artist} - ${metadata.title}`
        : metadata.title;

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
      requestedBy
    });
  }

  /**
   * Map a metadata collection (Spotify or Apple Music album/playlist) into playable tracks
   * in deterministic order with bounded concurrency and playlist size enforcement.
   */
  async resolveMetadataCollection(collectionMeta, { platform, webpageUrl, requestedBy }) {
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

    const mappedResults = await mapWithConcurrency(
      slice,
      this.config.PLAYLIST_CONCURRENCY || 3,
      async (item) => {
        if (!item || item.unavailable || !item.title) {
          return null;
        }
        const searchStr = item.artist ? `${item.artist} - ${item.title}` : item.title;
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
      }
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

  /**
   * Fetch Spotify metadata via injected resolver, play-dl, or Spotify public oEmbed endpoint.
   */
  async fetchSpotifyMetadata(parsedUrl, classification) {
    if (typeof this.spotifyMetadataResolver === 'function') {
      return this.spotifyMetadataResolver(parsedUrl, classification);
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
        this.logger.debug('play-dl Spotify metadata fetch failed, trying oEmbed fallback', {
          error: err.message
        });
      }
    }

    if (classification.type === 'track' && typeof globalThis.fetch === 'function') {
      try {
        const oembedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(parsedUrl.toString())}`;
        const res = await globalThis.fetch(oembedUrl, {
          headers: { 'User-Agent': 'omni-discord-music/1.0' }
        });
        if (res.ok) {
          const data = await res.json();
          if (data?.title) {
            return {
              type: 'track',
              title: data.title,
              artist: data.author_name || null,
              duration: null,
              thumbnail: data.thumbnail_url || null
            };
          }
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

  /**
   * Fetch Apple Music metadata via injected resolver or Apple iTunes Lookup API.
   */
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
