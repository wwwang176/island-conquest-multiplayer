import * as THREE from 'three';
import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { ServerSoldier } from './ServerSoldier.js';
import { AIController } from '../ai/AIController.js';
import { SquadTemplates } from '../ai/Personality.js';
import { TeamIntel } from '../ai/TeamIntel.js';
import { SquadCoordinator } from '../ai/SquadCoordinator.js';
import { ThreatMap } from '../ai/ThreatMap.js';
import { AI_UPDATES_PER_TICK } from '../shared/constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Stubs for visual-only methods ──
// AIVisual.js is safe to import — browser-only code paths (createTacLabel, debugArcs)
// are guarded by static flags (showTacLabels=false, debugArcs=false) and never execute.

// Stub TeamIntel visualization
TeamIntel.prototype.setVisualization = function() {};
TeamIntel.prototype.updateVisualization = function() {};

// Stub ThreatMap visualization
ThreatMap.prototype.createVisualization = function() {};
ThreatMap.prototype.setVisible = function() {};
ThreatMap.prototype._updateVisTexture = function() {};

// Override ThreatMap._initWorker to use Node.js worker_threads
const origInitThreatWorker = ThreatMap.prototype._initWorker;
ThreatMap.prototype._initWorker = function() {
    const workerPath = join(__dirname, '..', 'workers', 'threat-worker-node.js');
    this._worker = new Worker(workerPath);

    this._worker.postMessage({
        type: 'init',
        cols: this.cols,
        rows: this.rows,
        cellSize: this.cellSize,
        originX: this.originX,
        originZ: this.originZ,
        heightGrid: this.heightGrid,
    });

    this._worker.on('message', (data) => {
        if (data.type === 'result') {
            this.threat.set(data.threat);
            this._workerBusy = false;
        }
    });
};

/**
 * Server-side AI manager.
 * Uses ServerSoldier instead of Soldier, Node.js workers instead of Web Workers.
 */
export class ServerAIManager {
    constructor(physics, flags, coverSystem, getHeightAt, eventBus) {
        this.physics = physics;
        this.flags = flags;
        this.coverSystem = coverSystem;
        this.getHeightAt = getHeightAt;
        this.eventBus = eventBus;

        // Shared intel boards
        this.intelA = new TeamIntel('teamA');
        this.intelB = new TeamIntel('teamB');

        // Threat maps
        this.threatMapA = new ThreatMap();
        this.threatMapB = new ThreatMap();

        // Storm debuff: sight range multiplier (set by applyTimeOfDay)
        this.sightMultiplier = 1.0;

        this.teamA = { soldiers: [], controllers: [], squads: [] };
        this.teamB = { soldiers: [], controllers: [], squads: [] };

        this._createTeam('teamA', this.teamA);
        this._createTeam('teamB', this.teamB);

        // Staggered updates
        this.updateIndex = 0;
        this.totalAI = this.teamA.soldiers.length + this.teamB.soldiers.length;

        // Pre-allocated buffers
        this._teamAEnemies = [];
        this._teamBEnemies = [];
        this._meshBuf = [];
        this._posABuf = [];
        this._posBBuf = [];

        // Scan worker state
        this._scanWorker = null;
        this._scanPending = false;

        this._spawned = false;
        this.players = new Map();
    }

    _createTeam(team, teamData) {
        const teamIntel = team === 'teamA' ? this.intelA : this.intelB;
        let id = 0;

        for (const squad of SquadTemplates) {
            const squadControllers = [];

            for (const role of squad.roles) {
                // Use ServerSoldier instead of Soldier
                const soldier = new ServerSoldier(this.physics, team, id, true);

                // Position off-screen until spawnAll
                soldier.body.position.set(0, -100, 0);

                const controller = new AIController(
                    soldier, role, team, this.flags, this.getHeightAt,
                    this.coverSystem, teamIntel, this.eventBus
                );

                // Assign threat map
                controller.threatMap = team === 'teamA' ? this.threatMapA : this.threatMapB;

                // Stub visual methods on controller
                controller._updateLabel = () => {};

                squadControllers.push(controller);
                teamData.soldiers.push(soldier);
                teamData.controllers.push(controller);
                id++;
            }

            const coordinator = new SquadCoordinator(
                squad.name, squadControllers, teamIntel, this.flags, team,
                squad.strategy || 'secure'
            );

            let flankSide = 1;
            for (const ctrl of squadControllers) {
                ctrl.squad = coordinator;
                ctrl.flankSide = flankSide;
                flankSide *= -1;
            }

            teamData.squads.push(coordinator);
        }
    }

    /**
     * Apply time-of-day debuffs to AI.
     * @param {number} tod - 0=day, 1=dusk, 2=storm
     */
    applyTimeOfDay(tod) {
        const isStorm = tod === 2;
        this.sightMultiplier = isStorm ? 0.6 : 1.0;
        const reactionMult = isStorm ? 1.5 : 1.0;
        const accuracyMult = isStorm ? 0.7 : 1.0;

        const allControllers = [...this.teamA.controllers, ...this.teamB.controllers];
        for (const ctrl of allControllers) {
            ctrl.reactionMult = reactionMult;
            ctrl.accuracyMult = accuracyMult;
            ctrl.aimCorrectionSpeed = (2 + ctrl.personality.aimSkill * 3) * accuracyMult;
        }

        const todNames = ['Day', 'Dusk', 'Storm'];
        console.log(`[AI] Time-of-day: ${todNames[tod]} — sight ×${this.sightMultiplier}, accuracy ×${accuracyMult}, reaction ×${reactionMult}`);
    }

    setNavGrid(grid, heightGrid, obstacleBounds) {
        for (const ctrl of [...this.teamA.controllers, ...this.teamB.controllers]) {
            ctrl.navGrid = grid;
        }
        this.threatMapA.navGrid = grid;
        this.threatMapB.navGrid = grid;
        this._navGrid = grid;

        // Initialize pathfinding worker (Node.js version)
        this._initPathWorker(grid);

        // Build height grid
        this.threatMapA.buildHeightGrid(this.getHeightAt, obstacleBounds);
        this.threatMapB.heightGrid = this.threatMapA.heightGrid;
        this.threatMapB._initWorker();

        // Initialize scan worker
        this._initScanWorker();
    }

    _initPathWorker(grid) {
        const workerPath = join(__dirname, '..', 'workers', 'pathfind-worker-node.js');
        grid._pathWorker = new Worker(workerPath);
        grid._nextReqId = 0;
        grid._pendingCallbacks = new Map();

        grid._pathWorker.on('message', (data) => {
            const cb = grid._pendingCallbacks.get(data.id);
            if (cb) {
                grid._pendingCallbacks.delete(data.id);
                cb(data.path);
            }
        });

        grid._pathWorker.postMessage({
            type: 'init',
            grid: grid.grid,
            proxCost: grid.proxCost,
            cols: grid.cols,
            rows: grid.rows,
            cellSize: grid.cellSize,
            originX: grid.originX,
            originZ: grid.originZ,
        });
    }

    _initScanWorker() {
        const tm = this.threatMapA;
        if (!tm.heightGrid) return;

        const workerPath = join(__dirname, '..', 'workers', 'threat-scan-worker-node.js');
        this._scanWorker = new Worker(workerPath);

        this._scanWorker.postMessage({
            type: 'init',
            cols: tm.cols,
            rows: tm.rows,
            cellSize: tm.cellSize,
            originX: tm.originX,
            originZ: tm.originZ,
            heightGrid: tm.heightGrid,
        });

        this._scanWorker.on('message', (data) => {
            if (data.type === 'scanResult') {
                this._applyTeamResults(this.teamA.controllers, this._teamAEnemies, data.teamAResults);
                this._applyTeamResults(this.teamB.controllers, this._teamBEnemies, data.teamBResults);
                this._scanPending = false;
            }
        });
    }

    // Pack and dispatch scan — same as AIManager
    static AI_STRIDE = 8;
    static EN_STRIDE = 5;

    _packTeam(controllers, enemies) {
        const AS = ServerAIManager.AI_STRIDE;
        const ES = ServerAIManager.EN_STRIDE;
        const aiData = new Float32Array(controllers.length * AS);
        const enData = new Float32Array(enemies.length * ES);

        for (let i = 0; i < controllers.length; i++) {
            const ctrl = controllers[i];
            const s = ctrl.soldier;
            const pos = s.getPosition();
            const off = i * AS;
            const inHeli = ctrl.vehicle && ctrl.vehicle.type === 'helicopter';
            aiData[off]     = pos.x;
            aiData[off + 1] = pos.y;
            aiData[off + 2] = pos.z;
            const pitch = ctrl._aimPitch || 0;
            const cp = Math.cos(pitch);
            aiData[off + 3] = ctrl.facingDir.x * cp;
            aiData[off + 4] = Math.sin(pitch);
            aiData[off + 5] = ctrl.facingDir.z * cp;
            const baseRange = ctrl.vehicle ? ctrl.vehicle.detectionRange : 80;
            aiData[off + 6] = baseRange * this.sightMultiplier;
            aiData[off + 7] = (s.alive ? 1 : 0) | (inHeli ? 2 : 0);
        }

        for (let i = 0; i < enemies.length; i++) {
            const e = enemies[i];
            const pos = e.getPosition();
            const off = i * ES;
            enData[off]     = pos.x;
            enData[off + 1] = pos.y;
            enData[off + 2] = pos.z;
            enData[off + 3] = e.vehicle ? e.vehicle.visibilityRange : 80;
            const eInHeli = e.vehicle && e.vehicle.type === 'helicopter';
            enData[off + 4] = (e.alive ? 1 : 0) | (eInHeli ? 2 : 0);
        }

        return { aiData, enData };
    }

    _dispatchScan(teamAEnemies, teamBEnemies) {
        if (!this._scanWorker || this._scanPending) return;

        const a = this._packTeam(this.teamA.controllers, teamAEnemies);
        const b = this._packTeam(this.teamB.controllers, teamBEnemies);

        this._scanPending = true;
        this._scanWorker.postMessage({
            type: 'scan',
            aiAData: a.aiData, enAData: a.enData,
            aiACount: this.teamA.controllers.length, enACount: teamAEnemies.length,
            aiBData: b.aiData, enBData: b.enData,
            aiBCount: this.teamB.controllers.length, enBCount: teamBEnemies.length,
        }, [a.aiData.buffer, a.enData.buffer, b.aiData.buffer, b.enData.buffer]);
    }

    _applyTeamResults(controllers, enemies, results) {
        for (let i = 0; i < results.length; i++) {
            const ctrl = controllers[i];
            if (!ctrl.soldier.alive) continue;

            const r = results[i];
            const visibleEnemies = [];
            let bestEnemy = null;
            let bestScore = Infinity;
            let bestDist = Infinity;
            let bestLOS = 1;
            let bestDot = 1;

            const ds = ctrl._damageSource;
            let dsAlreadySeen = false;

            for (const ve of r.visibleEnemies) {
                const enemy = enemies[ve.idx];
                if (!enemy) continue;
                if (enemy === ds) dsAlreadySeen = true;
                visibleEnemies.push({ enemy, dist: ve.dist, losLevel: ve.losLevel });
                const score = 0.7 * (1 - ve.dot) + 0.3 * (ve.dist / ve.range);
                if (score < bestScore) {
                    bestScore = score;
                    bestDist = ve.dist;
                    bestEnemy = enemy;
                    bestLOS = ve.losLevel;
                    bestDot = ve.dot;
                }
            }

            if (ds && !dsAlreadySeen && ds.alive) {
                const myPos = ctrl.soldier.getPosition();
                const ePos = ds.getPosition();
                const dist = myPos.distanceTo(ePos);
                if (dist < ctrl.weaponDef.maxRange) {
                    visibleEnemies.push({ enemy: ds, dist, losLevel: 1 });
                    const dx = ePos.x - myPos.x, dz = ePos.z - myPos.z;
                    const inv = 1 / Math.max(dist, 0.01);
                    const dot = ctrl.facingDir.x * dx * inv + ctrl.facingDir.z * dz * inv;
                    const score = 0.7 * (1 - dot) + 0.3 * (dist / ctrl.weaponDef.maxRange);
                    if (score < bestScore) {
                        bestScore = score;
                        bestDist = dist;
                        bestEnemy = ds;
                        bestLOS = 1;
                        bestDot = dot;
                    }
                }
            }

            ctrl.applyScanResults(visibleEnemies, bestEnemy, bestDist, bestLOS, bestDot);
        }
    }

    spawnAll() {
        if (this._spawned) return;
        this._spawned = true;

        const spawnTeam = (teamData, team) => {
            const spawnFlag = team === 'teamA' ? this.flags[0] : this.flags[this.flags.length - 1];
            const threatMap = team === 'teamA' ? this.threatMapA : this.threatMapB;
            for (const soldier of teamData.soldiers) {
                const angle = Math.random() * Math.PI * 2;
                const dist = 5 + Math.random() * 10;
                const cx = spawnFlag.position.x + Math.cos(angle) * dist;
                const cz = spawnFlag.position.z + Math.sin(angle) * dist;
                const safe = this._findSafeCell(cx, cz, threatMap, 30);
                if (safe) {
                    soldier.body.position.set(safe.x, safe.y + 1, safe.z);
                } else {
                    const h = this.getHeightAt(spawnFlag.position.x, spawnFlag.position.z);
                    soldier.body.position.set(spawnFlag.position.x, h + 1, spawnFlag.position.z);
                }
            }
        };

        spawnTeam(this.teamA, 'teamA');
        spawnTeam(this.teamB, 'teamB');
    }

    // Stubs for VFX systems the server doesn't have
    set tracerSystem(sys) {
        for (const ctrl of [...this.teamA.controllers, ...this.teamB.controllers]) {
            ctrl.tracerSystem = sys;
        }
    }

    set grenadeManager(mgr) {
        for (const ctrl of [...this.teamA.controllers, ...this.teamB.controllers]) {
            ctrl.grenadeManager = mgr;
        }
    }

    set vehicleManager(mgr) {
        for (const ctrl of [...this.teamA.controllers, ...this.teamB.controllers]) {
            ctrl.vehicleManager = mgr;
        }
    }

    set impactVFX(sys) {
        for (const ctrl of [...this.teamA.controllers, ...this.teamB.controllers]) {
            ctrl.impactVFX = sys;
        }
    }

    addPlayer(clientId, player) {
        this.players.set(clientId, player);
        for (const ctrl of [...this.teamA.controllers, ...this.teamB.controllers]) {
            ctrl.addPlayerRef(player);
        }
    }

    removePlayer(clientId) {
        const player = this.players.get(clientId);
        if (!player) return;
        this.players.delete(clientId);
        for (const ctrl of [...this.teamA.controllers, ...this.teamB.controllers]) {
            ctrl.removePlayerRef(player);
        }
    }

    getTeamPositions(team) {
        const buf = team === 'teamA' ? this._posABuf : this._posBBuf;
        buf.length = 0;
        const data = team === 'teamA' ? this.teamA : this.teamB;
        for (const s of data.soldiers) {
            if (s.alive) buf.push(s.getPosition());
        }
        return buf;
    }

    getAllSoldierMeshes() {
        const buf = this._meshBuf;
        buf.length = 0;
        for (const s of this.teamA.soldiers) if (s.alive) buf.push(s.mesh);
        for (const s of this.teamB.soldiers) if (s.alive) buf.push(s.mesh);
        return buf;
    }

    update(dt, collidables) {
        const allA = this.teamA.soldiers;
        const allB = this.teamB.soldiers;

        this.intelA.update(dt);
        this.intelB.update(dt);

        let aFlags = 0, bFlags = 0;
        for (const f of this.flags) {
            if (f.owner === 'teamA') aFlags++;
            else if (f.owner === 'teamB') bFlags++;
        }

        for (const ctrl of this.teamA.controllers) ctrl.flagDeficit = bFlags - aFlags;
        for (const ctrl of this.teamB.controllers) ctrl.flagDeficit = aFlags - bFlags;

        for (const squad of this.teamA.squads) squad.update(dt, bFlags - aFlags);
        for (const squad of this.teamB.squads) squad.update(dt, aFlags - bFlags);

        const teamAEnemies = this._teamAEnemies;
        teamAEnemies.length = 0;
        for (const s of allB) teamAEnemies.push(s);

        const teamBEnemies = this._teamBEnemies;
        teamBEnemies.length = 0;
        for (const s of allA) teamBEnemies.push(s);

        for (const [, player] of this.players) {
            if (!player.alive || !player.team) continue;
            if (player.team === 'teamA') {
                teamBEnemies.push(player);
            } else {
                teamAEnemies.push(player);
            }
        }

        this.threatMapA.update(dt, teamAEnemies);
        this.threatMapB.update(dt, teamBEnemies);

        // Staggered updates
        const updatesPerFrame = AI_UPDATES_PER_TICK;
        for (let i = 0; i < updatesPerFrame; i++) {
            const idx = (this.updateIndex + i) % this.totalAI;

            if (idx < this.teamA.controllers.length) {
                const ctrl = this.teamA.controllers[idx];
                if (ctrl.soldier.alive) {
                    ctrl.update(dt, teamAEnemies, allA, collidables);
                }
            } else {
                const bIdx = idx - this.teamA.controllers.length;
                const ctrl = this.teamB.controllers[bIdx];
                if (ctrl.soldier.alive) {
                    ctrl.update(dt, teamBEnemies, allB, collidables);
                }
            }
        }
        this.updateIndex = (this.updateIndex + updatesPerFrame) % this.totalAI;

        this._dispatchScan(teamAEnemies, teamBEnemies);

        // Continuous updates (aiming + shooting)
        for (const ctrl of this.teamA.controllers) ctrl.updateContinuous(dt);
        for (const ctrl of this.teamB.controllers) ctrl.updateContinuous(dt);

        // Update all soldiers (regen, mesh sync)
        for (const s of allA) s.update(dt);
        for (const s of allB) s.update(dt);

        // Respawns
        this._handleRespawns(allA, 'teamA');
        this._handleRespawns(allB, 'teamB');
    }

    _findSafeCell(centerX, centerZ, threatMap, searchRadius = 30, teamIntel = null) {
        if (!this._navGrid) return null;
        const nav = this._navGrid;
        const g = nav.worldToGrid(centerX, centerZ);
        const maxThreat = 0.3;
        const intelMinDist = 30;

        const _isSafe = (wx, wz, h) => {
            if (h < 0.3) return false;
            if (threatMap.getThreat(wx, wz) >= maxThreat) return false;
            if (teamIntel) {
                for (const contact of teamIntel.contacts.values()) {
                    const dx = wx - contact.lastSeenPos.x;
                    const dz = wz - contact.lastSeenPos.z;
                    if (dx * dx + dz * dz < intelMinDist * intelMinDist) return false;
                }
            }
            return true;
        };

        if (nav.isWalkable(g.col, g.row)) {
            const h = this.getHeightAt(centerX, centerZ);
            if (_isSafe(centerX, centerZ, h)) {
                return { x: centerX, y: h, z: centerZ };
            }
        }
        for (let r = 1; r <= searchRadius; r++) {
            for (let dr = -r; dr <= r; dr++) {
                for (let dc = -r; dc <= r; dc++) {
                    if (Math.abs(dr) !== r && Math.abs(dc) !== r) continue;
                    const nc = g.col + dc, nr = g.row + dr;
                    if (!nav.isWalkable(nc, nr)) continue;
                    const w = nav.gridToWorld(nc, nr);
                    const h = this.getHeightAt(w.x, w.z);
                    if (_isSafe(w.x, w.z, h)) {
                        return { x: w.x, y: h, z: w.z };
                    }
                }
            }
        }
        return null;
    }

    findSafeSpawn(team) {
        const spawnFlag = team === 'teamA' ? this.flags[0] : this.flags[this.flags.length - 1];
        const threatMap = team === 'teamA' ? this.threatMapA : this.threatMapB;
        const intel = team === 'teamA' ? this.intelA : this.intelB;
        const teamData = team === 'teamA' ? this.teamA : this.teamB;

        const anchors = [];
        const basePos = spawnFlag.position;
        const now = performance.now();

        const ownedFlags = this.flags
            .filter(f => f.owner === team)
            .sort((a, b) => b.position.distanceTo(basePos) - a.position.distanceTo(basePos));
        for (const flag of ownedFlags) anchors.push(flag.position);

        for (const ally of teamData.soldiers) {
            if (!ally.alive) continue;
            const allyPos = ally.getPosition();
            if (threatMap.getThreat(allyPos.x, allyPos.z) >= 0.3) continue;
            if (now - ally.lastDamagedTime < 10000) continue;
            anchors.push(allyPos);
        }

        for (const anchor of anchors) {
            const angle = Math.random() * Math.PI * 2;
            const dist = 5 + Math.random() * 5;
            const cx = anchor.x + Math.cos(angle) * dist;
            const cz = anchor.z + Math.sin(angle) * dist;
            const safe = this._findSafeCell(cx, cz, threatMap, 20, intel);
            if (safe) return new THREE.Vector3(safe.x, safe.y, safe.z);
        }

        if (this._navGrid) {
            for (let attempt = 0; attempt < 10; attempt++) {
                const rx = (Math.random() - 0.5) * this._navGrid.width;
                const rz = (Math.random() - 0.5) * this._navGrid.depth;
                const safe = this._findSafeCell(rx, rz, threatMap, 15, intel);
                if (safe) return new THREE.Vector3(safe.x, safe.y, safe.z);
            }
        }

        const angle = Math.random() * Math.PI * 2;
        const dist = 10 + Math.random() * 5;
        const x = spawnFlag.position.x + Math.cos(angle) * dist;
        const z = spawnFlag.position.z + Math.sin(angle) * dist;
        const y = this.getHeightAt(x, z);
        return new THREE.Vector3(x, Math.max(y, 1), z);
    }

    _handleRespawns(soldiers, team) {
        const spawnFlag = team === 'teamA' ? this.flags[0] : this.flags[this.flags.length - 1];
        const threatMap = team === 'teamA' ? this.threatMapA : this.threatMapB;
        const intel = team === 'teamA' ? this.intelA : this.intelB;
        const teamData = team === 'teamA' ? this.teamA : this.teamB;

        for (const soldier of soldiers) {
            if (!soldier.canRespawn()) continue;

            const anchors = [];
            const basePos = spawnFlag.position;
            const now = performance.now();

            const ownedFlags = this.flags
                .filter(f => f.owner === team)
                .sort((a, b) => b.position.distanceTo(basePos) - a.position.distanceTo(basePos));
            for (const flag of ownedFlags) anchors.push(flag.position);

            for (const ally of teamData.soldiers) {
                if (!ally.alive || ally === soldier) continue;
                const allyPos = ally.getPosition();
                if (threatMap.getThreat(allyPos.x, allyPos.z) >= 0.3) continue;
                if (now - ally.lastDamagedTime < 10000) continue;
                anchors.push(allyPos);
            }

            let spawnPoint = null;
            for (const anchor of anchors) {
                const angle = Math.random() * Math.PI * 2;
                const dist = 5 + Math.random() * 5;
                const cx = anchor.x + Math.cos(angle) * dist;
                const cz = anchor.z + Math.sin(angle) * dist;
                const safe = this._findSafeCell(cx, cz, threatMap, 20, intel);
                if (safe) {
                    spawnPoint = new THREE.Vector3(safe.x, safe.y, safe.z);
                    break;
                }
            }

            if (!spawnPoint && this._navGrid) {
                for (let attempt = 0; attempt < 10; attempt++) {
                    const rx = (Math.random() - 0.5) * this._navGrid.width;
                    const rz = (Math.random() - 0.5) * this._navGrid.depth;
                    const safe = this._findSafeCell(rx, rz, threatMap, 15, intel);
                    if (safe) {
                        spawnPoint = new THREE.Vector3(safe.x, safe.y, safe.z);
                        break;
                    }
                }
            }

            if (!spawnPoint) continue;

            soldier.respawn(spawnPoint);
            if (soldier.controller) soldier.controller.onRespawn();
        }
    }
}
