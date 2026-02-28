/**
 * Shared constants used by both server and client.
 */

// Server tick rate
export const TICK_RATE = 64;
export const TICK_INTERVAL = 1 / TICK_RATE;  // ~15.625ms

// Map dimensions (must match Island.js)
export const MAP_WIDTH = 300;
export const MAP_DEPTH = 120;

// Players
export const MAX_PLAYERS = 10;
export const TEAM_SIZE = 15;  // AI soldiers per team
export const AI_UPDATES_PER_TICK = 8;  // how many AI controllers update per tick (staggered)

// Gameplay
export const RESPAWN_DELAY = 5;  // seconds
export const WIN_SCORE = 500;
export const SCORE_INTERVAL = 3;  // seconds between scoring ticks
export const ROUND_COUNTDOWN = 30; // seconds between game over and round restart

// Network
export const DEFAULT_PORT = 8088;
export const HTTP_PORT = 8088;
export const INTERPOLATION_DELAY = 2;  // ticks behind server time for remote entities
export const PREDICTION_TOLERANCE = 0.1;  // meters; below this, no correction

// Physics
export const GRAVITY = 9.8;
export const MOVE_SPEED = 6;
export const JUMP_SPEED = 5;
export const ACCEL = 20;
export const DECEL = 12;
