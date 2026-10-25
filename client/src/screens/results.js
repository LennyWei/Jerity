// client/src/screens/results.js
// Between the rounds of a match: the round's winner and leaderboard (kills, damage, score).
// After the last round: the final standings by performance score, then Play again.
// Person 4 owns this file.
//
//   mount(root, { result, lobby, playerId, onPlayAgain }) -> unmount
// The server starts the next round after RESULTS_MS; after the last round it reopens the lobby
// (the TEST room starts a new match), and the router follows it. Play again goes back sooner.

import { h, colorOf } from '../ui.js';
import { mountVerity, LINES } from '../verity-ui.js';
import { CONFIG } from '../../../shared/config.js';

/** Seconds as m:ss. */
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function mount(root, { result, lobby, playerId, onPlayAgain }) {
  const players = new Map((lobby?.players || []).map((p, i) => [p.id, { ...p, i }]));
  const who = (r) => [h('span.swatch', { style: { display: 'inline-block', verticalAlign: '-3px', marginRight: '8px', background: colorOf(players.get(r.id), players.get(r.id)?.i) } }), r.name];
  const table = (heads, rows) => h('div.card', { style: { width: 'min(600px, 100%)' } },
    h('table.board', {},
      h('thead', {}, h('tr', {}, ...heads.map((t) => h('th', {}, t)))),
      h('tbody', {}, rows)));
  // A server without matches (fake.js) sends lone rounds: no round number, no standings.
  const final = result.final && result.match?.length > 0;
  const between = typeof result.round === 'number' && !result.final;

  let title, board, note, won, winnerName;
  if (final) {
    const top = result.match[0];
    won = top.id === playerId;
    winnerName = top.name;
    title = won ? 'You win the match! 🏆' : `${top.name} wins the match!`;
    board = table(['#', 'Player', 'Performance', 'Wins', 'Time', 'KO', 'Dmg'], result.match.map((r, rank) =>
      h(`tr${r.id === playerId ? '.me' : ''}`, {},
        h('td', {}, `${rank + 1}`), h('td', {}, ...who(r)), h('td', {}, r.score),
        h('td', {}, r.wins), h('td', {}, clock(r.survived)), h('td', {}, r.kills), h('td', {}, r.damage))));
    note = `Final standings after ${result.round} rounds · Performance = all round scores: damage + ${CONFIG.SCORE_KILL} per KO + ${CONFIG.SCORE_WIN} per round won + ${CONFIG.SCORE_PER_SURVIVAL_S} per second survived`;
  } else {
    const winner = result.winnerId && players.get(result.winnerId);
    const round = between ? ` round ${result.round}` : '';
    won = result.winnerId === playerId;
    winnerName = winner?.name || (result.winnerId ? 'Someone' : '');
    title = !result.winnerId ? 'Draw!' : won ? `You win${round}! 🏆` : `${winnerName} wins${round}!`;
    board = table(['#', 'Player', 'KO', 'Dmg', 'Score'], result.leaderboard.map((r, rank) =>
      h(`tr${r.id === playerId ? '.me' : ''}`, {},
        h('td', {}, `${rank + 1}`), h('td', {}, ...who(r)), h('td', {}, r.kills), h('td', {}, r.damage), h('td', {}, r.score))));
    note = `Score = damage dealt + ${CONFIG.SCORE_KILL} per KO + ${CONFIG.SCORE_WIN} for the win`
      + (between ? ` + ${CONFIG.SCORE_PER_SURVIVAL_S} per second survived` : '');
  }

  const helper = h('div');
  const el = h('div.screen.center.crt', {},
    helper,
    h('p.winner', {}, title),
    between ? h('p.muted', { style: { textAlign: 'center', margin: 0 } }, `Round ${result.round} of ${result.rounds} · next round coming up`) : null,
    board,
    h('div.stack', {},
      between ? null : h('button.btn.primary', { onclick: () => onPlayAgain?.() }, 'Play again'),
      h('p.muted', { style: { textAlign: 'center', margin: 0 } }, note)));
  root.append(el);
  const verity = mountVerity(helper, { lines: LINES.results, name: () => players.get(playerId)?.name });
  verity.verdict({ won, winner: winnerName });
  return () => { verity.destroy(); el.remove(); };
}
