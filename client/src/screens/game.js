// client/src/screens/game.js
// The in-round phone screen: countdown that calibrates, controls, arena,
// rotate-your-phone overlay, wake lock, and spectating after dying.
// Person 2 owns this file.
//
// main.js mounts it when the countdown starts:
//   const unmount = mount(root, {
//     net,                 // { on(event, fn), emit(event, payload, ack) } from net.js / mocknet.js
//     playerId,            // own id (null for a pure spectator)
//     lobby,               // last LobbyState, for names and colors
//     countdown,           // seconds from the countdown event that triggered the mount (optional)
//     onRoundEnd,          // (RoundEnd) => void, router shows results
//   });
// URL flags: ?fx=low|off cuts effects, ?fps=1 shows the frame rate.

import { S2C, CAR_STATE } from '../../../shared/protocol.js';
import { createRenderer } from '../render.js';
import { createInterp } from '../interp.js';
import * as input from '../input.js';

const CSS = `
.bb-game { position: fixed; inset: 0; background: #0b0d12; overflow: hidden;
  touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
.bb-game canvas { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.bb-pad { position: absolute; top: 0; bottom: 0; width: 50%; display: flex; align-items: flex-end;
  padding: 0 0 max(14px, env(safe-area-inset-bottom)); box-sizing: border-box; touch-action: none; }
.bb-pad.tap { left: 0; justify-content: flex-start; padding-left: max(14px, env(safe-area-inset-left)); }
.bb-pad.accel { right: 0; justify-content: flex-end; padding-right: max(14px, env(safe-area-inset-right)); }
.bb-pad .lbl { pointer-events: none; min-width: 96px; padding: 12px 18px; border-radius: 18px;
  font: 800 18px/1.1 system-ui, sans-serif; color: #fff; text-align: center;
  background: rgba(255,255,255,0.08); border: 2px solid rgba(255,255,255,0.18);
  transition: transform 60ms, background 60ms; }
.bb-pad .lbl small { display: block; font-weight: 600; font-size: 11px; opacity: 0.7; margin-top: 3px; }
.bb-pad.accel .lbl { min-width: 128px; padding: 22px 18px; }
.bb-pad.accel.down .lbl { background: rgba(92,225,160,0.35); border-color: #5ce1a0; transform: scale(0.95); }
.bb-pad.tap.down .lbl { background: rgba(77,208,225,0.35); border-color: #4dd0e1; transform: scale(0.95); }
.bb-game.out .bb-pad { display: none; }
.bb-overlay { position: absolute; inset: 0; display: none; flex-direction: column; align-items: center;
  justify-content: center; gap: 14px; background: rgba(6,8,12,0.94); color: #fff; text-align: center;
  font: 700 20px system-ui, sans-serif; z-index: 5; padding: 24px; }
.bb-overlay button { font: 800 20px system-ui, sans-serif; padding: 16px 28px; border-radius: 14px;
  border: 0; background: #ffd23f; color: #111; }
.bb-overlay .phone { width: 44px; height: 76px; border: 4px solid #fff; border-radius: 10px;
  animation: bb-rot 1.6s ease-in-out infinite; }
@keyframes bb-rot { 0%, 30% { transform: rotate(0); } 60%, 100% { transform: rotate(-90deg); } }
@media (orientation: portrait) { .bb-overlay.rotate { display: flex; } }
.bb-overlay.motion.show { display: flex; }
`;

function injectCss() {
  if (document.getElementById('bb-game-css')) return;
  const el = document.createElement('style');
  el.id = 'bb-game-css';
  el.textContent = CSS;
  document.head.appendChild(el);
}

/** net.js may or may not return an unsubscribe; handle both. */
function listen(net, event, fn) {
  const off = net.on(event, fn);
  if (typeof off === 'function') return off;
  return () => net.off?.(event, fn);
}

export function mount(root, { net, playerId = null, lobby = null, countdown = null, onRoundEnd } = {}) {
  injectCss();
  const params = new URLSearchParams(location.search);

  const el = document.createElement('div');
  el.className = 'bb-game';
  el.innerHTML = `
    <canvas></canvas>
    <div class="bb-pad tap"><div class="lbl">TAP<small>parry · recover</small></div></div>
    <div class="bb-pad accel"><div class="lbl">ACCEL<small>hold</small></div></div>
    <div class="bb-overlay motion"><div>Tilt steering needs motion access</div><button>Enable steering</button></div>
    <div class="bb-overlay rotate"><div class="phone"></div><div>Rotate your phone sideways</div></div>
  `;
  root.appendChild(el);

  const canvas = el.querySelector('canvas');
  const tapEl = el.querySelector('.bb-pad.tap');
  const accelEl = el.querySelector('.bb-pad.accel');
  const motionEl = el.querySelector('.bb-overlay.motion');

  const renderer = createRenderer(canvas, {
    showHud: true, fx: params.get('fx') || 'full', fps: params.get('fps') === '1',
  });
  renderer.setMe(playerId);
  if (lobby) renderer.setPlayers(lobby.players, lobby.mode);
  const interp = createInterp();

  let alive = true;           // screen mounted
  let count = null;           // countdown number on screen
  let goTimer = null;
  let myState = null;         // CAR_STATE of own car, null if not in the round
  let flipBase = null;        // input totals when we flipped
  let sending = false;
  let lastSnapAt = 0;

  // Motion permission fallback: lobby should already have asked from a tap.
  if (playerId && input.needsPermission()) motionEl.classList.add('show');
  motionEl.querySelector('button').addEventListener('click', async () => {
    await input.requestMotionPermission();
    motionEl.classList.remove('show');
    input.calibrate();
  });

  const unbind = input.bindButtons(accelEl, tapEl);
  if (playerId) { input.startSending(net); sending = true; }
  else el.classList.add('out');

  // ---------------------------------------------------------------------------
  // Network
  // ---------------------------------------------------------------------------

  function onCountdown({ seconds }) {
    if (count === null && seconds > 0) {
      interp.reset();               // new round: drop the last round's timeline
      myState = null;
      flipBase = null;
      el.classList.toggle('out', !playerId);
      if (playerId && !sending) { input.startSending(net); sending = true; }
      // Average the hold over most of the countdown. Keep the last 300 ms for "GO".
      input.calibrate(Math.max(400, seconds * 1000 - 300));
    }
    clearTimeout(goTimer);
    count = seconds;
    if (seconds <= 0) goTimer = setTimeout(() => { count = null; }, 600);
  }
  if (countdown != null) onCountdown({ seconds: countdown });

  const offs = [
    listen(net, S2C.COUNTDOWN, onCountdown),
    listen(net, S2C.SNAP, (snap) => {
      lastSnapAt = performance.now();
      interp.push(snap, lastSnapAt);
    }),
    listen(net, S2C.LOBBY, (l) => renderer.setPlayers(l.players, l.mode)),
    listen(net, S2C.ROUND_END, (res) => {
      stopSending();
      onRoundEnd?.(res);
    }),
  ];

  function stopSending() {
    if (sending) input.stopSending();
    sending = false;
  }

  // ---------------------------------------------------------------------------
  // Wake lock (re-acquired when the tab comes back)
  // ---------------------------------------------------------------------------

  let wakeLock = null;
  async function lockScreen() {
    try {
      if (document.visibilityState === 'visible' && navigator.wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch { /* unsupported or denied; not fatal */ }
  }
  const onVisible = () => { if (document.visibilityState === 'visible') lockScreen(); };
  document.addEventListener('visibilitychange', onVisible);
  lockScreen();

  // ---------------------------------------------------------------------------
  // Frame loop
  // ---------------------------------------------------------------------------

  function updateOwnState() {
    // Use the newest snapshot (not the delayed view) so the flip overlay reacts immediately.
    const snap = interp.latest();
    const mine = playerId && snap?.cars.find((c) => c.id === playerId);
    const prev = myState;
    myState = mine ? mine.s : null;

    if (myState === CAR_STATE.FLIPPED && prev !== CAR_STATE.FLIPPED) flipBase = input.totals();
    if (myState !== CAR_STATE.FLIPPED) flipBase = null;
    input.setAlive(myState === CAR_STATE.ALIVE);

    if (myState === CAR_STATE.DEAD) {
      el.classList.add('out');      // spectate the rest of the round
      stopSending();
    }

    if (!flipBase) return null;
    const now = input.totals();
    return {
      taps: Math.max(mine.taps || 0, now.taps - flipBase.taps),
      shakes: mine.shakes ?? now.shakes - flipBase.shakes,
    };
  }

  function banner() {
    if (!playerId) return 'Spectating';
    if (myState === CAR_STATE.DEAD) return "You're out · spectating";
    if (count === null && lastSnapAt && performance.now() - lastSnapAt > 1500) return 'Reconnecting…';
    return null;
  }

  let raf = 0;
  function frame(now) {
    if (!alive) return;
    raf = requestAnimationFrame(frame);
    const view = interp.sample(now);
    renderer.addEvents(interp.takeEvents(), view);
    const flip = updateOwnState();
    renderer.draw(view, now, {
      tilt: playerId && myState !== CAR_STATE.DEAD ? input.getTilt() : undefined,
      countdown: count,
      flip,
      banner: banner(),
    });
  }
  raf = requestAnimationFrame(frame);

  return function unmount() {
    alive = false;
    cancelAnimationFrame(raf);
    clearTimeout(goTimer);
    stopSending();
    unbind();
    offs.forEach((off) => off());
    document.removeEventListener('visibilitychange', onVisible);
    try { wakeLock?.release(); } catch { /* already released */ }
    renderer.destroy();
    el.remove();
  };
}

export default mount;

// Re-exported so the lobby can wire its buttons without importing input.js directly.
export { calibrate, requestMotionPermission } from '../input.js';
