# Bumper Brawl: Design Document

HackPSU Fall 2026, Mystery Stack track (phone motion, rivalry, group of 4+).

A multiplayer bumper-car arena game played in the phone browser. Players tilt their phone to steer, hold a button to accelerate, and ram opponents at high speed to deal damage. Modes: FFA (4 to 8 players), 2v2, 3v3, 4v4. Last car or team standing wins the round.

---

## 1. Goals and non-goals

**Goals (must ship)**
- Join a room on a phone browser with a 4-letter code or QR; no install.
- Tilt steering that feels good on a real iPhone and Android phone.
- Server-authoritative physics for up to 8 cars at 30 Hz.
- Directional, speed-scaled collision damage; elimination; round end.
- Tip-over with tap-to-recover.
- Laptop spectator view with leaderboard and kill feed.

**Stretch (only after the core is fun)**
- Parry with cooldown.
- Three car presets.
- Sounds and hit effects.

**Non-goals (cut, do not start)**
- Accounts, currency, shop, persistent unlocks.
- Client-side prediction or lag compensation.
- Native app.

---

## 2. Architecture

```
 Phone (browser)           Server (Node, HTTPS)              Laptop (browser)
 ┌──────────────┐  input   ┌──────────────────────────┐  snap  ┌──────────────┐
 │ tilt / accel ├────────► │ Socket.IO rooms          ├──────► │ spectator    │
 │ taps         │  20-30Hz │ Planck.js world @ 30 Hz  │  20 Hz │ renderer     │
 │ renderer     │ ◄────────┤ mechanics (damage, flip) │        │ leaderboard  │
 └──────────────┘ snapshot └──────────────────────────┘        └──────────────┘
                  + events
```

- **The server owns all game state.** Phones only send inputs and draw what the server says.
- **No prediction.** Inputs reach the server in ~50 to 100 ms; for heavy bumper cars this reads as weight, not lag.
- **One process serves everything:** Express serves the built client, Socket.IO runs on the same port. No CORS.

### Stack
| Layer | Choice |
|---|---|
| Server | Node 20, Express, Socket.IO, Planck.js |
| Client | Vite, vanilla JS (or Pixi.js if someone knows it), HTML canvas |
| Shared | `/shared` plain JS modules imported by both |
| Hosting | One cloud VM (Ubuntu), Caddy for automatic HTTPS, pm2 |

### Repo layout
```
/shared
  protocol.js      message names and shapes
  config.js        every tunable number
  constants.js     arena size, car presets, team colors
/server
  index.js         express + socket.io bootstrap
  rooms.js         room lifecycle, join codes, teams
  game.js          planck world, tick loop, snapshot builder
  mechanics.js     damage, flip, parry, scoring (pure functions)
  bots.js          dummy inputs for solo testing
/client
  index.html
  src/main.js      screen router
  src/net.js       socket wrapper
  src/input.js     tilt, accel, taps, calibration
  src/render.js    arena + cars + effects (shared with spectator)
  src/interp.js    snapshot buffer and interpolation
  src/screens/     lobby.js, game.js, spectate.js, results.js
  public/          sprites, sounds, manifest.json
deploy.sh
```

---

## 3. Protocol (`/shared/protocol.js`)

Freeze this in the first hour. Changes require a quick team ping.

### Client to server
| Event | Payload | Notes |
|---|---|---|
| `createRoom` | `{ name }` | ack returns `{ code, playerId }` |
| `joinRoom` | `{ code, name }` | ack returns `{ playerId }` or `{ error }` |
| `setTeam` | `{ team }` | 0 to 3, ignored in FFA |
| `pickCar` | `{ car }` | `'balanced' \| 'heavy' \| 'light'` |
| `setMode` | `{ mode }` | host only: `'ffa' \| '2v2' \| '3v3' \| '4v4'` |
| `ready` | `{ ready }` | |
| `start` | `{}` | host only |
| `input` | `{ seq, tilt, accel, taps }` | 30 Hz while playing |

`taps` is the **count of taps since the last input message**, not a boolean. A boolean sent at 30 Hz loses fast taps during flip recovery.

### Server to client
| Event | Payload |
|---|---|
| `lobby` | `{ code, mode, hostId, players: [{ id, name, team, car, ready }] }` |
| `countdown` | `{ seconds }` |
| `snap` | `{ t, cars: [{ id, x, y, a, hp, s, parry }] }` (s: 0 alive, 1 flipped, 2 dead) |
| `events` | `[{ type, ...}]` batched with each snapshot |
| `roundEnd` | `{ winner, leaderboard: [{ id, name, kills, survived, score }] }` |

Event types: `hit {attacker, victim, dmg}`, `wall {id}`, `flip {id}`, `recover {id}`, `parry {id, attacker}`, `kill {attacker, victim}`.

Keep snapshots small: round x, y to 1 decimal, angle to 2 decimals, hp to integer.

---

## 4. World and physics (`/server/game.js`)

- Arena: **1000 x 600 world units**. Planck scale: `SCALE = 20` units per meter, so the Planck world is 50 x 30 m.
- Top-down: world gravity `(0, 0)`.
- Walls: four static edge bodies, restitution 0.3.
- Obstacles: 2 to 3 static circles (pillars) with restitution 0.8 so they bounce rather than stop.
- Car body: dynamic box 40 x 24 units, `fixedRotation: false`, density from preset, restitution 0.5.
- Spawns: evenly spaced on a circle of radius 220 around the center, facing the center. Teammates adjacent.

### Tick loop (30 Hz, fixed timestep `dt = 1/30`)
For each alive car, using its latest input:

1. **Lateral grip** (classic top-down car): remove sideways velocity so the car drives like a car, not a puck.
   `lat = right · v; apply impulse -lat * mass * GRIP` (GRIP 0.9)
2. **Throttle:** if `accel`:
   - If forward speed < `MIN_SPEED`, set forward speed to `MIN_SPEED` (instant launch).
   - Else apply forward force `ENGINE * mass` until speed reaches `maxSpeed`.
   If not `accel`: linear damping `COAST_DAMPING`.
3. **Steering:** `angularVelocity = tilt * turnRate * min(1, speed / MIN_SPEED)` (no spinning in place).
4. **Tip-over check** (see 5.2).
5. Step world: `world.step(dt, 8, 3)`.
6. Process queued contacts (see 5.1), then deaths, then win check.
7. Every 3rd tick out of 2 (i.e. 20 Hz): broadcast `snap` + `events`.

Collect contacts in the Planck `post-solve` listener into a queue; apply damage after `step`, never inside the callback.

---

## 5. Mechanics (`/server/mechanics.js`)

Write these as pure functions taking plain numbers so they can be unit-tested before the server exists.

### 5.1 Car-to-car damage (directional, speed-squared)

For a contact between car A and car B, let `n` be the unit normal from A to B.

```
approachA = max(0, dot(vA, n))          // A's speed into B
approachB = max(0, dot(vB, -n))         // B's speed into A
frontA    = max(0, dot(forwardA, n))    // 1 if A hit with its nose
frontB    = max(0, dot(forwardB, -n))

dmgToB = DMG_K * approachA² * (0.3 + 0.7*frontA) * (1 - 0.5*frontB) * (massA / massB)^0.5
dmgToA = DMG_K * approachB² * (0.3 + 0.7*frontB) * (1 - 0.5*frontA) * (massB / massA)^0.5
```

- Nose into side or rear: full damage. Head-on: both take about half. Getting rear-ended: worst case.
- Ignore if `max(approachA, approachB) < MIN_IMPACT_SPEED`.
- Per-pair cooldown `HIT_COOLDOWN_MS = 300` so one crunch does not register three times.
- Flipped victims take `x FLIPPED_DMG_MULT`.
- Record `lastAttacker` and timestamp on the victim for kill credit.

### 5.2 Tip-over and recovery

```
load = speed * |angularVelocity|
if load > FLIP_LOAD for FLIP_HOLD_MS continuous: flip
```

On flip:
- `state = flipped`, zero velocity, raise linear damping to 8 (car slides to a stop, becomes a target).
- `recoverTaps = 0`. Each input adds `taps` to it. At `RECOVER_TAPS` (10): `state = alive`, brief 1 s invulnerability, emit `recover`.

Tune `FLIP_LOAD` generously first. Judges are first-time players; an over-sensitive flip makes the game feel broken.

### 5.3 Parry (stretch)

- A tap while alive and off cooldown opens a `PARRY_WINDOW_MS = 150` window and starts `PARRY_COOLDOWN_MS = 5000`.
- An incoming hit during the window: damage to the parrier is 0, the attacker takes `PARRY_REFLECT = 0.5` of the would-be damage, both get pushed apart. Emit `parry`.
- Snapshot field `parry` = 1 while the window is open (client draws a shield ring).

### 5.4 Walls

- On car-wall contact with speed > `WALL_MIN_SPEED`: multiply velocity by `WALL_SPEED_KEEP` (0.35).
- If `frontness > 0.8` and speed > `0.8 * maxSpeed`: full stop, self-damage `WALL_DMG`.
- Death by wall within `KILL_CREDIT_MS = 3000` of being hit credits the last attacker.

### 5.5 Elimination, rounds, scoring

- `hp <= 0` → `state = dead`, remove body, emit `kill`.
- Round ends when one team (or one car in FFA) remains, or after `ROUND_TIME_S = 120` (highest total HP team wins).
- Score: `kills * 100 + survivedSeconds + (won ? 150 : 0)`. Leaderboard sorted by score, so a 3-kill player who died still ranks well.

---

## 6. Tunables (`/shared/config.js`)

Starting values. Person 3 owns tuning; nobody hardcodes numbers elsewhere.

| Name | Start | Meaning |
|---|---|---|
| `TICK_HZ` | 30 | physics rate |
| `SNAP_HZ` | 20 | broadcast rate |
| `MIN_SPEED` | 4 m/s | launch speed when accel pressed |
| `ENGINE` | 6 | forward accel per unit mass |
| `GRIP` | 0.9 | lateral velocity removed per tick |
| `COAST_DAMPING` | 1.2 | slowdown when not accelerating |
| `DMG_K` | 0.6 | damage scale |
| `MIN_IMPACT_SPEED` | 2 m/s | ignore taps below this |
| `HIT_COOLDOWN_MS` | 300 | |
| `FLIPPED_DMG_MULT` | 1.5 | |
| `FLIP_LOAD` | 30 | speed x angular velocity threshold |
| `FLIP_HOLD_MS` | 250 | |
| `RECOVER_TAPS` | 10 | |
| `WALL_SPEED_KEEP` | 0.35 | |
| `WALL_DMG` | 8 | |
| `ROUND_TIME_S` | 120 | |
| `TILT_MAX_G` | 6 | m/s² of gravity on the steering axis that counts as full lock (~37°) |
| `TILT_DEADZONE` | 0.08 | |

### Car presets (`/shared/constants.js`)
| Car | HP | Density | Max speed | Turn rate |
|---|---|---|---|---|
| balanced | 100 | 1.0 | 14 m/s | 3.2 rad/s |
| heavy | 140 | 1.6 | 11 m/s | 2.5 rad/s |
| light | 75 | 0.7 | 17 m/s | 4.0 rad/s |

---

## 7. Client

### 7.1 Input (`/client/src/input.js`)

**Permission (iOS):** on the "Tap to start" button, call `DeviceMotionEvent.requestPermission()` if it exists. Must be from a user tap and the page must be on HTTPS.

**Steering from gravity** (more stable than `gamma`, which jumps near vertical):
```
g = event.accelerationIncludingGravity
raw = g.y                             // long edge axis
if (screen.orientation.angle === 270) raw = -raw   // landscape flipped
steer = (raw - calibrationOffset) / TILT_MAX_G
apply deadzone, clamp to [-1, 1]
```
Players hold the phone like a steering wheel. `calibrationOffset` is captured automatically during the 3-second countdown and with a "Recalibrate" button in the lobby. Verify the axis and sign on a real iPhone in the first two hours; Android may need the sign flipped.

**Buttons:**
- Right half of screen: big ACCEL button (hold).
- Left half: TAP button (parry when alive, recovery when flipped).
- `touch-action: none`, `user-select: none`, use `pointerdown`/`pointerup`.

Send `input` at 30 Hz with the accumulated tap count, then reset it.

### 7.2 Screen handling
- iPhone Safari does **not** support the Fullscreen or Orientation Lock APIs. Show a "Rotate your phone" overlay in portrait instead.
- Add `manifest.json` with `"display": "fullscreen"` and `"orientation": "landscape"`; on demo phones use **Add to Home Screen** for true full screen.
- `navigator.wakeLock.request('screen')` so phones don't sleep mid-round (wrap in try/catch).
- `navigator.vibrate` does not work on iOS; use screen shake and flash instead.

### 7.3 Rendering (`/client/src/render.js`)
- Letterbox the 1000 x 600 world into the canvas; handle `devicePixelRatio`.
- **Interpolation:** keep the last ~10 snapshots; render at `now - 100 ms`, lerping position and angle (shortest-path for angle) between the two snapshots around that time.
- Draw order: floor, obstacles, cars, HP bars, effects, HUD.
- Own car: white outline and an arrow when off-screen is impossible (whole arena is visible), so just the outline.
- Effects from events: hit sparks, damage numbers, screen shake for the victim, shield ring for parry, "FLIPPED! TAP!" overlay with a tap counter.
- The same module renders the spectator page with `showHud: false` and a larger canvas.

### 7.4 Screens
1. **Home:** name, Create room, Join with code.
2. **Lobby:** room code + QR (`/join/ABCD`), player list, team picker, car picker, ready toggle, mode picker and Start for the host. Recalibrate button.
3. **Game:** countdown (calibrates), play, death screen (spectate the rest of the round).
4. **Results:** winner, leaderboard, Play again.
5. **Spectate** (`/spectate/ABCD`, laptop): arena, live leaderboard, kill feed, QR to join.

---

## 8. Rooms (`/server/rooms.js`)

- Code: 4 letters from `ABCDEFGHJKMNPQRSTUVWXYZ` (no I, L, O). Retry on collision.
- States: `lobby → countdown (3 s) → playing → roundEnd → lobby`.
- Max 8 players. Minimum to start: 4 (`DEV_MIN_PLAYERS = 1` in development, with bots).
- Host is the creator; if the host leaves, the oldest player becomes host.
- Disconnect during play: car keeps its last input as zero for 5 s, then is removed (counts as dead, no kill credit).
- Teams: FFA puts everyone on their own team; team modes require even team sizes before Start is enabled.

### Bots (`/server/bots.js`)
`?bots=3` on create adds 3 server-side players that steer toward the nearest enemy with full accel. Essential for testing collisions with one or two phones and for tuning alone.

---

## 9. Deployment

1. Ubuntu VM, open ports 80 and 443.
2. Install Node 20, pm2, Caddy.
3. Hostname without buying a domain: `<ip-with-dashes>.sslip.io` (e.g. `45-77-1-2.sslip.io`).
4. `Caddyfile`:
   ```
   45-77-1-2.sslip.io {
       reverse_proxy localhost:3000
   }
   ```
   Caddy fetches the TLS certificate automatically; WebSockets pass through.
5. `deploy.sh`: `git pull && npm ci && npm run build && pm2 restart bumper`.

**Demo network:** all phones and the laptop join one teammate's phone hotspot. Do not depend on venue Wi-Fi.

---

## 10. Work split

| Person | Load | Owns |
|---|---|---|
| 1 | Heavy | `server/index.js`, `rooms.js`, `game.js`: socket rooms, Planck world, tick loop, snapshots, bots |
| 2 | Heavy | `client/input.js`, `render.js`, `interp.js`, game screen: tilt, buttons, drawing, effects |
| 3 | Medium | `server/mechanics.js`, `shared/config.js`, `constants.js`: damage, flip, parry, walls, scoring, presets, tuning |
| 4 | Light | Deployment, `deploy.sh`, lobby/home/results/spectate screens, art, sound, pitch, Devpost, demo logistics |

Everyone: write `/shared/protocol.js` together in the first 45 minutes.

## 11. Milestones

| Time | Done |
|---|---|
| Sat 16:00 | Protocol written, repo set up |
| Sat 16:30 | HTTPS server live (P4) |
| Sat 17:30 | Tilt confirmed on a real iPhone over HTTPS (P2) |
| Sat 20:00 | One phone drives one car on the server |
| Sat 23:00 | Four phones (or phones + bots), collisions, HP, elimination |
| Sun 02:00 | Tip-over, lobby, spectator working |
| Sun 10:00 | Parry, car presets, art, sound; tuning starts |
| Sun 12:00 | Feature freeze; two full rehearsals on the hotspot |
| Sun 13:30 | At the table, phones charged, server running |

**Cut order if behind:** sound, parry, car presets, spectator kill feed. Never cut tip-over.

---

## 12. Risks

| Risk | Mitigation |
|---|---|
| iOS tilt permission or HTTPS issues | Deploy first; test on a real iPhone by 17:30 |
| Wrong tilt axis or sign on some phones | Gravity-based steering + calibration; test iPhone and Android early |
| Duplicate damage per collision | Per-pair hit cooldown |
| Jittery cars on phones | 100 ms interpolation buffer; never render raw snapshots |
| Game too hard for judges | Generous flip threshold; tune with people who haven't played |
| Venue Wi-Fi | Phone hotspot for the demo |
| Server crash mid-demo | pm2 auto-restart; rooms are cheap to recreate |

## 13. Demo script (90 seconds)

1. Laptop shows the spectator page with a QR. "Phones are the controllers and the screens."
2. Hand four judges phones already in the lobby. Host taps Start; countdown calibrates.
3. Play one FFA round. Point out a directional hit and the first tip-over ("tap ten times while everyone comes for you").
4. Results screen with the leaderboard. Close on the three ingredients: phone motion steers, rivalry is the whole game, and it needs four or more people.
