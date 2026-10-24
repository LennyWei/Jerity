// server/game.js
// One round: cars, driving, damage, deaths, kill rewards, events, and snapshots.
// No sockets here. rooms.js makes a game per round, calls step() at TICK_HZ with one input
// per player, and broadcasts snapshot() at SNAP_HZ. sim.js drives the same object headless.
//
// Physics is a Planck world per round (design.md section 4). Planck works in meters and m/s,
// like config.js; world units (SCALE per meter) appear only when creating bodies and when
// building snapshots.
//
// Phase B (now): real driving and bouncing, but walls cost no HP yet and car-to-car hits are
// still the random stand-in from fake.js. Phase C takes both from Planck contacts.
//
// Timers use simulation time (`now`, ms since the round started), not Date.now(), so a
// headless run plays out exactly like a live one.

import { World, Vec2, Box, Circle, Edge } from 'planck';
import { CAR_STATE, EVENT, BUFF, HIT_KIND, packCar } from '../shared/protocol.js';
import {
  ARENA, SCALE, CAR_SIZE, OBSTACLES, SPAWN_RADIUS, CARS, DEFAULT_CAR,
} from '../shared/constants.js';
import { CONFIG } from '../shared/config.js';

const NO_INPUT = { tilt: 0, accel: false, taps: 0 };
const VELOCITY_ITERATIONS = 8; // Planck solver passes per step
const POSITION_ITERATIONS = 3;

/** Score without the win bonus (snapshot `sc`). The leaderboard adds SCORE_WIN. */
export function liveScore(st) {
  return st.damage * CONFIG.SCORE_PER_DAMAGE + st.kills * CONFIG.SCORE_KILL;
}

/** players: [{ id }] in spawn order. */
export function createGame(players) {
  const world = new World({ gravity: Vec2(0, 0) }); // top-down: no gravity
  const cars = new Map();   // id -> car; dead cars stay (without a body) so clients can draw the wreck and the KO
  const stats = new Map();  // id -> { kills, damage } for this round
  const events = [];        // EVENT objects since the last snapshot
  let now = 0;
  let timeLeft = CONFIG.ROUND_TIME_S;
  let lastSnapT = 0;
  let nextFakeHit = 2000;     // stand-in hit timers, removed in Phase C
  let nextFakeHeadon = 7000;

  buildArena();
  players.forEach((p, i) => addCar(p.id, (2 * Math.PI * i) / players.length));

  // ---------------------------------------------------------------------------
  // Round API (rooms.js and sim.js)
  // ---------------------------------------------------------------------------

  /** inputs: Map id -> { tilt, accel, taps } for this tick. A car without one coasts. */
  function step(inputs, dt) {
    now += dt * 1000;
    for (const car of cars.values()) {
      if (car.body) drive(car, inputs.get(car.id) || NO_INPUT, dt);
    }
    world.step(dt, VELOCITY_ITERATIONS, POSITION_ITERATIONS);
    for (const car of cars.values()) {
      if (car.body) syncFromBody(car);
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
    const car = cars.get(id);
    if (car?.body) world.destroyBody(car.body);
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
  // World and cars
  // ---------------------------------------------------------------------------

  // Four static wall edges and the pillars. Pillars count as walls for damage (Phase C).
  function buildArena() {
    const w = ARENA.W / SCALE;
    const h = ARENA.H / SCALE;
    const corners = [Vec2(0, 0), Vec2(w, 0), Vec2(w, h), Vec2(0, h)];
    const walls = world.createBody();
    corners.forEach((c, i) => {
      walls.createFixture(new Edge(c, corners[(i + 1) % 4]), { restitution: CONFIG.WALL_RESTITUTION });
    });
    for (const o of OBSTACLES) {
      world.createBody({ position: Vec2(o.x / SCALE, o.y / SCALE) })
        .createFixture(new Circle(o.r / SCALE), { restitution: CONFIG.OBSTACLE_RESTITUTION });
    }
    // Planck mixes restitution by taking the larger value, so a car (CAR_RESTITUTION) would
    // bounce off a softer wall at the car's value. Walls and pillars use their own instead.
    world.on('pre-solve', (contact) => {
      const fA = contact.getFixtureA();
      const fB = contact.getFixtureB();
      if (fA.getBody().isStatic()) contact.setRestitution(fA.getRestitution());
      else if (fB.getBody().isStatic()) contact.setRestitution(fB.getRestitution());
    });
  }

  // On the spawn circle at angle `ang`, facing the center.
  function addCar(id, ang) {
    const spec = CARS[DEFAULT_CAR]; // MVP: everyone drives balanced
    const x = ARENA.W / 2 + SPAWN_RADIUS * Math.cos(ang);
    const y = ARENA.H / 2 + SPAWN_RADIUS * Math.sin(ang);
    const a = wrapAngle(ang + Math.PI);
    const body = world.createBody({
      type: 'dynamic',
      position: Vec2(x / SCALE, y / SCALE),
      angle: a,
      bullet: true,        // two cars closing at ~30 m/s would otherwise pass through each other
      allowSleep: false,
    });
    body.createFixture(new Box(CAR_SIZE.W / 2 / SCALE, CAR_SIZE.H / 2 / SCALE), {
      density: spec.density,
      restitution: CONFIG.CAR_RESTITUTION,
    });
    cars.set(id, {
      id,
      body,                     // null once dead
      x, y, a,                  // world units, copied from the body after every step
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

  function syncFromBody(car) {
    const p = car.body.getPosition();
    car.x = p.x * SCALE;
    car.y = p.y * SCALE;
    car.a = wrapAngle(car.body.getAngle());
  }

  function aliveCars() {
    return [...cars.values()].filter(c => c.s !== CAR_STATE.DEAD);
  }

  // ---------------------------------------------------------------------------
  // Driving (design.md section 4). Runs before world.step.
  // ---------------------------------------------------------------------------

  function drive(car, input, dt) {
    const b = car.body;
    const spec = CARS[DEFAULT_CAR];
    const boosted = car.buff === BUFF.BOOST && now < car.buffUntil;
    if (now >= car.buffUntil) car.buff = BUFF.NONE;

    if (car.s === CAR_STATE.STUNNED) {
      b.setLinearDamping(CONFIG.COAST_DAMPING); // no control: coast, spin dies out
      b.setAngularDamping(CONFIG.ANGULAR_DAMPING);
      if (now >= car.stunUntil) car.s = CAR_STATE.ALIVE;
      return;
    }
    if (car.s === CAR_STATE.FLIPPED) {
      b.setLinearDamping(CONFIG.FLIPPED_DAMPING); // no control: slide to a stop, count taps
      b.setAngularDamping(CONFIG.ANGULAR_DAMPING);
      car.taps += input.taps;
      if (car.taps >= CONFIG.RECOVER_TAPS) {
        car.s = CAR_STATE.ALIVE;
        car.taps = 0;
        car.invulnUntil = now + CONFIG.RECOVER_INVULN_MS;
        events.push({ type: EVENT.RECOVER, id: car.id });
      }
      return;
    }

    const mass = b.getMass();
    const fwd = b.getWorldVector(Vec2(1, 0));
    const right = b.getWorldVector(Vec2(0, 1));

    // Lateral grip: remove most sideways velocity so it drives like a car, not a puck.
    const lat = Vec2.dot(right, b.getLinearVelocity());
    b.applyLinearImpulse(Vec2.mul(right, -lat * mass * CONFIG.GRIP), b.getWorldCenter());

    // Throttle: instant launch to MIN_SPEED, then engine force up to max speed.
    if (input.accel) {
      b.setLinearDamping(0);
      const maxSpeed = spec.maxSpeed * (boosted ? CONFIG.BOOST_SPEED_MULT : 1);
      const fwdSpeed = Vec2.dot(fwd, b.getLinearVelocity());
      if (fwdSpeed < CONFIG.MIN_SPEED) {
        b.applyLinearImpulse(Vec2.mul(fwd, (CONFIG.MIN_SPEED - fwdSpeed) * mass), b.getWorldCenter());
      } else if (fwdSpeed < maxSpeed) {
        b.applyForceToCenter(Vec2.mul(fwd, CONFIG.ENGINE * mass * (boosted ? CONFIG.BOOST_ENGINE_MULT : 1)));
      }
    } else {
      b.setLinearDamping(CONFIG.COAST_DAMPING);
    }

    // Steering: no spinning in place, full turn rate from MIN_SPEED up. Planck would damp the
    // turn rate during the step, so damping is off while the player steers.
    const speed = b.getLinearVelocity().length();
    b.setAngularDamping(0);
    b.setAngularVelocity(input.tilt * spec.turnRate * Math.min(1, speed / CONFIG.MIN_SPEED));

    // Tip-over: full speed + full steering held too long
    const greedy = speed >= CONFIG.FLIP_SPEED_FRAC * spec.maxSpeed
      && Math.abs(input.tilt) >= CONFIG.FLIP_TILT;
    car.flipHeldMs = greedy ? car.flipHeldMs + dt * 1000 : 0;
    if (car.flipHeldMs >= CONFIG.FLIP_HOLD_MS) {
      car.s = CAR_STATE.FLIPPED;
      car.taps = 0;
      car.flipHeldMs = 0;
      events.push({ type: EVENT.FLIP, id: car.id });
    }
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

  // Only call after world.step (never inside a Planck callback): it destroys the body.
  function checkDeath(car) {
    if (car.hp > 0 || car.s === CAR_STATE.DEAD) return;
    car.hp = 0;
    car.s = CAR_STATE.DEAD;
    world.destroyBody(car.body);
    car.body = null;

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
  // Stand-in from fake.js until Phase C: random car-to-car hits and head-ons
  // ---------------------------------------------------------------------------

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
