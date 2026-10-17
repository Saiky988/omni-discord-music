import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SourceResolver,
  BoundedMetadataCache,
  selectBestSearchCandidate
} from '../src/services/resolver.js';
import {
  matchesDomain,
  parseAndValidateUrl,
  detectUrlPlatform
} from '../src/utils/urlSafety.js';
import {
  InvalidInputError,
  UnsafeUrlError,
  UnsupportedSourceError,
  UnsupportedMediaError
} from '../src/utils/errors.js';

function createMockResolver(overrides = {}) {
  const testConfig = {
    MAX_PLAYLIST_TRACKS: 3,
    MAX_TRACK_DURATION_SECONDS: 7200,
    PLAYLIST_CONCURRENCY: 2,
    METADATA_CACHE_TTL_MS: 60000,
    METADATA_CACHE_MAX_ENTRIES: 50,
    ALLOW_HTTP_MEDIA: false,
    ...(overrides.config || {})
  };

  const defaultYtdlpExtract = async (target, { allowPlaylist = false } = {}) => {
    if (target.startsWith('ytsearch1:')) {
      const q = target.slice('ytsearch1:'.length);
      return {
        id: 'yt123',
        title: `Resolved: ${q}`,
        uploader: 'Mock Artist',
        webpage_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
        duration: 212,
        is_live: false,
        formats: [{ acodec: 'opus', vcodec: 'none', ext: 'webm' }]
      };
    }

    if (allowPlaylist && target.includes('list=')) {
      return {
        _type: 'playlist',
        title: 'Mock YouTube Playlist',
        uploader: 'Playlist Creator',
        entries: [
          {
            id: 'v1',
            title: 'Track One',
            uploader: 'Artist 1',
            webpage_url: 'https://www.youtube.com/watch?v=11111111111',
            duration: 180
          },
          {
            id: 'v2',
            title: 'Track Two',
            uploader: 'Artist 2',
            webpage_url: 'https://www.youtube.com/watch?v=22222222222',
            duration: 200
          },
          {
            id: 'v3',
            title: 'Track Three',
            uploader: 'Artist 3',
            webpage_url: 'https://www.youtube.com/watch?v=33333333333',
            duration: 220
          },
          {
            id: 'v4',
            title: 'Track Four (Exceeds Limit)',
            uploader: 'Artist 4',
            webpage_url: 'https://www.youtube.com/watch?v=44444444444',
            duration: 240
          }
        ]
      };
    }

    if (target.includes('tiktok.com') && target.includes('photo-silent')) {
      return {
        id: 'tt_silent',
        title: 'Silent Photo Carousel',
        vcodec: 'none',
        acodec: 'none',
        formats: [{ vcodec: 'none', acodec: 'none', ext: 'jpg' }]
      };
    }

    if (target.includes('track-stations:')) {
      return {
        _type: 'playlist',
        title: 'Related tracks: Shared Single Song',
        entries: [
          {
            id: 'sc1',
            title: 'Shared Single Song (Demo)',
            uploader: 'Quinvy',
            webpage_url: 'https://soundcloud.com/quinvy/shared-single-song',
            duration: 190,
            formats: [{ acodec: 'mp3', ext: 'mp3' }]
          },
          {
            id: 'sc2',
            title: 'Unwanted Related Track 2',
            uploader: 'Other',
            webpage_url: 'https://soundcloud.com/other/related-2',
            duration: 210
          }
        ]
      };
    }

    return {
      id: 'direct_1',
      title: 'Direct Platform Track',
      uploader: 'Platform Uploader',
      webpage_url: target,
      thumbnail: 'https://example.com/thumb.jpg',
      duration: 195,
      is_live: false,
      formats: [{ acodec: 'mp4a.40.2', vcodec: 'avc1', ext: 'mp4' }]
    };
  };

  return new SourceResolver({
    config: testConfig,
    playDl: overrides.playDl ?? null,
    ytdlpExtract: overrides.ytdlpExtract || defaultYtdlpExtract,
    redirectResolver:
      overrides.redirectResolver ||
      (async (parsedUrl) => parsedUrl),
    spotifyMetadataResolver:
      overrides.spotifyMetadataResolver ||
      (async (_url, classification) => {
        if (classification.type === 'track') {
          return {
            type: 'track',
            title: 'Starboy',
            artist: 'The Weeknd',
            duration: 230,
            thumbnail: 'https://i.scdn.co/image/starboy.jpg'
          };
        }
        return {
          type: classification.type,
          title: 'Synthwave Essentials',
          thumbnail: 'https://i.scdn.co/image/playlist.jpg',
          tracks: [
            { title: 'Nightcall', artist: 'Kavinsky', duration: 258 },
            { title: 'Unavailable Song', artist: 'Ghost', unavailable: true },
            { title: 'Blinding Lights', artist: 'The Weeknd', duration: 200 },
            { title: 'Midnight City', artist: 'M83', duration: 243 },
            { title: 'Extra Track Beyond Cap', artist: 'Artist X', duration: 190 }
          ]
        };
      }),
    appleMusicMetadataResolver:
      overrides.appleMusicMetadataResolver ||
      (async (_url, classification) => {
        if (classification.type === 'track') {
          return {
            type: 'track',
            title: 'Severance Main Title',
            artist: 'Theodore Shapiro',
            duration: 162,
            thumbnail: 'https://is1-ssl.mzstatic.com/thumb.jpg'
          };
        }
        return {
          type: 'album',
          title: 'Apple Album',
          tracks: [
            { title: 'Apple Song 1', artist: 'Artist A', duration: 150 },
            { title: 'Apple Song 2', artist: 'Artist B', duration: 170 }
          ]
        };
      }),
    directMediaValidator:
      overrides.directMediaValidator ||
      (async (parsedUrl) => ({
        finalUrl: parsedUrl.toString(),
        contentType: 'audio/mpeg',
        validatedViaProbe: true
      }))
  });
}

test('Resolver — valid YouTube and YouTube Music URLs resolve to normalized contract', async () => {
  const resolver = createMockResolver();

  const ytResult = await resolver.resolve('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {
    requestedBy: 'alice#1234'
  });

  assert.equal(ytResult.kind, 'track');
  assert.equal(ytResult.title, 'Direct Platform Track');
  assert.equal(ytResult.source, 'youtube');
  assert.equal(ytResult.query, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(ytResult.duration, 195);
  assert.equal(ytResult.isLive, false);
  assert.equal(ytResult.requestedBy, 'alice#1234');

  const ytmResult = await resolver.resolve('https://music.youtube.com/watch?v=dQw4w9WgXcQ', {
    requestedBy: 'bob#5678'
  });
  assert.equal(ytmResult.source, 'youtube_music');
});

test('Resolver — Spotify track, duration-matched search candidate selection, and eager first-track playlist loading', async () => {
  const resolver = createMockResolver();

  const trackRes = await resolver.resolve(
    'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT',
    { requestedBy: 'user1' }
  );

  assert.equal(trackRes.kind, 'track');
  assert.equal(trackRes.title, 'Starboy');
  assert.equal(trackRes.artist, 'The Weeknd');
  assert.equal(trackRes.source, 'spotify');
  assert.equal(trackRes.isFallback, true);
  assert.notEqual(trackRes.query, 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT');
  assert.equal(trackRes.query, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');

  // Verify candidate scoring picks "chess" by "joyful" (124s) over "Brainy Chess" (489s)
  const bestCandidate = selectBestSearchCandidate(
    [
      {
        title: 'chess',
        channel: { name: 'Brainy Chess' },
        durationInSec: 489,
        url: 'https://www.youtube.com/watch?v=wrong_chess_video'
      },
      {
        title: 'joyful - chess (Official Audio)',
        channel: { name: 'joyful - Topic' },
        durationInSec: 124,
        url: 'https://www.youtube.com/watch?v=right_joyful_chess'
      }
    ],
    { title: 'chess', artist: 'joyful', duration: 124 }
  );
  assert.equal(bestCandidate.url, 'https://www.youtube.com/watch?v=right_joyful_chess');

  // Full synchronous playlist resolution
  const playlistRes = await resolver.resolve(
    'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
    { requestedBy: 'user1' }
  );

  assert.equal(playlistRes.kind, 'playlist');
  assert.equal(playlistRes.title, 'Synthwave Essentials');
  assert.equal(playlistRes.truncated, true);
  assert.equal(playlistRes.tracks.length, 2);
  assert.equal(playlistRes.skippedTracks, 3);

  // Eager first-track playlist resolution returns Track #1 immediately and loads Track #2 in background
  const eagerRes = await resolver.resolve(
    'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
    { requestedBy: 'user1', eagerFirstTrackOnly: true }
  );
  assert.equal(eagerRes.kind, 'playlist');
  assert.equal(eagerRes.tracks.length, 1);
  assert.equal(eagerRes.tracks[0].title, 'Nightcall');
  assert.equal(typeof eagerRes.backgroundTasks, 'function');

  const bgTracks = [];
  await eagerRes.backgroundTasks(async (t) => {
    bgTracks.push(t);
  });
  assert.equal(bgTracks.length, 1);
  assert.equal(bgTracks[0].title, 'Blinding Lights');
});

test('Resolver — SoundCloud mobile share (on.soundcloud.com -> track-stations) extracts single shared track immediately', async () => {
  const resolver = createMockResolver({
    redirectResolver: async () =>
      new URL('https://soundcloud.com/discover/sets/track-stations:123456789?si=abc')
  });

  const scShareRes = await resolver.resolve('https://on.soundcloud.com/YGk1ZFz55VOEQVeXkh', {
    requestedBy: 'nvirya'
  });

  assert.equal(scShareRes.kind, 'track');
  assert.equal(scShareRes.title, 'Shared Single Song (Demo)');
  assert.equal(scShareRes.artist, 'Quinvy');
  assert.equal(scShareRes.query, 'https://soundcloud.com/quinvy/shared-single-song');
});

test('Resolver — Apple Music track and album URLs resolve via fallback search', async () => {
  const resolver = createMockResolver();

  const songRes = await resolver.resolve(
    'https://music.apple.com/us/album/severance/1608469491?i=1608469495',
    { requestedBy: 'tester' }
  );
  assert.equal(songRes.kind, 'track');
  assert.equal(songRes.title, 'Severance Main Title');
  assert.equal(songRes.source, 'apple_music');
  assert.equal(songRes.isFallback, true);

  const albumRes = await resolver.resolve(
    'https://music.apple.com/us/album/severance/1608469491',
    { requestedBy: 'tester' }
  );
  assert.equal(albumRes.kind, 'playlist');
  assert.equal(albumRes.tracks.length, 2);
});

test('Resolver — SoundCloud, TikTok, Discord CDN, and silent photo carousel detection', async () => {
  const resolver = createMockResolver();

  const scRes = await resolver.resolve('https://soundcloud.com/artist/track-name');
  assert.equal(scRes.source, 'soundcloud');
  assert.equal(scRes.kind, 'track');

  const ttRes = await resolver.resolve('https://www.tiktok.com/@creator/video/7123456789');
  assert.equal(ttRes.source, 'tiktok');

  const cdnRes = await resolver.resolve(
    'https://cdn.discordapp.com/attachments/111/222/mysong.mp3?ex=123'
  );
  assert.equal(cdnRes.source, 'direct_media');
  assert.equal(cdnRes.title, 'mysong');

  await assert.rejects(
    () => resolver.resolve('https://www.tiktok.com/@creator/video/photo-silent'),
    (err) => err instanceof UnsupportedMediaError
  );
});

test('Resolver — Playlist limits enforced on extractor playlists', async () => {
  const resolver = createMockResolver();

  const pl = await resolver.resolve('https://www.youtube.com/playlist?list=PL1234567890');
  assert.equal(pl.kind, 'playlist');
  assert.equal(pl.truncated, true);
  assert.equal(pl.tracks.length, 3);
  assert.equal(pl.skippedTracks, 1);
  assert.equal(pl.tracks[0].title, 'Track One');
  assert.equal(pl.tracks[2].title, 'Track Three');
});

test('Resolver — Hostname spoofing attempts are rejected', async () => {
  const resolver = createMockResolver();

  assert.equal(matchesDomain('www.youtube.com', ['youtube.com']), true);
  assert.equal(matchesDomain('evil-youtube.com', ['youtube.com']), false);
  assert.equal(matchesDomain('youtube.com.attacker.com', ['youtube.com']), false);

  const spoofedUrls = [
    'https://evil-youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com.attacker.org/watch?v=dQw4w9WgXcQ',
    'https://open.spotify.com.phish.net/track/4cOdK2wGLETKBW3PvgPWqT',
    'https://not-tiktok.com/@user/video/123'
  ];

  for (const url of spoofedUrls) {
    const parsed = parseAndValidateUrl(url);
    assert.equal(detectUrlPlatform(parsed), 'unknown');
    await assert.rejects(
      () => resolver.resolve(url),
      (err) => err instanceof UnsupportedSourceError
    );
  }
});

test('Resolver — SSRF, private network, loopback, cloud metadata, and unsupported protocols are rejected', async () => {
  const resolver = createMockResolver();

  const unsafeTargets = [
    'http://127.0.0.1:8080/stream.mp3',
    'https://127.0.0.1/audio.mp3',
    'https://localhost/audio.mp3',
    'https://10.0.0.1/audio.mp3',
    'https://172.16.5.4/audio.mp3',
    'https://192.168.1.50/audio.mp3',
    'https://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'https://[::1]/audio.mp3',
    'https://[::ffff:127.0.0.1]/audio.mp3',
    'https://[::ffff:169.254.169.254]/audio.mp3',
    'https://[fe80::1]/audio.mp3',
    'https://[fd00::1]/audio.mp3',
    'https://2130706433/audio.mp3',
    'https://0x7f000001/audio.mp3',
    'https://0177.0.0.1/audio.mp3',
    'https://internal-service.local/audio.mp3',
    'https://redis/audio.mp3',
    'https://user:password@example.com/audio.mp3',
    'file:///etc/passwd',
    'ftp://example.com/audio.mp3',
    'javascript:alert(1)'
  ];

  for (const target of unsafeTargets) {
    await assert.rejects(
      () => resolver.resolve(target),
      (err) => err instanceof UnsafeUrlError || err instanceof InvalidInputError,
      `Expected target to be rejected: ${target}`
    );
  }
});

test('Resolver — Invalid search inputs and option injection are rejected', async () => {
  const resolver = createMockResolver();

  await assert.rejects(() => resolver.resolve(''), InvalidInputError);
  await assert.rejects(() => resolver.resolve('   '), InvalidInputError);
  await assert.rejects(() => resolver.resolve('a'), InvalidInputError);
  await assert.rejects(() => resolver.resolve('--exec rm -rf /'), InvalidInputError);
  await assert.rejects(() => resolver.resolve('-o /tmp/pwn'), InvalidInputError);
});

test('BoundedMetadataCache — evicts oldest entries when capacity is exceeded', () => {
  const cache = new BoundedMetadataCache({ maxEntries: 2, ttlMs: 10000 });
  cache.set('k1', { title: 'One' });
  cache.set('k2', { title: 'Two' });
  assert.deepEqual(cache.get('k1'), { title: 'One' });
  cache.set('k3', { title: 'Three' });

  assert.equal(cache.get('k2'), null);
  assert.deepEqual(cache.get('k1'), { title: 'One' });
  assert.deepEqual(cache.get('k3'), { title: 'Three' });
});
