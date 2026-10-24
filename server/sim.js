// server/sim.js
// Plays a round headless (no sockets, no waiting) to check the game in a terminal.
// Phase A (now): one bot round with the stand-in physics, printing the events.
// Phase C adds scripted hits (side vs rear vs head-on, wall, kill) to compare with design.md.
//
// Run: npm run sim

import { EVENT } from '../shared/protocol.js';
import { MIN_PLAYERS } from '../shared/constants.js';
import { CONFIG } from '../shared/config.js';
import { createGame } from './game.js';
import { botInput } from './bots.js';

const dt = 1 / CONFIG.TICK_HZ;
const bots = Array.from({ length: MIN_PLAYERS }, (_, i) => ({ id: `bot${i + 1}`, isBot: true }));
const game = createGame(bots);
const counts = {};

while (!game.over()) {
  game.step(new Map(bots.map(b => [b.id, botInput(game, b)])), dt);
  for (const e of game.snapshot().events) {
    counts[e.type] = (counts[e.type] || 0) + 1;
    if (e.type !== EVENT.WALL) console.log(`${(game.now / 1000).toFixed(1).padStart(6)} s`, JSON.stringify(e));
  }
}

console.log(`\nround over at ${(game.now / 1000).toFixed(1)} s, winner: ${game.winnerId()}`);
console.log('events:', counts);
for (const b of bots) {
  const car = game.cars.get(b.id);
  const st = game.stats.get(b.id);
  console.log(`${b.id}  hp ${car.hp}  state ${car.s}  kills ${st.kills}  damage ${st.damage}`);
}
