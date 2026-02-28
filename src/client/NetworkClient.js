import {
    MsgType, decodeWorldSeed, decodeSnapshot, decodeEventBatch,
    decodePong, decodePlayerSpawned, decodeInputAck,
    decodePlayerJoined, decodePlayerLeft, decodeJoinRejected,
    decodeScoreboardSync,
    encodeInput, encodeJoin, encodeLeave, encodeRespawn, encodePing,
} from '../shared/protocol.js';

/**
 * WebSocket client for connecting to the game server.
 * Handles binary protocol parsing and dispatching.
 */
export class NetworkClient {
    constructor() {
        this.ws = null;
        this.connected = false;
        this.rtt = 0; // round-trip time in ms

        // Callbacks (set by ClientGame)
        this.onWorldSeed = null;       // (seed, flagLayout, entityCount)
        this.onSnapshot = null;        // (tick, entities, flags, scores, vehicles)
        this.onEvents = null;          // (events[])
        this.onPlayerSpawned = null;   // (playerId, x, y, z, team, weaponId)
        this.onInputAck = null;        // (lastProcessedTick, x, y, z, ammo, grenades, dmgDirX, dmgDirZ, dmgTimer, vehicleId)
        this.onPlayerJoined = null;    // (playerId, team, playerName)
        this.onPlayerLeft = null;      // (playerId)
        this.onJoinRejected = null;    // (reason)
        this.onConnected = null;       // ()
        this.onDisconnected = null;    // ()
    }

    connect(serverUrl) {
        if (this.ws) this.disconnect();

        this.ws = new WebSocket(serverUrl);
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
            this.connected = true;
            console.log('[Net] Connected to', serverUrl);
            if (this.onConnected) this.onConnected();
            // Measure RTT
            this._sendPing();
        };

        this.ws.onmessage = (event) => {
            if (event.data instanceof ArrayBuffer) {
                this._handleBinary(event.data);
            }
        };

        this.ws.onclose = () => {
            this.connected = false;
            console.log('[Net] Disconnected');
            if (this.onDisconnected) this.onDisconnected();
        };

        this.ws.onerror = (err) => {
            console.error('[Net] WebSocket error:', err);
        };
    }

    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.connected = false;
    }

    sendInput(tick, keys, mouseDeltaX, mouseDeltaY, yaw, pitch) {
        if (!this.connected) return;
        const buf = encodeInput(tick, keys, mouseDeltaX, mouseDeltaY, yaw, pitch);
        this.ws.send(buf);
    }

    sendJoin(team, weaponId, playerName) {
        if (!this.connected) return;
        const teamId = team === 'teamA' ? 0 : 1;
        const buf = encodeJoin(teamId, weaponId, playerName);
        this.ws.send(buf);
    }

    sendLeave() {
        if (!this.connected) return;
        const buf = encodeLeave();
        this.ws.send(buf);
    }

    sendRespawn(weaponId) {
        if (!this.connected) return;
        const buf = encodeRespawn(weaponId);
        this.ws.send(buf);
    }

    _sendPing() {
        if (!this.connected) return;
        const buf = encodePing(performance.now());
        this.ws.send(buf);
    }

    _handleBinary(buf) {
        const view = new DataView(buf);
        const msgType = view.getUint8(0);

        switch (msgType) {
            case MsgType.WORLD_SEED: {
                const data = decodeWorldSeed(buf);
                console.log('[Net] WorldSeed:', data);
                if (this.onWorldSeed) {
                    this.onWorldSeed(data.seed, data.flagLayout, data.entityCount);
                }
                break;
            }
            case MsgType.SNAPSHOT: {
                const data = decodeSnapshot(buf);
                if (this.onSnapshot) {
                    this.onSnapshot(data.tick, data.entities, data.flags, data.scores, data.vehicles);
                }
                break;
            }
            case MsgType.EVENT_BATCH: {
                const events = decodeEventBatch(buf);
                if (this.onEvents) {
                    this.onEvents(events);
                }
                break;
            }
            case MsgType.PLAYER_SPAWNED: {
                const data = decodePlayerSpawned(buf);
                if (this.onPlayerSpawned) {
                    this.onPlayerSpawned(data.playerId, data.x, data.y, data.z, data.team, data.weaponId);
                }
                break;
            }
            case MsgType.INPUT_ACK: {
                const data = decodeInputAck(buf);
                if (this.onInputAck) {
                    this.onInputAck(data.lastProcessedTick, data.x, data.y, data.z, data.ammo, data.grenades, data.dmgDirX, data.dmgDirZ, data.dmgTimer, data.vehicleId);
                }
                break;
            }
            case MsgType.PLAYER_JOINED: {
                const data = decodePlayerJoined(buf);
                if (this.onPlayerJoined) {
                    this.onPlayerJoined(data.playerId, data.team, data.playerName);
                }
                break;
            }
            case MsgType.PLAYER_LEFT: {
                const data = decodePlayerLeft(buf);
                if (this.onPlayerLeft) {
                    this.onPlayerLeft(data.playerId);
                }
                break;
            }
            case MsgType.PONG: {
                const data = decodePong(buf);
                this.rtt = performance.now() - data.clientTimestamp;
                break;
            }
            case MsgType.JOIN_REJECTED: {
                const data = decodeJoinRejected(buf);
                if (this.onJoinRejected) {
                    this.onJoinRejected(data.reason);
                }
                break;
            }
            case MsgType.SCOREBOARD_SYNC: {
                const entries = decodeScoreboardSync(buf);
                if (this.onScoreboardSync) {
                    this.onScoreboardSync(entries);
                }
                break;
            }
        }
    }
}
