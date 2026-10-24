// server/fake.js
// FAKE SERVER so the client, lobby, and spectator can be built before real physics exists.
//
// Real here (port into rooms.js / mechanics.js):
//   - Every message in shared/protocol.js, with the exact shapes
//   - Room codes, join/leave, colors, ready, host start, countdown, round end, scoring
//   - Tip-over from input (full speed + full tilt), tap recovery, wall/pillar penalty,
//     kill heal + buff, stun timing
//
// Fake (replace with Planck in game.js):
//   - Cars move kinematically and pass through each other
//   - Car-to-car hits and head-ons are random events every few seconds
//
// Run:  npm install && npm run fake    ->  http://localhost:3000
// Room "TEST" always exists with 3 bots looping rounds. Join it with code TEST to get
// a drivable car immediately (no lobby needed).

import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';

import {
  C2S, S2C, ROOM_STATE, CAR_STATE, EVENT, BUFF, HIT_KIND,
  sanitizeInput, packCar, CODE_ALPHABET, CODE_LENGTH,
} from '../shared/protocol.js';
import {
  ARENA, SCALE, CAR_SIZE, MIN_PLAYERS, MAX_PLAYERS, OBSTACLES, SPAWN_RADIUS, CARS, DEFAULT_CAR,
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
    state: ROOM_STATE.LOBBY,
    players: new Map(),   // id -> player
    cars: new Map(),      // id -> car
    events: [],
    timeLeft: CONFIG.ROUND_TIME_S,
    nextFakeHit: 0,
    nextFakeHeadon: 0,
    timers: [],
  };
  rooms.set(code, room);
  return room;
}

function freeColor(room) {
  const used = new Set([...room.players.values()].map(p => p.color));
  for (let i = 0; i < MAX_PLAYERS; i++) if (!used.has(i)) return i;
  return 0;
}

function addPlayer(room, id, name, isBot = false) {
  const p = {
    id,
    name: String(name || 'Player').slice(0, 12),
    color: freeColor(room),
    ready: isBot,
    isBot,
    botDir: Math.random() < 0.5 ? 1 : -1,
    input: { seq: 0, tilt: 0, accel: false, taps: 0 },
    kills: 0,
    damage: 0,
  };
  room.players.set(id, p);
  return p;
}

function humans(room) {
  return [...room.players.values()].filter(p => !p.isBot);
}

function lobbyState(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    state: room.state,
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, color: p.color, ready: p.ready,
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
  const spec = CARS[DEFAULT_CAR]; // MVP: everyone drives balanced
  return {
    id: p.id, x, y, a,
    speed: 0,                 // world units / s
    hp: spec.hp,
    maxHp: spec.hp,
    s: CAR_STATE.ALIVE,
    taps: 0,
    flipHeldMs: 0,
    stunUntil: 0,
    invulnUntil: 0,
    buff: BUFF.NONE,
    buffUntil: 0,
    lastAttacker: null,
    lastHitAt: 0,
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
    p.damage = 0;
  });
}

function spawnOne(room, p) {
  const x = 100 + Math.random() * (ARENA.W - 200);
  const y = 100 + Math.random() * (ARENA.H - 200);
  room.cars.set(p.id, makeCar(p, x, y, Math.random() * Math.PI * 2));
}

function liveScore(p) {
  return p.damage * CONFIG.SCORE_PER_DAMAGE + p.kills * CONFIG.SCORE_KILL;
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
      room.nextFakeHeadon = Date.now() + 7000;
      broadcastLobby(room);
    }
  };
  room.timers.push(setTimeout(step, 1000));
}

function aliveCars(room) {
  return [...room.cars.values()].filter(c => c.s !== CAR_STATE.DEAD);
}

function endRound(room) {
  room.state = ROOM_STATE.ROUND_END;
  const alive = aliveCars(room);
  let winnerId = null;
  if (alive.length === 1) winnerId = alive[0].id;
  else if (alive.length > 1) winnerId = alive.sort((a, b) => b.hp - a.hp)[0].id;

  const leaderboard = [...room.players.values()].map(p => ({
    id: p.id,
    name: p.name,
    kills: p.kills,
    damage: Math.round(p.damage),
    score: Math.round(liveScore(p) + (p.id === winnerId ? CONFIG.SCORE_WIN : 0)),
  })).sort((a, b) => b.score - a.score);

  io.to(room.code).emit(S2C.ROUND_END, { winnerId, leaderboard });

  room.timers.push(setTimeout(() => {
    if (room.code === 'TEST') {
      startCountdown(room); // TEST room loops forever
    } else {
      room.state = ROOM_STATE.LOBBY;
      room.cars.clear();
      for (const p of room.players.values()) if (!p.isBot) p.ready = false;
      broadcastLobby(room);
    }
  }, 5000));
}

// ---------------------------------------------------------------------------
// Damage, death, kill reward (same rules as design.md section 5)
// ---------------------------------------------------------------------------

function canTakeDamage(car, now) {
  if (car.s === CAR_STATE.DEAD) return false;
  if (now < car.invulnUntil) return false;
  if (car.buff === BUFF.SHIELD && now < car.buffUntil) return false;
  return true;
}

// Returns damage actually dealt.
function applyDamage(room, victim, dmg, attackerId, now) {
  if (!canTakeDamage(victim, now)) return 0;
  const mult = victim.s === CAR_STATE.FLIPPED ? CONFIG.FLIPPED_DMG_MULT : 1;
  const dealt = Math.min(victim.hp, Math.round(dmg * mult));
  victim.hp -= dealt;
  if (attackerId && attackerId !== victim.id) {
    victim.lastAttacker = attackerId;
    victim.lastHitAt = now;
    const ap = room.players.get(attackerId);
    if (ap) ap.damage += dealt;
  }
  return dealt;
}

function checkDeath(room, car, now) {
  if (car.hp > 0 || car.s === CAR_STATE.DEAD) return;
  car.hp = 0;
  car.s = CAR_STATE.DEAD;
  car.speed = 0;

  const creditOk = car.lastAttacker && now - car.lastHitAt <= CONFIG.KILL_CREDIT_MS;
  const killerId = creditOk ? car.lastAttacker : null;
  const killer = killerId && room.players.get(killerId);
  const killerCar = killerId && room.cars.get(killerId);
  let heal = 0;
  let buff = BUFF.NONE;
  if (killer) killer.kills += 1;
  if (killerCar && killerCar.s !== CAR_STATE.DEAD) {
    heal = Math.min(killerCar.maxHp - killerCar.hp, Math.round(killerCar.maxHp * CONFIG.KILL_HEAL_FRAC));
    killerCar.hp += heal;
    buff = CONFIG.KILL_BUFF === 'shield' ? BUFF.SHIELD : BUFF.BOOST;
    killerCar.buff = buff;
    killerCar.buffUntil = now + CONFIG.BUFF_MS;
  }
  room.events.push({ type: EVENT.KILL, attacker: killerId, victim: car.id, heal, buff });
}

// ---------------------------------------------------------------------------
// Fake car-to-car events (real version comes from Planck contacts)
// ---------------------------------------------------------------------------

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function fakeEvents(room, now) {
  const alive = aliveCars(room);
  if (alive.length < 2) return;

  if (now >= room.nextFakeHit) {
    const a = pick(alive);
    const v = pick(alive.filter(c => c.id !== a.id));
    const kind = Math.random() < 0.4 ? HIT_KIND.REAR : HIT_KIND.SIDE;
    const base = 10 + Math.random() * 20;
    const dmg = applyDamage(room, v, kind === HIT_KIND.REAR ? base * (1 + CONFIG.REAR_BONUS) : base, a.id, now);
    applyDamage(room, a, dmg * CONFIG.ATTACKER_RECOIL, null, now);
    if (dmg > 0) room.events.push({ type: EVENT.HIT, attacker: a.id, victim: v.id, dmg, kind });
    checkDeath(room, v, now);
    checkDeath(room, a, now);
    room.nextFakeHit = now + 2500 + Math.random() * 2500;
  }

  if (now >= room.nextFakeHeadon) {
    const upright = alive.filter(c => c.s === CAR_STATE.ALIVE);
    if (upright.length >= 2) {
      const a = pick(upright);
      const b = pick(upright.filter(c => c.id !== a.id));
      const base = 6 + Math.random() * 10;
      const dmgA = applyDamage(room, a, base, b.id, now);
      const dmgB = applyDamage(room, b, base, a.id, now);
      for (const c of [a, b]) {
        if (c.s === CAR_STATE.ALIVE) { c.s = CAR_STATE.STUNNED; c.stunUntil = now + CONFIG.CONCUSSION_MS; }
      }
      room.events.push({ type: EVENT.HEADON, a: a.id, b: b.id, dmg: Math.max(dmgA, dmgB), stunMs: CONFIG.CONCUSSION_MS });
      checkDeath(room, a, now);
      checkDeath(room, b, now);
    }
    room.nextFakeHeadon = now + 9000 + Math.random() * 6000;
  }
}

// ---------------------------------------------------------------------------
// Kinematic driving (real input handling, fake physics)
// ---------------------------------------------------------------------------

function wrapAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

function surfaceHit(room, car, impactSpeedUnits, now) {
  const impact = impactSpeedUnits / SCALE; // m/s
  if (impact < CONFIG.WALL_MIN_SPEED) return;
  car.speed *= CONFIG.WALL_SPEED_KEEP;
  const dmg = applyDamage(room, car, CONFIG.WALL_DMG_K * impact * impact, null, now);
  room.events.push({ type: EVENT.WALL, id: car.id, dmg });
  checkDeath(room, car, now); // credits lastAttacker if within KILL_CREDIT_MS
}

function stepCar(room, car, p, dt, now) {
  const spec = CARS[DEFAULT_CAR];
  const boosted = car.buff === BUFF.BOOST && now < car.buffUntil;
  if (now >= car.buffUntil) car.buff = BUFF.NONE;
  const maxV = spec.maxSpeed * SCALE * (boosted ? CONFIG.BOOST_SPEED_MULT : 1);
  const minV = CONFIG.MIN_SPEED * SCALE;
  const engine = CONFIG.ENGINE * SCALE * (boosted ? CONFIG.BOOST_ENGINE_MULT : 1);
  const input = p.isBot ? { tilt: 0.45 * p.botDir, accel: true, taps: 0 } : p.input;
  const taps = input.taps;
  if (!p.isBot) input.taps = 0; // taps are consumed every tick

  if (car.s === CAR_STATE.STUNNED) {
    car.speed *= Math.exp(-CONFIG.COAST_DAMPING * dt);
    if (now >= car.stunUntil) car.s = CAR_STATE.ALIVE;
  } else if (car.s === CAR_STATE.FLIPPED) {
    car.speed *= Math.exp(-CONFIG.FLIPPED_DAMPING * dt);
    car.taps += p.isBot ? (now >= car.botRecoverAt ? CONFIG.RECOVER_TAPS : 0) : taps;
    if (car.taps >= CONFIG.RECOVER_TAPS) {
      car.s = CAR_STATE.ALIVE;
      car.taps = 0;
      car.invulnUntil = now + CONFIG.RECOVER_INVULN_MS;
      room.events.push({ type: EVENT.RECOVER, id: car.id });
    }
  } else {
    // Throttle
    if (input.accel) {
      car.speed = car.speed < minV ? minV : Math.min(maxV, car.speed + engine * dt);
    } else {
      car.speed *= Math.exp(-CONFIG.COAST_DAMPING * dt);
    }
    // Steering
    const grip = Math.min(1, car.speed / minV);
    car.a = wrapAngle(car.a + input.tilt * spec.turnRate * grip * dt);

    // Tip-over: full speed + full steering held too long
    const greedy = car.speed >= CONFIG.FLIP_SPEED_FRAC * spec.maxSpeed * SCALE
      && Math.abs(input.tilt) >= CONFIG.FLIP_TILT;
    car.flipHeldMs = greedy ? car.flipHeldMs + dt * 1000 : 0;
    if (car.flipHeldMs >= CONFIG.FLIP_HOLD_MS) {
      car.s = CAR_STATE.FLIPPED;
      car.taps = 0;
      car.flipHeldMs = 0;
      car.botRecoverAt = now + 2500;
      room.events.push({ type: EVENT.FLIP, id: car.id });
    }
  }

  // Move
  car.x += Math.cos(car.a) * car.speed * dt;
  car.y += Math.sin(car.a) * car.speed * dt;

  // Walls: reflect, lose speed, self-damage
  const half = CAR_SIZE.W / 2;
  const vx = Math.cos(car.a) * car.speed;
  const vy = Math.sin(car.a) * car.speed;
  if (car.x < half) { car.x = half; car.a = wrapAngle(Math.PI - car.a); surfaceHit(room, car, Math.abs(vx), now); }
  else if (car.x > ARENA.W - half) { car.x = ARENA.W - half; car.a = wrapAngle(Math.PI - car.a); surfaceHit(room, car, Math.abs(vx), now); }
  if (car.y < half) { car.y = half; car.a = wrapAngle(-car.a); surfaceHit(room, car, Math.abs(vy), now); }
  else if (car.y > ARENA.H - half) { car.y = ARENA.H - half; car.a = wrapAngle(-car.a); surfaceHit(room, car, Math.abs(vy), now); }

  // Pillars: same penalty as walls
  for (const o of OBSTACLES) {
    const dx = car.x - o.x;
    const dy = car.y - o.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 0 && dist < o.r + half) {
      const nx = dx / dist, ny = dy / dist;
      car.x = o.x + nx * (o.r + half);
      car.y = o.y + ny * (o.r + half);
      let dxv = Math.cos(car.a), dyv = Math.sin(car.a);
      const dot = dxv * nx + dyv * ny;
      if (dot < 0) {
        const impact = -dot * car.speed;
        dxv -= 2 * dot * nx;
        dyv -= 2 * dot * ny;
        car.a = Math.atan2(dyv, dxv);
        surfaceHit(room, car, impact, now);
      }
    }
  }
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

  if (room.state !== ROOM_STATE.PLAYING) return;
  const enough = room.players.size > 1;
  if ((enough && aliveCars(room).length <= 1) || room.timeLeft <= 0) endRound(room);
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
      cars: [...room.cars.values()].map(c => {
        const p = room.players.get(c.id);
        return packCar({ ...c, sc: p ? liveScore(p) : 0 });
      }),
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
    const midRound = room.state !== ROOM_STATE.LOBBY;
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
    reply(ack)({ ok: true });
    socket.emit(S2C.LOBBY, lobbyState(room));
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
    const min = room.devRoom ? CONFIG.DEV_MIN_PLAYERS : MIN_PLAYERS;
    if (room.players.size < min) return reply(ack)({ error: `Need at least ${min} players` });
    reply(ack)({ ok: true });
    startCountdown(room);
  });

  socket.on(C2S.INPUT, (raw) => {
    const p = myRoom()?.players.get(socket.id);
    if (!p) return;
    const s = sanitizeInput(raw);
    p.input = { ...s, taps: p.input.taps + s.taps }; // taps accumulate until a tick uses them
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
