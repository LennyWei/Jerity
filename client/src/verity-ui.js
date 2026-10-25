// Jerity's persistent face. Dialogue is audio; live status stays accessible without speech boxes.
import { store } from './ui.js';
import './jerity.css';
import { CAR_STATE } from '../../shared/protocol.js';
import { playVoice, stopVoice, soundMuted, setSoundMuted, unlockAudio,
  microphoneEnabled, enableMicrophone, disableMicrophone, onMicrophoneChange } from './jerity-audio.js';

const VISITS_KEY = 'jerity-visits';
const EXTRA_KEY = 'jerity-corruption';
const MINUTES_TO_FULL = 6;   // menus alone take this long to go fully wrong

let visits = (Number(store.get(VISITS_KEY, '0')) || 0) + 1;
store.set(VISITS_KEY, String(visits));
let extra = Number(store.get(EXTRA_KEY, '0')) || 0, menuSeconds = 0;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
export const corruption = () => Math.min(1, Math.min(0.45, (visits - 1) * 0.08) + extra + menuSeconds / (MINUTES_TO_FULL * 60));
export const stageOf = c => c < 0.25 ? 0 : c < 0.5 ? 1 : c < 0.75 ? 2 : 3;
function apply() {
  document.documentElement.style.setProperty('--corrupt', corruption().toFixed(3));
  document.documentElement.dataset.verityStage = String(stageOf(corruption()));
}

export function bumpCorruption(amount) {
  extra = Math.min(1, extra + amount);
  store.set(EXTRA_KEY, extra.toFixed(3));
  apply();
}

/** Back to the cheerful start (the game server restarted: a fresh demo). */
export function resetCorruption() {
  visits = 1;
  extra = 0;
  menuSeconds = 0;
  store.set(VISITS_KEY, '1');
  store.set(EXTRA_KEY, '0');
  apply();
}


apply();

// Drop recordings into client/public/audio/jerity. Missing menu clips stay silent.
export const LINES = { home: 'home', lobby: 'lobby', match: 'match', spectate: 'spectate', results: 'results' };
export const MENU_VOICES = {
  home: ['/audio/jerity/home-1.mp3', '/audio/jerity/home-2.mp3'],
  lobby: ['/audio/jerity/lobby-1.mp3', '/audio/jerity/lobby-2.mp3'],
};
const greetings = { home: 0, lobby: 0 };
const FACE = `<svg viewBox="0 0 100 100" aria-hidden="true">
  <circle class="v-halo" cx="50" cy="50" r="48"/>
  <circle class="v-head" cx="50" cy="50" r="43"/>
  <g class="v-eyes">
    <ellipse class="v-eye" cx="35" cy="42" rx="7" ry="9"/>
    <ellipse class="v-eye" cx="65" cy="42" rx="7" ry="9"/>
    <circle class="v-pupil" cx="35" cy="42" r="3.4"/>
    <circle class="v-pupil" cx="65" cy="42" r="3.4"/>
  </g>
  <path class="v-mouth" d="M30 64 Q50 80 70 64"/>
</svg>`;

export function mountVerity(el, { lines = 'match', quiet = false, microphone = false } = {}) {
  el.classList.add('verity');
  el.innerHTML = `<div class="v-face" role="img" aria-label="Jerity">${FACE}</div>
    <div class="v-controls">
      ${microphone ? '<button class="v-mic" type="button"></button>' : ''}
    </div>
    <span class="v-status" role="status" aria-live="polite"></span>`;
  const face = el.querySelector('.v-face'), mouth = el.querySelector('.v-mouth');
  const pupils = [...el.querySelectorAll('.v-pupil')], status = el.querySelector('.v-status');
  // A body-level control stays in the viewport corner despite screen transforms and scrolling.
  const sound = document.createElement('button');
  sound.className = 'v-sound v-corner-sound';
  sound.type = 'button';
  document.body.append(sound);
  const mic = el.querySelector('.v-mic');
  let alive = true, speaking = false, phase = 'idle', mood = '', focusId = null;
  let watchedId = null, switchAt = 0, pulseTimer = 0, greetingTimer = 0, micBusy = false;
  let awayTimer = 0, awayReady = false, turnedAway = false, roundId = null;
  function updateAway() {
    // Finish the follow-up line before turning, even if it runs beyond the four-second delay.
    turnedAway = awayReady && phase === 'idle' && !speaking;
    el.classList.toggle('v-away', turnedAway);
    if (turnedAway) face.setAttribute('aria-label', 'Jerity is looking away.');
  }
  function expression() {
    const stage = stageOf(corruption());
    const sinister = ['vengeful', 'menacing', 'chaotic'].includes(mood);
    mouth.setAttribute('d', speaking ? 'M34 65 Q50 88 66 65 Q50 73 34 65'
      : phase === 'listening' ? 'M41 69 Q50 74 59 69'
      : sinister ? 'M22 62 Q50 92 78 62'
      : ['M30 64 Q50 80 70 64', 'M32 66 Q50 72 68 66', 'M32 68 L68 68', 'M22 62 Q50 92 78 62'][stage]);
  }
  function onSpeaking(value) {
    if (!alive) return;
    speaking = value;
    el.classList.toggle('v-speaking', value);
    expression();
    updateAway();
  }
  function refreshSound() {
    sound.textContent = soundMuted() ? '♪ ×' : '♪';
    sound.setAttribute('aria-label', soundMuted() ? 'Unmute Jerity' : 'Mute Jerity');
    sound.title = sound.getAttribute('aria-label');
    sound.setAttribute('aria-pressed', String(soundMuted()));
  }
  sound.onclick = () => { unlockAudio(); setSoundMuted(!soundMuted()); refreshSound(); };
  refreshSound();
  function refreshMic() {
    if (!mic || !alive) return;
    const enabled = microphoneEnabled();
    mic.textContent = enabled ? 'Mic on' : 'Enable mic';
    mic.setAttribute('aria-pressed', String(enabled));
    mic.title = enabled ? 'Disable microphone' : 'Let Jerity listen for 4.5 seconds after each countdown';
  }
  function microphoneError(message) {
    if (!alive) return;
    if (mic) { mic.textContent = 'Mic unavailable'; mic.title = message; }
    status.textContent = message;
  }
  if (mic) mic.onclick = async () => {
    if (micBusy) return;
    if (microphoneEnabled()) { disableMicrophone(); return; }
    micBusy = true; mic.disabled = true;
    try { await enableMicrophone(); refreshMic(); }
    catch (error) { microphoneError(error.message); }
    finally { micBusy = false; mic.disabled = false; }
  };
  const offMic = onMicrophoneChange(refreshMic);
  refreshMic();

  async function greet() {
    if (!alive || quiet || !MENU_VOICES[lines] || phase !== 'idle') return;
    const urls = MENU_VOICES[lines];
    const url = urls[greetings[lines]++ % urls.length];
    await playVoice({ url, onSpeaking });
    if (alive) greetingTimer = setTimeout(greet, 25000);
  }
  // Browser autoplay rules require the first interaction; returning lobby screens can speak immediately.
  let greetingStarted = false;
  const startGreeting = () => {
    if (greetingStarted || !alive) return;
    greetingStarted = true;
    void greet();
  };
  addEventListener('pointerdown', startGreeting, { once: true });
  addEventListener('keydown', startGreeting, { once: true });
  if (navigator.userActivation?.hasBeenActive) startGreeting();

  function lookAt(x, y) {
    const r = face.getBoundingClientRect();
    const dx = x - r.left - r.width / 2, dy = y - r.top - r.height / 2;
    const length = Math.max(80, Math.hypot(dx, dy));
    pupils.forEach((p, i) => {
      p.setAttribute('cx', (i ? 65 : 35) + dx / length * 3.5);
      p.setAttribute('cy', 42 + dy / length * 4.5);
    });
  }
  const pointer = event => { if (!quiet) lookAt(event.clientX, event.clientY); };
  addEventListener('pointermove', pointer);
  function watch(view, project, now) {
    if (turnedAway) return;
    const cars = view?.cars.filter(c => c.s !== CAR_STATE.DEAD && c.s !== CAR_STATE.DISCONNECTED) || [];
    if (!cars.length) return;
    if (now >= switchAt || !cars.some(c => c.id === watchedId)) {
      const index = cars.findIndex(c => c.id === watchedId);
      watchedId = cars[(index + 1) % cars.length].id;
      switchAt = now + 3000;
    }
    const target = cars.find(c => c.id === focusId) || cars.find(c => c.id === watchedId);
    const point = project(target.x, target.y);
    lookAt(point.x, point.y);
  }
  function setState(next) {
    if (next.roundId !== roundId || ['inviting', 'listening'].includes(next.phase)) {
      clearTimeout(awayTimer);
      awayReady = false;
    }
    roundId = next.roundId;
    phase = next.phase || 'idle'; mood = next.mood || mood;
    focusId = phase === 'idle' ? null : next.focusId || null;
    el.dataset.phase = phase;
    status.textContent = phase === 'inviting' ? 'Jerity is about to listen.'
      : phase === 'listening' ? 'Jerity is listening. Make your case now.'
      : phase === 'thinking' || phase === 'uploading' ? 'Jerity is deciding.'
      : phase === 'idle' ? 'Jerity is watching.' : 'Jerity has made his decision.';
    face.setAttribute('aria-label', status.textContent);
    if (Number.isFinite(next.turnAwayInMs)) {
      clearTimeout(awayTimer);
      if (next.turnAwayInMs <= 0) awayReady = true;
      else awayTimer = setTimeout(() => { awayReady = true; updateAway(); }, next.turnAwayInMs);
    }
    updateAway();
    expression();
  }
  function pulse() {
    if (!alive || reduceMotion) return;
    el.classList.add('v-reaction');
    clearTimeout(pulseTimer);
    pulseTimer = setTimeout(() => el.classList.remove('v-reaction'), 450);
  }
  const clock = setInterval(() => { if (!quiet) menuSeconds++; apply(); expression(); }, 1000);
  expression();
  return {
    setState, watch, pulse, microphoneError,
    playLine: line => {
      status.textContent = line.text;
      return playVoice({ ...line, fallback: line.timing !== 'listening_cue', onSpeaking });
    },
    say: text => playVoice({ text, fallback: true, onSpeaking }),
    react: events => { if (events?.some(e => e.type === 'kill')) pulse(); },
    verdict: () => { pulse(); expression(); },
    destroy() {
      alive = false; stopVoice(); offMic();
      clearInterval(clock); clearTimeout(greetingTimer); clearTimeout(pulseTimer);
      clearTimeout(awayTimer);
      sound.remove();
      removeEventListener('pointermove', pointer);
      removeEventListener('pointerdown', startGreeting);
      removeEventListener('keydown', startGreeting);
      el.innerHTML = '';
    },
  };
}
