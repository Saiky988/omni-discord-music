import crypto from 'node:crypto';
import config from '../config.js';
import {
  AudioPlayerStatus,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
  createAudioPlayer as defaultCreateAudioPlayer,
  joinVoiceChannel as defaultJoinVoiceChannel,
  entersState as defaultEntersState
} from '../utils/discordSdk.js';
import { createAudioStream as defaultCreateAudioStream } from './streamer.js';
import { logger as defaultLogger } from '../utils/logger.js';
import {
  ErrorCodes,
  QueueOperationError
} from '../utils/errors.js';
import {
  buildNowPlayingEmbed,
  buildExtractionFailureEmbed,
  buildConnectionRecoveryFailureEmbed,
  buildPlayerControlRow
} from '../utils/embeds.js';

export const VALID_LOOP_MODES = Object.freeze(['off', 'track', 'queue']);

/**
 * Per-guild isolated queue and playback lifecycle manager.
 */
export class QueueManager {
  constructor(options = {}) {
    this.config = options.config || config;
    this.logger = (options.logger || defaultLogger).child?.('queueManager') || defaultLogger;
    this.createStreamFn = options.createStreamFn || defaultCreateAudioStream;
    this.createPlayerFn = options.createPlayerFn || defaultCreateAudioPlayer;
    this.joinVoiceFn = options.joinVoiceFn || defaultJoinVoiceChannel;
    this.entersStateFn = options.entersStateFn || defaultEntersState;
    this.sendChannelMessage = options.sendChannelMessage || null;

    /** @type {Map<string, object>} */
    this.queues = new Map();
    this.shuttingDown = false;
  }

  getQueue(guildId) {
    if (!guildId) return null;
    return this.queues.get(String(guildId)) || null;
  }

  getSnapshot(guildId) {
    const queue = this.getQueue(guildId);
    if (!queue) {
      return {
        guildId: String(guildId),
        exists: false,
        voiceChannelId: null,
        textChannelId: null,
        state: 'idle',
        loopMode: 'off',
        volume: this.config.DEFAULT_VOLUME ?? 100,
        currentTrack: null,
        tracks: [],
        upcomingCount: 0,
        consecutiveFailures: 0,
        hasIdleTimer: false
      };
    }

    return {
      guildId: queue.guildId,
      exists: true,
      voiceChannelId: queue.voiceChannelId,
      textChannelId: queue.textChannelId,
      state: queue.state,
      loopMode: queue.loopMode,
      volume: queue.volume,
      currentTrack: queue.currentTrack ? { ...queue.currentTrack } : null,
      tracks: queue.tracks.map((t) => ({ ...t })),
      upcomingCount: queue.tracks.length,
      consecutiveFailures: queue.consecutiveFailures,
      hasIdleTimer: Boolean(queue.idleTimer),
      activeSessionId: queue.activeSessionId
    };
  }

  getOrCreateQueue(guildId, meta = {}) {
    if (this.shuttingDown) {
      throw new QueueOperationError('Bot is currently shutting down and not accepting new requests.', {
        code: ErrorCodes.SHUTTING_DOWN
      });
    }

    const key = String(guildId || '').trim();
    if (!key) {
      throw new QueueOperationError('A valid guildId is required.', {
        code: ErrorCodes.INVALID_STATE
      });
    }

    let queue = this.queues.get(key);
    if (queue && queue.state !== 'destroyed') {
      if (meta.textChannelId) queue.textChannelId = meta.textChannelId;
      if (meta.textChannel) queue.textChannel = meta.textChannel;
      if (meta.voiceChannelId && !queue.voiceChannelId) {
        queue.voiceChannelId = meta.voiceChannelId;
      }
      return queue;
    }

    const player = this.createPlayerFn({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause
      }
    });

    queue = {
      guildId: key,
      voiceChannelId: meta.voiceChannelId || null,
      textChannelId: meta.textChannelId || null,
      textChannel: meta.textChannel || null,
      tracks: [],
      currentTrack: null,
      player,
      connection: null,
      currentSession: null,
      activeSessionId: null,
      handledSessionIds: new Set(),
      volume: this.config.DEFAULT_VOLUME ?? 100,
      loopMode: 'off',
      idleTimer: null,
      state: 'idle',
      consecutiveFailures: 0,
      reconnectAttempts: 0,
      recoveringConnection: false,
      transitionPromise: null,
      announceNowPlayingOnNextTrack: false
    };

    this.attachPlayerListeners(queue);
    this.queues.set(key, queue);

    this.logger.info('Initialized guild queue', {
      guildId: key,
      defaultVolume: queue.volume
    });

    return queue;
  }

  attachPlayerListeners(queue) {
    const { player, guildId } = queue;

    player.on('stateChange', (oldState, newState) => {
      if (queue.state === 'destroyed') {
        return;
      }

      const nextStatus = newState?.status;
      this.logger.debug('AudioPlayer state transition', {
        guildId,
        from: oldState?.status,
        to: nextStatus,
        sessionId: queue.activeSessionId
      });

      if (nextStatus === AudioPlayerStatus.Buffering) {
        queue.state = 'buffering';
      } else if (nextStatus === AudioPlayerStatus.Playing) {
        queue.state = 'playing';
        queue.consecutiveFailures = 0;
        this.clearIdleTimer(queue);
      } else if (nextStatus === AudioPlayerStatus.Paused) {
        queue.state = 'paused';
      } else if (nextStatus === AudioPlayerStatus.AutoPaused) {
        queue.state = 'autopaused';
      } else if (nextStatus === AudioPlayerStatus.Idle) {
        const sessionId =
          oldState?.resource?.metadata?.sessionId ||
          queue.activeSessionId;

        if (!sessionId || queue.handledSessionIds.has(sessionId)) {
          return;
        }

        const sessionState = queue.currentSession?.getState?.();
        if (sessionState?.status === 'failed') {
          void this.handleSessionFailure(
            queue,
            sessionId,
            sessionState.failureError || new Error('Stream failed prior to Idle transition.')
          );
          return;
        }

        void this.handleNaturalTrackCompletion(queue, sessionId);
      }
    });

    player.on('error', (err) => {
      if (queue.state === 'destroyed') {
        return;
      }
      const sessionId = err?.resource?.metadata?.sessionId || queue.activeSessionId;
      this.logger.warn('AudioPlayer emitted error', {
        guildId,
        sessionId,
        error: err.message
      });
      void this.handleSessionFailure(queue, sessionId, err);
    });
  }

  async ensureVoiceConnection(queue, { voiceChannelId, adapterCreator }) {
    if (!voiceChannelId) {
      throw new QueueOperationError('User must be in a voice channel.', {
        code: ErrorCodes.VOICE_NOT_CONNECTED,
        userMessage: 'You need to join a voice channel before playing music.'
      });
    }

    if (
      queue.connection &&
      queue.voiceChannelId &&
      queue.voiceChannelId !== voiceChannelId &&
      queue.connection.state?.status !== VoiceConnectionStatus.Destroyed &&
      (queue.currentTrack || queue.tracks.length > 0)
    ) {
      throw new QueueOperationError('User is in a different voice channel from the bot.', {
        code: ErrorCodes.VOICE_CHANNEL_MISMATCH,
        userMessage: 'You must be in the same voice channel as the bot to control playback.'
      });
    }

    const existingStatus = queue.connection?.state?.status;
    if (
      queue.connection &&
      existingStatus &&
      existingStatus !== VoiceConnectionStatus.Destroyed
    ) {
      queue.voiceChannelId = voiceChannelId;
      if (existingStatus !== VoiceConnectionStatus.Ready) {
        await this.entersStateFn(
          queue.connection,
          VoiceConnectionStatus.Ready,
          this.config.VOICE_READY_TIMEOUT_MS
        );
      }
      return queue.connection;
    }

    queue.state = 'connecting';
    queue.voiceChannelId = voiceChannelId;

    const connection = this.joinVoiceFn({
      channelId: voiceChannelId,
      guildId: queue.guildId,
      adapterCreator: adapterCreator || (() => ({ sendPayload: () => true, destroy: () => {} })),
      selfDeaf: true,
      selfMute: false,
      debug: this.config.LOG_LEVEL === 'debug'
    });

    queue.connection = connection;
    this.attachConnectionListeners(queue, connection);
    connection.subscribe(queue.player);

    try {
      await this.entersStateFn(
        connection,
        VoiceConnectionStatus.Ready,
        this.config.VOICE_READY_TIMEOUT_MS
      );
      queue.reconnectAttempts = 0;
      return connection;
    } catch (err) {
      const lastState = connection.state?.status || 'unknown';
      const networkingCode = connection.state?.networking?.state?.code ?? null;
      this.logger.error('VoiceConnection failed to reach Ready state before timeout', {
        guildId: queue.guildId,
        voiceChannelId,
        lastVoiceState: lastState,
        networkingStateCode: networkingCode,
        timeoutMs: this.config.VOICE_READY_TIMEOUT_MS,
        hint: 'Ensure @discordjs/voice >= 0.19.0 and @snazzah/davey are installed on Node.js 22.12+ for Discord DAVE E2EE voice handshakes, and outbound UDP is open.'
      });
      await this.destroyGuildQueue(queue.guildId, 'voice_connect_timeout');
      throw new QueueOperationError(
        `Voice connection failed to reach Ready state within ${this.config.VOICE_READY_TIMEOUT_MS}ms (stuck in "${lastState}", networking=${networkingCode}): ${err.message}`,
        {
          code: ErrorCodes.VOICE_RECOVERY_FAILED,
          userMessage: 'Could not establish a voice connection in that channel. Please check my permissions and server voice dependencies.',
          cause: err
        }
      );
    }
  }

  attachConnectionListeners(queue, connection) {
    const { guildId } = queue;

    connection.on('debug', (msg) => {
      this.logger.debug('VoiceConnection protocol debug', {
        guildId,
        detail: msg
      });
    });

    connection.on('stateChange', async (oldState, newState) => {
      if (queue.state === 'destroyed' || queue.connection !== connection) {
        return;
      }

      const nextStatus = newState?.status;
      this.logger.debug('VoiceConnection state transition', {
        guildId,
        from: oldState?.status,
        to: nextStatus
      });

      if (nextStatus === VoiceConnectionStatus.Ready) {
        queue.reconnectAttempts = 0;
        queue.recoveringConnection = false;
        if (queue.state === 'recovering') {
          queue.state = queue.currentTrack ? 'playing' : 'idle';
        }
        return;
      }

      if (nextStatus === VoiceConnectionStatus.Disconnected) {
        if (queue.recoveringConnection) {
          return;
        }
        queue.recoveringConnection = true;
        queue.state = 'recovering';

        const maxAttempts = this.config.VOICE_RECONNECT_ATTEMPTS ?? 3;
        const readyTimeoutMs = this.config.VOICE_READY_TIMEOUT_MS || 20000;
        const signalingTimeoutMs = Math.min(5000, readyTimeoutMs);

        while (queue.reconnectAttempts < maxAttempts && queue.state !== 'destroyed') {
          queue.reconnectAttempts += 1;
          this.logger.warn('Attempting voice connection recovery', {
            guildId,
            attempt: queue.reconnectAttempts,
            maxAttempts
          });

          try {
            await Promise.race([
              this.entersStateFn(connection, VoiceConnectionStatus.Signalling, signalingTimeoutMs),
              this.entersStateFn(connection, VoiceConnectionStatus.Connecting, signalingTimeoutMs)
            ]);
            await this.entersStateFn(
              connection,
              VoiceConnectionStatus.Ready,
              readyTimeoutMs
            );
            queue.reconnectAttempts = 0;
            queue.recoveringConnection = false;
            if (queue.state === 'recovering') {
              queue.state = queue.currentTrack ? 'playing' : 'idle';
            }
            this.logger.info('Voice connection recovered', { guildId });
            return;
          } catch {
            if (queue.reconnectAttempts < maxAttempts && typeof connection.rejoin === 'function') {
              try {
                connection.rejoin();
              } catch {
                // Ignore rejoin error
              }
            }
          }
        }

        queue.recoveringConnection = false;
        this.logger.error('Voice connection recovery failed after bounded attempts', {
          guildId,
          attempts: queue.reconnectAttempts
        });
        await this.notifyGuildChannel(queue, {
          embeds: [buildConnectionRecoveryFailureEmbed()]
        });
        await this.destroyGuildQueue(guildId, 'connection_recovery_failed');
      } else if (nextStatus === VoiceConnectionStatus.Destroyed) {
        if (queue.state !== 'destroyed') {
          await this.destroyGuildQueue(guildId, 'connection_destroyed');
        }
      }
    });

    connection.on('error', (err) => {
      this.logger.warn('VoiceConnection error event', {
        guildId,
        error: err.message
      });
    });
  }

  async enqueue(guildId, tracksOrSingle, options = {}) {
    const incoming = Array.isArray(tracksOrSingle) ? tracksOrSingle : [tracksOrSingle];
    if (incoming.length === 0 || !incoming[0]) {
      throw new QueueOperationError('No valid tracks provided to enqueue.', {
        code: ErrorCodes.INVALID_STATE
      });
    }

    const queue = this.getOrCreateQueue(guildId, {
      voiceChannelId: options.voiceChannelId,
      textChannelId: options.textChannelId,
      textChannel: options.textChannel
    });

    if (options.voiceChannelId) {
      await this.ensureVoiceConnection(queue, {
        voiceChannelId: options.voiceChannelId,
        adapterCreator: options.adapterCreator
      });
    }

    this.clearIdleTimer(queue);

    const maxQueueSize = this.config.MAX_QUEUE_SIZE || 500;
    const isCurrentlyIdle =
      !queue.currentTrack &&
      (queue.state === 'idle' || queue.state === 'connecting' || queue.state === 'stopped');

    let trackToStartImmediately = null;
    let candidatesForQueue = incoming;

    if (isCurrentlyIdle) {
      trackToStartImmediately = incoming[0];
      candidatesForQueue = incoming.slice(1);
    }

    const availableSlots = Math.max(0, maxQueueSize - queue.tracks.length);
    if (!trackToStartImmediately && availableSlots === 0) {
      throw new QueueOperationError(
        `Queue is full (maximum ${maxQueueSize} tracks).`,
        {
          code: ErrorCodes.QUEUE_FULL,
          userMessage: `The server queue is full (maximum ${maxQueueSize} tracks). Remove or play some tracks first.`
        }
      );
    }

    const acceptedForQueue = candidatesForQueue.slice(0, availableSlots);
    const droppedByQueueLimit = candidatesForQueue.length - acceptedForQueue.length;

    queue.tracks.push(...acceptedForQueue);

    if (trackToStartImmediately) {
      await this.startTrackPlayback(queue, trackToStartImmediately, {
        announce: false
      });

      return {
        startedPlayback: true,
        activeTrack: queue.currentTrack,
        addedCount: 1 + acceptedForQueue.length,
        droppedByQueueLimit,
        queuePosition: 0,
        snapshot: this.getSnapshot(guildId)
      };
    }

    const firstQueuedPosition = queue.tracks.length - acceptedForQueue.length + 1;
    return {
      startedPlayback: false,
      activeTrack: queue.currentTrack,
      addedCount: acceptedForQueue.length,
      droppedByQueueLimit,
      queuePosition: firstQueuedPosition,
      snapshot: this.getSnapshot(guildId)
    };
  }

  async startTrackPlayback(queue, track, { announce = false } = {}) {
    if (queue.state === 'destroyed' || this.shuttingDown) {
      return;
    }

    this.clearIdleTimer(queue);

    if (queue.currentSession) {
      const prevSession = queue.currentSession;
      if (prevSession.sessionId) {
        queue.handledSessionIds.add(prevSession.sessionId);
      }
      queue.currentSession = null;
      await prevSession.cleanup('replaced');
    }

    const sessionId = crypto.randomUUID();
    queue.activeSessionId = sessionId;
    queue.currentTrack = track;
    queue.state = 'buffering';

    this.logger.info('Starting track playback', {
      guildId: queue.guildId,
      sessionId,
      title: track.title,
      source: track.source
    });

    let streamSession;
    try {
      streamSession = await this.createStreamFn(track.query, {
        sessionId,
        volume: queue.volume,
        metadata: {
          guildId: queue.guildId,
          sessionId,
          trackTitle: track.title
        },
        logger: this.logger
      });
    } catch (err) {
      await this.handleSessionFailure(queue, sessionId, err);
      return;
    }

    if (queue.activeSessionId !== sessionId || queue.state === 'destroyed') {
      await streamSession.cleanup('superseded');
      return;
    }

    queue.currentSession = streamSession;

    streamSession.events?.once?.('failed', (err) => {
      if (queue.activeSessionId !== sessionId || queue.handledSessionIds.has(sessionId)) {
        return;
      }
      void this.handleSessionFailure(queue, sessionId, err);
    });

    try {
      queue.player.play(streamSession.resource);
      queue.state = 'playing';
      if (announce) {
        const snap = this.getSnapshot(queue.guildId);
        await this.notifyGuildChannel(queue, {
          embeds: [buildNowPlayingEmbed(track, snap)],
          components: [buildPlayerControlRow(snap)]
        });
      }
    } catch (err) {
      await this.handleSessionFailure(queue, sessionId, err);
    }
  }

  async handleNaturalTrackCompletion(queue, sessionId) {
    if (
      queue.state === 'destroyed' ||
      !sessionId ||
      sessionId !== queue.activeSessionId ||
      queue.handledSessionIds.has(sessionId)
    ) {
      return;
    }

    queue.handledSessionIds.add(sessionId);
    queue.consecutiveFailures = 0;

    const finishedTrack = queue.currentTrack;
    const prevSession = queue.currentSession;
    queue.currentSession = null;

    if (prevSession) {
      await prevSession.cleanup('completed');
    }

    await this.advanceQueue(queue, {
      reason: 'natural',
      finishedTrack
    });
  }

  async handleSessionFailure(queue, sessionId, error) {
    if (
      queue.state === 'destroyed' ||
      (sessionId && queue.handledSessionIds.has(sessionId)) ||
      (sessionId && queue.activeSessionId && sessionId !== queue.activeSessionId)
    ) {
      return;
    }

    if (sessionId) {
      queue.handledSessionIds.add(sessionId);
    }

    const failedTrack = queue.currentTrack;
    const prevSession = queue.currentSession;
    queue.currentSession = null;

    if (prevSession) {
      await prevSession.cleanup('error');
    }

    queue.consecutiveFailures += 1;
    const maxFailures = this.config.MAX_CONSECUTIVE_FAILURES ?? 3;

    this.logger.warn('Track playback failed', {
      guildId: queue.guildId,
      sessionId,
      title: failedTrack?.title,
      consecutiveFailures: queue.consecutiveFailures,
      maxFailures,
      error: error?.message
    });

    await this.notifyGuildChannel(queue, {
      embeds: [
        buildExtractionFailureEmbed(
          failedTrack?.title || 'Unknown Track',
          error?.userMessage || 'The audio stream could not be extracted or was interrupted.'
        )
      ]
    });

    if (queue.consecutiveFailures >= maxFailures) {
      this.logger.error('Halting queue progression after reaching consecutive failure limit', {
        guildId: queue.guildId,
        consecutiveFailures: queue.consecutiveFailures
      });
      queue.currentTrack = null;
      queue.activeSessionId = null;
      queue.state = 'idle';
      try {
        queue.player.stop(true);
      } catch {
        // Ignore stop error
      }
      this.startIdleTimer(queue);
      return;
    }

    await this.advanceQueue(queue, {
      reason: 'error',
      finishedTrack: failedTrack
    });
  }

  async advanceQueue(queue, { reason = 'natural', finishedTrack = null } = {}) {
    if (queue.state === 'destroyed' || this.shuttingDown) {
      return null;
    }

    let nextTrack = null;

    if (reason === 'natural') {
      if (queue.loopMode === 'track' && finishedTrack) {
        nextTrack = finishedTrack;
      } else if (queue.loopMode === 'queue' && finishedTrack) {
        queue.tracks.push({ ...finishedTrack });
        nextTrack = queue.tracks.shift() || null;
      } else {
        nextTrack = queue.tracks.shift() || null;
      }
    } else if (reason === 'skip') {
      nextTrack = queue.tracks.shift() || null;
    } else {
      nextTrack = queue.tracks.shift() || null;
    }

    if (!nextTrack) {
      queue.currentTrack = null;
      queue.activeSessionId = null;
      queue.state = 'idle';
      this.startIdleTimer(queue);
      return null;
    }

    await this.startTrackPlayback(queue, nextTrack, {
      announce: reason === 'natural'
    });

    return nextTrack;
  }

  pause(guildId) {
    const queue = this.getQueue(guildId);
    if (!queue || !queue.currentTrack || queue.state !== 'playing') {
      throw new QueueOperationError('Nothing is currently playing to pause.', {
        code: ErrorCodes.INVALID_STATE,
        userMessage: 'There is no active track playing right now.'
      });
    }

    const paused = queue.player.pause();
    if (!paused && queue.player.state?.status !== AudioPlayerStatus.Paused) {
      throw new QueueOperationError('Could not pause the current track.', {
        code: ErrorCodes.INVALID_STATE,
        userMessage: 'Unable to pause playback in its current state.'
      });
    }

    queue.state = 'paused';
    return {
      track: { ...queue.currentTrack },
      snapshot: this.getSnapshot(guildId)
    };
  }

  resume(guildId) {
    const queue = this.getQueue(guildId);
    if (!queue || !queue.currentTrack) {
      throw new QueueOperationError('Nothing is currently paused to resume.', {
        code: ErrorCodes.INVALID_STATE,
        userMessage: 'There is no paused track to resume.'
      });
    }

    if (queue.state !== 'paused' && queue.state !== 'autopaused') {
      throw new QueueOperationError('Playback is not paused.', {
        code: ErrorCodes.INVALID_STATE,
        userMessage: 'Playback is already active and not paused.'
      });
    }

    const resumed = queue.player.unpause();
    if (!resumed && queue.player.state?.status !== AudioPlayerStatus.Playing) {
      throw new QueueOperationError('Failed to resume playback.', {
        code: ErrorCodes.INVALID_STATE,
        userMessage: 'Could not resume the paused track.'
      });
    }

    queue.state = 'playing';
    this.clearIdleTimer(queue);
    return {
      track: { ...queue.currentTrack },
      snapshot: this.getSnapshot(guildId)
    };
  }

  async skip(guildId) {
    const queue = this.getQueue(guildId);
    if (!queue || !queue.currentTrack) {
      throw new QueueOperationError('Nothing is currently playing to skip.', {
        code: ErrorCodes.QUEUE_EMPTY,
        userMessage: 'There is no active track to skip.'
      });
    }

    const skippedTrack = { ...queue.currentTrack };
    const sessionId = queue.activeSessionId;
    if (sessionId) {
      queue.handledSessionIds.add(sessionId);
    }

    const prevSession = queue.currentSession;
    queue.currentSession = null;

    if (prevSession) {
      await prevSession.cleanup('skip');
    }

    try {
      queue.player.stop(true);
    } catch {
      // Ignore stop error
    }

    const nextTrack = await this.advanceQueue(queue, {
      reason: 'skip',
      finishedTrack: skippedTrack
    });

    return {
      skippedTrack,
      nextTrack: nextTrack ? { ...nextTrack } : null,
      snapshot: this.getSnapshot(guildId)
    };
  }

  async stop(guildId) {
    const queue = this.getQueue(guildId);
    if (!queue || (!queue.currentTrack && queue.tracks.length === 0)) {
      throw new QueueOperationError('Nothing is playing and the queue is already empty.', {
        code: ErrorCodes.QUEUE_EMPTY,
        userMessage: 'Playback is already stopped and the queue is empty.'
      });
    }

    const clearedCount = queue.tracks.length;
    const sessionId = queue.activeSessionId;
    if (sessionId) {
      queue.handledSessionIds.add(sessionId);
    }

    queue.tracks = [];
    queue.currentTrack = null;
    queue.activeSessionId = null;
    queue.loopMode = 'off';
    queue.consecutiveFailures = 0;

    const prevSession = queue.currentSession;
    queue.currentSession = null;
    if (prevSession) {
      await prevSession.cleanup('stop');
    }

    try {
      queue.player.stop(true);
    } catch {
      // Ignore stop error
    }

    queue.state = 'idle';
    this.startIdleTimer(queue);

    return {
      clearedCount,
      snapshot: this.getSnapshot(guildId)
    };
  }

  setVolume(guildId, rawVolume) {
    const parsed = Number(rawVolume);
    const maxVolume = this.config.MAX_VOLUME ?? 200;

    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0 || parsed > maxVolume) {
      throw new QueueOperationError(
        `Volume must be an integer between 0 and ${maxVolume}.`,
        {
          code: ErrorCodes.VOLUME_OUT_OF_RANGE,
          userMessage: `Please provide a whole number volume between 0% and ${maxVolume}%.`
        }
      );
    }

    const queue = this.getOrCreateQueue(guildId);
    const activeResource = queue.currentSession?.resource;

    if (activeResource) {
      if (!activeResource.volume) {
        throw new QueueOperationError(
          'The current audio resource does not support inline volume adjustment.',
          {
            code: ErrorCodes.VOLUME_UNSUPPORTED,
            userMessage: 'Volume adjustment is not supported for the current audio stream.'
          }
        );
      }

      const ratio = parsed / 100;
      if (typeof activeResource.volume.setVolume === 'function') {
        activeResource.volume.setVolume(ratio);
      } else if (typeof activeResource.volume.setVolumeLogarithmic === 'function') {
        activeResource.volume.setVolumeLogarithmic(ratio);
      }
    }

    queue.volume = parsed;
    return {
      volume: queue.volume,
      snapshot: this.getSnapshot(guildId)
    };
  }

  setLoopMode(guildId, mode) {
    const normalized = String(mode || '').trim().toLowerCase();
    if (!VALID_LOOP_MODES.includes(normalized)) {
      throw new QueueOperationError(
        `Invalid loop mode "${mode}". Expected one of: ${VALID_LOOP_MODES.join(', ')}.`,
        {
          code: ErrorCodes.INVALID_INPUT,
          userMessage: 'Invalid loop mode. Choose `off`, `track`, or `queue`.'
        }
      );
    }

    const queue = this.getQueue(guildId);
    if (!queue || (!queue.currentTrack && queue.tracks.length === 0)) {
      throw new QueueOperationError(
        'Cannot change loop mode when nothing is playing.',
        {
          code: ErrorCodes.QUEUE_EMPTY,
          userMessage: 'Start playing a track before changing the loop mode.'
        }
      );
    }

    queue.loopMode = normalized;
    return {
      loopMode: queue.loopMode,
      snapshot: this.getSnapshot(guildId)
    };
  }

  startIdleTimer(queue) {
    if (!queue || queue.state === 'destroyed') {
      return;
    }

    this.clearIdleTimer(queue);
    const timeoutMs = this.config.IDLE_TIMEOUT_MS ?? 180000;

    queue.idleTimer = setTimeout(() => {
      queue.idleTimer = null;
      if (!queue.currentTrack && queue.tracks.length === 0 && queue.state !== 'destroyed') {
        this.logger.info('Idle timeout reached; disconnecting and removing guild queue', {
          guildId: queue.guildId,
          timeoutMs
        });
        void this.destroyGuildQueue(queue.guildId, 'idle_timeout');
      }
    }, timeoutMs);

    queue.idleTimer.unref?.();
  }

  clearIdleTimer(queue) {
    if (queue?.idleTimer) {
      clearTimeout(queue.idleTimer);
      queue.idleTimer = null;
    }
  }

  async notifyGuildChannel(queue, payload) {
    try {
      if (typeof this.sendChannelMessage === 'function') {
        await this.sendChannelMessage(queue.guildId, queue.textChannelId, payload);
        return;
      }
      if (queue.textChannel && typeof queue.textChannel.send === 'function') {
        await queue.textChannel.send(payload);
      }
    } catch (err) {
      this.logger.debug('Could not send notification to guild text channel', {
        guildId: queue.guildId,
        error: err.message
      });
    }
  }

  async destroyGuildQueue(guildId, reason = 'destroy') {
    const key = String(guildId || '');
    const queue = this.queues.get(key);
    if (!queue) {
      return false;
    }

    this.queues.delete(key);
    queue.state = 'destroyed';
    this.clearIdleTimer(queue);

    if (queue.activeSessionId) {
      queue.handledSessionIds.add(queue.activeSessionId);
    }

    queue.tracks = [];
    queue.currentTrack = null;
    queue.activeSessionId = null;

    const prevSession = queue.currentSession;
    queue.currentSession = null;
    if (prevSession) {
      await prevSession.cleanup(reason);
    }

    try {
      queue.player.removeAllListeners?.();
      queue.player.stop(true);
    } catch {
      // Ignore player cleanup error
    }

    if (queue.connection) {
      try {
        queue.connection.removeAllListeners?.();
        if (queue.connection.state?.status !== VoiceConnectionStatus.Destroyed) {
          queue.connection.destroy();
        }
      } catch {
        // Ignore connection destroy error
      }
      queue.connection = null;
    }

    this.logger.info('Destroyed guild queue', { guildId: key, reason });
    return true;
  }

  async shutdownAll() {
    this.shuttingDown = true;
    const guildIds = Array.from(this.queues.keys());
    await Promise.allSettled(
      guildIds.map((guildId) => this.destroyGuildQueue(guildId, 'shutdown'))
    );
  }
}

export const defaultQueueManager = new QueueManager();
export default QueueManager;
