// client/src/screens/spectate.js
// Laptop view at /spectate/ABCD: the arena with render.js (showHud: false, so names, a live
// leaderboard and the kill feed), plus a join QR. Person 4 owns this file.
//
//   mount(root, { net, code, onError }) -> unmount

import { h, joinUrl, renderQr } from '../ui.js';
import { C2S, S2C, ROOM_STATE } from '../../../shared/protocol.js';
import { createRenderer } from '../render.js';
import { createInterp } from '../interp.js';
import { mountVerity, corruption, LINES } from '../verity-ui.js';

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
      ended = r;
      status.replaceChildren(h('h2', {}, r.winnerId ? `${name || 'Someone'} wins!` : 'Draw!'),
        ...r.leaderboard.slice(0, 5).map((row, i) => h('p.muted', {}, `${i + 1}. ${row.name} · ${row.score}`)));
      setTimeout(() => { if (ended === r) { ended = null; interp.reset(); showStatus(); } }, 5000);
    }),
  ];

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
    cancelAnimationFrame(raf);
    offs.forEach((f) => f());
    offStatus();
    renderer.destroy();
    verity.destroy();
    el.remove();
  };
}
