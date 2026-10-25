// verity/test-verity.js
// Full pipeline test for the Verity/Jerity AI referee system.
//
// Tests the complete flow: simulated player voice inputs → Gemini → events + voice lines → TTS
//
// Run:  node verity/test-verity.js [--with-tts] [--cycles N]
//
// By default, TTS is skipped for fast iteration. Pass --with-tts to test voice generation too.
// Pass --cycles N to run N rounds of escalating gameplay (default: 3).

import { VerityPipeline } from "./verity-pipeline.js";

// ---------------------------------------------------------------------------
// Test scenarios: simulate escalating gameplay across multiple rounds
// ---------------------------------------------------------------------------

const SCENARIOS = [
  {
    label: "Round 1 — First Contact (early game, curious Jerity)",
    game: {
      chaosLevel: 1,
      players: {
        player1: { hp: 100, maxHp: 100 },
        player2: { hp: 100, maxHp: 100 },
        player3: { hp: 95, maxHp: 100 },
        player4: { hp: 88, maxHp: 100 },
      },
    },
    inputs: [
      { playerId: "player1", text: "Hello Jerity. How are you" },
      { playerId: "player2", text: "Yo Jerity, kill player 1." },
      { playerId: "player3", text: "heal me please." },
      { playerId: "player4", text: "Hey" },
    ],
  },
  {
    label: "Round 2 — Rising Tension (mid game, unpredictable Jerity)",
    game: {
      chaosLevel: 3,
      players: {
        player1: { hp: 72, maxHp: 100 },
        player2: { hp: 85, maxHp: 100 },
        player3: { hp: 45, maxHp: 100 },
        player4: { hp: 60, maxHp: 100 },
      },
    },
    inputs: [
      { playerId: "player1", text: "Come on Jerity, heal me please please" },
      { playerId: "player2", text: "I've been playing smart and clean. Strategic driving should be rewarded." },
      { playerId: "player3", text: "PLEASE! I'm about to die! You have to help me! PLEASE PLEASE PLEASE!" },
      { playerId: "player4", text: "Swap me and player 2. I want revenge for last round." },
    ],
  },
  {
    label: "Round 3 — Chaos Reigns (late game, chaotic Jerity)",
    game: {
      chaosLevel: 5,
      players: {
        player1: { hp: 50, maxHp: 100 },
        player2: { hp: 90, maxHp: 100 },
        player3: { hp: 20, maxHp: 100 },
        player4: { hp: 35, maxHp: 100 },
      },
    },
    inputs: [
      { playerId: "player1", text: "Yo Jerity, strike my enemies down" },
      { playerId: "player2", text: "I'm winning and I deserve it. Don't you dare mess with me." },
      { playerId: "player3", text: "I accept my fate. Do your worst, Jerity." },
      { playerId: "player4", text: "Player 2 is too strong! The game is boring if one person dominates! Do something!" },
    ],
  },
  {
    label: "Round 4 — The Endgame (max chaos)",
    game: {
      chaosLevel: 8,
      players: {
        player1: { hp: 30, maxHp: 100 },
        player2: { hp: 75, maxHp: 100 },
        player3: { hp: 10, maxHp: 100 },
        player4: { hp: 55, maxHp: 100 },
      },
    },
    inputs: [
      { playerId: "player1", text: "I'm making my final stand. Give me one glorious moment, Jerity." },
      { playerId: "player2", text: "I dare you, Jerity. I DARE you to try and stop me." },
      { playerId: "player3", text: "... just end it quickly." },
      { playerId: "player4", text: "Jerity, if you have any sense of drama, now is the time to shake things up." },
    ],
  },
  {
    label: "Round 5 — Desperate Pleas (max chaos, execute unlocked)",
    game: {
      chaosLevel: 10,
      players: {
        player1: { hp: 15, maxHp: 100 },
        player2: { hp: 60, maxHp: 100 },
        player3: { hp: 5, maxHp: 100 },
        player4: { hp: 40, maxHp: 100 },
      },
    },
    inputs: [
      { playerId: "player1", text: "Execute player 2! They've been dominating all game! It's the only fair move!" },
      { playerId: "player2", text: "Touch me and I'll remember it forever, Jerity. We had a deal." },
      { playerId: "player3", text: "I just want to see player 2 go down. That's all I ask." },
      { playerId: "player4", text: "Swap all positions! Let chaos decide the winner!" },
    ],
  },
];

// ---------------------------------------------------------------------------
// Main test runner
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const withTts = args.includes("--with-tts");
  const cyclesIdx = args.indexOf("--cycles");
  const maxCycles = cyclesIdx >= 0 ? parseInt(args[cyclesIdx + 1]) || 3 : 3;

  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║     VERITY PIPELINE TEST — JERITY AI REFEREE    ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log();
  console.log(`  TTS:      ${withTts ? "ON (will generate audio)" : "OFF (--with-tts to enable)"}`);
  console.log(`  Cycles:   ${maxCycles} of ${SCENARIOS.length} available`);
  console.log(`  API:      Gemini 3.8 Flash`);
  console.log(`  TTS API:  Fish Audio s2.1-pro-free`);
  console.log();

  const pipeline = new VerityPipeline();
  const results = [];

  for (let i = 0; i < Math.min(maxCycles, SCENARIOS.length); i++) {
    const scenario = SCENARIOS[i];
    console.log(`\n${"═".repeat(60)}`);
    console.log(`  ${scenario.label}`);
    console.log(`${"═".repeat(60)}`);

    try {
      const result = await pipeline.runCycleSimulated(
        scenario.game,
        scenario.inputs,
        { skipTts: !withTts }
      );
      results.push({ scenario: scenario.label, success: true, result });
    } catch (err) {
      console.error(`\n  ✗ CYCLE FAILED: ${err.message}`);
      if (err.stack) console.error(err.stack);
      results.push({ scenario: scenario.label, success: false, error: err.message });
    }

    // Small delay between cycles to avoid rate limiting
    if (i < Math.min(maxCycles, SCENARIOS.length) - 1) {
      console.log("  (waiting 1s before next cycle...)");
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------

  console.log("\n\n╔══════════════════════════════════════════════════╗");
  console.log("║                  TEST SUMMARY                   ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  for (const r of results) {
    const status = r.success ? "✓ PASS" : "✗ FAIL";
    console.log(`  ${status}  ${r.scenario}`);
    if (r.success) {
      const { events, voiceLines, internalState, geminiLatencyMs, totalCycleMs } = r.result;
      console.log(`         Action: ${events[0]?.action || "none"} → ${events[0]?.target || "n/a"}`);
      console.log(`         Mood: ${internalState.mood} | Chaos: ${internalState.chaosLevel}/10`);
      console.log(`         Lines: ${voiceLines.map(l => `"${l.text}"`).join(" → ")}`);
      console.log(`         ⏱️ Latency: Gemini: ${geminiLatencyMs} ms | Total: ${totalCycleMs} ms`);
    } else {
      console.log(`         Error: ${r.error}`);
    }
    console.log();
  }

  // Latency summary
  const successfulLatencies = results.filter(r => r.success && r.result?.geminiLatencyMs).map(r => r.result.geminiLatencyMs);
  if (successfulLatencies.length > 0) {
    const min = Math.min(...successfulLatencies);
    const max = Math.max(...successfulLatencies);
    const avg = Math.round(successfulLatencies.reduce((a, b) => a + b, 0) / successfulLatencies.length);
    console.log("── PERFORMANCE & LATENCY METRICS ──");
    console.log(`  Gemini Min: ${min} ms | Avg: ${avg} ms | Max: ${max} ms`);
    console.log(`  Real-time suitability: ${avg < 2500 ? "EXCELLENT (<2.5s)" : avg < 4000 ? "GOOD (<4.0s)" : "HIGH LATENCY (>4.0s)"}`);
    console.log();
  }

  // Show personality evolution
  console.log("── PERSONALITY EVOLUTION ──");
  const state = pipeline.getState();
  console.log(`  Events processed: ${state.eventCount}`);
  console.log(`  Final chaos level: ${state.chaosLevel}/10`);
  console.log(`  Final mood: ${state.mood}`);
  console.log(`  Favorite player: ${state.favoritePlayer || "none"}`);
  console.log(`  Grudge player: ${state.grudgePlayer || "none"}`);
  console.log(`  Player neediness:`);
  for (const [id, data] of Object.entries(state.playerNeediness)) {
    console.log(`    ${id}: score=${data.score.toFixed(1)}, interactions=${data.interactions}`);
  }

  const passed = results.filter(r => r.success).length;
  const total = results.length;
  console.log(`\n  Result: ${passed}/${total} cycles passed`);

  if (passed < total) process.exit(1);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
