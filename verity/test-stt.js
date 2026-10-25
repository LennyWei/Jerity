// verity/test-stt.js
// Test script for speech-to-text (Groq Whisper)
//
// Usage:
//   node verity/test-stt.js                  (tests with verity/verity-output.mp3)
//   node verity/test-stt.js <path-to-audio>   (tests with your own recording)

import { resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { transcribeFile, collectPlayerVoiceInputs } from "./verity-stt.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIME_MAP = {
  ".mp3": "audio/mp3",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
  ".m4a": "audio/m4a",
  ".ogg": "audio/ogg",
};

async function run() {
  const customPath = process.argv[2];
  const targetFile = customPath ? resolve(process.cwd(), customPath) : resolve(__dirname, "verity-output.mp3");

  console.log("═════════════════════════════════════════");
  console.log(" Testing Verity Speech-To-Text (STT)");
  console.log("═════════════════════════════════════════");
  console.log(`Audio file: ${targetFile}`);

  if (!existsSync(targetFile)) {
    console.error(`❌ Error: Audio file not found at: ${targetFile}`);
    console.log(`\nTip: You can pass a path to any audio file (.mp3, .wav, .webm, .m4a):`);
    console.log(`  node verity/test-stt.js path/to/recording.wav`);
    process.exit(1);
  }

  const ext = extname(targetFile).toLowerCase();
  const mimeType = MIME_MAP[ext] || "audio/wav";

  // Test 1: Single file transcription
  console.log(`\n[Test 1] Transcribing single file (${mimeType})...`);
  const t0 = performance.now();
  try {
    const text = await transcribeFile(targetFile, mimeType);
    const duration = ((performance.now() - t0) / 1000).toFixed(2);
    console.log(`✅ Transcription successful (${duration}s):`);
    console.log(`   "${text}"`);
  } catch (err) {
    console.error("❌ Single file transcription failed:", err.message);
  }

  // Test 2: Multi-player voice input collection
  console.log(`\n[Test 2] Testing collectPlayerVoiceInputs (multi-player mock)...`);
  try {
    const buffer = await readFile(targetFile);
    const base64 = buffer.toString("base64");

    const playerAudios = [
      { playerId: "player1", audioBase64: base64, mimeType },
      { playerId: "player2", audioBase64: base64, mimeType },
    ];

    const results = await collectPlayerVoiceInputs(playerAudios);
    console.log("✅ Multi-player results:");
    for (const res of results) {
      console.log(`   ${res.playerId}: "${res.text}"`);
    }
  } catch (err) {
    console.error("❌ Multi-player test failed:", err.message);
  }

  console.log("\nDone!");
}

run();

