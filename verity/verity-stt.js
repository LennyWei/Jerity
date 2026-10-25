// Groq speech-to-text for the shared 4.5-second round-opening listening window.
// The browser sends bounded MediaRecorder clips over Socket.IO; credentials stay here.

import { JERITY } from '../shared/jerity.js';
import { readFile } from "node:fs/promises";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(dir, "..", ".env") });

const RECORDING_DURATION_MS = JERITY.LISTEN_MS;

/**
 * Transcribe a base64-encoded audio buffer using Groq.
 * @param {string} audioBase64 - Base64-encoded audio data
 * @param {string} mimeType - MIME type of the audio (e.g. "audio/wav", "audio/webm")
 * @returns {Promise<string>} - Transcribed text
 */

export async function transcribeAudio(audioBase64, mimeType = "audio/webm", { signal } = {}) {
  if (!process.env.GROQ_API_KEY) throw new Error('Groq STT is not configured');
  const cleanMime = mimeType.split(";")[0].trim(); // Strip ';codecs=opus'
  const ext = cleanMime.includes("mp4") || cleanMime.includes("m4a") ? "m4a"
            : cleanMime.includes("mp3") || cleanMime.includes("mpeg") ? "mp3"
            : cleanMime.includes("wav") ? "wav"
            : cleanMime.includes("ogg") ? "ogg"
            : "webm";

  const buffer = Buffer.from(audioBase64, "base64");
  const formData = new FormData();
  formData.append("file", new Blob([buffer], { type: cleanMime }), `speech.${ext}`);
  formData.append("model", "whisper-large-v3-turbo");
  formData.append("language", "en");

  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    signal: AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]),
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: formData,
  });

  if (!res.ok) throw new Error(`Groq STT ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.text.trim() || "[silence]";
}

/**
 * Transcribe an audio file from disk.
 * @param {string} filePath - Path to the audio file
 * @param {string} mimeType - MIME type
 * @returns {Promise<string>}
 */
export async function transcribeFile(filePath, mimeType = "audio/wav") {
  const buffer = await readFile(filePath);
  const base64 = buffer.toString("base64");
  return transcribeAudio(base64, mimeType);
}

/**
 * Collect voice inputs from multiple players.
 * In the real game, this will be called with audio buffers received via Socket.IO.
 * Each entry is { playerId, audioBase64, mimeType }.
 *
 * @param {Array<{playerId: string, audioBase64: string, mimeType?: string}>} playerAudios
 * @returns {Promise<Array<{playerId: string, text: string}>>}
 */
export async function collectPlayerVoiceInputs(playerAudios, options = {}) {
  const results = await Promise.all(
    playerAudios.map(async ({ playerId, audioBase64, mimeType }) => {
      try {
        const text = await transcribeAudio(audioBase64, mimeType || "audio/wav", options);
        return { playerId, text };
      } catch (err) {
        console.error(`STT failed for player ${playerId}:`, err.message);
        return null;
      }
    })
  );
  return results.filter(input => input && input.text !== '[silence]');
}

/**
 * Simulate player text inputs (for testing without microphones).
 * @param {Array<{playerId: string, text: string}>} inputs
 * @returns {Array<{playerId: string, text: string}>}
 */
export function simulateVoiceInputs(inputs) {
  return inputs.map(({ playerId, text }) => ({ playerId, text }));
}

export { RECORDING_DURATION_MS };

