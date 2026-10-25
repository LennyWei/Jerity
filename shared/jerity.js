// Shared limits for the round-opening voice exchange.
export const JERITY = {
  LISTEN_MS: 4500,
  UPLOAD_GRACE_MS: 1500,
  MAX_AUDIO_BYTES: 512 * 1024,
  PIPELINE_TIMEOUT_MS: 45000,
  PLAYBACK_TIMEOUT_MS: 15000,
};

export const JERITY_AUDIO_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/wav', 'audio/mpeg'];
