# Jerity integration

## Production: deploy both services

Vercel serves the client. The deployed client connects to the separate Render
service at `https://bumper-brawl-nkcw.onrender.com`. A Vercel deploy does not update
the game server or its AI pipeline.

Deploy the current `main` branch to **both** services. The old Render Blueprint
pointed at `server/phase-a`; it now points at `main`. Check the existing Render
service's branch in its dashboard as well (editing this file alone does not change
a manually configured service). Render's start command must be `npm start`, which
runs `server/index.js`, not either fake server.

In the Render service's Environment settings, provide `GROQ_API_KEY`,
`GEMINI_API_KEY`, `FISH_AUDIO_API_KEY`, and `FISH_AUDIO_VOICE_ID` as secrets. Adding
them only to Vercel will not configure the Render process. For an existing Render
Blueprint, newly added `sync: false` variables must be filled in manually.
See https://render.com/docs/configure-environment-variables.

After deploying, `/health` on Render should include `jerity.protocolVersion: 1`
and `jerity.configured: true`; `jerity.missing` lists only missing variable names.
`revision` identifies the deployed Render commit. Vercel's `VITE_SERVER_URL`
must point to that Render service at build time. Reload the page and create a new
room after restarting the backend; rooms are held in memory.

An older backend without Jerity state now shows **Jerity unavailable** instead of
silently remaining idle. **Enable mic** is still required to opt into recording.
The **Speak now** cue appears when the shared listening window opens.

Corruption starts fresh on every page reload and resets when a match finishes
(including the spectator view). It no longer accumulates across page visits.

## Local setup

Run `npm start` with a built client (`npm run build`), or run `npm run dev` and
`npm run dev:client` together. For phones use `npm run dev:phone` so microphone
access has HTTPS. Plain HTTP on a LAN IP cannot capture a microphone.

Set server-only credentials in `.env`: `GROQ_API_KEY`, `GEMINI_API_KEY`,
`FISH_AUDIO_API_KEY`, and `FISH_AUDIO_VOICE_ID`. The existing Gemini model cascade
and Fish Audio model remain configured in `verity/verity.js` and
`verity/verity-voice.js`.

Players opt in using **Enable mic** in the lobby or above the arena. After each
countdown, Jerity cycles through the three listening invitations
(`listening-1.mp3` / `listening-2.mp3` / `listening-3.mp3`, under four seconds each), then the server
opens one shared six-second listening window. Missing invitation clips stay silent.
A green halo
means speak; a violet halo means Jerity is deciding. The microphone is released
after capture, when disabled, on disconnect, and when leaving the game screen.
Permission denial or unsupported recording does not prevent playing.

The server accepts one bounded recording per human player, allows 1.5 seconds
for upload, transcribes the recordings together, and requests one AI action.
It plays the before line, applies the action, publishes the resulting state,
then plays the after line. Cars keep driving and the round clock keeps ticking
throughout the invitation, recording, AI/TTS requests, and voice playback.
Targets are checked again at application time: dead or disconnected players get
no effect, and Jerity skips the success follow-up. A decided round cancels any
pending requests or playback. Temporary effects start when actually applied.
Each connected player's playback completion advances the exchange; a 15-second
deadline prevents blocked audio or dropped clients from stalling the round.
STT, AI, and TTS also have deadlines. Late results cannot affect another round.
Jerity's personality persists through the match and resets for a new match.

Dynamic lines use Fish Audio only. Failed voice generation is logged and shown as
unavailable, rather than silently replacing Jerity with the browser's default voice.
Voice generation is awaited, with a 25-second request deadline; gameplay continues.
Landing/lobby greetings use only your MP3 recordings and stay silent while
missing; see `client/public/audio/jerity/README.md`. Speech bubbles are removed.
The face follows living cars, prioritizing the target of the current ruling.
Four seconds after the ruling takes effect, Jerity turns away: his head stays
visible while his eyes and mouth fade out. If his follow-up is still playing, he
finishes it first. He faces the players again for the next round's invitation.
Mute stays fixed in the bottom-right viewport corner on every screen.
Sound/microphone controls have accessible labels and status announcements.

In the lobby, open **Microphone & voice check**. **Test microphone** records six
seconds and shows the private Groq transcript (or the actual failure category).
**Play my recording** checks whether the microphone captured sound independently
of Groq. **Test Jerity voice** requests a fixed phrase using the server's configured
Fish Audio voice. Both tests require lobby membership and are rate limited.
The voice uses `FISH_AUDIO_VOICE_ID`; `FISH_AUDIO_MODEL` optionally overrides the
existing `s2.1-pro-free` model. Missing credentials must be set on Render, not only
in a local `.env` or on Vercel.

Action durations and HP amounts are clamped by `server/game.js`. `swap_positions`
accepts the AI's two-ID target array. `remove_walls` disables interior obstacles
and hides them until they return; the arena boundary stays in place.
`execute_player` remains limited to the last quarter of a round, so it is excluded
from opening rulings. `auto_kill` is not exposed to the AI.

Run `npm run test:jerity` for offline pipeline/lifecycle checks, `npm run sim` for
existing physics checks, and `npm run build` for the client build. Live microphone
permissions and provider voices should also be checked on the target phones.
An optional Chrome smoke test, `node test/jerity-browser.mjs`, uses a fake browser
microphone and offline AI fixtures to verify capture and layout. Set `CHROME_PATH`
if Chrome is installed outside its default Windows location.
