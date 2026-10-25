# Bumper Brawl: Design Document

HackPSU Fall 2026, Mystery Stack track (phone motion, rivalry, group of 4+).

A free-for-all PvP bumper-car game for 4 to 8 players, played in the phone browser. Players tilt their phone to steer and hold a button to accelerate. The goal is to ram other cars to damage them and earn score. Faster hits do more damage, and hitting someone's side or rear beats hitting them head-on. Greedy driving gets punished: full speed plus full steering tips the car over, and slamming into walls or obstacles costs speed and HP. Last car alive wins the round.

---

## 1. Scope

**MVP (must ship, in this order)**
1. Join a room on a phone browser with a 4-letter code or QR; no install.
2. Tilt steering and accelerate button that feel good on a real iPhone and Android phone.
3. Server-authoritative physics for 4 to 8 cars at 30 Hz in a flat, closed, walled arena with a few pillars.
4. Speed-scaled, direction-aware collision damage; head-on concussion.
5. Tip-over with tap-to-recover.
6. Wall and obstacle penalties (speed loss, small self-damage).
7. Elimination, kill reward (heal + short buff), score, round end, leaderboard.
8. Laptop spectator view with live leaderboard and kill feed.

**Post-MVP (only after FFA is done and fun)**
- Team modes: 2v2, 3v3, 4v4.
- Items and perks spawning at fixed spots in the arena.
- Car picking (heavy / light presets already exist in `constants.js`).
- Parry, currency, unlocks, accounts.

**Non-goals for this weekend**
- Client-side prediction or lag compensation.
- Native app.

---

## 2. Architecture

```
 Phone (browser)           Server (Node, HTTPS)              Laptop (browser)
 ┌──────────────┐  input   ┌──────────────────────────┐  snap  ┌──────────────┐
 │ tilt / accel ├────────► │ Socket.IO rooms          ├──────► │ spectator    │
 │ taps         │  30 Hz   │ Planck.js world @ 30 Hz  │  20 Hz │ renderer     │
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
  protocol.js      message names and shapes (the contract)
  config.js        every tunable number
  constants.js     arena, obstacles, car stats, colors
/server
  fake.js          fake server for client work (kinematic cars, random events)
  fake-client.js   headless test player
  index.js         express + socket.io bootstrap
  rooms.js         room lifecycle, join codes, colors
  game.js          planck world, tick loop, snapshot builder
  mechanics.js     damage, head-on, flip, walls, kill reward, scoring (pure functions)
  bots.js          bot inputs for solo testing
/client
  index.html
  src/main.js      screen router
  src/net.js       socket wrapper
  src/input.js     tilt, accel, taps, calibration
  src/render.js    arena + cars + effects (shared with spectator)
  src/interp.js    snapshot buffer and interpolation
  src/screens/     home.js, lobby.js, game.js, results.js, spectate.js
  public/          sprites, sounds, manifest.json
deploy.sh
```

---

## 3. Protocol (`/shared/protocol.js`)

`protocol.js` is the source of truth; this section summarizes it.

### Client to server
| Event | Payload | Notes |
|---|---|---|
| `createRoom` | `{ name, bots? }` | ack `{ code, playerId }`; `bots` adds server bots for testing |
| `joinRoom` | `{ code, name }` | ack `{ playerId }` or `{ error }` |
| `spectate` | `{ code }` | ack `{ ok }` or `{ error }`; laptop view |
| `ready` | `{ ready }` | |
| `start` | `{}` | host only; needs 4+ players (1+ in bot rooms) |
| `input` | `{ seq, tilt, accel, taps }` | 30 Hz while playing |
| `leave` | `{}` | |

`taps` is the **count of taps since the last input message**, not a boolean, so fast tapping during flip recovery is never lost.

### Server to client
| Event | Payload |
|---|---|
| `lobby` | `{ code, hostId, state, players: [{ id, name, color, ready }] }` |
| `countdown` | `{ seconds }` |
| `snap` | `{ t, cars: [{ id, x, y, a, hp, s, taps, buff, sc }], events: [...], timeLeft }` |
| `roundEnd` | `{ winnerId, leaderboard: [{ id, name, kills, damage, score }] }` |

Car state `s`: 0 alive, 1 flipped, 2 dead, 3 stunned. `buff`: 0 none, 1 boost, 2 shield. `sc`: live score.

Events:
| Type | Fields |
|---|---|
| `hit` | `attacker, victim, dmg, kind` (`side` or `rear`) |
| `headon` | `a, b, dmg, stunMs` |
| `wall` | `id, dmg` (walls and pillars) |
| `flip` | `id` |
| `recover` | `id` |
| `kill` | `attacker` (or null), `victim, heal, buff` |

---

## 4. World and physics (`/server/game.js`)

- Arena: flat and closed, **1000 x 600 world units**. Planck scale: `SCALE = 20` units per meter, so the Planck world is 50 x 30 m. Small enough that 8 cars can't avoid each other.
- Top-down: world gravity `(0, 0)`.
- Walls: four static edge bodies.
- Obstacles: 4 static pillars in the gaps between the spawn lanes, leaving the middle open for clashes (`OBSTACLES` in `constants.js`).
- Car body: dynamic box 40 x 24 units, density from car stats, restitution 0.5.
- Spawns: `SPAWN_POINTS` on the edges, corners first, then the middle of each edge (2 players: opposite corners; 4: all corners), facing the center. The drive from every spawn point to the middle misses the pillars.

### Drive modes (`DRIVE_MODE` in `config.js`)
- `'omni'` (default): the phone's tilt is a direction on screen (input `tilt` = right, `throttle` = up the screen). The car's velocity swings toward it at `OMNI_ACCEL` and the nose turns to face where it goes. No grip, no instant launch. Tip-over: at `OMNI_FLIP_SPEED_FRAC` of top speed, demanding a direction `OMNI_FLIP_ANGLE_DEG` or more off course for `FLIP_HOLD_MS`.
- `'car'`: roll steers, tipping the phone forward/back is the throttle (partial throttle cruises; back brakes, then reverses). The tick loop below describes this mode. Steering swings the other way only while actually reversing, not while being knocked backwards.

Both modes: stunned, flipped and knocked-back cars ignore input; damage, knockback and walls work the same.

### Tick loop (30 Hz, fixed timestep `dt = 1/30`)
For each car:

1. **Stunned:** ignore input; coast with `COAST_DAMPING`; back to alive when `CONCUSSION_MS` is over.
2. **Flipped:** ignore steering and throttle; add input `taps` to the recovery count; slide to a stop.
3. **Alive:**
   - **Lateral grip:** remove sideways velocity so the car drives like a car, not a puck. `lat = right · v; apply impulse -lat * mass * GRIP`.
   - **Throttle:** if `accel`, below `MIN_SPEED` jump to `MIN_SPEED` (instant launch); otherwise apply `ENGINE * mass` forward until `maxSpeed`. Boost buff multiplies both. If not `accel`, damping `COAST_DAMPING`.
   - **Steering:** `angularVelocity = tilt * turnRate * min(1, speed / MIN_SPEED)` (no spinning in place).
   - **Tip-over check** (5.3).
4. `world.step(dt, 8, 3)`.
5. Apply queued contacts (5.1, 5.2, 5.4), then deaths and kill rewards (5.5), then the win check.
6. At 20 Hz, broadcast `snap` with the events since the last one.

Collect contacts in the Planck `begin-contact` listener into a queue (with the velocities at that moment); apply damage after `step`, never inside the callback. Not `post-solve`: by then the solver has already bounced the cars and the hit speed is gone.

---

## 5. Mechanics (`/server/mechanics.js`)

Pure functions taking plain numbers, so they can be unit-tested before the physics exists.

### 5.1 Car-to-car hits: faster and from behind hurts more

For a contact between car A and car B, `n` is the unit normal from A to B, `v` is velocity in m/s, `fwd` is a car's unit forward vector.

```
approachA = max(0, dot(vA, n))        // A's speed into B
approachB = max(0, dot(vB, -n))       // B's speed into A
noseA     = max(0, dot(fwdA, n))      // 1 = A hit with its nose
noseB     = max(0, dot(fwdB, -n))
```

If `max(approachA, approachB) < MIN_IMPACT_SPEED`, ignore. Otherwise:

**Head-on** (both `noseA` and `noseB` ≥ `HEADON_THRESHOLD`):
```
closing = approachA + approachB
dmg     = DMG_K * closing² * HEADON_MULT     // same for both cars
```
Both cars take `dmg` and both are **stunned** for `CONCUSSION_MS` (1.5 s). Emit `headon`.

**Side or rear** (otherwise): the attacker is the car with the larger `approach * (0.3 + 0.7 * nose)`. Say A attacks B:
```
rear   = max(0, dot(fwdB, n))            // 1 = A hit B squarely from behind
dmgToB = DMG_K * approachA² * (0.3 + 0.7 * noseA) * (1 + REAR_BONUS * rear) * sqrt(massA / massB)
dmgToA = dmgToB * ATTACKER_RECOIL
```
`kind` is `rear` when `rear > 0.5`, else `side`. Emit `hit`.

Common rules:
- Per-pair cooldown `HIT_COOLDOWN_MS` so one crunch counts once.
- Flipped victims take `x FLIPPED_DMG_MULT`.
- A shield buff or post-recovery invulnerability blocks damage.
- Record the victim's `lastAttacker` and time for kill credit.
- The attacker earns `SCORE_PER_DAMAGE` per HP dealt.
- Knockback: both cars are pushed apart along the hit at `KNOCKBACK_SPEED` (`HEADON_KNOCKBACK_SPEED` after a head-on) and get no throttle or grip for `KNOCKBACK_MS`, so they separate instead of grinding, sliding along each other, or concussing each other again right after the stun.

Why this works: hitting someone's side or rear at speed is the best play, a head-on is a punishing trade for both, and getting caught from behind is the worst outcome. Positioning and approach angle matter, which is where the tilt skill shows.

### 5.2 Walls and obstacles

On contact with a wall or pillar where impact speed (velocity into the surface) ≥ `WALL_MIN_SPEED`:
- Speed is multiplied by `WALL_SPEED_KEEP` (keep 35%).
- Any bump of `MIN_IMPACT_SPEED` or more (even under `WALL_MIN_SPEED`) knocks the car off the surface at `WALL_KNOCKBACK_SPEED`, with no throttle or grip for `KNOCKBACK_MS`. `WALL_MIN_SPEED` is above the 4 m/s launch, so holding accel against a wall bounces off it for free instead of grinding HP away.
- Self-damage `WALL_DMG_K * impactSpeed²` (about 16 HP at full speed, about 1 HP at a gentle bump). Emit `wall`.
- If this kills the car within `KILL_CREDIT_MS` of being hit by someone, that player gets the kill.

### 5.3 Tip-over (greedy driving)

```
if speed >= FLIP_SPEED_FRAC * maxSpeed and |tilt| >= FLIP_TILT:
    flipHeld += dt
else:
    flipHeld = 0
if flipHeld >= FLIP_HOLD_MS: flip
```
Full speed plus full steering held for 0.4 s flips the car. This depends on the player's input, so players can learn exactly where the limit is: ease off the throttle or the tilt and you're safe.

On flip: `state = flipped`, the car slides to a stop (`FLIPPED_DAMPING`), takes extra damage, and the player taps `RECOVER_TAPS` (8) times to get back up. Then a short invulnerability (`RECOVER_INVULN_MS`) and `recover`.

Tune `FLIP_SPEED_FRAC` and `FLIP_TILT` with first-time players. If judges flip within ten seconds of their first round, raise them.

### 5.4 Elimination and kill reward

- `hp <= 0` → `state = dead`, remove the body, emit `kill`.
- The killer restores `KILL_HEAL_FRAC` (30%) of max HP, capped at max, and gets a buff for `BUFF_MS` (4 s):
  - `KILL_BUFF = 'boost'` (default): acceleration x1.6, top speed x1.15. Rewards aggression and makes the killer visibly dangerous.
  - `KILL_BUFF = 'shield'`: immune to damage. Safer for the killer but lets them stall. Kept as a config switch so the team can try both.
- Kill credit with no attacker (a solo wall death) gives no reward.
- A killer knocked to 0 HP in the same crash gets no reward either: both die (a double KO).

### 5.5 Rounds and scoring

- Round ends when one car is left alive (flipped or stunned still counts as alive), or after `ROUND_TIME_S` (120 s), where the highest HP wins.
- `score = damage dealt * SCORE_PER_DAMAGE + kills * SCORE_KILL + (winner ? SCORE_WIN : 0)`.
- Live score `sc` is in every snapshot (no win bonus until the end). The leaderboard is sorted by score, so a player who dealt lots of damage and got three kills but died still ranks high.

---

## 6. Tunables (`/shared/config.js`)

Person 3 owns tuning; nobody hardcodes numbers elsewhere. Key starting values:

| Name | Start | Meaning |
|---|---|---|
| `MIN_SPEED` | 4 m/s | launch speed when accel is pressed |
| `ENGINE` | 6 | forward accel per unit mass |
| `DMG_K` | 0.6 | damage scale (full-speed nose into side ≈ 118 HP: one-shot) |
| `REAR_BONUS` | 0.3 | rear hits up to +30% |
| `ATTACKER_RECOIL` | 0.1 | attacker's share of side/rear damage |
| `HEADON_MULT` | 0.35 | head-on damage to each car |
| `CONCUSSION_MS` | 1500 | head-on stun |
| `FLIP_SPEED_FRAC` / `FLIP_TILT` / `FLIP_HOLD_MS` | 0.85 / 0.85 / 400 | tip-over trigger |
| `RECOVER_TAPS` | 8 | taps to get back up |
| `WALL_SPEED_KEEP` / `WALL_DMG_K` | 0.35 / 0.08 | wall penalty |
| `KILL_HEAL_FRAC` / `KILL_BUFF` / `BUFF_MS` | 0.3 / boost / 4000 | kill reward |
| `ROUND_TIME_S` | 120 | |

**First tuning target:** `DMG_K` is deliberately high, so a perfect full-speed side hit nearly one-shots. If rounds end in 20 seconds, cut `DMG_K` to about 0.3 so a kill takes two or three good hits.

All cars use `balanced` stats for the MVP (100 HP, 14 m/s, 3.2 rad/s).

---

## 7. Client

### 7.1 Input (`/client/src/input.js`)

**Permission (iOS):** on the "Tap to start" button, call `DeviceMotionEvent.requestPermission()` if it exists. Must be from a user tap and the page must be on HTTPS.

**Steering from gravity** (steadier than `gamma` when the phone is held like a steering wheel):
```
g = event.accelerationIncludingGravity
raw = g.y                                         // long edge axis
if (screen.orientation.angle === 270) raw = -raw  // landscape flipped
steer = (raw - calibrationOffset) / TILT_MAX_G
apply deadzone, clamp to [-1, 1]
```
`calibrationOffset` is captured during the 3-second countdown and with a "Recalibrate" button in the lobby. Verify the axis and sign on a real iPhone in the first two hours; Android may need the sign flipped.

**Controls:**
- Right side: big ACCEL button (hold).
- Anywhere else: taps count toward flip recovery. They do nothing while upright.
- `touch-action: none`, `user-select: none`, use `pointerdown`/`pointerup`.

Send `input` at 30 Hz with the accumulated tap count, then reset it.

**Tip-over warning:** when `speed` is near max and `|tilt| >= FLIP_TILT`, flash the screen edge red so players learn the limit before they hit it. (The client knows its own tilt; speed can be estimated from snapshot positions.)

### 7.2 Screen handling
- iPhone Safari does **not** support the Fullscreen or Orientation Lock APIs. Show a "Rotate your phone" overlay in portrait.
- `manifest.json` with `"display": "fullscreen"` and `"orientation": "landscape"`; on demo phones use **Add to Home Screen** for true full screen.
- `navigator.wakeLock.request('screen')` so phones don't sleep mid-round (wrap in try/catch).
- `navigator.vibrate` does not work on iOS; use screen shake and flashes instead.

### 7.3 Rendering (`/client/src/render.js`)
- Letterbox the 1000 x 600 world into the canvas; handle `devicePixelRatio`.
- **Interpolation:** keep the last ~10 snapshots; render at `now - 100 ms`, lerping position and angle (shortest path for angle).
- Draw order: floor, pillars, cars, HP bars, effects, HUD.
- Cars in their `PLAYER_COLORS` color; your own car has a white outline.
- State visuals: flipped = car drawn upside down/greyed with a tap counter; stunned = spinning stars; boost = flame trail; shield = ring.
- Event effects: sparks and damage numbers on `hit` (bigger for `rear`), a big flash plus "CONCUSSED" on `headon`, a small puff on `wall`, kill banner with "+HEAL" on `kill`.
- HUD: your HP, score, time left, and a "FLIPPED! TAP!" overlay with progress.
- The same module renders the spectator page with `showHud: false`, a larger canvas, live leaderboard from `sc`, and kill feed.

### 7.4 Screens
1. **Home:** name, Create room, Join with code.
2. **Lobby:** room code + QR (`/join/ABCD`), player list with colors, ready toggle, Start (host only, enabled at 4+ players), Recalibrate.
3. **Game:** countdown (calibrates), play, death screen (watch the rest of the round).
4. **Results:** winner, leaderboard (kills, damage, score), Play again.
5. **Spectate** (`/spectate/ABCD`, laptop): arena, live leaderboard, kill feed, QR to join.

---

## 8. Rooms (`/server/rooms.js`)

- Code: 4 letters from `ABCDEFGHJKMNPQRSTUVWXYZ` (no I, L, O). Retry on collision.
- States: `lobby → countdown (3 s) → playing → roundEnd → lobby`.
- 4 to 8 players. Rooms created with bots can start with 1 human (`DEV_MIN_PLAYERS`).
- Each player gets the lowest free color index.
- Host is the creator; if the host leaves, the oldest remaining human becomes host.
- Joining mid-round is refused (except in bot rooms, for testing).
- Disconnect during play: the car keeps zero input for `DISCONNECT_GRACE_MS`, then is removed (counts as dead, no kill credit).

### Bots (`/server/bots.js`)
`bots: 3` on `createRoom` adds 3 server-side players. MVP bots steer toward the nearest car with full accel and moderate tilt (they never flip). When the target faces a bot, the lower id of the two aims `BOT_FLANK_DIST` beside it instead, so bots swerve into side hits rather than head-on double KOs or circling each other; with the target behind it, a bot lets off the throttle to turn tighter. Essential for testing collisions with one or two phones and for tuning alone.

---

## 9. Deployment

1. Ubuntu VM, open ports 80 and 443.
2. Install Node 20, pm2, Caddy.
3. Hostname without a domain: `<ip-with-dashes>.sslip.io` (e.g. `45-77-1-2.sslip.io`).
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
| 1 | Heavy | `server/index.js`, `rooms.js`, `game.js`, `bots.js`: socket rooms, Planck world, tick loop, contact queue, snapshots |
| 2 | Heavy | `client/input.js`, `render.js`, `interp.js`, game screen: tilt, buttons, drawing, state visuals, effects |
| 3 | Medium | `server/mechanics.js`, `shared/config.js`: hits, head-on stun, tip-over, walls, kill reward, scoring, tuning |
| 4 | Light | Deployment, `deploy.sh`, home/lobby/results/spectate screens, art, sound, pitch, Devpost, demo logistics |

Until `game.js` exists, everyone builds against `server/fake.js` (`npm run fake`, join room `TEST`).

## 11. Milestones

| Time | Done |
|---|---|
| Sat 16:30 | Contract frozen; fake server running; HTTPS server live (P4) |
| Sat 17:30 | Tilt confirmed on a real iPhone over HTTPS (P2) |
| Sat 20:00 | One phone drives one Planck car on the real server |
| Sat 23:00 | 4 phones (or phones + bots): side/rear/head-on damage, walls, elimination |
| Sun 02:00 | Tip-over, kill reward, lobby, spectator working |
| Sun 10:00 | Art, sound; tuning starts |
| Sun 12:00 | Feature freeze; two full rehearsals on the hotspot |
| Sun 13:30 | At the table, phones charged, server running |

**Cut order if behind:** sound, kill buff (keep the heal), spectator kill feed, head-on stun (keep equal damage). Never cut tip-over.

---

## 12. Risks

| Risk | Mitigation |
|---|---|
| iOS tilt permission or HTTPS issues | Deploy first; test on a real iPhone by 17:30 |
| Wrong tilt axis or sign on some phones | Gravity-based steering + calibration; test iPhone and Android early |
| Duplicate damage per collision | Per-pair hit cooldown |
| Rounds end too fast (one-shots) | Lower `DMG_K` first |
| First-timers flip constantly | Raise `FLIP_SPEED_FRAC` / `FLIP_TILT`; add the red-edge warning |
| Jittery cars on phones | 100 ms interpolation buffer; never render raw snapshots |
| Venue Wi-Fi | Phone hotspot for the demo |
| Server crash mid-demo | pm2 auto-restart; rooms are cheap to recreate |

## 13. Demo script (90 seconds)

1. Laptop shows the spectator page with a QR. "Your phone is the steering wheel."
2. Hand four judges phones already in the lobby. Host taps Start; the countdown calibrates.
3. Play one FFA round. Point out a rear hit doing big damage, a head-on concussing both cars, and the first tip-over ("tap eight times while everyone comes for you").
4. Results screen with the leaderboard. Close on the three ingredients: phone motion steers, rivalry is the whole game, and it needs four or more people.
