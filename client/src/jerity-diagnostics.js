import { h } from './ui.js';
import { C2S } from '../../shared/protocol.js';
import { JERITY } from '../../shared/jerity.js';
import { enableMicrophone, microphoneEnabled, recordArgument, playVoice, stopVoice } from './jerity-audio.js';

// Explicit lobby-only checks: transcripts and recordings are returned only to this player.
export function mountJerityDiagnostics(root, net) {
  let alive = true, busy = false, clip = null;
  const abort = new AbortController();
  const result = h('output.muted', { 'aria-live': 'polite' });
  const mic = h('button.btn.small.ghost', { type: 'button', onclick: () => run(async () => {
    stopVoice(); clip = null;
    if (!microphoneEnabled()) await enableMicrophone();
    if (!alive) return;
    result.textContent = 'Recording for six seconds. Say a short sentence.';
    clip = await recordArgument(JERITY.LISTEN_MS, abort.signal);
    if (!alive) return;
    if (!clip) throw new Error('No microphone audio was captured. Check permission and try again.');
    result.textContent = 'Recording captured. Asking Groq what it heard...';
    const response = await net.request(C2S.JERITY_TEST_MIC, clip, 15000);
    if (!alive) return;
    if (response.error) throw new Error(response.error);
    result.textContent = response.text && response.text !== '[silence]'
      ? `Groq heard: "${response.text}"` : 'Groq received the audio but heard no speech. Try playing the recording.';
  }) }, 'Test microphone');
  const voice = h('button.btn.small.ghost', { type: 'button', onclick: () => run(async () => {
    stopVoice(); result.textContent = 'Generating Jerity\'s voice...';
    const response = await net.request(C2S.JERITY_TEST_VOICE, {}, JERITY.TTS_TIMEOUT_MS + 5000);
    if (!alive) return;
    if (response.error) throw new Error(response.error);
    result.textContent = 'Playing Fish Audio voice. Unmute Jerity if needed.';
    await playVoice({ audioBase64: response.audioBase64, fallback: false });
  }) }, 'Test Jerity voice');
  const replay = h('button.btn.small.ghost', { type: 'button', disabled: true, onclick: () => run(async () => {
    if (clip) await playVoice({ ...clip, fallback: false });
  }) }, 'Play my recording');
  const el = h('details.jerity-tests', {}, h('summary', {}, 'Microphone & voice check'),
    h('div.row', {}, mic, voice, replay), result);
  root.append(el);
  async function run(fn) {
    if (busy || !alive) return;
    busy = true; mic.disabled = voice.disabled = replay.disabled = true;
    try { await fn(); }
    catch (error) { if (alive) result.textContent = error.message; }
    finally {
      busy = false;
      if (alive) { mic.disabled = voice.disabled = false; replay.disabled = !clip; }
    }
  }
  return () => { alive = false; abort.abort(); stopVoice(); clip = null; el.remove(); };
}
