import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';
import { createGame } from '../server/game.js';
import { createJerityRound } from '../server/jerity-round.js';
import { createRooms } from '../server/rooms.js';
import { VerityPipeline } from '../verity/verity-pipeline.js';
import { C2S, S2C, BUFF } from '../shared/protocol.js';
import { JERITY } from '../shared/jerity.js';

const limits = { ...JERITY, LISTEN_MS: 20, UPLOAD_GRACE_MS: 10, PLAYBACK_TIMEOUT_MS: 80, PIPELINE_TIMEOUT_MS: 100 };
const roster = [{ id: 'a', name: 'Alice' }, { id: 'b', name: 'Bob' }];
const recording = { audioBase64: Buffer.from('audio fixture').toString('base64'), mimeType: 'audio/webm;codecs=opus' };
const ruling = () => ({
  events: [{ action: 'boost_player', target: 'a', params: { duration: 3 } }],
  internalState: { mood: 'playful' },
  audioBuffers: [{ timing: 'before_effect', text: 'A boost for Alice.', audio: Buffer.from('mp3') },
    { timing: 'after_effect', text: 'Make it count.', audio: Buffer.from('mp3') }],
});
function setup({ pipeline, onEvent, customLimits } = {}) {
  const game = createGame(roster), events = [];
  let current = true;
  const cycle = createJerityRound({ game, pipeline: pipeline || { runCycle: async () => ruling() },
    players: () => roster, limits: customLimits || limits, isCurrent: () => current,
    broadcast: (type, payload) => {
      events.push({ type, payload });
      onEvent?.(type, payload, game);
      if (type === S2C.JERITY_VOICE) queueMicrotask(() => {
        for (const p of roster) cycle.played(p.id, payload);
      });
    },
  });
  return { cycle, game, events, invalidate: () => { current = false; } };
}

test('one combined recording batch; before audio completes before action and after audio follows it', async () => {
  let inputs;
  const observed = [];
  const { cycle, game, events } = setup({
    pipeline: { runCycle: async (_state, audios) => { inputs = audios; return ruling(); } },
    onEvent: (type, payload, g) => {
      if (type === S2C.JERITY_VOICE) observed.push([payload.timing, g.cars.get('a').buff]);
    },
  });
  const running = cycle.start();
  const roundId = cycle.state().roundId;
  assert.equal(cycle.busy, true);
  assert.equal(cycle.submit('a', { roundId, ...recording }).ok, true);
  assert.equal(cycle.submit('b', { roundId, ...recording }).ok, true);
  assert.ok(cycle.submit('a', { roundId, ...recording }).error);
  await running;
  assert.equal(inputs.length, 2);
  assert.deepEqual(observed, [['before_effect', BUFF.NONE], ['after_effect', BUFF.BOOST]]);
  assert.equal(game.cars.get('a').buffUntil, 3000);
  assert.equal(game.now, 0);
  assert.equal(cycle.busy, false);
  assert.deepEqual(events.filter(e => e.type === S2C.JERITY_STATE).map(e => e.payload.phase),
    ['listening', 'uploading', 'thinking', 'speaking', 'effect', 'idle']);
  assert.ok(cycle.submit('b', { roundId, ...recording }).error);
});

test('reject stale, spectator, oversized and unsupported microphone submissions', async () => {
  const { cycle } = setup();
  const running = cycle.start(), roundId = cycle.state().roundId;
  assert.ok(cycle.submit('a', { ...recording, roundId: 'old-round' }).error);
  assert.ok(cycle.submit('spectator', { ...recording, roundId }).error);
  assert.ok(cycle.submit('a', { ...recording, roundId, mimeType: 'text/plain' }).error);
  assert.ok(cycle.submit('a', { ...recording, roundId, audioBase64: '!not-base64' }).error);
  assert.ok(cycle.submit('a', { ...recording, roundId, audioBase64: 'A'.repeat(JERITY.MAX_AUDIO_BYTES * 2) }).error);
  cycle.cancel(); await running;
});

test('room cancellation cannot apply a late ruling or send more events', async () => {
  let finish, consulted;
  const pending = new Promise(resolve => { consulted = resolve; });
  const { cycle, game, events } = setup({ pipeline: { runCycle: () => {
    consulted(); return new Promise(resolve => { finish = resolve; });
  } } });
  const running = cycle.start();
  await pending;
  cycle.cancel();
  const count = events.length;
  finish(ruling());
  await running;
  assert.equal(game.cars.get('a').buff, BUFF.NONE);
  assert.equal(events.length, count);
});

test('provider deadline releases the room even when the provider never settles', async () => {
  const { cycle, game } = setup({ pipeline: { runCycle: () => new Promise(() => {}) },
    customLimits: { ...limits, PIPELINE_TIMEOUT_MS: 15 } });
  await cycle.start();
  assert.equal(cycle.busy, false);
  assert.equal(cycle.state().phase, 'idle');
  assert.equal(game.cars.get('a').buff, BUFF.NONE);
});

test('missing playback acknowledgments have a deadline', async () => {
  const game = createGame(roster);
  const cycle = createJerityRound({ game, pipeline: { runCycle: async () => ruling() },
    players: () => roster, isCurrent: () => true, broadcast() {},
    limits: { ...limits, PLAYBACK_TIMEOUT_MS: 10 },
  });
  await cycle.start();
  assert.equal(cycle.busy, false);
  assert.equal(game.cars.get('a').buff, BUFF.BOOST);
});

test('game honors bounded parameters, target arrays and obstacle expiry', () => {
  const game = createGame(roster), a = game.cars.get('a'), b = game.cars.get('b');
  assert.equal(game.applyJerityAction({ action: 'boost_player', target: 'a', params: { duration: 99 } }), true);
  assert.equal(a.buffUntil, 10000);
  game.applyJerityAction({ action: 'freeze_player', target: 'a', params: { duration: -5 } });
  assert.equal(a.frozenUntil, 2000);
  const before = a.hp;
  game.applyJerityAction({ action: 'damage_player', target: 'a', params: { amount: 900 } });
  assert.equal(a.hp, before - 40);
  game.applyJerityAction({ action: 'heal_player', target: 'a', params: { amount: 19 } });
  assert.equal(a.hp, before - 21);
  const ax = a.x, bx = b.x;
  assert.equal(game.applyJerityAction({ action: 'swap_positions', target: ['a', 'b'] }), true);
  assert.equal(a.x, bx); assert.equal(b.x, ax);
  assert.equal(game.applyJerityAction({ action: 'swap_positions', target: ['a', 'missing'] }), false);
  assert.equal(game.applyJerityAction({ action: 'execute_player', target: 'a' }), false);
  game.applyJerityAction({ action: 'remove_walls', params: { duration: 2 } });
  assert.equal(game.snapshot().obstaclesDisabled, true);
  for (let i = 0; i < 61; i++) game.step(new Map(), 1 / 30);
  assert.equal(game.snapshot().obstaclesDisabled, false);
});

test('real pipeline carries STT text to the model and returns before/after TTS audio', async () => {
  const priorFetch = globalThis.fetch;
  const saved = Object.fromEntries(['GROQ_API_KEY', 'FISH_AUDIO_API_KEY', 'FISH_AUDIO_VOICE_ID'].map(key => [key, process.env[key]]));
  Object.keys(saved).forEach(key => { process.env[key] = 'offline-test'; });
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push(url);
    if (url.includes('transcriptions')) {
      assert.ok(options.body.get('file'));
      return Response.json({ text: 'Give Alice a boost please.' });
    }
    assert.ok(JSON.parse(options.body).text);
    return new Response(Buffer.from('mock mp3'), { headers: { 'content-type': 'audio/mpeg' } });
  };
  try {
    const pipeline = new VerityPipeline();
    pipeline.verity.callGeminiWithFallback = async prompt => {
      assert.match(prompt, /Give Alice a boost please/);
      assert.match(prompt, /Alice/);
      return { modelUsed: 'offline', result: {
        events: ruling().events, internalState: ruling().internalState,
        voiceLines: ruling().audioBuffers.map(({ text, timing }) => ({ text, timing })),
      } };
    };
    const result = await pipeline.runCycle({ players: { a: { hp: 100, maxHp: 100, name: 'Alice' } }, timeLeft: 90 },
      [{ playerId: 'a', ...recording }]);
    assert.equal(result.audioBuffers.length, 2);
    assert.ok(result.audioBuffers.every(line => Buffer.isBuffer(line.audio)));
    assert.equal(result.events[0].action, 'boost_player');
    assert.equal(requests.length, 3);
    assert.equal(pipeline.getState().eventCount, 1);
  } finally {
    globalThis.fetch = priorFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('Socket.IO room starts the exchange after countdown and broadcasts the action to a spectator', { timeout: 12000 }, async () => {
  const server = http.createServer(), io = new Server(server);
  let captured;
  const rooms = createRooms(io, { pipelineFactory: () => ({ runCycle: async (_state, audios) => {
    captured = audios;
    const result = ruling(); result.events[0].target = audios[0].playerId; return result;
  } }), jerityLimits: { ...limits, LISTEN_MS: 100, UPLOAD_GRACE_MS: 50, PLAYBACK_TIMEOUT_MS: 1000 } });
  io.on('connection', rooms.attach);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const player = connect(url, { transports: ['websocket'] });
  const spectator = connect(url, { transports: ['websocket'] });
  try {
    await Promise.all([once(player, 'connect'), once(spectator, 'connect')]);
    const created = await player.emitWithAck(C2S.CREATE_ROOM, { name: 'Alice', bots: 1 });
    await spectator.emitWithAck(C2S.SPECTATE, { code: created.code });
    let countdownFinished = false;
    player.on(S2C.COUNTDOWN, ({ seconds }) => { if (seconds === 0) countdownFinished = true; });
    const idle = new Promise(resolve => player.on(S2C.JERITY_STATE, state => {
      if (state.phase === 'listening') {
        assert.equal(countdownFinished, true);
        player.emit(C2S.JERITY_AUDIO, { roundId: state.roundId, ...recording });
      }
      if (state.phase === 'idle') resolve();
    }));
    const outcome = once(spectator, S2C.JERITY_RULING);
    player.on(S2C.JERITY_VOICE, line => player.emit(C2S.JERITY_PLAYED, line));
    assert.equal((await player.emitWithAck(C2S.START, {})).ok, true);
    const [result] = await outcome;
    await idle;
    assert.equal(result.applied, true);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].playerId, created.playerId);
  } finally {
    player.disconnect(); spectator.disconnect(); rooms.close();
    await new Promise(resolve => io.close(resolve));
  }
});
