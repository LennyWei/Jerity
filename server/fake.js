// server/fake.js
// FAKE SERVER so the client, lobby, and spectator can be built before real physics exists.
//
// What is real here (keep or port into rooms.js):
//   - Every message in shared/protocol.js, with the exact shapes
//   - Room codes, join/leave, teams, car pick, ready, host start, countdown, round end
//
// What is fake (replace with Planck in game.js):
//   - Cars move kinematically (no collisions between cars)
//   - Hits and flips are random events every few seconds
//
// Run:  npm install && npm run fake    ->  http://localhost:3000
// A room "TEST" always exists with 3 bots looping rounds. Join it from any client
// with code TEST to get a drivable car immediately (no lobby needed).

import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';

import {
  C2S, S2C, MODES, ROOM_STATE, CAR_STATE, EVENT,
  sanitizeInput, packCar, CODE_ALPHABET, CODE_LENGTH,
} from '../shared/protocol.js';
import {
  ARENA, SCALE, CAR_SIZE, MAX_PLAYERS, OBSTACLES, SPAWN_RADIUS, CARS, DEFAULT_CAR,
} from '../shared/constants.js';
import { CONFIG } from '../shared/config.js';

const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.static(path.join(__dirname, '../client/dist')));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: [...rooms.keys()] }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

const rooms = new Map();
let botSeq = 1;

function makeCode() {
  let code;
  do {
    code = Array.from({ length: CODE_LENGTH },
      () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function newRoom(code, hostId, devRoom = false) {
  const room = {
    code, hostId, devRoom,
    mode: 'ffa',
    state: ROOM_STATE.LOBBY,
    players: new Map(),   // id -> player
    cars: new Map(),      // id -> car
    events: [],
    timeLeft: CONFIG.ROUND_TIME_S,
    nextFakeHit: 0,
    nextFakeFlip: 0,
    timers: [],
  };
  rooms.set(code, room);
  return room;
}

function teamFor(room, index) {
  if (room.mode === 'ffa') return index;
  return index % 2;
}

function addPlayer(room, id, name, isBot = false) {
  const p = {
    id,
    name: String(name || 'Player').slice(0, 12),
    team: teamFor(room, room.players.size),
    car: DEFAULT_CAR,
    ready: isBot,
    isBot,
    botDir: Math.random() < 0.5 ? 1 : -1,
    input: { seq: 0, tilt: 0, accel: false, taps: 0 },
    kills: 0,
    survived: 0,
  };
  room.players.set(id, p);
  return p;
}

function reassignTeams(room) {
  [...room.players.values()].forEach((p, i) => { p.team = teamFor(room, i); });
}

function humans(room) {
  return [...room.players.values()].filter(p => !p.isBot);
}

function lobbyState(room) {
  return {
    code: room.code,
    mode: room.mode,
    hostId: room.hostId,
    state: room.state,
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, team: p.team, car: p.car, ready: p.ready,
    })),
  };
}

function broadcastLobby(room) {
  io.to(room.code).emit(S2C.LOBBY, lobbyState(room));
}

function clearTimers(room) {
  room.timers.forEach(clearTimeout);
  room.timers = [];
}

// ---------------------------------------------------------------------------
// Cars
// ---------------------------------------------------------------------------

function makeCar(p, x, y, a) {
  return {
    id: p.id, x, y, a,
    speed: 0,
    hp: CARS[p.car].hp,
    s: CAR_STATE.ALIVE,
    parry: 0,
    parryUntil: 0,
    parryReadyAt: 0,
    taps: 0,
    botRecoverAt: 0,
  };
}

function spawnAll(room) {
  room.cars.clear();
  const list = [...room.players.values()];
  list.forEach((p, i) => {
    const ang = (2 * Math.PI * i) / list.length;
    const x = ARENA.W / 2 + SPAWN_RADIUS * Math.cos(ang);
    const y = ARENA.H / 2 + SPAWN_RADIUS * Math.sin(ang);
    room.cars.set(p.id, makeCar(p, x, y, ang + Math.PI)); // face the center
    p.kills = 0;
    p.survived = 0;
  });
}

function spawnOne(room, p) {
  const x = 100 + Math.random() * (ARENA.W - 200);
  const y = 100 + Math.random() * (ARENA.H - 200);
  room.cars.set(p.id, makeCar(p, x, y, Math.random() * Math.PI * 2));
}

// ---------------------------------------------------------------------------
// Round flow
// ---------------------------------------------------------------------------

function startCountdown(room) {
  clearTimers(room);
  room.state = ROOM_STATE.COUNTDOWN;
  room.events = [];
  spawnAll(room);
  broadcastLobby(room);

  let s = CONFIG.COUNTDOWN_S;
  io.to(room.code).emit(S2C.COUNTDOWN, { seconds: s });
  const step = () => {
    s -= 1;
    if (s > 0) {
      io.to(room.code).emit(S2C.COUNTDOWN, { seconds: s });
      room.timers.push(setTimeout(step, 1000));
    } else {
      io.to(room.code).emit(S2C.COUNTDOWN, { seconds: 0 });
      room.state = ROOM_STATE.PLAYING;
      room.timeLeft = CONFIG.ROUND_TIME_S;
      room.nextFakeHit = Date.now() + 2000;
      room.nextFakeFlip = Date.now() + 6000;
      broadcastLobby(room);
    }
  };
  room.timers.push(setTimeout(step, 1000));
}

function aliveTeams(room) {
  const teams = new Set();
  for (const car of room.cars.values()) {
    if (car.s === CAR_STATE.DEAD) continue;
    const p = room.players.get(car.id);
    if (p) teams.add(p.team);
  }
  return teams;
}

function endRound(room) {
  room.state = ROOM_STATE.ROUND_END;
  const teams = aliveTeams(room);
  let winnerTeam = null;
  if (teams.size === 1) {
    winnerTeam = [...teams][0];
  } else if (teams.size > 1) {
    const hpByTeam = new Map();
    for (const car of room.cars.values()) {
      const p = room.players.get(car.id);
      if (!p || car.s === CAR_STATE.DEAD) continue;
      hpByTeam.set(p.team, (hpByTeam.get(p.team) || 0) + car.hp);
    }
    winnerTeam = [...hpByTeam.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  }

  const leaderboard = [...room.players.values()].map(p => ({
    id: p.id,
    name: p.name,
    kills: p.kills,
    survived: Math.round(p.survived),
    score: p.kills * CONFIG.SCORE_KILL
      + Math.round(p.survived) * CONFIG.SCORE_PER_SECOND
      + (p.team === winnerTeam ? CONFIG.SCORE_WIN : 0),
  })).sort((a, b) => b.score - a.score);

  io.to(room.code).emit(S2C.ROUND_END, { winnerTeam, leaderboard });

  room.timers.push(setTimeout(() => {
    if (room.devRoom && room.code === 'TEST') {
      startCountdown(room);          // TEST room loops forever
    } else {
      room.state = ROOM_STATE.LOBBY;
      room.cars.clear();
      for (const p of room.players.values()) if (!p.isBot) p.ready = false;
      broadcastLobby(room);
    }
  }, 5000));
}

// ---------------------------------------------------------------------------
// Fake simulation
// ---------------------------------------------------------------------------

function wrapAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

function damage(room, attackerId, victim, dmg) {
  const now = Date.now();
  if (victim.parry) {
    room.events.push({ type: EVENT.PARRY, id: victim.id, attacker: attackerId });
    const attacker = room.cars.get(attackerId);
    if (attacker && attacker.s !== CAR_STATE.DEAD) {
      attacker.hp -= dmg * CONFIG.PARRY_REFLECT;
      checkDeath(room, attacker, victim.id);
    }
    return;
  }
  const mult = victim.s === CAR_STATE.FLIPPED ? CONFIG.FLIPPED_DMG_MULT : 1;
  const dealt = Math.round(dmg * mult);
  victim.hp -= dealt;
  room.events.push({ type: EVENT.HIT, attacker: attackerId, victim: victim.id, dmg: dealt });
  checkDeath(room, victim, attackerId);
  void now;
}

function checkDeath(room, car, killerId) {
  if (car.hp > 0 || car.s === CAR_STATE.DEAD) return;
  car.hp = 0;
  car.s = CAR_STATE.DEAD;
  car.speed = 0;
  const killer = killerId && room.players.get(killerId);
  if (killer) killer.kills += 1;
  room.events.push({ type: EVENT.KILL, attacker: killer ? killerId : null, victim: car.id });
}

function fakeEvents(room, now) {
  const alive = [...room.cars.values()].filter(c => c.s !== CAR_STATE.DEAD);
  if (alive.length < 2) return;

  if (now >= room.nextFakeHit) {
    const a = alive[Math.floor(Math.random() * alive.length)];
    const others = alive.filter(c => c.id !== a.id);
    const v = others[Math.floor(Math.random() * others.length)];
    damage(room, a.id, v, 8 + Math.random() * 22);
    room.nextFakeHit = now + 2500 + Math.random() * 2500;
  }

  if (now >= room.nextFakeFlip) {
    const upright = alive.filter(c => c.s === CAR_STATE.ALIVE);
    if (upright.length) {
      const c = upright[Math.floor(Math.random() * upright.length)];
      c.s = CAR_STATE.FLIPPED;
      c.taps = 0;
      c.botRecoverAt = now + 2500;
      room.events.push({ type: EVENT.FLIP, id: c.id });
    }
    room.nextFakeFlip = now + 8000 + Math.random() * 6000;
  }
}

function stepCar(room, car, p, dt, now) {
  const spec = CARS[p.car] || CARS[DEFAULT_CAR];
  const maxV = spec.maxSpeed * SCALE;
  const minV = CONFIG.MIN_SPEED * SCALE;
  const input = p.isBot
    ? { tilt: 0.45 * p.botDir, accel: true, taps: 0 }
    : p.input;

  // Flipped: slide to a stop, count recovery taps
  if (car.s === CAR_STATE.FLIPPED) {
    car.speed *= Math.exp(-CONFIG.FLIPPED_DAMPING * dt);
    if (p.isBot) {
      if (now >= car.botRecoverAt) car.taps = CONFIG.RECOVER_TAPS;
    } else {
      car.taps += input.taps;
      input.taps = 0;
    }
    if (car.taps >= CONFIG.RECOVER_TAPS) {
      car.s = CAR_STATE.ALIVE;
      car.taps = 0;
      room.events.push({ type: EVENT.RECOVER, id: car.id });
    }
  } else {
    // Parry on tap
    if (CONFIG.PARRY_ENABLED && input.taps > 0 && now >= car.parryReadyAt) {
      car.parryUntil = now + CONFIG.PARRY_WINDOW_MS;
      car.parryReadyAt = now + CONFIG.PARRY_COOLDOWN_MS;
    }
    if (!p.isBot) input.taps = 0;
    car.parry = now < car.parryUntil ? 1 : 0;

    // Throttle
    if (input.accel) {
      car.speed = car.speed < minV ? minV : Math.min(maxV, car.speed + CONFIG.ENGINE * SCALE * dt);
    } else {
      car.speed *= Math.exp(-CONFIG.COAST_DAMPING * dt);
    }

    // Steering
    const grip = Math.min(1, car.speed / minV);
    car.a = wrapAngle(car.a + input.tilt * spec.turnRate * grip * dt);
  }

  // Move
  car.x += Math.cos(car.a) * car.speed * dt;
  car.y += Math.sin(car.a) * car.speed * dt;

  // Walls: reflect and slow
  const half = CAR_SIZE.W / 2;
  let hitWall = false;
  if (car.x < half) { car.x = half; car.a = wrapAngle(Math.PI - car.a); hitWall = true; }
  if (car.x > ARENA.W - half) { car.x = ARENA.W - half; car.a = wrapAngle(Math.PI - car.a); hitWall = true; }
  if (car.y < half) { car.y = half; car.a = wrapAngle(-car.a); hitWall = true; }
  if (car.y > ARENA.H - half) { car.y = ARENA.H - half; car.a = wrapAngle(-car.a); hitWall = true; }
  if (hitWall && car.speed > CONFIG.WALL_MIN_SPEED * SCALE) {
    car.speed *= CONFIG.WALL_SPEED_KEEP;
    room.events.push({ type: EVENT.WALL, id: car.id, dmg: 0 });
  }

  // Obstacles: push out and bounce
  for (const o of OBSTACLES) {
    const dx = car.x - o.x;
    const dy = car.y - o.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 0 && dist < o.r + half) {
      const nx = dx / dist, ny = dy / dist;
      car.x = o.x + nx * (o.r + half);
      car.y = o.y + ny * (o.r + half);
      let vx = Math.cos(car.a), vy = Math.sin(car.a);
      const dot = vx * nx + vy * ny;
      if (dot < 0) {
        vx -= 2 * dot * nx;
        vy -= 2 * dot * ny;
        car.a = Math.atan2(vy, vx);
        car.speed *= 0.6;
      }
    }
  }

  if (car.s !== CAR_STATE.DEAD) p.survived += dt;
}

function tickRoom(room, dt, now) {
  if (room.state !== ROOM_STATE.PLAYING) return;
  for (const car of room.cars.values()) {
    if (car.s === CAR_STATE.DEAD) continue;
    const p = room.players.get(car.id);
    if (p) stepCar(room, car, p, dt, now);
  }
  fakeEvents(room, now);
  room.timeLeft -= dt;

  const teams = aliveTeams(room);
  const enoughToWin = room.players.size > 1;
  if ((enoughToWin && teams.size <= 1) || room.timeLeft <= 0) endRound(room);
}

setInterval(() => {
  const now = Date.now();
  const dt = 1 / CONFIG.TICK_HZ;
  for (const room of rooms.values()) tickRoom(room, dt, now);
}, 1000 / CONFIG.TICK_HZ);

setInterval(() => {
  const t = Date.now();
  for (const room of rooms.values()) {
    if (room.state !== ROOM_STATE.PLAYING && room.state !== ROOM_STATE.COUNTDOWN) continue;
    io.to(room.code).emit(S2C.SNAP, {
      t,
      cars: [...room.cars.values()].map(packCar),
      events: room.events.splice(0),
      timeLeft: Math.max(0, Math.ceil(room.timeLeft)),
    });
  }
}, 1000 / CONFIG.SNAP_HZ);

// ---------------------------------------------------------------------------
// Sockets
// ---------------------------------------------------------------------------

io.on('connection', (socket) => {
  const reply = (ack) => (typeof ack === 'function' ? ack : () => {});
  const myRoom = () => rooms.get(socket.data.code);

  socket.on(C2S.CREATE_ROOM, (msg = {}, ack) => {
    const code = makeCode();
    const bots = Math.max(0, Math.min(MAX_PLAYERS - 1, Number(msg.bots) || 0));
    const room = newRoom(code, socket.id, bots > 0);
    addPlayer(room, socket.id, msg.name);
    for (let i = 1; i <= bots; i++) addPlayer(room, `bot${botSeq++}`, `Bot ${i}`, true);
    socket.join(code);
    socket.data.code = code;
    reply(ack)({ code, playerId: socket.id });
    broadcastLobby(room);
  });

  socket.on(C2S.JOIN_ROOM, (msg = {}, ack) => {
    const code = String(msg.code || '').toUpperCase();
    const room = rooms.get(code);
    if (!room) return reply(ack)({ error: 'Room not found' });
    if (room.players.size >= MAX_PLAYERS) return reply(ack)({ error: 'Room is full' });
    const midRound = room.state === ROOM_STATE.PLAYING || room.state === ROOM_STATE.COUNTDOWN;
    if (midRound && !room.devRoom) return reply(ack)({ error: 'Round in progress' });

    const p = addPlayer(room, socket.id, msg.name);
    if (midRound) spawnOne(room, p);
    if (!room.hostId) room.hostId = socket.id;
    socket.join(code);
    socket.data.code = code;
    reply(ack)({ playerId: socket.id });
    broadcastLobby(room);
  });

  socket.on(C2S.SPECTATE, (msg = {}, ack) => {
    const code = String(msg.code || '').toUpperCase();
    const room = rooms.get(code);
    if (!room) return reply(ack)({ error: 'Room not found' });
    socket.join(code);
    socket.data.spectating = code;
    reply(ack)({ ok: true });
    socket.emit(S2C.LOBBY, lobbyState(room));
  });

  socket.on(C2S.SET_TEAM, (msg = {}) => {
    const room = myRoom(); const p = room?.players.get(socket.id);
    if (!p || room.state !== ROOM_STATE.LOBBY || room.mode === 'ffa') return;
    p.team = Math.max(0, Math.min(1, Number(msg.team) || 0));
    broadcastLobby(room);
  });

  socket.on(C2S.PICK_CAR, (msg = {}) => {
    const room = myRoom(); const p = room?.players.get(socket.id);
    if (!p || room.state !== ROOM_STATE.LOBBY || !CARS[msg.car]) return;
    p.car = msg.car;
    broadcastLobby(room);
  });

  socket.on(C2S.SET_MODE, (msg = {}) => {
    const room = myRoom();
    if (!room || room.hostId !== socket.id || !MODES.includes(msg.mode)) return;
    room.mode = msg.mode;
    reassignTeams(room);
    broadcastLobby(room);
  });

  socket.on(C2S.READY, (msg = {}) => {
    const room = myRoom(); const p = room?.players.get(socket.id);
    if (!p) return;
    p.ready = !!msg.ready;
    broadcastLobby(room);
  });

  socket.on(C2S.START, (_msg, ack) => {
    const room = myRoom();
    if (!room || room.hostId !== socket.id) return reply(ack)({ error: 'Only the host can start' });
    if (room.state !== ROOM_STATE.LOBBY) return reply(ack)({ error: 'Already started' });
    const min = room.devRoom ? CONFIG.DEV_MIN_PLAYERS : CONFIG.MIN_PLAYERS;
    if (room.players.size < min) return reply(ack)({ error: `Need at least ${min} players` });
    reply(ack)({ ok: true });
    startCountdown(room);
  });

  socket.on(C2S.INPUT, (raw) => {
    const p = myRoom()?.players.get(socket.id);
    if (!p) return;
    const s = sanitizeInput(raw);
    p.input = { ...s, taps: p.input.taps + s.taps }; // taps accumulate until the tick uses them
  });

  const leave = () => {
    const room = myRoom();
    if (!room) return;
    room.players.delete(socket.id);
    room.cars.delete(socket.id);
    socket.leave(room.code);
    socket.data.code = undefined;
    if (room.hostId === socket.id) room.hostId = humans(room)[0]?.id ?? null;
    if (humans(room).length === 0 && room.code !== 'TEST') {
      clearTimers(room);
      rooms.delete(room.code);
      return;
    }
    broadcastLobby(room);
  };
  socket.on(C2S.LEAVE, leave);
  socket.on('disconnect', leave);
});

// ---------------------------------------------------------------------------
// Always-on TEST room: 3 bots looping rounds
// ---------------------------------------------------------------------------

const test = newRoom('TEST', null, true);
for (let i = 1; i <= 3; i++) addPlayer(test, `bot${botSeq++}`, `Bot ${i}`, true);
startCountdown(test);

server.listen(PORT, () => {
  console.log(`Fake server on http://localhost:${PORT}  (room TEST is always running)`);
});
