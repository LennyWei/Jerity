
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(dir, "..", ".env") });

export async function speakVerity(message, { signal } = {}) {
  if (!process.env.FISH_AUDIO_API_KEY || !process.env.FISH_AUDIO_VOICE_ID) throw new Error('Fish Audio is not configured');
  const response = await fetch("https://api.fish.audio/v1/tts", {
    signal: AbortSignal.any([AbortSignal.timeout(12000), ...(signal ? [signal] : [])]),
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.FISH_AUDIO_API_KEY}`,
      "Content-Type": "application/json",
      "model": "s2.1-pro-free"
    },
    body: JSON.stringify({
      text: message,
      reference_id: process.env.FISH_AUDIO_VOICE_ID,
      format: "mp3"
    })
  });

  if (!response.ok) {
    throw new Error("Fish Audio error: " + await response.text());
  }

  const audio = Buffer.from(await response.arrayBuffer());

  return audio;
}
