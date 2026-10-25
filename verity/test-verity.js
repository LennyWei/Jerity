import { speakVerity } from "./verity-voice.js";

async function main() {
  console.log("Testing VERITY's voice...");

  await speakVerity(
    "I am JERITY, your completely unbiased referee. Unfortunately for you, I have terrible judgment."
  );
}

main().catch(console.error);
