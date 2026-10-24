// shared/protocol.js
// The contract between phones, server, and spectator.
// Frozen after the first 45 minutes. Any change: ping the whole team first.
// Imported by both /server and /client (ES modules; set "type": "module" in package.json).

// ---------------------------------------------------------------------------
// Event names (always use these constants, never raw strings)
// ---------------------------------------------------------------------------

// Client -> server
export const C2S = {
  CREATE_ROOM: 'createRoom', // { name, bots? }            ack -> { code, playerId } | { error }
  JOIN_ROOM:   'joinRoom',   // { code, name }             ack -> { playerId } | { error }
  SPECTATE:    'spectate',   // { code }                   ack -> { ok } | { error }
  SET_TEAM:    'setTeam',    // { team }                   0..3, ignored in FFA
  PICK_CAR:    'pickCar',    // { car }                    one of CARS keys
  SET_MODE:    'setMode',    // { mode }                   host only
  READY:       'ready',      // { ready }
  START:       'start',      // {}                         host only
  INPUT:       'input',      // { seq, tilt, accel, taps } 30 Hz while playing
  LEAVE:       'leave',      // {}
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

export const MODES = ['ffa', '2v2', '3v3', '4v4'];

export const ROOM_STATE = {
  LOBBY: 'lobby',
  COUNTDOWN: 'countdown',
  PLAYING: 'playing',
  ROUND_END: 'roundEnd',
};

// Car state in snapshots (numbers keep snapshots small)
export const CAR_STATE = { ALIVE: 0, FLIPPED: 1, DEAD: 2 };

export const EVENT = {
  HIT: 'hit',         // { attacker, victim, dmg }
  WALL: 'wall',       // { id, dmg }
  FLIP: 'flip',       // { id }
  RECOVER: 'recover', // { id }
  PARRY: 'parry',     // { id, attacker }
  KILL: 'kill',       // { attacker | null, victim }
};

// ---------------------------------------------------------------------------
// Shapes (JSDoc so editors autocomplete; no runtime cost)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Input            phone -> server, 30 Hz
 * @property {number} seq             increments every send
 * @property {number} tilt            -1 (full left) .. 1 (full right), already calibrated
 * @property {boolean} accel          ACCEL button held
 * @property {number} taps            taps since the previous Input (NOT a boolean)
 */

/**
 * @typedef {Object} LobbyPlayer
 * @property {string} id
 * @property {string} name
 * @property {number} team            0..3 (FFA: unique per player)
 * @property {string} car             key of CARS
 * @property {boolean} ready
 */

/**
 * @typedef {Object} LobbyState
 * @property {string} code
 * @property {string} mode            one of MODES
 * @property {string} hostId
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
 * @property {number} parry           1 while parry window is open, else 0
 * @property {number} taps            recovery taps so far (only meaningful when flipped)
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
 * @property {number} survived        seconds
 * @property {number} score
 */

/**
 * @typedef {Object} RoundEnd
 * @property {number|null} winnerTeam null on draw
 * @property {LeaderRow[]} leaderboard sorted by score, highest first
 */

// ---------------------------------------------------------------------------
// Small helpers both sides use
// ---------------------------------------------------------------------------

/** Server-side guard: never trust phone input. */
export function sanitizeInput(raw) {
  const tilt = Number(raw?.tilt);
  const taps = Math.floor(Number(raw?.taps));
  return {
    seq: Number(raw?.seq) || 0,
    tilt: Number.isFinite(tilt) ? Math.max(-1, Math.min(1, tilt)) : 0,
    accel: !!raw?.accel,
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
    parry: c.parry ? 1 : 0,
    taps: c.taps || 0,
  };
}

/** 4-letter room codes without I, L, O. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';
export const CODE_LENGTH = 4;
