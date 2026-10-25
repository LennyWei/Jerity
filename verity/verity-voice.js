
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { JERITY } from '../shared/jerity.js';

const dir = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(dir, "..", ".env") });

export async function speakVerity(message, { signal } = {}) {
  if (!process.env.FISH_AUDIO_API_KEY || !process.env.FISH_AUDIO_VOICE_ID) throw new Error('Fish Audio is not configured');
  const response = await fetch("https://api.fish.audio/v1/tts", {
    signal: AbortSignal.any([AbortSignal.timeout(JERITY.TTS_TIMEOUT_MS), ...(signal ? [signal] : [])]),
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.FISH_AUDIO_API_KEY}`,
      "Content-Type": "application/json",
      "model": process.env.FISH_AUDIO_MODEL || "s2.1-pro-free"
    },
    body: JSON.stringify({
      text: message,
      reference_id: process.env.FISH_AUDIO_VOICE_ID,
      format: "mp3"
    })
  });

  if (!response.ok) {
    throw new Error(`Fish Audio ${response.status}: ${await response.text()}`);
  }

  const audio = Buffer.from(await response.arrayBuffer());
  if (!audio.length) throw new Error('Fish Audio returned empty audio');

  return audio;
}
