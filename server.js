import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { existsSync } from 'fs';
import { networkInterfaces } from 'os';
import { ServerGame } from './src/server/ServerGame.js';
import { NetworkManager } from './src/server/NetworkManager.js';
import { HTTP_PORT } from './src/shared/constants.js';

// Patch Three.js with BVH-accelerated raycasting (same as client main.js)
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// ── Resolve project root for static file serving ──
// Prefer dist/ (Vite build output) when available, fall back to project root.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const distDir = resolve(__dirname, 'dist');
const staticRoot = existsSync(distDir) ? distDir : resolve(__dirname);

// ── Generate a deterministic seed (or use env) ──
const seed = process.env.SEED ? parseFloat(process.env.SEED) : Math.random() * 65536;

// ── Create game and network ──
const game = new ServerGame({ seed });
const network = new NetworkManager(game, staticRoot);
game.setNetwork(network);

// ── Initialize world & start ──
await game.init();
network.start();
game.start();

// ── Print LAN info ──
function getLanIP() {
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                return net.address;
            }
        }
    }
    return '127.0.0.1';
}

const lanIP = getLanIP();
const port = parseInt(process.env.PORT, 10) || HTTP_PORT;
const proto = process.env.SSL_CERT ? 'https' : 'http';
const wsProto = process.env.SSL_CERT ? 'wss' : 'ws';
console.log('');
console.log('═══════════════════════════════════════════');
console.log('  Island Conquest — LAN Multiplayer Server');
console.log('═══════════════════════════════════════════');
console.log(`  Seed:      ${seed.toFixed(2)}`);
console.log(`  Local:     ${proto}://localhost:${port}`);
console.log(`  LAN:       ${proto}://${lanIP}:${port}`);
console.log(`  WebSocket: ${wsProto}://${lanIP}:${port}`);
console.log('═══════════════════════════════════════════');
console.log('');

// ── Graceful shutdown ──
process.on('SIGINT', () => {
    console.log('\n[Server] Shutting down...');
    game.stop();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n[Server] Shutting down...');
    game.stop();
    process.exit(0);
});
