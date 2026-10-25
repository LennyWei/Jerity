import { C2S, S2C } from '../../shared/protocol.js';
import { microphoneEnabled, onMicrophoneChange, recordArgument, stopVoice } from './jerity-audio.js';

export function connectJerity({ net, face, playerId = null, initialState, onPhase = () => {} }) {
  let state = null, recording = null, attempted = null, alive = true, deadline = 0;
  const seenLines = new Set();
  let unavailableReported = false;
  function unavailable() {
    face.setState({ phase: 'unavailable' });
    if (!unavailableReported) {
      console.warn('The game server did not provide Jerity state. Deploy the current server/index.js backend as well as the frontend.');
      unavailableReported = true;
    }
  }
  async function capture() {
    if (!playerId || !microphoneEnabled() || state?.phase !== 'listening' || attempted === state.roundId) return;
    attempted = state.roundId;
    const roundId = state.roundId;
    const controller = recording = new AbortController();
    try {
      const audio = await recordArgument(deadline - performance.now(), controller.signal);
      if (alive && !controller.signal.aborted && audio && net.connected !== false) {
        net.emit(C2S.JERITY_AUDIO, { roundId, ...audio });
      }
    } catch (error) { face.microphoneError(error.message); }
  }
  function receive(next) {
    if (!next || !alive) return;
    unavailableReported = false;
    const changed = state?.roundId !== next.roundId;
    if (changed) { recording?.abort(); seenLines.clear(); attempted = null; }
    if (changed || state?.phase !== next.phase) {
      if (next.phase === 'listening') {
        stopVoice();
        deadline = performance.now() + next.remainingMs;
      }
      if (!['listening', 'uploading'].includes(next.phase)) recording?.abort();
    }
    state = next;
    face.setState(next);
    onPhase(next.phase);
    void capture();
  }
  const offs = [
    net.on(S2C.JERITY_STATE, receive),
    net.on(S2C.LOBBY, lobby => {
      if (!Object.hasOwn(lobby, 'jerity')) unavailable();
      else receive(lobby.jerity || { phase: 'idle' });
    }),
    net.on(S2C.JERITY_VOICE, async line => {
      if (!alive || line.roundId !== state?.roundId || seenLines.has(line.lineId)) return;
      seenLines.add(line.lineId);
      await face.playLine(line);
      if (alive && line.roundId === state?.roundId && playerId) {
        net.emit(C2S.JERITY_PLAYED, { roundId: line.roundId, lineId: line.lineId });
      }
    }),
    net.on(S2C.JERITY_RULING, () => face.pulse()),
    net.on(S2C.ROUND_END, () => { recording?.abort(); stopVoice(); face.setState({ phase: 'idle' }); }),
    onMicrophoneChange(() => { if (microphoneEnabled()) { attempted = null; void capture(); } }),
  ];
  if (net.onStatus) offs.push(net.onStatus(up => {
    if (!up) { recording?.abort(); attempted = null; stopVoice(); }
  }));
  receive(initialState);
  if (playerId && initialState === undefined) unavailable();
  return () => { alive = false; recording?.abort(); stopVoice(); offs.forEach(off => off?.()); };
}
