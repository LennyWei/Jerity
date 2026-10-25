import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';
import { createGame } from '../server/game.js';
import { createJerityRound, createJerityLoop } from '../server/jerity-round.js';
import { createRooms } from '../server/rooms.js';
import { VerityPipeline } from '../verity/verity-pipeline.js';
import { C2S, S2C, BUFF } from '../shared/protocol.js';
import { JERITY } from '../shared/jerity.js';
import { jerityStatus } from '../server/jerity-status.js';

const limits = { ...JERITY, LISTEN_MS: 20, UPLOAD_GRACE_MS: 10, PLAYBACK_TIMEOUT_MS: 80, PIPELINE_TIMEOUT_MS: 100 };
const roster = [{ id: 'a', name: 'Alice' }, { id: 'b', name: 'Bob' }];
const recording = { audioBase64: Buffer.from('audio fixture').toString('base64'), mimeType: 'audio/webm;codecs=opus' };

test('backend diagnostics report missing configuration without exposing secrets', () => {
  const keys = ['GROQ_API_KEY', 'GEMINI_API_KEY', 'FISH_AUDIO_API_KEY', 'FISH_AUDIO_VOICE_ID'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    keys.forEach(key => { delete process.env[key]; });
    assert.deepEqual(jerityStatus(), { protocolVersion: 1, configured: false, missing: keys });
    keys.forEach(key => { process.env[key] = 'test-secret-value'; });
    assert.deepEqual(jerityStatus(), { protocolVersion: 1, configured: true, missing: [] });
    assert.ok(!JSON.stringify(jerityStatus()).includes('test-secret-value'));
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
const ruling = () => ({
  events: [{ action: 'boost_player', target: 'a', params: { duration: 3 } }],
  internalState: { mood: 'playful' },
  audioBuffers: [{ timing: 'before_effect', text: 'A boost for Alice.', audio: Buffer.from('mp3') },
    { timing: 'after_effect', text: 'Make it count.', audio: Buffer.from('mp3') }],
});

test('recurring exchanges use fresh IDs, reject old audio, and wait between exchanges', { timeout: 2000 }, async () => {
  const ids = [], cues = [], idleTimes = [];
  let calls = 0, loop;
  loop = createJerityLoop({ game: createGame(roster), players: () => roster, isCurrent: () => true,
    limits: { ...limits, COOLDOWN_MIN_MS: 30, COOLDOWN_MAX_MS: 50 },
    pipeline: { runCycle: async () => { calls++; return ruling(); } },
    broadcast(type, payload) {
      if (type === S2C.JERITY_VOICE) {
        if (payload.timing === 'listening_cue') cues.push(payload.url);
        queueMicrotask(() => roster.forEach(p => loop.played(p.id, payload)));
      }
      if (type !== S2C.JERITY_STATE) return;
      if (payload.phase === 'listening') {
        if (ids.length) {
          assert.ok(Date.now() - idleTimes.at(-1) >= 30);
          assert.ok(loop.submit('a', { ...recording, roundId: ids.at(-1) }).error);
        }
        ids.push(payload.roundId);
        assert.equal(loop.submit('a', { ...recording, roundId: payload.roundId }).ok, true);
      }
      if (payload.phase === 'idle') {
        idleTimes.push(Date.now());
        if (calls === 3) queueMicrotask(() => loop.cancel());
      }
    },
  });
  await loop.start();
  assert.equal(calls, 3);
  assert.equal(new Set(ids).size, 3);
  assert.deepEqual(cues, ['/audio/jerity/listening-1.mp3', '/audio/jerity/listening-2.mp3', '/audio/jerity/listening-3.mp3']);
});

test('ending the round during cooldown cancels the next exchange immediately', { timeout: 1000 }, async () => {
  let ready, calls = 0, loop;
  const idle = new Promise(resolve => { ready = resolve; });
  loop = createJerityLoop({ game: createGame(roster), players: () => [], isCurrent: () => true,
    limits: { ...limits, LISTEN_CUE_TIMEOUT_MS: 1, COOLDOWN_MIN_MS: 4000, COOLDOWN_MAX_MS: 4000 },
    pipeline: { runCycle: async () => { calls++; return { events: [], audioBuffers: [] }; } },
    broadcast(type, payload) { if (type === S2C.JERITY_STATE && payload.phase === 'idle') ready(); },
  });
  const running = loop.start();
  await idle;
  await new Promise(resolve => setImmediate(resolve));
  loop.cancel(); await running;
  assert.equal(calls, 1);
});

test('ending the round during processing prevents late effects and further exchanges', { timeout: 1000 }, async () => {
  let ready, finish, calls = 0;
  const processing = new Promise(resolve => { ready = resolve; });
  const game = createGame(roster), events = [];
  const loop = createJerityLoop({ game, players: () => [], isCurrent: () => true,
    limits: { ...limits, LISTEN_CUE_TIMEOUT_MS: 1, PIPELINE_TIMEOUT_MS: 60000 },
    pipeline: { runCycle: () => { calls++; ready(); return new Promise(resolve => { finish = resolve; }); } },
    broadcast: (type, payload) => events.push({ type, payload }),
  });
  const running = loop.start();
  await processing;
  loop.cancel(); await running;
  const count = events.length;
  finish(ruling());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.length, count);
  assert.equal(calls, 1);
  assert.equal(game.cars.get('a').buff, BUFF.NONE);
});
function setup({ pipeline, onEvent, customLimits, roundNumber = 1, customRoster = roster } = {}) {
  const game = createGame(customRoster), events = [];
  let listeningReady;
  const listening = new Promise(resolve => { listeningReady = resolve; });
  let current = true;
  const cycle = createJerityRound({ game, pipeline: pipeline || { runCycle: async () => ruling() },
    players: () => customRoster, limits: customLimits || limits, isCurrent: () => current, roundNumber,
    broadcast: (type, payload) => {
      events.push({ type, payload });
      if (type === S2C.JERITY_STATE && payload.phase === 'listening') listeningReady();
      onEvent?.(type, payload, game);
      if (type === S2C.JERITY_VOICE) queueMicrotask(() => {
        for (const p of customRoster) cycle.played(p.id, payload);
      });
    },
  });
  return { cycle, game, events, listening, invalidate: () => { current = false; } };
}

test('one combined recording batch; before audio completes before action and after audio follows it', async () => {
  let inputs;
  const observed = [];
  const { cycle, game, events, listening } = setup({
    pipeline: { runCycle: async (_state, audios) => { inputs = audios; return ruling(); } },
    onEvent: (type, payload, g) => {
      if (type === S2C.JERITY_VOICE) observed.push([payload.timing, g.cars.get('a').buff]);
    },
  });
  const running = cycle.start();
  await listening;
  const roundId = cycle.state().roundId;
  assert.equal(cycle.busy, true);
  assert.equal(cycle.submit('a', { roundId, ...recording }).ok, true);
  assert.equal(cycle.submit('b', { roundId, ...recording }).ok, true);
  assert.ok(cycle.submit('a', { roundId, ...recording }).error);
  await running;
  assert.equal(inputs.length, 2);
  assert.deepEqual(observed, [['listening_cue', BUFF.NONE], ['before_effect', BUFF.NONE], ['after_effect', BUFF.BOOST]]);
  assert.equal(game.cars.get('a').buffUntil, 3000);
  assert.equal(game.now, 0);
  assert.equal(cycle.busy, false);
  assert.deepEqual(events.filter(e => e.type === S2C.JERITY_STATE).map(e => e.payload.phase),
    ['inviting', 'listening', 'uploading', 'thinking', 'speaking', 'effect', 'idle']);
  assert.ok(cycle.state().turnAwayInMs > 0 && cycle.state().turnAwayInMs <= 4000);
  assert.ok(cycle.submit('b', { roundId, ...recording }).error);
});

test('reject stale, spectator, oversized and unsupported microphone submissions', async () => {
  const { cycle, listening } = setup();
  const running = cycle.start(), roundId = cycle.state().roundId;
  await listening;
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

test('a target killed during the before line receives no effect or success line', async () => {
  const { cycle, game, events } = setup({ onEvent(type, payload, g) {
    if (type === S2C.JERITY_VOICE && payload.timing === 'before_effect') {
      g.cars.get('a').hp = 1;
      g.applyJerityAction({ action: 'damage_player', target: 'a', params: { amount: 10 } });
    }
  } });
  await cycle.start();
  assert.equal(game.cars.get('a').buff, BUFF.NONE);
  assert.ok(!events.some(e => e.type === S2C.JERITY_RULING && e.payload.applied));
  assert.ok(!events.some(e => e.type === S2C.JERITY_VOICE && e.payload.timing === 'after_effect'));
});

test('cancellation releases a pending provider without waiting for its deadline', { timeout: 1000 }, async () => {
  let ready;
  const pending = new Promise(resolve => { ready = resolve; });
  const { cycle } = setup({ pipeline: { runCycle() { ready(); return new Promise(() => {}); } },
    customLimits: { ...limits, PIPELINE_TIMEOUT_MS: 60000 } });
  const running = cycle.start();
  await pending;
  cycle.cancel();
  await running;
  assert.equal(cycle.busy, false);
});

test('missing playback acknowledgments have a deadline', async () => {
  const game = createGame(roster);
  const cycle = createJerityRound({ game, pipeline: { runCycle: async () => ruling() },
    players: () => roster, isCurrent: () => true, broadcast() {},
    limits: { ...limits, PLAYBACK_TIMEOUT_MS: 10, LISTEN_CUE_TIMEOUT_MS: 10 },
  });
  await cycle.start();
  assert.equal(cycle.busy, false);
  assert.equal(game.cars.get('a').buff, BUFF.BOOST);
});

test('listening clips alternate by round, and recording stays closed until the cue completes', async () => {
  for (const [roundNumber, clipNumber] of [[1, 1], [2, 2], [3, 3], [4, 1]]) {
    const { cycle, events, listening } = setup({ roundNumber });
    const running = cycle.start();
    assert.equal(cycle.state().phase, 'inviting');
    assert.ok(cycle.submit('a', { roundId: cycle.state().roundId, ...recording }).error);
    const cue = events.find(event => event.type === S2C.JERITY_VOICE).payload;
    assert.equal(cue.url, `/audio/jerity/listening-${clipNumber}.mp3`);
    await listening;
    assert.equal(cycle.state().phase, 'listening');
    assert.equal(cycle.submit('a', { roundId: cycle.state().roundId, ...recording }).ok, true);
    cycle.cancel(); await running;
  }
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

test('real pipeline carries STT text to the model and preserves dialogue for multiple actions through TTS', async () => {
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
        events: [...ruling().events, { action: 'freeze_player', target: 'b', params: { duration: 3 } }], internalState: ruling().internalState,
        voiceLines: [...ruling().audioBuffers.map(({ text, timing }) => ({ text, timing, eventIndex: 0 })),
          { eventIndex: 1, timing: 'before_effect', text: 'Bob, time to freeze.' },
          { eventIndex: 1, timing: 'after_effect', text: 'Bob, parking looks good on you.' }],
      } };
    };
    const result = await pipeline.runCycle({ players: { a: { hp: 100, maxHp: 100, name: 'Alice' }, b: { hp: 100, name: 'Bob' } }, timeLeft: 90 },
      [{ playerId: 'a', ...recording }]);
    assert.equal(result.audioBuffers.length, 4);
    assert.deepEqual(result.audioBuffers.map(line => line.eventIndex), [0, 0, 1, 1]);
    assert.equal(result.events.length, 2);
    assert.ok(result.audioBuffers.every(line => Buffer.isBuffer(line.audio)));
    assert.equal(result.events[0].action, 'boost_player');
    assert.equal(requests.length, 5);
    assert.equal(pipeline.getState().eventCount, 1);
  } finally {
    globalThis.fetch = priorFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('multi-action playback stays paired and skips a dead target without skipping other actions', async () => {
  for (const killTarget of [false, true]) {
    const batch = {
      events: [
        { action: 'boost_player', target: 'a', params: { duration: 3 } },
        { action: 'freeze_player', target: 'b', params: { duration: 3 } },
        { action: 'shield_player', target: 'c', params: { duration: 3 } },
      ],
      audioBuffers: [0, 1, 2].flatMap(eventIndex => ['before_effect', 'after_effect'].map(timing =>
        ({ eventIndex, timing, text: `${eventIndex} ${timing}`, audio: Buffer.from('mp3') }))),
    };
    const { cycle, game, events } = setup({ customRoster: [...roster, { id: 'c', name: 'Cara' }],
      pipeline: { runCycle: async () => batch },
      onEvent(type, payload, g) {
        if (killTarget && type === S2C.JERITY_VOICE && payload.text === '0 before_effect') {
          g.cars.get('a').hp = 1;
          g.applyJerityAction({ action: 'damage_player', target: 'a', params: { amount: 10 } });
        }
      },
    });
    await cycle.start();
    assert.equal(game.cars.get('a').buff, killTarget ? BUFF.NONE : BUFF.BOOST);
    assert.ok(game.cars.get('b').frozenUntil > 0);
    assert.equal(game.cars.get('c').buff, BUFF.SHIELD);
    const order = events.filter(e => e.type === S2C.JERITY_RULING ||
      (e.type === S2C.JERITY_VOICE && e.payload.timing !== 'listening_cue'))
      .map(e => e.type === S2C.JERITY_VOICE ? e.payload.text : `${e.payload.eventIndex} applied:${e.payload.applied}`);
    assert.deepEqual(order, [ '0 before_effect', `0 applied:${!killTarget}`, ...(!killTarget ? ['0 after_effect'] : []),
      '1 before_effect', '1 applied:true', '1 after_effect', '2 before_effect', '2 applied:true', '2 after_effect' ]);
  }
});

test('a batch without dialogue for every action safely falls back to no action', async () => {
  const pipeline = new VerityPipeline();
  pipeline.verity.callGeminiWithFallback = async () => ({ modelUsed: 'offline', result: {
    events: [...ruling().events, { action: 'freeze_player', target: 'b', params: {} }],
    voiceLines: ruling().audioBuffers.map(({ text, timing }) => ({ text, timing, eventIndex: 0 })),
  } });
  const result = await pipeline.runCycleSimulated({ players: { a: { hp: 100 }, b: { hp: 100 } }, timeLeft: 90 },
    [{ playerId: 'a', text: 'Help me!' }], { skipTts: true });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].action, 'none');
});

test('an action ending the round prevents the remaining batch and its dialogue', async () => {
  const batch = {
    events: [{ action: 'damage_player', target: 'a', params: { amount: 10 } },
      { action: 'boost_player', target: 'b', params: { duration: 3 } }],
    audioBuffers: [0, 1].flatMap(eventIndex => ['before_effect', 'after_effect'].map(timing =>
      ({ eventIndex, timing, text: `${eventIndex} ${timing}`, audio: Buffer.from('mp3') }))),
  };
  const { cycle, game, events } = setup({ pipeline: { runCycle: async () => batch } });
  game.cars.get('a').hp = 1;
  await cycle.start();
  assert.equal(game.over(), true);
  assert.equal(game.cars.get('b').buff, BUFF.NONE);
  assert.deepEqual(events.filter(e => e.type === S2C.JERITY_VOICE && e.payload.timing !== 'listening_cue')
    .map(e => e.payload.text), ['0 before_effect']);
  assert.equal(events.filter(e => e.type === S2C.JERITY_RULING).length, 1);
});

test('Socket.IO room starts the exchange after countdown and broadcasts the action to a spectator', { timeout: 12000 }, async () => {
  const server = http.createServer(), io = new Server(server);
  let captured;
  const rooms = createRooms(io, { pipelineFactory: () => ({ runCycle: async (_state, audios) => {
    captured = audios;
    await new Promise(resolve => setTimeout(resolve, 1100));
    const result = ruling(); result.events[0].target = audios[0].playerId; return result;
  } }), transcribe: async () => 'I need a boost', generateVoice: async () => Buffer.from('voice fixture'),
    jerityLimits: { ...limits, LISTEN_MS: 1200, UPLOAD_GRACE_MS: 50, PLAYBACK_TIMEOUT_MS: 1000, PIPELINE_TIMEOUT_MS: 3000 } });
  io.on('connection', rooms.attach);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const player = connect(url, { transports: ['websocket'] });
  const spectator = connect(url, { transports: ['websocket'] });
  try {
    await Promise.all([once(player, 'connect'), once(spectator, 'connect')]);
    const created = await player.emitWithAck(C2S.CREATE_ROOM, { name: 'Alice', bots: 1 });
    await spectator.emitWithAck(C2S.SPECTATE, { code: created.code });
    assert.equal((await player.emitWithAck(C2S.JERITY_TEST_MIC, recording)).text, 'I need a boost');
    assert.ok((await player.emitWithAck(C2S.JERITY_TEST_MIC, recording)).error);
    assert.ok((await spectator.emitWithAck(C2S.JERITY_TEST_MIC, recording)).error);
    assert.equal((await player.emitWithAck(C2S.JERITY_TEST_VOICE, {})).audioBase64, Buffer.from('voice fixture').toString('base64'));
    let countdownFinished = false;
    let phase, listeningTimes = [], thinkingTimes = [];
    player.on(S2C.SNAP, snapshot => {
      if (phase === 'listening') listeningTimes.push(snapshot.timeLeft);
      if (phase === 'thinking') thinkingTimes.push(snapshot.timeLeft);
    });
    player.on(S2C.COUNTDOWN, ({ seconds }) => { if (seconds === 0) countdownFinished = true; });
    const idle = new Promise(resolve => player.on(S2C.JERITY_STATE, state => {
      phase = state.phase;
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
    assert.ok(listeningTimes.length > 1 && listeningTimes.at(-1) < listeningTimes[0], 'clock advances while listening');
    assert.ok(thinkingTimes.length > 1 && thinkingTimes.at(-1) < thinkingTimes[0], 'clock advances while processing');
  } finally {
    player.disconnect(); spectator.disconnect(); rooms.close();
    await new Promise(resolve => io.close(resolve));
  }
});
