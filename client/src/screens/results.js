// client/src/screens/results.js
// Winner and leaderboard (kills, damage, score), then Play again. Person 4 owns this file.
//
//   mount(root, { result, lobby, playerId, onPlayAgain }) -> unmount
// The server reopens the lobby after RESULTS_MS (the TEST room starts the next round),
// and the router follows it; Play again just goes back to the lobby sooner.

import { h, colorOf } from '../ui.js';
import { mountVerity, LINES } from '../verity-ui.js';

export function mount(root, { result, lobby, playerId, onPlayAgain }) {
  const players = new Map((lobby?.players || []).map((p, i) => [p.id, { ...p, i }]));
  const winner = result.winnerId && players.get(result.winnerId);
  const title = !result.winnerId ? 'Draw!'
    : result.winnerId === playerId ? 'You win! 🏆'
      : `${winner?.name || 'Someone'} wins!`;

  const rows = result.leaderboard.map((r, rank) => {
    const p = players.get(r.id);
    return h(`tr${r.id === playerId ? '.me' : ''}`, {},
      h('td', {}, `${rank + 1}`),
      h('td', {}, h('span.swatch', { style: { display: 'inline-block', verticalAlign: '-3px', marginRight: '8px', background: colorOf(p, p?.i) } }), r.name),
      h('td', {}, r.kills),
      h('td', {}, r.damage),
      h('td', {}, r.score));
  });

  const helper = h('div');
  const el = h('div.screen.center.crt', {},
    helper,
    h('p.winner', {}, title),
    h('div.card', { style: { width: 'min(520px, 100%)' } },
      h('table.board', {},
        h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Player'), h('th', {}, 'KO'), h('th', {}, 'Dmg'), h('th', {}, 'Score'))),
        h('tbody', {}, rows))),
    h('div.stack', {}, h('button.btn.primary', { onclick: () => onPlayAgain?.() }, 'Play again'),
      h('p.muted', { style: { textAlign: 'center', margin: 0 } }, 'Score = damage dealt + 100 per KO + 150 for the win')));
  root.append(el);
  const verity = mountVerity(helper, { lines: LINES.results, name: () => players.get(playerId)?.name });
  verity.verdict({ won: result.winnerId === playerId, winner: winner?.name || (result.winnerId ? 'Someone' : '') });
  return () => { verity.destroy(); el.remove(); };
}
