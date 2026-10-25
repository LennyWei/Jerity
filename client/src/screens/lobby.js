// client/src/screens/lobby.js
// Room code + QR to /join/CODE, players in their colors, ready toggle, Start (host only,
// enabled at MIN_PLAYERS; bots count), host bot controls, Recalibrate, Leave. Person 4 owns this file.
//
//   mount(root, { net, playerId, lobby, onLeave }) -> unmount
// The router switches to the game screen on the countdown; this screen only shows the room.

import { h, colorOf, joinUrl, renderQr } from '../ui.js';
import { C2S, S2C, ROOM_STATE } from '../../../shared/protocol.js';
import { MIN_PLAYERS, MAX_PLAYERS } from '../../../shared/constants.js';
import { calibrate, requestMotionPermission } from './game.js';

export function mount(root, { net, playerId, lobby, onLeave }) {
  let state = lobby;
  const qr = h('div.qr');
  const list = h('ul.players');
  const err = h('div.error');
  const note = h('p.muted', { style: { textAlign: 'center', margin: 0 } });

  const ready = h('button.btn', { onclick: () => {
    const me = state.players.find((p) => p.id === playerId);
    net.emit(C2S.READY, { ready: !me?.ready });
  } });

  const start = h('button.btn.primary', { onclick: async () => {
    start.disabled = true;
    const res = await net.request(C2S.START, {});
    if (res?.error) { err.textContent = res.error; start.disabled = false; }
  } }, 'Start');

  // Host: fill empty seats with bots, or take them out again.
  const botReq = async (event) => {
    addBot.disabled = removeBot.disabled = true;
    const res = await net.request(event, {});
    if (res?.error) err.textContent = res.error;
    render();
  };
  const addBot = h('button.btn.small', { onclick: () => botReq(C2S.ADD_BOT) }, '+ Add bot');
  const removeBot = h('button.btn.small.ghost', { onclick: () => botReq(C2S.REMOVE_BOT) }, '− Remove bot');
  const botRow = h('div.row', {}, addBot, removeBot);

  const recal = h('button.btn.ghost', { onclick: async () => {
    await requestMotionPermission(); // from this tap: iOS needs it
    recal.disabled = true;
    recal.textContent = 'Hold it how you’ll drive…';
    await calibrate(1200);
    recal.textContent = 'Calibrated ✓';
    setTimeout(() => { recal.textContent = 'Recalibrate steering'; recal.disabled = false; }, 1200);
  } }, 'Recalibrate steering');

  const leave = h('button.btn.small.ghost', { onclick: () => { net.emit(C2S.LEAVE, {}); onLeave?.(); } }, 'Leave');

  function render() {
    const host = state.hostId === playerId;
    const n = state.players.length;
    const me = state.players.find((p) => p.id === playerId);
    list.replaceChildren(...state.players.map((p, i) => h('li.player', {},
      h('span.swatch', { style: { background: colorOf(p, i) } }),
      h('span.name', {}, p.name, p.id === playerId ? ' (you)' : ''),
      p.id === state.hostId ? h('span.tag.host', {}, 'HOST') : null,
      p.bot ? h('span.tag.bot', {}, 'BOT') : h(`span.tag${p.ready ? '.ready' : ''}`, {}, p.ready ? 'READY' : 'not ready'),
    )));
    ready.textContent = me?.ready ? 'Ready ✓ (tap to undo)' : 'I’m ready';
    ready.className = `btn ${me?.ready ? 'good' : ''}`;

    const inLobby = state.state === ROOM_STATE.LOBBY;
    const botCount = state.players.filter((p) => p.bot).length;
    botRow.hidden = !host;
    addBot.disabled = !inLobby || n >= MAX_PLAYERS;
    removeBot.disabled = !inLobby || botCount === 0;
    start.hidden = !host;
    start.disabled = !inLobby || n < MIN_PLAYERS;
    start.textContent = n < MIN_PLAYERS ? `Start (need ${MIN_PLAYERS - n} more)` : 'Start';
    note.textContent = !inLobby ? 'A round is finishing. The lobby opens in a moment.'
      : host ? (n < MIN_PLAYERS ? `Waiting for players: ${n}/${MIN_PLAYERS} (or add bots)` : 'Everyone in? Tap Start.')
        : 'Waiting for the host to start…';
  }

  const off = net.on(S2C.LOBBY, (l) => { state = l; err.textContent = ''; render(); });

  const el = h('div.screen', {},
    h('div.row', { style: { width: 'min(760px, 100%)' } }, h('h2', {}, 'Lobby'), h('div', { style: { flex: 'none' } }, leave)),
    h('div.lobby', {},
      h('div.card.code-card', {},
        h('div.muted', {}, 'Room code'),
        h('div.room-code', {}, state.code),
        qr,
        h('div.muted', {}, 'Scan to join, or enter the code')),
      h('div.stack', { style: { width: '100%' } },
        h('div.card', {}, list),
        ready, start, botRow, recal, note, err)));
  root.append(el);
  renderQr(qr, joinUrl(state.code));
  render();

  return () => { off(); el.remove(); };
}
