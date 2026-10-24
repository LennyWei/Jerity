// server/game.js
// One round: cars, driving, damage, deaths, kill rewards, events, and snapshots.
// No sockets here. rooms.js makes a game per round, calls step() at TICK_HZ with one input
// per player, and broadcasts snapshot() at SNAP_HZ. sim.js drives the same object headless.
//
// Phase A (now): the stand-in physics from fake.js. Cars move kinematically and pass through
// each other, and car-to-car hits are random. Phase B swaps stepCar for a Planck world and
// Phase C swaps fakeEvents for real contacts; the rest of this file stays.
//
// Timers use simulation time (`now`, ms since the round started), not Date.now(), so a
// headless run plays out exactly like a live one.

import { CAR_STATE, EVENT, BUFF, HIT_KIND, packCar } from '../shared/protocol.js';
import {
  ARENA, SCALE, CAR_SIZE, OBSTACLES, SPAWN_RADIUS, CARS, DEFAULT_CAR,
} from '../shared/constants.js';
import { CONFIG } from '../shared/config.js';

const NO_INPUT = { tilt: 0, accel: false, taps: 0 };

/** Score without the win bonus (snapshot `sc`). The leaderboard adds SCORE_WIN. */
export function liveScore(st) {
  return st.damage * CONFIG.SCORE_PER_DAMAGE + st.kills * CONFIG.SCORE_KILL;
}

/** players: [{ id }] in spawn order. */
export function createGame(players) {
  const cars = new Map();   // id -> car; dead cars stay so clients can draw the wreck and the KO
  const stats = new Map();  // id -> { kills, damage } for this round
  const events = [];        // EVENT objects since the last snapshot
  let now = 0;
  let timeLeft = CONFIG.ROUND_TIME_S;
  let lastSnapT = 0;
  let nextFakeHit = 2000;     // stand-in hit timers, removed in Phase C
  let nextFakeHeadon = 7000;

  players.forEach((p, i) => addCar(p.id, (2 * Math.PI * i) / players.length));

  // ---------------------------------------------------------------------------
  // Round API (rooms.js and sim.js)
  // ---------------------------------------------------------------------------

  /** inputs: Map id -> { tilt, accel, taps } for this tick. A car without one coasts. */
  function step(inputs, dt) {
    now += dt * 1000;
    for (const car of cars.values()) {
      if (car.s !== CAR_STATE.DEAD) stepCar(car, inputs.get(car.id) || NO_INPUT, dt);
    }
    fakeEvents();
    timeLeft -= dt;
  }

  function snapshot() {
    // Clients order snapshots by t and drop any that go backwards, so never repeat one.
    lastSnapT = Math.max(Date.now(), lastSnapT + 1);
    return {
      t: lastSnapT,
      cars: [...cars.values()].map(c => packCar({ ...c, sc: liveScore(stats.get(c.id)) })),
      events: events.splice(0),
      timeLeft: Math.max(0, Math.ceil(timeLeft)),
    };
  }

  /** Mid-round join (bot rooms only): a random spot on the spawn circle. */
  function spawn(p) {
    addCar(p.id, Math.random() * 2 * Math.PI);
  }

  function remove(id) {
    cars.delete(id);
  }

  /** One car left (flipped and stunned still count), or time is up. A lone car plays to the timer. */
  function over() {
    return timeLeft <= 0 || (cars.size > 1 && aliveCars().length <= 1);
  }

  /** Last car alive; on timeout the highest HP; null when nobody is left. */
  function winnerId() {
    return aliveCars().sort((a, b) => b.hp - a.hp)[0]?.id ?? null;
  }

  // ---------------------------------------------------------------------------
  // Cars
  // ---------------------------------------------------------------------------

  // On the spawn circle at angle `ang`, facing the center.
  function addCar(id, ang) {
    const spec = CARS[DEFAULT_CAR]; // MVP: everyone drives balanced
    cars.set(id, {
      id,
      x: ARENA.W / 2 + SPAWN_RADIUS * Math.cos(ang),
      y: ARENA.H / 2 + SPAWN_RADIUS * Math.sin(ang),
      a: wrapAngle(ang + Math.PI),
      speed: 0,                 // world units / s
      hp: spec.hp,
      maxHp: spec.hp,
      s: CAR_STATE.ALIVE,
      taps: 0,
      flipHeldMs: 0,
      stunUntil: 0,
      invulnUntil: 0,
      buff: BUFF.NONE,
      buffUntil: 0,
      lastAttacker: null,
      lastHitAt: 0,
    });
    stats.set(id, { kills: 0, damage: 0 });
  }

  function aliveCars() {
    return [...cars.values()].filter(c => c.s !== CAR_STATE.DEAD);
  }

  // ---------------------------------------------------------------------------
  // Damage, death, kill reward (design.md section 5)
  // ---------------------------------------------------------------------------

  function canTakeDamage(car) {
    if (car.s === CAR_STATE.DEAD) return false;
    if (now < car.invulnUntil) return false;
    if (car.buff === BUFF.SHIELD && now < car.buffUntil) return false;
    return true;
  }

  // Returns damage actually dealt.
  function applyDamage(victim, dmg, attackerId) {
    if (!canTakeDamage(victim)) return 0;
    const mult = victim.s === CAR_STATE.FLIPPED ? CONFIG.FLIPPED_DMG_MULT : 1;
    const dealt = Math.min(victim.hp, Math.round(dmg * mult));
    victim.hp -= dealt;
    if (attackerId && attackerId !== victim.id) {
      victim.lastAttacker = attackerId;
      victim.lastHitAt = now;
      const st = stats.get(attackerId);
      if (st) st.damage += dealt;
    }
    return dealt;
  }

  function checkDeath(car) {
    if (car.hp > 0 || car.s === CAR_STATE.DEAD) return;
    car.hp = 0;
    car.s = CAR_STATE.DEAD;
    car.speed = 0;

    const creditOk = car.lastAttacker && now - car.lastHitAt <= CONFIG.KILL_CREDIT_MS;
    const killerId = creditOk ? car.lastAttacker : null;
    const killer = killerId && cars.get(killerId);
    let heal = 0;
    let buff = BUFF.NONE;
    if (killerId) stats.get(killerId).kills += 1;
    if (killer && killer.s !== CAR_STATE.DEAD) {
      heal = Math.min(killer.maxHp - killer.hp, Math.round(killer.maxHp * CONFIG.KILL_HEAL_FRAC));
      killer.hp += heal;
      buff = CONFIG.KILL_BUFF === 'shield' ? BUFF.SHIELD : BUFF.BOOST;
      killer.buff = buff;
      killer.buffUntil = now + CONFIG.BUFF_MS;
    }
    events.push({ type: EVENT.KILL, attacker: killerId, victim: car.id, heal, buff });
  }

  // ---------------------------------------------------------------------------
  // Stand-in physics from fake.js (Phase B: Planck world, Phase C: real contacts)
  // ---------------------------------------------------------------------------

  // Random car-to-car hits and head-ons every few seconds.
  function fakeEvents() {
    const alive = aliveCars();
    if (alive.length < 2) return;

    if (now >= nextFakeHit) {
      const a = pick(alive);
      const v = pick(alive.filter(c => c.id !== a.id));
      const kind = Math.random() < 0.4 ? HIT_KIND.REAR : HIT_KIND.SIDE;
      const base = 10 + Math.random() * 20;
      const dmg = applyDamage(v, kind === HIT_KIND.REAR ? base * (1 + CONFIG.REAR_BONUS) : base, a.id);
      applyDamage(a, dmg * CONFIG.ATTACKER_RECOIL, null);
      if (dmg > 0) events.push({ type: EVENT.HIT, attacker: a.id, victim: v.id, dmg, kind });
      checkDeath(v);
      checkDeath(a);
      nextFakeHit = now + 2500 + Math.random() * 2500;
    }

    if (now >= nextFakeHeadon) {
      const upright = alive.filter(c => c.s === CAR_STATE.ALIVE);
      if (upright.length >= 2) {
        const a = pick(upright);
        const b = pick(upright.filter(c => c.id !== a.id));
        const base = 6 + Math.random() * 10;
        const dmgA = applyDamage(a, base, b.id);
        const dmgB = applyDamage(b, base, a.id);
        for (const c of [a, b]) {
          if (c.s === CAR_STATE.ALIVE) { c.s = CAR_STATE.STUNNED; c.stunUntil = now + CONFIG.CONCUSSION_MS; }
        }
        events.push({ type: EVENT.HEADON, a: a.id, b: b.id, dmg: Math.max(dmgA, dmgB), stunMs: CONFIG.CONCUSSION_MS });
        checkDeath(a);
        checkDeath(b);
      }
      nextFakeHeadon = now + 9000 + Math.random() * 6000;
    }
  }

  function surfaceHit(car, impactSpeedUnits) {
    const impact = impactSpeedUnits / SCALE; // m/s
    if (impact < CONFIG.WALL_MIN_SPEED) return;
    car.speed *= CONFIG.WALL_SPEED_KEEP;
    const dmg = applyDamage(car, CONFIG.WALL_DMG_K * impact * impact, null);
    events.push({ type: EVENT.WALL, id: car.id, dmg });
    checkDeath(car); // credits lastAttacker if within KILL_CREDIT_MS
  }

  // Kinematic driving with the real input rules (throttle, steering, tip-over, recovery).
  function stepCar(car, input, dt) {
    const spec = CARS[DEFAULT_CAR];
    const boosted = car.buff === BUFF.BOOST && now < car.buffUntil;
    if (now >= car.buffUntil) car.buff = BUFF.NONE;
    const maxV = spec.maxSpeed * SCALE * (boosted ? CONFIG.BOOST_SPEED_MULT : 1);
    const minV = CONFIG.MIN_SPEED * SCALE;
    const engine = CONFIG.ENGINE * SCALE * (boosted ? CONFIG.BOOST_ENGINE_MULT : 1);

    if (car.s === CAR_STATE.STUNNED) {
      car.speed *= Math.exp(-CONFIG.COAST_DAMPING * dt);
      if (now >= car.stunUntil) car.s = CAR_STATE.ALIVE;
    } else if (car.s === CAR_STATE.FLIPPED) {
      car.speed *= Math.exp(-CONFIG.FLIPPED_DAMPING * dt);
      car.taps += input.taps;
      if (car.taps >= CONFIG.RECOVER_TAPS) {
        car.s = CAR_STATE.ALIVE;
        car.taps = 0;
        car.invulnUntil = now + CONFIG.RECOVER_INVULN_MS;
        events.push({ type: EVENT.RECOVER, id: car.id });
      }
    } else {
      // Throttle
      if (input.accel) {
        car.speed = car.speed < minV ? minV : Math.min(maxV, car.speed + engine * dt);
      } else {
        car.speed *= Math.exp(-CONFIG.COAST_DAMPING * dt);
      }
      // Steering
      const grip = Math.min(1, car.speed / minV);
      car.a = wrapAngle(car.a + input.tilt * spec.turnRate * grip * dt);

      // Tip-over: full speed + full steering held too long
      const greedy = car.speed >= CONFIG.FLIP_SPEED_FRAC * spec.maxSpeed * SCALE
        && Math.abs(input.tilt) >= CONFIG.FLIP_TILT;
      car.flipHeldMs = greedy ? car.flipHeldMs + dt * 1000 : 0;
      if (car.flipHeldMs >= CONFIG.FLIP_HOLD_MS) {
        car.s = CAR_STATE.FLIPPED;
        car.taps = 0;
        car.flipHeldMs = 0;
        events.push({ type: EVENT.FLIP, id: car.id });
      }
    }

    // Move
    car.x += Math.cos(car.a) * car.speed * dt;
    car.y += Math.sin(car.a) * car.speed * dt;

    // Walls: reflect, lose speed, self-damage
    const half = CAR_SIZE.W / 2;
    const vx = Math.cos(car.a) * car.speed;
    const vy = Math.sin(car.a) * car.speed;
    if (car.x < half) { car.x = half; car.a = wrapAngle(Math.PI - car.a); surfaceHit(car, Math.abs(vx)); }
    else if (car.x > ARENA.W - half) { car.x = ARENA.W - half; car.a = wrapAngle(Math.PI - car.a); surfaceHit(car, Math.abs(vx)); }
    if (car.y < half) { car.y = half; car.a = wrapAngle(-car.a); surfaceHit(car, Math.abs(vy)); }
    else if (car.y > ARENA.H - half) { car.y = ARENA.H - half; car.a = wrapAngle(-car.a); surfaceHit(car, Math.abs(vy)); }

    // Pillars: same penalty as walls
    for (const o of OBSTACLES) {
      const dx = car.x - o.x;
      const dy = car.y - o.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 0 && dist < o.r + half) {
        const nx = dx / dist, ny = dy / dist;
        car.x = o.x + nx * (o.r + half);
        car.y = o.y + ny * (o.r + half);
        let dxv = Math.cos(car.a), dyv = Math.sin(car.a);
        const dot = dxv * nx + dyv * ny;
        if (dot < 0) {
          const impact = -dot * car.speed;
          dxv -= 2 * dot * nx;
          dyv -= 2 * dot * ny;
          car.a = Math.atan2(dyv, dxv);
          surfaceHit(car, impact);
        }
      }
    }
  }

  return {
    cars, stats,
    get now() { return now; },
    step, snapshot, spawn, remove, over, winnerId,
  };
}

function wrapAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
