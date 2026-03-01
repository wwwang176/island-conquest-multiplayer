/**
 * Binary network protocol definitions.
 * Shared by server (NetworkManager) and client (NetworkClient).
 */

// ── Message Types ──

// Client → Server
export const MsgType = {
    // Client → Server
    INPUT:          0x01,
    JOIN:           0x02,
    LEAVE:          0x03,
    PING:           0x04,
    RESPAWN:        0x05,

    // Server → Client
    WORLD_SEED:     0x10,
    SNAPSHOT:       0x11,
    EVENT_BATCH:    0x12,
    PLAYER_SPAWNED: 0x13,
    PLAYER_JOINED:  0x14,
    PLAYER_LEFT:    0x15,
    PONG:           0x16,
    INPUT_ACK:      0x17,
    JOIN_REJECTED:  0x18,
    SCOREBOARD_SYNC:0x19,
};

// ── Event Types (inside EventBatch) ──
export const EventType = {
    FIRED:              0x01,
    KILLED:             0x02,
    FLAG_CAPTURED:      0x03,
    GRENADE_EXPLODE:    0x04,
    VEHICLE_DESTROYED:  0x05,
    PLAYER_SPAWNED:     0x06,
    GAME_OVER:          0x07,
    ROUND_COUNTDOWN:    0x08,
    ROUND_RESTART:      0x09,
};

// ── Entity Types ──
export const EntityType = {
    COM:    0,
    PLAYER: 1,
    GRENADE: 2,
    VEHICLE: 3,
};

// ── Input Key Bits ──
export const KeyBit = {
    FORWARD:    1 << 0,
    BACKWARD:   1 << 1,
    LEFT:       1 << 2,
    RIGHT:      1 << 3,
    JUMP:       1 << 4,
    SPRINT:     1 << 5,
    FIRE:       1 << 6,
    SCOPE:      1 << 7,
    RELOAD:     1 << 8,
    GRENADE:    1 << 9,
    INTERACT:   1 << 10,
};

// ── Surface Types (in FIRED event) ──
export const SurfaceType = {
    MISS:       0,
    TERRAIN:    1,
    WATER:      2,
    CHARACTER:  3,
    VEHICLE:    4,
    ROCK:       5,
};

// ── Serialization Helpers ──

/**
 * Encode a float as int16 with fixed precision.
 * @param {number} val - The value to encode
 * @param {number} scale - Multiply before rounding (e.g. 100 for 1cm precision)
 * @returns {number} int16 value
 */
export function encodeFloat16(val, scale) {
    return Math.round(val * scale) | 0;
}

/**
 * Decode an int16 back to float.
 * @param {number} int16 - The encoded value
 * @param {number} scale - Divide to restore (e.g. 100 for 1cm precision)
 * @returns {number}
 */
export function decodeFloat16(int16, scale) {
    return int16 / scale;
}

// ── WorldSeed Message ──

/**
 * Serialize WorldSeed: msgType(1) + seed(4) + flagLayout(1) + entityCount(2) = 8 bytes
 */
export function encodeWorldSeed(seed, flagLayout, entityCount) {
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    view.setUint8(0, MsgType.WORLD_SEED);
    view.setFloat32(1, seed, true);
    view.setUint8(5, flagLayout);
    view.setUint16(6, entityCount, true);
    return buf;
}

export function decodeWorldSeed(buf) {
    const view = new DataView(buf);
    return {
        seed: view.getFloat32(1, true),
        flagLayout: view.getUint8(5),
        entityCount: view.getUint16(6, true),
    };
}

// ── Ping / Pong ──

export function encodePing(clientTimestamp, rtt) {
    const buf = new ArrayBuffer(11);
    const view = new DataView(buf);
    view.setUint8(0, MsgType.PING);
    view.setFloat64(1, clientTimestamp, true);
    view.setUint16(9, (rtt ?? 0) & 0xFFFF, true);
    return buf;
}

export function decodePing(buf) {
    const view = new DataView(buf);
    return {
        clientTimestamp: view.getFloat64(1, true),
        rtt: buf.byteLength >= 11 ? view.getUint16(9, true) : 0,
    };
}

export function encodePong(clientTimestamp, serverTimestamp) {
    const buf = new ArrayBuffer(17);
    const view = new DataView(buf);
    view.setUint8(0, MsgType.PONG);
    view.setFloat64(1, clientTimestamp, true);
    view.setFloat64(9, serverTimestamp, true);
    return buf;
}

export function decodePong(buf) {
    const view = new DataView(buf);
    return {
        clientTimestamp: view.getFloat64(1, true),
        serverTimestamp: view.getFloat64(9, true),
    };
}

// ── InputPacket ──

/**
 * Encode input: msgType(1) + tick(4) + keys(2) + mouseDX(2) + mouseDY(2) + yaw(4) + pitch(4) = 19 bytes
 */
export function encodeInput(tick, keys, mouseDeltaX, mouseDeltaY, yaw, pitch) {
    const buf = new ArrayBuffer(19);
    const view = new DataView(buf);
    view.setUint8(0, MsgType.INPUT);
    view.setUint32(1, tick, true);
    view.setUint16(5, keys, true);
    view.setInt16(7, encodeFloat16(mouseDeltaX, 10), true);
    view.setInt16(9, encodeFloat16(mouseDeltaY, 10), true);
    view.setFloat32(11, yaw, true);
    view.setFloat32(15, pitch, true);
    return buf;
}

export function decodeInput(buf) {
    const view = new DataView(buf);
    return {
        tick: view.getUint32(1, true),
        keys: view.getUint16(5, true),
        mouseDeltaX: decodeFloat16(view.getInt16(7, true), 10),
        mouseDeltaY: decodeFloat16(view.getInt16(9, true), 10),
        yaw: view.getFloat32(11, true),
        pitch: view.getFloat32(15, true),
    };
}

// ── JoinRequest ──

/**
 * Encode join: msgType(1) + teamId(1) + weaponIdLen(1) + weaponId(var) + nameLen(1) + name(var)
 */
export function encodeJoin(teamId, weaponId, playerName) {
    const weaponBytes = new TextEncoder().encode(weaponId);
    const nameBytes = new TextEncoder().encode(playerName);
    const buf = new ArrayBuffer(4 + weaponBytes.length + nameBytes.length);
    const view = new DataView(buf);
    const u8 = new Uint8Array(buf);
    view.setUint8(0, MsgType.JOIN);
    view.setUint8(1, teamId);  // 0=teamA, 1=teamB
    view.setUint8(2, weaponBytes.length);
    u8.set(weaponBytes, 3);
    view.setUint8(3 + weaponBytes.length, nameBytes.length);
    u8.set(nameBytes, 4 + weaponBytes.length);
    return buf;
}

export function decodeJoin(buf) {
    const view = new DataView(buf);
    const u8 = new Uint8Array(buf);
    const teamId = view.getUint8(1);
    const weaponLen = view.getUint8(2);
    const weaponId = new TextDecoder().decode(u8.slice(3, 3 + weaponLen));
    const nameLen = view.getUint8(3 + weaponLen);
    const playerName = new TextDecoder().decode(u8.slice(4 + weaponLen, 4 + weaponLen + nameLen));
    return {
        team: teamId === 0 ? 'teamA' : 'teamB',
        weaponId,
        playerName,
    };
}

// ── Leave ──

export function encodeLeave() {
    const buf = new ArrayBuffer(1);
    new DataView(buf).setUint8(0, MsgType.LEAVE);
    return buf;
}

// ── Respawn ──

/**
 * Encode respawn request: msgType(1) + weaponIdLen(1) + weaponId(var)
 */
export function encodeRespawn(weaponId) {
    const weaponBytes = new TextEncoder().encode(weaponId);
    const buf = new ArrayBuffer(2 + weaponBytes.length);
    const view = new DataView(buf);
    const u8 = new Uint8Array(buf);
    view.setUint8(0, MsgType.RESPAWN);
    view.setUint8(1, weaponBytes.length);
    u8.set(weaponBytes, 2);
    return buf;
}

export function decodeRespawn(buf) {
    const view = new DataView(buf);
    const u8 = new Uint8Array(buf);
    const weaponLen = view.getUint8(1);
    return {
        weaponId: new TextDecoder().decode(u8.slice(2, 2 + weaponLen)),
    };
}

// ── PlayerJoined ──

export function encodePlayerJoined(playerId, playerName, team) {
    const nameBytes = new TextEncoder().encode(playerName);
    const buf = new ArrayBuffer(4 + nameBytes.length);
    const view = new DataView(buf);
    const u8 = new Uint8Array(buf);
    view.setUint8(0, MsgType.PLAYER_JOINED);
    view.setUint16(1, playerId, true);
    view.setUint8(3, team === 'teamA' ? 0 : 1);
    u8.set(nameBytes, 4);
    return buf;
}

export function decodePlayerJoined(buf) {
    const view = new DataView(buf);
    const u8 = new Uint8Array(buf);
    return {
        playerId: view.getUint16(1, true),
        team: view.getUint8(3) === 0 ? 'teamA' : 'teamB',
        playerName: new TextDecoder().decode(u8.slice(4)),
    };
}

// ── PlayerLeft ──

export function encodePlayerLeft(playerId) {
    const buf = new ArrayBuffer(3);
    const view = new DataView(buf);
    view.setUint8(0, MsgType.PLAYER_LEFT);
    view.setUint16(1, playerId, true);
    return buf;
}

export function decodePlayerLeft(buf) {
    const view = new DataView(buf);
    return { playerId: view.getUint16(1, true) };
}

// ── PlayerSpawned ──

export function encodePlayerSpawned(playerId, x, y, z, team, weaponId) {
    const weaponBytes = new TextEncoder().encode(weaponId);
    const buf = new ArrayBuffer(17 + weaponBytes.length);
    const view = new DataView(buf);
    const u8 = new Uint8Array(buf);
    view.setUint8(0, MsgType.PLAYER_SPAWNED);
    view.setUint16(1, playerId, true);
    view.setFloat32(3, x, true);
    view.setFloat32(7, y, true);
    view.setFloat32(11, z, true);
    view.setUint8(15, team === 'teamA' ? 0 : 1);
    view.setUint8(16, weaponBytes.length);
    u8.set(weaponBytes, 17);
    return buf;
}

export function decodePlayerSpawned(buf) {
    const view = new DataView(buf);
    const u8 = new Uint8Array(buf);
    const weaponLen = view.getUint8(16);
    return {
        playerId: view.getUint16(1, true),
        x: view.getFloat32(3, true),
        y: view.getFloat32(7, true),
        z: view.getFloat32(11, true),
        team: view.getUint8(15) === 0 ? 'teamA' : 'teamB',
        weaponId: new TextDecoder().decode(u8.slice(17, 17 + weaponLen)),
    };
}

// ── JoinRejected ──

export function encodeJoinRejected(reason) {
    const reasonBytes = new TextEncoder().encode(reason);
    const buf = new ArrayBuffer(1 + reasonBytes.length);
    const u8 = new Uint8Array(buf);
    u8[0] = MsgType.JOIN_REJECTED;
    u8.set(reasonBytes, 1);
    return buf;
}

export function decodeJoinRejected(buf) {
    const u8 = new Uint8Array(buf);
    return { reason: new TextDecoder().decode(u8.slice(1)) };
}

// ── Weapon ID Mapping ──

const WEAPON_IDS = ['AR15', 'SMG', 'LMG', 'BOLT', 'GRENADE', 'VEHICLE'];
const WEAPON_TO_ID = {};
WEAPON_IDS.forEach((w, i) => { WEAPON_TO_ID[w] = i; });

export function weaponToId(weaponId) {
    return WEAPON_TO_ID[weaponId] ?? 0;
}
export function idToWeapon(id) {
    return WEAPON_IDS[id] ?? 'AR15';
}

// ── Snapshot ──

/**
 * Encode full snapshot: all entities + flags + scores + vehicles.
 * Header: msgType(1) + tick(4) + entityCount(2) = 7 bytes
 * Per entity: entityId(2) + type(1) + team(1) + posX(4) + posY(4) + posZ(4) +
 *             yaw(2) + pitch(2) + hp(1) + state(1) + weaponId(1) + ammo(1) + grenades(1) = 25 bytes
 * Flags: 5 × (owner(1) + captureProgress(1) + capturingTeam(1)) = 15 bytes
 * Scores: teamA(2) + teamB(2) = 4 bytes
 * Vehicles: vehicleCount(1) + N × 30 bytes each:
 *   vehicleId(1) + stateBits(1) + posX(4) + posY(4) + posZ(4) +
 *   yaw(2) + pitch(2) + roll(2) + hp(2) + pilotId(2) + passenger0-3(8) = 32 bytes
 */
export function encodeSnapshot(tick, entities, flags, scores, vehicles) {
    const entityCount = entities.length;
    const headerSize = 7;
    const entitySize = 25;
    const flagSize = 3;  // per flag
    const flagCount = flags.length;
    const vehicleCount = vehicles ? vehicles.length : 0;
    const vehicleSize = 32;
    const totalSize = headerSize + entityCount * entitySize + flagCount * flagSize + 4
        + 1 + vehicleCount * vehicleSize;

    const buf = new ArrayBuffer(totalSize);
    const view = new DataView(buf);

    // Header
    view.setUint8(0, MsgType.SNAPSHOT);
    view.setUint32(1, tick, true);
    view.setUint16(5, entityCount, true);

    // Entities
    let offset = headerSize;
    for (let i = 0; i < entityCount; i++) {
        const e = entities[i];
        view.setUint16(offset, e.entityId, true);           // entityId
        view.setUint8(offset + 2, e.type);                   // type (COM=0, Player=1)
        view.setUint8(offset + 3, e.team === 'teamA' ? 0 : 1); // team
        view.setFloat32(offset + 4, e.x, true);               // posX
        view.setFloat32(offset + 8, e.y, true);               // posY
        view.setFloat32(offset + 12, e.z, true);              // posZ
        view.setInt16(offset + 16, encodeFloat16(e.yaw, 1000), true);   // yaw
        view.setInt16(offset + 18, encodeFloat16(e.pitch, 1000), true); // pitch
        view.setUint8(offset + 20, Math.round(e.hp));        // hp
        view.setUint8(offset + 21, e.state);                  // state bits
        view.setUint8(offset + 22, weaponToId(e.weaponId));   // weaponId
        view.setUint8(offset + 23, e.ammo ?? 0);              // ammo
        view.setUint8(offset + 24, e.grenades ?? 0);          // grenades
        offset += entitySize;
    }

    // Flags
    for (let i = 0; i < flagCount; i++) {
        const f = flags[i];
        const ownerByte = f.owner === 'teamA' ? 1 : f.owner === 'teamB' ? 2 : 0;
        const capTeamByte = f.capturingTeam === 'teamA' ? 1 : f.capturingTeam === 'teamB' ? 2 : 0;
        view.setUint8(offset, ownerByte);
        view.setUint8(offset + 1, Math.round(f.captureProgress * 255));
        view.setUint8(offset + 2, capTeamByte);
        offset += flagSize;
    }

    // Scores
    view.setUint16(offset, scores.teamA, true);
    view.setUint16(offset + 2, scores.teamB, true);
    offset += 4;

    // Vehicles
    view.setUint8(offset, vehicleCount);
    offset += 1;
    for (let i = 0; i < vehicleCount; i++) {
        const v = vehicles[i];
        view.setUint8(offset, v.vehicleId);                              // vehicleId
        // stateBits: bit0=alive, bit1=crashing, bit2-3=team (0=neutral,1=A,2=B)
        let stateBits = 0;
        if (v.alive) stateBits |= 1;
        if (v.crashing) stateBits |= 2;
        const teamBits = v.team === 'teamA' ? 1 : v.team === 'teamB' ? 2 : 0;
        stateBits |= (teamBits << 2);
        view.setUint8(offset + 1, stateBits);
        view.setFloat32(offset + 2, v.x, true);                          // posX
        view.setFloat32(offset + 6, v.y, true);                          // posY
        view.setFloat32(offset + 10, v.z, true);                         // posZ
        view.setInt16(offset + 14, encodeFloat16(v.yaw, 1000), true);    // yaw
        view.setInt16(offset + 16, encodeFloat16(v.pitch, 1000), true);  // pitch
        view.setInt16(offset + 18, encodeFloat16(v.roll, 1000), true);   // roll
        view.setUint16(offset + 20, Math.round(v.hp), true);             // hp (uint16 for 6000)
        view.setUint16(offset + 22, v.pilotId ?? 0xFFFF, true);          // pilotId
        view.setUint16(offset + 24, v.passenger0 ?? 0xFFFF, true);       // passenger0
        view.setUint16(offset + 26, v.passenger1 ?? 0xFFFF, true);       // passenger1
        view.setUint16(offset + 28, v.passenger2 ?? 0xFFFF, true);       // passenger2
        view.setUint16(offset + 30, v.passenger3 ?? 0xFFFF, true);       // passenger3
        offset += vehicleSize;
    }

    return buf;
}

export function decodeSnapshot(buf) {
    const view = new DataView(buf);
    const tick = view.getUint32(1, true);
    const entityCount = view.getUint16(5, true);

    const entities = [];
    let offset = 7;
    for (let i = 0; i < entityCount; i++) {
        entities.push({
            entityId: view.getUint16(offset, true),
            type: view.getUint8(offset + 2),
            team: view.getUint8(offset + 3) === 0 ? 'teamA' : 'teamB',
            x: view.getFloat32(offset + 4, true),
            y: view.getFloat32(offset + 8, true),
            z: view.getFloat32(offset + 12, true),
            yaw: decodeFloat16(view.getInt16(offset + 16, true), 1000),
            pitch: decodeFloat16(view.getInt16(offset + 18, true), 1000),
            hp: view.getUint8(offset + 20),
            state: view.getUint8(offset + 21),
            weaponId: idToWeapon(view.getUint8(offset + 22)),
            ammo: view.getUint8(offset + 23),
            grenades: view.getUint8(offset + 24),
        });
        offset += 25;
    }

    // Flags
    const flagCount = 5; // fixed
    const flags = [];
    for (let i = 0; i < flagCount; i++) {
        if (offset + 3 > buf.byteLength) break;
        const ownerByte = view.getUint8(offset);
        flags.push({
            owner: ownerByte === 1 ? 'teamA' : ownerByte === 2 ? 'teamB' : 'neutral',
            captureProgress: view.getUint8(offset + 1) / 255,
            capturingTeam: (() => {
                const ct = view.getUint8(offset + 2);
                return ct === 1 ? 'teamA' : ct === 2 ? 'teamB' : null;
            })(),
        });
        offset += 3;
    }

    // Scores
    const scores = {
        teamA: view.getUint16(offset, true),
        teamB: view.getUint16(offset + 2, true),
    };
    offset += 4;

    // Vehicles (optional — backward compatible)
    const vehicles = [];
    if (offset < buf.byteLength) {
        const vehicleCount = view.getUint8(offset);
        offset += 1;
        for (let i = 0; i < vehicleCount; i++) {
            if (offset + 30 > buf.byteLength) break;
            const vehicleId = view.getUint8(offset);
            const stateBits = view.getUint8(offset + 1);
            const alive = !!(stateBits & 1);
            const crashing = !!(stateBits & 2);
            const teamBits = (stateBits >> 2) & 3;
            const team = teamBits === 1 ? 'teamA' : teamBits === 2 ? 'teamB' : null;
            vehicles.push({
                vehicleId,
                alive,
                crashing,
                team,
                x: view.getFloat32(offset + 2, true),
                y: view.getFloat32(offset + 6, true),
                z: view.getFloat32(offset + 10, true),
                yaw: decodeFloat16(view.getInt16(offset + 14, true), 1000),
                pitch: decodeFloat16(view.getInt16(offset + 16, true), 1000),
                roll: decodeFloat16(view.getInt16(offset + 18, true), 1000),
                hp: view.getUint16(offset + 20, true),
                pilotId: view.getUint16(offset + 22, true),
                passenger0: view.getUint16(offset + 24, true),
                passenger1: view.getUint16(offset + 26, true),
                passenger2: view.getUint16(offset + 28, true),
                passenger3: view.getUint16(offset + 30, true),
            });
            offset += 32;
        }
    }

    return { tick, entities, flags, scores, vehicles };
}

// ── EventBatch ──

/**
 * Encode event batch: msgType(1) + count(2) + events[].
 * Each event starts with eventType(1) then event-specific data.
 */
export function encodeEventBatch(events) {
    const encoder = new TextEncoder();

    // Pre-encode variable-length strings and calculate total size
    let dataSize = 3; // header
    const encoded = [];
    for (const ev of events) {
        dataSize += 1; // eventType
        switch (ev.eventType) {
            case EventType.FIRED:
                encoded.push(null);
                // shooterId(2) + originXYZ(12) + dirXYZ(6) + hitDist(4) + surfaceType(1) = 25
                dataSize += 25;
                break;
            case EventType.KILLED: {
                const kn = encoder.encode(ev.killerName || '');
                const vn = encoder.encode(ev.victimName || '');
                encoded.push({ kn, vn });
                // killerTeam(1) + victimTeam(1) + weaponId(1) + headshot(1) + knLen(1) + kn + vnLen(1) + vn
                // + killerEntityId(2) + victimEntityId(2) + killerKills(2) + victimDeaths(2)
                dataSize += 14 + kn.length + vn.length;
                break;
            }
            case EventType.FLAG_CAPTURED:
                encoded.push(null);
                dataSize += 2; // flagIdx(1) + newOwner(1)
                break;
            case EventType.GRENADE_EXPLODE:
                encoded.push(null);
                dataSize += 12; // posXYZ(12)
                break;
            case EventType.VEHICLE_DESTROYED:
                encoded.push(null);
                dataSize += 37; // vehicleId(1) + posXYZ(12) + velXYZ(12) + angVelXYZ(12)
                break;
            case EventType.GAME_OVER:
                encoded.push(null);
                dataSize += 5; // winner(1) + scoreA(2) + scoreB(2)
                break;
            case EventType.ROUND_COUNTDOWN:
                encoded.push(null);
                dataSize += 1; // secondsLeft(1)
                break;
            case EventType.ROUND_RESTART:
                encoded.push(null);
                // no data
                break;
            default:
                encoded.push(null);
                break;
        }
    }

    const buf = new ArrayBuffer(dataSize);
    const view = new DataView(buf);
    const u8 = new Uint8Array(buf);
    view.setUint8(0, MsgType.EVENT_BATCH);
    view.setUint16(1, events.length, true);

    let offset = 3;
    for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        view.setUint8(offset, ev.eventType);
        offset += 1;

        switch (ev.eventType) {
            case EventType.FIRED:
                view.setUint16(offset, ev.shooterId ?? 0, true);
                view.setFloat32(offset + 2, ev.originX, true);
                view.setFloat32(offset + 6, ev.originY, true);
                view.setFloat32(offset + 10, ev.originZ, true);
                view.setInt16(offset + 14, encodeFloat16(ev.dirX, 10000), true);
                view.setInt16(offset + 16, encodeFloat16(ev.dirY, 10000), true);
                view.setInt16(offset + 18, encodeFloat16(ev.dirZ, 10000), true);
                view.setFloat32(offset + 20, ev.hitDist, true);
                view.setUint8(offset + 24, ev.surfaceType ?? 0);
                offset += 25;
                break;
            case EventType.KILLED: {
                const { kn, vn } = encoded[i];
                view.setUint8(offset, ev.killerTeam === 'teamA' ? 0 : 1);
                view.setUint8(offset + 1, ev.victimTeam === 'teamA' ? 0 : 1);
                view.setUint8(offset + 2, weaponToId(ev.weaponId));
                view.setUint8(offset + 3, ev.headshot ? 1 : 0);
                view.setUint8(offset + 4, kn.length);
                u8.set(kn, offset + 5);
                view.setUint8(offset + 5 + kn.length, vn.length);
                u8.set(vn, offset + 6 + kn.length);
                view.setUint16(offset + 6 + kn.length + vn.length, ev.killerEntityId ?? 0xFFFF, true);
                view.setUint16(offset + 8 + kn.length + vn.length, ev.victimEntityId ?? 0xFFFF, true);
                view.setUint16(offset + 10 + kn.length + vn.length, ev.killerKills ?? 0, true);
                view.setUint16(offset + 12 + kn.length + vn.length, ev.victimDeaths ?? 0, true);
                offset += 14 + kn.length + vn.length;
                break;
            }
            case EventType.FLAG_CAPTURED:
                view.setUint8(offset, ev.flagIdx ?? 0);
                view.setUint8(offset + 1, ev.newOwner === 'teamA' ? 0 : 1);
                offset += 2;
                break;
            case EventType.GRENADE_EXPLODE:
                view.setFloat32(offset, ev.x, true);
                view.setFloat32(offset + 4, ev.y, true);
                view.setFloat32(offset + 8, ev.z, true);
                offset += 12;
                break;
            case EventType.VEHICLE_DESTROYED:
                view.setUint8(offset, ev.vehicleId ?? 0);
                view.setFloat32(offset + 1, ev.x ?? 0, true);
                view.setFloat32(offset + 5, ev.y ?? 0, true);
                view.setFloat32(offset + 9, ev.z ?? 0, true);
                view.setFloat32(offset + 13, ev.vx ?? 0, true);
                view.setFloat32(offset + 17, ev.vy ?? 0, true);
                view.setFloat32(offset + 21, ev.vz ?? 0, true);
                view.setFloat32(offset + 25, ev.avx ?? 0, true);
                view.setFloat32(offset + 29, ev.avy ?? 0, true);
                view.setFloat32(offset + 33, ev.avz ?? 0, true);
                offset += 37;
                break;
            case EventType.GAME_OVER:
                view.setUint8(offset, ev.winner === 'teamA' ? 0 : 1);
                view.setUint16(offset + 1, ev.scoreA ?? 0, true);
                view.setUint16(offset + 3, ev.scoreB ?? 0, true);
                offset += 5;
                break;
            case EventType.ROUND_COUNTDOWN:
                view.setUint8(offset, ev.secondsLeft ?? 0);
                offset += 1;
                break;
            case EventType.ROUND_RESTART:
                // no data
                break;
        }
    }

    return buf;
}

export function decodeEventBatch(buf) {
    const view = new DataView(buf);
    const u8 = new Uint8Array(buf);
    const decoder = new TextDecoder();
    const count = view.getUint16(1, true);
    const events = [];
    let offset = 3;

    for (let i = 0; i < count; i++) {
        const eventType = view.getUint8(offset);
        offset += 1;

        switch (eventType) {
            case EventType.FIRED:
                events.push({
                    eventType,
                    shooterId: view.getUint16(offset, true),
                    originX: view.getFloat32(offset + 2, true),
                    originY: view.getFloat32(offset + 6, true),
                    originZ: view.getFloat32(offset + 10, true),
                    dirX: decodeFloat16(view.getInt16(offset + 14, true), 10000),
                    dirY: decodeFloat16(view.getInt16(offset + 16, true), 10000),
                    dirZ: decodeFloat16(view.getInt16(offset + 18, true), 10000),
                    hitDist: view.getFloat32(offset + 20, true),
                    surfaceType: view.getUint8(offset + 24),
                });
                offset += 25;
                break;
            case EventType.KILLED: {
                const killerTeam = view.getUint8(offset) === 0 ? 'teamA' : 'teamB';
                const victimTeam = view.getUint8(offset + 1) === 0 ? 'teamA' : 'teamB';
                const weaponId = idToWeapon(view.getUint8(offset + 2));
                const headshot = view.getUint8(offset + 3) !== 0;
                const knLen = view.getUint8(offset + 4);
                const killerName = decoder.decode(u8.slice(offset + 5, offset + 5 + knLen));
                const vnLen = view.getUint8(offset + 5 + knLen);
                const victimName = decoder.decode(u8.slice(offset + 6 + knLen, offset + 6 + knLen + vnLen));
                const killerEntityId = view.getUint16(offset + 6 + knLen + vnLen, true);
                const victimEntityId = view.getUint16(offset + 8 + knLen + vnLen, true);
                const killerKills = view.getUint16(offset + 10 + knLen + vnLen, true);
                const victimDeaths = view.getUint16(offset + 12 + knLen + vnLen, true);
                events.push({ eventType, killerName, killerTeam, victimName, victimTeam, weaponId, headshot, killerEntityId, victimEntityId, killerKills, victimDeaths });
                offset += 14 + knLen + vnLen;
                break;
            }
            case EventType.FLAG_CAPTURED:
                events.push({
                    eventType,
                    flagIdx: view.getUint8(offset),
                    newOwner: view.getUint8(offset + 1) === 0 ? 'teamA' : 'teamB',
                });
                offset += 2;
                break;
            case EventType.GRENADE_EXPLODE:
                events.push({
                    eventType,
                    x: view.getFloat32(offset, true),
                    y: view.getFloat32(offset + 4, true),
                    z: view.getFloat32(offset + 8, true),
                });
                offset += 12;
                break;
            case EventType.VEHICLE_DESTROYED:
                events.push({
                    eventType,
                    vehicleId: view.getUint8(offset),
                    x: view.getFloat32(offset + 1, true),
                    y: view.getFloat32(offset + 5, true),
                    z: view.getFloat32(offset + 9, true),
                    vx: view.getFloat32(offset + 13, true),
                    vy: view.getFloat32(offset + 17, true),
                    vz: view.getFloat32(offset + 21, true),
                    avx: view.getFloat32(offset + 25, true),
                    avy: view.getFloat32(offset + 29, true),
                    avz: view.getFloat32(offset + 33, true),
                });
                offset += 37;
                break;
            case EventType.GAME_OVER:
                events.push({
                    eventType,
                    winner: view.getUint8(offset) === 0 ? 'teamA' : 'teamB',
                    scoreA: view.getUint16(offset + 1, true),
                    scoreB: view.getUint16(offset + 3, true),
                });
                offset += 5;
                break;
            case EventType.ROUND_COUNTDOWN:
                events.push({
                    eventType,
                    secondsLeft: view.getUint8(offset),
                });
                offset += 1;
                break;
            case EventType.ROUND_RESTART:
                events.push({ eventType });
                break;
            default:
                // Unknown event — skip (might cause misalignment)
                events.push({ eventType });
                break;
        }
    }

    return events;
}

// ── InputAck ──

/**
 * msgType(1) + lastProcessedTick(4) + posX(4) + posY(4) + posZ(4) + ammo(1) + grenades(1)
 * + dmgDirX(2) + dmgDirZ(2) + dmgTimer(1) + vehicleId(1) = 25 bytes
 */
export function encodeInputAck(lastProcessedTick, x, y, z, ammo, grenades, dmgDirX, dmgDirZ, dmgTimer, vehicleId) {
    const buf = new ArrayBuffer(25);
    const view = new DataView(buf);
    view.setUint8(0, MsgType.INPUT_ACK);
    view.setUint32(1, lastProcessedTick, true);
    view.setFloat32(5, x, true);
    view.setFloat32(9, y, true);
    view.setFloat32(13, z, true);
    view.setUint8(17, ammo ?? 0);
    view.setUint8(18, grenades ?? 0);
    view.setInt16(19, encodeFloat16(dmgDirX ?? 0, 1000), true);
    view.setInt16(21, encodeFloat16(dmgDirZ ?? 0, 1000), true);
    view.setUint8(23, Math.round((dmgTimer ?? 0) * 100));
    view.setUint8(24, vehicleId ?? 0xFF); // 0xFF = not in vehicle
    return buf;
}

export function decodeInputAck(buf) {
    const view = new DataView(buf);
    return {
        lastProcessedTick: view.getUint32(1, true),
        x: view.getFloat32(5, true),
        y: view.getFloat32(9, true),
        z: view.getFloat32(13, true),
        ammo: view.getUint8(17),
        grenades: view.getUint8(18),
        dmgDirX: decodeFloat16(view.getInt16(19, true), 1000),
        dmgDirZ: decodeFloat16(view.getInt16(21, true), 1000),
        dmgTimer: view.getUint8(23) / 100,
        vehicleId: buf.byteLength >= 25 ? view.getUint8(24) : 0xFF,
    };
}

// ── ScoreboardSync ──

/**
 * Encode scoreboard sync: msgType(1) + count(2) + entries[] + spectatorCount(1).
 * Each entry: nameLen(1) + name(var) + team(1) + weapon(1) + kills(2) + deaths(2) + ping(2) = 9 + nameLen
 * @param {Array<{name:string, team:string, weaponId:string, kills:number, deaths:number, ping?:number}>} entries
 * @param {number} [spectatorCount=0]
 */
export function encodeScoreboardSync(entries, spectatorCount) {
    const encoder = new TextEncoder();
    const encoded = entries.map(e => encoder.encode(e.name));
    let size = 3; // header: msgType(1) + count(2)
    for (const nb of encoded) size += 9 + nb.length;
    size += 1; // spectatorCount

    const buf = new ArrayBuffer(size);
    const view = new DataView(buf);
    const u8 = new Uint8Array(buf);
    view.setUint8(0, MsgType.SCOREBOARD_SYNC);
    view.setUint16(1, entries.length, true);

    let offset = 3;
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const nb = encoded[i];
        view.setUint8(offset, nb.length);
        u8.set(nb, offset + 1);
        view.setUint8(offset + 1 + nb.length, e.team === 'teamA' ? 0 : 1);
        view.setUint8(offset + 2 + nb.length, weaponToId(e.weaponId));
        view.setUint16(offset + 3 + nb.length, e.kills, true);
        view.setUint16(offset + 5 + nb.length, e.deaths, true);
        view.setUint16(offset + 7 + nb.length, (e.ping ?? 0) & 0xFFFF, true);
        offset += 9 + nb.length;
    }
    view.setUint8(offset, spectatorCount ?? 0);
    return buf;
}

export function decodeScoreboardSync(buf) {
    const view = new DataView(buf);
    const u8 = new Uint8Array(buf);
    const decoder = new TextDecoder();
    const count = view.getUint16(1, true);
    const entries = [];
    let offset = 3;
    for (let i = 0; i < count; i++) {
        const nameLen = view.getUint8(offset);
        const name = decoder.decode(u8.slice(offset + 1, offset + 1 + nameLen));
        const team = view.getUint8(offset + 1 + nameLen) === 0 ? 'teamA' : 'teamB';
        const weaponId = idToWeapon(view.getUint8(offset + 2 + nameLen));
        const kills = view.getUint16(offset + 3 + nameLen, true);
        const deaths = view.getUint16(offset + 5 + nameLen, true);
        const ping = view.getUint16(offset + 7 + nameLen, true);
        entries.push({ name, team, weaponId, kills, deaths, ping });
        offset += 9 + nameLen;
    }
    const spectatorCount = offset < buf.byteLength ? view.getUint8(offset) : 0;
    return { entries, spectatorCount };
}
