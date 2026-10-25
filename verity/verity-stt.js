// verity/verity-stt.js
// Speech-to-text for player voice inputs using Gemini's audio understanding.
// Each player gets a 10-second recording window. The raw audio (WAV/PCM) is sent
// to Gemini which transcribes it.
//
// For the real game: the client records audio via the Web Audio API / MediaRecorder,
// sends it over Socket.IO as a base64-encoded buffer, and this module transcribes it.
// For testing: we can feed in pre-recorded audio or simulate with text.

import { GoogleGenAI } from "@google/genai";
import { readFile } from "node:fs/promises";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(dir, "..", ".env") });

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const RECORDING_DURATION_MS = 10_000; // 10 seconds per player

/**
 * Transcribe a base64-encoded audio buffer using Gemini.
 * @param {string} audioBase64 - Base64-encoded audio data
 * @param {string} mimeType - MIME type of the audio (e.g. "audio/wav", "audio/webm")
 * @returns {Promise<string>} - Transcribed text
 */
export async function transcribeAudio(audioBase64, mimeType = "audio/wav") {
  const response = await ai.models.generateContent({
    model: "gemini-3.7-flash",
    contents: [
      {
        role: "user",
        parts: [
          {
            inlineData: {
              mimeType,
              data: audioBase64,
            },
          },
          {
            text: "Transcribe this audio exactly. Return only the transcription, nothing else. If the audio is silent or unintelligible, return '[silence]'.",
          },
        ],
      },
    ],
  });

  return response.text.trim();
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
export async function collectPlayerVoiceInputs(playerAudios) {
  const results = await Promise.all(
    playerAudios.map(async ({ playerId, audioBase64, mimeType }) => {
      try {
        const text = await transcribeAudio(audioBase64, mimeType || "audio/wav");
        return { playerId, text };
      } catch (err) {
        console.error(`STT failed for player ${playerId}:`, err.message);
        return { playerId, text: "[unintelligible]" };
      }
    })
  );
  return results;
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

