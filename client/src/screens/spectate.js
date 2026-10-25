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
import { mountVerity, corruption, resetCorruption, LINES } from '../verity-ui.js';
import { connectJerity } from '../jerity-round.js';
import { victorySplash } from './results.js';
import { playEvents, playCountdown, playRoundEnd, audioReady, onAudioReady, onAudioLocked, unlockSfx } from '../sfx.js';

export function mount(root, { net, code, onError }) {
  const canvas = h('canvas');
  const qr = h('div.qr');
  const status = h('div.status');
  const el = h('div.spectate', {}, canvas,
    h('div.join-card', {}, qr, h('div', {}, h('div.muted', {}, 'Join on your phone'), h('div.room-code', {}, code))),
    status);
  root.append(el);
  renderQr(qr, joinUrl(code));

  const preview = new URLSearchParams(location.search).get('corrupt'); // ?corrupt=0.9 previews a Verity stage
  const renderer = createRenderer(canvas, { showHud: false, corrupt: preview !== null ? () => Number(preview) || 0 : corruption });
  // Verity announces the match on the big screen.
  const helper = h('div.spectate-verity');
  el.append(helper);
  const verity = mountVerity(helper, { lines: LINES.spectate, quiet: true });
  const disconnectJerity = connectJerity({ net, face: verity });
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
      if (seconds > lastCount) { // a new round's countdown
        ended = null; decided = null; interp.reset(); renderer.setWinner(null); showStatus();
      }
      lastCount = seconds;
      playCountdown(seconds);
    }),
    // Round decided: a victory lap on the live arena under the winner's splash, then ROUND_END.
    net.on(S2C.ROUND_DECIDED, (d) => {
      decided = d;
      renderer.setWinner(d.winnerId);
      showSplash({ id: d.winnerId, ...who(d.winnerId), title: ' Won!',
        sub: typeof d.round === 'number' ? `Round ${d.round} of ${d.rounds}` : null, lap: true, ms: d.lapMs });
    }),
    net.on(S2C.SNAP, (s) => interp.push(s)),
    net.on(S2C.ROUND_END, (r) => {
      if (r.final || typeof r.round !== 'number') resetCorruption();
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
      const splashMs = CONFIG.VICTORY_SPLASH_MS ?? 2600;
      if (final) {
        showSplash({ id: r.match[0].id, name: r.match[0].name, color: who(r.match[0].id).color,
          title: ' Wins the Match!', sub: `After ${r.round} rounds`, final: true, ms: splashMs + 700 });
      } else if (!decided) { // an older server: no victory lap showed the winner yet
        showSplash({ id: r.winnerId, ...who(r.winnerId), title: ' Won!',
          sub: typeof r.round === 'number' ? `Round ${r.round} of ${r.rounds}` : null, ms: splashMs });
      } else hideSplash(); // the lap's splash gives way to the standings
    }),
  ];

  // Every round, the big screen shows the winner's "[trophy] Name Won!": over the live arena
  // during the victory lap, and the match winner once more after the last round.
  let splash = null, splashTimer = 0, decided = null;
  const who = (id) => {
    const i = lobby?.players.findIndex((p) => p.id === id) ?? -1;
    const p = i >= 0 ? lobby.players[i] : null;
    return { name: p?.name || 'Someone', color: colorOf(p, Math.max(0, i)) };
  };
  function hideSplash() {
    clearTimeout(splashTimer);
    const s = splash;
    if (!s) return;
    s.classList.add('rs-out');
    splashTimer = setTimeout(() => s.remove(), 500);
  }
  function showSplash({ id, name, color, title, sub = null, final = false, lap = false, ms }) {
    clearTimeout(splashTimer);
    splash?.remove();
    const s = splash = victorySplash({ name, color, title, sub, final, draw: !id });
    s.classList.add('rs-over-arena');
    if (lap) s.classList.add('rs-lap'); // lighter, so the lap on the arena shows through
    el.append(s);
    playRoundEnd({ final });
    splashTimer = setTimeout(hideSplash, ms);
  }

  // Browsers keep a page silent until someone clicks it: say so on the big screen until they do.
  const soundHint = h('button.btn.small', {
    onclick: () => unlockSfx(),
    style: { position: 'absolute', top: '14px', left: '50%', transform: 'translateX(-50%)', zIndex: 40, width: 'auto' },
  }, '🔊 Click for game sound');
  const syncHint = () => { soundHint.hidden = audioReady(); };
  syncHint();
  el.append(soundHint);
  const offSound = [onAudioReady(syncHint), onAudioLocked(syncHint)];

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
    playEvents(events, { all: true, view }); // the big screen sounds every crash, panned by where it hit
    verity.react(events, { me: null, nameOf });
    renderer.draw(view, now);
    verity.watch(view, renderer.project, now);
  };
  raf = requestAnimationFrame(frame);
  showStatus();

  return () => {
    alive = false;
    clearTimeout(splashTimer);
    offSound.forEach((off) => off());
    cancelAnimationFrame(raf);
    offs.forEach((f) => f());
    offStatus();
    renderer.destroy();
    disconnectJerity();
    verity.destroy();
    el.remove();
  };
}
