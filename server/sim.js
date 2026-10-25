// server/sim.js
// Checks the game headless (no sockets, no waiting) in a terminal:
//   1. Driving: launch, top speed, coasting, turning, grip, tip-over, bounces, no pass-through.
//   2. Hits and walls: side vs rear vs head-on, speed scaling, stun, wall penalty, kill reward.
//   3. Knockback, the map (spawn lanes), and bots, then one bot round printing the events.
// Each check compares a measured number with what design.md and config.js say it should be.
//
// Run: npm run sim   (exits 1 if a check fails)

import { Vec2 } from 'planck';
import { CAR_STATE, EVENT, HIT_KIND, BUFF } from '../shared/protocol.js';
import {
  ARENA, MIN_PLAYERS, SCALE, CAR_SIZE, CARS, DEFAULT_CAR, OBSTACLES, SPAWN_POINTS,
} from '../shared/constants.js';
import { CONFIG } from '../shared/config.js';
import { createGame } from './game.js';
import { botInput } from './bots.js';

// These driving checks describe car-style driving (launch, turning radius); omni is checked separately.
CONFIG.DRIVE_MODE = 'car';
const dt = 1 / CONFIG.TICK_HZ;
const spec = CARS[DEFAULT_CAR];
const ACCEL = { tilt: 0, accel: true, taps: 0 };
const COAST = { tilt: 0, accel: false, taps: 0 };
let failed = 0;

function near(name, got, want, tol, unit) {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) failed++;
  console.log(`${ok ? '  ok ' : 'FAIL '} ${name.padEnd(38)} ${got.toFixed(2).padStart(7)} ${unit.padEnd(4)} want ${want.toFixed(2)} ± ${+tol.toFixed(2)}`);
}

function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? '  ok ' : 'FAIL '} ${name}${ok ? '' : `  (${detail})`}`);
}

// Cars at given spots in meters, heading `a`, moving forward at `v` m/s. The y = 3 m lane
// along the top wall and the area right of x = 28 m are clear of pillars.
function setup(...placed) {
  const game = createGame(placed.map((_, i) => ({ id: `c${i}` })));
  const cars = placed.map(({ x, y, a = 0, v = 0 }, i) => {
    const car = game.cars.get(`c${i}`);
    car.body.setTransform(Vec2(x, y), a);
    car.body.setLinearVelocity(Vec2(Math.cos(a) * v, Math.sin(a) * v));
    return car;
  });
  return { game, cars };
}

// Steps until `stop(tick)` returns true or `ticks` run out; returns the tick it stopped on.
function run(game, inputs, ticks, stop) {
  for (let i = 1; i <= ticks; i++) {
    game.step(new Map(inputs.map((inp, k) => [`c${k}`, inp])), dt);
    if (stop?.(i)) return i;
  }
  return ticks;
}

const speed = car => car.body.getLinearVelocity().length();
const vx = car => car.body.getLinearVelocity().x;

// First separating speed / last closing speed along x: the effective restitution.
function bounceRatio(game, inputs, relVx) {
  let closing = 0;
  let ratio = NaN;
  run(game, inputs, 3 * CONFIG.TICK_HZ, () => {
    const rel = relVx();
    if (rel < 0) closing = -rel;
    else if (closing > 0) { ratio = rel / closing; return true; }
  });
  return ratio;
}

console.log('Driving (design.md section 4)');
{
  const { game, cars: [car] } = setup({ x: 3, y: 3 });
  run(game, [ACCEL], 1);
  near('speed after one tick (launch + engine)', speed(car), CONFIG.MIN_SPEED + CONFIG.ENGINE * dt, 0.05, 'm/s');
  const ticks = run(game, [ACCEL], 4 * CONFIG.TICK_HZ, () => speed(car) >= spec.maxSpeed - 0.05) + 1;
  near('time to top speed', ticks * dt, (spec.maxSpeed - CONFIG.MIN_SPEED) / CONFIG.ENGINE, 0.1, 's');
  const top = speed(car);
  const half = run(game, [COAST], 4 * CONFIG.TICK_HZ, () => speed(car) <= top / 2);
  near('coasting: time to half speed', half * dt, Math.LN2 / CONFIG.COAST_DAMPING, 0.05, 's');
}
{
  const { game, cars: [car] } = setup({ x: 30, y: 3 });
  run(game, [{ tilt: 1, accel: false, taps: 0 }], CONFIG.TICK_HZ);
  near('full tilt at a standstill: turned', car.body.getAngle(), 0, 0.001, 'rad');
}
{
  // Regression: a car steering from rest used to stay stuck at MIN_SPEED.
  const { game, cars: [car] } = setup({ x: 40, y: 6 }); // spirals inside x 34-43, y 4-12
  run(game, [{ tilt: 0.8, accel: true, taps: 0 }], 2 * CONFIG.TICK_HZ);
  near('turning from rest (tilt 0.8): speed at 2 s', speed(car), spec.maxSpeed, 1, 'm/s');
}
{
  const tilt = 0.8; // just under FLIP_TILT
  const { game, cars: [car] } = setup({ x: 40, y: 3, v: spec.maxSpeed }); // turns inside x 34-47, y 3-14
  const p0 = Vec2.clone(car.body.getPosition());
  run(game, [{ tilt, accel: true, taps: 0 }], CONFIG.TICK_HZ);
  const turned = car.body.getAngle();
  const chord = Vec2.lengthOf(Vec2.sub(car.body.getPosition(), p0));
  const radius = (chord / (2 * Math.sin(turned / 2))) * SCALE;
  near(`turning radius at top speed, tilt ${tilt}`, radius, (spec.maxSpeed / (spec.turnRate * tilt)) * SCALE, 10, 'u');
  const fwd = car.body.getWorldVector(Vec2(1, 0));
  const v = car.body.getLinearVelocity();
  const slipDeg = Math.abs(Math.atan2(fwd.x * v.y - fwd.y * v.x, Vec2.dot(fwd, v))) * 180 / Math.PI;
  check(`grip: moving where it points (slip ${slipDeg.toFixed(1)} deg < 10)`, slipDeg < 10, `${slipDeg} deg`);
  check(`tilt ${tilt} at top speed never flips`, car.s === CAR_STATE.ALIVE, `state ${car.s}`);
}
{
  const { game, cars: [car] } = setup({ x: 40, y: 3, v: spec.maxSpeed }); // turns inside x 34-47, y 3-14
  const flipTick = run(game, [{ tilt: 1, accel: true, taps: 0 }], (CONFIG.FLIP_HOLD_MS / 1000 + 1) * CONFIG.TICK_HZ,
    () => game.snapshot().events.some(e => e.type === EVENT.FLIP)); // circling at full lock and top speed
  near('full tilt at top speed: time to flip', flipTick * dt, CONFIG.FLIP_HOLD_MS / 1000, 0.05, 's');
  run(game, [{ ...COAST, taps: 3 }], 1);
  run(game, [{ ...COAST, taps: 5 }], 1);
  const recovered = game.snapshot().events.some(e => e.type === EVENT.RECOVER);
  check(`${CONFIG.RECOVER_TAPS} taps (3 + 5) recover`, car.s === CAR_STATE.ALIVE && recovered, `state ${car.s}`);
}

console.log('\nBounces and collisions');
// Under MIN_IMPACT_SPEED a bump is not a crash: no knockback, only Planck's bounce at the
// surface's own restitution (Planck doesn't bounce at all under 1 m/s). Noses 0.5 m away.
const SLOW = CONFIG.MIN_IMPACT_SPEED * 0.9;
{
  const { game, cars: [car] } = setup({ x: 48.5, y: 10, v: SLOW }); // toward the right wall
  near('slow bump, wall (restitution)', bounceRatio(game, [COAST], () => -vx(car)), CONFIG.WALL_RESTITUTION, 0.1, '');
}
{
  const p = OBSTACLES[0];
  const { game, cars: [car] } = setup({ x: (p.x - p.r) / SCALE - 1.5, y: p.y / SCALE, v: SLOW }); // toward a pillar
  near('slow bump, pillar (restitution)', bounceRatio(game, [COAST], () => -vx(car)), CONFIG.OBSTACLE_RESTITUTION, 0.1, '');
}
{
  // Closing just under MIN_IMPACT_SPEED: not a hit, so no knockback, only Planck's bounce.
  // (Still above Planck's 1 m/s, under which it does not bounce at all.) Noses 0.5 m apart.
  const v = CONFIG.MIN_IMPACT_SPEED * 0.45;
  const { game, cars: [a, b] } = setup({ x: 19.75, y: 3, v }, { x: 22.25, y: 3, a: Math.PI, v });
  near('slow bump, car to car (restitution)', bounceRatio(game, [COAST, COAST], () => vx(b) - vx(a)), CONFIG.CAR_RESTITUTION, 0.1, '');
}
{
  const { game, cars: [a, b] } = setup({ x: 15, y: 3, v: spec.maxSpeed }, { x: 25, y: 3, a: Math.PI, v: spec.maxSpeed });
  a.invulnUntil = b.invulnUntil = Infinity; // a 28 m/s head-on one-shots both; keep them pushing
  let gap = Infinity;
  run(game, [ACCEL, ACCEL], CONFIG.TICK_HZ, () => {
    gap = Math.min(gap, (b.x - a.x) / SCALE);
  });
  const length = CAR_SIZE.W / SCALE;
  check(`head-on at top speed: no pass-through (closest ${gap.toFixed(2)} m, cars ${length} m long)`,
    gap > length - 0.1, `closest ${gap}`);
}

console.log('\nHits and walls (design.md section 5)');
// Measured hits come out a little under the formula: the attacker coasts one tick (about 4%
// slower) before the touch registers, and dealt damage is rounded.
const DMG_SLACK = 0.12;
const NORTH = -Math.PI / 2;

// Two cars 5 cm apart on the y = 10 m line (clear of pillars), both coasting. Collects events for 1 s.
function crash(a, b, { hpA, hpB } = {}) {
  const { game, cars } = setup({ y: 10, ...a }, { y: 10, ...b });
  if (hpA) cars[0].hp = hpA;
  if (hpB) cars[1].hp = hpB;
  const events = [];
  run(game, [COAST, COAST], CONFIG.TICK_HZ, () => { events.push(...game.snapshot().events); });
  return { game, cars, events, hits: events.filter(e => e.type === EVENT.HIT) };
}
const side = v => crash({ x: 28.35, v }, { x: 30, a: NORTH }); // A's nose into B's side
const rear = v => crash({ x: 27.95, v }, { x: 30 });           // A's nose into B's tail
const sideDmg = v => CONFIG.DMG_K * v * v;                       // nose square into a side, equal masses
{
  const slow = side(5);
  const fast = side(10);
  const s5 = slow.hits[0]?.dmg ?? NaN;
  const s10 = fast.hits[0]?.dmg ?? NaN;
  near('side hit at 5 m/s: damage', s5, sideDmg(5), sideDmg(5) * DMG_SLACK, 'HP');
  near('side hit at 10 m/s: damage', s10, sideDmg(10), sideDmg(10) * DMG_SLACK, 'HP');
  near('twice the speed: damage ratio', s10 / s5, 4, 0.3, 'x');
  const h = slow.hits[0];
  check('the rammer is the attacker, kind side', h?.attacker === 'c0' && h?.victim === 'c1' && h?.kind === HIT_KIND.SIDE, JSON.stringify(h));
  check('one crunch counts once', slow.hits.length === 1 && fast.hits.length === 1, `${slow.hits.length} and ${fast.hits.length} hits`);
}
{
  const s = side(8).hits[0];
  const r = rear(8).hits[0];
  near('rear vs side at 8 m/s: damage ratio', (r?.dmg ?? NaN) / (s?.dmg ?? NaN), 1 + CONFIG.REAR_BONUS, 0.06, 'x');
  check("a hit from behind is kind 'rear'", r?.kind === HIT_KIND.REAR, JSON.stringify(r));
}
// Head-on: two cars nose to nose on the y = 10 m line, 5 cm apart, coasting at vA and vB.
function headOn(vA, vB) {
  const { game, cars } = setup({ x: 28.975, y: 10, v: vA }, { x: 31.025, y: 10, a: Math.PI, v: vB });
  let event = null;
  run(game, [COAST, COAST], CONFIG.TICK_HZ, () => (event = game.snapshot().events.find(e => e.type === EVENT.HEADON)));
  return { game, cars, event };
}
const headonDmg = v => CONFIG.DMG_K * v * v * CONFIG.HEADON_MULT; // from the other car's speed into you
{
  const { game, cars: [a, b], event } = headOn(10, 10);
  near('head-on at 10 + 10 m/s: damage each', event?.dmgA ?? NaN, headonDmg(10), headonDmg(10) * DMG_SLACK, 'HP');
  check('head-on: both hurt equally and stunned',
    a.hp === b.hp && a.hp < spec.hp && a.s === CAR_STATE.STUNNED && b.s === CAR_STATE.STUNNED,
    `hp ${a.hp}/${b.hp}, states ${a.s}/${b.s}`);
  const stunTicks = run(game, [COAST, COAST], 3 * CONFIG.TICK_HZ,
    () => a.s === CAR_STATE.ALIVE && b.s === CAR_STATE.ALIVE);
  near('head-on stun lasts', stunTicks * dt, CONFIG.CONCUSSION_MS / 1000, 0.05, 's');
}
{
  // A fast rammer meets a car that only just started toward it: the rammer hits far harder.
  const { cars: [a, b], event } = headOn(12, 4);
  const tookA = spec.hp - a.hp, tookB = spec.hp - b.hp;
  check(`head-on, 12 vs 4 m/s: the slow car takes the big hit (${tookB} HP vs ${tookA} HP)`,
    tookB > tookA && event?.dmgA === tookA && event?.dmgB === tookB, JSON.stringify(event));
  near('...damage ratio, (12 / 4)^2', tookB / tookA, 9, 1.5, 'x');
}
{
  const { game, cars: [car] } = setup({ x: 48.95, y: 10, v: spec.maxSpeed }); // nose 5 cm from the right wall
  let wall = null;
  run(game, [COAST], CONFIG.TICK_HZ, () => (wall = game.snapshot().events.find(e => e.type === EVENT.WALL)));
  const want = CONFIG.WALL_DMG_K * spec.maxSpeed ** 2;
  near('wall at top speed: self-damage', wall?.dmg ?? NaN, want, want * DMG_SLACK, 'HP');
  check(`wall hit keeps at most ${CONFIG.WALL_SPEED_KEEP * 100}% of the speed (${speed(car).toFixed(1)} m/s left)`,
    speed(car) <= CONFIG.WALL_SPEED_KEEP * spec.maxSpeed, `${speed(car)} m/s`);
}
{
  const { game } = setup({ x: 48.95, y: 10, v: 2 });
  const events = [];
  run(game, [COAST], CONFIG.TICK_HZ, () => { events.push(...game.snapshot().events); });
  check('gentle wall bump (under WALL_MIN_SPEED) is free', !events.some(e => e.type === EVENT.WALL), JSON.stringify(events));
}
{
  // Holding accel nose-first into a wall: one crash, then it bounces off instead of grinding HP away.
  const { game, cars: [car] } = setup({ x: 46, y: 10 }); // nose 3 m from the right wall
  let afterCrash = null;
  run(game, [ACCEL], 4 * CONFIG.TICK_HZ, () => {
    if (afterCrash === null && game.snapshot().events.some(e => e.type === EVENT.WALL)) afterCrash = car.hp;
  });
  check(`holding accel into a wall for 4 s: no grinding (${afterCrash - car.hp} HP lost after the first crash)`,
    afterCrash !== null && car.hp === afterCrash, `crash left ${afterCrash} HP, now ${car.hp}`);
}
{
  // Regression: rolling backwards off a wall (a knock) without reversing used to steer like
  // reversing, swinging the nose back into the wall every bounce: bots stayed pinned forever.
  const { game, cars: [car] } = setup({ x: 46, y: 15, v: -2 }); // facing the right wall, rolling back off it
  run(game, [{ tilt: -CONFIG.BOT_TILT_MAX, accel: false, taps: 0 }], Math.round(0.5 / dt));
  const turned = car.body.getAngle() * 180 / Math.PI; // negative = the way it tilts (left)
  check(`rolling back off a wall, not reversing: steers the way you tilt (${turned.toFixed(0)} deg)`, turned < 0, `${turned} deg`);
}
{
  const { game, cars: [a, b], events } = crash({ x: 28.35, v: 5 }, { x: 30, a: NORTH }, { hpA: 70, hpB: 5 });
  const kill = events.find(e => e.type === EVENT.KILL);
  const wantBuff = CONFIG.KILL_BUFF === 'shield' ? BUFF.SHIELD : BUFF.BOOST;
  check('kill: credited to the rammer', kill?.attacker === 'c0' && kill?.victim === 'c1', JSON.stringify(kill));
  near('kill: killer heals', kill?.heal ?? NaN, Math.round(spec.hp * CONFIG.KILL_HEAL_FRAC), 0, 'HP');
  check('kill: killer gets the buff', kill?.buff === wantBuff && a.buff === wantBuff, `event ${kill?.buff}, car ${a.buff}`);
  const wreck = game.snapshot().cars.find(c => c.id === 'c1');
  check('kill: wreck stays in snapshots (for the KO effect)', wreck?.s === CAR_STATE.DEAD && !b.body, JSON.stringify(wreck));
}

console.log('\nKnockback (no grinding, no sliding along, room to steer past)');
const fwdSpeed = car => Vec2.dot(car.body.getWorldVector(Vec2(1, 0)), car.body.getLinearVelocity());
{
  // Side ram at 10 m/s, and the rammer keeps holding accel.
  const { game, cars: [a, b] } = setup({ x: 28.35, y: 10, v: 10 }, { x: 30, y: 10, a: NORTH });
  const dist = () => Math.hypot(a.x - b.x, a.y - b.y) / SCALE;
  run(game, [ACCEL, COAST], CONFIG.TICK_HZ, () => game.snapshot().events.some(e => e.type === EVENT.HIT));
  check(`side ram: the rammer bounces back (${fwdSpeed(a).toFixed(1)} m/s forward)`, fwdSpeed(a) < 0, `${fwdSpeed(a)} m/s`);
  const d0 = dist();
  run(game, [ACCEL, COAST], Math.round(CONFIG.KNOCKBACK_MS / 1000 / dt));
  check(`side ram, accel still held: cars come apart (${(dist() - d0).toFixed(1)} m in ${CONFIG.KNOCKBACK_MS} ms)`,
    dist() - d0 >= 1, `${dist() - d0} m`);
}
{
  // Both drive at each other from rest and concuss. After the stun, a short steer right each
  // and they get past each other. Along the open middle of the arena (y = 15 m).
  const { game, cars: [a, b] } = setup({ x: 20, y: 15 }, { x: 30, y: 15, a: Math.PI });
  let headons = 0;
  const count = () => { headons += game.snapshot().events.filter(e => e.type === EVENT.HEADON).length; };
  run(game, [ACCEL, ACCEL], 2 * CONFIG.TICK_HZ, () => { count(); return headons > 0; });
  run(game, [COAST, COAST], Math.round(CONFIG.CONCUSSION_MS / 1000 / dt), count);
  const gap = Math.hypot(a.x - b.x, a.y - b.y) / SCALE;
  check(`head-on: ${gap.toFixed(1)} m apart when the stun ends (room to steer past)`, gap >= 10, `${gap} m`);
  const RIGHT = { tilt: 0.5, accel: true, taps: 0 };
  run(game, [RIGHT, RIGHT], Math.round(0.4 / dt), count);
  run(game, [ACCEL, ACCEL], Math.round(1.1 / dt), count);
  check('after the stun, a short steer gets them past each other (one head-on total)', headons === 1, `${headons} head-ons`);
}
{
  const { game, cars: [a, b] } = setup({ x: 28.975, y: 10, v: spec.maxSpeed }, { x: 31.025, y: 10, a: Math.PI, v: spec.maxSpeed });
  a.hp = b.hp = Math.floor(headonDmg(spec.maxSpeed) / 2); // low enough that a top-speed head-on kills both
  const events = [];
  run(game, [COAST, COAST], 10, () => { events.push(...game.snapshot().events); });
  const kills = events.filter(e => e.type === EVENT.KILL);
  check('head-on that kills both: both die, no kill heal brings one back',
    a.s === CAR_STATE.DEAD && b.s === CAR_STATE.DEAD && kills.length === 2 && kills.every(k => k.heal === 0),
    `states ${a.s}/${b.s}, kills ${JSON.stringify(kills)}`);
}

console.log('\nMap');
{
  // From every spawn point, holding accel straight ahead reaches the middle without a bump.
  const ids = SPAWN_POINTS.map((_, i) => ({ id: `c${i}` }));
  const blocked = [];
  for (let k = 0; k < SPAWN_POINTS.length; k++) {
    const game = createGame(ids.slice(0, k + 1)); // car k starts at spawn point k
    for (let j = 0; j < k; j++) game.remove(`c${j}`);
    const car = game.cars.get(`c${k}`);
    const input = new Map([[`c${k}`, ACCEL]]);
    let bumps = 0;
    for (let t = 0; t < 3 * CONFIG.TICK_HZ && Math.hypot(car.x - ARENA.W / 2, car.y - ARENA.H / 2) > CAR_SIZE.W; t++) {
      game.step(input, dt);
      bumps += game.snapshot().events.length;
    }
    const reached = Math.hypot(car.x - ARENA.W / 2, car.y - ARENA.H / 2) <= CAR_SIZE.W;
    if (!reached || bumps) blocked.push(`spawn ${k}${reached ? '' : ' (never reached the middle)'}`);
  }
  check(`all ${SPAWN_POINTS.length} spawn points have a clear drive to the middle`, !blocked.length, blocked.join(', '));
}

console.log('\nBots');
{
  // Bots aim at the nearest car: target to the right of the nose -> positive tilt, never at FLIP_TILT.
  const game = createGame([{ id: 'bot' }, { id: 'near' }, { id: 'far' }]); // 'bot' < 'near': the bot is the one that swerves
  const [bot, near, far] = ['bot', 'near', 'far'].map(id => game.cars.get(id));
  Object.assign(bot, { x: 500, y: 300, a: 0 }); // facing +x; +y (down) is to its right
  Object.assign(far, { x: 100, y: 300 });
  // `a` is the target's heading: 0 = facing away from the bot, PI = facing it.
  const tiltAt = (x, y, a = 0) => { Object.assign(near, { x, y, a }); return botInput(game, { id: 'bot' }).tilt; };
  const right = tiltAt(600, 400), left = tiltAt(600, 200), ahead = tiltAt(650, 300), behind = tiltAt(400, 290);
  check(`a bot turns toward the nearest car (right ${right.toFixed(2)}, left ${left.toFixed(2)}, ahead ${ahead.toFixed(2)})`,
    right > 0 && left < 0 && ahead === 0, JSON.stringify({ right, left, ahead }));
  check(`a bot never tilts past BOT_TILT_MAX ${CONFIG.BOT_TILT_MAX} (< FLIP_TILT ${CONFIG.FLIP_TILT}), even turning around`,
    Math.abs(behind) <= CONFIG.BOT_TILT_MAX && CONFIG.BOT_TILT_MAX < CONFIG.FLIP_TILT, `${behind}`);
  const dodge = tiltAt(650, 300, Math.PI);
  check(`a car coming straight at a bot: it swerves to flank (tilt ${dodge.toFixed(2)}) instead of a head-on`, dodge > 0, `${dodge}`);
}

function botRound(mode) {
  CONFIG.DRIVE_MODE = mode;
  console.log(`\nOne bot round, ${mode} mode (wall hits counted, not printed)`);
  const bots = Array.from({ length: MIN_PLAYERS }, (_, i) => ({ id: `bot${i + 1}`, isBot: true }));
  const game = createGame(bots);
  const counts = {};
  while (!game.over()) {
    game.step(new Map(bots.map(b => [b.id, botInput(game, b)])), dt);
    for (const e of game.snapshot().events) {
      counts[e.type] = (counts[e.type] || 0) + 1;
      if (e.type !== EVENT.WALL) console.log(`${(game.now / 1000).toFixed(1).padStart(6)} s`, JSON.stringify(e));
    }
  }
  console.log(`round over at ${(game.now / 1000).toFixed(1)} s, winner: ${game.winnerId()}, events:`, counts);
  for (const b of bots) {
    const car = game.cars.get(b.id);
    const st = game.stats.get(b.id);
    console.log(`  ${b.id}  hp ${car.hp}  state ${car.s}  at (${car.x.toFixed(0)}, ${car.y.toFixed(0)})  kills ${st.kills}  damage ${st.damage}`);
  }
  check(`${mode}: bots find each other (car-to-car hits in the round)`, (counts.hit || 0) + (counts.headon || 0) > 0, JSON.stringify(counts));
  check(`${mode}: no bot flips`, !counts.flip, JSON.stringify(counts));
}
botRound('car');

console.log('\nDisconnects (a ghost until the phone rejoins)');
{
  // Drive straight through an away car's spot: no collision, and the ghost stays put, unhurt.
  const { game, cars: [a, ghost] } = setup({ x: 25, y: 15, v: 10 }, { x: 30, y: 15, a: NORTH });
  game.setAway('c1', true);
  const events = [];
  run(game, [ACCEL, COAST], CONFIG.TICK_HZ, () => { events.push(...game.snapshot().events); });
  check(`an away car is a ghost: driven straight through, unhurt (${ghost.hp} HP)`,
    a.x / SCALE > 31 && ghost.hp === spec.hp && ghost.s === CAR_STATE.DISCONNECTED
      && !events.some(e => e.type === EVENT.HIT || e.type === EVENT.HEADON),
    `driver at x ${a.x / SCALE}, ghost ${ghost.hp} HP state ${ghost.s}, ${JSON.stringify(events)}`);
  check('...and frozen where it dropped', Math.hypot(ghost.x / SCALE - 30, ghost.y / SCALE - 15) < 0.01, `(${ghost.x}, ${ghost.y})`);
  game.setAway('c1', false);
  check('back: drives again, briefly invulnerable', ghost.s === CAR_STATE.ALIVE && ghost.invulnUntil > game.now, `state ${ghost.s}`);
}
{
  // Bots don't chase ghosts: the nearest car ahead is away, so the bot turns toward the other one.
  const game = createGame([{ id: 'bot' }, { id: 'away' }, { id: 'far' }]);
  game.setAway('away', true);
  Object.assign(game.cars.get('bot'), { x: 500, y: 300, a: 0 });
  Object.assign(game.cars.get('away'), { x: 600, y: 300 });
  Object.assign(game.cars.get('far'), { x: 500, y: 500, a: 0 }); // to the bot's right
  const tilt = botInput(game, { id: 'bot' }).tilt;
  check(`bots ignore away cars (tilt ${tilt.toFixed(2)} toward the car on its right)`, tilt > 0, `${tilt}`);
}

// ---------------------------------------------------------------------------
// Omni: the game's default DRIVE_MODE. The phone's tilt is a direction on screen.
// ---------------------------------------------------------------------------

console.log(`\nOmni driving (the default DRIVE_MODE)`);
CONFIG.DRIVE_MODE = 'omni';
const tiltTo = (x, y) => ({ tilt: x, throttle: -y, taps: 0 }); // a screen direction: +x right, +y down
const angleOf = car => { const v = car.body.getLinearVelocity(); return Math.atan2(v.y, v.x); };
const degBetween = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) * 180 / Math.PI;
{
  // Full tilt to the right from rest, with the nose starting out pointing up the screen.
  const { game, cars: [car] } = setup({ x: 8, y: 15, a: -Math.PI / 2 });
  const ticks = run(game, [tiltTo(1, 0)], 4 * CONFIG.TICK_HZ, () => speed(car) >= spec.maxSpeed - 0.1);
  near('full tilt from rest: time to top speed', ticks * dt, spec.maxSpeed / CONFIG.OMNI_ACCEL, 0.1, 's');
  near('...moving the way the phone tilts', degBetween(angleOf(car), 0), 0, 3, 'deg');
  near('...nose turned to face where it goes', degBetween(car.body.getAngle(), angleOf(car)), 0, 10, 'deg');
}
{
  // Half tilt up the screen (between the top pillars): cruise at half speed, heading up.
  const { game, cars: [car] } = setup({ x: 25, y: 26 });
  run(game, [tiltTo(0, -0.5)], 3 * CONFIG.TICK_HZ);
  near('half tilt: cruise speed', speed(car), spec.maxSpeed / 2, 0.3, 'm/s');
  near('...up the screen', degBetween(angleOf(car), -Math.PI / 2), 0, 3, 'deg');
}
{
  const { game, cars: [car] } = setup({ x: 8, y: 15, v: spec.maxSpeed });
  const half = run(game, [tiltTo(0, 0)], 4 * CONFIG.TICK_HZ, () => speed(car) <= spec.maxSpeed / 2);
  near('no tilt: coasting to half speed', half * dt, Math.LN2 / CONFIG.COAST_DAMPING, 0.05, 's');
}
{
  // At top speed going right, yank the phone the other way. Omni tips over only if that is held
  // FLIP_HOLD_MS at speed; the yank swings the car around (or stops it) well before 2.5 s, so
  // with that hold time omni cars don't flip. Shows whether a tuning change brings flips back.
  const { game, cars: [car] } = setup({ x: 8, y: 15, v: spec.maxSpeed });
  const flipTick = run(game, [tiltTo(-1, 0)], (CONFIG.FLIP_HOLD_MS / 1000 + 1) * CONFIG.TICK_HZ,
    () => game.snapshot().events.some(e => e.type === EVENT.FLIP));
  const flipped = car.s === CAR_STATE.FLIPPED;
  console.log(`  ..  yanking the other way at top speed: ${flipped ? `tips over after ${(flipTick * dt).toFixed(2)} s` : 'no tip-over (omni flips are off at this FLIP_HOLD_MS)'}`);
}
{
  // A 45 degree change of direction at top speed is just a turn.
  const { game, cars: [car] } = setup({ x: 8, y: 15, v: spec.maxSpeed });
  const events = [];
  run(game, [tiltTo(Math.SQRT1_2, -Math.SQRT1_2)], CONFIG.TICK_HZ, () => { events.push(...game.snapshot().events); });
  check('a 45 degree turn at top speed does not tip over', car.s === CAR_STATE.ALIVE && !events.some(e => e.type === EVENT.FLIP),
    `state ${car.s}, ${JSON.stringify(events)}`);
}
{
  // Holding the tilt into a wall: one crash, then it bounces off instead of grinding HP away.
  const { game, cars: [car] } = setup({ x: 46, y: 15 }); // nose 3 m from the right wall
  let afterCrash = null;
  run(game, [tiltTo(1, 0)], 4 * CONFIG.TICK_HZ, () => {
    if (afterCrash === null && game.snapshot().events.some(e => e.type === EVENT.WALL)) afterCrash = car.hp;
  });
  check(`holding the tilt into a wall for 4 s: no grinding (${afterCrash - car.hp} HP lost after the first crash)`,
    afterCrash !== null && car.hp === afterCrash, `crash left ${afterCrash} HP, now ${car.hp}`);
}
botRound('omni');

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
