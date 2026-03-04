import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { Island } from '../world/Island.js';
import { FlagPoint } from '../world/FlagPoint.js';
import { TracerSystem } from '../vfx/TracerSystem.js';
import { ImpactVFX } from '../vfx/ImpactVFX.js';
import { StormVFX } from '../vfx/StormVFX.js';
import { Minimap } from '../ui/Minimap.js';
import { KillFeed } from '../ui/KillFeed.js';
import { SpectatorHUD } from '../ui/SpectatorHUD.js';
import { InputManager } from '../core/InputManager.js';
import { EventBus } from '../core/EventBus.js';
import { NetworkClient } from './NetworkClient.js';
import { EntityRenderer, buildGunMesh, createMuzzleFlashMesh } from './EntityRenderer.js';
import { VehicleRenderer } from './VehicleRenderer.js';
import { EventType, SurfaceType } from '../shared/protocol.js';
import { WeaponDefs, GunAnim } from '../entities/WeaponDefs.js';
import { MOVE_SPEED, TEAM_SIZE } from '../shared/constants.js';
import Stats from 'three/addons/libs/stats.module.js';

import { ClientHUD } from './ClientHUD.js';
import { Scoreboard } from './Scoreboard.js';
import { JoinScreen } from './JoinScreen.js';
import { DeathScreen } from './DeathScreen.js';
import { GameOverScreen } from './GameOverScreen.js';
import { FPSController } from './FPSController.js';
import { SpectatorController } from './SpectatorController.js';
import { VehicleController } from './VehicleController.js';

const _euler = new THREE.Euler(0, 0, 0, 'YXZ');

// Reusable vectors for VFX
const _firedOrigin = new THREE.Vector3();
const _firedDir    = new THREE.Vector3();
const _hitPoint    = new THREE.Vector3();
const _hitNormal   = new THREE.Vector3();
const _normalRaycaster = new THREE.Raycaster();


/**
 * Build a first-person gun group for the given weapon ID.
 * Mirrors Weapon.buildFPGunMesh logic from the single-player version.
 */
function _buildFPGunGroup(weaponId, team) {
    const gun = buildGunMesh(weaponId);
    gun.position.set(0.25, -0.19, -0.40);

    const group = new THREE.Group();
    group.add(gun);

    // First-person arms — match team color (same logic as Player._getLimbColor)
    let armColor = 0xddbb99;
    if (team) {
        const tc = new THREE.Color(team === 'teamA' ? 0x4488ff : 0xff4444);
        armColor = tc.multiplyScalar(0.7).getHex();
    }
    const armMat = new THREE.MeshLambertMaterial({ color: armColor });
    const [rGripZ, lGripZ] = WeaponDefs[weaponId].fpGripZ;

    // Right arm (trigger hand)
    const rightArmGeo = new THREE.BoxGeometry(0.15, 0.40, 0.15);
    rightArmGeo.translate(0, -0.20, 0);
    const rightArm = new THREE.Mesh(rightArmGeo, armMat);
    rightArm.position.set(0.28, -0.22, rGripZ);
    rightArm.rotation.set(-1.1, 0, 0);
    group.add(rightArm);

    // Left arm (support hand)
    const leftArmGeo = new THREE.BoxGeometry(0.15, 0.55, 0.15);
    leftArmGeo.translate(0, -0.275, 0);
    const leftArm = new THREE.Mesh(leftArmGeo, armMat);
    leftArm.position.set(0.21, -0.22, lGripZ);
    leftArm.rotation.set(-1.2, 0, -0.5);
    group.add(leftArm);

    // Muzzle flash
    const flash = createMuzzleFlashMesh();
    flash.visible = false;
    const def = WeaponDefs[weaponId];
    flash.position.set(0.25, -0.18, -0.40 + def.tpMuzzleZ);
    group.add(flash);

    group.position.set(-0.20, -0.10, 0);
    return { group, muzzleFlash: flash };
}

/**
 * Networked client game — connects to server, receives snapshots, renders entities.
 * Main game orchestrator for multiplayer mode.
 */
export class ClientGame {
    constructor() {
        this.eventBus = new EventBus();
        this.input = new InputManager();
        this.clock = new THREE.Clock();
        this.gameMode = 'connecting'; // 'connecting' | 'spectator' | 'playing' | 'dead'

        // ── Renderer ──
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFShadowMap;
        this.renderer.setClearColor(0x87CEEB);
        document.body.appendChild(this.renderer.domElement);

        // ── Stats (FPS counter) ──
        this.stats = new Stats();
        this.stats.showPanel(0);
        document.body.appendChild(this.stats.dom);

        // ── Scene ──
        this.scene = new THREE.Scene();
        this.scene.fog = new THREE.Fog(0x87CEEB, 100, 300);

        // ── Camera ──
        this.camera = new THREE.PerspectiveCamera(
            75, window.innerWidth / window.innerHeight, 0.1, 500
        );
        this.scene.add(this.camera);

        // ── Lighting ──
        this._setupLighting();

        // ── Window resize ──
        window.addEventListener('resize', () => {
            this.camera.aspect = window.innerWidth / window.innerHeight;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(window.innerWidth, window.innerHeight);
        });

        // ── Network ──
        this.network = new NetworkClient();
        this.entityRenderer = new EntityRenderer(this.scene);
        this.vehicleRenderer = new VehicleRenderer(this.scene);

        // ── World state ──
        this.island = null;
        this.flags = [];
        this.scores = { teamA: 0, teamB: 0 };

        // ── VFX (initialized after island) ──
        this.tracerSystem = null;
        this.impactVFX = null;
        this.stormVFX = null;

        // ── UI ──
        this.minimap = null;
        this.killFeed = new KillFeed();
        this.spectatorHUD = new SpectatorHUD();

        // ── Extracted UI modules ──
        this.hud = new ClientHUD();
        this.scoreboard = new Scoreboard();
        this.joinScreen = new JoinScreen();
        this.deathScreen = new DeathScreen();
        this.deathScreen._onRespawn = (weaponId) => {
            this._fps.weaponId = weaponId;
            const def = WeaponDefs[weaponId];
            this._fps.moveSpeed = MOVE_SPEED * (def?.moveSpeedMult || 1.0);
            this.network.sendRespawn(weaponId);
        };
        this.deathScreen._onSpectate = () => {
            this._leaveGame();
        };
        this.gameOverScreen = new GameOverScreen();

        // ── Spectator camera state ──
        this._spectator = {
            mode: 'follow',
            targetIndex: 0,
            targetId: null,
            overheadPos: new THREE.Vector3(0, 120, 0),
            overheadZoom: 120,
            panSpeed: 80,
            lerpYaw: 0,
            lerpPitch: 0,
            initialized: false,
            deathFreezeTimer: 0,
            lastScoped: false,
        };

        // ── FPS mode state ──
        this._fps = {
            myEntityId: -1,
            team: 'teamA',
            weaponId: 'AR15',
            playerName: 'Player',
            localTick: 0,
            yaw: 0,
            pitch: 0,
            predictedPos: new THREE.Vector3(),
            serverPos: new THREE.Vector3(),
            velX: 0,
            velZ: 0,
            isJumping: false,
            jumpVelY: 0,
            prevSpace: false,
            moveSpeed: MOVE_SPEED,
            mouseSensitivity: 0.002,
            // FP gun model
            fpGunGroup: null,
            fpMuzzleFlash: null,
            fpMuzzleFlashTimer: 0,
            // Recoil / tilt
            fpRecoilOffset: 0,
            fpReloadTilt: 0,
            isReloading: false,
            isBolting: false,
            // Scope
            isScoped: false,
            prevRightMouse: false,
            // Death camera
            deathLerp: { active: false, yaw: 0, pitch: 0, targetYaw: 0, targetPitch: 0 },
            // Grenade throw lock
            grenadeThrowTimer: 0,
            prevGrenade: false,
            // Vehicle state
            vehicleId: 0xFF,   // 0xFF = not in vehicle
        };

        // ── Server HUD state (written by onSnapshot/onInputAck, read by _updatePlayerHUD) ──
        this._serverHP = 100;
        this._serverAmmo = 30;
        this._serverGrenades = 2;

        // ── Controllers ──
        this.fpsController = new FPSController();
        this.spectatorController = new SpectatorController();
        this.vehicleController = new VehicleController();

        // ── Previous flag states for detecting changes ──
        this._prevFlagStates = [];

        // ── Connection UI ──
        this.joinScreen.createConnectionUI((url) => this.network.connect(url));

        // ── Key handlers ──
        document.addEventListener('keydown', (e) => this._onGlobalKey(e));
        document.addEventListener('keydown', (e) => {
            if (e.code === 'Tab') {
                e.preventDefault();
                this.scoreboard.updateWeaponData(this.entityRenderer, this.scoreboard.playerNames, TEAM_SIZE);
                this.scoreboard.show(this._fps.playerName, this._fps.myEntityId);
            }
        });
        document.addEventListener('keyup', (e) => {
            if (e.code === 'Tab') { e.preventDefault(); this.scoreboard.hide(); }
        });

        // ── Pointer lock for FPS ──
        this.renderer.domElement.addEventListener('click', () => {
            if (this.gameMode === 'playing') {
                this.input.requestPointerLock();
            }
        });

        // ── Bind animate ──
        this._boundAnimate = () => this._animate();

        // ── Suppress VFX when tab is hidden ──
        this._suppressVFX = false;
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                this._suppressVFX = true;
            }
        });

        // ── Network callbacks ──
        this.network.onWorldSeed = (seed, flagLayout, entityCount, timeOfDay) => {
            this._onWorldSeed(seed, flagLayout, entityCount, timeOfDay);
        };
        this.network.onSnapshot = (tick, entities, flags, scores, vehicles) => {
            this._onSnapshot(tick, entities, flags, scores, vehicles);
        };
        this.network.onEvents = (events) => {
            this._onEvents(events);
        };
        this.network.onPlayerSpawned = (playerId, x, y, z, team, weaponId) => {
            this._onPlayerSpawned(playerId, x, y, z, team, weaponId);
        };
        this.network.onInputAck = (lastProcessedTick, x, y, z, ammo, grenades, dmgDirX, dmgDirZ, dmgTimer, vehicleId) => {
            this._onInputAck(lastProcessedTick, x, y, z, ammo, grenades, dmgDirX, dmgDirZ, dmgTimer, vehicleId);
        };
        this.network.onPlayerJoined = (playerId, team, playerName) => {
            console.log(`[Client] Player "${playerName}" joined ${team} (entity ${playerId})`);
            this.scoreboard.playerNames.set(playerId, playerName);
            if (!this.scoreboard.data[playerName]) {
                this.scoreboard.data[playerName] = { kills: 0, deaths: 0, team, weapon: '' };
            }
            // Remove the AI placeholder this player replaced
            const aiName = team === 'teamA' ? `A-${playerId}` : `B-${playerId - TEAM_SIZE}`;
            delete this.scoreboard.data[aiName];
        };
        this.network.onPlayerLeft = (playerId) => {
            console.log(`[Client] Player entity ${playerId} left the game`);
        };
        this.network.onJoinRejected = (reason) => {
            console.log(`[Client] Join rejected: ${reason}`);
            this.joinScreen.createJoinUI((team, wpn, name) => this._joinGame(team, wpn, name), () => {}, reason);
        };
        this.network.onScoreboardSync = (entries, spectatorCount) => {
            this.scoreboard.onSync(entries, spectatorCount);
        };
        this.network.onConnected = () => this._onConnected();
        this.network.onDisconnected = () => this._onDisconnected();
    }

    // ═══════════════════════════════════════════════════════
    // Helpers
    // ═══════════════════════════════════════════════════════

    /** Unscope: reset FOV, hide vignette, show crosshair + gun. */
    _unscope() {
        const fps = this._fps;
        if (!fps.isScoped) return;
        fps.isScoped = false;
        this.camera.fov = 75;
        this.camera.updateProjectionMatrix();
        if (fps.fpGunGroup) fps.fpGunGroup.visible = true;
        if (this.hud.scopeVignette) this.hud.scopeVignette.style.display = 'none';
        if (this.hud.crosshair) this.hud.crosshair.style.display = 'block';
    }

    _joinGame(team, weaponId, playerName) {
        // Sanitize locally — must match server-side sanitization in ServerGame.onJoinRequest
        playerName = String(playerName).trim().replace(/[^\w\s\-]/g, '').substring(0, 16).trim() || 'Player';

        this._fps.team = team;
        this._fps.weaponId = weaponId;
        this._fps.playerName = playerName;

        const def = WeaponDefs[weaponId];
        this._fps.moveSpeed = MOVE_SPEED * (def?.moveSpeedMult || 1.0);

        // Force ammo HUD refresh on next frame
        this.hud.resetCache();

        this.network.sendJoin(team, weaponId, playerName);
        console.log(`[Client] Joining ${team} with ${weaponId} as "${playerName}"`);
    }

    // ═══════════════════════════════════════════════════════
    // Lighting
    // ═══════════════════════════════════════════════════════

    _setupLighting() {
        this._ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
        this.scene.add(this._ambientLight);

        const sun = new THREE.DirectionalLight(0xfff5e0, 1.0);
        sun.position.set(50, 80, 30);
        sun.castShadow = true;
        sun.shadow.mapSize.set(1024, 1024);
        sun.shadow.camera.near = 0.5;
        sun.shadow.camera.far = 300;
        sun.shadow.camera.left = -150;
        sun.shadow.camera.right = 150;
        sun.shadow.camera.top = 150;
        sun.shadow.camera.bottom = -150;
        this.scene.add(sun);
        this._sun = sun;

        this._hemiLight = new THREE.HemisphereLight(0x87CEEB, 0x556B2F, 0.3);
        this.scene.add(this._hemiLight);
    }

    _applyTimeOfDay(tod) {
        const presets = [
            { // 0 = Day (defaults, no changes needed)
                clearColor: 0x87CEEB, fogColor: 0x87CEEB, fogNear: 100, fogFar: 300,
                sunColor: 0xfff5e0, sunIntensity: 1.0, sunPos: [50, 80, 30],
                ambientColor: 0xffffff, ambientIntensity: 0.5,
                hemiSky: 0x87CEEB, hemiGround: 0x556B2F, hemiIntensity: 0.3,
                shadows: true,
            },
            { // 1 = Dusk (golden hour — warm but not overly orange)
                clearColor: 0xC9A878, fogColor: 0xC9A878, fogNear: 90, fogFar: 270,
                sunColor: 0xFFAA60, sunIntensity: 0.85, sunPos: [70, 40, 50],
                ambientColor: 0xFFDDB0, ambientIntensity: 0.4,
                hemiSky: 0xC9A878, hemiGround: 0x665530, hemiIntensity: 0.28,
                shadows: true,
            },
            { // 2 = Storm (overcast rain)
                clearColor: 0x607272, fogColor: 0x607272,
                fogNear: 40, fogFar: 180,
                sunColor: 0x99aabb, sunIntensity: 0.45,
                sunPos: [50, 80, 30],
                ambientColor: 0x778888, ambientIntensity: 0.55,
                hemiSky: 0x6a7d7d, hemiGround: 0x4a5a4a, hemiIntensity: 0.3,
                shadows: true,
            },
        ];

        const p = presets[tod] || presets[0];
        const todNames = ['Day', 'Dusk', 'Storm'];
        console.log(`[Client] Applying time of day: ${todNames[tod] || 'Day'}`);

        this.renderer.setClearColor(p.clearColor);
        this.scene.fog.color.setHex(p.fogColor);
        this.scene.fog.near = p.fogNear;
        this.scene.fog.far = p.fogFar;

        this._sun.color.setHex(p.sunColor);
        this._sun.intensity = p.sunIntensity;
        this._sun.position.set(p.sunPos[0], p.sunPos[1], p.sunPos[2]);
        this._sun.castShadow = p.shadows;

        this._ambientLight.color.setHex(p.ambientColor);
        this._ambientLight.intensity = p.ambientIntensity;

        this._hemiLight.color.setHex(p.hemiSky);
        this._hemiLight.groundColor.setHex(p.hemiGround);
        this._hemiLight.intensity = p.hemiIntensity;
    }

    // ═══════════════════════════════════════════════════════
    // Network Callbacks
    // ═══════════════════════════════════════════════════════

    _onConnected() {
        console.log('[Client] Connected to server');
        this.joinScreen.showConnected();

        // Periodic ping measurement
        this._pingInterval = setInterval(() => {
            if (this.network.connected) {
                this.network._sendPing();
            }
        }, 3000);
    }

    _onDisconnected() {
        console.log('[Client] Disconnected');
        this.gameMode = 'connecting';
        const fps = this._fps;
        fps.myEntityId = -1;
        // Clean up FP gun
        if (fps.fpGunGroup) {
            this.camera.remove(fps.fpGunGroup);
            fps.fpGunGroup = null;
            fps.fpMuzzleFlash = null;
        }
        this._unscope();
        this.hud.hidePlayingHUD();
        if (this._pingInterval) clearInterval(this._pingInterval);
        this.joinScreen.showDisconnected();
    }

    _onWorldSeed(seed, flagLayout, entityCount, timeOfDay) {
        console.log('[Client] WorldSeed received: seed=', seed, 'entities=', entityCount, 'timeOfDay=', timeOfDay);
        this._timeOfDay = timeOfDay ?? 0;
        this._applyTimeOfDay(this._timeOfDay);

        // Prefill all AI soldiers into scoreboard
        for (let i = 0; i < TEAM_SIZE; i++) {
            this.scoreboard.data[`A-${i}`] = { kills: 0, deaths: 0, team: 'teamA', weapon: '' };
            this.scoreboard.data[`B-${i}`] = { kills: 0, deaths: 0, team: 'teamB', weapon: '' };
        }

        // Hide connection UI
        const blocker = document.getElementById('blocker');
        if (blocker) blocker.classList.add('hidden');

        // Build a real cannon-es world for ragdoll physics
        // Island static bodies (terrain heightfield + obstacles) auto-register via addBody
        this._ragdollWorld = new CANNON.World();
        this._ragdollWorld.gravity.set(0, -9.82, 0);
        this._ragdollWorld.broadphase = new CANNON.SAPBroadphase(this._ragdollWorld);
        this._ragdollWorld.allowSleep = true;

        const defaultMat = new CANNON.Material('default');
        const defaultContact = new CANNON.ContactMaterial(defaultMat, defaultMat, {
            friction: 0.4,
            restitution: 0.1,
        });
        this._ragdollWorld.addContactMaterial(defaultContact);
        this._ragdollWorld.defaultContactMaterial = defaultContact;

        const ragdollPhysics = {
            defaultMaterial: defaultMat,
            addBody: (b) => { this._ragdollWorld.addBody(b); },
        };
        const stubCover = { register() {} };
        this.island = new Island(this.scene, ragdollPhysics, stubCover, seed);

        // Build NavGrid for client-side collision prediction (async, non-blocking)
        this.island.buildNavGridAsync().then(({ navGrid }) => {
            this._navGrid = navGrid;
        });

        // Create flags
        this._setupFlags();

        // Init VFX
        this.tracerSystem = new TracerSystem(this.scene);
        this.impactVFX = new ImpactVFX(this.scene, (x, z) => this.island.getHeightAt(x, z));

        // Storm VFX (rain + lightning) — only when tod === 2
        this.stormVFX = null;
        if (this._timeOfDay === 2) {
            this.stormVFX = new StormVFX(
                this.scene, this.camera,
                { sun: this._sun, ambient: this._ambientLight, hemi: this._hemiLight },
                (x, z) => this.island.getHeightAt(x, z)
            );
        }

        // Wire ragdoll references to EntityRenderer and VehicleRenderer
        this.entityRenderer.ragdollWorld = this._ragdollWorld;
        this.vehicleRenderer.ragdollWorld = this._ragdollWorld;
        this.entityRenderer.impactVFX = this.impactVFX;
        this.entityRenderer.getHeightAt = (x, z) => this.island.getHeightAt(x, z);

        // Init Minimap
        this.minimap = new Minimap(this.island.width, this.island.depth);

        // Activate spectator mode (overhead / bird's-eye by default)
        this.gameMode = 'spectator';
        this._spectator.mode = 'overhead';
        this._spectator.overheadPos.set(0, 120, 0);
        this.spectatorHUD.show();
        this.spectatorHUD.setOverheadMode();

        // Start render loop
        this.clock.getDelta(); // consume initial delta
        requestAnimationFrame(this._boundAnimate);
    }

    _setupFlags() {
        const flagPositions = this.island.getFlagPositions();
        const names = ['A', 'B', 'C', 'D', 'E'];
        for (let i = 0; i < flagPositions.length; i++) {
            this.flags.push(new FlagPoint(
                this.scene, flagPositions[i], names[i], i,
                (x, z) => this.island.getHeightAt(x, z)
            ));
        }
    }

    _onPlayerSpawned(playerId, x, y, z, team, weaponId) {
        console.log(`[Client] Player spawned: entity ${playerId} at (${x}, ${y}, ${z})`);

        // Register local player in scoreboard (server doesn't send PLAYER_JOINED to self)
        const pName = this._fps.playerName;
        this.scoreboard.playerNames.set(playerId, pName);
        if (!this.scoreboard.data[pName]) {
            this.scoreboard.data[pName] = { kills: 0, deaths: 0, team, weapon: weaponId };
        } else {
            this.scoreboard.data[pName].team = team;
            this.scoreboard.data[pName].weapon = weaponId;
        }
        // Remove the AI placeholder this player replaced (e.g. A-3)
        const aiName = team === 'teamA' ? `A-${playerId}` : `B-${playerId - TEAM_SIZE}`;
        delete this.scoreboard.data[aiName];

        const fps = this._fps;
        fps.myEntityId = playerId;
        fps.predictedPos.set(x, y, z);
        fps.serverPos.set(x, y, z);
        fps.velX = 0;
        fps.velZ = 0;
        fps.isJumping = false;
        fps.jumpVelY = 0;
        fps.prevSpace = true; // suppress jump on spawn frame
        fps.localTick = 0;

        // Reset FP state
        fps.fpRecoilOffset = 0;
        fps.fpReloadTilt = 0;
        fps.isReloading = false;
        fps.isBolting = false;
        fps.isScoped = false;
        fps.prevRightMouse = false;
        fps.grenadeThrowTimer = 0;
        fps.prevGrenade = false;
        fps.deathLerp.active = false;
        fps.fpMuzzleFlashTimer = 0;

        // Apply weapon from server response (may differ on respawn)
        fps.weaponId = weaponId;
        const wdef = WeaponDefs[weaponId];
        fps.moveSpeed = MOVE_SPEED * (wdef?.moveSpeedMult || 1.0);

        // Build FP gun group
        if (fps.fpGunGroup) {
            this.camera.remove(fps.fpGunGroup);
        }
        const fpResult = _buildFPGunGroup(fps.weaponId, fps.team);
        fps.fpGunGroup = fpResult.group;
        fps.fpMuzzleFlash = fpResult.muzzleFlash;
        this.camera.add(fps.fpGunGroup);

        // Reset camera FOV
        this.camera.fov = 75;
        this.camera.updateProjectionMatrix();

        // Hide scope vignette
        if (this.hud.scopeVignette) this.hud.scopeVignette.style.display = 'none';

        // Switch to FPS mode
        this.gameMode = 'playing';
        this.spectatorHUD.hide();
        this.hud.crosshair.style.display = 'block';
        this.hud.healthHUD.style.display = 'block';
        this.hud.ammoHUD.style.display = 'block';
        this.deathScreen.hide();

        // Initialize health + ammo HUD content
        this.hud.resetCache();

        // Request pointer lock
        this.input.requestPointerLock();
    }

    _onInputAck(lastProcessedTick, x, y, z, ammo, grenades, dmgDirX, dmgDirZ, dmgTimer, vehicleId) {
        if (this.gameMode !== 'playing' && this.gameMode !== 'dead') return;

        const fps = this._fps;

        // Vehicle state transition
        const prevVehicle = fps.vehicleId;
        fps.vehicleId = vehicleId ?? 0xFF;
        const inVehicle = fps.vehicleId !== 0xFF;
        const wasInVehicle = prevVehicle !== 0xFF;

        if (inVehicle && !wasInVehicle) {
            // Entered vehicle — unscope (gun stays visible, matching single-player)
            this._unscope();
        } else if (!inVehicle && wasInVehicle) {
            // Exited vehicle — restore FP gun (skip if dead, death hides gun)
            if (this.gameMode !== 'dead') {
                if (fps.fpGunGroup) fps.fpGunGroup.visible = true;
                if (this.hud.crosshair) this.hud.crosshair.style.display = 'block';
            }
        }

        if (!inVehicle) {
            fps.serverPos.set(x, y, z);

            // Snap if error > 3m (teleport / respawn)
            const dx = x - fps.predictedPos.x;
            const dy = y - fps.predictedPos.y;
            const dz = z - fps.predictedPos.z;
            if (dx * dx + dy * dy + dz * dz > 9) {
                fps.predictedPos.set(x, y, z);
            }
        } else {
            // In vehicle: always use server position
            fps.serverPos.set(x, y, z);
            fps.predictedPos.set(x, y, z);
        }

        // Update ammo/grenade HUD — dirty-check to avoid DOM thrash
        this._serverAmmo = ammo;
        this._serverGrenades = grenades;

        // Damage direction indicator
        if (dmgTimer > 0) {
            this.hud.showDamageDirection(dmgDirX, dmgDirZ, dmgTimer, this._fps.yaw);
        }
    }

    _onSnapshot(tick, entities, flags, scores, vehicles) {
        const fps = this._fps;

        // Update entity renderer (interpolation + mesh management)
        this.entityRenderer.onSnapshot(tick, entities);

        // Update vehicle renderer
        this.vehicleRenderer.onSnapshot(vehicles);

        // Hide local player's mesh (FPS mode — camera is at predicted position)
        if (fps.myEntityId >= 0) {
            const entry = this.entityRenderer.entities.get(fps.myEntityId);
            if (entry) entry.mesh.visible = false;
        }

        // Detect death/respawn for local player
        if (this.gameMode === 'playing' || this.gameMode === 'dead') {
            const myEntity = entities.find(e => e.entityId === fps.myEntityId);
            if (myEntity) {
                const alive = !!(myEntity.state & 1);

                if (this.gameMode === 'playing' && !alive) {
                    // Just died — unscope and hide gun
                    this._unscope();
                    if (fps.fpGunGroup) fps.fpGunGroup.visible = false;
                    this.gameMode = 'dead';
                    this.hud._streakCount = 0;
                    this.hud._streakTimer = 0;
                    this.deathScreen.show(this._fps.weaponId);
                    this.hud.hidePlayingHUD();
                    document.exitPointerLock();
                } else if (this.gameMode === 'dead' && alive) {
                    // Respawned (fallback if PLAYER_SPAWNED was missed)
                    this.gameMode = 'playing';
                    this.deathScreen.hide();
                    this.hud.crosshair.style.display = 'block';
                    this.hud.healthHUD.style.display = 'block';
                    this.hud.ammoHUD.style.display = 'block';
                    if (fps.fpGunGroup) fps.fpGunGroup.visible = true;
                    fps.deathLerp.active = false;
                    this.hud.resetCache();
                    this.input.requestPointerLock();
                }

                // Read reload/bolt state bits
                fps.isReloading = !!(myEntity.state & 2);
                fps.isBolting = !!(myEntity.state & 4);

                // Update player health HUD
                this._serverHP = myEntity.hp;
            }
        }

        // Update flag states from server + detect contesting changes
        const inTeam = (this.gameMode === 'playing' || this.gameMode === 'dead') && this._fps.myEntityId >= 0;
        const myTeam = inTeam ? this._fps.team : null;
        const flagNames = ['A', 'B', 'C', 'D', 'E'];
        for (let i = 0; i < flags.length && i < this.flags.length; i++) {
            const sf = flags[i];
            const owner = sf.owner === 'neutral' ? 'neutral' : sf.owner;

            // Detect contesting state transitions (TAKING / LOSING banners)
            if (myTeam && this._prevFlagStates.length > 0) {
                const prev = this._prevFlagStates[i];
                let contesting = null;
                if (owner === myTeam && sf.capturingTeam && sf.capturingTeam !== myTeam
                    && sf.captureProgress > 0 && sf.captureProgress < 1) {
                    contesting = 'losing';
                } else if (owner !== myTeam && sf.capturingTeam === myTeam
                    && sf.captureProgress > 0 && sf.captureProgress < 1) {
                    contesting = 'capturing';
                }
                if (contesting !== prev.contesting) {
                    const teamColor = myTeam === 'teamA' ? '#4488ff' : '#ff4444';
                    if (contesting === 'losing') {
                        this.hud.showFlagBanner(`LOSING ${flagNames[i]}`, '#ffaa00');
                    } else if (contesting === 'capturing') {
                        this.hud.showFlagBanner(`TAKING ${flagNames[i]}`, teamColor);
                    }
                }
                prev.owner = owner;
                prev.contesting = contesting;
            }

            this.flags[i].owner = owner;
            this.flags[i].captureProgress = sf.captureProgress;
            this.flags[i].capturingTeam = sf.capturingTeam;
        }
        // Init prev flag states on first snapshot
        if (this._prevFlagStates.length === 0) {
            for (let i = 0; i < this.flags.length; i++) {
                this._prevFlagStates.push({ owner: this.flags[i].owner, contesting: null });
            }
        }

        // Update scores + flag count
        this.scores.teamA = scores.teamA;
        this.scores.teamB = scores.teamB;

        // Count flags per team
        let flagsA = 0, flagsB = 0;
        for (const f of this.flags) {
            if (f.owner === 'teamA') flagsA++;
            else if (f.owner === 'teamB') flagsB++;
        }
        this.hud.updateScores(scores.teamA, scores.teamB, flagsA, flagsB);
    }

    _onEvents(events) {
        for (const ev of events) {
            switch (ev.eventType) {
                case EventType.FIRED:
                    if (!this._suppressVFX) this._handleFiredEvent(ev);
                    break;

                case EventType.KILLED:
                    this.killFeed.addKill(
                        ev.killerName, ev.killerTeam,
                        ev.victimName, ev.victimTeam,
                        ev.headshot, ev.weaponId,
                        this.scoreboard.isCOM(ev.killerName),
                        this.scoreboard.isCOM(ev.victimName)
                    );
                    this.scoreboard.trackKill(ev.killerName, ev.killerTeam, ev.victimName, ev.victimTeam, ev.weaponId, ev.killerKills, ev.victimDeaths);
                    if (this.scoreboard._el && this.scoreboard._el.style.display !== 'none') {
                        this.scoreboard.updateWeaponData(this.entityRenderer, this.scoreboard.playerNames, TEAM_SIZE);
                        this.scoreboard.show(this._fps.playerName, this._fps.myEntityId);
                    }
                    // Kill banner + hit marker upgrade for local player
                    if (ev.killerName === this._fps.playerName && this._fps.myEntityId >= 0) {
                        this.hud.showHitMarker(ev.headshot ? 'headshot_kill' : 'kill');
                        this.hud.recordKill(ev.headshot);
                    }
                    // Kill hit marker upgrade for spectated COM
                    if (this.gameMode === 'spectator' && this._spectator.mode === 'follow'
                        && this._spectator.targetId !== null && ev.killerEntityId === this._spectator.targetId) {
                        this.hud.showHitMarker(ev.headshot ? 'headshot_kill' : 'kill');
                    }
                    // Death camera — lerp toward killer
                    if (ev.victimEntityId === this._fps.myEntityId && ev.killerEntityId !== 0xFFFF) {
                        this._startDeathLerp(ev.killerEntityId);
                    }
                    // Spectated COM killed — lerp toward killer
                    if (this.gameMode === 'spectator' && this._spectator.mode === 'follow'
                        && ev.victimEntityId === this._spectator.targetId
                        && ev.killerEntityId !== 0xFFFF) {
                        this._startDeathLerp(ev.killerEntityId);
                    }
                    // Record kill for ragdoll impulse matching
                    this.entityRenderer.recordKill(ev);
                    break;

                case EventType.FLAG_CAPTURED: {
                    const flagNames = ['A', 'B', 'C', 'D', 'E'];
                    const fname = flagNames[ev.flagIdx] || `Flag ${ev.flagIdx}`;
                    const inTeam2 = (this.gameMode === 'playing' || this.gameMode === 'dead') && this._fps.myEntityId >= 0;
                    const myTeam = inTeam2 ? this._fps.team : null;
                    if (myTeam) {
                        const teamColor = myTeam === 'teamA' ? '#4488ff' : '#ff4444';
                        if (ev.newOwner === myTeam) {
                            this.hud.showFlagBanner(`CAPTURED ${fname}`, teamColor);
                        } else {
                            this.hud.showFlagBanner(`LOST ${fname}`, '#ff4444');
                        }
                    }
                    break;
                }

                case EventType.GRENADE_EXPLODE:
                    if (!this._suppressVFX && this.impactVFX) {
                        this.impactVFX.spawn(
                            'explosion',
                            new THREE.Vector3(ev.x, ev.y, ev.z),
                            null
                        );
                    }
                    this.entityRenderer.recordGrenadeExplode(ev.x, ev.y, ev.z);
                    this.entityRenderer.applyGrenadeBlast(ev.x, ev.y, ev.z);
                    break;

                case EventType.VEHICLE_DESTROYED:
                    if (!this._suppressVFX && this.impactVFX) {
                        this.impactVFX.spawn(
                            'explosion',
                            new THREE.Vector3(ev.x, ev.y, ev.z),
                            null
                        );
                    }
                    this.vehicleRenderer.startCrashPhysics(ev.vehicleId, ev);
                    break;

                case EventType.GAME_OVER:
                    console.log(`[Event] Game over! Winner: ${ev.winner}`);
                    this._showGameOver(ev.winner, ev.scoreA, ev.scoreB);
                    break;

                case EventType.ROUND_COUNTDOWN:
                    this.gameOverScreen.updateCountdown(ev.secondsLeft);
                    break;

                case EventType.ROUND_RESTART:
                    console.log('[Event] Round restart');
                    this._resetForNewRound();
                    break;
            }
        }
    }

    _handleFiredEvent(ev) {
        _firedOrigin.set(ev.originX, ev.originY, ev.originZ);
        _firedDir.set(ev.dirX, ev.dirY, ev.dirZ).normalize();

        // Flash enemy on minimap
        if (this.minimap) {
            const entry = this.entityRenderer.entities.get(ev.shooterId);
            if (entry) {
                const myTeam = this._fps.myEntityId >= 0 ? this._fps.team : null;
                if (entry.team !== myTeam) {
                    this.minimap.onEnemyFired(`${entry.team}_${ev.shooterId}`);
                }
            }
        }

        // First-person muzzle flash + recoil for local player
        const fps = this._fps;
        if (ev.shooterId === fps.myEntityId && fps.fpMuzzleFlash) {
            fps.fpMuzzleFlash.visible = true;
            fps.fpMuzzleFlash.scale.setScalar(0.85 + Math.random() * 0.3);
            fps.fpMuzzleFlash.rotation.z = (Math.random() - 0.5) * (10 * Math.PI / 180);
            fps.fpMuzzleFlashTimer = 0.04;
            // Recoil kick
            fps.fpRecoilOffset = GunAnim.recoilOffset;
        }

        // Third-person muzzle flash
        this.entityRenderer.showMuzzleFlash(ev.shooterId);

        const TRACER_SKIP = 1.5;
        const tracerDist = ev.hitDist;

        // Spawn tracer (skip past shooter body)
        if (this.tracerSystem && tracerDist > TRACER_SKIP) {
            _hitPoint.copy(_firedOrigin).addScaledVector(_firedDir, TRACER_SKIP);
            this.tracerSystem.fire(_hitPoint, _firedDir, tracerDist - TRACER_SKIP);
        }

        // Hit marker for local player's hits or spectated COM's hits
        const isMyShot = ev.shooterId === this._fps.myEntityId;
        const isSpectatedShot = this.gameMode === 'spectator' && this._spectator.mode === 'follow'
            && this._spectator.targetId !== null && ev.shooterId === this._spectator.targetId;
        if ((isMyShot || isSpectatedShot) && (ev.surfaceType === SurfaceType.CHARACTER || ev.surfaceType === SurfaceType.VEHICLE)) {
            this.hud.showHitMarker('hit');
        }

        // Record CHARACTER hits for ragdoll impulse direction
        if (ev.surfaceType === SurfaceType.CHARACTER) {
            this.entityRenderer.recordCharacterHit(ev);
        }

        // Spawn impact VFX at hit point
        if (this.impactVFX && ev.surfaceType !== SurfaceType.MISS) {
            _hitPoint.copy(_firedOrigin).addScaledVector(_firedDir, tracerDist);

            // Client-side raycast to get real surface normal (same as single-player)
            _hitNormal.copy(_firedDir).negate(); // fallback
            if (this.island) {
                _normalRaycaster.set(_firedOrigin, _firedDir);
                _normalRaycaster.far = tracerDist + 1;
                const hits = _normalRaycaster.intersectObjects(this.island.collidables, true);
                if (hits.length > 0 && hits[0].face) {
                    _hitNormal.copy(hits[0].face.normal);
                    _hitNormal.transformDirection(hits[0].object.matrixWorld);
                }
            }

            switch (ev.surfaceType) {
                case SurfaceType.TERRAIN:
                    this.impactVFX.spawn('dirt', _hitPoint, _hitNormal);
                    break;
                case SurfaceType.WATER:
                    this.impactVFX.spawn('water', _hitPoint, _hitNormal);
                    break;
                case SurfaceType.CHARACTER:
                    this.impactVFX.spawn('blood', _hitPoint, _hitNormal);
                    break;
                case SurfaceType.VEHICLE:
                case SurfaceType.ROCK:
                    this.impactVFX.spawn('spark', _hitPoint, _hitNormal);
                    break;
            }
        }
    }

    _showGameOver(winner, scoreA, scoreB) {
        // ── Stop player input: release pointer lock, hide FPS HUD ──
        if (this.gameMode === 'playing' || this.gameMode === 'dead') {
            const fps = this._fps;
            this._unscope();
            if (fps.fpGunGroup) fps.fpGunGroup.visible = false;
            this.hud.hidePlayingHUD();
            this.deathScreen.hide();
            document.exitPointerLock();
            this.gameMode = 'spectator';
            fps.myEntityId = -1;
        }

        // Update weapon data before rendering scoreboard
        this.scoreboard.updateWeaponData(this.entityRenderer, this.scoreboard.playerNames, TEAM_SIZE);

        // Show game-over overlay
        this.gameOverScreen.show(winner, scoreA, scoreB);

        // Render team columns into the overlay
        this.scoreboard.renderGameOver();
    }

    /** Remove game-over overlay and reset client state for a new round. */
    _resetForNewRound() {
        // Remove game-over overlay
        this.gameOverScreen.remove();

        // Hide TAB scoreboard if open
        this.scoreboard.hide();

        // If playing, switch to spectator (server already removed player)
        if (this.gameMode === 'playing' || this.gameMode === 'dead') {
            const fps = this._fps;
            fps.myEntityId = -1;
            // Clean up FP gun
            if (fps.fpGunGroup) {
                this.camera.remove(fps.fpGunGroup);
                fps.fpGunGroup = null;
                fps.fpMuzzleFlash = null;
            }
            this._unscope();
            this.hud.hidePlayingHUD();
            this.deathScreen.hide();
            this.hud.resetCache();
            document.exitPointerLock();
        }

        this.gameMode = 'spectator';
        this._spectator.mode = 'overhead';
        this._spectator.overheadPos.set(0, 120, 0);
        this._spectator.initialized = false;
        this._spectator.lastScoped = false;
        this.spectatorHUD.show();
        this.spectatorHUD.setOverheadMode();
        this.hud.hidePlayingHUD();

        // Reset scoreboard stats
        this.scoreboard.resetStats();

        // Clear kill feed
        if (this.killFeed) {
            this.killFeed.entries.length = 0;
            this.killFeed.container.innerHTML = '';
        }

        // Reset kill streak / banner state (these live in hud now)
        this.hud._streakCount = 0;
        this.hud._streakTimer = 0;
        this.hud._killBannerTimer = 0;
        this.hud._flagBannerTimer = 0;
        this._prevFlagStates = [];

        console.log('[Client] Round reset — back to spectator');
    }

    _startDeathLerp(killerEntityId) {
        const fps = this._fps;
        const killerEntry = this.entityRenderer.entities.get(killerEntityId);
        if (!killerEntry || !killerEntry.mesh) return;

        const kp = killerEntry.mesh.position;

        // Use camera position (frozen at victim's head) instead of player position
        // so spectated COM deaths calculate the correct direction to killer
        const camPos = this.camera.position;
        const dx = kp.x - camPos.x;
        const dy = (kp.y + 1.6) - camPos.y;
        const dz = kp.z - camPos.z;
        const hDist = Math.sqrt(dx * dx + dz * dz);

        fps.deathLerp.active = true;
        // Start from current camera orientation (matches single-player)
        _euler.setFromQuaternion(this.camera.quaternion, 'YXZ');
        fps.deathLerp.yaw = _euler.y;
        fps.deathLerp.pitch = _euler.x;
        fps.deathLerp.targetYaw = Math.atan2(-dx, -dz);
        fps.deathLerp.targetPitch = Math.atan2(dy, hDist);
    }

    // ═══════════════════════════════════════════════════════
    // Game Loop
    // ═══════════════════════════════════════════════════════

    _animate() {
        requestAnimationFrame(this._boundAnimate);
        this.stats.begin();

        const dt = Math.min(this.clock.getDelta(), 0.1);

        // Island vegetation sway (2x speed during storm)
        if (this.island) {
            const swayTime = this._timeOfDay === 2
                ? this.clock.elapsedTime * 2
                : this.clock.elapsedTime;
            this.island.updateSway(swayTime);
        }

        // VFX
        if (this.tracerSystem) this.tracerSystem.update(dt);
        if (this.impactVFX) this.impactVFX.update(dt);
        if (this.stormVFX) this.stormVFX.update(dt, this.camera.position);

        // Step ragdoll physics (only meaningful when ragdoll bodies exist)
        if (this._ragdollWorld) {
            this._ragdollWorld.step(1 / 60, dt, 3);
        }

        // Entity interpolation + vehicle animation
        this.entityRenderer.update(dt, this._suppressVFX);

        // Clear VFX suppression on first visible frame (after entityRenderer
        // has used it to skip ragdoll/dropped-weapon effects)
        if (this._suppressVFX && !document.hidden) {
            this._suppressVFX = false;
        }
        this.vehicleRenderer.update(dt);

        // Position occupants on vehicle seats
        this.vehicleController.updateOccupants(this._fps, this.entityRenderer, this.vehicleRenderer);

        // Camera mode
        if (this.gameMode === 'playing') {
            this.fpsController.update(dt, this._fps, this.input, this.camera, this.network, this.island, this._navGrid, this.hud);
            if (this._fps.vehicleId !== 0xFF) this.vehicleController.updateCamera(this._fps, this.vehicleRenderer, this.camera);
        } else if (this.gameMode === 'dead') {
            // Death screen countdown + weapon select
            this.deathScreen.update(dt);

            // Camera position stays frozen at the moment of death.
            // Only the death lerp (below) rotates toward the killer.
        } else if (this.gameMode === 'spectator') {
            if (this._spectator.mode === 'follow') {
                this.spectatorController.updateFollow(dt, this._spectator, this.entityRenderer, this.camera, this.hud, this.spectatorHUD, this.scoreboard, this._fps);
            } else {
                this.spectatorController.updateOverhead(dt, this._spectator, this.input, this.camera);
            }
        }

        // Death lerp: smooth turn toward killer after death (runs unconditionally like single-player)
        const dl = this._fps.deathLerp;
        if (dl.active) {
            // Stop when player respawns
            if (this.gameMode === 'playing') {
                dl.active = false;
            // Stop when spectator freeze ends (target switches)
            } else if (this.gameMode === 'spectator' && this._spectator.deathFreezeTimer <= 0) {
                dl.active = false;
            } else {
                const t = Math.min(1, 6 * dt);
                let yawDiff = dl.targetYaw - dl.yaw;
                if (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
                if (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
                dl.yaw += yawDiff * t;
                dl.pitch += (dl.targetPitch - dl.pitch) * t;

                _euler.set(dl.pitch, dl.yaw, 0, 'YXZ');
                this.camera.quaternion.setFromEuler(_euler);
            }
        }

        // Update flag visuals (cloth animation, progress bar, billboard)
        for (const flag of this.flags) {
            flag.update([], [], dt, this.camera);
        }

        // Minimap
        if (this.minimap) {
            const teamA = this.entityRenderer.getTeamSoldiers('teamA');
            const teamB = this.entityRenderer.getTeamSoldiers('teamB');
            const fps = this._fps;
            // Determine minimap team perspective
            const inTeam = fps.myEntityId >= 0;
            const isOverhead = this.gameMode === 'spectator' && this._spectator.mode === 'overhead';
            let minimapTeam;
            if (inTeam) {
                minimapTeam = fps.team;
            } else if (!isOverhead && this._spectator.targetId !== null) {
                const tgt = this.entityRenderer.getEntityState(this._spectator.targetId);
                minimapTeam = tgt ? tgt.team : 'teamA';
            } else {
                minimapTeam = 'teamA'; // fallback (overhead uses showAll anyway)
            }
            this.minimap.update({
                playerPos: this.gameMode === 'playing' ? fps.predictedPos : null,
                playerYaw: fps.yaw,
                playerTeam: minimapTeam,
                showAll: isOverhead,
                flags: this.flags,
                teamASoldiers: teamA,
                teamBSoldiers: teamB,
                vehicles: this.vehicleRenderer.getVehicleData(),
                dt,
            });
        }

        // Vehicle HUD + prompt
        this.vehicleController.updateHUD(this._fps, this.vehicleRenderer, this.gameMode);

        // Player HUD (health + ammo, works in both playing and spectator follow)
        this._updatePlayerHUD(dt);

        // Reload indicator (spinning circle)
        this._updateReloadIndicator(dt);

        // Hit marker fade
        this.hud.updateHitMarker(dt);

        // Damage direction fade
        this.hud.updateDamageIndicator(dt);

        // Kill banner + flag banner timers
        this.hud.updateKillBannerTimer(dt);
        this.hud.updateFlagBannerTimer(dt);

        // Kill feed decay
        this.killFeed.update(dt);

        // Ping display (update every ~30 frames)
        if (this.network.connected) {
            this._pingFrameCount = (this._pingFrameCount || 0) + 1;
            if (this._pingFrameCount >= 30) {
                this._pingFrameCount = 0;
                const rtt = Math.round(this.network.rtt);
                this.hud.updatePing(rtt);
            }
        }

        // Render
        this.renderer.render(this.scene, this.camera);
        this.stats.end();
    }

    /**
     * Update health + ammo HUD (dirty-checked DOM writes).
     * Called every frame for both playing mode and spectator follow.
     */
    _updatePlayerHUD(dt) {
        const fps = this._fps;

        // ── Determine data source ──
        let hp, ammo, grenades, weaponId, isReloading, isBolting;

        if (this.gameMode === 'playing') {
            hp = this._serverHP ?? 100;
            ammo = this._serverAmmo ?? 30;
            grenades = this._serverGrenades ?? 2;
            weaponId = fps.weaponId;
            isReloading = fps.isReloading;
            isBolting = fps.isBolting;
        } else if (this.gameMode === 'spectator' && this._spectator.mode === 'follow') {
            const entry = this._spectator.targetId !== null
                ? this.entityRenderer.entities.get(this._spectator.targetId) : null;
            if (!entry || !entry.alive) {
                this.hud.ammoHUD.style.display = 'none';
                this.hud.healthHUD.style.display = 'none';
                return;
            }
            hp = entry.hp ?? 100;
            weaponId = entry.weaponId;
            isReloading = entry.isReloading;
            isBolting = entry.isBolting;
            ammo = entry.ammo ?? 0;
            grenades = entry.grenades ?? 0;
        } else {
            return;
        }

        this.hud.updatePlayerHUD(dt, { hp, ammo, grenades, weaponId, isReloading, isBolting });
    }

    /**
     * Update reload indicator (SVG circle progress).
     * Works for both playing mode and spectator follow.
     */
    _updateReloadIndicator(dt) {
        let isReloading = false;
        let isBolting = false;
        let weaponId = null;
        let isScoped = false;
        let showCrosshair = false;

        if (this.gameMode === 'playing' && this._fps.myEntityId >= 0) {
            weaponId = this._fps.weaponId;
            isReloading = this._fps.isReloading;
            isBolting = this._fps.isBolting;
            isScoped = this._fps.isScoped;
            showCrosshair = true;
        } else if (this.gameMode === 'spectator' && this._spectator.mode === 'follow') {
            const entry = this._spectator.targetId !== null
                ? this.entityRenderer.entities.get(this._spectator.targetId) : null;
            if (entry && entry.alive) {
                weaponId = entry.weaponId;
                isReloading = entry.isReloading;
                isBolting = entry.isBolting;
                isScoped = this._spectator.lastScoped;
                showCrosshair = true;
            }
        }

        this.hud.updateReloadIndicator(dt, { isReloading, isBolting, weaponId, isScoped, showCrosshair });
    }

    _leaveGame() {
        this.network.sendLeave();
        this.gameMode = 'spectator';
        const fps = this._fps;
        fps.myEntityId = -1;

        // Clean up FP gun
        if (fps.fpGunGroup) {
            this.camera.remove(fps.fpGunGroup);
            fps.fpGunGroup = null;
            fps.fpMuzzleFlash = null;
        }
        this._unscope();
        this.hud.hidePlayingHUD();
        this.deathScreen.hide();
        // Clear flag banner & stale flag states so spectator doesn't see team notifications
        this.hud._flagBannerTimer = 0;
        this._prevFlagStates = [];
        this.spectatorHUD.show();
        this.spectatorHUD.setFollowMode();
        this._spectator.initialized = false;
        this._spectator.lastScoped = false;
        this.hud.resetCache();
        document.exitPointerLock();
    }

    // ═══════════════════════════════════════════════════════
    // Key Handlers
    // ═══════════════════════════════════════════════════════

    _onGlobalKey(e) {
        if (this.gameMode === 'connecting') return;

        // Escape — leave game or close join panel
        if (e.code === 'Escape') {
            const joinPanel = document.getElementById('join-panel');
            if (joinPanel) {
                if (this.joinScreen.joinStep === 2) {
                    // Go back to step 1 (name + team)
                    this.joinScreen.goBackToStep1();
                    return;
                }
                this.joinScreen.removeJoinPanel();
                return;
            }
            if (this.gameMode === 'playing' || this.gameMode === 'dead') {
                this._leaveGame();
                return;
            }
        }

        // Dead state — weapon selection + respawn
        if (this.gameMode === 'dead' && this.deathScreen.canRespawn) {
            const weaponKeys = { Digit1: 'AR15', Digit2: 'SMG', Digit3: 'LMG', Digit4: 'BOLT' };
            if (weaponKeys[e.code]) {
                this.deathScreen.selectedWeapon = weaponKeys[e.code];
                this.deathScreen.highlightWeapon(this.deathScreen.selectedWeapon);
                return;
            }
            if (e.code === 'Space') {
                const weaponId = this.deathScreen.selectedWeapon || 'AR15';
                this._fps.weaponId = weaponId;
                const def = WeaponDefs[weaponId];
                this._fps.moveSpeed = MOVE_SPEED * (def?.moveSpeedMult || 1.0);
                this.network.sendRespawn(weaponId);
                return;
            }
        }

        if (this.gameMode === 'spectator') {
            switch (e.code) {
                case 'KeyQ':
                    this.spectatorController.nextTarget(this._spectator, this.entityRenderer, this.hud);
                    break;
                case 'KeyV':
                    this.spectatorController.toggleView(this._spectator, this.camera, this.hud, this.spectatorHUD);
                    break;
                case 'KeyJ':
                case 'Enter':
                    this.joinScreen.createJoinUI((team, wpn, name) => this._joinGame(team, wpn, name), () => {});
                    break;
            }
        }
    }
}
