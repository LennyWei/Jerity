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
let visits = (Number(store.get(VISITS_KEY, '0')) || 0) + 1;
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

/** Back to the cheerful start (the game server restarted: a fresh demo). */
export function resetCorruption() {
  visits = 1;
  extra = 0;
  menuSeconds = 0;
  store.set(VISITS_KEY, '1');
  store.set(EXTRA_KEY, '0');
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
  match: [
    ['Drive safe! Bump the others, not the walls :)', 'Ram their side for big points!', 'You’re doing great, {name}!'],
    ['Faster.', 'Is that all?', 'I’m keeping score. Of everything.'],
    ['Pathetic driving.', 'Hit someone already.', 'They can all see you, {name}.'],
    ['It ends here.', 'Nobody is coming to help you.', 'Keep driving. I’m right behind you.'],
  ],
  spectate: [
    ['Welcome to the arena! Scan the code to play :)', 'Who will be the last car standing?', 'Cheer for your friends!'],
    ['Watch closely.', 'Someone is going to lose.', 'I see everything from up here.'],
    ['Look at them. Fighting over nothing.', 'You are watching. So am I.', 'Join them. There’s room.'],
    ['None of them are leaving.', 'You could stop this. You won’t.', 'Keep watching.'],
  ],
  results: [
    ['What a match! Want to play again?', 'Great game, everyone :)'],
    ['Again?', 'You’ll play again. You always do.'],
    ['Go again. I’m not finished with you.', 'Again.'],
    ['Again.', 'There is no leaving.'],
  ],
};

// One-off reactions, by stage. {victim} and {winner} are names.
export const REACT = {
  myHit: [['Nice hit!', 'Ooh, right in the side!', 'Great bump! :)'], ['Adequate.', 'Again.', 'Harder.'],
    ['Again. Make it hurt.', 'Is that your best?', 'More.'], ['Yes. Break them.', 'Good. Good.', 'They felt that.']],
  gotHit: [['Ouch! Shake it off!', 'Oopsie! You’re okay!', 'Watch out!'], ['That looked painful.', 'Pay attention.', 'Ow.'],
    ['You deserved that.', 'Pathetic.', 'Stop getting hit.'], ['Does it hurt, {name}?', 'I enjoyed that.', 'Let them.']],
  flip: [['Uh oh! Tap to flip back!', 'Whoops! Tap tap tap!'], ['Tap. Now.', 'Flipped again.'],
    ['Get up.', 'Embarrassing.'], ['Stay down.', 'Maybe stay there.']],
  headon: [['Bonk! Head-on!', 'Seeing stars? :)'], ['That was stupid.', 'Brilliant. Truly.'],
    ['Idiots.', 'Both of you. Idiots.'], ['Your skulls rang like bells.', 'I heard that.']],
  kill: [['You knocked them out! Amazing!', 'KO! You’re a natural!'], ['One less.', 'Fine work.'],
    ['Who’s next?', 'More.'], ['That’s one.', 'I’ll remember {victim}.']],
  killed: [['Oh no! You can watch the rest :)', 'Good game! Better luck next time!'], ['You lost.', 'Sit down.'],
    ['Useless.', 'I expected that.'], ['You belong to me now, {name}.', 'There you are.']],
  otherKill: [['{victim} is out! Wow!', 'Bye bye, {victim}!'], ['{victim} is gone.', 'So long, {victim}.'],
    ['{victim} won’t be missed.', 'Nobody liked {victim}.'], ['{victim} is mine now.', 'I have {victim}.']],
  win: [['You won! I’m so proud of you!'], ['You won. This time.'], ['Winning changes nothing.'], ['You won. Now you can never leave.']],
  lose: [['{winner} wins! Good try :)'], ['{winner} wins. You didn’t.'], ['You lost to {winner}. Typical.'], ['{winner} won. You are still here.']],
  draw: [['A draw! Everyone’s a winner :)'], ['Nobody won.'], ['All of you failed.'], ['No winners. Only me.']],
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
 * quiet: chat less on his own (in a match he mostly reacts).
 * Returns { say(text), react(events, { me, nameOf }), verdict({ won, winner }), destroy() }.
 */
export function mountVerity(el, { lines, name = () => '', quiet = false }) {
  el.classList.add('verity');
  el.innerHTML = `<div class="v-face">${FACE}</div><div class="v-bubble" role="status" aria-live="polite"><span class="v-text"></span></div>`;
  const textEl = el.querySelector('.v-text');
  const mouth = el.querySelector('.v-mouth');
  const pupils = [...el.querySelectorAll('.v-pupil')];
  let alive = true, typing = 0, lastLine = '', lineTimer = 0, glitchTimer = 0, reactedAt = 0;
  const idleMs = quiet ? 14000 : 6500;

  const fill = (t, vars = {}) => Object.entries({ name: name() || 'friend', ...vars })
    .reduce((out, [k, v]) => out.replaceAll(`{${k}}`, v || 'someone'), t);

  // Typewriter, so he "speaks"
  function say(text, speed = 28, vars) {
    clearInterval(typing);
    const full = fill(text, vars);
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
    lineTimer = setTimeout(nextLine, idleMs + Math.random() * 3000 - stage * 1200);
  }

  const pickLine = (pools) => {
    const pool = pools[stageOf(corruption())] || pools[0];
    return pool[Math.floor(Math.random() * pool.length)];
  };
  function sayNow(pools, vars) {
    clearTimeout(lineTimer);
    say(pickLine(pools), 24 + stageOf(corruption()) * 10, vars);
    lineTimer = setTimeout(nextLine, idleMs + 4000);
  }

  /**
   * In a match: comment on the most interesting event in this batch. Your own KO beats your kill,
   * beats a flip, a head-on, getting hit, landing a hit; then other people's KOs.
   * A short cooldown keeps him from chattering, except for KOs.
   */
  function react(events, { me, nameOf = () => '' } = {}) {
    if (!events?.length || !alive) return;
    let best = null, rank = 0;
    const offer = (r, pools, vars) => { if (r > rank) { rank = r; best = [pools, vars]; } };
    for (const e of events) {
      if (e.type === 'kill' && e.victim === me) offer(9, REACT.killed);
      else if (e.type === 'kill' && e.attacker === me) offer(8, REACT.kill, { victim: nameOf(e.victim) });
      else if (e.type === 'flip' && e.id === me) offer(7, REACT.flip);
      else if (e.type === 'headon' && (e.a === me || e.b === me)) offer(6, REACT.headon);
      else if (e.type === 'hit' && e.victim === me) offer(5, REACT.gotHit);
      else if (e.type === 'hit' && e.attacker === me) offer(4, REACT.myHit);
      else if (e.type === 'kill') offer(3, REACT.otherKill, { victim: nameOf(e.victim) });
    }
    if (!best) return;
    const now = performance.now();
    if (rank < 8 && now - reactedAt < 2600) return;
    reactedAt = now;
    sayNow(...best);
  }

  /** Results: one line about how it went. */
  function verdict({ won, winner }) {
    sayNow(won ? REACT.win : winner ? REACT.lose : REACT.draw, { winner });
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
    react,
    verdict,
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
