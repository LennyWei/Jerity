// client/src/input.js
// Phone controls: gravity steering, ACCEL/TAP buttons, shake-to-recover.
// Person 2 owns this file.
//
// Usage:
//   await requestMotionPermission();   // from a user tap (iOS needs this + HTTPS)
//   bindButtons(accelEl, tapEl);
//   startSending(net);                 // emits C2S.INPUT at INPUT_HZ
//   calibrate();                       // lobby Recalibrate button, countdown
//
// Desktop fallback for dev: arrows / A,D steer, W or Up = accel, Space = tap, S = shake.
//
// Flip recovery is taps (protocol). While flipped, each shake is also sent as a tap, so
// shaking the phone works too without any server change.

import { CONFIG } from '../../shared/config.js';
import { C2S } from '../../shared/protocol.js';

// New tunables from the build plan; fall back until config.js has them.
const cfg = (k, d) => (CONFIG[k] ?? d);
const G = 9.81;

const st = {
  listening: false,
  motionOk: false,       // a devicemotion event with real numbers has arrived
  granted: false,        // requestMotionPermission() succeeded (events may not have arrived yet)
  angle: 0,              // wheel angle in degrees, + = turned right (smoothed)
  offset: 0,             // calibration, degrees (fallback when there is no pose)
  ref: null,             // calibrated pose from makeRef: center + sensitivity follow the grip
  side: 1,               // which landscape the phone is held in, from gravity (sign of x)
  hold: null,            // 'landscape' | 'portrait' | null (flat / unknown), from gravity
  conv: null,            // +1 Android axis convention, -1 if this browser reports inverted gravity
  grav: { x: 0, y: 0, z: G }, // low-passed gravity, for devices without event.acceleration
  linMag: 0,             // |acceleration without gravity|
  accelPointers: new Set(),
  keyAccel: false,
  keySteer: 0,
  taps: 0, shakes: 0,                   // since last sent input
  totals: { taps: 0, shakes: 0 },       // never reset; screens diff these
  lastShakeAt: 0,
  shakeArmed: true,      // re-armed once acceleration falls back, so one push counts once
  flipped: false,
  seq: 0,
  sendTimer: null,
  calSamples: null,      // array while calibrating
  listeners: new Set(),  // gesture callbacks
};

const isIOS = typeof navigator !== 'undefined' &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
   (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

// ---------------------------------------------------------------------------
// Orientation and steering
// ---------------------------------------------------------------------------

/** Screen rotation in degrees (0, 90, 180, 270). Falls back to window.orientation before iOS 16.4. */
export function orientationAngle() {
  let a = screen.orientation?.angle;
  if (typeof a !== 'number') a = typeof window.orientation === 'number' ? window.orientation : 0;
  return ((a % 360) + 360) % 360;
}

/**
 * Steering angle in degrees (+ = turned right) for a phone held sideways.
 *
 * It is how far the phone's long edge tilts away from level (its bank against gravity),
 * which is the same whether you turn it like a steering wheel or roll it like a game
 * controller held flat. Tilting the phone back weakens that reading a little, so it gets
 * a mild boost (at most 1.4x). The old in-the-screen-plane angle blew small rolls up 3x
 * when the phone was held back, so a tiny tilt was nearly full lock.
 * It never reads screen.orientation, so an auto-rotate mid-turn cannot make steering jump.
 * `side` is the sign of gravity on the phone's short axis; gy * side gives the same result
 * whether a browser reports gravity with Android's sign or inverted.
 */
export function wheelAngle(gx, gy, gz, side) {
  const mag = Math.hypot(gx, gy, gz) || G;
  const bank = Math.asin(Math.max(-1, Math.min(1, (gy * side) / mag))) * (180 / Math.PI);
  const upright = Math.max(0.5, Math.min(1, Math.hypot(gx, gy) / mag)); // cos of tilt-back
  return bank / Math.sqrt(upright);
}

/**
 * The calibrated pose: how the player held the phone when they set "straight".
 * g0 is gravity at that moment (device axes, any length); side is which landscape.
 * The steering axis r is the phone's long edge, leveled for that pose, so the neutral
 * hold reads exactly 0 however the phone is tilted back or held crooked. gain makes up
 * for the long edge moving less when the phone is held back (at most 1.4x), and is fixed
 * at calibration so sensitivity doesn't shift while you play.
 */
export function makeRef(g0, side) {
  const m = Math.hypot(g0.x, g0.y, g0.z) || G;
  const u = { x: g0.x / m, y: g0.y / m, z: g0.z / m };
  const r = { x: -u.y * u.x, y: 1 - u.y * u.y, z: -u.y * u.z }; // long edge minus its gravity part
  const rm = Math.hypot(r.x, r.y, r.z) || 1;
  return {
    r: { x: r.x / rm, y: r.y / rm, z: r.z / rm },
    gain: 1 / Math.sqrt(Math.max(0.5, Math.min(1, Math.hypot(u.x, u.y)))),
    side,
  };
}

/** Steering angle in degrees (+ = right) relative to the calibrated pose. */
export function poseAngle(gx, gy, gz, ref) {
  const mag = Math.hypot(gx, gy, gz) || G;
  const d = (gx * ref.r.x + gy * ref.r.y + gz * ref.r.z) / mag;
  return Math.asin(Math.max(-1, Math.min(1, d))) * (180 / Math.PI) * ref.side * ref.gain;
}

/** Wheel angle -> steering in [-1, 1] with a rescaled deadzone. */
export function shapeSteer(angle, offset) {
  const dz = cfg('TILT_DEADZONE', 0.08);
  const sign = isIOS ? cfg('TILT_SIGN_IOS', 1) : cfg('TILT_SIGN_ANDROID', 1);
  const s = ((angle - offset) / cfg('TILT_MAX_DEG', 30)) * sign;
  const m = Math.abs(s);
  if (m < dz) return 0;
  // Response curve: small tilts give fine control, full lock is unchanged.
  const lin = Math.min(1, (m - dz) / (1 - dz));
  return Math.sign(s) * Math.pow(lin, cfg('TILT_EXPO', 1));
}

export function getTilt() {
  if (st.keySteer) return st.keySteer;
  return st.motionOk ? shapeSteer(st.angle, 0) : 0; // st.angle is already relative to center
}

/**
 * How the phone is physically held, from gravity. `rotate` is the CSS rotation (deg) that
 * makes the game upright when the screen is stuck in portrait (iPhone rotation lock),
 * or 0 if unknown. hold is null when the phone is flat or no motion data has arrived.
 */
export function holdState() {
  const conv = st.conv ?? (isIOS ? -1 : 1);
  return { hold: st.hold, rotate: st.hold === 'landscape' ? (st.side * conv > 0 ? 90 : -90) : 0 };
}

function onMotion(e) {
  const g = e.accelerationIncludingGravity;
  if (!g || g.x == null) return;
  st.motionOk = true;

  // Players face the screen, so z is clearly positive in Android's convention unless the
  // phone is near vertical. Learn the browser's sign from that (only matters for holdState).
  if (Math.abs(g.z) > 3) st.conv = Math.sign(g.z);

  // Which way is the phone held? Hysteresis so a hard turn doesn't flip it.
  const ax = Math.abs(g.x), ay = Math.abs(g.y);
  if (ax > 6 && ax > ay * 1.2) { st.side = Math.sign(g.x); st.hold = 'landscape'; }
  else if (ay > 7 && ay > ax * 2) st.hold = 'portrait';

  // Relative to the calibrated pose when we have one for this landscape side; otherwise
  // the plain angle minus the calibrated offset (before the first calibration, or after
  // the phone was turned around).
  const gz = g.z ?? 0;
  const plain = wheelAngle(g.x, g.y, gz, st.side);
  const angle = st.ref && st.ref.side === st.side ? poseAngle(g.x, g.y, gz, st.ref) : plain - st.offset;
  st.angle += (angle - st.angle) * 0.5; // light low-pass; the server blends steering too
  if (st.calSamples) st.calSamples.push({ x: g.x, y: g.y, z: gz, plain });

  // Linear acceleration: use the OS value if present, else subtract low-passed gravity.
  st.grav.x += (g.x - st.grav.x) * 0.1;
  st.grav.y += (g.y - st.grav.y) * 0.1;
  st.grav.z += (g.z - st.grav.z) * 0.1;
  const a = e.acceleration;
  const lx = a?.x ?? g.x - st.grav.x;
  const ly = a?.y ?? g.y - st.grav.y;
  const lz = a?.z ?? g.z - st.grav.z;
  st.linMag = Math.hypot(lx || 0, ly || 0, lz || 0);
  detectGestures(st.linMag, performance.now());
}

/**
 * Counts one shake per push above SHAKE_ACCEL. The detector re-arms only after the
 * reading falls below half the threshold, so one long push is one shake, not three.
 */
export function detectGestures(mag, now) {
  const shakeAt = cfg('SHAKE_ACCEL', 11);
  if (mag < shakeAt * 0.5) st.shakeArmed = true;
  if (st.shakeArmed && mag > shakeAt && now - st.lastShakeAt >= cfg('SHAKE_GAP_MS', 100)) {
    st.shakeArmed = false;
    st.lastShakeAt = now;
    count('shakes');
  }
}

function count(kind) {
  st[kind] += 1;
  st.totals[kind] += 1;
  for (const fn of st.listeners) fn(kind);
}

/**
 * Ask for motion access (iOS 13+) and start listening. Call from a user tap.
 * Resolves true if motion is (or may become) available.
 */
export async function requestMotionPermission() {
  try {
    if (typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function') {
      const res = await DeviceMotionEvent.requestPermission();
      if (res !== 'granted') return false;
    }
  } catch (err) {
    console.warn('motion permission failed', err);
    return false;
  }
  st.granted = true;
  listen();
  return typeof DeviceMotionEvent !== 'undefined';
}

/** True if a permission tap is still needed before tilt can work. */
export function needsPermission() {
  return !st.granted && !st.motionOk && typeof DeviceMotionEvent !== 'undefined' &&
    typeof DeviceMotionEvent.requestPermission === 'function';
}

function listen() {
  if (st.listening) return;
  st.listening = true;
  window.addEventListener('devicemotion', onMotion);
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);
}

/**
 * Treat the way the phone is held right now as "straight": records the whole pose
 * (see makeRef), so center and sensitivity follow the player's own grip. Collects samples
 * for durationMs and uses the median of the last 60%, so the moment of tapping Start
 * (phone still moving into position) and single jolts don't shift it.
 * Safe to call without motion (keeps the old calibration).
 */
export function calibrate(durationMs = 400) {
  listen();
  st.calSamples = [];
  return new Promise((resolve) => {
    setTimeout(() => {
      const all = st.calSamples || [];
      const s = all.slice(-Math.ceil(all.length * 0.6));
      st.calSamples = null;
      if (s.length) {
        const median = (k) => { const v = s.map((p) => p[k]).sort((a, b) => a - b); return v[v.length >> 1]; };
        const max = cfg('TILT_MAX_DEG', 30) * 1.5;
        st.offset = Math.max(-max, Math.min(max, median('plain')));
        if (st.hold === 'landscape') st.ref = makeRef({ x: median('x'), y: median('y'), z: median('z') }, st.side);
        st.angle = 0;
      }
      resolve(st.offset);
    }, durationMs);
  });
}

/** Re-center right now (in-game Center button): quick, from the current hold. */
export function recenter() {
  if (!st.motionOk) return Promise.resolve(st.offset);
  return calibrate(250);
}

// ---------------------------------------------------------------------------
// Buttons (pointer events) and keyboard fallback
// ---------------------------------------------------------------------------

/**
 * Hold accelEl to accelerate, tap tapEl to recover from a flip. Returns an unbind function.
 * Both elements get class "down" while pressed, for feedback.
 */
export function bindButtons(accelEl, tapEl) {
  listen();
  const accelDown = (e) => {
    e.preventDefault();
    accelEl.setPointerCapture?.(e.pointerId);
    st.accelPointers.add(e.pointerId);
    accelEl.classList.add('down');
  };
  const accelUp = (e) => {
    st.accelPointers.delete(e.pointerId);
    if (!st.accelPointers.size) accelEl.classList.remove('down');
  };
  const tapDown = (e) => {
    e.preventDefault();
    count('taps');
    tapEl.classList.add('down');
  };
  const tapUp = () => tapEl.classList.remove('down');

  accelEl.addEventListener('pointerdown', accelDown);
  accelEl.addEventListener('pointerup', accelUp);
  accelEl.addEventListener('pointercancel', accelUp);
  tapEl.addEventListener('pointerdown', tapDown);
  tapEl.addEventListener('pointerup', tapUp);
  tapEl.addEventListener('pointercancel', tapUp);
  const noMenu = (e) => e.preventDefault();
  accelEl.addEventListener('contextmenu', noMenu);
  tapEl.addEventListener('contextmenu', noMenu);

  return () => {
    accelEl.removeEventListener('pointerdown', accelDown);
    accelEl.removeEventListener('pointerup', accelUp);
    accelEl.removeEventListener('pointercancel', accelUp);
    tapEl.removeEventListener('pointerdown', tapDown);
    tapEl.removeEventListener('pointerup', tapUp);
    tapEl.removeEventListener('pointercancel', tapUp);
    accelEl.removeEventListener('contextmenu', noMenu);
    tapEl.removeEventListener('contextmenu', noMenu);
    st.accelPointers.clear();
  };
}

const keysDown = new Set();
function onKey(e) {
  const down = e.type === 'keydown';
  const k = e.key.toLowerCase();
  if (down && e.repeat) return;
  if (down) keysDown.add(k); else keysDown.delete(k);
  const left = keysDown.has('arrowleft') || keysDown.has('a');
  const right = keysDown.has('arrowright') || keysDown.has('d');
  st.keySteer = (right ? 1 : 0) - (left ? 1 : 0);
  st.keyAccel = keysDown.has('arrowup') || keysDown.has('w');
  if (down && k === ' ') count('taps');
  if (down && k === 's') count('shakes');
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export function isAccel() {
  return st.accelPointers.size > 0 || st.keyAccel;
}

/** Build the next input message ({ seq, tilt, accel, taps }) and reset the counters. */
export function takeInput() {
  const msg = {
    seq: st.seq++,
    tilt: Math.round(getTilt() * 1000) / 1000,
    accel: isAccel(),
    taps: st.taps + (st.flipped ? st.shakes : 0),
  };
  st.taps = 0; st.shakes = 0;
  return msg;
}

export function startSending(net) {
  stopSending();
  listen();
  st.taps = 0; st.shakes = 0;
  st.sendTimer = setInterval(() => net.emit(C2S.INPUT, takeInput()),
    1000 / cfg('INPUT_HZ', 30));
}

export function stopSending() {
  if (st.sendTimer) clearInterval(st.sendTimer);
  st.sendTimer = null;
}

/** While flipped, shakes are sent as recovery taps. */
export function setFlipped(flipped) {
  st.flipped = flipped;
}

/** fn(kind) runs on every tap / shake. Returns an unsubscribe function. */
export function onGesture(fn) {
  st.listeners.add(fn);
  return () => st.listeners.delete(fn);
}

/** Cumulative counts, for "since I flipped" counters. */
export function totals() {
  return { ...st.totals };
}

/** Snapshot for HUD and debug overlays. */
export function debugState() {
  return {
    motionOk: st.motionOk, angle: st.angle, offset: st.offset, tilt: getTilt(), hold: st.hold,
    side: st.side, conv: st.conv, accel: isAccel(), linMag: st.linMag,
    screenAngle: orientationAngle(), isIOS,
  };
}
