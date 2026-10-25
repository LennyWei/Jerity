// Per-match personality, per-round audio -> transcription -> ruling -> voice.
import { Verity } from './verity.js';
import { collectPlayerVoiceInputs, simulateVoiceInputs } from './verity-stt.js';
import { speakVerity } from './verity-voice.js';

export class VerityPipeline {
  constructor() { this.reset(); }
  async runCycle(gameState, playerAudios, options = {}) {
    this.cycleCount++;
    const inputs = await collectPlayerVoiceInputs(playerAudios, options);
    return this._processAndSpeak(gameState, inputs, options);
  }
  async runCycleSimulated(gameState, textInputs, options = {}) {
    this.cycleCount++;
    return this._processAndSpeak(gameState, simulateVoiceInputs(textInputs), options);
  }
  async _processAndSpeak(gameState, playerInputs, options = {}) {
    const start = performance.now();
    options.signal?.throwIfAborted();
    const ruling = await this.verity.processPlayerInputs(gameState, playerInputs, options);
    options.signal?.throwIfAborted();
    // Generate both clips concurrently; the room controls playback order.
    const audioBuffers = options.skipTts ? [] : await Promise.all(
      ruling.voiceLines.map(async line => {
        const began = performance.now();
        try {
          const audio = await speakVerity(line.text, options);
          return { ...line, audio, latencyMs: Math.round(performance.now() - began) };
        } catch (error) {
          return { ...line, audio: null, error: error.message };
        }
      })
    );
    return {
      ruling, events: ruling.events, voiceLines: ruling.voiceLines,
      internalState: ruling.internalState || {}, audioBuffers,
      cycleNumber: this.cycleCount, geminiLatencyMs: ruling.latencyMs || 0,
      totalTtsMs: audioBuffers.reduce((sum, line) => sum + (line.latencyMs || 0), 0),
      totalCycleMs: Math.round(performance.now() - start),
    };
  }
  getState() {
    const v = this.verity;
    return { eventCount: v.eventCount, chaosLevel: v.chaosLevel, mood: v.mood,
      favoritePlayer: v.favoritePlayer, grudgePlayer: v.grudgePlayer,
      playerNeediness: { ...v.playerNeediness }, historyLength: v.history.length };
  }
  reset() { this.verity = new Verity(); this.cycleCount = 0; }
}

