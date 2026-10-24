// server/bots.js
// Server-side players for testing alone: { bots: n } on createRoom, and the TEST room.
// Phase A (now): drive in circles like fake.js. Phase E: steer toward the nearest living car.

import { CONFIG } from '../shared/config.js';

/** This tick's input for one bot. Bots tilt at half the flip limit, so they never tip over. */
export function botInput(_game, bot) {
  bot.circleDir ??= Math.random() < 0.5 ? 1 : -1; // each bot keeps one turning direction
  return { tilt: (CONFIG.FLIP_TILT / 2) * bot.circleDir, accel: true, taps: 0 };
}
