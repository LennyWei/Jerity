// server/mechanics.js
// The rules from design.md section 5 as pure functions: numbers in, numbers out, no Planck
// and no state. game.js decides when a rule applies (contacts, cooldowns, car states) and
// applies the result. Speeds in m/s; vectors are plain { x, y }. Tuning lives in config.js.

import { HIT_KIND, BUFF } from '../shared/protocol.js';
import { CONFIG } from '../shared/config.js';

const dot = (a, b) => a.x * b.x + a.y * b.y;

// 1 for a hit with the nose, down to NOSE_MIN_FRAC for a hit with the side of the car.
const noseFactor = nose => CONFIG.NOSE_MIN_FRAC + (1 - CONFIG.NOSE_MIN_FRAC) * nose;

/**
 * 5.1 Car-to-car hit. n is the unit contact normal from car A to car B, fwd* are unit
 * forward vectors. Returns null (too slow to count), { type: 'headon', dmgToA, dmgToB }, or
 * { type: 'hit', attacker: 'A' | 'B', dmgToVictim, dmgToAttacker, kind }.
 */
export function carHit({ vA, vB, n, fwdA, fwdB, massA, massB }) {
  const approachA = Math.max(0, dot(vA, n));  // A's speed into B
  const approachB = Math.max(0, -dot(vB, n)); // B's speed into A
  if (Math.max(approachA, approachB) < CONFIG.MIN_IMPACT_SPEED) return null;
  const noseA = Math.max(0, dot(fwdA, n));    // 1 = A hit with its nose
  const noseB = Math.max(0, -dot(fwdB, n));

  if (noseA >= CONFIG.HEADON_THRESHOLD && noseB >= CONFIG.HEADON_THRESHOLD) {
    // Each car is hurt by the other's speed into it: a fast rammer hits hard, and a car that
    // only just started moving toward it barely hurts it back.
    return {
      type: 'headon',
      dmgToA: CONFIG.DMG_K * approachB * approachB * CONFIG.HEADON_MULT * Math.sqrt(massB / massA),
      dmgToB: CONFIG.DMG_K * approachA * approachA * CONFIG.HEADON_MULT * Math.sqrt(massA / massB),
    };
  }

  // The attacker is whoever drove into the other harder, nose first.
  const aAttacks = approachA * noseFactor(noseA) >= approachB * noseFactor(noseB);
  const approach = aAttacks ? approachA : approachB;
  const nose = aAttacks ? noseA : noseB;
  const rear = Math.max(0, aAttacks ? dot(fwdB, n) : -dot(fwdA, n)); // 1 = squarely from behind
  const massRatio = aAttacks ? massA / massB : massB / massA;
  const dmgToVictim = CONFIG.DMG_K * approach * approach * noseFactor(nose)
    * (1 + CONFIG.REAR_BONUS * rear) * Math.sqrt(massRatio);
  return {
    type: 'hit',
    attacker: aAttacks ? 'A' : 'B',
    dmgToVictim,
    dmgToAttacker: dmgToVictim * CONFIG.ATTACKER_RECOIL,
    kind: rear > CONFIG.REAR_KIND_MIN ? HIT_KIND.REAR : HIT_KIND.SIDE,
  };
}

/** 5.2 Car into a wall or pillar; impactSpeed is the speed into the surface. */
export function wallHit(impactSpeed) {
  if (impactSpeed < CONFIG.WALL_MIN_SPEED) return null;
  return { dmg: CONFIG.WALL_DMG_K * impactSpeed * impactSpeed, speedKeep: CONFIG.WALL_SPEED_KEEP };
}

/** 5.3 One tick of the tip-over timer. Returns the new held time; the car flips at FLIP_HOLD_MS. */
export function flipTick(heldMs, speed, maxSpeed, tilt, dtMs) {
  const greedy = speed >= CONFIG.FLIP_SPEED_FRAC * maxSpeed && Math.abs(tilt) >= CONFIG.FLIP_TILT;
  return greedy ? heldMs + dtMs : 0;
}

/** 5.4 What the killer gets: HP back (capped at max) and a buff for BUFF_MS. */
export function killReward(maxHp, hp) {
  return {
    heal: Math.min(maxHp - hp, Math.round(maxHp * CONFIG.KILL_HEAL_FRAC)),
    buff: CONFIG.KILL_BUFF === 'shield' ? BUFF.SHIELD : BUFF.BOOST,
  };
}

/** 5.5 Score without the win bonus (snapshot `sc`). The leaderboard adds SCORE_WIN. */
export function liveScore({ damage, kills }) {
  return damage * CONFIG.SCORE_PER_DAMAGE + kills * CONFIG.SCORE_KILL;
}
