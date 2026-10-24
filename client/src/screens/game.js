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

import { S2C, CAR_STATE, BUFF } from '../../../shared/protocol.js';
import { CONFIG } from '../../../shared/config.js';
import { CARS, DEFAULT_CAR, SCALE } from '../../../shared/constants.js';
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
.bb-game.out .bb-pad, .bb-game.out .bb-center { display: none; }
.bb-center { position: absolute; top: 52px; right: max(14px, env(safe-area-inset-right)); z-index: 3;
  font: 700 13px system-ui, sans-serif; color: #e8ecf4; padding: 7px 14px; border-radius: 999px;
  background: rgba(0,0,0,0.55); border: 1px solid rgba(255,255,255,0.25); touch-action: manipulation; }
.bb-center.done { color: #5ce1a0; border-color: #5ce1a0; }
.bb-overlay { position: absolute; inset: 0; display: none; flex-direction: column; align-items: center;
  justify-content: center; gap: 14px; background: rgba(6,8,12,0.94); color: #fff; text-align: center;
  font: 700 20px system-ui, sans-serif; z-index: 5; padding: 24px; }
.bb-overlay button { font: 800 20px system-ui, sans-serif; padding: 16px 28px; border-radius: 14px;
  border: 0; background: #ffd23f; color: #111; }
.bb-overlay .phone { width: 44px; height: 76px; border: 4px solid #fff; border-radius: 10px;
  animation: bb-rot 1.6s ease-in-out infinite; }
@keyframes bb-rot { 0%, 30% { transform: rotate(0); } 60%, 100% { transform: rotate(-90deg); } }
.bb-overlay.rotate.show { display: flex; }
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
    <div class="bb-pad tap"><div class="lbl">TAP<small>flip back</small></div></div>
    <div class="bb-pad accel"><div class="lbl">ACCEL<small>hold</small></div></div>
    <button class="bb-center" type="button">Center steering</button>
    <div class="bb-overlay motion"><div>Tilt steering needs motion access</div><button>Enable steering</button></div>
    <div class="bb-overlay rotate"><div class="phone"></div><div>Hold your phone sideways</div></div>
  `;
  root.appendChild(el);

  const canvas = el.querySelector('canvas');
  const tapEl = el.querySelector('.bb-pad.tap');
  const accelEl = el.querySelector('.bb-pad.accel');
  const motionEl = el.querySelector('.bb-overlay.motion');
  const rotateEl = el.querySelector('.bb-overlay.rotate');

  const renderer = createRenderer(canvas, {
    showHud: true, fx: params.get('fx') || 'full', fps: params.get('fps') === '1',
  });
  renderer.setMe(playerId);
  if (lobby) renderer.setPlayers(lobby.players);
  const interp = createInterp();

  let alive = true;           // screen mounted
  let count = null;           // countdown number on screen
  let goTimer = null;
  let myState = null;         // CAR_STATE of own car, null if not in the round
  let flipBase = null;        // input totals when we flipped
  let mySpeed = 0;            // m/s, estimated from snapshot positions (for the flip warning)
  let lastMine = null;
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

  // Re-center any time: whatever angle you hold now becomes "straight".
  const centerEl = el.querySelector('.bb-center');
  let centerTimer = 0;
  centerEl.addEventListener('click', async () => {
    await input.recenter();
    centerEl.textContent = 'Centered ✓';
    centerEl.classList.add('done');
    clearTimeout(centerTimer);
    centerTimer = setTimeout(() => { centerEl.textContent = 'Center steering'; centerEl.classList.remove('done'); }, 900);
  });
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
      trackSpeed(snap);
    }),
    listen(net, S2C.LOBBY, (l) => renderer.setPlayers(l.players)),
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

  function trackSpeed(snap) {
    const m = playerId && snap.cars.find((c) => c.id === playerId);
    const t = typeof snap.t === 'number' ? snap.t : lastSnapAt;
    if (m && lastMine && t > lastMine.t) {
      const v = Math.hypot(m.x - lastMine.x, m.y - lastMine.y) / SCALE / ((t - lastMine.t) / 1000);
      mySpeed += (v - mySpeed) * 0.5;
    }
    lastMine = m ? { x: m.x, y: m.y, t, buff: m.buff } : null;
  }

  /** 0..1: how close we are to tipping over (near max speed while steering near FLIP_TILT). */
  // Same threshold the server uses: base top speed (boost doesn't move it).
  const FLIP_SPEED = CARS[DEFAULT_CAR].maxSpeed * (CONFIG.FLIP_SPEED_FRAC ?? 0.85);
  const topSpeed = () => CARS[DEFAULT_CAR].maxSpeed * (lastMine?.buff === BUFF.BOOST ? CONFIG.BOOST_SPEED_MULT ?? 1 : 1);

  function flipDanger(tilt) {
    if (myState !== CAR_STATE.ALIVE || !lastMine) return 0;
    const flipSpeed = FLIP_SPEED;
    const near = Math.min(mySpeed / flipSpeed, Math.abs(tilt) / (CONFIG.FLIP_TILT ?? 0.85));
    return near < 0.85 ? 0 : Math.min(1, 0.3 + (near - 0.85) / 0.15 * 0.7);
  }

  function updateOwnState() {
    // Use the newest snapshot (not the delayed view) so the flip overlay reacts immediately.
    const snap = interp.latest();
    const mine = playerId && snap?.cars.find((c) => c.id === playerId);
    const prev = myState;
    myState = mine ? mine.s : null;

    if (myState === CAR_STATE.FLIPPED && prev !== CAR_STATE.FLIPPED) flipBase = input.totals();
    if (myState !== CAR_STATE.FLIPPED) flipBase = null;
    input.setFlipped(myState === CAR_STATE.FLIPPED);

    if (myState === CAR_STATE.DEAD) {
      el.classList.add('out');      // spectate the rest of the round
      stopSending();
    }

    if (!flipBase) return null;
    const now = input.totals();
    // Server count is authoritative; local taps + shakes fill the gap until it catches up.
    const local = now.taps - flipBase.taps + now.shakes - flipBase.shakes;
    return { taps: Math.max(mine.taps || 0, local) };
  }

  function banner() {
    if (!playerId) return 'Spectating';
    if (myState === CAR_STATE.DEAD) return "You're out · spectating";
    if (count === null && lastSnapAt && performance.now() - lastSnapAt > 1500) return 'Reconnecting…';
    return null;
  }

  // ---------------------------------------------------------------------------
  // Orientation: trust how the phone is held (gravity), not just the screen.
  // If the screen is portrait (rotation lock on, or mid auto-rotate) but the phone is
  // sideways, rotate the game ourselves instead of blocking it with an overlay.
  // ---------------------------------------------------------------------------

  let layoutWant = '', layoutSince = 0, layoutNow = '';
  function updateLayout(now) {
    let want = 'normal';
    if (innerHeight > innerWidth) {
      const { hold, rotate } = input.holdState();
      want = hold === 'landscape' && rotate ? `rot${rotate}` : 'rotate';
    }
    if (want !== layoutWant) { layoutWant = want; layoutSince = now; }
    // Ignore brief changes (an auto-rotate mid-turn); the first layout applies at once.
    const settle = want === 'rotate' && count === null && myState === CAR_STATE.ALIVE ? 700 : 250;
    if (want === layoutNow || (layoutNow && now - layoutSince < settle)) return;
    layoutNow = want;

    rotateEl.classList.toggle('show', want === 'rotate');
    const st = el.style;
    if (want.startsWith('rot') && want !== 'rotate') {
      const cw = want === 'rot90';
      Object.assign(st, {
        inset: 'auto', width: `${innerHeight}px`, height: `${innerWidth}px`,
        top: cw ? '0px' : `${innerHeight}px`, left: cw ? `${innerWidth}px` : '0px',
        transformOrigin: '0 0', transform: `rotate(${cw ? 90 : -90}deg)`,
      });
    } else {
      for (const k of ['inset', 'width', 'height', 'top', 'left', 'transformOrigin', 'transform']) st[k] = '';
    }
  }
  const onResize = () => { layoutNow = ''; };
  window.addEventListener('resize', onResize);

  let raf = 0;
  function frame(now) {
    if (!alive) return;
    raf = requestAnimationFrame(frame);
    updateLayout(now);
    const view = interp.sample(now);
    renderer.addEvents(interp.takeEvents(), view);
    const flip = updateOwnState();
    const showTilt = !!playerId && myState !== CAR_STATE.DEAD;
    const tilt = input.getTilt();
    renderer.draw(view, now, {
      tilt: showTilt ? tilt : undefined,
      danger: showTilt ? flipDanger(tilt) : 0,
      speed: showTilt && myState !== null ? mySpeed : undefined,
      maxSpeed: topSpeed(),
      flipSpeed: FLIP_SPEED,
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
    clearTimeout(centerTimer);
    offs.forEach((off) => off());
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('resize', onResize);
    try { wakeLock?.release(); } catch { /* already released */ }
    renderer.destroy();
    el.remove();
  };
}

export default mount;

// Re-exported so the lobby can wire its buttons without importing input.js directly.
export { calibrate, requestMotionPermission } from '../input.js';
