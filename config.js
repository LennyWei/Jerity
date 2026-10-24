// shared/config.js
// Every tunable number. Person 3 owns this file. Nobody hardcodes these elsewhere.
// Speeds in m/s (Planck units), times in ms unless the name says S.

export const CONFIG = {
  // Loop
  TICK_HZ: 30,
  SNAP_HZ: 20,
  INPUT_HZ: 30,
  INTERP_DELAY_MS: 100,

  // Driving
  MIN_SPEED: 4,          // instant launch speed when ACCEL is pressed
  ENGINE: 6,             // forward accel per unit mass while ACCEL held
  GRIP: 0.9,             // fraction of sideways velocity removed per tick
  COAST_DAMPING: 1.2,    // linear damping when ACCEL released
  CAR_RESTITUTION: 0.5,

  // Car-to-car damage
  DMG_K: 0.6,
  MIN_IMPACT_SPEED: 2,
  HIT_COOLDOWN_MS: 300,
  FLIPPED_DMG_MULT: 1.5,
  KILL_CREDIT_MS: 3000,

  // Tip-over
  FLIP_LOAD: 30,         // speed * |angularVelocity|
  FLIP_HOLD_MS: 250,
  FLIPPED_DAMPING: 8,
  RECOVER_TAPS: 10,
  RECOVER_INVULN_MS: 1000,

  // Parry (stretch)
  PARRY_ENABLED: true,
  PARRY_WINDOW_MS: 150,
  PARRY_COOLDOWN_MS: 5000,
  PARRY_REFLECT: 0.5,

  // Walls and obstacles
  WALL_RESTITUTION: 0.3,
  OBSTACLE_RESTITUTION: 0.8,
  WALL_MIN_SPEED: 3,
  WALL_SPEED_KEEP: 0.35,
  WALL_DMG: 8,

  // Rounds and scoring
  COUNTDOWN_S: 3,
  ROUND_TIME_S: 120,
  MIN_PLAYERS: 4,
  DEV_MIN_PLAYERS: 1,    // used when the room was created with bots
  DISCONNECT_GRACE_MS: 5000,
  SCORE_KILL: 100,
  SCORE_PER_SECOND: 1,
  SCORE_WIN: 150,

  // Phone tilt
  TILT_MAX_G: 6,         // m/s^2 on the steering axis that counts as full lock (~37 degrees)
  TILT_DEADZONE: 0.08,
};
