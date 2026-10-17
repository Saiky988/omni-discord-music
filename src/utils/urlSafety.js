import net from 'node:net';
import dns from 'node:dns/promises';
import { UnsafeUrlError, InvalidInputError, UnsupportedSourceError } from './errors.js';

/**
 * Explicit platform hostname registry.
 * Never uses substring matching like hostname.includes('youtube.com').
 */
export const PLATFORM_DOMAINS = Object.freeze({
  youtube_music: ['music.youtube.com'],
  youtube: ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'],
  spotify: ['open.spotify.com', 'play.spotify.com', 'spotify.link'],
  apple_music: ['music.apple.com', 'itunes.apple.com'],
  soundcloud: ['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com', 'on.soundcloud.com'],
  tiktok: ['tiktok.com', 'www.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com', 'm.tiktok.com'],
  douyin: ['douyin.com', 'www.douyin.com', 'v.douyin.com', 'iesdouyin.com'],
  facebook: ['facebook.com', 'www.facebook.com', 'm.facebook.com', 'web.facebook.com', 'fb.watch'],
  instagram: ['instagram.com', 'www.instagram.com', 'ddinstagram.com'],
  discord_cdn: ['cdn.discordapp.com', 'media.discordapp.net']
});

export const DIRECT_MEDIA_EXTENSIONS = Object.freeze([
  '.mp3',
  '.m4a',
  '.flac',
  '.wav',
  '.ogg',
  '.opus',
  '.aac',
  '.m3u8',
  '.mp4',
  '.webm'
]);

export const ALLOWED_MEDIA_CONTENT_TYPES = Object.freeze([
  'audio/',
  'video/',
  'application/ogg',
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'application/octet-stream',
  'binary/octet-stream'
]);

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'kubernetes',
  'kubernetes.default',
  'kubernetes.default.svc',
  'kubernetes.default.svc.cluster.local',
  '0.0.0.0',
  '127.0.0.1',
  '::1',
  '::'
]);

const BLOCKED_HOSTNAME_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.intranet',
  '.home.arpa',
  '.localdomain',
  '.lan',
  '.corp',
  '.cluster.local'
];

export function normalizeHostname(rawHostname) {
  if (!rawHostname || typeof rawHostname !== 'string') {
    return '';
  }
  let host = rawHostname.trim().toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }
  return host;
}

export function matchesDomain(hostname, allowedDomains) {
  const normalized = normalizeHostname(hostname);
  if (!normalized) {
    return false;
  }

  for (const domain of allowedDomains) {
    const target = domain.toLowerCase();
    if (normalized === target || normalized.endsWith(`.${target}`)) {
      return true;
    }
  }
  return false;
}

export function isObfuscatedIpLiteral(hostname) {
  const host = normalizeHostname(hostname);
  if (!host) return false;

  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) {
    return true;
  }

  const parts = host.split('.');
  if (parts.length >= 2 && parts.length <= 4 && parts.every((p) => /^(0x[0-9a-f]+|\d+)$/i.test(p))) {
    if (parts.length !== 4) {
      return true;
    }
    for (const part of parts) {
      if (/^0x/i.test(part) || (part.length > 1 && part.startsWith('0'))) {
        return true;
      }
    }
  }

  return false;
}

export function isPrivateOrReservedIPv4(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) {
    return true;
  }

  const octets = parts.map((p) => Number.parseInt(p, 10));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }

  const [a, b, c] = octets;

  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 192 && b === 88 && c === 99) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;

  return false;
}

export function isPrivateOrReservedIPv6(rawIp) {
  const ip = normalizeHostname(rawIp).split('%')[0];
  if (!ip || ip === '::' || ip === '::1' || ip === '0:0:0:0:0:0:0:1' || ip === '0:0:0:0:0:0:0:0') {
    return true;
  }

  if (ip.includes('.')) {
    const lastColon = ip.lastIndexOf(':');
    const ipv4Part = ip.slice(lastColon + 1);
    if (net.isIPv4(ipv4Part)) {
      return isPrivateOrReservedIPv4(ipv4Part);
    }
    return true;
  }

  const normalizedHex = ip.replace(/^0+:0+:0+:0+:0+:ffff:/, '::ffff:');
  if (normalizedHex.startsWith('::ffff:')) {
    const rest = normalizedHex.slice(7);
    const groups = rest.split(':');
    if (groups.length === 2) {
      const high = Number.parseInt(groups[0], 16);
      const low = Number.parseInt(groups[1], 16);
      if (Number.isInteger(high) && Number.isInteger(low)) {
        const reconstructedIpv4 = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
        return isPrivateOrReservedIPv4(reconstructedIpv4);
      }
    }
  }

  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true;
  if (/^fe[89ab][0-9a-f]:/i.test(ip)) return true;
  if (/^ff[0-9a-f]{2}:/i.test(ip)) return true;
  if (/^2001:0?db8:/i.test(ip)) return true;

  return false;
}

export function isUnsafeIpAddress(ip) {
  const clean = normalizeHostname(ip);
  const version = net.isIP(clean);
  if (version === 4) {
    return isPrivateOrReservedIPv4(clean);
  }
  if (version === 6) {
    return isPrivateOrReservedIPv6(clean);
  }
  return true;
}

export function parseAndValidateUrl(rawUrl, options = {}) {
  const { allowHttp = false } = options;

  if (!rawUrl || typeof rawUrl !== 'string') {
    throw new InvalidInputError('URL must be a non-empty string.');
  }

  const trimmed = rawUrl.trim();
  if (trimmed.length > 2048 || /[\0\r\n\s]/.test(trimmed)) {
    throw new InvalidInputError('URL is malformed or contains invalid control characters.');
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new InvalidInputError('The provided URL is malformed.');
  }

  const allowedProtocols = allowHttp ? ['https:', 'http:'] : ['https:'];
  if (!allowedProtocols.includes(parsed.protocol)) {
    throw new UnsafeUrlError(
      `Unsupported or unsafe URL protocol "${parsed.protocol}".`,
      allowHttp
        ? 'Only HTTPS and explicitly enabled HTTP URLs are supported.'
        : 'Only HTTPS URLs are supported.'
    );
  }

  if (parsed.username || parsed.password) {
    throw new UnsafeUrlError(
      'URLs containing embedded credentials are not permitted.',
      'URLs with embedded usernames or passwords are rejected for security.'
    );
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (!hostname) {
    throw new InvalidInputError('URL is missing a valid hostname.');
  }

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new UnsafeUrlError(
      `Blocked internal/loopback hostname "${hostname}".`,
      'Localhost and internal service URLs are not permitted.'
    );
  }

  if (BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    throw new UnsafeUrlError(
      `Blocked internal domain suffix on "${hostname}".`,
      'Internal and local-network domain names are not permitted.'
    );
  }

  if (isObfuscatedIpLiteral(hostname)) {
    throw new UnsafeUrlError(
      `Blocked obfuscated IP address literal "${hostname}".`,
      'Obfuscated IP literals are not permitted.'
    );
  }

  const ipVersion = net.isIP(hostname);
  if (ipVersion !== 0) {
    if (isUnsafeIpAddress(hostname)) {
      throw new UnsafeUrlError(
        `Blocked private, loopback, or reserved IP address "${hostname}".`,
        'Private network, loopback, and link-local IP addresses are not permitted.'
      );
    }
  } else {
    if (!hostname.includes('.')) {
      throw new UnsafeUrlError(
        `Blocked single-label internal hostname "${hostname}".`,
        'Single-label internal hostnames are not permitted.'
      );
    }
    const labels = hostname.split('.');
    const tld = labels[labels.length - 1];
    if (!/^[a-z]{2,63}$|^xn--[a-z0-9-]{2,59}$/i.test(tld)) {
      throw new UnsafeUrlError(
        `Invalid top-level domain on hostname "${hostname}".`,
        'The URL hostname does not have a valid public domain.'
      );
    }
  }

  return parsed;
}

/**
 * Identify the platform of a validated URL using strict hostname boundary checks.
 */
export function detectUrlPlatform(parsedUrl) {
  const hostname = normalizeHostname(parsedUrl.hostname);

  if (matchesDomain(hostname, PLATFORM_DOMAINS.youtube_music)) {
    return 'youtube_music';
  }
  if (matchesDomain(hostname, PLATFORM_DOMAINS.youtube)) {
    return 'youtube';
  }
  if (matchesDomain(hostname, PLATFORM_DOMAINS.spotify)) {
    return 'spotify';
  }
  if (matchesDomain(hostname, PLATFORM_DOMAINS.apple_music)) {
    return 'apple_music';
  }
  if (matchesDomain(hostname, PLATFORM_DOMAINS.soundcloud)) {
    return 'soundcloud';
  }
  if (matchesDomain(hostname, PLATFORM_DOMAINS.tiktok)) {
    return 'tiktok';
  }
  if (matchesDomain(hostname, PLATFORM_DOMAINS.douyin)) {
    return 'douyin';
  }
  if (matchesDomain(hostname, PLATFORM_DOMAINS.facebook)) {
    return 'facebook';
  }
  if (matchesDomain(hostname, PLATFORM_DOMAINS.instagram)) {
    return 'instagram';
  }

  const lowerPath = parsedUrl.pathname.toLowerCase();
  if (DIRECT_MEDIA_EXTENSIONS.some((ext) => lowerPath.endsWith(ext))) {
    return 'direct_media';
  }

  // Support Discord CDN attachments and signed CDN URLs with media extensions or mime params
  if (matchesDomain(hostname, PLATFORM_DOMAINS.discord_cdn)) {
    return 'direct_media';
  }

  const formatParam = (
    parsedUrl.searchParams.get('format') ||
    parsedUrl.searchParams.get('ext') ||
    parsedUrl.searchParams.get('mime') ||
    ''
  ).toLowerCase();
  if (
    formatParam &&
    (DIRECT_MEDIA_EXTENSIONS.some((ext) => formatParam === ext.slice(1) || formatParam.endsWith(ext)) ||
      formatParam.startsWith('audio/') ||
      formatParam.startsWith('video/'))
  ) {
    return 'direct_media';
  }

  return 'unknown';
}

export async function assertPublicDnsResolution(hostname, lookupFn = dns.lookup) {
  const cleanHost = normalizeHostname(hostname);
  if (net.isIP(cleanHost)) {
    if (isUnsafeIpAddress(cleanHost)) {
      throw new UnsafeUrlError(`IP address "${cleanHost}" is private or reserved.`);
    }
    return [cleanHost];
  }

  let records;
  try {
    records = await lookupFn(cleanHost, { all: true, verbatim: true });
  } catch (err) {
    throw new UnsafeUrlError(
      `DNS resolution failed for "${cleanHost}": ${err.message}`,
      'Could not verify the remote host address.'
    );
  }

  const list = Array.isArray(records) ? records : [records];
  if (list.length === 0) {
    throw new UnsafeUrlError(`No DNS records found for "${cleanHost}".`);
  }

  for (const record of list) {
    const address = typeof record === 'string' ? record : record?.address;
    if (!address || isUnsafeIpAddress(address)) {
      throw new UnsafeUrlError(
        `Hostname "${cleanHost}" resolved to a restricted or private IP address (${address || 'unknown'}).`,
        'The target host resolves to an internal or restricted network address.'
      );
    }
  }

  return list.map((r) => (typeof r === 'string' ? r : r.address));
}

/**
 * Safely resolve redirect hops for shortlinks (such as on.soundcloud.com, vt.tiktok.com, vm.tiktok.com)
 * while enforcing SSRF checks on every hop.
 */
export async function resolveRedirectUrlSafely(initialUrl, options = {}) {
  const {
    allowHttp = false,
    maxRedirects = 4,
    timeoutMs = 6000,
    fetchFn = globalThis.fetch,
    lookupFn = dns.lookup
  } = options;

  let currentUrl = initialUrl instanceof URL
    ? parseAndValidateUrl(initialUrl.toString(), { allowHttp })
    : parseAndValidateUrl(String(initialUrl), { allowHttp });

  if (typeof fetchFn !== 'function') {
    return currentUrl;
  }

  for (let hop = 0; hop < maxRedirects; hop += 1) {
    await assertPublicDnsResolution(currentUrl.hostname, lookupFn);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();

    let response;
    try {
      response = await fetchFn(currentUrl.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
        }
      });
    } catch {
      clearTimeout(timer);
      return currentUrl;
    } finally {
      clearTimeout(timer);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers?.get?.('location');
      if (!location) {
        return currentUrl;
      }
      try {
        const nextCandidate = new URL(location, currentUrl);
        currentUrl = parseAndValidateUrl(nextCandidate.toString(), { allowHttp });
        continue;
      } catch {
        return currentUrl;
      }
    }

    return currentUrl;
  }

  return currentUrl;
}

/**
 * Probe and validate a direct media URL, revalidating any redirect hops against SSRF rules
 * and verifying that the final response exposes a valid audio/media Content-Type.
 * Falls back to a ranged GET probe (`Range: bytes=0-0`) when a CDN rejects `HEAD` requests (403/405).
 */
export async function validateDirectMediaUrl(initialUrl, options = {}) {
  const {
    allowHttp = false,
    maxRedirects = 4,
    timeoutMs = 8000,
    fetchFn = globalThis.fetch,
    lookupFn = dns.lookup
  } = options;

  let currentUrl = initialUrl instanceof URL
    ? parseAndValidateUrl(initialUrl.toString(), { allowHttp })
    : parseAndValidateUrl(String(initialUrl), { allowHttp });

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    await assertPublicDnsResolution(currentUrl.hostname, lookupFn);

    if (typeof fetchFn !== 'function') {
      return {
        finalUrl: currentUrl.toString(),
        contentType: null,
        validatedViaProbe: false
      };
    }

    const probeOnce = async (method, extraHeaders = {}) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();
      try {
        return await fetchFn(currentUrl.toString(), {
          method,
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) omni-discord-music/1.0',
            ...extraHeaders
          }
        });
      } finally {
        clearTimeout(timer);
      }
    };

    let response;
    try {
      response = await probeOnce('HEAD');
      // Many signed CDNs (S3, Discord CDN, CloudFront, Akamai) reject HEAD with 403/405
      if (response.status === 403 || response.status === 405 || response.status === 501) {
        response = await probeOnce('GET', { Range: 'bytes=0-0' });
      }
    } catch (err) {
      throw new UnsupportedSourceError(
        `Failed to reach direct media URL: ${err.message}`,
        'Could not reach or validate the direct media URL.'
      );
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (hop >= maxRedirects) {
        throw new UnsafeUrlError(
          'Direct media URL exceeded maximum allowed redirect hops.',
          'The media URL redirected too many times.'
        );
      }

      const location = response.headers?.get?.('location');
      if (!location) {
        throw new UnsupportedSourceError(
          'Redirect response missing Location header.',
          'The media URL returned an invalid redirect.'
        );
      }

      let nextUrl;
      try {
        nextUrl = new URL(location, currentUrl);
      } catch {
        throw new UnsafeUrlError('Redirect Location header is malformed.');
      }

      currentUrl = parseAndValidateUrl(nextUrl.toString(), { allowHttp });
      continue;
    }

    if (response.status >= 400) {
      throw new UnsupportedSourceError(
        `Direct media URL returned HTTP ${response.status}.`,
        `The direct media link is inaccessible (HTTP ${response.status}).`
      );
    }

    const contentType = (response.headers?.get?.('content-type') || '').toLowerCase();
    if (contentType) {
      const isAllowedMedia = ALLOWED_MEDIA_CONTENT_TYPES.some((prefix) =>
        contentType.startsWith(prefix) || contentType.includes(prefix)
      );
      if (!isAllowedMedia && contentType.includes('text/html')) {
        throw new UnsupportedSourceError(
          `Direct media URL returned HTML content-type (${contentType}) instead of an audio stream.`,
          'That link points to a web page rather than a direct audio stream.'
        );
      }
    }

    return {
      finalUrl: currentUrl.toString(),
      contentType: contentType || null,
      validatedViaProbe: true
    };
  }

  throw new UnsafeUrlError('Redirect validation failed.');
}
