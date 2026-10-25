// server/fake-client.js
// Headless phone: joins room TEST, drives in a wobbly line, taps once a second,
// and prints what the server sends. Use it to check the server without a phone.
//
// Run (with the fake server running):  npm run fake:client
// Different server:                    SERVER=https://your-host npm run fake:client

import { io } from 'socket.io-client';
import { C2S, S2C } from '../shared/protocol.js';
import { CONFIG } from '../shared/config.js';

const SERVER = process.env.SERVER || 'http://localhost:3000';
const CODE = process.env.CODE || 'TEST';
const socket = io(SERVER);

let seq = 0;
let snaps = 0;
let me = null;

socket.on('connect', () => {
  socket.emit(C2S.JOIN_ROOM, { code: CODE, name: 'HeadlessBot' }, (res) => {
    if (res.error) { console.error('join failed:', res.error); process.exit(1); }
    me = res.playerId;
    console.log('joined', CODE, 'as', me);
  });
});

socket.on(S2C.LOBBY, (l) => console.log('lobby:', l.state, l.players.map(p => p.name).join(', ')));
socket.on(S2C.COUNTDOWN, (c) => console.log('countdown:', c.seconds));
socket.on(S2C.ROUND_END, (r) => console.log('round end, winner', r.winnerId, r.leaderboard));

socket.on(S2C.SNAP, (snap) => {
  snaps += 1;
  const mine = snap.cars.find(c => c.id === me);
  for (const e of snap.events) console.log('  event', e);
  if (snaps % 20 === 0) {
    console.log(`snap t=${snap.t} cars=${snap.cars.length} timeLeft=${snap.timeLeft}`,
      mine ? `me: x=${mine.x} y=${mine.y} a=${mine.a} hp=${mine.hp} s=${mine.s}` : '');
  }
});

setInterval(() => {
  const t = Date.now() / 1000;
  socket.emit(C2S.INPUT, {
    seq: seq++,
    tilt: Math.sin(t) * 0.6,
    accel: true,
    taps: seq % CONFIG.INPUT_HZ === 0 ? 1 : 0,
  });
}, 1000 / CONFIG.INPUT_HZ);
