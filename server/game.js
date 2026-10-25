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
  ARENA, SCALE, CAR_SIZE, OBSTACLES, MAPS, DEFAULT_MAP, SPAWN_POINTS, CARS, DEFAULT_CAR,
} from '../shared/constants.js';
import { CONFIG } from '../shared/config.js';
import { carHit, wallHit, flipTick, killReward, liveScore } from './mechanics.js';

const NO_INPUT = { tilt: 0, accel: false, taps: 0 };
const VELOCITY_ITERATIONS = 8; // Planck solver passes per step
const POSITION_ITERATIONS = 3;

/** players: [{ id }] in spawn order. mapId: a key of MAPS (the arena's obstacles). */
export function createGame(players, mapId = DEFAULT_MAP) {
  const obstacles = (MAPS[mapId] || MAPS[DEFAULT_MAP])?.obstacles ?? OBSTACLES;
  const world = new World({ gravity: Vec2(0, 0) }); // top-down: no gravity
  const cars = new Map();   // id -> car; dead cars stay (without a body) so clients can draw the wreck and the KO
  const stats = new Map();  // id -> { kills, damage } for this round
  const events = [];        // EVENT objects since the last snapshot
  const contacts = [];      // touches queued during world.step, handled right after it
  const lastHitAt = new Map(); // car pair or "car|wall" -> sim time of the last hit that counted
  let now = 0;
  let timeLeft = CONFIG.ROUND_TIME_S;
  let persuasionKillUsed = false;
  let celebrating = false;  // the round is decided: cars still drive and bounce, nothing does damage
  let obstaclesOffUntil = 0;
  const arenaObstacles = [];
  let lastSnapT = 0;
  let clockBase = Date.now(); // snapshot times are this + simulation time

  buildArena();
  players.forEach((p, i) => addCar(p.id, SPAWN_POINTS[i % SPAWN_POINTS.length]));

  // ---------------------------------------------------------------------------
  // Round API (rooms.js and sim.js)
  // ---------------------------------------------------------------------------

  /** inputs: Map id -> { tilt, accel, taps } for this tick. A car without one coasts. */
  function step(inputs, dt) {
    now += dt * 1000;
    if (obstaclesOffUntil > 0 && now >= obstaclesOffUntil) {
    for (const body of arenaObstacles) {
    body.setActive(true);
    }
    obstaclesOffUntil = 0;
  }
    for (const car of cars.values()) {
      if (car.body && car.s !== CAR_STATE.DISCONNECTED) drive(car, inputs.get(car.id) || NO_INPUT, dt);
    }
    world.step(dt, VELOCITY_ITERATIONS, POSITION_ITERATIONS);
    for (const car of cars.values()) {
      if (car.body) syncFromBody(car);
    }
    handleContacts();
    timeLeft -= dt;
  }

  function snapshot() {
    // Stamp with simulation time, not the clock: snapshots go out every 50 ms but hold whole
    // 33 ms ticks (1, then 2, then 1...), and clock stamps made clients play that back as a
    // slow-fast stutter. But the simulation stands still in the countdown (and drops time after
    // a stall), so when it falls behind the clock, move the base up: stamps far behind the clock
    // make clients draw past the newest snapshot (jumpy) and slowly drift back (laggy).
    const wall = Date.now();
    if (wall - (clockBase + now) > CONFIG.SNAP_CLOCK_SLACK_MS) clockBase = wall - now;
    // Clients order snapshots by t and drop any that go backwards, so never repeat one.
    lastSnapT = Math.max(clockBase + Math.round(now), lastSnapT + 1);
    return {
      t: lastSnapT,
      cars: [...cars.values()].map(c => packCar({ ...c, sc: liveScore(stats.get(c.id)) })),
      events: events.splice(0),
      timeLeft: Math.max(0, Math.ceil(timeLeft)),
      obstaclesDisabled: now < obstaclesOffUntil,
    };
  }

  /** Mid-round join (bot rooms only): the spawn point farthest from every car still in the round. */
  function spawn(p) {
    const others = aliveCars();
    const room = s => Math.min(...others.map(c => Math.hypot(c.x - s.x, c.y - s.y)));
    addCar(p.id, SPAWN_POINTS.reduce((best, s) => (room(s) > room(best) ? s : best)));
  }

  function remove(id) {
    const car = cars.get(id);
    if (car?.body) world.destroyBody(car.body);
    cars.delete(id);
  }

  /**
   * The player's phone dropped (away) or came back. An away car is a ghost: frozen and out of
   * the physics, so cars drive through it and nothing can hurt it. Back: it carries on (flipped
   * stays flipped) with a moment of invulnerability. Only call between steps.
   */
  function setAway(id, away) {
    const car = cars.get(id);
    if (!car?.body || (car.s === CAR_STATE.DISCONNECTED) === away) return;
    if (away) {
      car.sBefore = car.s;
      car.s = CAR_STATE.DISCONNECTED;
      car.body.setLinearVelocity(Vec2(0, 0));
      car.body.setAngularVelocity(0);
      car.body.setActive(false);
    } else {
      car.s = car.sBefore === CAR_STATE.FLIPPED ? CAR_STATE.FLIPPED : CAR_STATE.ALIVE;
      car.invulnUntil = now + CONFIG.RECOVER_INVULN_MS;
      car.body.setActive(true);
    }
  }

  /** One car left (flipped and stunned still count), or time is up. A lone car plays to the timer. */
  function over() {
    return timeLeft <= 0 || (cars.size > 1 && aliveCars().length <= 1);
  }

  /** Last car alive; on timeout the highest HP; null when nobody is left. */
  function winnerId() {
    return aliveCars().sort((a, b) => b.hp - a.hp)[0]?.id ?? null;
  }

  /** Seconds a car has been in the round: until it was knocked out, or so far. */
  function survivedS(id) {
    const car = cars.get(id);
    return car ? ((car.diedAt ?? now) - car.bornAt) / 1000 : 0;
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
    for (const o of obstacles) {
      // Bollards and tire stacks are circles; barriers are rotated boxes. All count as walls.
      const shape = o.kind === 'box' ? new Box(o.w / 2 / SCALE, o.h / 2 / SCALE) : new Circle(o.r / SCALE);
      const body = world.createBody({position: Vec2(o.x / SCALE, o.y / SCALE), angle: o.a || 0});

body.createFixture(shape, {
  restitution: CONFIG.OBSTACLE_RESTITUTION
});

arenaObstacles.push(body);
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

  // At a spawn point (world units), facing the center.
  function addCar(id, spot) {
    const spec = CARS[DEFAULT_CAR]; // MVP: everyone drives balanced
    const car = {
      id,
      body: null,               // set below; null once dead
      x: spot.x,                // world units, copied from the body after every step
      y: spot.y,
      a: Math.atan2(ARENA.H / 2 - spot.y, ARENA.W / 2 - spot.x),
      hp: spec.hp,
      maxHp: spec.hp,
      s: CAR_STATE.ALIVE,
      taps: 0,
      flipHeldMs: 0,
      stunUntil: 0,
      knockUntil: 0,
      invulnUntil: 0,
      slowUntil: 0,
      reverseUntil: 0,
      superUntil: 0,
      frozenUntil: 0,           // Jerity's freeze_player: stunned and held in place
      buff: BUFF.NONE,
      buffUntil: 0,
      lastAttacker: null,
      lastHitAt: 0,
      lastWallAt: -Infinity,    // last wall/pillar bump: another one soon after is pressing, not crashing
      bornAt: now,              // sim time it joined the round, and when it was knocked out: survival time
      diedAt: null,
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
  const superBoost = now < car.superUntil;
  const slowed = now < car.slowUntil;

  const speedMult = (superBoost ? 2 : boosted ? CONFIG.BOOST_SPEED_MULT : 1) * (slowed ? 0.5 : 1);
  const engineMult = superBoost ? 2 : boosted ? CONFIG.BOOST_ENGINE_MULT : 1;

  if (now >= car.buffUntil) car.buff = BUFF.NONE;

  if (now < car.reverseUntil) {
    const throttle = Number.isFinite(input.throttle) ? input.throttle : input.accel ? 1 : 0;
    input = { ...input, tilt: -(Number(input.tilt) || 0), throttle: -throttle };
  }

  if (car.s === CAR_STATE.STUNNED) {
    if (now >= car.stunUntil) {
      car.s = CAR_STATE.ALIVE;
    } else {
      // Jerity's freeze holds the car still; a head-on stun coasts, so the knockback separates them.
      if (now < car.frozenUntil) {
        b.setLinearVelocity(Vec2(0, 0));
        b.setAngularVelocity(0);
      }
      b.setLinearDamping(CONFIG.COAST_DAMPING);
      b.setAngularDamping(CONFIG.ANGULAR_DAMPING);
      return;
    }
  }

  if (car.s === CAR_STATE.FLIPPED) {
    b.setLinearDamping(CONFIG.FLIPPED_DAMPING);
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

  if (now < car.knockUntil) {
    b.setLinearDamping(CONFIG.DRIVE_MODE === 'omni' ? CONFIG.OMNI_COAST_DAMPING : CONFIG.COAST_DAMPING);
    b.setAngularDamping(CONFIG.ANGULAR_DAMPING);
    car.flipHeldMs = 0;
    return;
  }

  if (CONFIG.DRIVE_MODE === 'omni') {
    return driveOmni(car, input, dt, spec, speedMult, engineMult);
  }

  const mass = b.getMass();
  const fwd = b.getWorldVector(Vec2(1, 0));
  const right = b.getWorldVector(Vec2(0, 1));

  const lat = Vec2.dot(right, b.getLinearVelocity());
  b.applyLinearImpulse(Vec2.mul(right, -lat * mass * CONFIG.GRIP), b.getWorldCenter());

  const throttle = Number.isFinite(input.throttle) ? input.throttle : input.accel ? 1 : 0;
  const fwdSpeed = Vec2.dot(fwd, b.getLinearVelocity());
  const push = accel => b.applyForceToCenter(Vec2.mul(fwd, accel * mass));

  if (throttle > 0) {
    const target = spec.maxSpeed * speedMult * throttle;
    const launch = Math.min(CONFIG.MIN_SPEED, target);

    b.setLinearDamping(fwdSpeed > target ? CONFIG.COAST_DAMPING : 0);

    if (fwdSpeed < launch) {
      b.applyLinearImpulse(Vec2.mul(fwd, (launch - fwdSpeed) * mass), b.getWorldCenter());
    }

    if (Math.max(fwdSpeed, launch) < target) {
      push(CONFIG.ENGINE * engineMult);
    }
  } else if (throttle < 0) {
    b.setLinearDamping(0);

    if (fwdSpeed > 0.5) {
      push(-CONFIG.BRAKE * -throttle);
    } else if (fwdSpeed > -CONFIG.REVERSE_MAX_SPEED * speedMult * -throttle) {
      push(-CONFIG.REVERSE_ENGINE * engineMult);
    }
  } else {
    b.setLinearDamping(CONFIG.COAST_DAMPING);
  }

  const speed = b.getLinearVelocity().length();
  const reversing = throttle < 0 && Vec2.dot(fwd, b.getLinearVelocity()) < 0;

  b.setAngularDamping(0);
  b.setAngularVelocity(
    input.tilt * spec.turnRate *
    Math.min(1, speed / CONFIG.MIN_SPEED) *
    (reversing ? -1 : 1)
  );

  car.flipHeldMs = flipTick(car.flipHeldMs, speed, spec.maxSpeed, input.tilt, dt * 1000);

  if (car.flipHeldMs >= CONFIG.FLIP_HOLD_MS) {
    car.s = CAR_STATE.FLIPPED;
    car.taps = 0;
    car.flipHeldMs = 0;
    events.push({ type: EVENT.FLIP, id: car.id });
  }
}

function driveOmni(car, input, dt, spec, speedMult, engineMult) {
  const b = car.body;
  const mass = b.getMass();
  const v = b.getLinearVelocity();

  const wx = Number(input.tilt) || 0;
  const wy = -(Number.isFinite(input.throttle) ? input.throttle : input.accel ? 1 : 0);
  const want = Math.min(1, Math.hypot(wx, wy));
  const maxSpeed = spec.maxSpeed * speedMult;

  if (want > 0) {
    b.setLinearDamping(0);

    const accel = CONFIG.OMNI_ACCEL * engineMult * dt;
    const target = maxSpeed * want;
    const s = v.length();

    let nvx, nvy;

    if (s < CONFIG.OMNI_ARC_MIN_SPEED) {
      const k = target / Math.hypot(wx, wy);
      const dvx = wx * k - v.x;
      const dvy = wy * k - v.y;
      const dv = Math.hypot(dvx, dvy);
      const f = dv > accel ? accel / dv : 1;

      nvx = v.x + dvx * f;
      nvy = v.y + dvy * f;
    } else {
      const h = Math.atan2(v.y, v.x);
      const d = Math.atan2(
        Math.sin(Math.atan2(wy, wx) - h),
        Math.cos(Math.atan2(wy, wx) - h)
      );

      const turn = Math.max(
        -CONFIG.OMNI_TURN_RATE,
        Math.min(CONFIG.OMNI_TURN_RATE, d * CONFIG.OMNI_TURN_GAIN)
      ) * dt;

      const ns = s + Math.max(-accel, Math.min(accel, target - s));

      nvx = Math.cos(h + turn) * ns;
      nvy = Math.sin(h + turn) * ns;
    }

    b.applyLinearImpulse(
      Vec2((nvx - v.x) * mass, (nvy - v.y) * mass),
      b.getWorldCenter()
    );
  } else {
    b.setLinearDamping(CONFIG.OMNI_COAST_DAMPING);
  }

  const vel = b.getLinearVelocity();
  const speed = vel.length();

  b.setAngularDamping(0);

  if (speed > 0.8) {
    const diff = Math.atan2(
      Math.sin(Math.atan2(vel.y, vel.x) - b.getAngle()),
      Math.cos(Math.atan2(vel.y, vel.x) - b.getAngle())
    );

    const maxTurn = spec.turnRate * 2;
    b.setAngularVelocity(
      Math.max(-maxTurn, Math.min(maxTurn, diff * CONFIG.OMNI_FACE_GAIN))
    );
  } else {
    b.setAngularVelocity(0);
  }

  const off = want > 0 && speed > 0
    ? Math.acos(
        Math.max(-1, Math.min(1,
          (wx * vel.x + wy * vel.y) / (Math.hypot(wx, wy) * speed)
        ))
      ) * (180 / Math.PI)
    : 0;

  const greedy =
    speed >= CONFIG.OMNI_FLIP_SPEED_FRAC * spec.maxSpeed &&
    want >= CONFIG.FLIP_TILT &&
    off >= CONFIG.OMNI_FLIP_ANGLE_DEG;

  car.flipHeldMs = greedy ? car.flipHeldMs + dt * 1000 : 0;

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
    if (celebrating) { contacts.length = 0; return; } // victory lap: bumps just bounce
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
      const dmgA = applyDamage(a, hit.dmgToA, b.id);
      const dmgB = applyDamage(b, hit.dmgToB, a.id);
      for (const car of [a, b]) {
        if (car.s === CAR_STATE.ALIVE) { car.s = CAR_STATE.STUNNED; car.stunUntil = now + CONFIG.CONCUSSION_MS; }
      }
      events.push({ type: EVENT.HEADON, a: a.id, b: b.id, dmg: Math.max(dmgA, dmgB), dmgA, dmgB, stunMs: CONFIG.CONCUSSION_MS });
    } else {
      const [attacker, victim] = hit.attacker === 'A' ? [a, b] : [b, a];
      const dmg = applyDamage(victim, hit.dmgToVictim, attacker.id);
      applyDamage(attacker, hit.dmgToAttacker, null);
      if (dmg > 0) events.push({ type: EVENT.HIT, attacker: attacker.id, victim: victim.id, dmg, kind: hit.kind });
    }
    const speed = hit.type === 'headon' ? CONFIG.HEADON_KNOCKBACK_SPEED : CONFIG.KNOCKBACK_SPEED;
    knock(a, Vec2.neg(n), speed);
    knock(b, n, speed);
    checkDeath(a);
    checkDeath(b);
  }

  function wallContact({ a, b, n, vA, vB }) {
    const car = a || b;
    if (car.s === CAR_STATE.DEAD) return;
    // n points from A to B, so "away from the wall" is -n when the car is A and +n when it is B.
    const away = a ? Vec2.neg(n) : n;
    const impact = Math.max(0, -Vec2.dot(a ? vA : vB, away));
    if (impact < CONFIG.MIN_IMPACT_SPEED || coolingDown(`${car.id}|wall`)) return;
    const hit = wallHit(impact); // a real crash: lose speed and some HP
    const pressing = now - car.lastWallAt < CONFIG.WALL_PRESS_MS; // holding it into the wall, bounce after bounce
    car.lastWallAt = now;
    if (hit && !pressing) {
      car.body.setLinearVelocity(Vec2.mul(car.body.getLinearVelocity(), hit.speedKeep));
      const dmg = applyDamage(car, hit.dmg, null);
      events.push({ type: EVENT.WALL, id: car.id, dmg });
    }
    knock(car, away, CONFIG.WALL_KNOCKBACK_SPEED); // every bump: bounce off instead of grinding
    checkDeath(car); // credits lastAttacker if within KILL_CREDIT_MS
  }

  // Sends a car away from what it hit (`away` is a unit vector) at `speed` or faster with a small
  // spin, and takes away all control for KNOCKBACK_MS (see drive) so the push plays out. Without
  // it the instant launch drives it straight back in and grip cancels a sideways push: cars grind
  // into walls and each other, slide along each other, and get hit again.
  function knock(car, away, speed) {
    const b = car.body;
    const v = b.getLinearVelocity();
    const out = Vec2.dot(v, away);
    b.setLinearVelocity(Vec2.add(v, Vec2.mul(away, Math.max(speed, out) - out))); // keep a faster bounce
    // Spin the way the push turns the nose (which side it was hit from), so it ends up facing a bit off.
    const fwd = b.getWorldVector(Vec2(1, 0));
    b.setAngularVelocity((fwd.x * away.y - fwd.y * away.x >= 0 ? 1 : -1) * CONFIG.KNOCKBACK_SPIN);
    car.knockUntil = now + CONFIG.KNOCKBACK_MS;
  }

  // ---------------------------------------------------------------------------
  // Damage, death, kill reward (design.md section 5)
  // ---------------------------------------------------------------------------

  function canTakeDamage(car) {
    if (car.s === CAR_STATE.DEAD || car.s === CAR_STATE.DISCONNECTED) return false;
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
    car.diedAt = now;
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
  
  // Apply an action chosen by Jerity
  function applyJerityAction(ruling) {
  if (!ruling || typeof ruling.action !== "string") return false;

  const action = ruling.action;
  const targets = Array.isArray(ruling.target) ? ruling.target : [ruling.target, ruling.target2];
  const car = cars.get(targets[0]);
  const bounded = (value, fallback, min, max) => Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
  const duration = bounded(ruling.params?.duration, 5, 2, 10) * 1000;

  const valid = c => c && c.body &&
    c.s !== CAR_STATE.DEAD &&
    c.s !== CAR_STATE.DISCONNECTED;

  function move(c, x, y, angle) {
    c.body.setTransform(Vec2(x / SCALE, y / SCALE), angle);
    c.body.setLinearVelocity(Vec2(0, 0));
    c.body.setAngularVelocity(0);
    c.knockUntil = 0;
    syncFromBody(c);
  }

  if (action === "remove_walls") {
    for (const body of arenaObstacles) {
      body.setActive(false);
    }
    obstaclesOffUntil = now + duration;
    return true;
  }

  if (action === "swap_all_positions") {
    const active = [...cars.values()].filter(valid);
    if (active.length < 2) return false;

    const places = active.map(c => ({
      x: c.x, y: c.y, a: c.a
    }));

    active.forEach((c, i) => {
      const p = places[(i + 1) % places.length];
      move(c, p.x, p.y, p.a);
    });

    return true;
  }

  if (!valid(car)) return false;

  switch (action) {
    case "freeze_player":
      car.s = CAR_STATE.STUNNED;
      car.stunUntil = now + duration;
      car.frozenUntil = car.stunUntil;
      car.body.setLinearVelocity(Vec2(0, 0));
      car.body.setAngularVelocity(0);
      break;

    case "heal_player":
      car.hp = Math.min(car.maxHp, car.hp + bounded(ruling.params?.amount, 30, 15, 30));
      break;

    case "boost_player":
      car.buff = BUFF.BOOST;
      car.buffUntil = now + duration;
      break;

    case "shield_player":
      car.buff = BUFF.SHIELD;
      car.buffUntil = now + duration;
      break;

    case "damage_player":
      applyDamage(car, bounded(ruling.params?.amount, 25, 10, 40), null);
      checkDeath(car);
      break;

    case "execute_player":
      if (timeLeft > CONFIG.ROUND_TIME_S / 4) return false;
      car.hp = 0;
      car.lastAttacker = null;
      checkDeath(car);
      break;

    case "auto_kill":
      if (persuasionKillUsed ||
          !Number.isFinite(ruling.persuasionScore) ||
          ruling.persuasionScore < 95) return false;

      persuasionKillUsed = true;
      car.hp = 0;
      car.lastAttacker = null;
      checkDeath(car);
      break;

    case "slow_player":
      car.slowUntil = now + duration;
      break;

    case "reverse_controls":
      car.reverseUntil = now + duration;
      break;

    case "super_boost":
      car.superUntil = now + duration;
      break;

    case "swap_positions":
      const other = cars.get(targets[1]);
      if (!valid(other) || other.id === car.id) return false;

      const old = { x: car.x, y: car.y, a: car.a };

      move(car, other.x, other.y, other.a);
      move(other, old.x, old.y, old.a);
      break;

    default:
      return false;
  }

  return true;
}

    return {
    cars, stats,
    get now() { return now; },
    step, snapshot, spawn, remove, setAway,
    over, winnerId, survivedS, applyJerityAction,
    /** The round is decided: keep driving for the victory lap, but nothing hurts anymore. */
    celebrate() { celebrating = true; },
  };
}

function wrapAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}
