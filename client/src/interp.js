// client/src/interp.js
// Snapshot buffer. Draws the world INTERP_DELAY_MS behind the newest snapshot so
// cars move smoothly between 20 Hz updates. Person 2 owns this file.
//
//   const interp = createInterp();
//   net.on(S2C.SNAP, (s) => interp.push(s));
//   // each frame:
//   const view = interp.sample(performance.now());  // { t, cars, timeLeft }
//   const events = interp.takeEvents();             // events whose time has been drawn

import { CONFIG } from '../../shared/config.js';

const BUFFER = 10;
const TWO_PI = Math.PI * 2;

/** Shortest signed difference b - a, in (-PI, PI]. */
export function angleDelta(a, b) {
  let d = (b - a) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  if (d <= -Math.PI) d += TWO_PI;
  return d;
}

export function lerpAngle(a, b, f) {
  return a + angleDelta(a, b) * f;
}

function lerpCar(ca, cb, f) {
  const near = f < 0.5 ? ca : cb; // discrete fields from whichever snapshot is closer
  return {
    ...near,
    x: ca.x + (cb.x - ca.x) * f,
    y: ca.y + (cb.y - ca.y) * f,
    a: lerpAngle(ca.a, cb.a, f),
  };
}

export function createInterp({ delayMs = CONFIG.INTERP_DELAY_MS ?? 150, now = () => performance.now() } = {}) {
  let snaps = [];        // { t (server ms), snap }, oldest first
  let pending = [];      // { t, event } not yet handed out
  let offset = null;     // local clock - server clock, tracked at its low edge
  let renderT = -Infinity;

  function push(snap, recvAt = now()) {
    const t = typeof snap.t === 'number' ? snap.t : recvAt;
    const last = snaps[snaps.length - 1];
    if (last && t <= last.t) {
      // Out-of-order or server restart: a big jump back means a new timeline.
      if (last.t - t > 2000) reset(); else return;
    }

    // Lowest observed delay = least network jitter. Drift up slowly to follow clock drift.
    const sample = recvAt - t;
    if (offset === null || sample < offset) offset = sample;
    else offset += (sample - offset) * 0.01;

    snaps.push({ t, snap });
    if (snaps.length > BUFFER) snaps.shift();
    for (const e of snap.events || []) pending.push({ t, event: e });
    // If frames stop (tab hidden), don't replay a backlog of stale effects later.
    while (pending.length && pending[0].t < snaps[0].t) pending.shift();
  }

  function sample(at = now()) {
    if (!snaps.length) return null;
    renderT = at - offset - delayMs;

    if (renderT <= snaps[0].t || snaps.length === 1) return view(snaps[0].snap, snaps[0].snap.cars);
    const newest = snaps[snaps.length - 1];
    if (renderT >= newest.t) return view(newest.snap, newest.snap.cars);

    let i = snaps.length - 2;
    while (i > 0 && snaps[i].t > renderT) i--;
    const A = snaps[i], B = snaps[i + 1];
    const f = (renderT - A.t) / (B.t - A.t || 1);

    const byId = new Map(A.snap.cars.map((c) => [c.id, c]));
    const cars = B.snap.cars.map((cb) => {
      const ca = byId.get(cb.id);
      return ca ? lerpCar(ca, cb, f) : cb;
    });
    return view(f < 0.5 ? A.snap : B.snap, cars);
  }

  function view(snap, cars) {
    return { t: renderT, cars, timeLeft: snap.timeLeft, obstaclesDisabled: snap.obstaclesDisabled };
  }

  /** Events from snapshots at or before the last sampled time, so effects line up with the cars. */
  function takeEvents() {
    const out = [];
    while (pending.length && pending[0].t <= renderT) out.push(pending.shift().event);
    return out;
  }

  /** The newest snapshot as received, for state that should not wait (own HP, flip counter). */
  function latest() {
    return snaps.length ? snaps[snaps.length - 1].snap : null;
  }

  function reset() {
    snaps = [];
    pending = [];
    offset = null;
    renderT = -Infinity;
  }

  return { push, sample, takeEvents, latest, reset };
}
