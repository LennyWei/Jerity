// client/src/input.js
// Phone controls: gravity steering, ACCEL/TAP buttons, shake and jerk gestures.
// Person 2 owns this file.
//
// Usage:
//   await requestMotionPermission();   // from a user tap (iOS needs this + HTTPS)
//   bindButtons(accelEl, tapEl);
//   startSending(net);                 // emits C2S.INPUT at INPUT_HZ
//   calibrate();                       // lobby Recalibrate button, countdown
//
// Desktop fallback for dev: arrows / A,D steer, W or Up = accel, Space = tap, S = shake, J = jerk.

import { CONFIG } from '../../shared/config.js';
import { C2S } from '../../shared/protocol.js';

// New tunables from the build plan; fall back until config.js has them.
const cfg = (k, d) => (CONFIG[k] ?? d);
const G = 9.81;

const st = {
  listening: false,
  motionOk: false,       // a devicemotion event with real numbers has arrived
  granted: false,        // requestMotionPermission() succeeded (events may not have arrived yet)
  raw: 0,                // m/s^2 of gravity on the steering axis (smoothed, sign-corrected)
  offset: 0,             // calibration
  grav: { x: 0, y: 0, z: G }, // low-passed gravity, for devices without event.acceleration
  linMag: 0,             // |acceleration without gravity|
  accelPointers: new Set(),
  keyAccel: false,
  keySteer: 0,
  taps: 0, shakes: 0, jerks: 0,         // since last sent input
  totals: { taps: 0, shakes: 0, jerks: 0 }, // never reset; screens diff these
  lastShakeAt: 0,
  lastJerkAt: 0,
  alive: true,
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
 * Gravity along the screen's "right" axis, negated so tilting the phone like a
 * steering wheel to the right gives a positive number (Android convention).
 * The per-platform sign is confirmed with public/tilt-test.html.
 */
export function steeringAxis(g, angle) {
  let raw;
  switch (Math.round(angle / 90) % 4) {
    case 1: raw = g.y; break;   // landscape, top of phone to the left
    case 2: raw = g.x; break;   // upside-down portrait
    case 3: raw = -g.y; break;  // landscape, top of phone to the right
    default: raw = -g.x;        // portrait
  }
  const sign = isIOS ? cfg('TILT_SIGN_IOS', 1) : cfg('TILT_SIGN_ANDROID', 1);
  return raw * sign;
}

/** Raw axis value -> steering in [-1, 1] with a rescaled deadzone. */
export function shapeSteer(raw, offset) {
  const dz = cfg('TILT_DEADZONE', 0.08);
  const s = (raw - offset) / cfg('TILT_MAX_G', 6);
  const m = Math.abs(s);
  if (m < dz) return 0;
  return Math.sign(s) * Math.min(1, (m - dz) / (1 - dz));
}

export function getTilt() {
  if (st.keySteer) return st.keySteer;
  return st.motionOk ? shapeSteer(st.raw, st.offset) : 0;
}

function onMotion(e) {
  const g = e.accelerationIncludingGravity;
  if (!g || g.x == null) return;
  st.motionOk = true;

  const raw = steeringAxis(g, orientationAngle());
  st.raw += (raw - st.raw) * 0.5; // light low-pass; the server blends steering too
  if (st.calSamples) st.calSamples.push(raw);

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

function detectGestures(mag, now) {
  const gap = cfg('SHAKE_GAP_MS', 120);
  if (mag > cfg('SHAKE_ACCEL', 14) && now - st.lastShakeAt >= gap) {
    st.lastShakeAt = now;
    count('shakes');
  }
  // A jerk is one sharp move, so give it a longer refractory window than a shake.
  if (st.alive && mag > cfg('JERK_ACCEL', 22) && now - st.lastJerkAt >= gap * 3) {
    st.lastJerkAt = now;
    count('jerks');
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
 * Treat the current hold as "straight". Averages samples over durationMs.
 * Resolves with the new offset. Safe to call without motion (resolves 0).
 */
export function calibrate(durationMs = 400) {
  listen();
  st.calSamples = [];
  return new Promise((resolve) => {
    setTimeout(() => {
      const s = st.calSamples || [];
      st.calSamples = null;
      if (s.length) {
        const max = cfg('TILT_MAX_G', 6);
        const mean = s.reduce((a, b) => a + b, 0) / s.length;
        st.offset = Math.max(-max, Math.min(max, mean));
      }
      resolve(st.offset);
    }, durationMs);
  });
}

// ---------------------------------------------------------------------------
// Buttons (pointer events) and keyboard fallback
// ---------------------------------------------------------------------------

/**
 * Hold accelEl to accelerate, tap tapEl to parry / recover. Returns an unbind function.
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
  if (down && k === 'j' && st.alive) count('jerks');
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export function isAccel() {
  return st.accelPointers.size > 0 || st.keyAccel;
}

/** Build the next input message and reset the per-message counters. */
export function takeInput() {
  const msg = {
    seq: st.seq++,
    tilt: Math.round(getTilt() * 1000) / 1000,
    accel: isAccel(),
    taps: st.taps,
    shakes: st.shakes,
    jerks: st.jerks,
  };
  st.taps = 0; st.shakes = 0; st.jerks = 0;
  return msg;
}

export function startSending(net) {
  stopSending();
  listen();
  st.taps = 0; st.shakes = 0; st.jerks = 0;
  st.sendTimer = setInterval(() => net.emit(C2S.INPUT, takeInput()),
    1000 / cfg('INPUT_HZ', 30));
}

export function stopSending() {
  if (st.sendTimer) clearInterval(st.sendTimer);
  st.sendTimer = null;
}

/** Jerks only count while the car is alive (they mean parry). */
export function setAlive(alive) {
  st.alive = alive;
}

/** fn(kind) runs on every tap / shake / jerk. Returns an unsubscribe function. */
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
    motionOk: st.motionOk, raw: st.raw, offset: st.offset, tilt: getTilt(),
    accel: isAccel(), linMag: st.linMag, angle: orientationAngle(), isIOS,
  };
}
