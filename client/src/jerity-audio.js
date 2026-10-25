import { JERITY } from '../../shared/jerity.js';

// One audio element survives route changes so a gesture can unlock later server voice lines.
const speaker = new Audio();
speaker.preload = 'auto';
let unlocked = false, muted = false, stopPlayback = null;
const missing = new Set();
let micEnabled = false, micRequest = 0;
const micListeners = new Set();

export const soundMuted = () => muted;
export function setSoundMuted(value) { muted = value; if (value) stopVoice(); }
export function stopVoice() { stopPlayback?.(); }
export function unlockAudio() {
  if (unlocked) return;
  unlocked = true;
  speaker.src = 'data:audio/wav;base64,UklGRiUAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQEAAACA';
  speaker.play().catch(() => { unlocked = false; });
}
addEventListener('pointerdown', unlockAudio, { capture: true });
addEventListener('keydown', unlockAudio, { capture: true });

export function playVoice({ url, audioBase64, text, fallback = false, timeoutMs = JERITY.PLAYBACK_TIMEOUT_MS, onSpeaking = () => {} }) {
  stopVoice();
  if (muted || (!audioBase64 && !url && !fallback) || missing.has(url)) return Promise.resolve();
  return new Promise(resolve => {
    let done = false, utterance = null;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      speaker.onended = speaker.onerror = speaker.onplaying = null;
      speaker.pause();
      speaker.removeAttribute('src');
      if (utterance) { utterance.onend = utterance.onerror = null; window.speechSynthesis?.cancel(); }
      onSpeaking(false);
      if (stopPlayback === finish) stopPlayback = null;
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    stopPlayback = finish;
    const localSpeech = () => {
      if (done) return;
      if (!fallback || !text || !window.speechSynthesis) return finish();
      speaker.pause();
      speaker.onerror = null;
      utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 0.95;
      utterance.onstart = () => onSpeaking(true);
      utterance.onend = utterance.onerror = finish;
      window.speechSynthesis.speak(utterance);
    };
    if (!url && !audioBase64) return localSpeech();
    speaker.onended = finish;
    speaker.onplaying = () => { unlocked = true; onSpeaking(true); };
    speaker.onerror = () => { if (url) missing.add(url); localSpeech(); };
    speaker.src = url || `data:audio/mpeg;base64,${audioBase64}`;
    speaker.play().catch(error => {
      if (error.name === 'NotAllowedError') unlocked = false;
      localSpeech();
    });
  });
}

export const microphoneEnabled = () => micEnabled;
export function onMicrophoneChange(fn) { micListeners.add(fn); return () => micListeners.delete(fn); }
function updateMic() { micListeners.forEach(fn => fn(micEnabled)); }
export async function enableMicrophone() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    throw new Error('Microphone needs HTTPS (or localhost) and a browser that supports recording.');
  }
  const request = ++micRequest;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
  stream.getTracks().forEach(track => track.stop());
  if (request === micRequest) { micEnabled = true; updateMic(); }
}
export function disableMicrophone() { micRequest++; micEnabled = false; updateMic(); }

// Capture only this listening window. No microphone is held between rounds or screens.
export async function recordArgument(durationMs, signal) {
  if (!micEnabled || signal.aborted || durationMs <= 0) return null;
  const deadline = performance.now() + Math.min(JERITY.LISTEN_MS, durationMs);
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
  const release = () => stream.getTracks().forEach(track => track.stop());
  if (signal.aborted || !micEnabled || performance.now() >= deadline) { release(); return null; }
  const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm']
    .find(type => MediaRecorder.isTypeSupported(type));
  let recorder;
  try { recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 64000 }); }
  catch (error) { release(); throw error; }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0, failed = false;
    const stop = () => { if (recorder.state !== 'inactive') recorder.stop(); };
    const cancel = () => { failed = true; stop(); };
    const offMic = onMicrophoneChange(enabled => { if (!enabled) cancel(); });
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); offMic(); release(); };
    const timer = setTimeout(stop, Math.max(1, deadline - performance.now()));
    signal.addEventListener('abort', cancel, { once: true });
    recorder.ondataavailable = ({ data }) => {
      bytes += data.size;
      if (bytes > JERITY.MAX_AUDIO_BYTES) cancel();
      else if (data.size) chunks.push(data);
    };
    recorder.onerror = () => { failed = true; cleanup(); reject(new Error('Microphone recording failed.')); };
    recorder.onstop = () => {
      cleanup();
      if (failed || signal.aborted || !chunks.length) return resolve(null);
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not read microphone audio.'));
      reader.onload = () => resolve(signal.aborted ? null : {
        audioBase64: String(reader.result).split(',')[1], mimeType: recorder.mimeType || mimeType,
      });
      reader.readAsDataURL(new Blob(chunks, { type: recorder.mimeType || mimeType }));
    };
    try { recorder.start(250); } catch (error) { cleanup(); reject(error); }
  });
}
