// client/src/screens/results.js
// After each round of a match: a victory splash ("[trophy] Name Won!"), then the match standings
// so far (performance score, with this round's points as +N), so everyone sees where they really
// stand. After the last round: the match winner's splash, then the final standings on a podium
// with gold, silver and bronze auras. Person 4 owns this file.
//
//   mount(root, { result, lobby, playerId, onPlayAgain }) -> unmount
// The server starts the next round after RESULTS_MS; after the last round it reopens the lobby
// (the TEST room starts a new match), and the router follows it. Play again goes back sooner.
// The splash can't be tapped away (a tap still in flight from the game would skip it unseen),
// and it waits for the phone to be looking. victorySplash() is shared with the spectator screen.

import { h, colorOf } from '../ui.js';
import { mountVerity, LINES } from '../verity-ui.js';
import { CONFIG } from '../../../shared/config.js';
import { PLAYER_COLORS } from '../../../shared/constants.js';
import { playRoundEnd } from '../sfx.js';

const MEDALS = ['gold', 'silver', 'bronze'];
const MEDAL_HEX = { gold: '#f6b93b', silver: '#c3cad6', bronze: '#cd7f32' };
const PLACES = ['1st', '2nd', '3rd'];
const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Seconds as m:ss. */
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function mount(root, { result, lobby, playerId, onPlayAgain }) {
  injectCss();
  const players = new Map((lobby?.players || []).map((p, i) => [p.id, { ...p, i }]));
  const colorFor = (id) => colorOf(players.get(id), players.get(id)?.i);
  const who = (id, name) => [h('span.swatch', { style: { display: 'inline-block', verticalAlign: '-3px', marginRight: '8px', background: colorFor(id) } }), name];
  const table = (heads, rows) => h('div.card.rs-card', {},
    h('table.board', {}, h('thead', {}, h('tr', {}, ...heads.map((t) => h('th', {}, t)))), h('tbody', {}, rows)));
  const note = (text) => h('p.muted.rs-note', {}, text);

  // A server without matches (fake.js) sends lone rounds: no round number, no standings.
  const standings = result.match?.length ? result.match : null;
  const final = !!(result.final && standings);
  const between = typeof result.round === 'number' && !result.final;
  const roundPts = new Map((result.leaderboard || []).map((r) => [r.id, r.score]));

  // The splash: the match winner at the end, the round winner between rounds (every round).
  const winnerId = final ? standings[0].id : result.winnerId;
  const winnerName = final ? standings[0].name : players.get(result.winnerId)?.name || (result.winnerId ? 'Someone' : '');
  const won = !!winnerId && winnerId === playerId;
  const lapShown = !!result.splashShown && !final; // the victory lap already showed this round's winner
  const splash = victorySplash({
    name: won ? 'You' : winnerName, color: winnerId ? colorFor(winnerId) : undefined,
    title: final ? (won ? ' Win the Match!' : ' Wins the Match!') : ' Won!',
    sub: final ? `After ${result.round} rounds` : between ? `Round ${result.round} of ${result.rounds}` : null,
    final, draw: !winnerId,
  });

  const helper = h('div.rs-verity');
  let body;
  if (final) {
    // Podium in 2nd-1st-3rd order, then everyone with medal auras on the top three rows.
    const podium = [1, 0, 2].filter((i) => standings[i]).map((i) => {
      const r = standings[i];
      return h(`div.rs-place.p${i + 1}.${MEDALS[i]}`, {},
        rain(MEDALS[i], colorFor(r.id), i === 0 ? 20 : 13),
        h('div.rs-avatar', { style: { background: colorFor(r.id) } }, `${i + 1}`),
        h('div.rs-pname', {}, r.id === playerId ? `${r.name} (you)` : r.name),
        h('div.rs-pts', {}, `${r.score} pts`),
        h('div.rs-step', {}, PLACES[i]));
    });
    body = h('div.rs-body.rs-final', {},
      h('div.rs-final-head', {}, h('p.rs-eyebrow', {}, 'Match over'), h('h1.rs-final-title', {}, 'Final Standings')),
      h('div.rs-final-grid', {},
        h('div.rs-podium', {}, podium),
        h('div.rs-final-side', {},
          helper,
          table(['#', 'Player', 'Performance', 'Wins', 'Time', 'KO', 'Dmg'], standings.map((r, i) =>
            h(`tr${r.id === playerId ? '.me' : ''}${i < 3 ? `.medal.${MEDALS[i]}` : ''}`, {},
              h('td', {}, `${i + 1}`), h('td', {}, ...who(r.id, r.name)), h('td', {}, r.score),
              h('td', {}, r.wins), h('td', {}, clock(r.survived)), h('td', {}, r.kills), h('td', {}, r.damage)))),
          h('button.btn.primary', { onclick: () => onPlayAgain?.() }, 'Play again'),
          note(`Performance = all round scores: damage + ${CONFIG.SCORE_KILL} per KO + ${CONFIG.SCORE_WIN} per round won + ${CONFIG.SCORE_PER_SURVIVAL_S} per second survived`))));
  } else if (standings && between) {
    // Between rounds: where everyone really stands in the match, not just this round.
    body = h('div.rs-body', {},
      helper,
      h('p.rs-eyebrow', {}, `Standings after round ${result.round} of ${result.rounds}`),
      table(['#', 'Player', 'Performance', 'Wins', 'KO', 'Dmg'], standings.map((r, i) =>
        h(`tr${r.id === playerId ? '.me' : ''}`, {},
          h('td', {}, `${i + 1}`), h('td', {}, ...who(r.id, r.name)),
          h('td', {}, `${r.score}`, roundPts.get(r.id) > 0 ? h('span.rs-delta', {}, `+${roundPts.get(r.id)}`) : null),
          h('td', {}, r.wins), h('td', {}, r.kills), h('td', {}, r.damage)))),
      note(`Next round coming up · +N = points this round (damage + ${CONFIG.SCORE_KILL} per KO + ${CONFIG.SCORE_WIN} for the win + ${CONFIG.SCORE_PER_SURVIVAL_S} per second survived)`));
  } else {
    body = h('div.rs-body', {},
      helper,
      table(['#', 'Player', 'KO', 'Dmg', 'Score'], result.leaderboard.map((r, i) =>
        h(`tr${r.id === playerId ? '.me' : ''}`, {},
          h('td', {}, `${i + 1}`), h('td', {}, ...who(r.id, r.name)), h('td', {}, r.kills), h('td', {}, r.damage), h('td', {}, r.score)))),
      h('div.stack', {}, h('button.btn.primary', { onclick: () => onPlayAgain?.() }, 'Play again'),
        note(`Score = damage dealt + ${CONFIG.SCORE_KILL} per KO + ${CONFIG.SCORE_WIN} for the win`)));
  }

  // The final gets a soft pale-yellow light behind the middle, so the late (dark) Verity stages
  // don't swallow it; paler than the 1st-place gold so that still stands out.
  const el = h(`div.screen.center.crt.rs${final ? '.rs-is-final' : ''}`, {}, final ? h('div.rs-glow') : null, splash, body);
  root.append(el);
  if (!lapShown) playRoundEnd({ won, final, small: true }); // the winner's jingle, or a soft "round over"
  const verity = mountVerity(helper, { lines: LINES.results, name: () => players.get(playerId)?.name });
  verity.verdict({ won, winner: winnerName });

  // The splash gets its full time while someone is looking: a phone that was asleep or in the
  // background when the round ended (you got knocked out and put it down) still shows it first.
  let toBoard = 0, slideIn = 0;
  const showBoard = () => { splash.classList.add('rs-out'); el.classList.add('rs-board-on'); };
  const startSplash = () => {
    if (toBoard || document.visibilityState === 'hidden') return;
    toBoard = setTimeout(showBoard, (CONFIG.VICTORY_SPLASH_MS ?? 2600) + (final ? 700 : 0));
  };
  if (lapShown) { // straight to the scoreboard, sliding in (the splash stays hidden)
    splash.classList.add('rs-out');
    slideIn = requestAnimationFrame(() => { slideIn = requestAnimationFrame(showBoard); });
  } else {
    document.addEventListener('visibilitychange', startSplash);
    startSplash();
  }
  return () => {
    clearTimeout(toBoard);
    cancelAnimationFrame(slideIn);
    document.removeEventListener('visibilitychange', startSplash);
    verity.destroy();
    el.remove();
  };
}

/**
 * "[trophy] Name Won!": a trophy popping in over spinning rays, the winner's name in their car's
 * color, and a burst of confetti. Shared with the spectator screen. Add class rs-out to fade it.
 * title follows the name (' Won!'); draw: no winner (a gray trophy, no confetti).
 */
export function victorySplash({ name, color, title, sub = null, final = false, draw = false }) {
  injectCss();
  return h(`div.rs-splash${final ? '.rs-splash-final' : ''}`, {},
    h('div.rs-rays'),
    trophy(draw),
    h('div.rs-title', {}, draw ? 'Draw!' : [h('span.rs-name', { style: { color } }, name), title]),
    sub ? h('div.rs-sub', {}, sub) : null,
    draw ? null : confetti(final ? 80 : 44));
}

/** Confetti pouring nonstop over a podium place: its medal color, the player's color and white. */
function rain(medal, color, n) {
  if (reduceMotion) return null;
  const colors = [MEDAL_HEX[medal], MEDAL_HEX[medal], color, '#ffffff'];
  return h('div.rs-rain', {}, Array.from({ length: n }, () => h('i', {
    style: `left:${(Math.random() * 100).toFixed(1)}%;background:${colors[(Math.random() * colors.length) | 0]};`
      + `animation-duration:${(1.5 + Math.random() * 1.5).toFixed(2)}s;animation-delay:-${(Math.random() * 3).toFixed(2)}s;`
      + `--dx:${((Math.random() - 0.5) * 50).toFixed(0)}px;--rot:${(300 + Math.random() * 600).toFixed(0)}deg`,
  })));
}

function trophy(dim) {
  const el = h(`div.rs-trophy${dim ? '.dim' : ''}`);
  el.innerHTML = TROPHY;
  return el;
}

/** Paper confetti in the players' colors and gold, falling once. */
function confetti(n) {
  if (reduceMotion) return null;
  const colors = [...PLAYER_COLORS, '#f6b93b', '#ffffff'];
  return h('div.rs-confetti', {}, Array.from({ length: n }, () => h('i', {
    style: `left:${(Math.random() * 100).toFixed(1)}%;background:${colors[(Math.random() * colors.length) | 0]};`
      + `animation-duration:${(2.2 + Math.random() * 1.8).toFixed(2)}s;animation-delay:${(Math.random() * 0.9).toFixed(2)}s;`
      + `--dx:${((Math.random() - 0.5) * 160).toFixed(0)}px;--rot:${(360 + Math.random() * 720).toFixed(0)}deg`,
  })));
}

const TROPHY = `<svg viewBox="0 0 120 120" aria-hidden="true">
  <defs><linearGradient id="rs-gold" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#fff1b3"/><stop offset="0.45" stop-color="#f6b93b"/><stop offset="1" stop-color="#c47f12"/>
  </linearGradient></defs>
  <path d="M34 30H18c0 17 8 27 22 29M86 30h16c0 17-8 27-22 29" fill="none" stroke="#c47f12" stroke-width="7" stroke-linecap="round"/>
  <path d="M30 16h60v16c0 23-12 39-30 41C42 71 30 55 30 32z" fill="url(#rs-gold)" stroke="#8a5a0c" stroke-width="3" stroke-linejoin="round"/>
  <path d="M43 26c0 15 5 26 12 32" fill="none" stroke="#fff6cf" stroke-width="5" stroke-linecap="round" opacity="0.8"/>
  <path d="M60 30l4.4 9 9.9 1.4-7.2 7 1.7 9.8L60 52.6l-8.8 4.6 1.7-9.8-7.2-7 9.9-1.4z" fill="#fff6cf" opacity="0.9"/>
  <rect x="53" y="72" width="14" height="15" fill="url(#rs-gold)" stroke="#8a5a0c" stroke-width="3"/>
  <rect x="38" y="87" width="44" height="12" rx="3" fill="url(#rs-gold)" stroke="#8a5a0c" stroke-width="3"/>
  <rect x="31" y="99" width="58" height="11" rx="3" fill="#5b3d0a"/>
</svg>`;

function injectCss() {
  if (document.getElementById('rs-css')) return;
  const s = document.createElement('style');
  s.id = 'rs-css';
  s.textContent = CSS;
  document.head.append(s);
}

const CSS = `
.rs { position: relative; overflow: hidden; }
.rs-splash { position: absolute; inset: 0; z-index: 5; display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 4px; padding: 16px; text-align: center; overflow: hidden;
  transition: opacity .45s ease, transform .45s ease; }
.rs-splash.rs-out { opacity: 0; transform: scale(.9); pointer-events: none; }
.rs-splash.rs-over-arena { position: absolute; z-index: 30; color: #f4f1ea;
  background: radial-gradient(circle at 50% 45%, rgba(0,0,0,.6), rgba(0,0,0,.3) 75%); }
.rs-over-arena .rs-sub { color: #d9d3c7; }
/* Victory lap: over the live game, lighter and smaller so the winner's lap shows through; taps go through */
.rs-splash.rs-lap { z-index: 4; pointer-events: none; justify-content: flex-start; padding-top: 7vh;
  background: radial-gradient(ellipse 72% 58% at 50% 34%, rgba(10,8,12,.55), rgba(10,8,12,.22) 60%, transparent 86%); }
.rs-lap .rs-rays { top: 26%; opacity: .55; }
.rs-lap .rs-trophy { width: min(96px, 22vh); }
.rs-lap .rs-title { font-size: clamp(26px, 8vh, 58px); color: #fff; text-shadow: 0 2px 0 rgba(0,0,0,.55), 0 0 16px rgba(0,0,0,.65); }
.rs-lap .rs-sub { color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,.85), 0 0 10px rgba(0,0,0,.6); }
/* Final: a soft pale-yellow light behind the middle (paler than the 1st-place gold) */
.rs-glow { position: absolute; inset: 0; z-index: 0; pointer-events: none;
  background: radial-gradient(ellipse 64% 58% at 50% 55%, rgba(255,246,200,.8), rgba(255,238,170,.36) 45%, transparent 76%); }
.rs-is-final .rs-body { position: relative; z-index: 1; }
.rs-rays { position: absolute; left: 50%; top: 45%; width: 160vmax; height: 160vmax; margin: -80vmax 0 0 -80vmax; z-index: -1;
  background: repeating-conic-gradient(rgba(246,185,59,.2) 0deg 9deg, transparent 9deg 18deg);
  -webkit-mask: radial-gradient(circle, #000 0, #000 12%, transparent 46%); mask: radial-gradient(circle, #000 0, #000 12%, transparent 46%);
  animation: rs-spin 16s linear infinite; }
.rs-splash-final .rs-rays { background: repeating-conic-gradient(rgba(246,185,59,.32) 0deg 7deg, transparent 7deg 14deg); }
.rs-trophy { width: min(150px, 32vh); animation: rs-pop .75s cubic-bezier(.2,1.6,.4,1) both;
  filter: drop-shadow(0 8px 22px rgba(246,185,59,.6)); }
.rs-splash-final .rs-trophy { width: min(190px, 38vh); }
.rs-trophy svg { display: block; width: 100%; height: auto; }
.rs-trophy.dim { filter: grayscale(1) opacity(.5); }
.rs-title { font-family: var(--friendly, system-ui); font-weight: 700; font-size: clamp(32px, 10vh, 76px); line-height: 1.05;
  animation: rs-rise .6s .25s both; text-shadow: 0 3px 0 rgba(0,0,0,.18); }
.rs-name { text-shadow: 0 0 1px rgba(0,0,0,.7), 0 3px 0 rgba(0,0,0,.28), 0 0 22px currentColor; }
.rs-sub { font-size: clamp(14px, 4vh, 22px); font-weight: 600; color: var(--dim); animation: rs-rise .6s .4s both; }
.rs-confetti { position: absolute; inset: 0; pointer-events: none; z-index: 1; }
.rs-confetti i { position: absolute; top: -16px; width: 8px; height: 14px; border-radius: 2px; animation: rs-fall linear both; }
.rs-body { width: min(680px, 100%); display: flex; flex-direction: column; align-items: center; gap: 8px;
  opacity: 0; transform: translateY(26px); transition: opacity .5s .15s, transform .5s .15s; }
.rs.rs-board-on .rs-body { opacity: 1; transform: none; }
.rs-verity { width: 100%; }
.rs-eyebrow { margin: 0; font-size: 12px; font-weight: 800; letter-spacing: .2em; text-transform: uppercase; color: var(--dim); }
.rs-card { width: 100%; padding: 6px 12px; }
.rs .board td { padding: 7px 6px; }
.rs .board td:nth-child(2) { white-space: nowrap; }
.rs-final .board th, .rs-final .board td { padding-left: 4px; padding-right: 4px; }
.rs-delta { margin-left: 6px; font-size: .78em; font-weight: 800; color: #2fa36b; }
.rs-note { margin: 0; text-align: center; }
.rs-final { width: min(980px, 100%); }
.rs-final-head { text-align: center; }
.rs-final-title { margin: 0; font-family: var(--friendly, system-ui); font-weight: 700; font-size: clamp(30px, 9vh, 58px); line-height: 1;
  background: linear-gradient(180deg, #fff1b3, #f6b93b 55%, #c47f12); -webkit-background-clip: text; background-clip: text; color: transparent;
  filter: drop-shadow(0 2px 0 rgba(0,0,0,.25)) drop-shadow(0 0 16px rgba(246,185,59,.45)); }
.rs-final-grid { width: 100%; display: flex; flex-wrap: wrap; gap: 16px 24px; align-items: flex-end; justify-content: center; }
.rs-final-side { flex: 1 1 420px; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.rs-podium { display: flex; align-items: flex-end; justify-content: center; gap: clamp(8px, 2.4vw, 22px); padding-top: 8px; }
.rs-place { position: relative; width: clamp(86px, 13vw, 120px); display: flex; flex-direction: column; align-items: center; gap: 3px; animation: rs-rise .6s both; }
.rs-rain { position: absolute; left: -16px; right: -16px; top: -72px; bottom: 0; overflow: hidden; pointer-events: none; z-index: 2; }
.rs-rain i { position: absolute; top: -14px; width: 6px; height: 11px; border-radius: 2px; animation: rs-pour linear infinite; }
.rs-place.p1 { animation-delay: .55s; } .rs-place.p2 { animation-delay: .3s; } .rs-place.p3 { animation-delay: .8s; }
.rs-avatar { width: 54px; height: 54px; border-radius: 50%; display: grid; place-items: center; color: #fff;
  font: 800 22px/1 system-ui, sans-serif; text-shadow: 0 1px 2px rgba(0,0,0,.6); border: 4px solid var(--medal);
  box-shadow: 0 0 0 3px rgba(255,255,255,.4), 0 0 16px 4px var(--glow); animation: rs-aura 1.8s ease-in-out infinite; }
.rs-place.p1 .rs-avatar { width: 72px; height: 72px; font-size: 28px; }
.rs-pname { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 700; }
.rs-pts { font-size: 13px; font-weight: 800; color: var(--medal-ink); }
.rs-step { width: 100%; display: grid; place-items: center; border-radius: 10px 10px 4px 4px; font: 800 16px/1 system-ui, sans-serif;
  color: rgba(0,0,0,.55); background: linear-gradient(180deg, rgba(255,255,255,.45), rgba(0,0,0,.12)), var(--medal);
  box-shadow: 0 0 18px var(--glow); }
.rs-place.p1 .rs-step { height: 66px; } .rs-place.p2 .rs-step { height: 46px; } .rs-place.p3 .rs-step { height: 32px; }
.gold { --medal: #f6b93b; --glow: rgba(246,185,59,.75); --medal-ink: #b07a10; }
.silver { --medal: #c3cad6; --glow: rgba(176,188,206,.8); --medal-ink: #6f7a8c; }
.bronze { --medal: #cd7f32; --glow: rgba(205,127,50,.75); --medal-ink: #9a5a1c; }
.rs .board tr.medal td { background: color-mix(in srgb, var(--medal) 14%, transparent); }
.rs .board tr.medal td:first-child { box-shadow: inset 4px 0 0 var(--medal), -6px 0 14px -6px var(--glow); color: var(--medal-ink); }
@media (max-height: 520px) {
  .rs-final { gap: 4px; }
  .rs-final-grid { flex-wrap: nowrap; align-items: center; }
  .rs-final-side { max-height: calc(100dvh - 96px); overflow-y: auto; }
  .rs-final .rs-verity { display: none; }
}
@keyframes rs-spin { to { transform: rotate(360deg); } }
@keyframes rs-pop { 0% { transform: scale(.2) rotate(-14deg); opacity: 0; } 60% { transform: scale(1.12) rotate(4deg); opacity: 1; } 100% { transform: none; } }
@keyframes rs-rise { from { transform: translateY(18px); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes rs-fall { to { transform: translate3d(var(--dx), 112vh, 0) rotate(var(--rot)); } }
@keyframes rs-pour { from { transform: translate3d(0, 0, 0) rotate(0deg); } to { transform: translate3d(var(--dx), 360px, 0) rotate(var(--rot)); } }
@keyframes rs-aura { 50% { box-shadow: 0 0 0 3px rgba(255,255,255,.4), 0 0 30px 10px var(--glow); } }
@media (prefers-reduced-motion: reduce) { .rs-rays, .rs-avatar { animation: none; } }
`;
