// client/src/input.js
// Phone controls, all from tilt, measured from the grip calibrated in the countdown.
//   DRIVE_MODE 'omni' (default): tilt the phone the way you want to go on screen, like a marble
//     on a tray: roll right = right, tip the top edge away = up the screen. Sent as tilt = x,
//     throttle = y (up), with a round deadzone so diagonals work.
//   DRIVE_MODE 'car': roll steers, tip the top away to drive, toward you to brake / reverse.
// Tap anywhere (or shake) to flip back over. Person 2 owns this file.
//
// Usage:
//   await requestMotionPermission();   // from a user tap (iOS needs this + HTTPS)
//   bindTap(el);                       // taps on el count toward flip recovery
//   startSending(net);                 // emits C2S.INPUT at INPUT_HZ
//   calibrate();                       // lobby Recalibrate button, countdown: sets center for both
//
// Desktop fallback for dev: arrows / A,D steer, Up / W forward, Down reverse, Space = tap, S = shake.
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
  convSure: false,       // conv came from the screen's own rotation, not a guess
  pitch: 0,              // forward/back tilt in degrees from the calibrated grip, + = forward (smoothed)
  roll: 0,               // sideways tilt in degrees from the grip, without the car-mode boost (omni)
  pitchOffset: 30,       // fallback neutral tilt-back before any calibration (a typical grip)
  grav: { x: 0, y: 0, z: G }, // low-passed gravity, for devices without event.acceleration
  linMag: 0,             // |acceleration without gravity|
  keyThrottle: 0,
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

/**
 * How far the top edge is tilted away from you, in degrees (0 = upright facing you, 90 = flat
 * face up). conv turns the browser's gravity into Android's sign convention: without it,
 * forward and reverse would swap on browsers that report gravity inverted.
 */
export function pitchAngle(gx, gz, side, conv) {
  return Math.atan2(gz * conv, gx * side) * (180 / Math.PI);
}

/** Forward/back tilt from the calibrated grip -> throttle in [-1, 1], with a deadzone. */
export function shapeThrottle(deg) {
  const dz = cfg('THROTTLE_DEADZONE_DEG', 6);
  const m = Math.abs(deg);
  if (m < dz) return 0;
  const full = deg > 0 ? cfg('THROTTLE_FWD_DEG', 22) : cfg('THROTTLE_BACK_DEG', 16);
  return Math.sign(deg) * Math.min(1, (m - dz) / (full - dz));
}

export function getThrottle() {
  if (st.keyThrottle) return st.keyThrottle;
  return st.motionOk ? shapeThrottle(st.pitch) : 0;
}

/**
 * Omni: the direction you're tilting, { x: right, y: up the screen }, length 0..1.
 * Roll and tip are combined into one vector with a round deadzone, so a diagonal tilt goes
 * diagonally at the same speed as a straight one.
 */
export function getMove() {
  if (st.keySteer || st.keyThrottle) {
    const m = Math.hypot(st.keySteer, st.keyThrottle);
    return { x: st.keySteer / m, y: st.keyThrottle / m };
  }
  if (!st.motionOk) return { x: 0, y: 0 };
  const full = cfg('OMNI_TILT_DEG', 18);
  const sign = isIOS ? cfg('TILT_SIGN_IOS', 1) : cfg('TILT_SIGN_ANDROID', 1);
  const x = (st.roll * sign) / full, y = st.pitch / full;
  const m = Math.hypot(x, y), dz = cfg('OMNI_DEADZONE', 0.2);
  if (m < dz) return { x: 0, y: 0 };
  const k = Math.pow(Math.min(1, (m - dz) / (1 - dz)), cfg('TILT_EXPO', 1)) / m;
  return { x: x * k, y: y * k };
}

const omni = () => cfg('DRIVE_MODE', 'car') === 'omni';

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

  // Which sign convention does this browser use? Best: the screen's own rotation. Landscape
  // at 90 deg has the phone's x axis pointing up, which reads +g in Android's convention.
  // Otherwise guess: players face the screen, so z is positive unless the phone is upright.
  const scr = orientationAngle();
  if ((scr === 90 || scr === 270) && Math.abs(g.x) > 6) {
    st.conv = Math.sign(g.x) * (scr === 90 ? 1 : -1);
    st.convSure = true;
  } else if (!st.convSure && (st.conv == null || st.calSamples) && Math.abs(g.z) > 1.5) {
    // Guess only from the neutral grip (first reading or while calibrating), never mid-drive:
    // tipping back past upright flips z, and re-guessing then would swap forward and reverse.
    st.conv = Math.sign(g.z);
  }
  const conv = st.conv ?? (isIOS ? -1 : 1);
  // A calibration made with the wrong guess: flip its neutral tilt instead of driving backwards.
  if (st.ref && st.ref.conv !== conv) { st.ref.pitch0 = -st.ref.pitch0; st.ref.conv = conv; }

  // Which way is the phone held? Hysteresis so a hard turn doesn't flip it.
  // Judged by the direction of gravity across the screen, not its size, so a phone held nearly
  // flat like a controller (little gravity across the screen) still knows which side is up.
  const ax = Math.abs(g.x), ay = Math.abs(g.y), across = Math.hypot(g.x, g.y);
  if (across > 2.5 && ax > ay * 1.2) { st.side = Math.sign(g.x); st.hold = 'landscape'; }
  else if (across > 2.5 && ay > ax * 2) st.hold = 'portrait';

  // Relative to the calibrated pose when we have one for this landscape side; otherwise
  // the plain angle minus the calibrated offset (before the first calibration, or after
  // the phone was turned around).
  const gz = g.z ?? 0;
  const plain = wheelAngle(g.x, g.y, gz, st.side);
  const angle = st.ref && st.ref.side === st.side ? poseAngle(g.x, g.y, gz, st.ref) : plain - st.offset;
  st.angle += (angle - st.angle) * 0.5; // light low-pass; the server blends steering too
  // Omni wants sideways and forward tilt to feel the same, so no flat-grip boost here.
  const roll = st.ref && st.ref.side === st.side ? angle / st.ref.gain : angle;
  st.roll += (roll - st.roll) * 0.5;

  const rawPitch = pitchAngle(g.x, gz, st.side, conv);
  const pitch = rawPitch - (st.ref && st.ref.side === st.side ? st.ref.pitch0 : st.pitchOffset);
  st.pitch += (pitch - st.pitch) * 0.4;
  if (st.calSamples) st.calSamples.push({ x: g.x, y: g.y, z: gz, plain, pitch: rawPitch });

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
        st.pitchOffset = median('pitch');
        if (st.hold === 'landscape') {
          st.ref = makeRef({ x: median('x'), y: median('y'), z: median('z') }, st.side);
          st.ref.pitch0 = st.pitchOffset;              // neutral throttle = this grip
          st.ref.conv = st.conv ?? (isIOS ? -1 : 1);
        }
        st.angle = 0;
        st.roll = 0;
        st.pitch = 0;
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

/** Taps on el count toward flip recovery. el gets class "down" while pressed. Returns unbind. */
export function bindTap(el) {
  listen();
  const down = (e) => { e.preventDefault(); count('taps'); el.classList.add('down'); };
  const up = () => el.classList.remove('down');
  const noMenu = (e) => e.preventDefault();
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('contextmenu', noMenu);
  return () => {
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    el.removeEventListener('contextmenu', noMenu);
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
  const fwd = keysDown.has('arrowup') || keysDown.has('w');
  const back = keysDown.has('arrowdown');
  st.keyThrottle = (fwd ? 1 : 0) - (back ? 1 : 0);
  if (down && k === ' ') count('taps');
  if (down && k === 's') count('shakes');
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/** Build the next input message ({ seq, tilt, throttle, accel, taps }) and reset the counters. */
export function takeInput() {
  const r = (v) => Math.round(v * 1000) / 1000;
  const mv = omni() ? getMove() : null;
  const throttle = r(mv ? mv.y : getThrottle());
  const msg = {
    seq: st.seq++,
    tilt: r(mv ? mv.x : getTilt()), // omni: x of the direction; car: steering
    throttle,                       // omni: y (up the screen); car: forward/back
    accel: throttle > 0, // for servers that only know accel
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

export const isOmni = omni;

/** Snapshot for HUD and debug overlays. */
export function debugState() {
  return {
    motionOk: st.motionOk, angle: st.angle, offset: st.offset, tilt: getTilt(), hold: st.hold,
    side: st.side, conv: st.conv, convSure: st.convSure, pitch: st.pitch, throttle: getThrottle(), linMag: st.linMag,
    screenAngle: orientationAngle(), isIOS,
  };
}
