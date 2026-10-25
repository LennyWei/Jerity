// client/src/main.js
// Router: home -> lobby -> game -> results, plus /join/ABCD and /spectate/ABCD.
// Person 4 owns this file.
//
// Screen changes follow the server: the countdown opens the game screen, roundEnd opens
// results, and the lobby comes back when the server reopens it (TEST loops straight into the
// next countdown). Each screen is mount(root, ctx) -> unmount.

import './style.css';
import { net } from './net.js';
import { h, keepQuery, store } from './ui.js';
import { bumpCorruption, resetCorruption } from './verity-ui.js';
import { disableMicrophone } from './jerity-audio.js';
import { C2S, S2C, ROOM_STATE } from '../../shared/protocol.js';
import * as home from './screens/home.js';
import * as lobbyScreen from './screens/lobby.js';
import * as game from './screens/game.js';
import * as results from './screens/results.js';
import * as spectate from './screens/spectate.js';

const app = document.getElementById('app');
const banner = h('div.banner');
document.body.append(banner);

const session = { playerId: null, code: null, name: '', lobby: null };
let screen = '';
let unmount = null;

function show(name, mountFn) {
  unmount?.();
  unmount = null;
  app.replaceChildren();
  screen = name;
  unmount = mountFn(app) || null;
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

function goHome(code = '', error = '') {
  disableMicrophone();
  if (session.code) { net.emit(C2S.LEAVE, {}); bumpCorruption(0.02); }
  Object.assign(session, { playerId: null, code: null, lobby: null });
  history.replaceState(null, '', (code ? `/join/${code}` : '/') + keepQuery());
  show('home', (root) => home.mount(root, { net, code, error, onCreate, onJoin }));
}

function showLobby() {
  show('lobby', (root) => lobbyScreen.mount(root, {
    net, playerId: session.playerId, lobby: session.lobby, onLeave: () => goHome(),
  }));
}

function showGame(countdown = null) {
  show('game', (root) => game.mount(root, {
    net, playerId: session.playerId, lobby: session.lobby, countdown,
    // Verity wears down once per game: after a match's last round (or a lone round from an older server).
    onRoundEnd: (result) => (bumpCorruption(result.final || typeof result.round !== 'number' ? 0.06 : 0), show('results', (r) => results.mount(r, {
      result, lobby: session.lobby, playerId: session.playerId, onPlayAgain: showLobby,
    }))),
  }));
}

/** After joining (or rejoining): mid-round rooms go straight to the game, others to the lobby. */
function enterRoomView() {
  const s = session.lobby?.state;
  if (s === ROOM_STATE.COUNTDOWN || s === ROOM_STATE.PLAYING) showGame();
  else showLobby();
}

async function enterRoom(playerId, code, name, rejoinKey) {
  Object.assign(session, { playerId, code, name, rejoinKey });
  history.replaceState(null, '', `/join/${code}${keepQuery()}`);
  if (session.lobby?.code === code) enterRoomView();
  else screen = 'waiting'; // the lobby event right after the ack decides where we go
}

// ---------------------------------------------------------------------------
// Home actions (both run from a tap, so the iPhone motion prompt is allowed here)
// ---------------------------------------------------------------------------

async function onCreate(name, bots) {
  await game.requestMotionPermission();
  const res = await net.request(C2S.CREATE_ROOM, { name, bots });
  if (res.error) return res.error;
  await enterRoom(res.playerId, res.code, name, res.rejoinKey);
}

async function onJoin(name, code) {
  await game.requestMotionPermission();
  const res = await net.request(C2S.JOIN_ROOM, { code, name });
  if (res.error) return res.error;
  await enterRoom(res.playerId, code, name, res.rejoinKey);
}

// ---------------------------------------------------------------------------
// Server events that move between screens
// ---------------------------------------------------------------------------

net.on(S2C.LOBBY, (l) => {
  if (l.code !== session.code) return;
  session.lobby = l;
  if (screen === 'waiting') enterRoomView();
  else if (screen === 'results' && l.state === ROOM_STATE.LOBBY) showLobby(); // server reopened the lobby
});

// A restarted game server (new bootId) starts Verity over from cheerful on every phone.
net.on(S2C.HELLO, ({ bootId } = {}) => {
  if (!bootId || store.get('jerity-boot') === bootId) return;
  store.set('jerity-boot', bootId);
  resetCorruption();
});

net.on(S2C.COUNTDOWN, ({ seconds }) => {
  if (session.playerId && seconds > 0 && (screen === 'lobby' || screen === 'results')) showGame(seconds);
});

// Connection. Before the first connect, say we're connecting; after a few seconds, that the
// server may be waking up (Render's free plan sleeps). When it drops, say so; on reconnect,
// rejoin as the same player: the server keeps our car (a ghost) for DISCONNECT_GRACE_MS, even
// mid-round, and the rejoin key proves it is us.
let everConnected = false;
banner.className = 'banner info';
banner.textContent = 'Connecting to the game server…';
setTimeout(() => {
  if (!everConnected) banner.textContent = 'Waking up the game server… this can take up to a minute';
}, 3000);
net.onStatus(async (up) => {
  if (!everConnected && !up) return; // still waking: keep the waking message
  banner.className = 'banner';
  banner.textContent = up ? '' : 'Connection lost · reconnecting…';
  if (!up) return;
  if (!everConnected) { everConnected = true; return; }
  if (!session.code) return;
  const res = await net.request(C2S.JOIN_ROOM, {
    code: session.code, name: session.name, playerId: session.playerId, rejoinKey: session.rejoinKey,
  });
  if (res.error) return goHome(session.code, `Lost connection: ${res.error}`);
  Object.assign(session, { playerId: res.playerId, rejoinKey: res.rejoinKey });
  screen = 'waiting';
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const [first, code] = location.pathname.split('/').filter(Boolean);
if (first === 'spectate' && code) {
  show('spectate', (root) => spectate.mount(root, {
    net, code: code.toUpperCase(), onError: (msg) => goHome('', `Can't watch room ${code.toUpperCase()}: ${msg}`),
  }));
} else {
  goHome(first === 'join' && code ? code.toUpperCase() : '');
}
