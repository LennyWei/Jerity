// server/game.js
// One round: cars, driving, contacts, damage, deaths, kill rewards, events, and snapshots.
// No sockets here. rooms.js makes a game per round, calls step() at TICK_HZ with one input
// per player, and broadcasts snapshot() at SNAP_HZ. sim.js drives the same object headless.
//
// Physics is a Planck world per round (design.md section 4). Planck works in meters and m/s,
// like config.js; world units (SCALE per meter) appear only when creating bodies and when
// building snapshots. The damage rules themselves are pure functions in mechanics.js.
//
// Timers use simulation time (`now`, ms since the round started), not Date.now(), so a
// headless run plays out exactly like a live one.

import { World, Vec2, Box, Circle, Edge } from 'planck';
import { CAR_STATE, EVENT, BUFF, packCar } from '../shared/protocol.js';
import {
  ARENA, SCALE, CAR_SIZE, OBSTACLES, SPAWN_RADIUS, CARS, DEFAULT_CAR,
} from '../shared/constants.js';
import { CONFIG } from '../shared/config.js';
import { carHit, wallHit, flipTick, killReward, liveScore } from './mechanics.js';

const NO_INPUT = { tilt: 0, accel: false, taps: 0 };
const VELOCITY_ITERATIONS = 8; // Planck solver passes per step
const POSITION_ITERATIONS = 3;

/** players: [{ id }] in spawn order. */
export function createGame(players) {
  const world = new World({ gravity: Vec2(0, 0) }); // top-down: no gravity
  const cars = new Map();   // id -> car; dead cars stay (without a body) so clients can draw the wreck and the KO
  const stats = new Map();  // id -> { kills, damage } for this round
  const events = [];        // EVENT objects since the last snapshot
  const contacts = [];      // touches queued during world.step, handled right after it
  const lastHitAt = new Map(); // car pair or "car|wall" -> sim time of the last hit that counted
  let now = 0;
  let timeLeft = CONFIG.ROUND_TIME_S;
  let lastSnapT = 0;

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
    handleContacts();
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

  // Four static wall edges and the pillars (pillars count as walls). Static bodies have no
  // user data; car bodies point at their car.
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

    // A new touch, before the solver has bounced anything: the velocities here are the ones
    // that caused it. Only record it (copies, Planck reuses these vectors); never change the
    // world inside a callback.
    world.on('begin-contact', (contact) => {
      const bA = contact.getFixtureA().getBody();
      const bB = contact.getFixtureB().getBody();
      const wm = contact.getWorldManifold(null);
      if (!wm) return;
      contacts.push({
        a: bA.getUserData() || null, // car, or null for a wall or pillar
        b: bB.getUserData() || null,
        n: Vec2.clone(wm.normal),    // unit normal from A to B
        vA: Vec2.clone(bA.getLinearVelocity()),
        vB: Vec2.clone(bB.getLinearVelocity()),
        fwdA: bA.getWorldVector(Vec2(1, 0)),
        fwdB: bB.getWorldVector(Vec2(1, 0)),
      });
    });
  }

  // On the spawn circle at angle `ang`, facing the center.
  function addCar(id, ang) {
    const spec = CARS[DEFAULT_CAR]; // MVP: everyone drives balanced
    const car = {
      id,
      body: null,               // set below; null once dead
      x: ARENA.W / 2 + SPAWN_RADIUS * Math.cos(ang), // world units, copied from the body after every step
      y: ARENA.H / 2 + SPAWN_RADIUS * Math.sin(ang),
      a: wrapAngle(ang + Math.PI),
      hp: spec.hp,
      maxHp: spec.hp,
      s: CAR_STATE.ALIVE,
      taps: 0,
      flipHeldMs: 0,
      stunUntil: 0,
      knockUntil: 0,
      invulnUntil: 0,
      buff: BUFF.NONE,
      buffUntil: 0,
      lastAttacker: null,
      lastHitAt: 0,
    };
    car.body = world.createBody({
      type: 'dynamic',
      position: Vec2(car.x / SCALE, car.y / SCALE),
      angle: car.a,
      bullet: true,        // two cars closing at ~30 m/s would otherwise pass through each other
      allowSleep: false,
      userData: car,
    });
    car.body.createFixture(new Box(CAR_SIZE.W / 2 / SCALE, CAR_SIZE.H / 2 / SCALE), {
      density: spec.density,
      restitution: CONFIG.CAR_RESTITUTION,
    });
    cars.set(id, car);
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
    const knocked = now < car.knockUntil; // just knocked back: no grip or throttle until it plays out

    // Lateral grip: remove most sideways velocity so it drives like a car, not a puck.
    if (!knocked) {
      const lat = Vec2.dot(right, b.getLinearVelocity());
      b.applyLinearImpulse(Vec2.mul(right, -lat * mass * CONFIG.GRIP), b.getWorldCenter());
    }

    // Throttle: instant launch to MIN_SPEED, plus engine force up to max speed. Both in the
    // same tick: a turning car's forward speed dips just under MIN_SPEED every tick, and with
    // launch-or-engine it would be relaunched forever and never speed up.
    if (input.accel && !knocked) {
      b.setLinearDamping(0);
      const maxSpeed = spec.maxSpeed * (boosted ? CONFIG.BOOST_SPEED_MULT : 1);
      const fwdSpeed = Vec2.dot(fwd, b.getLinearVelocity());
      if (fwdSpeed < CONFIG.MIN_SPEED) {
        b.applyLinearImpulse(Vec2.mul(fwd, (CONFIG.MIN_SPEED - fwdSpeed) * mass), b.getWorldCenter());
      }
      if (Math.max(fwdSpeed, CONFIG.MIN_SPEED) < maxSpeed) {
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

    // Tip-over: full speed + full steering held too long (design.md 5.3)
    car.flipHeldMs = flipTick(car.flipHeldMs, speed, spec.maxSpeed, input.tilt, dt * 1000);
    if (car.flipHeldMs >= CONFIG.FLIP_HOLD_MS) {
      car.s = CAR_STATE.FLIPPED;
      car.taps = 0;
      car.flipHeldMs = 0;
      events.push({ type: EVENT.FLIP, id: car.id });
    }
  }

  // ---------------------------------------------------------------------------
  // Contacts (design.md 5.1 and 5.2), handled after world.step: damage can kill a car,
  // and a dead car's body is destroyed.
  // ---------------------------------------------------------------------------

  function handleContacts() {
    for (const c of contacts.splice(0)) {
      if (c.a && c.b) carContact(c);
      else if (c.a || c.b) wallContact(c);
    }
  }

  // Per pair (or car and walls), so one crunch counts once. Starts the cooldown when it isn't on one.
  function coolingDown(key) {
    if (now - (lastHitAt.get(key) ?? -Infinity) < CONFIG.HIT_COOLDOWN_MS) return true;
    lastHitAt.set(key, now);
    return false;
  }

  function carContact({ a, b, n, vA, vB, fwdA, fwdB }) {
    if (a.s === CAR_STATE.DEAD || b.s === CAR_STATE.DEAD) return;
    const hit = carHit({ vA, vB, n, fwdA, fwdB, massA: a.body.getMass(), massB: b.body.getMass() });
    if (!hit || coolingDown([a.id, b.id].sort().join('|'))) return;

    if (hit.type === 'headon') {
      const dmgA = applyDamage(a, hit.dmg, b.id);
      const dmgB = applyDamage(b, hit.dmg, a.id);
      for (const car of [a, b]) {
        if (car.s === CAR_STATE.ALIVE) { car.s = CAR_STATE.STUNNED; car.stunUntil = now + CONFIG.CONCUSSION_MS; }
      }
      events.push({ type: EVENT.HEADON, a: a.id, b: b.id, dmg: Math.max(dmgA, dmgB), stunMs: CONFIG.CONCUSSION_MS });
    } else {
      const [attacker, victim] = hit.attacker === 'A' ? [a, b] : [b, a];
      const dmg = applyDamage(victim, hit.dmgToVictim, attacker.id);
      applyDamage(attacker, hit.dmgToAttacker, null);
      if (dmg > 0) events.push({ type: EVENT.HIT, attacker: attacker.id, victim: victim.id, dmg, kind: hit.kind });
    }
    knockApart(a, b, n, hit.type === 'headon' ? CONFIG.HEADON_KNOCKBACK_SPEED : CONFIG.KNOCKBACK_SPEED);
    checkDeath(a);
    checkDeath(b);
  }

  // Pushes two cars apart along the hit (n points from a to b), at least `speed` each, and takes
  // away their throttle and grip for KNOCKBACK_MS so the push plays out. Without it the instant
  // launch drives the rammer straight back in and grip cancels the sideways push, so cars grind,
  // slide along each other, and keep getting hit (head-ons: concussed again right after the stun).
  function knockApart(a, b, n, speed) {
    for (const [car, out] of [[a, -1], [b, 1]]) {
      const v = car.body.getLinearVelocity();
      const along = Vec2.dot(v, n);
      const target = out * Math.max(speed, out * along); // keep a bounce that is already faster
      car.body.setLinearVelocity(Vec2.add(v, Vec2.mul(n, target - along)));
      car.knockUntil = now + CONFIG.KNOCKBACK_MS;
    }
  }

  function wallContact({ a, b, n, vA, vB }) {
    const car = a || b;
    if (car.s === CAR_STATE.DEAD) return;
    // n points from A to B, so "into the wall" is +n when the car is A and -n when it is B.
    const impact = a ? Math.max(0, Vec2.dot(vA, n)) : Math.max(0, -Vec2.dot(vB, n));
    const hit = wallHit(impact);
    if (!hit || coolingDown(`${car.id}|wall`)) return;
    car.body.setLinearVelocity(Vec2.mul(car.body.getLinearVelocity(), hit.speedKeep));
    const dmg = applyDamage(car, hit.dmg, null);
    events.push({ type: EVENT.WALL, id: car.id, dmg });
    checkDeath(car); // credits lastAttacker if within KILL_CREDIT_MS
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
    // A killer knocked to 0 in the same crash gets no reward: it dies too (a double KO).
    if (killer && killer.s !== CAR_STATE.DEAD && killer.hp > 0) {
      ({ heal, buff } = killReward(killer.maxHp, killer.hp));
      killer.hp += heal;
      killer.buff = buff;
      killer.buffUntil = now + CONFIG.BUFF_MS;
    }
    events.push({ type: EVENT.KILL, attacker: killerId, victim: car.id, heal, buff });
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
