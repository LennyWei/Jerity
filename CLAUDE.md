# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Bumper Brawl: a free-for-all bumper-car game for 4 to 8 players in the phone browser, built at HackPSU Fall 2026 (Mystery Stack track: phone motion, rivalry, group of 4+). Phones tilt to steer and hold a button to accelerate; the Node server runs all physics and broadcasts snapshots.

**Read `design.md` before making non-trivial changes.** It is the spec for mechanics, formulas, and scope. The root `design.md` is authoritative; `ideaDocuments/design.md` is an older draft (still lists team modes as goals), ignore it.

## Who I am and what I own

I am Person 1: **server and physics**. I own `server/index.js`, `server/rooms.js`, `server/game.js`, `server/bots.js`.

Other people own (do not rewrite their files without asking me first):
- Person 2: `client/src/input.js`, `render.js`, `interp.js`, game screen
- Person 3: `server/mechanics.js`, `shared/config.js` (tuning)
- Person 4: deployment, `deploy.sh`, lobby/home/results/spectate screens, art, pitch

## Deadline

Demo Sunday Oct 25, 2:00 PM ET. Feature freeze Sunday noon. Prefer working and simple over clever.

## Scope (MVP = FFA only)

In: FFA rooms, tilt + accel driving, speed- and direction-scaled car damage, head-on concussion, tip-over with tap recovery, wall/pillar penalty, kill heal + buff, scoring, round end, spectator.

Out until FFA is done: team modes (2v2/3v3/4v4), car picking, items/perks, parry, accounts. Do not add code for these.

## Commands

```
npm install
npm run dev           # real server on :3000, restarts on file changes; room TEST always running with 3 bots
npm start             # same without watching (what pm2 runs)
npm run sim           # one headless round through game.js, no sockets; prints events
npm run fake          # fake server on :3000 (same port: run one or the other)
npm run fake:client   # headless player that joins TEST and logs everything
npm run dev:client    # Vite client with HMR; proxies /socket.io to :3000
npm run dev:phone     # same over HTTPS (self-signed) so phones allow motion sensors
npm run build         # client -> client/dist, which the server serves
```

Env vars: `PORT` (server, default 3000); `SERVER` and `CODE` (fake client, defaults `http://localhost:3000` and `TEST`). `/health` returns `{ ok, rooms }`.

There is no test runner or linter; testing is `npm run sim`, the fake client, and checking by hand (see Testing).

## Layout

```
shared/protocol.js    THE CONTRACT: event names, payload shapes, CAR_STATE, EVENT, BUFF, packCar, sanitizeInput
shared/constants.js   arena 1000x600, SCALE, obstacles, car stats, colors, MIN/MAX_PLAYERS
shared/config.js      every tunable number
server/fake.js        fake server (kinematic cars, random car-to-car events); clients build against it
server/fake-client.js headless test player
design.md             full spec
```

Data flow: phone sends `C2S.INPUT` at `INPUT_HZ` (30); server stores the latest sanitized input per player (adding taps), steps physics at `TICK_HZ` (30), and emits `S2C.SNAP` at `SNAP_HZ` (20) with packed cars plus all `EVENT`s queued since the last snapshot. Clients only interpolate and render. Room lifecycle is `ROOM_STATE`: lobby → countdown → playing → roundEnd. The fake server serves `client/dist` statically on the same port.

## Rules

- **Never change `shared/protocol.js` without telling the team.** Phones, spectator, and server all depend on it. Adding an optional field is OK after a heads-up; renaming or removing is not.
- **No hardcoded numbers.** Tunables go in `shared/config.js`, fixed facts in `shared/constants.js`.
- **Always use the constants** (`C2S.INPUT`, `CAR_STATE.FLIPPED`, `EVENT.HIT`), never raw strings.
- **Units:** the protocol, rendering, and `constants.js` use world units (arena 1000 x 600). Planck and all speeds in `config.js` use meters and m/s. Convert with `SCALE = 20` (world units per meter) only at the boundary: in `game.js` when creating bodies and when building snapshots.
- **Server is authoritative.** Never trust input; always run it through `sanitizeInput`. No client prediction.
- **Taps are a count, not a boolean.** Accumulate `input.taps` on the player until a tick consumes it.
- ES modules everywhere (`"type": "module"`), Node 20.

## Building the real server (my next steps)

1. **`rooms.js`:** lift room logic from `fake.js` as-is (codes, join/leave, colors, ready, host start, countdown, round end, scoring, TEST room). It already matches the contract.
2. **`game.js`:** replace `stepCar` and `fakeEvents` with a Planck world per room:
   - World gravity `(0, 0)`; 4 static wall edges; static circles from `OBSTACLES`; dynamic 40x24 box per car (in meters: 2 x 1.2).
   - Fixed `dt = 1/TICK_HZ`, `world.step(dt, 8, 3)`.
   - Driving per design.md section 4: lateral grip impulse, instant launch to `MIN_SPEED`, engine force to `maxSpeed`, `angularVelocity = tilt * turnRate * min(1, speed / MIN_SPEED)`, boost buff multipliers.
   - States: stunned (no input, coast), flipped (no input, heavy damping, count taps), dead (destroy body).
   - Collect contacts in `post-solve` into a queue with velocities and the world normal; apply after `step`, never inside the callback.
3. **Hook in `mechanics.js` (Person 3):** call pure functions for car-car hits (head-on vs side/rear), wall/pillar hits, tip-over check, kill reward, scoring. If they are not ready, keep the equivalent logic from `fake.js` (`applyDamage`, `checkDeath`, `surfaceHit`, flip check) and swap later.
4. **`bots.js`:** steer toward the nearest living car, accel on, tilt clamped below `FLIP_TILT` so bots never flip.
5. **`index.js`:** Express serving `client/dist` + Socket.IO on one port; `/health` endpoint.

Keep `fake.js` working until the real server passes the same tests; clients may still be pointed at it.

## Testing

- `npm run fake:client` (works against the real server too: `SERVER=http://localhost:3000`).
- Create a room with `{ bots: 4 }` to test collisions alone.
- Check by hand: a full-speed side hit does more than a slow one; rear > side; head-on stuns both for ~1.5 s; holding full tilt at full speed flips after ~0.4 s; 8 taps recovers; wall hits cost speed and a little HP; a kill heals the killer 30% and sets `buff`.
- Snapshots must stay small: always go through `packCar`.

## Deployment (Person 4 sets up; know the shape)

Ubuntu VM, Node 20, pm2, Caddy reverse proxy on `<ip-with-dashes>.sslip.io` for automatic HTTPS (iPhone tilt requires HTTPS). Demo runs on a phone hotspot, not venue Wi-Fi.
