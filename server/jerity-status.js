// Public diagnostics expose configuration presence only, never credential values.
export function jerityStatus() {
  const required = ['GROQ_API_KEY', 'GEMINI_API_KEY', 'FISH_AUDIO_API_KEY', 'FISH_AUDIO_VOICE_ID'];
  const missing = required.filter(key => !process.env[key]?.trim());
  return { protocolVersion: 1, configured: missing.length === 0, missing };
}
