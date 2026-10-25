![Jerity: tilt, ram, survive](media/jerity-thumbnail.png)

# Jerity

A bumper-car brawl for 4 to 8 players. The arena runs on a laptop or TV, everyone drives from their phone, and Jerity, an AI host, listens to the players and changes the round while it plays. Built at HackPSU Fall 2026.

## How to play

1. Open the game on a big screen and create a room. Everyone scans the QR code to join on their phone.
2. Hold your phone sideways and tilt it the way you want to drive, like rolling a marble: the further you tilt, the faster you go.
3. Ram the other cars. Damage depends on speed and angle: rear hits hurt more than side hits, and a head-on crash stuns both cars. Swing hard against your direction at speed and you tip over; tap 8 times to get back up. Walls and pillars cost you speed and a little HP.
4. Knocking someone out heals you 30% and gives you a short boost. The last car driving wins the round; if the 2-minute clock runs out, the healthiest car wins.
5. A match is 5 rounds. The final leaderboard ranks everyone by performance score: damage dealt, knockouts, round wins and time survived.

Players who turn on their mic can talk to Jerity. During each round Jerity invites everyone to speak, hears what they say and hands down a ruling on the live round: a speed boost, a freeze, a heal, reversed controls, a shield, a position swap or, very rarely, an execution. The more rulings Jerity makes, the wilder they get. Jerity also starts out cheerful and slowly gets corrupted, and the arena decays with it.

## How it's built

- **Game server** (Node 20, Express, Socket.IO): authoritative. Each room runs its own Planck.js physics world at 30 ticks per second and streams snapshots to every screen. Phones only send their tilt and taps.
- **Client** (Vite, Canvas 2D): draws the arena 100 ms behind the server and interpolates between snapshots. Every sound effect is synthesized live with the Web Audio API.
- **Jerity**: Groq transcribes the players, Gemini picks the ruling, and Fish Audio gives Jerity a voice. See [JERITY.md](JERITY.md).
- **Hosting**: the client on Vercel, the game server on Render.

## Run it locally

```bash
npm install
npm run build
npm start
```

Then open http://localhost:3000. For development, run `npm run dev` and `npm run dev:client` together. Phones need HTTPS for motion sensors and the microphone, so test on a phone with `npm run dev:phone`. Jerity's voice features need `GROQ_API_KEY`, `GEMINI_API_KEY`, `FISH_AUDIO_API_KEY` and `FISH_AUDIO_VOICE_ID` in `.env`.

`npm run sim` plays a headless round and checks the physics against the design numbers; `npm run test:jerity` checks the Jerity pipeline.
