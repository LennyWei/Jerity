// server/rooms.js
// Room lifecycle: codes, join/leave, colors, ready, host start, countdown, round end, scoring,
// and the always-on TEST room. Lifted from fake.js; the game itself lives in game.js.
//
// createRooms(io) starts the tick and snapshot loops and returns { attach, codes }:
//   io.on('connection', rooms.attach)

import {
  C2S, S2C, ROOM_STATE, sanitizeInput, CODE_ALPHABET, CODE_LENGTH,
} from '../shared/protocol.js';
import { MIN_PLAYERS, MAX_PLAYERS, NAME_MAX, MAPS, DEFAULT_MAP } from '../shared/constants.js';
import { CONFIG } from '../shared/config.js';
import { createGame } from './game.js';
import { liveScore } from './mechanics.js';
import { botInput } from './bots.js';

// Server-only details, not tuning.
const TEST_CODE = 'TEST';    // always running, rounds loop; join it to get a car immediately
const TEST_BOTS = 3;
const MAX_CATCHUP_TICKS = 5; // after a stall (GC, laptop sleep), drop time instead of fast-forwarding

const STEP_MS = 1000 / CONFIG.TICK_HZ;
const NO_INPUT = { seq: 0, tilt: 0, accel: false, taps: 0 };

export function createRooms(io) {
  const rooms = new Map();
  let botSeq = 1;

  // ---------------------------------------------------------------------------
  // Rooms and players
  // ---------------------------------------------------------------------------

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
      map: DEFAULT_MAP,
      state: ROOM_STATE.LOBBY,
      players: new Map(), // id -> player, in join order (the oldest human inherits host)
      game: null,         // set from countdown to the end of the results screen
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

  function addPlayer(room, id, name, isBot = false, socketId = null) {
    const p = {
      id,
      name: String(name || 'Player').slice(0, NAME_MAX),
      color: freeColor(room),
      ready: isBot,
      isBot,
      input: { ...NO_INPUT },
      socketId,                                   // the connection playing as this player
      key: isBot ? null : crypto.randomUUID(),    // rejoin secret, only ever sent to this player
      away: false,                                // connection dropped, rejoin pending
      dropTimer: null,
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
      map: room.map,
      state: room.state,
      players: [...room.players.values()].map(p => ({
        id: p.id, name: p.name, color: p.color, ready: p.ready, ...(p.isBot ? { bot: true } : {}),
      })),
    };
  }

  // Home screen list: rooms with people in them (plus TEST), joinable ones first.
  function roomList() {
    return [...rooms.values()]
      .filter(room => room.code === TEST_CODE || humans(room).length > 0)
      .map(room => ({
        code: room.code,
        host: room.players.get(room.hostId)?.name || '',
        players: room.players.size,
        humans: humans(room).length,
        max: MAX_PLAYERS,
        state: room.state,
        joinable: room.players.size < MAX_PLAYERS && (room.state === ROOM_STATE.LOBBY || room.devRoom),
        ...(room.code === TEST_CODE ? { practice: true } : {}),
      }))
      .sort((a, b) => (b.joinable - a.joinable) || (!!a.practice - !!b.practice) || (b.humans - a.humans));
  }

  function broadcastLobby(room) {
    io.to(room.code).emit(S2C.LOBBY, lobbyState(room));
  }

  function later(room, fn, ms) {
    room.timers.push(setTimeout(fn, ms));
  }

  function clearTimers(room) {
    room.timers.forEach(clearTimeout);
    room.timers = [];
  }

  // Leaving for good: LEAVE, a disconnect outside a round, or a dropped phone that didn't rejoin
  // within DISCONNECT_GRACE_MS. The oldest human left becomes host; a room with none is deleted.
  function removePlayer(room, id) {
    const p = room.players.get(id);
    if (!p) return;
    clearTimeout(p.dropTimer);
    room.players.delete(id);
    room.game?.remove(id);
    if (room.hostId === id) room.hostId = humans(room)[0]?.id ?? null;
    if (humans(room).length === 0 && room.code !== TEST_CODE) {
      clearTimers(room);
      rooms.delete(room.code);
      return;
    }
    broadcastLobby(room);
  }

  // ---------------------------------------------------------------------------
  // Round flow
  // ---------------------------------------------------------------------------

  function startCountdown(room) {
    clearTimers(room);
    room.state = ROOM_STATE.COUNTDOWN;
    for (const p of room.players.values()) p.input = { ...NO_INPUT };
    room.game = createGame([...room.players.values()], room.map);
    for (const p of room.players.values()) if (p.away) room.game.setAway(p.id, true); // still rejoining
    broadcastLobby(room);

    let s = CONFIG.COUNTDOWN_S;
    io.to(room.code).emit(S2C.COUNTDOWN, { seconds: s });
    const step = () => {
      s -= 1;
      io.to(room.code).emit(S2C.COUNTDOWN, { seconds: s });
      if (s > 0) {
        later(room, step, 1000);
      } else {
        room.state = ROOM_STATE.PLAYING;
        broadcastLobby(room);
      }
    };
    later(room, step, 1000);
  }

  function endRound(room) {
    const { game } = room;
    room.state = ROOM_STATE.ROUND_END;
    io.to(room.code).emit(S2C.SNAP, game.snapshot()); // last events (often the final KO) first

    const winnerId = game.winnerId();
    const leaderboard = [...room.players.values()].map(p => {
      const st = game.stats.get(p.id) || { kills: 0, damage: 0 };
      return {
        id: p.id,
        name: p.name,
        kills: st.kills,
        damage: Math.round(st.damage),
        score: Math.round(liveScore(st) + (p.id === winnerId ? CONFIG.SCORE_WIN : 0)),
      };
    }).sort((a, b) => b.score - a.score);

    io.to(room.code).emit(S2C.ROUND_END, { winnerId, leaderboard });
    broadcastLobby(room);
    later(room, () => nextRound(room), CONFIG.RESULTS_MS);
  }

  // After the results: TEST loops forever, other rooms go back to the lobby.
  function nextRound(room) {
    clearTimers(room);
    if (room.code === TEST_CODE) return startCountdown(room);
    room.state = ROOM_STATE.LOBBY;
    room.game = null;
    for (const p of room.players.values()) if (!p.isBot) p.ready = false;
    broadcastLobby(room);
  }

  function tickRoom(room, dt) {
    if (room.state !== ROOM_STATE.PLAYING) return;
    room.game.step(takeInputs(room), dt);
    if (room.game.over()) endRound(room);
  }

  // One input per player for this tick. Taps are consumed here, so each one counts exactly once.
  function takeInputs(room) {
    const inputs = new Map();
    for (const p of room.players.values()) {
      inputs.set(p.id, p.isBot ? botInput(room.game, p) : { ...p.input });
      p.input.taps = 0;
    }
    return inputs;
  }

  // A bug in one room must not take the server down mid-demo: log it and reset that room.
  function guard(room, fn) {
    try {
      fn();
    } catch (err) {
      console.error(`[${room.code}] crashed, resetting the round:`, err);
      nextRound(room);
    }
  }

  // Fixed timestep: the accumulator keeps the simulation at TICK_HZ even when setInterval runs late.
  // Snapshots go out from the same loop, right after a tick, SNAP_HZ times a second: a separate
  // timer drifts against this one and sends 0 ticks, then 2.
  let last = performance.now();
  let acc = 0;
  let snapAcc = 0;
  setInterval(() => {
    const t = performance.now();
    acc = Math.min(acc + t - last, STEP_MS * MAX_CATCHUP_TICKS);
    last = t;
    while (acc >= STEP_MS) {
      acc -= STEP_MS;
      for (const room of rooms.values()) guard(room, () => tickRoom(room, 1 / CONFIG.TICK_HZ));
      snapAcc += CONFIG.SNAP_HZ / CONFIG.TICK_HZ;
      if (snapAcc < 1) continue;
      snapAcc -= 1;
      for (const room of rooms.values()) {
        if (room.state !== ROOM_STATE.PLAYING && room.state !== ROOM_STATE.COUNTDOWN) continue;
        guard(room, () => io.to(room.code).emit(S2C.SNAP, room.game.snapshot()));
      }
    }
  }, STEP_MS);

  // ---------------------------------------------------------------------------
  // Sockets
  // ---------------------------------------------------------------------------

  function attach(socket) {
    // The player this socket plays as: its own id, or an earlier one it rejoined as.
    socket.data.pid = socket.id;
    const pid = () => socket.data.pid;
    const myRoom = () => rooms.get(socket.data.code);

    // Handlers get (msg, ack): msg is always an object and ack always callable, even when a
    // client sends no payload (emit(event, ack)) or garbage. A throwing handler is logged, not fatal.
    const on = (event, handler) => socket.on(event, (...args) => {
      const ack = typeof args.at(-1) === 'function' ? args.pop() : () => {};
      const msg = args[0] !== null && typeof args[0] === 'object' ? args[0] : {};
      try {
        handler(msg, ack);
      } catch (err) {
        console.error(`[${event}] from ${socket.id} failed:`, err);
      }
    });

    on(C2S.CREATE_ROOM, (msg, ack) => {
      leave(); // creating a room from inside another one leaves the old one
      const code = makeCode();
      const bots = Math.max(0, Math.min(MAX_PLAYERS - 1, Math.floor(Number(msg.bots)) || 0));
      const room = newRoom(code, pid(), bots > 0);
      const p = addPlayer(room, pid(), msg.name, false, socket.id);
      for (let i = 1; i <= bots; i++) addPlayer(room, `bot${botSeq++}`, `Bot ${i}`, true);
      socket.join(code);
      socket.data.code = code;
      ack({ code, playerId: p.id, rejoinKey: p.key });
      broadcastLobby(room);
    });

    on(C2S.JOIN_ROOM, (msg, ack) => {
      const code = String(msg.code || '').trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) return ack({ error: 'Room not found' });
      // Rejoining after a dropped connection: same player, same car. The key proves it is them
      // (player ids are public). The server may not have noticed the drop yet: retire the old socket.
      const back = room.players.get(String(msg.playerId || ''));
      if (back && !back.isBot && msg.rejoinKey === back.key) {
        const old = io.sockets.sockets.get(back.socketId);
        if (old && old !== socket) { old.data.code = undefined; old.disconnect(true); }
        leave();
        clearTimeout(back.dropTimer);
        back.away = false;
        back.socketId = socket.id;
        room.game?.setAway(back.id, false);
        socket.data.pid = back.id;
        socket.join(code);
        socket.data.code = code;
        ack({ playerId: back.id, rejoinKey: back.key });
        return broadcastLobby(room);
      }
      if (room.players.has(pid())) return ack({ playerId: pid() }); // double-tapped Join
      if (room.players.size >= MAX_PLAYERS) return ack({ error: 'Room is full' });
      const midRound = room.state !== ROOM_STATE.LOBBY;
      if (midRound && !room.devRoom) return ack({ error: 'Round in progress' });

      leave(); // only after the join is known to succeed
      const p = addPlayer(room, pid(), msg.name, false, socket.id);
      if (midRound) room.game.spawn(p);
      if (!room.hostId) room.hostId = pid();
      socket.join(code);
      socket.data.code = code;
      ack({ playerId: p.id, rejoinKey: p.key });
      broadcastLobby(room);
    });

    on(C2S.SPECTATE, (msg, ack) => {
      const room = rooms.get(String(msg.code || '').trim().toUpperCase());
      if (!room) return ack({ error: 'Room not found' });
      socket.join(room.code);
      ack({ ok: true });
      socket.emit(S2C.LOBBY, lobbyState(room));
    });

    on(C2S.READY, (msg) => {
      const room = myRoom();
      const p = room?.players.get(pid());
      if (!p) return;
      p.ready = !!msg.ready;
      broadcastLobby(room);
    });

    on(C2S.START, (_msg, ack) => {
      const room = myRoom();
      if (!room || room.hostId !== pid()) return ack({ error: 'Only the host can start' });
      if (room.state !== ROOM_STATE.LOBBY) return ack({ error: 'Already started' });
      const min = room.devRoom ? CONFIG.DEV_MIN_PLAYERS : MIN_PLAYERS;
      if (room.players.size < min) return ack({ error: `Need at least ${min} players` });
      ack({ ok: true });
      startCountdown(room);
    });

    on(C2S.INPUT, (raw) => {
      const p = myRoom()?.players.get(pid());
      if (!p) return;
      const s = sanitizeInput(raw);
      p.input = { ...s, taps: p.input.taps + s.taps }; // taps accumulate until a tick consumes them
    });

    function leave() {
      const room = myRoom();
      if (!room) return;
      socket.leave(room.code);
      socket.data.code = undefined;
      removePlayer(room, pid());
    }

    // A dropped connection during a round keeps the car as a ghost (game.setAway) for
    // DISCONNECT_GRACE_MS, so the phone can rejoin as the same player. Otherwise it leaves.
    function drop() {
      const room = myRoom();
      const p = room?.players.get(pid());
      if (!p || !room.game) return leave();
      p.away = true;
      p.input = { ...NO_INPUT };
      room.game.setAway(p.id, true);
      p.dropTimer = setTimeout(() => removePlayer(room, p.id), CONFIG.DISCONNECT_GRACE_MS);
      broadcastLobby(room);
    }
    on(C2S.LEAVE, () => leave());

    on(C2S.LIST_ROOMS, (_msg, ack) => ack({ rooms: roomList() }));

    // Host fills empty seats with bots (or takes them out) while in the lobby. Bots count toward
    // MIN_PLAYERS, so a host with fewer than 4 friends can still start.
    function hostLobby(ack) {
      const room = myRoom();
      if (!room || room.hostId !== pid()) { ack({ error: 'Only the host can change bots' }); return null; }
      if (room.state !== ROOM_STATE.LOBBY) { ack({ error: 'Bots can only change in the lobby' }); return null; }
      return room;
    }
    on(C2S.ADD_BOT, (_msg, ack) => {
      const room = hostLobby(ack);
      if (!room) return;
      if (room.players.size >= MAX_PLAYERS) return ack({ error: 'Room is full' });
      const n = [...room.players.values()].filter(p => p.isBot).length + 1;
      addPlayer(room, `bot${botSeq++}`, `Bot ${n}`, true);
      ack({ ok: true });
      broadcastLobby(room);
    });
    on(C2S.SET_MAP, (msg, ack) => {
      const room = hostLobby(ack);
      if (!room) return;
      if (!MAPS[msg.map]) return ack({ error: 'Unknown map' });
      room.map = msg.map;
      ack({ ok: true });
      broadcastLobby(room);
    });
    on(C2S.REMOVE_BOT, (_msg, ack) => {
      const room = hostLobby(ack);
      if (!room) return;
      const bot = [...room.players.values()].filter(p => p.isBot).pop(); // newest bot
      if (!bot) return ack({ error: 'No bots to remove' });
      room.players.delete(bot.id);
      ack({ ok: true });
      broadcastLobby(room);
    });
    socket.on('disconnect', drop);
  }

  // ---------------------------------------------------------------------------
  // Always-on TEST room: bots looping rounds
  // ---------------------------------------------------------------------------

  // Off unless TEST_ROOM=on: its bots use CPU nobody is watching (the free Render plan has little).
  if (process.env.TEST_ROOM === 'on') {
    const test = newRoom(TEST_CODE, null, true);
    for (let i = 1; i <= TEST_BOTS; i++) addPlayer(test, `bot${botSeq++}`, `Bot ${i}`, true);
    startCountdown(test);
  }

  return { attach, codes: () => [...rooms.keys()] };
}
