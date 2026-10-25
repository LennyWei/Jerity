// server/bots.js
// Server-side players for testing alone: { bots: n } on createRoom (Practice), and the TEST room.
// A bot drives at the nearest living car. If that car is facing it, one of the two (the lower id)
// aims beside it instead: it swerves and the other hits its side, rather than a head-on that stuns
// (or kills) both, or two flankers circling each other forever. With the target behind it, a bot
// lets off the throttle to turn tighter. Tilt stays under BOT_TILT_MAX < FLIP_TILT: no tipping over.

import { CAR_STATE } from '../shared/protocol.js';
import { SCALE } from '../shared/constants.js';
import { CONFIG } from '../shared/config.js';

const IDLE = { tilt: 0, accel: false, taps: 0 };

/** This tick's input for one bot. */
export function botInput(game, bot) {
  const me = game.cars.get(bot.id);
  if (!me || me.s === CAR_STATE.DEAD) return IDLE;

  let target = null;
  let best = Infinity;
  for (const c of game.cars.values()) {
    if (c === me || c.s === CAR_STATE.DEAD || c.s === CAR_STATE.DISCONNECTED) continue; // nothing to hit
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

  // Omni (DRIVE_MODE): tilt straight toward the aim point, up the screen = +throttle. Target
  // behind: tilt gently so the car slows and turns tighter, or two bots just circle each other.
  if (CONFIG.DRIVE_MODE === 'omni') {
    const dx = aimX - me.x, dy = aimY - me.y, d = Math.hypot(dx, dy) || 1;
    const behind = Math.abs(wrapAngle(Math.atan2(dy, dx) - me.a)) > Math.PI / 2;
    const k = CONFIG.BOT_TILT_MAX * (behind ? CONFIG.BOT_TURN_EASE : 1);
    return { tilt: (dx / d) * k, throttle: (-dy / d) * k, taps: 0 };
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
}
