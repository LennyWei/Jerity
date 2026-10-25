// client/src/screens/spectate.js
// Laptop view at /spectate/ABCD: the arena with render.js (showHud: false, so names, a live
// leaderboard and the kill feed), plus a join QR. Person 4 owns this file.
//
//   mount(root, { net, code, onError }) -> unmount

import { h, joinUrl, renderQr, colorOf } from '../ui.js';
import { C2S, S2C, ROOM_STATE } from '../../../shared/protocol.js';
import { CONFIG } from '../../../shared/config.js';
import { createRenderer } from '../render.js';
import { createInterp } from '../interp.js';
import { mountVerity, corruption, LINES } from '../verity-ui.js';
import { victorySplash } from './results.js';

export function mount(root, { net, code, onError }) {
  const canvas = h('canvas');
  const qr = h('div.qr');
  const status = h('div.status');
  const el = h('div.spectate', {}, canvas,
    h('div.join-card', {}, qr, h('div', {}, h('div.muted', {}, 'Join on your phone'), h('div.room-code', {}, code))),
    status);
  root.append(el);
  renderQr(qr, joinUrl(code));

  const renderer = createRenderer(canvas, { showHud: false, corrupt: corruption });
  // Verity announces the match on the big screen.
  const helper = h('div.spectate-verity');
  el.append(helper);
  const verity = mountVerity(helper, { lines: LINES.spectate, quiet: true });
  const nameOf = (id) => lobby?.players.find((p) => p.id === id)?.name || 'someone';
  const interp = createInterp();
  let lobby = null, ended = null, alive = true, lastCount = 0;

  const showStatus = () => {
    if (ended) return;
    if (!lobby) { status.textContent = 'Connecting…'; return; }
    if (lobby.state === ROOM_STATE.LOBBY) {
      status.replaceChildren(h('h2', {}, `Room ${code}`),
        h('p.muted', {}, `${lobby.players.length} player${lobby.players.length === 1 ? '' : 's'} in the lobby`),
        h('p.muted', {}, lobby.players.map((p) => p.name).join(' · ') || 'Scan the QR to join'));
    } else status.replaceChildren();
  };

  const offs = [
    net.on(S2C.LOBBY, (l) => { lobby = l; renderer.setPlayers(l.players); renderer.setMap(l.map); showStatus(); }),
    net.on(S2C.COUNTDOWN, ({ seconds }) => {
      if (seconds > lastCount) { ended = null; interp.reset(); showStatus(); } // a new round's countdown
      lastCount = seconds;
    }),
    net.on(S2C.SNAP, (s) => interp.push(s)),
    net.on(S2C.ROUND_END, (r) => {
      const name = lobby?.players.find((p) => p.id === r.winnerId)?.name;
      const final = r.final && r.match?.length > 0; // the match is over: final standings by performance score
      const round = typeof r.round === 'number' && !final ? ` round ${r.round}` : '';
      ended = r;
      status.replaceChildren(...[
        h('h2', {}, final ? `${r.match[0].name} wins the match!` : r.winnerId ? `${name || 'Someone'} wins${round}!` : 'Draw!'),
        round && h('p.muted', {}, r.match?.length ? `Standings after round ${r.round} of ${r.rounds}` : `Round ${r.round} of ${r.rounds}`),
        final && h('p.muted', {}, `Final standings · performance score after ${r.round} rounds`),
        // Between rounds too: the match standings (where everyone really is), not just this round.
        ...(r.match?.length ? r.match : r.leaderboard).slice(0, 5).map((row, i) => h('p.muted', {}, `${i + 1}. ${row.name} · ${row.score}`)),
      ].filter(Boolean));
      setTimeout(() => { if (ended === r) { ended = null; interp.reset(); showStatus(); } },
        final ? CONFIG.MATCH_RESULTS_MS : CONFIG.RESULTS_MS);
      showSplash(r, final);
    }),
  ];

  // Every round, the big screen shows the winner's "[trophy] Name Won!" first, like the phones.
  let splash = null, splashTimer = 0;
  function showSplash(r, final) {
    clearTimeout(splashTimer);
    splash?.remove();
    const id = final ? r.match[0].id : r.winnerId;
    const i = lobby?.players.findIndex((p) => p.id === id) ?? -1;
    const p = i >= 0 ? lobby.players[i] : null;
    const s = splash = victorySplash({
      name: final ? r.match[0].name : p?.name || 'Someone', color: colorOf(p, Math.max(0, i)),
      title: final ? ' Wins the Match!' : ' Won!',
      sub: final ? `After ${r.round} rounds` : typeof r.round === 'number' ? `Round ${r.round} of ${r.rounds}` : null,
      final, draw: !id,
    });
    s.classList.add('rs-over-arena');
    el.append(s);
    splashTimer = setTimeout(() => { s.classList.add('rs-out'); splashTimer = setTimeout(() => s.remove(), 500); },
      (CONFIG.VICTORY_SPLASH_MS ?? 2600) + (final ? 700 : 0));
  }

  const join = async () => {
    const res = await net.request(C2S.SPECTATE, { code });
    if (res?.error) onError?.(res.error);
  };
  join();
  const offStatus = net.onStatus((up) => { if (up) join(); }); // rejoin the room after a reconnect

  let raf = 0;
  const frame = (now) => {
    if (!alive) return;
    raf = requestAnimationFrame(frame);
    const view = interp.sample(now);
    const events = interp.takeEvents();
    renderer.addEvents(events, view);
    verity.react(events, { me: null, nameOf });
    renderer.draw(view, now);
  };
  raf = requestAnimationFrame(frame);
  showStatus();

  return () => {
    alive = false;
    clearTimeout(splashTimer);
    cancelAnimationFrame(raf);
    offs.forEach((f) => f());
    offStatus();
    renderer.destroy();
    verity.destroy();
    el.remove();
  };
}
