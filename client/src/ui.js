// client/src/ui.js
// Small DOM helpers shared by the menu screens. Person 4 owns this file.

import QRCode from 'qrcode';
import { PLAYER_COLORS } from '../../shared/constants.js';

/** h('button.btn.primary', { onclick }, 'Start') -> element. Text children are escaped. */
export function h(tag, props = {}, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

export const colorOf = (p, i = 0) => PLAYER_COLORS[(p?.color ?? i) % PLAYER_COLORS.length];

/** Keeps ?server=... when the page is hosted apart from the game server (e.g. Vercel). */
export const keepQuery = () => {
  const server = new URLSearchParams(location.search).get('server');
  return server ? `?server=${encodeURIComponent(server)}` : '';
};

/** Link a phone scans to join this room. */
export const joinUrl = (code) => `${location.origin}/join/${code}${keepQuery()}`;

/** Fill `el` with a QR code (SVG) for `text`. */
export async function renderQr(el, text) {
  try {
    el.innerHTML = await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    el.setAttribute('aria-label', `QR code: ${text}`);
  } catch (err) {
    console.warn('QR failed', err);
  }
}

/** localStorage that never throws (private mode, blocked storage). */
export const store = {
  get(k, d = '') { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};
