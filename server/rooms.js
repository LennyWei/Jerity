// server/rooms.js
// Room lifecycle: codes, join/leave, colors, ready, host start, countdown, rounds and matches, scoring,
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
import { roundScore } from './mechanics.js';
import { botInput } from './bots.js';
import { VerityPipeline } from '../verity/verity-pipeline.js';
// Server-only details, not tuning.
const TEST_CODE = 'TEST';    // always running, matches loop; join it to get a car immediately
const TEST_BOTS = 3;
const MAX_CATCHUP_TICKS = 5; // after a stall (GC, laptop sleep), drop time instead of fast-forwarding

const BOOT_ID = crypto.randomUUID(); // new every server start: phones reset Verity when it changes
const STEP_MS = 1000 / CONFIG.TICK_HZ;
const NO_INPUT = { seq: 0, tilt: 0, accel: false, taps: 0 };

export function createRooms(io) {
  const rooms = new Map();
  let botSeq = 1;
  const verityPipelines = new Map();
  const VERITY_COOLDOWN_MS = 7000;

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
      match: null,        // { round, totals: id -> match totals } from Start to the final standings
      timers: [],
      verityBusy: false,
      verityPhase: 'idle',
      verityArguments: new Map(),
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
      ...(room.match ? { round: room.match.round, rounds: CONFIG.ROUNDS_PER_MATCH } : {}),
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
  // Round flow: Start plays a match of ROUNDS_PER_MATCH rounds, then the final standings
  // ---------------------------------------------------------------------------

  function startMatch(room) {
    room.match = { round: 0, totals: new Map() };
    startCountdown(room);
  }

  /** Over after the last round, or early when fewer than 2 players are left to play one. */
  function matchOver(room) {
    return !room.match || room.match.round >= CONFIG.ROUNDS_PER_MATCH || room.players.size < 2;
  }

  function startCountdown(room) {
    clearTimers(room);
    room.match.round += 1;
    room.state = ROOM_STATE.COUNTDOWN;
    for (const p of room.players.values()) p.input = { ...NO_INPUT };
    room.game = createGame([...room.players.values()], room.map);
    verityPipelines.set(room.code, new VerityPipeline());
    room.verityBusy = false;
    room.verityPhase = 'idle';
    room.verityArguments.clear();
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
      const row = {
        id: p.id,
        name: p.name,
        kills: st.kills,
        damage: Math.round(st.damage),
        survived: Math.round(game.survivedS(p.id) * 10) / 10,
      };
      const won = p.id === winnerId;
      row.score = Math.round(roundScore({ ...row, won }));
      addToMatch(room.match, row, won);
      return row;
    }).sort((a, b) => b.score - a.score);

    const final = matchOver(room);
    io.to(room.code).emit(S2C.ROUND_END, {
      winnerId, leaderboard,
      round: room.match.round, rounds: CONFIG.ROUNDS_PER_MATCH, final, match: standings(room),
    });
    broadcastLobby(room);
    later(room, () => nextRound(room), final ? CONFIG.MATCH_RESULTS_MS : CONFIG.RESULTS_MS);
  }

  const NO_TOTALS = { wins: 0, kills: 0, damage: 0, survived: 0, score: 0 };

  function addToMatch(match, row, won) {
    const t = match.totals.get(row.id) || NO_TOTALS;
    match.totals.set(row.id, {
      wins: t.wins + (won ? 1 : 0),
      kills: t.kills + row.kills,
      damage: t.damage + row.damage,
      survived: t.survived + row.survived,
      score: t.score + row.score,
    });
  }

  /** Everyone still in the room, by performance score (the round scores summed); ties: wins, KOs, damage. */
  function standings(room) {
    return [...room.players.values()].map(p => {
      const t = room.match.totals.get(p.id) || NO_TOTALS;
      return { id: p.id, name: p.name, ...t, survived: Math.round(t.survived * 10) / 10 };
    }).sort((a, b) => (b.score - a.score) || (b.wins - a.wins) || (b.kills - a.kills) || (b.damage - a.damage));
  }

  // After the results: the match's next round. After the last one, the lobby (TEST starts a new match).
  function nextRound(room) {
    clearTimers(room);
    if (!matchOver(room)) return startCountdown(room);
    if (room.code === TEST_CODE) return startMatch(room);
        room.state = ROOM_STATE.LOBBY;
    room.game = null;
    verityPipelines.delete(room.code);
    room.match = null;
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
    socket.emit(S2C.HELLO, { bootId: BOOT_ID });
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
      startMatch(room);
    });
        // Player sends an argument to Jerity
    on('verityArgument', async (msg, ack) => {
      const room = myRoom();
      const p = room?.players.get(pid());

      if (!room || !p || p.isBot || p.away ||
          room.state !== ROOM_STATE.PLAYING || !room.game) {
        return ack({ error: 'Join an active game first' });
      }

      const text = typeof msg.text === 'string'
        ? msg.text.trim().slice(0, 500)
        : '';

      if (!text) {
        return ack({ error: 'Enter an argument' });
      }

      if (room.verityBusy) {
        return ack({ error: 'Jerity is already deciding' });
      }

      if (Date.now() - room.lastVerityAt < VERITY_COOLDOWN_MS) {
        return ack({ error: 'Wait before asking Jerity again' });
      }

      const game = room.game;
      const pipeline = verityPipelines.get(room.code);

      if (!pipeline) {
        return ack({ error: 'Jerity is not ready' });
      }

      room.verityBusy = true;
      room.lastVerityAt = Date.now();

      ack({ ok: true });

      try {
        const players = Object.fromEntries(
          [...game.cars].map(([id, car]) => [
            id,
            {
              hp: car.hp,
              maxHp: car.maxHp,
              name: room.players.get(id)?.name || id,
            }
          ])
        );

        const result = await pipeline.runCycleSimulated(
          { players },
          [{ playerId: p.id, text }],
          { skipTts: true }
        );

        // Make sure the same round is still running
        if (room.game !== game ||
            room.state !== ROOM_STATE.PLAYING) {
          return;
        }

        const applied = [];

        for (const event of result.events || []) {
          if (!event || event.action === 'none') continue;

          const targetValue = event.target;

          const targets = Array.isArray(targetValue)
            ? targetValue
            : [targetValue];

          const action = {
            action: event.action,
            target: targets[0],
            target2: targets[1],
          };

          // Auto-kill needs a trusted persuasion score
          if (action.action === 'auto_kill') continue;

          if (game.applyJerityAction(action)) {
            applied.push(event);
          }
        }

        io.to(room.code).emit('verityRuling', {
          speakerId: p.id,
          events: applied,
          voiceLines: result.voiceLines || [],
        });

      } catch (err) {
        console.error(`[${room.code}] Jerity failed:`, err);

        socket.emit('verityError', {
          message: 'Jerity could not process that argument',
        });

      } finally {
        room.verityBusy = false;
      }
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
  // Always-on TEST room: bots looping matches
  // ---------------------------------------------------------------------------

  // Off unless TEST_ROOM=on: its bots use CPU nobody is watching (the free Render plan has little).
  if (process.env.TEST_ROOM === 'on') {
    const test = newRoom(TEST_CODE, null, true);
    for (let i = 1; i <= TEST_BOTS; i++) addPlayer(test, `bot${botSeq++}`, `Bot ${i}`, true);
    startMatch(test);
  }

  return { attach, codes: () => [...rooms.keys()] };
}
