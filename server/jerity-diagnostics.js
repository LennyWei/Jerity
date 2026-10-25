import { JERITY, JERITY_AUDIO_TYPES } from '../shared/jerity.js';

export function validRecording(msg) {
  const mime = typeof msg.mimeType === 'string' ? msg.mimeType.split(';')[0].trim() : '';
  return JERITY_AUDIO_TYPES.includes(mime) && typeof msg.audioBase64 === 'string' &&
    msg.audioBase64.length > 0 && msg.audioBase64.length <= Math.ceil(JERITY.MAX_AUDIO_BYTES / 3) * 4 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(msg.audioBase64) && Buffer.byteLength(msg.audioBase64, 'base64') <= JERITY.MAX_AUDIO_BYTES;
}

export function providerError(provider, error) {
  if (/not configured/i.test(error.message)) return `${provider} is not configured on the game server.`;
  const status = error.message.match(/\b(4\d\d|5\d\d)\b/)?.[1];
  if (status === '401' || status === '403') return `${provider} rejected the server credentials (${status}).`;
  if (status === '402' || status === '429') return `${provider} quota, billing, or rate limit error (${status}).`;
  if (/timeout|abort/i.test(error.message)) return `${provider} timed out. Try again.`;
  return `${provider} failed${status ? ` (${status})` : ''}. Check the game server logs.`;
}
