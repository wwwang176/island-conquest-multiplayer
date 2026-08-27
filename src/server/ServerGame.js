import { TICK_RATE, TICK_INTERVAL, WIN_SCORE, MOVE_SPEED, ROUND_COUNTDOWN, MAX_PLAYERS } from '../shared/constants.js';
import { WeaponDefs } from '../entities/WeaponDefs.js';
import {
    encodeWorldSeed, encodeSnapshot, encodeEventBatch, encodeScoreboardSync,
    encodeInputAck, encodePlayerSpawned, encodePlayerJoined, encodePlayerLeft,
    encodeJoinRejected, encodePlayerAppearance,
    EntityType, EventType, SurfaceType, KeyBit,
} from '../shared/protocol.js';
import { sanitizeAppearance, DEFAULT_APPEARANCE } from '../shared/Appearance.js';
import { ServerIsland } from './ServerIsland.js';
import { ServerPhysics } from './ServerPhysics.js';
import { ServerAIManager } from './ServerAIManager.js';
import { ServerGrenadeManager } from './ServerGrenadeManager.js';
import { ServerVehicleManager } from './ServerVehicleManager.js';
import { ServerPlayer } from './ServerPlayer.js';
import { SpawnSystem } from '../systems/SpawnSystem.js';

// Selectable primary weapons (all WeaponDefs entries that have magazineSize)
const VALID_WEAPONS = Object.keys(WeaponDefs).filter(k => WeaponDefs[k].magazineSize);
import { CoverSystem } from '../world/CoverSystem.js';
import { EventBus } from '../core/EventBus.js';

/**
 * Server-side game loop running at 64 ticks/second.
 * Manages all authoritative game state.
 */
export class ServerGame {
    /**
     * @param {object} options
     * @param {number} options.seed - Map generation seed
     */
    constructor({ seed }) {
        this.seed = seed;
        this.tick = 0;
        this.running = false;
        this._ready = false;

        /** @type {import('./NetworkManager.js').NetworkManager|null} */
        this.network = null;

        this.eventBus = new EventBus();
        this.physics = new ServerPhysics();
        this.coverSystem = new CoverSystem();

        // Entities (COMs + Players) — filled in later steps
        this.entities = [];

        // Connected players: clientId → ServerPlayer
        this.players = new Map();

        // Entity ID counter (AI gets 0..N-1, players get N+)
        this._nextEntityId = 0;

        // Time of day: 0=day, 1=dusk, 2=storm
        this.timeOfDay = Math.floor(Math.random() * 3);
        const todNames = ['Day', 'Dusk', 'Storm'];
        console.log(`[Game] Time of day: ${todNames[this.timeOfDay]} (${this.timeOfDay})`);

        // Event queue — collected during tick, broadcast at end
        this.eventQueue = [];

        // Performance monitoring
        this._tickTimes = [];
        this._monitorInterval = null;

        // Island (initialized async)
        this.island = null;
    }

    /**
     * Set the NetworkManager reference.
     * @param {import('./NetworkManager.js').NetworkManager} network
     */
    setNetwork(network) {
        this.network = network;
    }

    /**
     * Initialize game world (async — builds island + NavGrid).
     * Must be called before start().
     */
    async init() {
        await this._buildWorld();

        // Flags (server-side: data-only, no mesh)
        this.flags = [];
        const flagPositions = this.island.getFlagPositions();
        const flagNames = ['A', 'B', 'C', 'D', 'E'];
        for (let i = 0; i < flagPositions.length; i++) {
            this.flags.push({
                name: flagNames[i],
                position: flagPositions[i],
                owner: 'neutral',
                captureProgress: 0,
                capturingTeam: null,
                captureRadius: 8,
                captureTime: 10,
            });
        }
        // Pre-capture base flags
        this.flags[0].owner = 'teamA';
        this.flags[0].captureProgress = 1;
        this.flags[0].capturingTeam = 'teamA';
        this.flags[this.flags.length - 1].owner = 'teamB';
        this.flags[this.flags.length - 1].captureProgress = 1;
        this.flags[this.flags.length - 1].capturingTeam = 'teamB';

        // Scores
        this.scores = { teamA: 0, teamB: 0 };
        this.scoreTimer = 0;
        this.scoreInterval = 3; // seconds between scoring ticks
        this.gameOver = false;

        // AI Manager — creates 30 soldiers (15v15)
        console.log('[Game] Creating AI soldiers...');
        const t2 = performance.now();
        this.aiManager = new ServerAIManager(
            this.physics, this.flags, this.coverSystem,
            (x, z) => this.island.getHeightAt(x, z),
            this.eventBus
        );

        // Wire NavGrid + pathfinding + threat scanning
        this.aiManager.setNavGrid(this.navGrid, this.heightGrid, this.island.obstacleBounds);

        // Populate entities list with all AI soldiers
        for (const s of this.aiManager.teamA.soldiers) this.entities.push(s);
        for (const s of this.aiManager.teamB.soldiers) this.entities.push(s);

        // Apply time-of-day debuffs to AI (before spawning)
        this.aiManager.applyTimeOfDay(this.timeOfDay);

        // Spawn all AI at their base flags
        this.aiManager.spawnAll();

        // Grenade manager (server-side: physics + damage, no visuals)
        this.grenadeManager = new ServerGrenadeManager(this.physics, this.eventBus);
        this.aiManager.grenadeManager = this.grenadeManager;

        // Vehicle manager — 2 neutral helicopters near base flags
        this.vehicleManager = new ServerVehicleManager(
            this.physics, this.flags,
            (x, z) => this.island.getHeightAt(x, z),
            this.eventBus
        );
        this.aiManager.vehicleManager = this.vehicleManager;
        console.log(`[Game] ${this.vehicleManager.vehicles.length} vehicles spawned`);

        // Collidables for raycast shooting (includes vehicle meshes)
        this.collidables = this.island.collidables;

        // Assign entity IDs to AI soldiers
        for (let i = 0; i < this.entities.length; i++) {
            this.entities[i]._entityId = i;
        }
        this._nextEntityId = this.entities.length;

        // Spawn system
        this.spawnSystem = new SpawnSystem(this.flags);

        console.log(`[Game] AI created in ${(performance.now() - t2).toFixed(0)}ms — ${this.entities.length} soldiers`);

        // Kill counter
        this._killCount = 0;

        // Subscribe to game events
        this.eventBus.on('kill', (data) => {
            this._killCount++;
            // Track kills/deaths on entities
            const killer = this.entities.find(e => e._entityId === data.killerEntityId);
            const victim = this.entities.find(e => e._entityId === data.victimEntityId);
            if (killer) killer._kills = (killer._kills || 0) + 1;
            if (victim) victim._deaths = (victim._deaths || 0) + 1;
            this.eventQueue.push({
                type: 'kill', ...data,
                killerKills: killer ? killer._kills : 0,
                victimDeaths: victim ? victim._deaths : 0,
            });
        });
        this.eventBus.on('grenadeExploded', (data) => {
            this.eventQueue.push({ type: 'grenadeExploded', ...data });
        });
        this.eventBus.on('shotFired', (data) => {
            this.eventQueue.push({ type: 'fired', ...data });
        });
        this.eventBus.on('gameOver', (data) => {
            this.eventQueue.push({
                type: 'gameOver',
                winner: data.winner,
                scoreA: data.scores.teamA,
                scoreB: data.scores.teamB,
            });
        });
        this.eventBus.on('vehicleDestroyed', (data) => {
            this.eventQueue.push({ type: 'vehicleDestroyed', ...data });
        });

        this._ready = true;
        console.log('[Game] World ready');
    }

    /**
     * Start the 64Hz game loop.
     */
    start() {
        if (this.running) return;
        this.running = true;
        this._lastTickTime = performance.now();
        this._accumulator = 0;

        // Use setInterval at a faster rate and accumulate for precision
        const intervalMs = Math.floor(TICK_INTERVAL * 1000);
        this._loopTimer = setInterval(() => this._loop(), intervalMs);

        // Performance monitor: log every 10 seconds
        this._monitorInterval = setInterval(() => this._logPerformance(), 10000);

        console.log(`[Game] Started — ${TICK_RATE} tick/s (${(TICK_INTERVAL * 1000).toFixed(2)}ms/tick)`);
    }

    stop() {
        this.running = false;
        if (this._loopTimer) {
            clearInterval(this._loopTimer);
            this._loopTimer = null;
        }
        if (this._monitorInterval) {
            clearInterval(this._monitorInterval);
            this._monitorInterval = null;
        }
        console.log('[Game] Stopped');
    }

    // ── Main Loop ──

    _loop() {
        const now = performance.now();
        const elapsed = (now - this._lastTickTime) / 1000;
        this._lastTickTime = now;
        this._accumulator += elapsed;

        // Process as many ticks as accumulated (catch up if behind)
        while (this._accumulator >= TICK_INTERVAL) {
            const tickStart = performance.now();
            this._tick(TICK_INTERVAL);
            const tickDuration = performance.now() - tickStart;

            this._tickTimes.push(tickDuration);
            if (tickDuration > TICK_INTERVAL * 1000) {
                // Tick took longer than budget — log warning
                console.warn(`[Game] Tick ${this.tick} overran: ${tickDuration.toFixed(2)}ms (budget: ${(TICK_INTERVAL * 1000).toFixed(2)}ms)`);
            }

            this._accumulator -= TICK_INTERVAL;
            this.tick++;
        }
    }

    /**
     * Single tick of game logic.
     * @param {number} dt - Fixed delta time (TICK_INTERVAL)
     */
    _tick(dt) {
        if (this.gameOver) {
            this._tickCountdown(dt);
            this._broadcastState();
            return;
        }

        // Step 1: Process player inputs (including E-key vehicle interaction)
        for (const [, player] of this.players) {
            if (player.alive) {
                const inVehicle = this.vehicleManager.getVehicleOf(player);
                if (inVehicle) {
                    // E-key exit (rising edge, must be safe altitude)
                    const input = player._latestInput;
                    const interact = input ? !!(input.keys & KeyBit.INTERACT) : false;
                    if (interact && !player._prevInteract && inVehicle.canExitSafely((x, z) => this.island.getHeightAt(x, z))) {
                        player._prevInteract = true;
                        const exitPos = this.vehicleManager.exitVehicle(player);
                        if (exitPos) {
                            player.body.position.set(exitPos.x, exitPos.y, exitPos.z);
                            player.body.collisionResponse = true;
                        }
                    } else {
                        player._prevInteract = interact;
                    }
                }
                const stillInVehicle = this.vehicleManager.getVehicleOf(player);
                if (stillInVehicle && stillInVehicle.driver === player) {
                    // Pilot: process vehicle input
                    player.processVehicleInput(dt, stillInVehicle);
                } else if (stillInVehicle) {
                    // Passenger: can shoot but movement is controlled by vehicle
                    player.processPassengerInput(dt, stillInVehicle, this.collidables,
                        this.entities, this.eventQueue,
                        this.vehicleManager.getVehicleMeshes());
                } else {
                    // On foot: normal input processing
                    player.processInput(
                        dt, this.collidables, this.entities,
                        this.eventQueue, this.grenadeManager,
                        this.vehicleManager.getVehicleMeshes()
                    );
                    // E-key: try to enter vehicle (rising edge)
                    this._handlePlayerVehicleInteract(player);
                }
            }
        }

        // Step 2: Vehicle update first (clears old forces, reads physics state)
        this.vehicleManager.update(dt);

        // Step 2.5: AI update — behavior tree, movement, aiming, shooting
        // Must run AFTER vehicle update so applyInput() forces survive until physics.step()
        const aiCollidables = this.collidables.concat(this.vehicleManager.getVehicleMeshes());
        this.aiManager.update(dt, aiCollidables);

        // Step 3: Grenade update + Physics step
        this.grenadeManager.update(dt, this.entities, null, this.vehicleManager);
        this.physics.step(dt);

        // Step 4: Update all entities (health regen, death timers, ragdoll)
        for (const [, player] of this.players) {
            player.update(dt);
        }

        // Step 5: Handle AI respawns (human players respawn via onRespawnRequest)
        for (const [clientId, player] of this.players) {
            if (player.isPlayer) continue; // human players request respawn manually
            if (player.canRespawn()) {
                const teammates = this.entities.filter(
                    e => e.team === player.team && e.alive && e !== player
                );
                const spawnPoints = this.spawnSystem.getSpawnPoints(
                    player.team, teammates,
                    (x, z) => this.island.getHeightAt(x, z)
                );
                const sp = spawnPoints[Math.floor(Math.random() * spawnPoints.length)];
                player.respawn(sp.position);

                // Notify the client of respawn position
                if (this.network) {
                    const pos = player.getPosition();
                    const buf = encodePlayerSpawned(
                        player._entityId, pos.x, pos.y, pos.z,
                        player.team, player.weaponId
                    );
                    this.network.sendToClient(clientId, buf);
                }
            }
        }

        // Step 6: Flag capture update
        this._updateFlags(dt);

        // Step 7: Score update
        this._updateScores(dt);

        // Step 8: Sync all soldier meshes + vehicle meshes (for accurate raycasting next tick)
        for (const s of this.entities) {
            if (s.alive) s.syncMesh();
        }
        this.vehicleManager.syncAllMeshes();

        // Broadcast snapshot + events
        this._broadcastState();
    }

    /**
     * Broadcast snapshot, InputAck, and events to all clients.
     * Runs every tick, including during countdown.
     */
    _broadcastState() {
        // Snapshot
        if (this.network && this.network.clientCount > 0) {
            const snapshotData = this._buildSnapshotData();
            const vehicleData = this.vehicleManager.getVehicleSnapshotData();
            const snapBuf = encodeSnapshot(this.tick, snapshotData, this.flags, this.scores, vehicleData);
            this.network.broadcast(snapBuf);
        }

        // InputAck
        if (this.network) {
            for (const [clientId, player] of this.players) {
                if (player._lastProcessedTick > 0) {
                    const veh = this.vehicleManager.getVehicleOf(player);
                    const pos = player.getPosition();
                    const dmgDir = player.lastDamageDirection;
                    const ack = encodeInputAck(
                        player._lastProcessedTick, pos.x, pos.y, pos.z,
                        player.currentAmmo, player.grenadeCount,
                        dmgDir ? dmgDir.x : 0,
                        dmgDir ? dmgDir.z : 0,
                        player.damageIndicatorTimer,
                        veh ? veh.vehicleId : 0xFF
                    );
                    this.network.sendToClient(clientId, ack);
                }
            }
        }

        // Periodic scoreboard sync (every 128 ticks ≈ 2s)
        if (this.network && this.network.clientCount > 0 && this.tick % 128 === 0) {
            const sbEntries = this._buildScoreboardEntries();
            const spectatorCount = this.network.getSpectatorCount();
            this.network.broadcast(encodeScoreboardSync(sbEntries, spectatorCount));
        }

        // Events
        if (this.eventQueue.length > 0 && this.network && this.network.clientCount > 0) {
            const batchEvents = this._buildEventBatch();
            if (batchEvents.length > 0) {
                const eventBuf = encodeEventBatch(batchEvents);
                this.network.broadcast(eventBuf);
            }
        }
        this.eventQueue.length = 0;
    }

    /**
     * Countdown timer during game-over phase.
     * Broadcasts remaining seconds, then resets the round.
     */
    _tickCountdown(dt) {
        this._countdownTimer -= dt;
        const sec = Math.ceil(this._countdownTimer);
        if (sec !== this._lastCountdownSec && sec >= 0) {
            this._lastCountdownSec = sec;
            this.eventQueue.push({
                type: 'roundCountdown',
                secondsLeft: sec,
            });
        }

        if (this._countdownTimer <= 0 && !this._resetting) {
            // Regenerating the map is async (NavGrid runs in a worker), so this
            // returns immediately and the countdown keeps ticking harmlessly until
            // _resetting clears. gameOver stays true throughout, which means _tick()
            // only broadcasts state — no simulation runs against a half-swapped world.
            this._resetting = true;
            this._resetRound()
                .catch((err) => {
                    console.error('[Game] Round reset failed:', err);
                })
                .finally(() => {
                    this._resetting = false;
                });
        }
    }

    /**
     * Reset all game state for a new round.
     * All players are removed (kicked to spectator on client side).
     * The map seed and time of day are re-rolled, so every round gets a fresh island.
     */
    async _resetRound() {
        console.log('[Game] Resetting round...');

        // 1. Remove all players (ejects from vehicles, broadcasts PlayerLeft)
        const playerIds = [...this.players.keys()];
        for (const clientId of playerIds) {
            this.onLeaveRequest(clientId);
        }

        // 2. Clear active grenades
        for (const g of this.grenadeManager.grenades) {
            g.dispose();
        }
        this.grenadeManager.grenades.length = 0;

        // 3. Regenerate the map — new seed, new time of day, new flag positions.
        //    Must happen before vehicles/AI respawn so they land on the new terrain.
        await this._regenerateWorld();

        // 4. Reset vehicles — clear occupants, move spawns onto the new island, respawn
        this.vehicleManager.relocateSpawns();
        for (const v of this.vehicleManager.vehicles) {
            v.driver = null;
            v.passengers = [];
            v.respawn();
        }

        // 5. Reset flags to initial state
        for (const flag of this.flags) {
            flag.owner = 'neutral';
            flag.captureProgress = 0;
            flag.capturingTeam = null;
        }
        this.flags[0].owner = 'teamA';
        this.flags[0].captureProgress = 1;
        this.flags[0].capturingTeam = 'teamA';
        this.flags[this.flags.length - 1].owner = 'teamB';
        this.flags[this.flags.length - 1].captureProgress = 1;
        this.flags[this.flags.length - 1].capturingTeam = 'teamB';

        // 6. Reset scores
        this.scores.teamA = 0;
        this.scores.teamB = 0;
        this.scoreTimer = 0;

        // 7. Respawn all AI soldiers at their base flags
        const respawnTeam = (teamData, team) => {
            const flag = team === 'teamA' ? this.flags[0] : this.flags[this.flags.length - 1];
            for (const soldier of teamData.soldiers) {
                const angle = Math.random() * Math.PI * 2;
                const dist = 5 + Math.random() * 10;
                const x = flag.position.x + Math.cos(angle) * dist;
                const z = flag.position.z + Math.sin(angle) * dist;
                const y = this.island.getHeightAt(x, z);
                soldier.respawn({ x, y: Math.max(y, 1), z });
                if (soldier.controller) soldier.controller.onRespawn();
            }
        };
        respawnTeam(this.aiManager.teamA, 'teamA');
        respawnTeam(this.aiManager.teamB, 'teamB');

        // 8. Clear game state
        this.gameOver = false;
        this._gameOverWinner = null;
        this._killCount = 0;
        for (const e of this.entities) {
            e._kills = 0;
            e._deaths = 0;
        }

        // 9. Push restart event
        this.eventQueue.push({ type: 'roundRestart' });

        console.log('[Game] New round started');
    }

    /**
     * Build (or rebuild) the island and everything derived from it for the current
     * seed. Shared by init() and the round reset so the two can't drift apart.
     */
    async _buildWorld() {
        const t0 = performance.now();

        // Replacing an existing island: unregister its static bodies and cover spots
        // first, or the old colliders would keep blocking movement and shots.
        if (this.island) {
            this.island.dispose();
            this.coverSystem.clear();
        }

        console.log('[Game] Generating island...');
        this.island = new ServerIsland(this.physics, this.coverSystem, this.seed);
        const islandMs = performance.now() - t0;

        console.log('[Game] Building NavGrid...');
        const t1 = performance.now();
        const { navGrid, heightGrid } = await this.island.buildNavGridAsync();
        this.navGrid = navGrid;
        this.heightGrid = heightGrid;
        this.collidables = this.island.collidables;

        console.log(
            `[Game] Island generated in ${islandMs.toFixed(0)}ms — ` +
            `${this.island.collidables.length} collidables; NavGrid built in ` +
            `${(performance.now() - t1).toFixed(0)}ms — ${navGrid.cols}×${navGrid.rows}`
        );
    }

    /**
     * Re-roll the map seed and time of day, then rebuild the island and everything
     * bound to it: NavGrid, cover registry, flag positions, AI threat maps.
     *
     * Safe to await from _resetRound(): gameOver is still true at that point, so
     * _tick() only broadcasts state and nothing simulates against a half-built world.
     */
    async _regenerateWorld() {
        const t0 = performance.now();
        const todNames = ['Day', 'Dusk', 'Storm'];

        this.seed = Math.random() * 65536;
        this.timeOfDay = Math.floor(Math.random() * 3);

        await this._buildWorld();

        // Flag objects are held by reference from AIManager, VehicleManager and
        // SpawnSystem, so move them in place instead of rebuilding the array.
        const flagPositions = this.island.getFlagPositions();
        for (let i = 0; i < this.flags.length; i++) {
            this.flags[i].position = flagPositions[i];
        }

        // Rebind AI to the new grid, terrain and weather
        this.aiManager.setNavGrid(this.navGrid, this.heightGrid, this.island.obstacleBounds);
        this.aiManager.applyTimeOfDay(this.timeOfDay);

        // Tell every connected client to rebuild its world with the new seed
        if (this.network) {
            this.network.broadcast(
                encodeWorldSeed(this.seed, 0, this.entities.length, this.timeOfDay)
            );
        }

        console.log(
            `[Game] World regenerated in ${(performance.now() - t0).toFixed(0)}ms — ` +
            `seed=${this.seed.toFixed(2)}, time of day=${todNames[this.timeOfDay]}`
        );
    }

    /**
     * Update flag capture state — server-side version of FlagPoint.update().
     */
    _updateFlags(dt) {
        const teamAPos = this.aiManager.getTeamPositions('teamA');
        const teamBPos = this.aiManager.getTeamPositions('teamB');

        // Include player positions for flag capture
        for (const [, player] of this.players) {
            if (!player.alive) continue;
            const pos = player.getPosition();
            if (player.team === 'teamA') teamAPos.push(pos);
            else teamBPos.push(pos);
        }

        for (const flag of this.flags) {
            const r2 = flag.captureRadius * flag.captureRadius;

            // Count soldiers of each team in capture radius
            let aCount = 0;
            for (const pos of teamAPos) {
                const dx = pos.x - flag.position.x;
                const dy = pos.y - flag.position.y;
                const dz = pos.z - flag.position.z;
                if (dx * dx + dy * dy + dz * dz <= r2) aCount++;
            }
            let bCount = 0;
            for (const pos of teamBPos) {
                const dx = pos.x - flag.position.x;
                const dy = pos.y - flag.position.y;
                const dz = pos.z - flag.position.z;
                if (dx * dx + dy * dy + dz * dz <= r2) bCount++;
            }

            if (aCount > 0 && bCount > 0) {
                // Contested — no progress change
            } else if (aCount > 0) {
                this._progressCapture(flag, 'teamA', aCount, dt);
            } else if (bCount > 0) {
                this._progressCapture(flag, 'teamB', bCount, dt);
            }
        }
    }

    _progressCapture(flag, team, count, dt) {
        const speed = (1 / flag.captureTime) * (1 + (count - 1) * 0.3);

        if (flag.owner === team) {
            flag.captureProgress = 1;
            flag.capturingTeam = team;
            return;
        }

        if (flag.capturingTeam === team || flag.capturingTeam === null) {
            flag.capturingTeam = team;
            flag.captureProgress = Math.min(1, flag.captureProgress + speed * dt);
            if (flag.captureProgress >= 1) {
                const prevOwner = flag.owner;
                flag.owner = team;
                flag.captureProgress = 1;
                if (prevOwner !== team) {
                    this.eventQueue.push({
                        type: 'flagCaptured',
                        flagName: flag.name,
                        newOwner: team,
                    });
                    console.log(`[Game] Flag ${flag.name} captured by ${team}`);
                }
            }
        } else {
            flag.captureProgress = Math.max(0, flag.captureProgress - speed * dt);
            if (flag.captureProgress <= 0) {
                flag.capturingTeam = team;
                flag.captureProgress = 0;
            }
        }
    }

    _updateScores(dt) {
        this.scoreTimer += dt;
        if (this.scoreTimer >= this.scoreInterval) {
            this.scoreTimer -= this.scoreInterval;

            let aFlags = 0, bFlags = 0;
            for (const flag of this.flags) {
                if (flag.owner === 'teamA') aFlags++;
                else if (flag.owner === 'teamB') bFlags++;
            }

            this.scores.teamA += aFlags;
            this.scores.teamB += bFlags;

            if (this.scores.teamA >= WIN_SCORE) {
                this.gameOver = true;
                this._gameOverWinner = 'teamA';
                this._countdownTimer = ROUND_COUNTDOWN;
                this._lastCountdownSec = ROUND_COUNTDOWN + 1;
                this.eventBus.emit('gameOver', { winner: 'teamA', scores: { ...this.scores } });
                console.log(`[Game] GAME OVER — Team A wins! (${this.scores.teamA} - ${this.scores.teamB}) — restarting in ${ROUND_COUNTDOWN}s`);
            } else if (this.scores.teamB >= WIN_SCORE) {
                this.gameOver = true;
                this._gameOverWinner = 'teamB';
                this._countdownTimer = ROUND_COUNTDOWN;
                this._lastCountdownSec = ROUND_COUNTDOWN + 1;
                this.eventBus.emit('gameOver', { winner: 'teamB', scores: { ...this.scores } });
                console.log(`[Game] GAME OVER — Team B wins! (${this.scores.teamA} - ${this.scores.teamB}) — restarting in ${ROUND_COUNTDOWN}s`);
            }
        }
    }

    // ── Snapshot & Event Building ──

    _buildSnapshotData() {
        const data = [];
        for (let i = 0; i < this.entities.length; i++) {
            const s = this.entities[i];
            const pos = s.getPosition();
            // Extract yaw from upper body rotation + pitch from shoulder pivot
            const yaw = s.upperBody ? s.upperBody.rotation.y : 0;
            const pitch = s.shoulderPivot ? s.shoulderPivot.rotation.x : 0;
            // State bits: bit0=alive, bit1=reloading, bit2=bolting, bit3=scoped
            let state = 0;
            if (s.alive) state |= 1;
            if (s.isPlayer) {
                if (s.isReloading) state |= 2;
                if (s.isBolting) state |= 4;
            } else if (s.controller) {
                if (s.controller.isReloading) state |= 2;
                if (s.controller.boltTimer > 0) state |= 4;
                if (s.controller.isScoped) state |= 8;
            }

            // Ammo + grenades
            let ammo = 0, grenades = 0;
            if (s.isPlayer) {
                ammo = s.currentAmmo ?? 0;
                grenades = s.grenadeCount ?? 0;
            } else if (s.controller) {
                ammo = s.controller.currentAmmo ?? 0;
                grenades = s.controller.grenadeCount ?? 0;
            }

            data.push({
                entityId: s._entityId,
                type: s.isPlayer ? EntityType.PLAYER : EntityType.COM,
                team: s.team,
                x: pos.x,
                y: pos.y,
                z: pos.z,
                yaw,
                pitch,
                hp: s.hp,
                state,
                weaponId: s.isPlayer ? s.weaponId : (s.controller ? s.controller.weaponId : 'AR15'),
                ammo,
                grenades,
            });
        }

        // Include active grenades
        for (const g of this.grenadeManager.grenades) {
            if (!g.alive) continue;
            data.push({
                entityId: g._entityId,
                type: EntityType.GRENADE,
                team: g.throwerTeam,
                x: g.body.position.x,
                y: g.body.position.y,
                z: g.body.position.z,
                yaw: 0, pitch: 0, hp: 0, state: 0, weaponId: 'AR15',
            });
        }

        return data;
    }

    _buildEventBatch() {
        const batch = [];
        const flagNames = ['A', 'B', 'C', 'D', 'E'];
        for (const ev of this.eventQueue) {
            switch (ev.type) {
                case 'fired':
                    batch.push({
                        eventType: EventType.FIRED,
                        shooterId: ev.shooterId,
                        originX: ev.originX,
                        originY: ev.originY,
                        originZ: ev.originZ,
                        dirX: ev.dirX,
                        dirY: ev.dirY,
                        dirZ: ev.dirZ,
                        hitDist: ev.hitDist,
                        surfaceType: ev.surfaceType,
                    });
                    break;
                case 'kill':
                    batch.push({
                        eventType: EventType.KILLED,
                        killerName: ev.killerName || '?',
                        killerTeam: ev.killerTeam || 'teamA',
                        victimName: ev.victimName || '?',
                        victimTeam: ev.victimTeam || 'teamB',
                        weaponId: ev.weapon || 'AR15',
                        headshot: ev.headshot || false,
                        killerEntityId: ev.killerEntityId ?? 0xFFFF,
                        victimEntityId: ev.victimEntityId ?? 0xFFFF,
                        killerKills: ev.killerKills ?? 0,
                        victimDeaths: ev.victimDeaths ?? 0,
                    });
                    break;
                case 'flagCaptured':
                    batch.push({
                        eventType: EventType.FLAG_CAPTURED,
                        flagIdx: flagNames.indexOf(ev.flagName),
                        newOwner: ev.newOwner,
                    });
                    break;
                case 'grenadeExploded':
                    if (ev.position) {
                        batch.push({
                            eventType: EventType.GRENADE_EXPLODE,
                            x: ev.position.x,
                            y: ev.position.y,
                            z: ev.position.z,
                        });
                    }
                    break;
                case 'gameOver':
                    batch.push({
                        eventType: EventType.GAME_OVER,
                        winner: ev.winner,
                        scoreA: ev.scoreA,
                        scoreB: ev.scoreB,
                    });
                    break;
                case 'vehicleDestroyed':
                    batch.push({
                        eventType: EventType.VEHICLE_DESTROYED,
                        vehicleId: ev.vehicleId,
                        x: ev.x,
                        y: ev.y,
                        z: ev.z,
                        vx: ev.vx,
                        vy: ev.vy,
                        vz: ev.vz,
                        avx: ev.avx,
                        avy: ev.avy,
                        avz: ev.avz,
                    });
                    break;
                case 'roundCountdown':
                    batch.push({
                        eventType: EventType.ROUND_COUNTDOWN,
                        secondsLeft: ev.secondsLeft,
                    });
                    break;
                case 'roundRestart':
                    batch.push({
                        eventType: EventType.ROUND_RESTART,
                    });
                    break;
            }
        }
        return batch;
    }

    /**
     * Build scoreboard entries with per-player ping for SCOREBOARD_SYNC.
     */
    _buildScoreboardEntries() {
        return this.entities.map(e => {
            const isPlayer = e.isPlayer;
            const name = isPlayer
                ? (e.playerName || e.id)
                : `${e.team === 'teamA' ? 'A' : 'B'}-${e.id}`;
            let ping = 0;
            if (isPlayer && this.network) {
                // Look up clientId for this player entity
                for (const [cid, p] of this.players) {
                    if (p === e) { ping = this.network.getClientRtt(cid); break; }
                }
            }
            return {
                name,
                team: e.team,
                weaponId: isPlayer ? (e.weaponId || 'AR15') : (e.controller?.weaponId || 'AR15'),
                kills: e._kills || 0,
                deaths: e._deaths || 0,
                ping,
            };
        });
    }

    /**
     * Handle E-key vehicle interaction (rising edge) for a player.
     */
    _handlePlayerVehicleInteract(player) {
        const input = player._latestInput;
        if (!input) return;

        const interact = !!(input.keys & KeyBit.INTERACT);
        if (!interact || player._prevInteract) {
            player._prevInteract = interact;
            return;
        }
        player._prevInteract = interact;

        const vehicle = this.vehicleManager.tryEnterVehicle(player);
        if (vehicle) {
            vehicle.enter(player);
        }
    }

    // ── Network Callbacks ──

    /**
     * Called when a new client connects.
     * @param {number} clientId
     * @param {import('ws').WebSocket} ws
     */
    onClientConnected(clientId, ws) {
        // Send world seed so client can generate matching terrain
        const worldSeed = encodeWorldSeed(this.seed, 0, this.entities.length, this.timeOfDay);
        this.network.send(ws, worldSeed);

        // Send accumulated scoreboard so late joiners see existing kills/deaths
        const sbEntries = this._buildScoreboardEntries();
        const spectatorCount = this.network.getSpectatorCount();
        this.network.send(ws, encodeScoreboardSync(sbEntries, spectatorCount));

        // Replay every current player's appearance so late joiners colour them
        // correctly the first time they show up in a snapshot
        const appearances = [];
        for (const [, p] of this.players) {
            appearances.push({ entityId: p._entityId, appearance: p.appearance ?? DEFAULT_APPEARANCE });
        }
        if (appearances.length > 0) {
            this.network.send(ws, encodePlayerAppearance(appearances));
        }

        // If game is in end-of-round countdown, send GAME_OVER + current countdown
        // so the late joiner sees the result screen immediately
        if (this.gameOver && this._gameOverWinner) {
            const catchUpEvents = [
                {
                    eventType: EventType.GAME_OVER,
                    winner: this._gameOverWinner,
                    scoreA: this.scores.teamA,
                    scoreB: this.scores.teamB,
                },
                {
                    eventType: EventType.ROUND_COUNTDOWN,
                    secondsLeft: Math.max(0, Math.ceil(this._countdownTimer)),
                },
            ];
            this.network.send(ws, encodeEventBatch(catchUpEvents));
        }

        console.log(`[Game] Client ${clientId} connected — sent WorldSeed (seed=${this.seed.toFixed(2)})`);
    }

    /**
     * Called when a client disconnects.
     * @param {number} clientId
     */
    onClientDisconnected(clientId) {
        // Remove player if they were in-game
        if (this.players.has(clientId)) {
            this.onLeaveRequest(clientId);
        }
        console.log(`[Game] Client ${clientId} fully disconnected`);
    }

    /**
     * Called when a client sends an input packet.
     * @param {number} clientId
     * @param {object} input - Decoded InputPacket
     */
    onClientInput(clientId, input) {
        const player = this.players.get(clientId);
        if (player) {
            player.receiveInput(input);
        }
    }

    /**
     * Called when a client requests to join a team.
     * @param {number} clientId
     * @param {string} team - 'teamA' or 'teamB'
     * @param {string} weaponId - e.g. 'AR15'
     * @param {string} playerName
     * @param {number} [appearance=0] - packed head/leg palette indices
     */
    onJoinRequest(clientId, team, weaponId, playerName, appearance = DEFAULT_APPEARANCE) {
        // Block joins during countdown
        if (this.gameOver) {
            console.log(`[Game] Client ${clientId} tried to join during countdown, ignoring`);
            return;
        }

        // Prevent double-join
        if (this.players.has(clientId)) {
            console.log(`[Game] Client ${clientId} already in game, ignoring join`);
            return;
        }

        // Enforce MAX_PLAYERS limit
        if (this.players.size >= MAX_PLAYERS) {
            console.log(`[Game] Client ${clientId} rejected: server full (${this.players.size}/${MAX_PLAYERS})`);
            if (this.network) {
                this.network.sendToClient(clientId, encodeJoinRejected('Server is full'));
            }
            return;
        }

        // Validate weaponId — fall back to AR15 if invalid
        if (!VALID_WEAPONS.includes(weaponId)) weaponId = VALID_WEAPONS[0];

        // ── Sanitize player name ──
        playerName = String(playerName).trim().replace(/[^\w\s\-]/g, '').substring(0, 16).trim();
        if (playerName.length === 0) playerName = 'Player';

        // Reject names that look like COM names (e.g. A-3, B-14)
        if (/^[AB]-\d+$/.test(playerName)) {
            console.log(`[Game] Client ${clientId} rejected: name "${playerName}" resembles COM format`);
            if (this.network) {
                this.network.sendToClient(clientId, encodeJoinRejected('Name not allowed'));
            }
            return;
        }

        // Reject duplicate player names
        for (const [, p] of this.players) {
            if (p.playerName === playerName) {
                console.log(`[Game] Client ${clientId} rejected: name "${playerName}" already taken`);
                if (this.network) {
                    this.network.sendToClient(clientId, encodeJoinRejected('Name already taken'));
                }
                return;
            }
        }

        console.log(`[Game] Client ${clientId} joining ${team} with ${weaponId} as "${playerName}"`);

        // Create ServerPlayer
        const entityId = this._nextEntityId++;
        const player = new ServerPlayer(
            this.physics, team, `P-${clientId}`,
            clientId, playerName, weaponId
        );
        player._entityId = entityId;
        player.appearance = sanitizeAppearance(appearance);
        player.eventBus = this.eventBus;
        player.getHeightAt = (x, z) => this.island.getHeightAt(x, z);
        player.navGrid = this.navGrid;

        // Register (must be done before findSafeSpawn so player is in entities)
        this.players.set(clientId, player);
        this.entities.push(player);

        // Find spawn point using threat map + intel (same as AI)
        const spawnPos = this.aiManager.findSafeSpawn(team);
        if (spawnPos) {
            player.respawn(spawnPos);
        } else {
            // Fallback: basic spawn system
            const teammates = this.entities.filter(
                e => e.team === team && e.alive && e !== player
            );
            const spawnPoints = this.spawnSystem.getSpawnPoints(
                team, teammates,
                (x, z) => this.island.getHeightAt(x, z)
            );
            const sp = spawnPoints[Math.floor(Math.random() * spawnPoints.length)];
            player.respawn(sp.position);
        }
        this.aiManager.addPlayer(clientId, player);

        // Notify the joining client
        const pos = player.getPosition();
        if (this.network) {
            const spawnBuf = encodePlayerSpawned(
                entityId, pos.x, pos.y, pos.z, team, weaponId
            );
            this.network.sendToClient(clientId, spawnBuf);

            // Broadcast PlayerJoined to all other clients
            const joinBuf = encodePlayerJoined(entityId, playerName, team);
            this.network.broadcastExcept(joinBuf, clientId);

            // Appearance goes to everyone, the joiner included — they see their own
            // soldier in the death cam and while spectating.
            this.network.broadcast(
                encodePlayerAppearance([{ entityId, appearance: player.appearance }])
            );
        }

        console.log(`[Game] Player "${playerName}" spawned as entity ${entityId} at (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`);
    }

    /**
     * Called when a client requests to leave the game.
     * @param {number} clientId
     */
    onLeaveRequest(clientId) {
        const player = this.players.get(clientId);
        if (!player) return;

        console.log(`[Game] Player "${player.playerName}" (client ${clientId}) leaving game`);

        // Eject from vehicle if in one
        const veh = this.vehicleManager.getVehicleOf(player);
        if (veh) {
            veh.exit(player);
        }

        // Unregister from AI targeting
        this.aiManager.removePlayer(clientId);

        // Remove from entities array
        const idx = this.entities.indexOf(player);
        if (idx !== -1) this.entities.splice(idx, 1);

        // Remove physics body
        player.removeFromPhysics();

        // Broadcast PlayerLeft
        if (this.network) {
            const buf = encodePlayerLeft(player._entityId);
            this.network.broadcast(buf);
        }

        this.players.delete(clientId);
    }

    /**
     * Called when a client requests to respawn with a chosen weapon.
     * @param {number} clientId
     * @param {string} weaponId - e.g. 'AR15', 'SMG', 'LMG', 'BOLT'
     */
    onRespawnRequest(clientId, weaponId) {
        if (this.gameOver) return;
        const player = this.players.get(clientId);
        if (!player) return;
        if (player.alive || !player.canRespawn()) return;

        // Validate weaponId — fall back to AR15 if invalid
        if (!VALID_WEAPONS.includes(weaponId)) weaponId = VALID_WEAPONS[0];

        // Apply new weapon
        player.weaponId = weaponId;
        player.setWeaponModel(weaponId);
        const def = WeaponDefs[weaponId];
        player.moveSpeed = MOVE_SPEED * (def?.moveSpeedMult || 1.0);
        player.magazineSize = def?.magazineSize || 30;

        // Find spawn point using threat map + intel (same as AI)
        const spawnPos = this.aiManager.findSafeSpawn(player.team);
        if (spawnPos) {
            player.respawn(spawnPos);
        } else {
            // Fallback: basic spawn system
            const teammates = this.entities.filter(
                e => e.team === player.team && e.alive && e !== player
            );
            const spawnPoints = this.spawnSystem.getSpawnPoints(
                player.team, teammates,
                (x, z) => this.island.getHeightAt(x, z)
            );
            const sp = spawnPoints[Math.floor(Math.random() * spawnPoints.length)];
            player.respawn(sp.position);
        }

        // Notify client
        if (this.network) {
            const pos = player.getPosition();
            const buf = encodePlayerSpawned(
                player._entityId, pos.x, pos.y, pos.z,
                player.team, weaponId
            );
            this.network.sendToClient(clientId, buf);
        }

        console.log(`[Game] Player "${player.playerName}" respawned with ${weaponId}`);
    }

    // ── Performance Monitoring ──

    _logPerformance() {
        if (this._tickTimes.length === 0) return;
        const avg = this._tickTimes.reduce((a, b) => a + b, 0) / this._tickTimes.length;
        const max = Math.max(...this._tickTimes);
        console.log(
            `[Perf] Tick avg: ${avg.toFixed(2)}ms, max: ${max.toFixed(2)}ms, ` +
            `clients: ${this.network ? this.network.clientCount : 0}, ` +
            `entities: ${this.entities.length}, kills: ${this._killCount || 0}, tick#: ${this.tick}`
        );
        this._tickTimes.length = 0;
    }
}
