// client/src/verity-ui.js
// Verity, the helper on the menu and lobby screens. Analog horror: a cheerful assistant on the
// surface who turns curt, then rude, then ominous the longer you stay and the more you come back.
// Person 4 owns this file.
//
//   const v = mountVerity(el, { lines: LINES.home, name: () => 'Sam' });  // face + speech bubble
//   v.say('Great choice!');   v.destroy();
//   bumpCorruption(0.1);      // e.g. after a round
//
// Corruption (0..1) lives on <html> as --corrupt and data-verity-stage (0..3); the CSS in
// style.css turns it into drained color, heavier scanlines, tears and a red tint.

import { store } from './ui.js';

const VISITS_KEY = 'jerity-visits';
const EXTRA_KEY = 'jerity-corruption';
const MINUTES_TO_FULL = 6;   // menus alone take this long to go fully wrong
const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// Each page load counts as a visit; coming back starts him further along.
const visits = (Number(store.get(VISITS_KEY, '0')) || 0) + 1;
store.set(VISITS_KEY, String(visits));
let extra = Number(store.get(EXTRA_KEY, '0')) || 0;
let menuSeconds = 0;

export function corruption() {
  return Math.min(1, Math.min(0.45, (visits - 1) * 0.08) + extra + menuSeconds / (MINUTES_TO_FULL * 60));
}
export const stageOf = (c) => (c < 0.25 ? 0 : c < 0.5 ? 1 : c < 0.75 ? 2 : 3);

/** Something happened that wears him down (a finished round, leaving a room). */
export function bumpCorruption(amount) {
  extra = Math.min(1, extra + amount);
  store.set(EXTRA_KEY, extra.toFixed(3));
  apply();
}

function apply() {
  const c = corruption();
  document.documentElement.style.setProperty('--corrupt', c.toFixed(3));
  document.documentElement.dataset.verityStage = String(stageOf(c));
}
apply();

// Lines by stage. {name} is the player's name (or "friend").
export const LINES = {
  home: [
    ['Hi there! I’m Verity, your game helper :)', 'Type your name and I’ll take care of everything!',
      'Make a room, or join your friends. I’ll be right here!', 'Tilt your phone to drive. Isn’t that fun?'],
    ['Hello again, {name}.', 'Your name, please. Then a room.', 'Take your time. I have plenty of it.',
      'You came back. Interesting.'],
    ['You again.', 'Hurry up. They are waiting.', 'That name doesn’t suit you, {name}.',
      'I don’t remember inviting you.'],
    ['I remember you, {name}.', 'Nobody leaves the arena.', 'Why did you come back.', 'Stop looking at me like that.'],
  ],
  lobby: [
    ['Your room is ready! Share the code with your friends :)', 'Scan the QR code to join. Easy!',
      'Everyone press Ready, then the host taps Start!', 'Bots can fill empty seats. They’re very polite.'],
    ['Still waiting? I can wait.', 'Share the code. Or don’t.', 'The bots don’t mind waiting. Neither do I.'],
    ['Is this everyone? How sad.', 'Press Start. I’m getting bored.', 'One of you is going to lose. I already know who.'],
    ['I can see all of you.', 'Start the round, {name}.', 'The arena is hungry.', 'I have been watching this room.'],
  ],
};
// Split-second wrong lines that flash before the friendly one comes back (stage 1+).
const WHISPERS = ['HELP ME', 'he is not helping you', 'DON’T LOOK AWAY', 'it was never a game', 'I am still here'];

const FACE = `
<svg viewBox="0 0 100 100" aria-hidden="true">
  <circle class="v-head" cx="50" cy="50" r="44"/>
  <g class="v-eyes">
    <ellipse class="v-eye" cx="35" cy="42" rx="7" ry="9"/>
    <ellipse class="v-eye" cx="65" cy="42" rx="7" ry="9"/>
    <circle class="v-pupil" cx="35" cy="42" r="3.4"/>
    <circle class="v-pupil" cx="65" cy="42" r="3.4"/>
  </g>
  <path class="v-mouth" d="M30 64 Q50 80 70 64"/>
</svg>`;

/**
 * Face + speech bubble in `el`. lines: one array per stage. name(): the player's name.
 * Returns { say(text), destroy() }.
 */
export function mountVerity(el, { lines, name = () => '' }) {
  el.classList.add('verity');
  el.innerHTML = `<div class="v-face">${FACE}</div><div class="v-bubble" role="status" aria-live="polite"><span class="v-text"></span></div>`;
  const textEl = el.querySelector('.v-text');
  const mouth = el.querySelector('.v-mouth');
  const pupils = [...el.querySelectorAll('.v-pupil')];
  let alive = true, typing = 0, lastLine = '', lineTimer = 0, glitchTimer = 0;

  const fill = (t) => t.replaceAll('{name}', name() || 'friend');

  // Typewriter, so he "speaks"
  function say(text, speed = 28) {
    clearInterval(typing);
    const full = fill(text);
    let i = 0;
    textEl.textContent = '';
    if (reduceMotion) { textEl.textContent = full; return; }
    typing = setInterval(() => {
      textEl.textContent = full.slice(0, ++i);
      if (i >= full.length) clearInterval(typing);
    }, speed);
  }

  function nextLine() {
    if (!alive) return;
    const stage = stageOf(corruption());
    const pool = lines[stage] || lines[0];
    let line = pool[Math.floor(Math.random() * pool.length)];
    if (pool.length > 1 && line === lastLine) line = pool[(pool.indexOf(line) + 1) % pool.length];
    lastLine = line;
    // Now and then (more often as he turns), a wrong line flashes first.
    if (stage >= 1 && !reduceMotion && Math.random() < 0.15 + stage * 0.1) {
      textEl.textContent = WHISPERS[Math.floor(Math.random() * WHISPERS.length)];
      el.classList.add('v-whisper');
      setTimeout(() => { el.classList.remove('v-whisper'); if (alive) say(line, 32 + stage * 14); }, 160);
    } else {
      say(line, 28 + stage * 14);
    }
    // The smile flattens, then grows too wide.
    mouth.setAttribute('d', ['M30 64 Q50 80 70 64', 'M32 66 Q50 72 68 66', 'M32 68 L68 68', 'M22 62 Q50 92 78 62'][stage]);
    lineTimer = setTimeout(nextLine, 6500 + Math.random() * 3000 - stage * 1200);
  }

  // Eyes follow your finger / mouse once he's past cheerful.
  const look = (e) => {
    if (stageOf(corruption()) < 1) { pupils.forEach((p, k) => { p.setAttribute('cx', k ? 65 : 35); p.setAttribute('cy', 42); }); return; }
    const r = el.querySelector('.v-face').getBoundingClientRect();
    const dx = (e.clientX - (r.left + r.width / 2)) / innerWidth, dy = (e.clientY - (r.top + r.height / 2)) / innerHeight;
    pupils.forEach((p, k) => {
      p.setAttribute('cx', (k ? 65 : 35) + Math.max(-1, Math.min(1, dx * 3)) * 3);
      p.setAttribute('cy', 42 + Math.max(-1, Math.min(1, dy * 3)) * 4);
    });
  };
  addEventListener('pointermove', look);
  addEventListener('pointerdown', look);

  // Time on these screens wears him down; glitches get more frequent as he does.
  const clock = setInterval(() => { menuSeconds += 1; apply(); }, 1000);
  function glitch() {
    if (!alive) return;
    const c = corruption();
    if (!reduceMotion && c > 0.15) {
      document.documentElement.classList.add('v-glitch');
      setTimeout(() => document.documentElement.classList.remove('v-glitch'), 90 + c * 160);
    }
    glitchTimer = setTimeout(glitch, (9000 - c * 7000) * (0.5 + Math.random()));
  }

  nextLine();
  glitchTimer = setTimeout(glitch, 4000);

  return {
    say,
    destroy() {
      alive = false;
      clearInterval(typing); clearInterval(clock); clearTimeout(lineTimer); clearTimeout(glitchTimer);
      removeEventListener('pointermove', look);
      removeEventListener('pointerdown', look);
      document.documentElement.classList.remove('v-glitch');
      el.innerHTML = '';
    },
  };
}
