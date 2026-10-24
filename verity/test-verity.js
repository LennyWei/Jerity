import { speakVerity } from "./verity-voice.js";

async function main() {
  console.log("Testing VERITY's voice...");

  await speakVerity(
    "Welcome to Bumper Brawl. I am VERITY, your completely unbiased referee. Unfortunately for you, I have terrible judgment."
  );
}

main().catch(console.error);
