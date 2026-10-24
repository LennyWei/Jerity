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
  COAST_DAMPING: 1.2,    // linear damping when ACCEL released (also while stunned)
  CAR_RESTITUTION: 0.5,

  // Car-to-car damage (faster = more damage; nose into side/rear beats head-on)
  DMG_K: 0.6,            // damage = DMG_K * impactSpeed^2 * modifiers
  MIN_IMPACT_SPEED: 2,   // ignore bumps slower than this
  HIT_COOLDOWN_MS: 300,  // per pair, so one crunch counts once
  REAR_BONUS: 0.3,       // rear hits deal up to +30% over side hits
  ATTACKER_RECOIL: 0.1,  // attacker takes 10% of what it deals on a side/rear hit
  HEADON_THRESHOLD: 0.7, // both noses this aligned with the hit = head-on
  HEADON_MULT: 0.35,     // head-on: each car takes DMG_K * closingSpeed^2 * this
  CONCUSSION_MS: 1500,   // head-on stun: no control for both cars
  FLIPPED_DMG_MULT: 1.5, // flipped cars are easy prey
  KILL_CREDIT_MS: 3000,  // wall death within this of being hit credits the hitter

  // Tip-over (greedy full speed + full steering)
  FLIP_SPEED_FRAC: 0.85, // at or above this fraction of max speed...
  FLIP_TILT: 0.85,       // ...with |tilt| at or above this...
  FLIP_HOLD_MS: 400,     // ...held this long = flip
  FLIPPED_DAMPING: 8,    // flipped car slides to a stop
  RECOVER_TAPS: 8,       // taps to get back up
  RECOVER_INVULN_MS: 1000,

  // Walls and obstacles (lose speed + small self-damage)
  WALL_RESTITUTION: 0.3,
  OBSTACLE_RESTITUTION: 0.8,
  WALL_MIN_SPEED: 3,     // slower touches are free
  WALL_SPEED_KEEP: 0.35, // keep 35% of speed after a hit
  WALL_DMG_K: 0.08,      // self-damage = WALL_DMG_K * impactSpeed^2 (about 16 HP at full speed)

  // Kill reward
  KILL_HEAL_FRAC: 0.3,   // killer restores 30% of max HP
  KILL_BUFF: 'boost',    // 'boost' (more acceleration and top speed) or 'shield' (immune to damage)
  BUFF_MS: 4000,
  BOOST_ENGINE_MULT: 1.6,
  BOOST_SPEED_MULT: 1.15,

  // Rounds and scoring (FFA: last car alive wins)
  COUNTDOWN_S: 3,
  ROUND_TIME_S: 120,     // on timeout, highest HP wins
  DEV_MIN_PLAYERS: 1,    // used when the room was created with bots
  DISCONNECT_GRACE_MS: 5000,
  SCORE_PER_DAMAGE: 1,   // 1 point per HP dealt to other players
  SCORE_KILL: 100,
  SCORE_WIN: 150,

  // Phone tilt
  TILT_MAX_G: 6,         // m/s^2 on the steering axis that counts as full lock (~37 degrees)
  TILT_DEADZONE: 0.08,
};
