// server/index.js
// The real server: Express serves the built client and Socket.IO runs the game, on one port.
// Run: npm run dev (restarts when files change) or npm start. Rooms and loops live in rooms.js.

import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';

import { createRooms } from './rooms.js';

const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '../client/dist');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } }); // pages served elsewhere (Vite, Vercel) can connect too
const rooms = createRooms(io);

app.use(express.static(DIST));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.codes() }));
// Client routes like /join/ABCD and /spectate/ABCD all load index.html (once the client has one).
app.get('*', (_req, res, next) => {
  const index = path.join(DIST, 'index.html');
  if (fs.existsSync(index)) res.sendFile(index);
  else next();
});

io.on('connection', rooms.attach);

server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.error(`Port ${PORT} is already in use: another game server (npm run dev, npm start or npm run fake) `
    + 'is still running. Stop it first (Ctrl+C in its terminal), or set PORT to another port.');
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`Bumper Brawl server on http://localhost:${PORT}  (room TEST is always running)`);
});
