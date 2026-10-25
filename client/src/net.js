// client/src/net.js
// Socket.IO wrapper in the shape the game screen expects. Person 4 owns this file.
//
//   import { net } from './net.js';
//   const off = net.on(S2C.LOBBY, (lobby) => ...);  // returns an unsubscribe function
//   net.emit(C2S.READY, { ready: true });
//   const res = await net.request(C2S.JOIN_ROOM, { code, name }); // ack as a promise
//
// The server is the page's own origin (the game server serves the client). A page hosted
// elsewhere, like Vercel, points at the game server (e.g. Render) with VITE_SERVER_URL at build
// time, or ?server=https://host in the address.
//
// A sleeping server (Render's free plan) can take about a minute to wake, so requests wait for
// the connection first instead of failing after a few seconds.

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

    /**
     * emit with an ack, as a promise. Waits up to connectMs for the connection (a sleeping
     * server waking up), then timeoutMs for the answer. Resolves { error } instead of hanging.
     */
    async request(event, payload, timeoutMs = 6000, connectMs = 75000) {
      if (!socket.connected) {
        const up = await new Promise((resolve) => {
          const done = (ok) => { clearTimeout(timer); socket.off('connect', onUp); resolve(ok); };
          const onUp = () => done(true);
          const timer = setTimeout(() => done(false), connectMs);
          socket.on('connect', onUp);
        });
        if (!up) return { error: 'Can’t reach the game server. Check your connection and try again.' };
      }
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
