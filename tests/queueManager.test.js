import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { QueueManager } from '../src/services/queueManager.js';
import {
  AudioPlayerStatus,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  StreamType
} from '../src/utils/discordSdk.js';

function createTrack(id, title = `Track ${id}`) {
  return {
    title,
    artist: `Artist ${id}`,
    query: `https://www.youtube.com/watch?v=track_${id}`,
    source: 'youtube',
    thumbnail: null,
    duration: 180,
    webpageUrl: `https://www.youtube.com/watch?v=track_${id}`,
    isLive: false,
    requestedBy: `user_${id}`
  };
}

function createHarness(configOverrides = {}) {
  const createdSessions = [];
  const notifications = [];

  const testConfig = {
    DEFAULT_VOLUME: 80,
    MAX_VOLUME: 200,
    IDLE_TIMEOUT_MS: 80,
    MAX_QUEUE_SIZE: 10,
    VOICE_READY_TIMEOUT_MS: 500,
    VOICE_RECONNECT_ATTEMPTS: 2,
    MAX_CONSECUTIVE_FAILURES: 3,
    ...configOverrides
  };

  const createStreamFn = async (query, options = {}) => {
    if (query.includes('fail_extract')) {
      const err = new Error('Simulated extraction failure');
      err.userMessage = 'Track extraction failed.';
      throw err;
    }

    const stream = new PassThrough();
    const events = new EventEmitter();
    let cleanedUp = false;
    let cleanupReason = null;

    const resource = createAudioResource(stream, {
      inputType: StreamType.Raw,
      inlineVolume: true,
      metadata: options.metadata
    });

    const session = {
      sessionId: options.sessionId,
      query,
      resource,
      stream,
      events,
      get cleanedUp() {
        return cleanedUp;
      },
      get cleanupReason() {
        return cleanupReason;
      },
      async cleanup(reason = 'dispose') {
        cleanedUp = true;
        cleanupReason = reason;
        if (!stream.destroyed) {
          stream.destroy();
        }
        return { sessionId: options.sessionId, status: 'cancelled', reason };
      },
      getState() {
        return {
          sessionId: options.sessionId,
          status: cleanedUp ? 'cancelled' : 'streaming'
        };
      }
    };

    createdSessions.push(session);
    return session;
  };

  const queueManager = new QueueManager({
    config: testConfig,
    createStreamFn,
    createPlayerFn: createAudioPlayer,
    sendChannelMessage: async (guildId, channelId, payload) => {
      notifications.push({ guildId, channelId, payload });
    }
  });

  return { queueManager, createdSessions, notifications };
}

test('QueueManager — strict multi-guild isolation', async () => {
  const { queueManager } = createHarness();

  await queueManager.enqueue('guild-A', [createTrack('A1'), createTrack('A2')], {
    voiceChannelId: 'vc-A'
  });
  await queueManager.enqueue('guild-B', [createTrack('B1')], {
    voiceChannelId: 'vc-B'
  });

  queueManager.setVolume('guild-A', 120);
  queueManager.setLoopMode('guild-A', 'track');
  queueManager.pause('guild-A');

  const snapA = queueManager.getSnapshot('guild-A');
  const snapB = queueManager.getSnapshot('guild-B');

  assert.equal(snapA.currentTrack.title, 'Track A1');
  assert.equal(snapA.upcomingCount, 1);
  assert.equal(snapA.volume, 120);
  assert.equal(snapA.loopMode, 'track');
  assert.equal(snapA.state, 'paused');

  // Guild B must be completely unaffected by Guild A's actions
  assert.equal(snapB.currentTrack.title, 'Track B1');
  assert.equal(snapB.upcomingCount, 0);
  assert.equal(snapB.volume, 80);
  assert.equal(snapB.loopMode, 'off');
  assert.equal(snapB.state, 'playing');

  await queueManager.shutdownAll();
});

test('QueueManager — FIFO progression and natural transition to idle', async () => {
  const { queueManager, createdSessions } = createHarness();

  await queueManager.enqueue('guild-1', [createTrack('1'), createTrack('2')], {
    voiceChannelId: 'vc-1'
  });

  assert.equal(queueManager.getSnapshot('guild-1').currentTrack.title, 'Track 1');
  assert.equal(queueManager.getSnapshot('guild-1').upcomingCount, 1);

  const queue = queueManager.getQueue('guild-1');
  // Simulate natural completion of Track 1
  await queueManager.handleNaturalTrackCompletion(queue, queue.activeSessionId);

  assert.equal(createdSessions[0].cleanedUp, true);
  assert.equal(queueManager.getSnapshot('guild-1').currentTrack.title, 'Track 2');
  assert.equal(queueManager.getSnapshot('guild-1').upcomingCount, 0);

  // Simulate natural completion of Track 2 -> transitions to idle and starts idle timer
  await queueManager.handleNaturalTrackCompletion(queue, queue.activeSessionId);
  const finalSnap = queueManager.getSnapshot('guild-1');
  assert.equal(finalSnap.currentTrack, null);
  assert.equal(finalSnap.state, 'idle');
  assert.equal(finalSnap.hasIdleTimer, true);

  await queueManager.shutdownAll();
});

test('QueueManager — loop-track and loop-queue modes behave deterministically', async () => {
  const { queueManager } = createHarness();

  await queueManager.enqueue('guild-loop', [createTrack('1'), createTrack('2')], {
    voiceChannelId: 'vc-loop'
  });

  const queue = queueManager.getQueue('guild-loop');

  // 1. Track loop mode: replays Track 1 without duplicating it in queue.tracks
  queueManager.setLoopMode('guild-loop', 'track');
  await queueManager.handleNaturalTrackCompletion(queue, queue.activeSessionId);

  let snap = queueManager.getSnapshot('guild-loop');
  assert.equal(snap.currentTrack.title, 'Track 1');
  assert.equal(snap.upcomingCount, 1);
  assert.equal(snap.tracks[0].title, 'Track 2');

  // 2. Skip while in track loop mode MUST NOT replay the skipped track
  const skipRes = await queueManager.skip('guild-loop');
  assert.equal(skipRes.skippedTrack.title, 'Track 1');
  assert.equal(skipRes.nextTrack.title, 'Track 2');

  // 3. Queue loop mode: appends finished track to the end and advances FIFO
  queueManager.setLoopMode('guild-loop', 'queue');
  await queueManager.enqueue('guild-loop', createTrack('3'));
  // Now playing Track 2, upcoming: [Track 3]
  await queueManager.handleNaturalTrackCompletion(queue, queue.activeSessionId);

  snap = queueManager.getSnapshot('guild-loop');
  assert.equal(snap.currentTrack.title, 'Track 3');
  assert.equal(snap.upcomingCount, 1);
  assert.equal(snap.tracks[0].title, 'Track 2');

  await queueManager.shutdownAll();
});

test('QueueManager — stop clears queue, resets loop mode, kills stream, and starts idle timer', async () => {
  const { queueManager, createdSessions } = createHarness();

  await queueManager.enqueue('guild-stop', [createTrack('1'), createTrack('2'), createTrack('3')], {
    voiceChannelId: 'vc-stop'
  });
  queueManager.setLoopMode('guild-stop', 'queue');

  const stopRes = await queueManager.stop('guild-stop');
  assert.equal(stopRes.clearedCount, 2);
  assert.equal(createdSessions[0].cleanedUp, true);
  assert.equal(createdSessions[0].cleanupReason, 'stop');

  const snap = stopRes.snapshot;
  assert.equal(snap.currentTrack, null);
  assert.equal(snap.upcomingCount, 0);
  assert.equal(snap.loopMode, 'off');
  assert.equal(snap.state, 'idle');
  assert.equal(snap.hasIdleTimer, true);

  await queueManager.shutdownAll();
});

test('QueueManager — prevents duplicate advancement and ignores stale session events', async () => {
  const { queueManager } = createHarness();

  await queueManager.enqueue('guild-dup', [createTrack('1'), createTrack('2'), createTrack('3')], {
    voiceChannelId: 'vc-dup'
  });

  const queue = queueManager.getQueue('guild-dup');
  const firstSessionId = queue.activeSessionId;

  // Fire natural completion twice with the same sessionId
  await Promise.all([
    queueManager.handleNaturalTrackCompletion(queue, firstSessionId),
    queueManager.handleNaturalTrackCompletion(queue, firstSessionId)
  ]);

  // Should have advanced only once (to Track 2), leaving Track 3 in upcoming queue
  const snap = queueManager.getSnapshot('guild-dup');
  assert.equal(snap.currentTrack.title, 'Track 2');
  assert.equal(snap.upcomingCount, 1);
  assert.equal(snap.tracks[0].title, 'Track 3');

  // Late failure event from firstSessionId must be ignored
  await queueManager.handleSessionFailure(queue, firstSessionId, new Error('Stale error'));
  assert.equal(queueManager.getSnapshot('guild-dup').currentTrack.title, 'Track 2');

  await queueManager.shutdownAll();
});

test('QueueManager — idle timer disconnects after timeout and cancels when new track is added', async () => {
  const { queueManager } = createHarness({ IDLE_TIMEOUT_MS: 50 });

  await queueManager.enqueue('guild-idle', [createTrack('1')], {
    voiceChannelId: 'vc-idle'
  });

  await queueManager.stop('guild-idle');
  assert.equal(queueManager.getSnapshot('guild-idle').hasIdleTimer, true);

  // Enqueueing new work before timeout cancels the timer
  await queueManager.enqueue('guild-idle', [createTrack('2')], {
    voiceChannelId: 'vc-idle'
  });
  assert.equal(queueManager.getSnapshot('guild-idle').hasIdleTimer, false);

  // Stop again and let the 50ms idle timer expire
  await queueManager.stop('guild-idle');
  await new Promise((resolve) => setTimeout(resolve, 90));

  assert.equal(queueManager.getQueue('guild-idle'), null);
  assert.equal(queueManager.getSnapshot('guild-idle').exists, false);
});

test('QueueManager — bounded consecutive failure policy skips broken tracks and halts after limit', async () => {
  const { queueManager, notifications } = createHarness({ MAX_CONSECUTIVE_FAILURES: 2 });

  const broken1 = { ...createTrack('bad1'), query: 'https://www.youtube.com/watch?v=fail_extract_1' };
  const broken2 = { ...createTrack('bad2'), query: 'https://www.youtube.com/watch?v=fail_extract_2' };
  const good3 = createTrack('good3');

  await queueManager.enqueue('guild-fail', [broken1, broken2, good3], {
    voiceChannelId: 'vc-fail'
  });

  const snap = queueManager.getSnapshot('guild-fail');
  // Because broken1 and broken2 both failed consecutively (reaching MAX_CONSECUTIVE_FAILURES = 2),
  // progression halted before starting good3
  assert.equal(snap.currentTrack, null);
  assert.equal(snap.state, 'idle');
  assert.equal(snap.upcomingCount, 1);
  assert.equal(snap.tracks[0].title, 'Track good3');
  assert.equal(notifications.length, 2);

  await queueManager.shutdownAll();
});

test('QueueManager — voice connection recovery succeeds on transient disconnect and destroys on permanent failure', async () => {
  const { queueManager, notifications } = createHarness({
    VOICE_RECONNECT_ATTEMPTS: 2,
    VOICE_READY_TIMEOUT_MS: 60
  });

  await queueManager.enqueue('guild-vc', [createTrack('1')], {
    voiceChannelId: 'vc-1'
  });

  const queue = queueManager.getQueue('guild-vc');
  const connection = queue.connection;

  // Simulate transient disconnect that recovers to Ready
  setTimeout(() => {
    connection.setStatus(VoiceConnectionStatus.Connecting);
    connection.setStatus(VoiceConnectionStatus.Ready);
  }, 10);

  connection.setStatus(VoiceConnectionStatus.Disconnected);
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(queue.state, 'playing');
  assert.equal(queue.reconnectAttempts, 0);

  // Now simulate permanent disconnect that never recovers
  connection.rejoin = () => false;
  connection.setStatus(VoiceConnectionStatus.Disconnected);
  await new Promise((resolve) => setTimeout(resolve, 220));

  assert.equal(queueManager.getQueue('guild-vc'), null);
  assert.ok(notifications.length >= 1);
});

test('QueueManager — live bassboost, nightcore, and speed filters hot-reload active playback', async () => {
  const { queueManager, createdSessions } = createHarness();

  await queueManager.enqueue('guild-fx', [createTrack('1')], {
    voiceChannelId: 'vc-fx'
  });
  assert.equal(createdSessions.length, 1);

  const bbRes = await queueManager.setBassboost('guild-fx', 'high');
  assert.equal(bbRes.bassboost, 'high');
  assert.equal(createdSessions.length, 2);

  const ncRes = await queueManager.setNightcore('guild-fx', 'on');
  assert.equal(ncRes.nightcore, true);
  assert.equal(createdSessions.length, 3);

  const spRes = await queueManager.setSpeed('guild-fx', 1.35);
  assert.equal(spRes.speed, 1.35);
  assert.equal(createdSessions.length, 4);

  await queueManager.shutdownAll();
});
