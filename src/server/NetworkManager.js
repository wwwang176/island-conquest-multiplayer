import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, extname } from 'path';
import { WebSocketServer } from 'ws';
import { MsgType, decodeInput, decodeJoin, decodeRespawn, decodePing, encodePong, encodeWorldSeed, encodePlayerJoined, encodePlayerLeft } from '../shared/protocol.js';
import { DEFAULT_PORT, HTTP_PORT } from '../shared/constants.js';

const MIME_TYPES = {
    '.html': 'text/html',
    '.js':   'text/javascript',
    '.mjs':  'text/javascript',
    '.css':  'text/css',
    '.json': 'application/json',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.gif':  'image/gif',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
    '.woff': 'font/woff',
    '.woff2':'font/woff2',
};

// Rate limit buckets: { capacity, refillPerSec }
const RATE_LIMITS = {
    [MsgType.INPUT]:   { capacity: 80, refillPerSec: 70 },
    [MsgType.PING]:    { capacity: 3,  refillPerSec: 1  },
    [MsgType.JOIN]:    { capacity: 2,  refillPerSec: 1  },
    [MsgType.RESPAWN]: { capacity: 2,  refillPerSec: 1  },
    [MsgType.LEAVE]:   { capacity: 2,  refillPerSec: 1  },
};
const VIOLATION_KICK_THRESHOLD = 50; // cumulative drops before disconnect

/**
 * Manages WebSocket connections and serves static files.
 */
export class NetworkManager {
    /**
     * @param {object} serverGame - ServerGame instance for callbacks
     * @param {string} staticRoot - Root directory for static file serving
     */
    constructor(serverGame, staticRoot) {
        this.serverGame = serverGame;
        this.staticRoot = staticRoot;

        /** @type {Map<import('ws').WebSocket, { clientId: number, joinedTick: number }>} */
        this.clients = new Map();
        this._nextClientId = 1;

        // HTTP server for static files
        this.httpServer = createServer((req, res) => this._handleHTTP(req, res));

        // WebSocket server
        this.wss = new WebSocketServer({ noServer: true });

        // Upgrade HTTP → WebSocket for /ws path
        this.httpServer.on('upgrade', (req, socket, head) => {
            this.wss.handleUpgrade(req, socket, head, (ws) => {
                this.wss.emit('connection', ws, req);
            });
        });

        this.wss.on('connection', (ws) => this._onConnection(ws));
    }

    start() {
        this.httpServer.listen(HTTP_PORT, () => {
            console.log(`[HTTP] Static file server on http://localhost:${HTTP_PORT}`);
        });
        console.log(`[WS]   WebSocket server on ws://localhost:${HTTP_PORT} (upgrade)`);
    }

    // ── HTTP Static File Handler ──

    async _handleHTTP(req, res) {
        let urlPath = req.url.split('?')[0];
        if (urlPath === '/') urlPath = '/index.html';

        const filePath = join(this.staticRoot, urlPath);

        // Security: prevent directory traversal
        if (!filePath.startsWith(this.staticRoot)) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }

        if (!existsSync(filePath)) {
            res.writeHead(404);
            res.end('Not Found');
            return;
        }

        try {
            const data = await readFile(filePath);
            const ext = extname(filePath).toLowerCase();
            const contentType = MIME_TYPES[ext] || 'application/octet-stream';
            res.writeHead(200, {
                'Content-Type': contentType,
                'Cache-Control': 'no-cache',
                'Access-Control-Allow-Origin': '*',
            });
            res.end(data);
        } catch (err) {
            res.writeHead(500);
            res.end('Internal Server Error');
        }
    }

    // ── WebSocket Handlers ──

    _onConnection(ws) {
        const clientId = this._nextClientId++;
        // Initialize rate limit buckets per message type
        const rateBuckets = {};
        for (const [msgType, cfg] of Object.entries(RATE_LIMITS)) {
            rateBuckets[msgType] = { tokens: cfg.capacity, lastRefill: performance.now() };
        }
        this.clients.set(ws, { clientId, joinedTick: this.serverGame.tick, rtt: 0, rateBuckets, rateViolations: 0 });

        console.log(`[WS] Client ${clientId} connected (total: ${this.clients.size})`);
        this.serverGame.onClientConnected(clientId, ws);

        ws.binaryType = 'arraybuffer';

        ws.on('message', (data) => {
            if (!(data instanceof ArrayBuffer)) {
                // Node ws gives Buffer, convert
                const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
                this._onMessage(ws, clientId, buf);
            } else {
                this._onMessage(ws, clientId, data);
            }
        });

        ws.on('close', () => {
            console.log(`[WS] Client ${clientId} disconnected (total: ${this.clients.size - 1})`);
            this.clients.delete(ws);
            this.serverGame.onClientDisconnected(clientId);
        });

        ws.on('error', (err) => {
            console.error(`[WS] Client ${clientId} error:`, err.message);
        });
    }

    // Minimum buffer sizes per message type
    static MIN_BUF_SIZE = {
        [MsgType.INPUT]:   19, // msgType(1)+tick(4)+keys(2)+mouseDX(2)+mouseDY(2)+yaw(4)+pitch(4)
        [MsgType.JOIN]:     4, // msgType(1)+teamId(1)+weaponLen(1)+nameLen(1)
        [MsgType.LEAVE]:    1, // msgType(1)
        [MsgType.RESPAWN]:  2, // msgType(1)+weaponLen(1)
        [MsgType.PING]:     9, // msgType(1)+clientTimestamp(8)
    };

    _onMessage(ws, clientId, buf) {
        try {
            if (buf.byteLength < 1) return;
            const msgType = new DataView(buf).getUint8(0);

            // Validate buffer length
            const minSize = NetworkManager.MIN_BUF_SIZE[msgType];
            if (minSize && buf.byteLength < minSize) {
                console.warn(`[WS] Client ${clientId}: truncated msg 0x${msgType.toString(16)} (${buf.byteLength}/${minSize} bytes)`);
                return;
            }

            // Rate limiting (token bucket)
            const info = this.clients.get(ws);
            const rateConfig = RATE_LIMITS[msgType];
            if (info && rateConfig) {
                const bucket = info.rateBuckets[msgType];
                const now = performance.now();
                const elapsed = (now - bucket.lastRefill) / 1000;
                bucket.tokens = Math.min(rateConfig.capacity, bucket.tokens + elapsed * rateConfig.refillPerSec);
                bucket.lastRefill = now;
                if (bucket.tokens < 1) {
                    info.rateViolations++;
                    if (info.rateViolations >= VIOLATION_KICK_THRESHOLD) {
                        console.warn(`[WS] Client ${clientId}: rate limit exceeded, disconnecting`);
                        try { ws.close(1008, 'Rate limit exceeded'); } catch (_) {}
                    }
                    return; // drop message
                }
                bucket.tokens -= 1;
            }

            switch (msgType) {
                case MsgType.INPUT: {
                    const input = decodeInput(buf);
                    this.serverGame.onClientInput(clientId, input);
                    break;
                }
                case MsgType.JOIN: {
                    const join = decodeJoin(buf);
                    this.serverGame.onJoinRequest(clientId, join.team, join.weaponId, join.playerName);
                    break;
                }
                case MsgType.LEAVE: {
                    this.serverGame.onLeaveRequest(clientId);
                    break;
                }
                case MsgType.RESPAWN: {
                    const data = decodeRespawn(buf);
                    this.serverGame.onRespawnRequest(clientId, data.weaponId);
                    break;
                }
                case MsgType.PING: {
                    const ping = decodePing(buf);
                    const pong = encodePong(ping.clientTimestamp, performance.now());
                    this.send(ws, pong);
                    // Store client-reported RTT
                    const info = this.clients.get(ws);
                    if (info) info.rtt = ping.rtt || 0;
                    break;
                }
                default:
                    console.warn(`[WS] Unknown message type 0x${msgType.toString(16)} from client ${clientId}`);
            }
        } catch (err) {
            console.error(`[WS] Error processing message from client ${clientId}:`, err.message);
            try { ws.close(1008, 'Bad message'); } catch (_) { /* ignore close errors */ }
        }
    }

    // ── Send Methods ──

    /**
     * Send binary data to a specific client.
     * @param {import('ws').WebSocket} ws
     * @param {ArrayBuffer} buf
     */
    send(ws, buf) {
        if (ws.readyState === ws.OPEN) {
            ws.send(buf);
        }
    }

    /**
     * Send to a client by ID.
     * @param {number} clientId
     * @param {ArrayBuffer} buf
     */
    sendToClient(clientId, buf) {
        for (const [ws, info] of this.clients) {
            if (info.clientId === clientId) {
                this.send(ws, buf);
                return;
            }
        }
    }

    /**
     * Broadcast binary data to all connected clients.
     * @param {ArrayBuffer} buf
     */
    broadcast(buf) {
        for (const [ws] of this.clients) {
            this.send(ws, buf);
        }
    }

    /**
     * Broadcast to all clients except one.
     * @param {ArrayBuffer} buf
     * @param {number} excludeClientId
     */
    broadcastExcept(buf, excludeClientId) {
        for (const [ws, info] of this.clients) {
            if (info.clientId !== excludeClientId) {
                this.send(ws, buf);
            }
        }
    }

    /**
     * Get WebSocket by client ID.
     * @param {number} clientId
     * @returns {import('ws').WebSocket|null}
     */
    getSocket(clientId) {
        for (const [ws, info] of this.clients) {
            if (info.clientId === clientId) return ws;
        }
        return null;
    }

    get clientCount() {
        return this.clients.size;
    }

    /**
     * Get a client's last reported RTT in ms.
     * @param {number} clientId
     * @returns {number}
     */
    getClientRtt(clientId) {
        for (const [, info] of this.clients) {
            if (info.clientId === clientId) return info.rtt || 0;
        }
        return 0;
    }

    /**
     * Number of connected clients that are NOT in-game players.
     * @returns {number}
     */
    getSpectatorCount() {
        return Math.max(0, this.clients.size - this.serverGame.players.size);
    }
}
