
import dotenv from "dotenv";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(dir, "..", ".env") });

export async function speakVerity(message) {
  const response = await fetch("https://api.fish.audio/v1/tts", {
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

  await writeFile(resolve(dir, "verity-output.mp3"), audio);

  console.log("VERITY voice generated!");

  return audio;
}
