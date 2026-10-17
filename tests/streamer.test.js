import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn as realSpawn } from 'node:child_process';
import {
  createAudioStream,
  buildYtdlpArgs,
  buildFfmpegArgs,
  validateExtractionTarget,
  HIGH_QUALITY_AUDIO_FILTER
} from '../src/services/streamer.js';
import { ErrorCodes, InvalidInputError, StreamExtractionError } from '../src/utils/errors.js';
import { StreamType } from '../src/utils/discordSdk.js';

function createMockChildProcess({ autoCloseOnKill = true } = {}) {
  const proc = new EventEmitter();
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.exitCode = null;
  proc.signalCode = null;
  proc.killed = false;
  proc.killSignals = [];

  proc.kill = (signal = 'SIGTERM') => {
    proc.killed = true;
    proc.killSignals.push(signal);
    if (autoCloseOnKill && proc.exitCode === null && proc.signalCode === null) {
      proc.signalCode = signal;
      queueMicrotask(() => {
        proc.emit('exit', null, signal);
        proc.emit('close', null, signal);
      });
    }
    return true;
  };

  return proc;
}

test('Streamer — builds high-quality yt-dlp and ffmpeg arguments and rejects unsafe targets', () => {
  const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  assert.deepEqual(buildYtdlpArgs(url), [
    '-f',
    'bestaudio/best',
    '--no-playlist',
    '--quiet',
    '--no-warnings',
    '--no-check-certificates',
    '--geo-bypass',
    '--force-ipv4',
    '--js-runtimes',
    'node',
    '--extractor-args',
    'youtube:player_client=default,android_vr,tv,web_safari,mweb',
    '-o',
    '-',
    url
  ]);

  assert.deepEqual(buildFfmpegArgs(), [
    '-i',
    'pipe:0',
    '-analyzeduration',
    '0',
    '-probesize',
    '32768',
    '-loglevel',
    '0',
    '-af',
    HIGH_QUALITY_AUDIO_FILTER,
    '-f',
    's16le',
    '-ar',
    '48000',
    '-ac',
    '2',
    'pipe:1'
  ]);

  assert.throws(() => validateExtractionTarget('--exec id'), InvalidInputError);
  assert.throws(() => validateExtractionTarget('plain search text without url'), Error);
  assert.equal(validateExtractionTarget('ytsearch1:daft punk'), 'ytsearch1:daft punk');
});

test('Streamer — successful process creation, PCM streaming, and natural completion', async () => {
  const spawnedCalls = [];
  const ytdlpProc = createMockChildProcess();
  const ffmpegProc = createMockChildProcess();

  ffmpegProc.stdin.on('data', (chunk) => {
    ffmpegProc.stdout.write(chunk);
  });

  const mockSpawn = (cmd, args, opts) => {
    spawnedCalls.push({ cmd, args, opts });
    return spawnedCalls.length === 1 ? ytdlpProc : ffmpegProc;
  };

  const session = await createAudioStream('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {
    spawnFn: mockSpawn,
    volume: 100
  });

  assert.equal(spawnedCalls.length, 2);
  assert.equal(spawnedCalls[0].opts.shell, false);
  assert.equal(spawnedCalls[1].opts.shell, false);
  assert.equal(session.resource.inputType, StreamType.Raw);

  const completedPromise = new Promise((resolve) => {
    session.events.once('completed', resolve);
  });

  const pcmSample = Buffer.alloc(3840, 1);
  ytdlpProc.stdout.write(pcmSample);
  ytdlpProc.stdout.end();
  ytdlpProc.exitCode = 0;
  ytdlpProc.emit('close', 0, null);

  ffmpegProc.stdout.end();
  ffmpegProc.exitCode = 0;
  ffmpegProc.emit('close', 0, null);

  const completionInfo = await completedPromise;
  assert.equal(completionInfo.pcmBytes, 3840);
  assert.equal(session.getState().status, 'completed');
});

test('Streamer — missing executable (ENOENT) rejects with EXECUTABLE_MISSING', async () => {
  const ytdlpProc = createMockChildProcess();
  const ffmpegProc = createMockChildProcess();

  const mockSpawn = (_cmd, _args) => {
    queueMicrotask(() => {
      const err = new Error('spawn yt-dlp ENOENT');
      err.code = 'ENOENT';
      ytdlpProc.emit('error', err);
    });
    return ytdlpProc;
  };

  await assert.rejects(
    () =>
      createAudioStream('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {
        spawnFn: (() => {
          let count = 0;
          return (cmd, args) => {
            count += 1;
            return count === 1 ? mockSpawn(cmd, args) : ffmpegProc;
          };
        })()
      }),
    (err) =>
      err instanceof StreamExtractionError &&
      err.code === ErrorCodes.EXECUTABLE_MISSING
  );
});

test('Streamer — synchronous spawn failure cleans up already-spawned yt-dlp process', async () => {
  const ytdlpProc = createMockChildProcess();
  let callCount = 0;

  const mockSpawn = () => {
    callCount += 1;
    if (callCount === 1) {
      return ytdlpProc;
    }
    const err = new Error('spawn ffmpeg ENOENT');
    err.code = 'ENOENT';
    throw err;
  };

  await assert.rejects(
    () =>
      createAudioStream('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {
        spawnFn: mockSpawn
      }),
    (err) => err instanceof StreamExtractionError && err.code === ErrorCodes.EXECUTABLE_MISSING
  );

  assert.equal(ytdlpProc.killed, true);
});

test('Streamer — non-zero exit code emits failed event and cleans up processes', async () => {
  const ytdlpProc = createMockChildProcess();
  const ffmpegProc = createMockChildProcess();
  let count = 0;

  const session = await createAudioStream('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {
    spawnFn: () => {
      count += 1;
      return count === 1 ? ytdlpProc : ffmpegProc;
    }
  });

  const failedPromise = new Promise((resolve) => {
    session.events.once('failed', (err) => resolve(err));
  });

  ytdlpProc.stderr.write('ERROR: Video unavailable?token=secret12345');
  ytdlpProc.exitCode = 1;
  ytdlpProc.emit('close', 1, null);

  const err = await failedPromise;
  assert.ok(err instanceof StreamExtractionError);
  assert.equal(session.getState().status, 'failed');
  assert.ok(!session.getState().ytdlpStderr.includes('secret12345'));
  assert.ok(session.getState().ytdlpStderr.includes('[REDACTED]'));
});

test('Streamer — premature stream closure with 0 PCM bytes is detected as failure', async () => {
  const ytdlpProc = createMockChildProcess();
  const ffmpegProc = createMockChildProcess();
  let count = 0;

  const session = await createAudioStream('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {
    spawnFn: () => {
      count += 1;
      return count === 1 ? ytdlpProc : ffmpegProc;
    }
  });

  const failedPromise = new Promise((resolve) => {
    session.events.once('failed', (err) => resolve(err));
  });

  ytdlpProc.exitCode = 0;
  ytdlpProc.emit('close', 0, null);
  ffmpegProc.exitCode = 0;
  ffmpegProc.emit('close', 0, null);

  const err = await failedPromise;
  assert.equal(err.code, ErrorCodes.STREAM_PREMATURE_EOF);
  assert.equal(session.getState().status, 'failed');
});

test('Streamer — broken pipe (EPIPE) on ffmpeg stdin is handled without crashing', async () => {
  const ytdlpProc = createMockChildProcess();
  const ffmpegProc = createMockChildProcess();
  let count = 0;

  const session = await createAudioStream('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {
    spawnFn: () => {
      count += 1;
      return count === 1 ? ytdlpProc : ffmpegProc;
    }
  });

  const failedPromise = new Promise((resolve) => {
    session.events.once('failed', (err) => resolve(err));
  });

  const epipe = new Error('write EPIPE');
  epipe.code = 'EPIPE';
  ffmpegProc.stdin.emit('error', epipe);

  const err = await failedPromise;
  assert.ok(err instanceof StreamExtractionError);
  assert.equal(session.getState().status, 'failed');
});

test('Streamer — explicit cancellation and idempotent cleanup escalate to SIGKILL when needed', async () => {
  const ytdlpProc = createMockChildProcess({ autoCloseOnKill: false });
  const ffmpegProc = createMockChildProcess({ autoCloseOnKill: true });
  let count = 0;

  const session = await createAudioStream('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {
    spawnFn: () => {
      count += 1;
      return count === 1 ? ytdlpProc : ffmpegProc;
    },
    killTimeoutMs: 40
  });

  const [res1, res2, res3] = await Promise.all([
    session.cleanup('skip'),
    session.cleanup('stop'),
    session.dispose('duplicate')
  ]);

  assert.deepEqual(res1, res2);
  assert.deepEqual(res2, res3);
  assert.equal(res1.status, 'cancelled');
  assert.equal(res1.reason, 'skip');
  assert.deepEqual(ytdlpProc.killSignals, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(ffmpegProc.killSignals, ['SIGTERM']);
});

test('Streamer — real system ffmpeg transcoding pipeline outputs 48kHz stereo s16le PCM', async () => {
  const ytdlpProc = createMockChildProcess();
  let callIndex = 0;

  const hybridSpawn = (cmd, args, opts) => {
    callIndex += 1;
    if (callIndex === 1) {
      return ytdlpProc;
    }
    return realSpawn(cmd, args, opts);
  };

  const session = await createAudioStream('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {
    spawnFn: hybridSpawn,
    ffmpegPath: '/usr/bin/ffmpeg'
  });

  const completedPromise = new Promise((resolve, reject) => {
    session.events.once('completed', resolve);
    session.events.once('failed', reject);
  });

  const dataSize = 1600;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);

  ytdlpProc.stdout.write(wav);
  ytdlpProc.stdout.end();
  ytdlpProc.exitCode = 0;
  ytdlpProc.emit('close', 0, null);

  const info = await completedPromise;
  assert.ok(info.pcmBytes > 0, 'Expected real ffmpeg process to emit PCM bytes');
  assert.equal(session.getState().status, 'completed');
});
