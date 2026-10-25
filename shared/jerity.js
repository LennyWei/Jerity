// Shared limits for the round-opening voice exchange.
export const JERITY = {
  LISTEN_MS: 6000,
  LISTEN_CUE_TIMEOUT_MS: 4000,
  TURN_AWAY_MS: 4000,
  UPLOAD_GRACE_MS: 1500,
  MAX_AUDIO_BYTES: 512 * 1024,
  PIPELINE_TIMEOUT_MS: 60000,
  TTS_TIMEOUT_MS: 25000,
  PLAYBACK_TIMEOUT_MS: 15000,
};

export const JERITY_LISTENING_CLIPS = [
  '/audio/jerity/listening-1.mp3',
  '/audio/jerity/listening-2.mp3',
  '/audio/jerity/listening-3.mp3',
];

export const JERITY_AUDIO_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/wav', 'audio/mpeg'];
