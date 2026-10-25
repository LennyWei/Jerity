// server/bots.js
// Server-side players for testing alone: { bots: n } on createRoom (Practice), and the TEST room.
// A bot drives at the nearest living car. If that car is facing it, one of the two (the lower id)
// aims beside it instead: it swerves and the other hits its side, rather than a head-on that stuns
// (or kills) both, or two flankers circling each other forever. With the target behind it, a bot
// lets off the throttle to turn tighter. Tilt stays under BOT_TILT_MAX < FLIP_TILT: no tipping over.

import { CAR_STATE } from '../shared/protocol.js';
import { SCALE } from '../shared/constants.js';
import { CONFIG } from '../shared/config.js';

<<<<<<< Updated upstream
const IDLE = { tilt: 0, accel: false, taps: 0 };

/** This tick's input for one bot. */
export function botInput(game, bot) {
  const me = game.cars.get(bot.id);
  if (!me || me.s === CAR_STATE.DEAD) return IDLE;

  let target = null;
  let best = Infinity;
  for (const c of game.cars.values()) {
    if (c === me || c.s === CAR_STATE.DEAD) continue;
    const d = Math.hypot(c.x - me.x, c.y - me.y);
    if (d < best) { best = d; target = c; }
  }
  if (!target) return IDLE;

  // Facing us as squarely as a head-on needs? Then the lower id aims beside it, to its own right.
  let aimX = target.x;
  let aimY = target.y;
  const ux = (target.x - me.x) / (best || 1); // unit vector from us to the target
  const uy = (target.y - me.y) / (best || 1);
  const facingUs = -(Math.cos(target.a) * ux + Math.sin(target.a) * uy) >= CONFIG.HEADON_THRESHOLD;
  if (facingUs && me.id < target.id) {
    aimX += -uy * CONFIG.BOT_FLANK_DIST * SCALE; // our right, looking at the target (y points down)
    aimY += ux * CONFIG.BOT_FLANK_DIST * SCALE;
  }

  // How far the aim point is off our nose (radians, positive = to the right), as tilt.
  const off = wrapAngle(Math.atan2(aimY - me.y, aimX - me.x) - me.a);
  const tilt = Math.max(-CONFIG.BOT_TILT_MAX, Math.min(CONFIG.BOT_TILT_MAX, off * CONFIG.BOT_STEER_GAIN));
  return { tilt, accel: Math.abs(off) < Math.PI / 2, taps: 0 }; // target behind: coast, turn tighter
}

function wrapAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
=======
/** This tick's input for one bot. Bots stay at half the flip limit, so they never tip over. */
export function botInput(_game, bot) {
  bot.circleDir ??= Math.random() < 0.5 ? 1 : -1; // each bot keeps one turning direction
  if (CONFIG.DRIVE_MODE === 'omni') {
    // Omni: the tilt direction itself goes round, so the bot drives loops.
    bot.heading = (bot.heading ?? Math.random() * 2 * Math.PI) + 0.05 * bot.circleDir;
    const m = CONFIG.FLIP_TILT * 0.8;
    return { tilt: Math.cos(bot.heading) * m, throttle: -Math.sin(bot.heading) * m, taps: 0 };
  }
  return { tilt: (CONFIG.FLIP_TILT / 2) * bot.circleDir, accel: true, taps: 0 };
>>>>>>> Stashed changes
}
