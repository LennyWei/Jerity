// shared/config.js
// Every tunable number. Person 1 owns this file (took over tuning from Person 3).
// Nobody hardcodes these elsewhere.
// Speeds in m/s (Planck units), times in ms unless the name says S.

export const CONFIG = {
  // Loop
  TICK_HZ: 30,
  SNAP_HZ: 30,           // = TICK_HZ: every tick goes out, sent right after it (rooms.js)
  INPUT_HZ: 30,
  INTERP_DELAY_MS: 100,  // 3 snapshots at 30 Hz (was 150 at 20 Hz; 100 at 20 Hz jittered: Person 2)
  SNAP_CLOCK_SLACK_MS: 150, // snapshot stamps follow simulation time; if it falls this far behind the clock (countdown, stall), they catch up

  // Driving mode. 'omni': tilt the phone the way you want to go on screen (like a marble on a
  // tray); the car's nose turns to face where it is going. 'car': roll steers, tip drives.
  DRIVE_MODE: 'omni',
  OMNI_ACCEL: 16,         // m/s^2: speeding up (or braking) toward the speed your tilt asks for: the weight
  OMNI_TURN_RATE: 6,      // rad/s: fastest the direction of travel swings toward the tilt (a turn is an arc at full speed)
  OMNI_TURN_GAIN: 10,     // ...and how it eases in: swing rate = this * angle still to go, up to OMNI_TURN_RATE
  OMNI_ARC_MIN_SPEED: 1.5, // m/s: below this there is no direction to swing, so tilt pushes straight that way
  OMNI_COAST_DAMPING: 3.5, // friction with the phone level: rolls to a stop instead of gliding (half speed every 0.2 s)
  OMNI_FACE_GAIN: 14,     // how quickly the nose turns to face the direction of travel
  OMNI_FLIP_ANGLE_DEG: 60, // omni tip-over: yanking at least this far off your direction of travel...
  OMNI_FLIP_SPEED_FRAC: 0.7, // ...while above this fraction of top speed (swinging bleeds speed, so lower than FLIP_SPEED_FRAC)
  OMNI_TILT_DEG: 18,      // phone tilt (from the calibrated grip) for full speed in that direction
  OMNI_DEADZONE: 0.2,     // fraction of OMNI_TILT_DEG (3.6 deg) that counts as no tilt, in any direction

  // Driving
  MIN_SPEED: 4,          // instant launch speed when ACCEL is pressed
  ENGINE: 6,             // forward accel per unit mass while ACCEL held
  GRIP: 0.9,             // fraction of sideways velocity removed per tick
  COAST_DAMPING: 1.2,    // linear damping when the throttle is centered (also while stunned)
  BRAKE: 14,             // m/s^2 when tilting back while still rolling forward
  REVERSE_ENGINE: 5,     // m/s^2 backwards once stopped
  REVERSE_MAX_SPEED: 5,  // reverse is for backing out of trouble, not for racing
  ANGULAR_DAMPING: 3,    // spin decay while nobody steers the car (stunned or flipped)
  CAR_RESTITUTION: 0.5,

  // Car-to-car damage (faster = more damage; nose into side/rear beats head-on)
  DMG_K: 0.36,           // damage = DMG_K * impactSpeed^2 * modifiers (full-speed side ram ~71, rear ~92: no one-shots)
  MIN_IMPACT_SPEED: 2,   // ignore bumps slower than this
  HIT_COOLDOWN_MS: 300,  // per pair, so one crunch counts once
  REAR_BONUS: 0.3,       // rear hits deal up to +30% over side hits
  NOSE_MIN_FRAC: 0.3,    // hitting with your side instead of your nose still deals 30%
  REAR_KIND_MIN: 0.5,    // how square from behind a hit must be to count as 'rear'
  ATTACKER_RECOIL: 0.1,  // attacker takes 10% of what it deals on a side/rear hit
  HEADON_THRESHOLD: 0.7, // both noses this aligned with the hit = head-on
  HEADON_MULT: 0.35,     // head-on: each car takes DMG_K * (the other car's speed into it)^2 * this
  CONCUSSION_MS: 1500,   // head-on stun: no control for both cars
  FLIPPED_DMG_MULT: 1.5, // flipped cars are easy prey
  KILL_CREDIT_MS: 3000,  // wall death within this of being hit credits the hitter

  // Knockback: a hit that counts pushes both cars apart along the hit and takes away their
  // throttle and grip for a moment, so they separate instead of grinding or sliding along each other.
  KNOCKBACK_SPEED: 5,         // m/s apart for each car after a side or rear hit
  HEADON_KNOCKBACK_SPEED: 8,  // m/s apart after a head-on: far enough to steer past each other after the stun
  KNOCKBACK_MS: 300,          // no control at all (throttle, grip, steering) for this long after a knockback
  KNOCKBACK_SPIN: 1.3,        // rad/s spin from a knockback; dies out at ANGULAR_DAMPING (about 25 deg in all)

  // Tip-over (greedy full speed + full steering)
  FLIP_SPEED_FRAC: 0.95, // at (nearly) full speed: at or above this fraction of max speed...
  FLIP_TILT: 0.95,       // ...with (nearly) full steering, |tilt| at or above this...
  FLIP_HOLD_MS: 2500,    // ...held this long = flip (rare on purpose, for balance)
  FLIPPED_DAMPING: 8,    // flipped car slides to a stop
  RECOVER_TAPS: 8,       // taps to get back up
  RECOVER_INVULN_MS: 1000,

  // Walls and obstacles (lose speed + small self-damage)
  WALL_RESTITUTION: 0.3,
  OBSTACLE_RESTITUTION: 0.8,
  WALL_MIN_SPEED: 5,     // slower touches are free (above the 4 m/s launch, so pressing on a wall costs nothing)
  WALL_PRESS_MS: 1000,   // a bump this soon after the car's last wall bump is pressing against it, not a crash: no HP
  WALL_KNOCKBACK_SPEED: 2, // m/s off a wall or pillar after any bump of MIN_IMPACT_SPEED or more, so holding accel bounces instead of grinding
  WALL_SPEED_KEEP: 0.35, // keep 35% of speed after a hit
  WALL_DMG_K: 0.08,      // self-damage = WALL_DMG_K * impactSpeed^2 (about 16 HP at full speed)

  // Kill reward
  KILL_HEAL_FRAC: 0.3,   // killer restores 30% of max HP
  KILL_BUFF: 'boost',    // 'boost' (more acceleration and top speed) or 'shield' (immune to damage)
  BUFF_MS: 4000,
  BOOST_ENGINE_MULT: 1.6,
  BOOST_SPEED_MULT: 1.15,

  // Rounds and scoring (FFA: last car alive wins)
  COUNTDOWN_S: 4,
  FIRST_COUNTDOWN_S: 8,  // a match's first round: new players read the tips on the countdown screen
  ROUND_TIME_S: 120,     // on timeout, highest HP wins
  ROUNDS_PER_MATCH: 5,   // Start plays this many rounds; the final standings rank by performance score
  VICTORY_LAP_MS: 5000,  // round decided: the arena keeps running (no damage) under the win splash, then the results
  RESULTS_MS: 6000,      // between rounds: the standings (the win splash already played during the lap), then the next round
  VICTORY_SPLASH_MS: 2600, // "[trophy] Name Won!" when no lap showed it (the final's match winner, older servers)
  MATCH_RESULTS_MS: 15000, // final standings after the last round, then back to the lobby (TEST room: a new match)
  DEV_MIN_PLAYERS: 1,    // used when the room was created with bots
  DISCONNECT_GRACE_MS: 15000, // a dropped phone keeps its car (a frozen ghost) this long to rejoin
  SCORE_PER_DAMAGE: 1,   // 1 point per HP dealt to other players
  SCORE_KILL: 100,
  SCORE_WIN: 150,        // last car alive (or highest HP on timeout)
  SCORE_PER_SURVIVAL_S: 2, // per second still in the round (alive at 45 s = 90). Performance score = all round scores summed

  // Server bots (testing alone and the TEST room)
  BOT_TILT_MAX: 0.7,     // below FLIP_TILT, so bots never tip over
  BOT_STEER_GAIN: 2,     // tilt per radian off target (full lock at 20 degrees off)
  BOT_FLANK_DIST: 4,     // m: when the target faces the bot, aim this far beside it (swing into its side, not a head-on)
  BOT_TURN_EASE: 0.3,    // omni bots tilt this fraction as hard while the target is behind them: slow down to turn around

  // Phone tilt. Measured as how far the phone's long edge tilts from level, which works for
  // a steering-wheel grip and a flat controller grip alike (see wheelAngle in input.js).
  // (Replaces TILT_MAX_G, which needed 45-60 deg in practice.)
  TILT_MAX_DEG: 30,      // tilt that counts as full lock (iPhones auto-rotate around 45)
  TILT_DEADZONE: 0.12,   // fraction of TILT_MAX_DEG (3.6 deg) that counts as straight, so hand shake doesn't steer
  TILT_EXPO: 1.5,        // response curve: 10 deg -> about 12-25% turn depending on grip, 30 deg full lock
  TILT_SIGN_IOS: 1,      // set to -1 if tilting right steers left on iPhone (client/public/tilt-test.html)
  TILT_SIGN_ANDROID: 1,  // same check on Android

  // Throttle from tilting the phone forward (top edge away from you) or back, measured from
  // the calibrated grip like steering. Bigger deadzone than steering: turning nudges it a bit.
  THROTTLE_DEADZONE_DEG: 6,
  THROTTLE_FWD_DEG: 22,  // forward tilt (from the calibrated grip) for full throttle
  THROTTLE_BACK_DEG: 16, // back tilt for full reverse

  // Shake to recover: while flipped, the phone sends each shake as a tap (client only).
  // From a motion simulation: a light 4 Hz shake recovers in ~1 s; steering never triggers it.
  SHAKE_ACCEL: 11,       // m/s^2 without gravity; one count per push
  SHAKE_GAP_MS: 100,
};
