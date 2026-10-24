// client/src/net.js
// Socket.IO wrapper in the shape the game screen expects. Person 4 owns this file.
//
//   import { net } from './net.js';
//   const off = net.on(S2C.LOBBY, (lobby) => ...);  // returns an unsubscribe function
//   net.emit(C2S.READY, { ready: true });
//   const res = await net.request(C2S.JOIN_ROOM, { code, name }); // ack as a promise
//
// The server is the page's own origin (the game server serves the client). A page hosted
// elsewhere, like Vercel, can point at the game server with ?server=https://host or
// VITE_SERVER_URL at build time.

import { io } from 'socket.io-client';

const SERVER = new URLSearchParams(location.search).get('server') || import.meta.env.VITE_SERVER_URL || undefined;

export function createNet(url = SERVER) {
  const socket = io(url, { transports: ['websocket', 'polling'] });

  return {
    socket,
    get id() { return socket.id; },
    get connected() { return socket.connected; },

    /** Listen to a server event. Returns a function that stops listening. */
    on(event, fn) {
      socket.on(event, fn);
      return () => socket.off(event, fn);
    },

    emit(event, payload, ack) {
      if (typeof ack === 'function') socket.emit(event, payload ?? {}, ack);
      else socket.emit(event, payload ?? {});
    },

    /** emit with an ack, as a promise. Resolves { error } on timeout instead of hanging. */
    request(event, payload, timeoutMs = 6000) {
      return new Promise((resolve) => {
        socket.timeout(timeoutMs).emit(event, payload ?? {}, (err, res) => {
          resolve(err ? { error: 'No answer from the server. Check your connection.' } : res ?? {});
        });
      });
    },

    /** fn(connected: boolean) on every connect / disconnect. Returns an unsubscribe function. */
    onStatus(fn) {
      const up = () => fn(true), down = () => fn(false);
      socket.on('connect', up);
      socket.on('disconnect', down);
      socket.on('connect_error', down);
      return () => { socket.off('connect', up); socket.off('disconnect', down); socket.off('connect_error', down); };
    },
  };
}

export const net = createNet();
