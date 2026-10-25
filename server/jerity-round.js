import { randomUUID } from 'node:crypto';
import { JERITY, JERITY_AUDIO_TYPES, JERITY_LISTENING_CLIPS } from '../shared/jerity.js';
import { S2C, CAR_STATE } from '../shared/protocol.js';

// One exchange per round. The room owns the lifetime; late AI responses cannot affect a new game.
export function createJerityRound({ game, pipeline, players, broadcast, isCurrent, roundNumber = 1, limits = JERITY }) {
  const roundId = randomUUID();
  const recordings = new Map();
  const abort = new AbortController();
  let phase = 'idle', closesAt = 0, mood = 'curious', focusId = null;
  let playback = null;
  let started = false;
  let actionAt = null;

  const current = () => !abort.signal.aborted && isCurrent();
  const state = () => ({
    roundId, phase, mood, focusId,
    durationMs: limits.LISTEN_MS,
    remainingMs: Math.max(0, closesAt - Date.now()),
    turnAwayInMs: actionAt === null ? null : Math.max(0, actionAt + limits.TURN_AWAY_MS - Date.now()),
  });
  function setPhase(value) {
    phase = value;
    if (current()) broadcast(S2C.JERITY_STATE, state());
  }
  function delay(ms) {
    return new Promise(resolve => {
      if (abort.signal.aborted) return resolve();
      const done = () => { clearTimeout(timer); abort.signal.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, ms);
      abort.signal.addEventListener('abort', done, { once: true });
    });
  }
  function submit(playerId, msg) {
    const player = players().find(p => p.id === playerId && !p.isBot && !p.away);
    if (!current() || !player || msg.roundId !== roundId ||
        !['listening', 'uploading'].includes(phase) || recordings.has(playerId)) {
      return { error: 'The listening window is closed or your recording was already received.' };
    }
    const mimeType = typeof msg.mimeType === 'string' ? msg.mimeType.split(';')[0].trim() : '';
    const audio = msg.audioBase64;
    if (!JERITY_AUDIO_TYPES.includes(mimeType) || typeof audio !== 'string' || !audio.length ||
        audio.length > Math.ceil(limits.MAX_AUDIO_BYTES / 3) * 4 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(audio) || Buffer.byteLength(audio, 'base64') > limits.MAX_AUDIO_BYTES) {
      return { error: 'Unsupported or oversized recording.' };
    }
    recordings.set(playerId, { playerId, audioBase64: audio, mimeType });
    return { ok: true };
  }
  function played(playerId, msg) {
    if (!current() || msg.roundId !== roundId || msg.lineId !== playback?.id) return;
    playback.waiting.delete(playerId);
    if (!playback.waiting.size) playback.finish();
  }
  async function speak(line) {
    if (!current()) return;
    const id = randomUUID();
    const waiting = new Set(players().filter(p => !p.isBot && !p.away).map(p => p.id));
    await new Promise(resolve => {
      const finish = () => {
        clearTimeout(timer);
        abort.signal.removeEventListener('abort', finish);
        playback = null;
        resolve();
      };
      // Spectators still hear the line when a room temporarily has no human drivers.
      const timeoutMs = line.timeoutMs || limits.PLAYBACK_TIMEOUT_MS;
      const timeout = waiting.size ? timeoutMs : Math.min(timeoutMs, 6000);
      const timer = setTimeout(finish, timeout);
      playback = { id, waiting, finish };
      abort.signal.addEventListener('abort', finish, { once: true });
      broadcast(S2C.JERITY_VOICE, {
        roundId, lineId: id, timing: line.timing, text: line.text,
        audioBase64: line.audio ? Buffer.from(line.audio).toString('base64') : null,
        ...(line.url ? { url: line.url } : {}),
        timeoutMs,
      });
    });
  }
  async function start() {
    if (started || !current()) return;
    started = true;
    try {
      setPhase('inviting');
      await speak({
        timing: 'listening_cue', text: 'Jerity is ready to listen.',
        url: JERITY_LISTENING_CLIPS[(roundNumber - 1) % JERITY_LISTENING_CLIPS.length],
        timeoutMs: limits.LISTEN_CUE_TIMEOUT_MS,
      });
      if (!current()) return;
      closesAt = Date.now() + limits.LISTEN_MS;
      setPhase('listening');
      await delay(limits.LISTEN_MS);
      if (!current()) return;
      setPhase('uploading');
      await delay(limits.UPLOAD_GRACE_MS);
      if (!current()) return;
      setPhase('thinking');
      const roster = players();
      const gameState = {
        timeLeft: game.snapshot().timeLeft,
        players: Object.fromEntries([...game.cars].filter(([, car]) =>
          car.body && car.s !== CAR_STATE.DEAD && car.s !== CAR_STATE.DISCONNECTED).map(([id, car]) => [id, {
          hp: car.hp, maxHp: car.maxHp, name: roster.find(p => p.id === id)?.name || id,
        }])),
      };
      let timer;
      const result = await Promise.race([
        pipeline.runCycle(gameState, [...recordings.values()], { signal: abort.signal }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Jerity response timed out')), limits.PIPELINE_TIMEOUT_MS);
        }),
      ]).finally(() => clearTimeout(timer));
      if (!current()) return;
      mood = result.internalState?.mood || mood;
      const event = result.events?.[0];
      focusId = Array.isArray(event?.target) ? event.target[0] : event?.target;
      const lines = result.audioBuffers || [];
      setPhase('speaking');
      for (const line of lines.filter(l => l.timing === 'before_effect')) await speak(line);
      if (!current()) return;
      const applied = !!(event && event.action !== 'none' && game.applyJerityAction(event));
      actionAt = Date.now();
      broadcast(S2C.JERITY_RULING, { roundId, events: applied ? [event] : [], applied });
      broadcast(S2C.SNAP, game.snapshot());
      setPhase('effect');
      for (const line of lines.filter(l => l.timing !== 'before_effect')) await speak(line);
    } catch (error) {
      if (current()) console.error('Jerity round exchange failed:', error.message);
    } finally {
      recordings.clear();
      if (current()) setPhase('idle');
      abort.abort();
    }
  }
  return {
    start, submit, played, state,
    get busy() { return phase !== 'idle' && !abort.signal.aborted; },
    cancel() { abort.abort(); recordings.clear(); },
  };
}
