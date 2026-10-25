// shared/constants.js
// Fixed facts about the world. Tunable feel numbers live in config.js.

export const ARENA = { W: 1000, H: 600 }; // world units; flat, fully walled
export const SCALE = 20;                  // world units per Planck meter (arena = 50 x 30 m)

export const CAR_SIZE = { W: 40, H: 24 }; // world units, W along the car's forward axis

export const MIN_PLAYERS = 4;
export const MAX_PLAYERS = 8;
export const NAME_MAX = 12; // longer player names are cut by the server

// Static pillars (world units). Hitting one costs speed and a little HP, like a wall.
// Four pillars in the gaps between the spawn lanes: the middle stays open for clashes, and the
// straight drive from every spawn point to the center misses them (closest: 56 units, a corner lane; 55 is the limit, so they cannot go wider).
export const OBSTACLES = [
  { x: 330, y: 150, r: 32 },
  { x: 670, y: 150, r: 32 },
  { x: 330, y: 450, r: 32 },
  { x: 670, y: 450, r: 32 },
];

// Where cars start (world units), facing the center. Corners first, then the middle of each
// edge, so any number of players is spread out (2 players: opposite corners; 4: all corners).
export const SPAWN_POINTS = [
  { x: 90, y: 90 }, { x: 910, y: 510 }, { x: 910, y: 90 }, { x: 90, y: 510 },
  { x: 70, y: 300 }, { x: 930, y: 300 }, { x: 500, y: 70 }, { x: 500, y: 530 },
];

export const SPAWN_RADIUS = 220; // fake.js only: it still spawns on a circle

// Car stats. maxSpeed in m/s, turnRate in rad/s.
// MVP: everyone drives 'balanced'. 'heavy' and 'light' are post-MVP (car picking).
export const CARS = {
  balanced: { label: 'Balanced', hp: 100, density: 1.0, maxSpeed: 14, turnRate: 3.2 },
  heavy:    { label: 'Tank',     hp: 140, density: 1.6, maxSpeed: 11, turnRate: 2.5 },
  light:    { label: 'Dart',     hp: 75,  density: 0.7, maxSpeed: 17, turnRate: 4.0 },
};
export const DEFAULT_CAR = 'balanced';

// One color per player slot (LobbyPlayer.color is the index).
export const PLAYER_COLORS = [
  '#ff5a5f', '#3fa7ff', '#ffd23f', '#5ce1a0',
  '#c77dff', '#ff9f43', '#4dd0e1', '#f06292',
];
