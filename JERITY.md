# Jerity integration

Run `npm start` with a built client (`npm run build`), or run `npm run dev` and
`npm run dev:client` together. For phones use `npm run dev:phone` so microphone
access has HTTPS. Plain HTTP on a LAN IP cannot capture a microphone.

Set server-only credentials in `.env`: `GROQ_API_KEY`, `GEMINI_API_KEY`,
`FISH_AUDIO_API_KEY`, and `FISH_AUDIO_VOICE_ID`. The existing Gemini model cascade
and Fish Audio model remain configured in `verity/verity.js` and
`verity/verity-voice.js`.

Players opt in using **Enable mic** in the lobby or above the arena. After each
countdown, Jerity plays one of two alternating listening invitations
(`listening-1.mp3` / `listening-2.mp3`, under four seconds each), then the server
opens one shared 4.5-second listening window. Missing invitation clips stay silent.
A green halo
means speak; a violet halo means Jerity is deciding. The microphone is released
after capture, when disabled, on disconnect, and when leaving the game screen.
Permission denial or unsupported recording does not prevent playing.

The server accepts one bounded recording per human player, allows 1.5 seconds
for upload, transcribes the recordings together, and requests one AI action.
It plays the before line, applies the action, publishes the resulting state,
then plays the after line. Physics and the round timer wait until this exchange
finishes, so temporary effects retain their full duration for driving.
Each connected player's playback completion advances the exchange; a 15-second
deadline prevents blocked audio or dropped clients from stalling the round.
STT, AI, and TTS also have deadlines. Late results cannot affect another round.
Jerity's personality persists through the match and resets for a new match.

Dynamic lines use Fish Audio, with browser speech if audio generation fails.
Landing/lobby greetings use only your MP3 recordings and stay silent while
missing; see `client/public/audio/jerity/README.md`. Speech bubbles are removed.
The face follows living cars, prioritizing the target of the current ruling.
Four seconds after the ruling takes effect, Jerity turns away: his head stays
visible while his eyes and mouth fade out. If his follow-up is still playing, he
finishes it first. He faces the players again for the next round's invitation.
Mute stays fixed in the bottom-right viewport corner on every screen.
Sound/microphone controls have accessible labels and status announcements.

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
