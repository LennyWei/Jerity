// shared/protocol.js
// The contract between phones, server, and spectator.
// MVP scope: FFA only, 4 to 8 players. Team modes, car picking, parry, and items are post-MVP.
// Any change to this file: ping the whole team first.
// Imported by both /server and /client (ES modules; "type": "module" in package.json).

// ---------------------------------------------------------------------------
// Event names (always use these constants, never raw strings)
// ---------------------------------------------------------------------------

// Client -> server
export const C2S = {
  CREATE_ROOM: 'createRoom', // { name, bots? }            ack -> { code, playerId } | { error }
  JOIN_ROOM:   'joinRoom',   // { code, name }             ack -> { playerId } | { error }
  SPECTATE:    'spectate',   // { code }                   ack -> { ok } | { error }
  READY:       'ready',      // { ready }
  START:       'start',      // {}                         host only, ack -> { ok } | { error }
  INPUT:       'input',      // { seq, tilt, throttle, accel, taps } 30 Hz while playing
  LEAVE:       'leave',      // {}
  LIST_ROOMS:  'listRooms',  // {}                         ack -> { rooms: RoomInfo[] } (home screen list)
  ADD_BOT:     'addBot',     // {}                         host only, in the lobby, ack -> { ok } | { error }
  REMOVE_BOT:  'removeBot',  // {}                         host only, in the lobby: removes the newest bot
};

// Server -> client
export const S2C = {
  LOBBY:     'lobby',     // LobbyState
  COUNTDOWN: 'countdown', // { seconds }
  SNAP:      'snap',      // Snapshot
  ROUND_END: 'roundEnd',  // RoundEnd
  ERROR:     'err',       // { message }
};

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const ROOM_STATE = {
  LOBBY: 'lobby',
  COUNTDOWN: 'countdown',
  PLAYING: 'playing',
  ROUND_END: 'roundEnd',
};

// Car state in snapshots (numbers keep snapshots small)
export const CAR_STATE = {
  ALIVE: 0,    // full control
  FLIPPED: 1,  // tipped over: no control until RECOVER_TAPS taps
  DEAD: 2,
  STUNNED: 3,  // concussed after a head-on hit: no control for CONCUSSION_MS
};

// Buff from getting a kill (snapshot field `buff`)
export const BUFF = { NONE: 0, BOOST: 1, SHIELD: 2 };

// Hit direction relative to the victim (event field `kind`)
export const HIT_KIND = { SIDE: 'side', REAR: 'rear' };

export const EVENT = {
  HIT: 'hit',         // { attacker, victim, dmg, kind }        nose into side or rear
  HEADON: 'headon',   // { a, b, dmg, stunMs }                  both take dmg, both stunned
  WALL: 'wall',       // { id, dmg }                            wall or obstacle self-damage
  FLIP: 'flip',       // { id }
  RECOVER: 'recover', // { id }
  KILL: 'kill',       // { attacker | null, victim, heal, buff } heal = HP restored to attacker
};

// ---------------------------------------------------------------------------
// Shapes (JSDoc so editors autocomplete; no runtime cost)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Input            phone -> server, 30 Hz
 * @property {number} seq             increments every send
 * @property {number} tilt            -1 (full left) .. 1 (full right), already calibrated
 * @property {number} [throttle]      -1 (full reverse) .. 1 (full forward), from tilting the phone
 *                                    forward/back. Optional: without it, accel means full forward.
 * @property {boolean} accel          driving forward (throttle > 0); kept for bots and older clients
 * @property {number} taps            taps since the previous Input (NOT a boolean); used to recover from a flip
 */

/**
 * @typedef {Object} LobbyPlayer
 * @property {string} id
 * @property {string} name
 * @property {number} color           index into PLAYER_COLORS, unique in the room
 * @property {boolean} ready
 * @property {boolean} [bot]           a server bot (hosts can add / remove them in the lobby)
 */

/**
 * @typedef {Object} RoomInfo          one row of the home screen's open-rooms list
 * @property {string} code
 * @property {string} host             host's name ('' if none)
 * @property {number} players          including bots
 * @property {number} humans
 * @property {number} max              MAX_PLAYERS
 * @property {string} state            one of ROOM_STATE
 * @property {boolean} joinable        not full, and in the lobby (or a practice room, which takes
 *                                     players mid-round)
 * @property {boolean} [practice]      the always-on TEST room
 */

/**
 * @typedef {Object} LobbyState
 * @property {string} code
 * @property {string|null} hostId
 * @property {string} state           one of ROOM_STATE
 * @property {LobbyPlayer[]} players
 */

/**
 * @typedef {Object} CarSnap
 * @property {string} id
 * @property {number} x               world units, 1 decimal
 * @property {number} y
 * @property {number} a               angle in radians, 2 decimals (0 = facing +x)
 * @property {number} hp              integer
 * @property {number} s               CAR_STATE
 * @property {number} taps            recovery taps so far (only meaningful when flipped)
 * @property {number} buff            BUFF
 * @property {number} sc              live score
 */

/**
 * @typedef {Object} Snapshot         server -> everyone in room, 20 Hz
 * @property {number} t               server time in ms
 * @property {CarSnap[]} cars
 * @property {Object[]} events        EVENT objects since the last snapshot, each with a `type`
 * @property {number} timeLeft        seconds left in the round
 */

/**
 * @typedef {Object} LeaderRow
 * @property {string} id
 * @property {string} name
 * @property {number} kills
 * @property {number} damage          total damage dealt to other players
 * @property {number} score
 */

/**
 * @typedef {Object} RoundEnd
 * @property {string|null} winnerId    last car alive (or highest HP on timeout); null on draw
 * @property {LeaderRow[]} leaderboard sorted by score, highest first
 */

// ---------------------------------------------------------------------------
// Small helpers both sides use
// ---------------------------------------------------------------------------

/** Server-side guard: never trust phone input. */
export function sanitizeInput(raw) {
  const tilt = Number(raw?.tilt);
  const taps = Math.floor(Number(raw?.taps));
  const thr = Number(raw?.throttle);
  const throttle = Number.isFinite(thr) ? Math.max(-1, Math.min(1, thr)) : raw?.accel ? 1 : 0;
  return {
    seq: Number(raw?.seq) || 0,
    tilt: Number.isFinite(tilt) ? Math.max(-1, Math.min(1, tilt)) : 0,
    throttle,
    accel: throttle > 0,
    taps: Number.isFinite(taps) ? Math.max(0, Math.min(20, taps)) : 0,
  };
}

/** Round a car snapshot so the payload stays small. */
export function packCar(c) {
  return {
    id: c.id,
    x: Math.round(c.x * 10) / 10,
    y: Math.round(c.y * 10) / 10,
    a: Math.round(c.a * 100) / 100,
    hp: Math.max(0, Math.round(c.hp)),
    s: c.s,
    taps: c.taps || 0,
    buff: c.buff || 0,
    sc: Math.round(c.sc || 0),
  };
}

/** 4-letter room codes without I, L, O. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';
export const CODE_LENGTH = 4;
