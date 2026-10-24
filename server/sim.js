// server/sim.js
// Checks the game headless (no sockets, no waiting) in a terminal:
//   1. Driving: launch, top speed, coasting, turning, grip, tip-over, bounces, no pass-through.
//   2. Hits and walls: side vs rear vs head-on, speed scaling, stun, wall penalty, kill reward.
//   3. One bot round, printing the events.
// Each check compares a measured number with what design.md and config.js say it should be.
//
// Run: npm run sim   (exits 1 if a check fails)

import { Vec2 } from 'planck';
import { CAR_STATE, EVENT, HIT_KIND, BUFF } from '../shared/protocol.js';
import { MIN_PLAYERS, SCALE, CAR_SIZE, CARS, DEFAULT_CAR } from '../shared/constants.js';
import { CONFIG } from '../shared/config.js';
import { createGame } from './game.js';
import { botInput } from './bots.js';

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
  const { game, cars: [car] } = setup({ x: 30, y: 3, v: spec.maxSpeed });
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
  const { game, cars: [car] } = setup({ x: 30, y: 3, v: spec.maxSpeed });
  const flipTick = run(game, [{ tilt: 1, accel: true, taps: 0 }], CONFIG.TICK_HZ,
    () => game.snapshot().events.some(e => e.type === EVENT.FLIP));
  near('full tilt at top speed: time to flip', flipTick * dt, CONFIG.FLIP_HOLD_MS / 1000, 0.05, 's');
  run(game, [{ ...COAST, taps: 3 }], 1);
  run(game, [{ ...COAST, taps: 5 }], 1);
  const recovered = game.snapshot().events.some(e => e.type === EVENT.RECOVER);
  check(`${CONFIG.RECOVER_TAPS} taps (3 + 5) recover`, car.s === CAR_STATE.ALIVE && recovered, `state ${car.s}`);
}

console.log('\nBounces and collisions');
{
  // A hard hit bounces at the surface's restitution, then keeps WALL_SPEED_KEEP of that speed.
  const { game, cars: [car] } = setup({ x: 44, y: 3, v: 12 }); // nose toward the right wall
  near('wall bounce (restitution x speed kept)', bounceRatio(game, [COAST], () => -vx(car)),
    CONFIG.WALL_RESTITUTION * CONFIG.WALL_SPEED_KEEP, 0.05, '');
}
{
  const { game, cars: [car] } = setup({ x: 17, y: 15, v: 12 }); // toward the center pillar
  near('pillar bounce (restitution x speed kept)', bounceRatio(game, [COAST], () => -vx(car)),
    CONFIG.OBSTACLE_RESTITUTION * CONFIG.WALL_SPEED_KEEP, 0.05, '');
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
{
  const { game, cars: [a, b] } = setup({ x: 28.975, y: 10, v: 6 }, { x: 31.025, y: 10, a: Math.PI, v: 6 });
  let headon = null;
  run(game, [COAST, COAST], CONFIG.TICK_HZ, () => (headon = game.snapshot().events.find(e => e.type === EVENT.HEADON)));
  const want = CONFIG.DMG_K * 12 * 12 * CONFIG.HEADON_MULT; // closing 6 + 6 m/s
  near('head-on at 6 + 6 m/s: damage each', headon?.dmg ?? NaN, want, want * DMG_SLACK, 'HP');
  check('head-on: both hurt equally and stunned',
    a.hp === b.hp && a.hp < spec.hp && a.s === CAR_STATE.STUNNED && b.s === CAR_STATE.STUNNED,
    `hp ${a.hp}/${b.hp}, states ${a.s}/${b.s}`);
  const stunTicks = run(game, [COAST, COAST], 3 * CONFIG.TICK_HZ,
    () => a.s === CAR_STATE.ALIVE && b.s === CAR_STATE.ALIVE);
  near('head-on stun lasts', stunTicks * dt, CONFIG.CONCUSSION_MS / 1000, 0.05, 's');
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
  // and they get past each other. Clear area: x 28-48, y 0-15.
  const { game, cars: [a, b] } = setup({ x: 32, y: 8 }, { x: 42, y: 8, a: Math.PI });
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
  const events = [];
  run(game, [COAST, COAST], 10, () => { events.push(...game.snapshot().events); });
  const kills = events.filter(e => e.type === EVENT.KILL);
  check('head-on that kills both: both die, no kill heal brings one back',
    a.s === CAR_STATE.DEAD && b.s === CAR_STATE.DEAD && kills.length === 2 && kills.every(k => k.heal === 0),
    `states ${a.s}/${b.s}, kills ${JSON.stringify(kills)}`);
}

console.log('\nOne bot round (wall hits counted, not printed)');
{
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
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
