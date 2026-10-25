// client/src/sfx.js
// Game sound effects, synthesized with the Web Audio API (no audio files): countdown beeps and
// GO, hit thumps that get heavier with damage, the head-on clang, wall bumps, the KO explosion,
// flip and recover, and the round-win and match-win stings.
//
//   playEvents(events, { all: true, view })        // laptop: every arena event, panned left/right
//   playEvents(events, { me: playerId, small: true }) // phone: only events you are in
//   playCountdown(seconds, { small })               // 4, 3, 2, 1: beep; 0: GO
//   playRoundEnd({ won, final, small })             // round sting, or the match fanfare
//
// small: a phone speaker has no deep bass, so the low thumps and booms sit higher there.
// Everything respects the mute switch (the corner ♪, jerity-audio.js) and drops to DUCK while
// Jerity runs her exchange (her voice, and the players' microphones while she listens).
// Browsers start audio locked: the first tap or key anywhere unlocks it (the spectator page
// shows a prompt until then, see onAudioReady).

import { ARENA } from '../../shared/constants.js';
import { EVENT, HIT_KIND, S2C } from '../../shared/protocol.js';
import { soundMuted } from './jerity-audio.js';
import { net } from './net.js';

const VOLUME = 0.7;
const DUCK = 0.3;           // level while Jerity is talking or listening
const MAX_BURST = 10;       // sounds started within BURST_S; a pile-up beyond that is skipped
const BURST_S = 0.15;

let ctx = null, master = null, noise = null;
let ducked = false;
const started = [];         // start times of recent sounds (the burst limiter)
const readyFns = new Set();
let announced = false;      // readyFns told about the current running stretch

function announce() {
  if (ctx?.state !== 'running' || announced) return;
  announced = true;
  readyFns.forEach((fn) => fn());
}

// ---------------------------------------------------------------------------
// Context, unlock, ducking
// ---------------------------------------------------------------------------

function ensureContext() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC({ latencyHint: 'interactive' });
  // A compressor on the way out, so a pile-up on the laptop never clips.
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 6;
  comp.attack.value = 0.003; comp.release.value = 0.25;
  master = ctx.createGain();
  master.gain.value = VOLUME;
  master.connect(comp);
  comp.connect(ctx.destination);
  noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate); // white noise for every noisy sound
  const d = noise.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  ctx.onstatechange = () => { if (ctx.state !== 'running') announced = false; announce(); };
  return ctx;
}

/** Call from a tap or click (any gesture unlocks; this is for an explicit "sound on" button). */
export function unlockSfx() {
  const c = ensureContext();
  if (!c) return;
  if (c.state === 'running') return announce(); // made inside a gesture: running from the start
  c.resume().then(announce, () => {});
  const s = c.createBufferSource(); // iOS also wants a sound started inside the gesture
  s.buffer = c.createBuffer(1, 1, 22050);
  s.connect(c.destination);
  s.start(0);
}
for (const type of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown']) {
  addEventListener(type, unlockSfx, { capture: true, passive: true });
}

export const audioReady = () => ctx?.state === 'running';
/** fn() whenever audio becomes able to play (also after the phone suspends and resumes it). */
export function onAudioReady(fn) { readyFns.add(fn); return () => readyFns.delete(fn); }
/** fn() whenever the browser stops audio again (tab hidden, a phone call). Returns an unsubscribe. */
export function onAudioLocked(fn) {
  const check = () => { if (ctx && ctx.state !== 'running') fn(); };
  addEventListener('visibilitychange', check);
  return () => removeEventListener('visibilitychange', check);
}

// While Jerity runs her round-opening exchange, everything else is quieter.
net.on(S2C.JERITY_STATE, (s) => { ducked = !!s?.phase && s.phase !== 'idle'; });
net.on(S2C.LOBBY, (l) => { ducked = !!l?.jerity?.phase && l.jerity.phase !== 'idle'; });

/** Ready to play now? (unlocked, not muted, not part of a pile-up) */
function canPlay() {
  if (soundMuted() || ctx?.state !== 'running') return false;
  const t = ctx.currentTime;
  while (started.length && started[0] < t - BURST_S) started.shift();
  if (started.length >= MAX_BURST) return false;
  started.push(t);
  return true;
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

/** A sound's own output: its level (ducked while Jerity talks), panned left/right on the laptop. */
function out(level, pan = 0) {
  const g = ctx.createGain();
  g.gain.value = level * (ducked ? DUCK : 1);
  if (pan && ctx.createStereoPanner) {
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    g.connect(p);
    p.connect(master);
  } else g.connect(master);
  return g;
}

/** Envelope: up to peak in attack seconds, then an exponential fall to silence over decay. */
function env(param, t, peak, attack, decay) {
  param.setValueAtTime(0.0001, t);
  param.exponentialRampToValueAtTime(peak, t + attack);
  param.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

/** An oscillator note, optionally sliding from f0 to f1. */
function tone(dest, { type = 'sine', f0, f1 = f0, t = ctx.currentTime, attack = 0.004, decay = 0.2, peak = 0.5 }) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + attack + decay);
  env(g.gain, t, peak, attack, decay);
  o.connect(g);
  g.connect(dest);
  o.start(t);
  o.stop(t + attack + decay + 0.05);
}

/** Filtered white noise, the filter optionally sweeping from f0 to f1. */
function hiss(dest, { type = 'lowpass', f0 = 2000, f1 = f0, q = 0.7, t = ctx.currentTime, attack = 0.002, decay = 0.2, peak = 0.5 }) {
  const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
  s.buffer = noise;
  s.loop = true;
  f.type = type;
  f.Q.value = q;
  f.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(f1, t + attack + decay);
  env(g.gain, t, peak, attack, decay);
  s.connect(f);
  f.connect(g);
  g.connect(dest);
  s.start(t, Math.random() * 1.5);
  s.stop(t + attack + decay + 0.05);
}

// ---------------------------------------------------------------------------
// The sounds
// ---------------------------------------------------------------------------

/** Bumper hit: a low body thump, a crunch and a rubber knock; heavier with damage, doubled for a rear hit. */
function hit(power, { rear = false, small = false, pan = 0 } = {}) {
  const o = out(0.55 + 0.45 * power, pan), base = (small ? 230 : 140) * (rear ? 0.85 : 1);
  tone(o, { f0: base, f1: base * 0.4, decay: 0.12 + 0.14 * power, peak: 0.55 + 0.35 * power });
  hiss(o, { f0: 2600, f1: 450, decay: 0.08 + 0.12 * power, peak: 0.22 + 0.35 * power });
  tone(o, { type: 'triangle', f0: small ? 560 : 430, f1: 300, decay: 0.05, peak: 0.2 });
  if (rear) tone(o, { f0: base * 0.8, f1: base * 0.35, t: ctx.currentTime + 0.035, decay: 0.16, peak: 0.45 });
}

/** Head-on: a ringing metallic clang (inharmonic partials) over a hard thump. */
function headon({ small = false, pan = 0 } = {}) {
  const o = out(0.8, pan);
  [1, 1.48, 2.24, 3.17, 4.6].forEach((r, i) => tone(o, {
    type: i < 2 ? 'square' : 'sine', f0: 330 * r, f1: 330 * r * 0.97, decay: 0.85 - i * 0.12, peak: i < 2 ? 0.07 : 0.11,
  }));
  hiss(o, { type: 'highpass', f0: 3200, decay: 0.07, peak: 0.4 });
  hit(0.8, { small, pan });
}

/** Wall or obstacle: a short muffled thud. */
function wall(power, { small = false, pan = 0 } = {}) {
  const o = out(0.45, pan), base = small ? 200 : 110;
  tone(o, { f0: base, f1: base * 0.5, decay: 0.1, peak: 0.35 + 0.45 * power });
  hiss(o, { f0: 900, f1: 280, decay: 0.07, peak: 0.16 + 0.2 * power });
}

/** KO: a boom, a blast of noise that darkens as it fades, crackles, and a rumbling tail. */
function explosion({ small = false, pan = 0, big = false } = {}) {
  const o = out(big ? 1 : 0.85, pan), t = ctx.currentTime;
  tone(o, { f0: small ? 120 : 72, f1: small ? 48 : 30, attack: 0.005, decay: 0.9, peak: 0.9 });
  hiss(o, { f0: 4200, f1: 170, q: 0.5, attack: 0.004, decay: 1.1, peak: 0.8 });
  hiss(o, { f0: small ? 500 : 300, attack: 0.05, decay: 1.5, peak: 0.28 });
  for (let i = 0; i < 7; i++) {
    hiss(o, { type: 'highpass', f0: 2200 + Math.random() * 2500, t: t + 0.05 + Math.random() * 0.5, decay: 0.03, peak: 0.12 + Math.random() * 0.16 });
  }
}

/** Tipped over: a whoosh up and over, then the clunk of the car landing on its back. */
function flip({ small = false, pan = 0 } = {}) {
  const o = out(0.7, pan), t = ctx.currentTime;
  hiss(o, { type: 'bandpass', f0: 380, f1: 2600, q: 1.4, attack: 0.16, decay: 0.12, peak: 0.45 });
  hiss(o, { type: 'bandpass', f0: 2600, f1: 500, q: 1.4, t: t + 0.24, decay: 0.16, peak: 0.3 });
  tone(o, { type: 'triangle', f0: small ? 380 : 300, f1: 120, t: t + 0.36, decay: 0.12, peak: 0.4 });
  tone(o, { f0: small ? 210 : 120, f1: 60, t: t + 0.36, decay: 0.14, peak: 0.45 });
}

/** Back on its wheels: a quick rising chirp. */
function recover({ pan = 0 } = {}) {
  const o = out(0.6, pan), t = ctx.currentTime;
  [784, 988, 1175, 1568].forEach((f, i) => tone(o, { type: 'square', f0: f, t: t + i * 0.055, decay: 0.09, peak: 0.16 }));
}

/** Countdown: a beep per second, and a brighter rising GO. */
export function playCountdown(seconds, { small = false } = {}) {
  if (!canPlay()) return;
  const o = out(0.8), t = ctx.currentTime;
  if (seconds > 0) {
    tone(o, { type: 'square', f0: 660, decay: 0.14, peak: 0.22 });
    tone(o, { f0: 1320, decay: 0.1, peak: 0.12 });
  } else {
    tone(o, { type: 'square', f0: 660, f1: 880, attack: 0.03, decay: 0.42, peak: 0.24 });
    tone(o, { type: 'square', f0: 1320, t: t + 0.03, decay: 0.42, peak: 0.16 });
    tone(o, { f0: 1760, t: t + 0.03, decay: 0.38, peak: 0.12 });
    if (!small) tone(o, { f0: 220, f1: 110, decay: 0.2, peak: 0.3 }); // a little kick under GO
  }
}

/**
 * Round over. won: the winner's jingle (always on the laptop); otherwise a soft "round over".
 * final: the match fanfare instead (ta-ta-ta-taaa, a chord, and a cymbal).
 */
export function playRoundEnd({ won = true, final = false, small = false } = {}) {
  if (!canPlay()) return;
  const o = out(0.8), t = ctx.currentTime;
  const note = (f, at, decay, peak, type = 'triangle') => {
    tone(o, { type, f0: f, t: t + at, decay, peak });
    tone(o, { type: 'square', f0: f, t: t + at, decay: decay * 0.7, peak: peak * 0.3 });
  };
  if (final && won) {
    [392, 392, 392].forEach((f, i) => note(f, i * 0.12, 0.09, 0.3));
    [523.25, 659.25, 783.99].forEach((f) => note(f, 0.38, 1.1, 0.24));
    [1046.5, 1318.5].forEach((f, i) => note(f, 0.62 + i * 0.1, 0.9, 0.16));
    hiss(o, { type: 'highpass', f0: 6000, t: t + 0.38, attack: 0.01, decay: 1.3, peak: small ? 0.14 : 0.2 });
    if (!small) tone(o, { f0: 130.8, t: t + 0.38, decay: 0.9, peak: 0.3 });
  } else if (won) {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => note(f, i * 0.085, 0.16, 0.26));
    [523.25, 659.25, 783.99, 1046.5].forEach((f) => note(f, 0.36, 0.6, 0.14));
    tone(o, { f0: 2093, t: t + 0.4, decay: 0.5, peak: 0.07 });
  } else {
    note(659.25, 0, 0.18, 0.18);
    note(523.25, 0.16, 0.42, 0.16);
  }
}

/**
 * Arena events from interp.takeEvents(). all: every event (the laptop), panned by where it
 * happened when view is given; otherwise only events `me` is in (a phone).
 */
export function playEvents(events, { me = null, all = false, small = false, view = null } = {}) {
  if (!events?.length || soundMuted() || ctx?.state !== 'running') return;
  const cars = view ? new Map(view.cars.map((c) => [c.id, c])) : null;
  const panOf = (...ids) => {
    const c = cars && ids.map((id) => cars.get(id)).find(Boolean);
    return c ? Math.max(-0.8, Math.min(0.8, (c.x / ARENA.W) * 2 - 1)) : 0;
  };
  const mine = (...ids) => all || (me !== null && ids.includes(me));
  for (const e of events) {
    switch (e.type) {
      case EVENT.HIT:
        if (mine(e.attacker, e.victim) && canPlay()) {
          hit(Math.min(1, (e.dmg || 0) / 50), { rear: e.kind === HIT_KIND.REAR, small, pan: panOf(e.victim) });
        }
        break;
      case EVENT.HEADON:
        if (mine(e.a, e.b) && canPlay()) headon({ small, pan: panOf(e.a, e.b) });
        break;
      case EVENT.WALL:
        if (mine(e.id) && canPlay()) wall(Math.min(1, (e.dmg || 0) / 12 + 0.3), { small, pan: panOf(e.id) });
        break;
      case EVENT.KILL:
        if (mine(e.victim, e.attacker) && canPlay()) explosion({ small, pan: panOf(e.victim), big: e.victim === me });
        break;
      case EVENT.FLIP:
        if (mine(e.id) && canPlay()) flip({ small, pan: panOf(e.id) });
        break;
      case EVENT.RECOVER:
        if (mine(e.id) && canPlay()) recover({ pan: panOf(e.id) });
        break;
    }
  }
}
