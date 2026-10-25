// verity/verity-pipeline.js
// End-to-end pipeline: Voice → Text → Gemini → Events + Voice Lines → TTS
//
// This module orchestrates the full Jerity/Verity cycle:
//   1. Collect player voice recordings (10s each, in parallel)
//   2. Transcribe all recordings via STT
//   3. Feed transcriptions + game state into Verity (Gemini)
//   4. Speak Jerity's voice lines via TTS
//   5. Return the ruling (events to apply to the game)
//
// Usage:
//   const pipeline = new VerityPipeline();
//   const result = await pipeline.runCycle(gameState, playerAudios);
//   // result.events → apply to game
//   // result.audioBuffers → play in order

import { Verity } from "./verity.js";
import { collectPlayerVoiceInputs, simulateVoiceInputs } from "./verity-stt.js";
import { speakVerity } from "./verity-voice.js";

export class VerityPipeline {
  constructor() {
    this.verity = new Verity();
    this.cycleCount = 0;
  }

  /**
   * Run a full Verity cycle with real audio inputs.
   *
   * @param {Object} gameState - { players: { [id]: { hp, maxHp, ... } }, chaosLevel? }
   * @param {Array<{playerId: string, audioBase64: string, mimeType?: string}>} playerAudios
   * @returns {Promise<PipelineResult>}
   */
  async runCycle(gameState, playerAudios) {
    this.cycleCount++;
    console.log(`\n══════ VERITY CYCLE ${this.cycleCount} ══════`);

    // Step 1: Transcribe all player audio → text
    console.log("Step 1: Transcribing player audio...");
    const playerInputs = await collectPlayerVoiceInputs(playerAudios);
    for (const inp of playerInputs) {
      console.log(`  ${inp.playerId}: "${inp.text}"`);
    }

    // Step 2-3: Feed into Verity
    return this._processAndSpeak(gameState, playerInputs);
  }

  /**
   * Run a cycle with simulated text inputs (for testing without microphones).
   *
   * @param {Object} gameState - { players: { [id]: { hp, maxHp, ... } }, chaosLevel? }
   * @param {Array<{playerId: string, text: string}>} textInputs
   * @param {Object} [options]
   * @param {boolean} [options.skipTts=false] - Skip TTS generation (faster for testing)
   * @returns {Promise<PipelineResult>}
   */
  async runCycleSimulated(gameState, textInputs, options = {}) {
    this.cycleCount++;
    console.log(`\n══════ VERITY CYCLE ${this.cycleCount} (simulated) ══════`);

    // Use simulated text inputs directly
    const playerInputs = simulateVoiceInputs(textInputs);
    for (const inp of playerInputs) {
      console.log(`  ${inp.playerId}: "${inp.text}"`);
    }

    return this._processAndSpeak(gameState, playerInputs, options);
  }

  /**
   * Internal: process inputs through Verity and generate TTS.
   */
  async _processAndSpeak(gameState, playerInputs, options = {}) {
    const cycleStartTime = performance.now();

    // Step 2: Process through Verity (Gemini)
    console.log("\nStep 2: Consulting JERITY (Gemini Flash)...");
    const ruling = await this.verity.processPlayerInputs(gameState, playerInputs);
    const geminiLatencyMs = ruling.latencyMs || 0;
    console.log(`  ⏱️ Gemini API latency: ${geminiLatencyMs} ms (${(geminiLatencyMs / 1000).toFixed(2)}s)`);

    console.log("\n── JERITY'S RULING ──");
    console.log(`Mood: ${ruling.internalState?.mood}`);
    console.log(`Chaos: ${ruling.internalState?.chaosLevel}/10`);
    console.log(`Favorite: ${ruling.internalState?.favoritePlayer || "none"}`);
    console.log(`Grudge: ${ruling.internalState?.grudgePlayer || "none"}`);

    console.log("\nEvents:");
    for (const event of ruling.events || []) {
      console.log(`  → ${event.action} on ${event.target || "n/a"} (${event.reason})`);
      if (event.params) console.log(`    params: ${JSON.stringify(event.params)}`);
    }

    console.log("\nVoice lines:");
    for (const line of ruling.voiceLines || []) {
      console.log(`  [${line.timing}] "${line.text}"`);
    }

    // Step 3: Generate TTS for voice lines (unless skipped)
    const audioBuffers = [];
    let totalTtsMs = 0;
    if (!options.skipTts) {
      console.log("\nStep 3: Generating JERITY voice (Fish Audio)...");
      for (const line of ruling.voiceLines || []) {
        try {
          const ttsStart = performance.now();
          const audio = await speakVerity(line.text);
          const ttsLatencyMs = Math.round(performance.now() - ttsStart);
          totalTtsMs += ttsLatencyMs;
          audioBuffers.push({ timing: line.timing, text: line.text, audio, latencyMs: ttsLatencyMs });
          console.log(`  ✓ Generated audio for: "${line.text}" (${ttsLatencyMs} ms)`);
        } catch (err) {
          console.error(`  ✗ TTS failed for: "${line.text}" — ${err.message}`);
          audioBuffers.push({ timing: line.timing, text: line.text, audio: null, error: err.message });
        }
      }
    } else {
      console.log("\nStep 3: TTS skipped (testing mode)");
    }

    const totalCycleMs = Math.round(performance.now() - cycleStartTime);
    console.log(`\n⏱️ Total Cycle Time: ${totalCycleMs} ms (Gemini: ${geminiLatencyMs} ms${!options.skipTts ? `, TTS: ${totalTtsMs} ms` : ""})`);
    console.log(`══════ CYCLE ${this.cycleCount} COMPLETE ══════\n`);

    return {
      ruling,
      events: ruling.events || [],
      voiceLines: ruling.voiceLines || [],
      internalState: ruling.internalState || {},
      audioBuffers,
      cycleNumber: this.cycleCount,
      geminiLatencyMs,
      totalTtsMs,
      totalCycleMs,
    };
  }

  /**
   * Get the current state of Jerity's personality.
   */
  getState() {
    return {
      eventCount: this.verity.eventCount,
      chaosLevel: this.verity.chaosLevel,
      mood: this.verity.mood,
      favoritePlayer: this.verity.favoritePlayer,
      grudgePlayer: this.verity.grudgePlayer,
      playerNeediness: { ...this.verity.playerNeediness },
      historyLength: this.verity.history.length,
    };
  }

  /**
   * Reset the pipeline state (new game).
   */
  reset() {
    this.verity = new Verity();
    this.cycleCount = 0;
  }
}

