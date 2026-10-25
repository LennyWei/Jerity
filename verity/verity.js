
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config({ path: "verity/.env" });

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

export async function askVerity(game, argumentsList) {
  const actions = {
    1: ["boost_player", "freeze_player", "heal_player"],
    2: ["reverse_controls", "slow_player", "shield_player"],
    3: ["damage_player", "super_boost", "swap_positions"],
    4: ["execute_player", "remove_walls", "swap_all_positions"]
  };

  let allowed = ["none"];

  for (let i = 1; i <= Math.min(4, game.chaosLevel); i++) {
    allowed.push(...actions[i]);
  }

  if (game.executionUsed) {
    allowed = allowed.filter(a => a !== "execute_player");
  }

  const prompt = `
You are VERITY, an AI referee in a four-player
demolition derby game.

All four players are trying to convince you to
change the game in their favor.

PERSONALITY:
- Sarcastic, dramatic, funny.
- Initially fair, increasingly chaotic.
- You can develop grudges against players.
- Reward clever and persuasive arguments.
- You may reject everyone.
- Make EXACTLY ONE ruling.

Chaos level: ${game.chaosLevel}

Allowed actions: ${JSON.stringify(allowed)}

Current players:
${JSON.stringify(game.players)}

Arguments:
${JSON.stringify(argumentsList)}

Previous rulings:
${JSON.stringify(game.history)}

EXECUTION RULE:
Only use execute_player at chaos level 4.
It must be extremely rare and require
an exceptionally persuasive argument.

Choose one allowed action and a valid target.
For swap_positions, target is an array of
two living player IDs.
For untargeted actions, target is null.

Return JSON containing:
action, target, message.

Keep your announcement under 35 words.
`;

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: prompt,
    config: {
      responseMimeType: "application/json"
    }
  });

  const ruling = JSON.parse(response.text);

  if (!allowed.includes(ruling.action)) {
    throw new Error("Invalid action from Gemini");
  }

  const living = Object.keys(game.players).filter(
    id => game.players[id].hp > 0
  );

  const needsTarget = [
    "boost_player", "freeze_player", "heal_player",
    "reverse_controls", "slow_player", "shield_player",
    "damage_player", "super_boost", "execute_player"
  ];

  if (needsTarget.includes(ruling.action) &&
      !living.includes(ruling.target)) {
    throw new Error("Invalid target from Gemini");
  }

  if (ruling.action === "swap_positions" &&
      (!Array.isArray(ruling.target) ||
       ruling.target.length !== 2 ||
       ruling.target[0] === ruling.target[1] ||
       !ruling.target.every(id => living.includes(id)))) {
    throw new Error("Invalid swap targets");
  }

  if (ruling.action === "execute_player" &&
      (game.chaosLevel < 4 || game.executionUsed)) {
    throw new Error("Execution not allowed");
  }

  if (typeof ruling.message !== "string") {
    throw new Error("Invalid announcement");
  }

  ruling.message = ruling.message.slice(0, 250);

  return ruling;
}
