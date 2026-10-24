// server/sim.js
// Checks the game headless (no sockets, no waiting) in a terminal:
//   1. Driving: launch, top speed, coasting, turning, grip, tip-over, bounces, no pass-through,
//      each compared with what design.md and config.js say it should be.
//   2. One bot round, printing every event.
// Phase C adds scripted hits (side vs rear vs head-on, wall, kill).
//
// Run: npm run sim   (exits 1 if a check fails)

import { Vec2 } from 'planck';
import { CAR_STATE, EVENT } from '../shared/protocol.js';
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
  console.log(`${ok ? '  ok ' : 'FAIL '} ${name.padEnd(38)} ${got.toFixed(2).padStart(7)} ${unit.padEnd(4)} want ${want.toFixed(2)} ± ${tol}`);
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
  near('launch speed after one tick', speed(car), CONFIG.MIN_SPEED, 0.05, 'm/s');
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
  const { game, cars: [car] } = setup({ x: 44, y: 3, v: 12 }); // nose toward the right wall
  near('wall bounce (restitution)', bounceRatio(game, [COAST], () => -vx(car)), CONFIG.WALL_RESTITUTION, 0.1, '');
}
{
  const { game, cars: [car] } = setup({ x: 17, y: 15, v: 12 }); // toward the center pillar
  near('pillar bounce (restitution)', bounceRatio(game, [COAST], () => -vx(car)), CONFIG.OBSTACLE_RESTITUTION, 0.1, '');
}
{
  const { game, cars: [a, b] } = setup({ x: 15, y: 3, v: 10 }, { x: 25, y: 3, a: Math.PI, v: 10 });
  near('car-to-car bounce (restitution)', bounceRatio(game, [COAST, COAST], () => vx(b) - vx(a)), CONFIG.CAR_RESTITUTION, 0.1, '');
}
{
  const { game, cars: [a, b] } = setup({ x: 15, y: 3, v: spec.maxSpeed }, { x: 25, y: 3, a: Math.PI, v: spec.maxSpeed });
  let gap = Infinity;
  run(game, [ACCEL, ACCEL], CONFIG.TICK_HZ, () => {
    gap = Math.min(gap, b.body.getPosition().x - a.body.getPosition().x);
  });
  const length = CAR_SIZE.W / SCALE;
  check(`head-on at top speed: no pass-through (closest ${gap.toFixed(2)} m, cars ${length} m long)`,
    gap > length - 0.1, `closest ${gap}`);
}

console.log('\nOne bot round (stand-in hits until Phase C)');
{
  const bots = Array.from({ length: MIN_PLAYERS }, (_, i) => ({ id: `bot${i + 1}`, isBot: true }));
  const game = createGame(bots);
  const counts = {};
  while (!game.over()) {
    game.step(new Map(bots.map(b => [b.id, botInput(game, b)])), dt);
    for (const e of game.snapshot().events) {
      counts[e.type] = (counts[e.type] || 0) + 1;
      console.log(`${(game.now / 1000).toFixed(1).padStart(6)} s`, JSON.stringify(e));
    }
  }
  console.log(`round over at ${(game.now / 1000).toFixed(1)} s, winner: ${game.winnerId()}, events:`, counts);
  for (const b of bots) {
    const car = game.cars.get(b.id);
    const st = game.stats.get(b.id);
    console.log(`  ${b.id}  hp ${car.hp}  state ${car.s}  at (${car.x.toFixed(0)}, ${car.y.toFixed(0)})  kills ${st.kills}  damage ${st.damage}`);
  }
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall driving checks passed');
process.exit(failed ? 1 : 0);
