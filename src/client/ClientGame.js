import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { Island } from '../world/Island.js';
import { FlagPoint } from '../world/FlagPoint.js';
import { TracerSystem } from '../vfx/TracerSystem.js';
import { ImpactVFX } from '../vfx/ImpactVFX.js';
import { Minimap } from '../ui/Minimap.js';
import { KillFeed } from '../ui/KillFeed.js';
import { SpectatorHUD } from '../ui/SpectatorHUD.js';
import { InputManager } from '../core/InputManager.js';
import { EventBus } from '../core/EventBus.js';
import { NetworkClient } from './NetworkClient.js';
import { EntityRenderer, buildGunMesh, createMuzzleFlashMesh } from './EntityRenderer.js';
import { VehicleRenderer, HELI_PILOT_OFFSET, HELI_PASSENGER_SLOTS } from './VehicleRenderer.js';
import { EventType, SurfaceType, KeyBit } from '../shared/protocol.js';
import { WeaponDefs, GunAnim } from '../entities/WeaponDefs.js';
import { MAP_WIDTH, MAP_DEPTH, GRAVITY, MOVE_SPEED, ACCEL, DECEL, TEAM_SIZE } from '../shared/constants.js';
import Stats from 'three/addons/libs/stats.module.js';

const _euler = new THREE.Euler(0, 0, 0, 'YXZ');

// Reusable vectors for FPS prediction
const _pForward = new THREE.Vector3();
const _pRight   = new THREE.Vector3();
const _pYawQuat = new THREE.Quaternion();
const _pMoveDir = new THREE.Vector3();
const _pYAxis   = new THREE.Vector3(0, 1, 0);

// Reusable objects for vehicle occupant positioning
const _seatQuat = new THREE.Quaternion();
const _aimDirVec = new THREE.Vector3();
const _invQuat = new THREE.Quaternion();

// Reusable vectors for VFX
const _firedOrigin = new THREE.Vector3();
const _firedDir    = new THREE.Vector3();
const _hitPoint    = new THREE.Vector3();
const _hitNormal   = new THREE.Vector3();
const _headLocal   = new THREE.Vector3();
const _normalRaycaster = new THREE.Raycaster();

const PLAYER_JUMP_SPEED = 4;

/** Escape HTML special characters to prevent XSS when inserting into innerHTML. */
function escapeHTML(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}


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

        // ── UI ──
        this.minimap = null;
        this.killFeed = new KillFeed();
        this.spectatorHUD = new SpectatorHUD();

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

        // ── Scoreboard (Tab key) ──
        this._scoreboard = {}; // playerName → { kills, deaths, team, weapon }
        this._playerNames = new Map(); // entityId → playerName
        this._spectatorCount = 0;
        this._playerPings = {}; // playerName → ping ms
        this._createScoreboard();

        // ── HUD ──
        this._createScoreHUD();
        this._createCrosshair();
        this._createScopeVignette();
        this._createPlayerHUD();
        this._createVehicleHUD();
        this._createDamageIndicator();
        this._createPingDisplay();
        this._createKillBanner();
        this._createFlagBanner();

        // Kill streak state
        this._streakCount = 0;
        this._streakTimer = 0;
        // Kill banner timer
        this._killBannerTimer = 0;
        this._killBannerFadeOut = false;
        // Flag banner timer
        this._flagBannerTimer = 0;
        this._flagBannerFadeOut = false;
        // Previous flag states for detecting changes
        this._prevFlagStates = [];
        this._createConnectionUI();

        // ── Key handlers ──
        document.addEventListener('keydown', (e) => this._onGlobalKey(e));
        document.addEventListener('keydown', (e) => {
            if (e.code === 'Tab') { e.preventDefault(); this._showScoreboard(); }
        });
        document.addEventListener('keyup', (e) => {
            if (e.code === 'Tab') { e.preventDefault(); this._hideScoreboard(); }
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
        this.network.onWorldSeed = (seed, flagLayout, entityCount) => {
            this._onWorldSeed(seed, flagLayout, entityCount);
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
            this._playerNames.set(playerId, playerName);
            if (!this._scoreboard[playerName]) {
                this._scoreboard[playerName] = { kills: 0, deaths: 0, team, weapon: '' };
            }
            // Remove the AI placeholder this player replaced
            const aiName = team === 'teamA' ? `A-${playerId}` : `B-${playerId - TEAM_SIZE}`;
            delete this._scoreboard[aiName];
        };
        this.network.onPlayerLeft = (playerId) => {
            console.log(`[Client] Player entity ${playerId} left the game`);
        };
        this.network.onJoinRejected = (reason) => {
            console.log(`[Client] Join rejected: ${reason}`);
            this._createJoinUI(reason);
        };
        this.network.onScoreboardSync = (entries, spectatorCount) => {
            this._onScoreboardSync(entries, spectatorCount);
        };
        this.network.onConnected = () => this._onConnected();
        this.network.onDisconnected = () => this._onDisconnected();
    }

    // ═══════════════════════════════════════════════════════
    // Connection UI
    // ═══════════════════════════════════════════════════════

    _createConnectionUI() {
        const blocker = document.getElementById('blocker');
        if (!blocker) return;
        this._blocker = blocker;

        blocker.innerHTML = `
            <h1>Island Conquest</h1>
            <p style="margin-bottom:12px">LAN Multiplayer</p>
            <div style="display:flex;gap:8px;align-items:center">
                <input id="server-url" type="text" value="ws://${location.hostname || 'localhost'}:${location.port || '8088'}"
                    style="padding:8px 12px;font-size:16px;border:none;border-radius:4px;width:280px;
                    background:rgba(255,255,255,0.9);color:#333;outline:none"
                    placeholder="ws://192.168.1.x:8088" />
                <button id="connect-btn"
                    style="padding:8px 20px;font-size:16px;border:none;border-radius:4px;
                    background:#4488ff;color:#fff;cursor:pointer;font-weight:bold">
                    Connect
                </button>
            </div>
            <p id="conn-status" style="margin-top:8px;font-size:14px;color:#aaa"></p>
        `;

        const input = document.getElementById('server-url');
        const btn = document.getElementById('connect-btn');

        const doConnect = () => {
            const url = input.value.trim();
            if (!url) return;
            document.getElementById('conn-status').textContent = 'Connecting...';
            btn.disabled = true;
            this.network.connect(url);
        };

        btn.addEventListener('click', doConnect);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') doConnect();
        });
    }

    _createScoreHUD() {
        const el = document.createElement('div');
        el.id = 'net-score';
        el.style.cssText = `position:fixed;top:15px;left:50%;transform:translateX(-50%);
            color:white;font-family:Consolas,monospace;font-size:18px;
            background:rgba(0,0,0,0.5);padding:8px 24px;border-radius:6px;
            pointer-events:none;z-index:100;text-align:center;`;
        el.innerHTML = `
            <span style="color:#4488ff;font-weight:bold"><span id="score-a">0</span></span>
            <span style="color:#aaa;font-size:14px;margin:0 6px">
                Team A [<span id="flag-count-a">0</span>] &mdash; [<span id="flag-count-b">0</span>] Team B
            </span>
            <span style="color:#ff4444;font-weight:bold"><span id="score-b">0</span></span>`;
        document.body.appendChild(el);
        this._scoreA = document.getElementById('score-a');
        this._scoreB = document.getElementById('score-b');
        this._flagCountA = document.getElementById('flag-count-a');
        this._flagCountB = document.getElementById('flag-count-b');
    }

    _createCrosshair() {
        const el = document.createElement('div');
        el.id = 'crosshair';
        el.style.cssText = `position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
            width:30px;height:30px;pointer-events:none;z-index:100;display:none;`;
        el.innerHTML = `
            <svg width="30" height="30" viewBox="0 0 30 30">
                <line x1="15" y1="3" x2="15" y2="12" stroke="white" stroke-width="2" opacity="0.8"/>
                <line x1="15" y1="18" x2="15" y2="27" stroke="white" stroke-width="2" opacity="0.8"/>
                <line x1="3" y1="15" x2="12" y2="15" stroke="white" stroke-width="2" opacity="0.8"/>
                <line x1="18" y1="15" x2="27" y2="15" stroke="white" stroke-width="2" opacity="0.8"/>
            </svg>`;
        document.body.appendChild(el);
        this._crosshair = el;

        // Hit marker (X shape, separate from crosshair)
        const hm = document.createElement('div');
        hm.id = 'hit-marker';
        hm.style.cssText = `position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(45deg);
            width:30px;height:30px;pointer-events:none;z-index:101;display:none;`;
        hm.innerHTML = `<svg width="30" height="30" viewBox="0 0 20 20">
            <line x1="10" y1="2" x2="10" y2="7" stroke="white" stroke-width="1.5"/>
            <line x1="10" y1="13" x2="10" y2="18" stroke="white" stroke-width="1.5"/>
            <line x1="2" y1="10" x2="7" y2="10" stroke="white" stroke-width="1.5"/>
            <line x1="13" y1="10" x2="18" y2="10" stroke="white" stroke-width="1.5"/></svg>`;
        document.body.appendChild(hm);
        this._hitMarker = hm;
        this._hitMarkerLines = hm.querySelectorAll('line');
        this._hitMarkerScale = 1;
        this._hitMarkerDuration = 0.15;
        this._hitMarkerTimer = 0;
    }

    _createScopeVignette() {
        const el = document.createElement('div');
        el.id = 'scope-vignette';
        el.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;
            pointer-events:none;z-index:99;display:none;
            background:radial-gradient(circle, transparent 30%, rgba(0,0,0,0.9) 70%);`;
        el.innerHTML = `
            <div style="position:absolute;top:50%;left:0;width:100%;height:1px;background:rgba(255,255,255,0.5);"></div>
            <div style="position:absolute;top:0;left:50%;width:1px;height:100%;background:rgba(255,255,255,0.5);"></div>
            <div style="position:absolute;top:50%;left:50%;width:6px;height:6px;transform:translate(-50%,-50%);
                border:1px solid rgba(255,255,255,0.6);border-radius:50%;"></div>`;
        document.body.appendChild(el);
        this._scopeVignette = el;
    }

    _createPlayerHUD() {
        // ── Health HUD (bottom-left) ──
        const health = document.createElement('div');
        health.id = 'health-hud';
        health.style.cssText = `position:fixed;bottom:30px;left:30px;color:white;
            font-family:Consolas,monospace;background:rgba(0,0,0,0.5);
            padding:12px 18px;border-radius:6px;pointer-events:none;z-index:100;
            min-width:150px;display:none;`;
        document.body.appendChild(health);
        this._healthHUD = health;

        // ── Ammo HUD (bottom-right) ──
        const ammo = document.createElement('div');
        ammo.id = 'ammo-hud';
        ammo.style.cssText = `position:fixed;bottom:30px;right:30px;color:white;
            font-family:Consolas,monospace;font-size:16px;background:rgba(0,0,0,0.5);
            padding:12px 18px;border-radius:6px;pointer-events:none;z-index:100;
            min-width:120px;display:none;`;
        document.body.appendChild(ammo);
        this._ammoHUD = ammo;

        // ── Reload Indicator (center, SVG circle) ──
        const ri = document.createElement('div');
        ri.id = 'reload-indicator';
        ri.style.cssText = `position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
            width:40px;height:40px;pointer-events:none;z-index:100;display:none;`;
        ri.innerHTML = `<svg width="40" height="40" viewBox="0 0 40 40" style="transform:rotate(-90deg)">
            <circle cx="20" cy="20" r="16" fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="3"/>
            <circle id="reload-arc" cx="20" cy="20" r="16" fill="none" stroke="white" stroke-width="3"
                stroke-dasharray="100.53" stroke-dashoffset="100.53" stroke-linecap="round" opacity="0.85"/>
        </svg>`;
        document.body.appendChild(ri);
        this._reloadIndicator = ri;
        this._reloadArc = null; // lazy-cached

        // Dirty-check caches
        this._lastAmmo = undefined;
        this._lastHP = undefined;
        this._lastWeaponId = undefined;
        this._lastReloading = undefined;
        this._lastBolting = undefined;
        this._lastGrenades = undefined;

        // Reload progress tracking (local timer since server only sends state bits)
        this._reloadTrack = {
            wasReloading: false,
            wasBolting: false,
            elapsed: 0,
        };
    }

    _createVehicleHUD() {
        const el = document.createElement('div');
        el.id = 'vehicle-hud';
        el.style.cssText = `position:fixed;bottom:80px;left:50%;transform:translateX(-50%);
            color:white;font-family:Consolas,monospace;background:rgba(0,0,0,0.5);
            padding:10px 20px;border-radius:6px;pointer-events:none;z-index:100;
            text-align:center;display:none;`;
        el.innerHTML = `
            <div id="vhud-title" style="font-size:14px;font-weight:bold;margin-bottom:4px"></div>
            <div style="width:200px;height:8px;background:#333;border-radius:4px;margin:4px auto;">
                <div id="vhud-hp-bar" style="height:100%;border-radius:4px;"></div>
            </div>
            <div id="vhud-controls" style="font-size:11px;color:#aaa;margin-top:4px"></div>`;
        document.body.appendChild(el);
        this._vehicleHUD = el;
        this._vhudTitle = document.getElementById('vhud-title');
        this._vhudHpBar = document.getElementById('vhud-hp-bar');
        this._vhudControls = document.getElementById('vhud-controls');
        this._lastVehicleTitle = null;
        this._lastVehicleHpPct = -1;

        // "Press E" prompt
        const prompt = document.createElement('div');
        prompt.id = 'vehicle-prompt';
        prompt.style.cssText = `position:fixed;bottom:100px;left:50%;transform:translateX(-50%);
            font-family:Consolas,monospace;font-size:14px;
            color:#fff;text-shadow:1px 1px 3px rgba(0,0,0,0.7);z-index:100;
            display:none;pointer-events:none;
            background:rgba(0,0,0,0.4);padding:6px 14px;border-radius:6px;`;
        prompt.textContent = 'Press E to board helicopter';
        document.body.appendChild(prompt);
        this._vehiclePrompt = prompt;
    }

    _createDamageIndicator() {
        const el = document.createElement('div');
        el.id = 'damage-indicator';
        el.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;
            pointer-events:none;z-index:99;`;
        document.body.appendChild(el);
        this._dmgIndicator = el;
        this._dmgIndicatorTimer = 0;
    }

    _showDamageDirection(dirX, dirZ, timer) {
        if (!this._dmgIndicator) return;
        const attackAngle = Math.atan2(dirX, -dirZ);
        const relAngle = attackAngle - this._fps.yaw;
        const gradAngle = (-relAngle * 180 / Math.PI + 90);
        const opacity = Math.min(1, timer) * 0.6;

        this._dmgIndicator.style.background = `linear-gradient(${gradAngle}deg,
            rgba(255,0,0,${opacity}) 0%, transparent 30%, transparent 100%)`;
        this._dmgIndicator.style.opacity = '1';
        this._dmgIndicatorTimer = timer;
    }

    _updateDamageIndicator(dt) {
        if (this._dmgIndicatorTimer > 0) {
            this._dmgIndicatorTimer -= dt;
            if (this._dmgIndicatorTimer <= 0) {
                this._dmgIndicator.style.background = 'none';
            }
        }
    }

    _createPingDisplay() {
        const el = document.createElement('div');
        el.id = 'ping-display';
        el.style.cssText = `position:fixed;top:10px;right:10px;
            font-family:Consolas,monospace;font-size:12px;
            color:rgba(255,255,255,0.5);z-index:100;pointer-events:none;`;
        el.textContent = 'PING: --';
        document.body.appendChild(el);
        this._pingDisplay = el;
    }

    _createKillBanner() {
        const el = document.createElement('div');
        el.id = 'kill-banner';
        el.style.cssText = `position:fixed;top:calc(50% + 60px);left:50%;transform:translateX(-50%);
            pointer-events:none;z-index:102;display:none;
            font-family:Arial,sans-serif;font-size:18px;font-weight:bold;
            text-shadow:0 0 6px rgba(0,0,0,0.8);letter-spacing:2px;
            transition:opacity 0.15s ease-out, transform 0.15s ease-out;`;
        const span = document.createElement('span');
        el.appendChild(span);
        document.body.appendChild(el);
        this._killBannerEl = el;
        this._killBannerText = span;
    }

    _createFlagBanner() {
        const el = document.createElement('div');
        el.id = 'flag-banner';
        el.style.cssText = `position:fixed;top:25%;left:50%;transform:translateX(-50%);
            pointer-events:none;z-index:102;display:none;
            font-family:Consolas,monospace;font-size:20px;font-weight:bold;
            letter-spacing:2px;background:rgba(0,0,0,0.5);padding:8px 24px;border-radius:6px;
            transition:opacity 0.15s ease-out, transform 0.15s ease-out;`;
        const span = document.createElement('span');
        el.appendChild(span);
        document.body.appendChild(el);
        this._flagBannerEl = el;
        this._flagBannerTextEl = span;
    }

    _recordKill(isHeadshot) {
        this._streakCount++;
        this._streakTimer = 4;

        let text, color, isStreak;
        if (this._streakCount >= 2) {
            const labels = ['', '', 'DOUBLE KILL', 'TRIPLE KILL', 'MULTI KILL', 'RAMPAGE'];
            text = this._streakCount >= labels.length
                ? 'RAMPAGE' : labels[this._streakCount];
            color = '#ffd700';
            isStreak = true;
        } else {
            text = isHeadshot ? 'HEADSHOT' : 'ELIMINATED';
            color = isHeadshot ? '#ffd700' : '#ffffff';
            isStreak = false;
        }

        this._killBannerText.textContent = text;
        this._killBannerText.style.color = color;
        this._killBannerTimer = isStreak ? 2 : 1.5;
        this._killBannerFadeOut = false;

        if (isStreak) {
            this._killBannerEl.style.transition = 'transform 0.2s cubic-bezier(0.34,1.56,0.64,1), opacity 0.15s ease-out';
            this._killBannerEl.style.fontSize = '28px';
            this._killBannerEl.style.display = 'block';
            this._killBannerEl.style.opacity = '1';
            this._killBannerEl.style.transform = 'translateX(-50%) scale(0.5)';
            this._killBannerEl.offsetHeight; // reflow
            this._killBannerEl.style.transform = 'translateX(-50%) scale(1)';
        } else {
            this._killBannerEl.style.transition = 'opacity 0.15s ease-out, transform 0.15s ease-out';
            this._killBannerEl.style.fontSize = '18px';
            this._killBannerEl.style.display = 'block';
            this._killBannerEl.style.opacity = '0';
            this._killBannerEl.style.transform = 'translateX(-50%) translateY(8px)';
            this._killBannerEl.offsetHeight; // reflow
            this._killBannerEl.style.opacity = '1';
            this._killBannerEl.style.transform = 'translateX(-50%) translateY(0)';
        }
    }

    _showFlagBanner(text, color) {
        this._flagBannerTextEl.textContent = text;
        this._flagBannerTextEl.style.color = color;
        this._flagBannerTimer = 2.0;
        this._flagBannerFadeOut = false;

        this._flagBannerEl.style.transition = 'opacity 0.15s ease-out, transform 0.15s ease-out';
        this._flagBannerEl.style.display = 'block';
        this._flagBannerEl.style.opacity = '0';
        this._flagBannerEl.style.transform = 'translateX(-50%) translateY(-8px)';
        this._flagBannerEl.offsetHeight; // reflow
        this._flagBannerEl.style.opacity = '1';
        this._flagBannerEl.style.transform = 'translateX(-50%) translateY(0)';
    }

    _updateKillBannerTimer(dt) {
        // Streak window countdown
        if (this._streakTimer > 0) {
            this._streakTimer -= dt;
            if (this._streakTimer <= 0) {
                this._streakCount = 0;
            }
        }
        if (this._killBannerTimer <= 0) return;
        this._killBannerTimer -= dt;
        if (this._killBannerTimer <= 0.3 && !this._killBannerFadeOut) {
            this._killBannerFadeOut = true;
            this._killBannerEl.style.opacity = '0';
            this._killBannerEl.style.transform = 'translateX(-50%) translateY(-8px)';
        }
        if (this._killBannerTimer <= 0) {
            this._killBannerEl.style.display = 'none';
            this._killBannerTimer = 0;
        }
    }

    _updateFlagBannerTimer(dt) {
        if (this._flagBannerTimer <= 0) return;
        this._flagBannerTimer -= dt;
        if (this._flagBannerTimer <= 0.3 && !this._flagBannerFadeOut) {
            this._flagBannerFadeOut = true;
            this._flagBannerEl.style.opacity = '0';
            this._flagBannerEl.style.transform = 'translateX(-50%) translateY(-8px)';
        }
        if (this._flagBannerTimer <= 0) {
            this._flagBannerEl.style.display = 'none';
            this._flagBannerTimer = 0;
        }
    }

    _createScoreboard() {
        const el = document.createElement('div');
        el.id = 'scoreboard';
        el.style.cssText = `position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
            background:rgba(0,0,0,0.8);border-radius:10px;padding:20px 28px;
            display:none;flex-direction:column;
            pointer-events:none;z-index:150;font-family:Consolas,monospace;
            min-width:600px;backdrop-filter:blur(4px);border:1px solid rgba(255,255,255,0.1);`;
        el.innerHTML = `
            <div style="display:flex;align-items:flex-start;gap:32px;">
                <div id="sb-teamA" style="flex:1;min-width:280px;"></div>
                <div style="width:1px;background:rgba(255,255,255,0.15);align-self:stretch;"></div>
                <div id="sb-teamB" style="flex:1;min-width:280px;"></div>
            </div>
            <div id="sb-spectators" style="margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.1);display:none;"></div>`;
        document.body.appendChild(el);
        this._scoreboardEl = el;
    }

    /** Returns true if the scoreboard name belongs to a COM (not a real player). */
    _isCOM(name) {
        for (const pn of this._playerNames.values()) {
            if (pn === name) return false;
        }
        return true;
    }

    _showScoreboard() {
        if (!this._scoreboardEl) return;

        this._updateScoreboardData();

        // Split into teams and sort
        const teamAList = [];
        const teamBList = [];
        for (const [name, stat] of Object.entries(this._scoreboard)) {
            const entry = { name, ...stat, ping: this._playerPings[name] ?? 0 };
            if (stat.team === 'teamA') teamAList.push(entry);
            else teamBList.push(entry);
        }
        teamAList.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
        teamBList.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);

        const localName = this._fps.playerName;

        const pingColor = (ms) => ms < 30 ? '#6f6' : ms < 80 ? '#ff4' : '#f66';

        const renderTeam = (entries, teamColor, teamLabel) => {
            let totalK = 0, totalD = 0;
            for (const e of entries) { totalK += e.kills; totalD += e.deaths; }
            let html = `<div style="color:${teamColor};font-weight:bold;font-size:16px;margin-bottom:8px;text-align:center;">${teamLabel}</div>`;
            html += `<div style="display:flex;color:#888;font-size:11px;padding:2px 6px;border-bottom:1px solid rgba(255,255,255,0.1);margin-bottom:2px;">
                <span style="flex:1">Name</span><span style="width:30px;text-align:center">K</span>
                <span style="width:30px;text-align:center">D</span><span style="width:50px;text-align:center">Wpn</span><span style="width:48px;text-align:right">Ping</span></div>`;
            for (const e of entries) {
                const isPlayer = e.name === localName && this._fps.myEntityId >= 0;
                const com = this._isCOM(e.name);
                const displayName = com ? `${escapeHTML(e.name)}<span style="color:#666;font-weight:normal">(AI)</span>` : escapeHTML(e.name);
                const bg = isPlayer ? 'rgba(255,255,255,0.1)' : 'transparent';
                const nameColor = isPlayer ? '#fff' : 'rgba(255,255,255,0.75)';
                const wpn = e.weapon || '-';
                const pingStr = com ? '<span style="color:#555">-</span>' : `<span style="color:${pingColor(e.ping)}">${e.ping}ms</span>`;
                html += `<div style="display:flex;font-size:12px;padding:2px 6px;background:${bg};border-radius:2px;">
                    <span style="flex:1;color:${nameColor};font-weight:${isPlayer ? 'bold' : 'normal'}">${displayName}</span>
                    <span style="width:30px;text-align:center;color:#ccc">${e.kills}</span>
                    <span style="width:30px;text-align:center;color:#ccc">${e.deaths}</span>
                    <span style="width:50px;text-align:center;color:#888;font-size:11px">${escapeHTML(wpn)}</span>
                    <span style="width:48px;text-align:right;font-size:11px">${pingStr}</span></div>`;
            }
            html += `<div style="display:flex;font-size:12px;padding:4px 6px;margin-top:4px;border-top:1px solid rgba(255,255,255,0.1);color:#aaa;">
                <span style="flex:1;font-weight:bold">Total</span>
                <span style="width:30px;text-align:center">${totalK}</span>
                <span style="width:30px;text-align:center">${totalD}</span>
                <span style="width:50px"></span><span style="width:48px"></span></div>`;
            return html;
        };

        document.getElementById('sb-teamA').innerHTML = renderTeam(teamAList, '#4488ff', 'TEAM A');
        document.getElementById('sb-teamB').innerHTML = renderTeam(teamBList, '#ff4444', 'TEAM B');

        // Spectators section
        const specEl = document.getElementById('sb-spectators');
        if (specEl) {
            if (this._spectatorCount > 0) {
                specEl.innerHTML = `<span style="color:#888;font-size:11px;">Spectators: ${this._spectatorCount}</span>`;
                specEl.style.display = 'block';
            } else {
                specEl.style.display = 'none';
            }
        }

        this._scoreboardEl.style.display = 'flex';
    }

    _hideScoreboard() {
        if (this._scoreboardEl) this._scoreboardEl.style.display = 'none';
    }

    _trackKill(killerName, killerTeam, victimName, victimTeam, weapon, killerKills, victimDeaths) {
        // Track killer — use authoritative server value
        if (!this._scoreboard[killerName]) {
            this._scoreboard[killerName] = { kills: 0, deaths: 0, team: killerTeam, weapon: '' };
        }
        if (killerKills !== undefined) {
            this._scoreboard[killerName].kills = killerKills;
        } else {
            this._scoreboard[killerName].kills++;
        }
        this._scoreboard[killerName].team = killerTeam;
        if (weapon) this._scoreboard[killerName].weapon = weapon;

        // Track victim — use authoritative server value
        if (!this._scoreboard[victimName]) {
            this._scoreboard[victimName] = { kills: 0, deaths: 0, team: victimTeam, weapon: '' };
        }
        if (victimDeaths !== undefined) {
            this._scoreboard[victimName].deaths = victimDeaths;
        } else {
            this._scoreboard[victimName].deaths++;
        }
        this._scoreboard[victimName].team = victimTeam;
    }

    _onScoreboardSync(entries, spectatorCount) {
        for (const e of entries) {
            this._scoreboard[e.name] = {
                kills: e.kills,
                deaths: e.deaths,
                team: e.team,
                weapon: e.weaponId,
            };
            if (e.ping !== undefined) {
                this._playerPings[e.name] = e.ping;
            }
        }
        if (spectatorCount !== undefined) {
            this._spectatorCount = spectatorCount;
        }
    }

    _createJoinUI(errorMsg = '') {
        // Remove existing join panel if any
        const existing = document.getElementById('join-panel');
        if (existing) existing.remove();
        if (this._joinKeyHandler) {
            document.removeEventListener('keydown', this._joinKeyHandler);
            this._joinKeyHandler = null;
        }

        this._joinStep = 1;

        const panel = document.createElement('div');
        panel.id = 'join-panel';
        panel.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;
            background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;
            flex-direction:column;z-index:200;font-family:Arial,sans-serif;`;

        panel.innerHTML = `
            <div id="join-step1" style="display:flex;flex-direction:column;align-items:center;">
                <h2 style="color:#fff;font-size:36px;margin-bottom:24px">JOIN GAME</h2>
                <div style="display:flex;gap:8px;align-items:center;margin-bottom:20px">
                    <label style="color:#aaa;font-size:14px">Name:</label>
                    <input id="player-name" type="text" value="Player" maxlength="16"
                        style="padding:6px 10px;font-size:14px;border:none;border-radius:4px;width:160px;
                        background:rgba(255,255,255,0.9);color:#333;outline:none" />
                </div>
                <p id="join-error" style="color:#ff4444;font-size:14px;margin-top:4px;min-height:18px;font-weight:bold">${errorMsg}</p>
                <div style="font-size:14px;color:#aaa;margin-bottom:12px;">Select team:</div>
                <div style="display:flex;gap:16px;margin-bottom:20px">
                    <button class="team-btn" data-team="teamA"
                        style="padding:12px 32px;font-size:18px;border:2px solid #4488ff;border-radius:6px;
                        background:rgba(68,136,255,0.2);color:#4488ff;cursor:pointer;font-weight:bold">
                        BLUE TEAM
                    </button>
                    <button class="team-btn" data-team="teamB"
                        style="padding:12px 32px;font-size:18px;border:2px solid #ff4444;border-radius:6px;
                        background:rgba(255,68,68,0.2);color:#ff4444;cursor:pointer;font-weight:bold">
                        RED TEAM
                    </button>
                </div>
                <button id="join-cancel" style="margin-top:12px;padding:6px 20px;font-size:13px;
                    border:1px solid #666;border-radius:4px;background:transparent;color:#888;cursor:pointer">
                    Cancel (Esc)
                </button>
            </div>
            <div id="join-step2" style="display:none;flex-direction:column;align-items:center;">
                <h2 style="color:#fff;font-size:36px;margin-bottom:12px">SELECT WEAPON</h2>
                <div id="join-team-badge" style="font-size:14px;font-weight:bold;margin-bottom:18px;
                    padding:4px 16px;border-radius:4px;"></div>
                <div style="display:flex;gap:12px;margin-bottom:20px;color:#fff;">
                    ${this._weaponCardHTML('join-wp', 1, 'AR15', 'ar', true)}
                    ${this._weaponCardHTML('join-wp', 2, 'SMG', 'smg', false)}
                    ${this._weaponCardHTML('join-wp', 3, 'LMG', 'lmg', false)}
                    ${this._weaponCardHTML('join-wp', 4, 'BOLT', 'bolt', false)}
                </div>
                <div style="display:flex;gap:12px;margin-top:16px;">
                    <button id="join-back-btn" style="padding:8px 24px;font-size:14px;border:1px solid #666;
                        border-radius:4px;background:transparent;color:#aaa;cursor:pointer">Back (Esc)</button>
                    <button id="join-deploy-btn" style="padding:8px 32px;font-size:16px;font-weight:bold;
                        border:2px solid #4488ff;border-radius:4px;background:rgba(68,136,255,0.3);
                        color:#fff;cursor:pointer">DEPLOY (Space)</button>
                </div>
            </div>
        `;

        document.body.appendChild(panel);

        let selectedWeapon = 'AR15';

        const highlightJoinWeapon = (weaponId) => {
            selectedWeapon = weaponId;
            const map = { AR15: 'ar', SMG: 'smg', LMG: 'lmg', BOLT: 'bolt' };
            for (const [wid, shortId] of Object.entries(map)) {
                const card = document.getElementById(`join-wp-${shortId}`);
                if (!card) continue;
                if (wid === weaponId) {
                    card.style.borderColor = '#4488ff';
                    card.style.background = 'rgba(68,136,255,0.15)';
                } else {
                    card.style.borderColor = '#888';
                    card.style.background = 'transparent';
                }
            }
        };

        // Weapon card click selection
        const weaponMap = { 'join-wp-ar': 'AR15', 'join-wp-smg': 'SMG', 'join-wp-lmg': 'LMG', 'join-wp-bolt': 'BOLT' };
        for (const [elId, wid] of Object.entries(weaponMap)) {
            const card = document.getElementById(elId);
            if (card) card.addEventListener('click', () => highlightJoinWeapon(wid));
        }

        // Deploy action (shared by button click and Space key)
        const deployAction = () => {
            document.removeEventListener('keydown', this._joinKeyHandler);
            this._joinKeyHandler = null;
            panel.remove();
            this._joinGame(this._joinTeam, selectedWeapon, this._joinName);
        };

        // Back action (shared by button click and Esc key)
        const backAction = () => {
            this._joinStep = 1;
            document.getElementById('join-step2').style.display = 'none';
            document.getElementById('join-step1').style.display = 'flex';
        };

        // Deploy button
        document.getElementById('join-deploy-btn').addEventListener('click', deployAction);

        // Back button
        document.getElementById('join-back-btn').addEventListener('click', backAction);

        // Keyboard handler — weapon selection (Digit1-4) + deploy (Space) + back (Esc) in step 2
        this._joinKeyHandler = (e) => {
            if (this._joinStep !== 2) return;
            const weaponKeys = { Digit1: 'AR15', Digit2: 'SMG', Digit3: 'LMG', Digit4: 'BOLT' };
            if (weaponKeys[e.code]) {
                highlightJoinWeapon(weaponKeys[e.code]);
            }
            if (e.code === 'Space') {
                deployAction();
            }
            // Escape is handled by the global keydown handler (avoids double-fire)
        };
        document.addEventListener('keydown', this._joinKeyHandler);

        // Team selection → advance to step 2
        panel.querySelectorAll('.team-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this._joinTeam = btn.dataset.team;
                this._joinName = document.getElementById('player-name').value.trim() || 'Player';
                this._joinStep = 2;

                // Show team badge
                const badge = document.getElementById('join-team-badge');
                if (badge) {
                    const isA = this._joinTeam === 'teamA';
                    badge.textContent = isA ? 'BLUE TEAM' : 'RED TEAM';
                    badge.style.color = isA ? '#4488ff' : '#ff4444';
                    badge.style.border = `1px solid ${isA ? '#4488ff' : '#ff4444'}`;
                    badge.style.background = isA ? 'rgba(68,136,255,0.15)' : 'rgba(255,68,68,0.15)';
                }

                document.getElementById('join-step1').style.display = 'none';
                document.getElementById('join-step2').style.display = 'flex';
            });
        });

        // Cancel
        const cancelBtn = document.getElementById('join-cancel');
        cancelBtn.addEventListener('click', () => {
            if (this._joinKeyHandler) {
                document.removeEventListener('keydown', this._joinKeyHandler);
                this._joinKeyHandler = null;
            }
            panel.remove();
        });
    }

    // ── Weapon card helpers (mirrored from HUDController) ──

    _weaponStatBars(weaponId) {
        const def = WeaponDefs[weaponId];
        let maxDmg = 0, maxRof = 0, maxRng = 0, maxSpread = 0, maxMob = 0;
        for (const k in WeaponDefs) {
            const w = WeaponDefs[k];
            if (!w.fireRate) continue;
            if (w.damage > maxDmg) maxDmg = w.damage;
            if (w.fireRate > maxRof) maxRof = w.fireRate;
            if (w.maxRange > maxRng) maxRng = w.maxRange;
            if (w.baseSpread > maxSpread) maxSpread = w.baseSpread;
            if ((w.moveSpeedMult || 1) > maxMob) maxMob = w.moveSpeedMult || 1;
        }
        const stats = [
            ['DMG', def.damage / maxDmg],
            ['ROF', def.fireRate / maxRof],
            ['RNG', def.maxRange / maxRng],
            ['ACC', 1 - def.baseSpread / (maxSpread * 1.25)],
            ['MOB', (def.moveSpeedMult || 1) / maxMob],
        ];
        const barW = 64;
        return stats.map(([label, ratio]) => {
            const pct = Math.round(Math.min(1, Math.max(0, ratio)) * 100);
            return `<div style="display:flex;align-items:center;gap:5px;margin-top:3px;">
                <span style="font-size:9px;color:#888;width:24px;text-align:right;">${label}</span>
                <div style="width:${barW}px;height:5px;background:rgba(255,255,255,0.12);border-radius:2px;overflow:hidden;">
                    <div style="width:${pct}%;height:100%;background:rgba(255,255,255,0.6);border-radius:2px;"></div>
                </div>
                <span style="font-size:9px;color:#aaa;width:20px;text-align:right;">${pct}</span>
            </div>`;
        }).join('');
    }

    _weaponCardHTML(idPrefix, num, weaponId, shortId, selected) {
        const def = WeaponDefs[weaponId];
        const border = selected ? '#4488ff' : '#888';
        const bg = selected ? 'rgba(68,136,255,0.15)' : 'transparent';
        return `<div id="${idPrefix}-${shortId}" style="border:2px solid ${border};border-radius:8px;padding:10px 14px;
            background:${bg};cursor:pointer;min-width:140px;transition:background 0.15s,border-color 0.15s;"
            onmouseenter="if(this.style.borderColor!=='rgb(68, 136, 255)')this.style.background='rgba(255,255,255,0.07)'"
            onmouseleave="if(this.style.borderColor!=='rgb(68, 136, 255)')this.style.background='transparent'">
            <div style="font-size:16px;font-weight:bold;">[${num}] ${def.name}</div>
            <div style="font-size:11px;color:#aaa;margin-top:3px;">${def.fireRate} RPM &middot; ${def.magazineSize} rds</div>
            ${this._weaponStatBars(weaponId)}
        </div>`;
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
        this._lastAmmo = undefined;
        this._lastWeaponId = undefined;

        this.network.sendJoin(team, weaponId, playerName);
        console.log(`[Client] Joining ${team} with ${weaponId} as "${playerName}"`);
    }

    // ═══════════════════════════════════════════════════════
    // Lighting
    // ═══════════════════════════════════════════════════════

    _setupLighting() {
        this.scene.add(new THREE.AmbientLight(0xffffff, 0.5));

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

        this.scene.add(new THREE.HemisphereLight(0x87CEEB, 0x556B2F, 0.3));
    }

    // ═══════════════════════════════════════════════════════
    // Network Callbacks
    // ═══════════════════════════════════════════════════════

    _onConnected() {
        console.log('[Client] Connected to server');
        document.getElementById('conn-status').textContent = 'Connected! Waiting for world data...';

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
        if (fps.isScoped) {
            fps.isScoped = false;
            this.camera.fov = 75;
            this.camera.updateProjectionMatrix();
        }
        if (this._scopeVignette) this._scopeVignette.style.display = 'none';
        this._crosshair.style.display = 'none';
        this._healthHUD.style.display = 'none';
        this._ammoHUD.style.display = 'none';
        this._reloadIndicator.style.display = 'none';
        if (this._pingInterval) clearInterval(this._pingInterval);
        if (this._blocker) {
            this._blocker.classList.remove('hidden');
            document.getElementById('conn-status').textContent = 'Disconnected. Reconnect?';
            document.getElementById('connect-btn').disabled = false;
        }
    }

    _onWorldSeed(seed, flagLayout, entityCount) {
        console.log('[Client] WorldSeed received: seed=', seed, 'entities=', entityCount);

        // Prefill all AI soldiers into scoreboard
        for (let i = 0; i < TEAM_SIZE; i++) {
            this._scoreboard[`A-${i}`] = { kills: 0, deaths: 0, team: 'teamA', weapon: '' };
            this._scoreboard[`B-${i}`] = { kills: 0, deaths: 0, team: 'teamB', weapon: '' };
        }

        // Hide connection UI
        if (this._blocker) this._blocker.classList.add('hidden');

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
        this._playerNames.set(playerId, pName);
        if (!this._scoreboard[pName]) {
            this._scoreboard[pName] = { kills: 0, deaths: 0, team, weapon: weaponId };
        } else {
            this._scoreboard[pName].team = team;
            this._scoreboard[pName].weapon = weaponId;
        }
        // Remove the AI placeholder this player replaced (e.g. A-3)
        const aiName = team === 'teamA' ? `A-${playerId}` : `B-${playerId - TEAM_SIZE}`;
        delete this._scoreboard[aiName];

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
        if (this._scopeVignette) this._scopeVignette.style.display = 'none';

        // Switch to FPS mode
        this.gameMode = 'playing';
        this.spectatorHUD.hide();
        this._crosshair.style.display = 'block';
        this._healthHUD.style.display = 'block';
        this._ammoHUD.style.display = 'block';
        this._hideDeathOverlay();

        // Initialize health + ammo HUD content
        this._lastHP = undefined;
        this._lastAmmo = undefined;
        this._lastWeaponId = undefined;
        this._lastReloading = undefined;
        this._lastBolting = undefined;
        this._lastGrenades = undefined;
        this._reloadTrack.wasReloading = false;
        this._reloadTrack.wasBolting = false;
        this._reloadTrack.elapsed = 0;

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
            if (fps.isScoped) {
                fps.isScoped = false;
                this.camera.fov = 75;
                this.camera.updateProjectionMatrix();
                if (this._scopeVignette) this._scopeVignette.style.display = 'none';
            }
        } else if (!inVehicle && wasInVehicle) {
            // Exited vehicle — restore FP gun (skip if dead, death hides gun)
            if (this.gameMode !== 'dead') {
                if (fps.fpGunGroup) fps.fpGunGroup.visible = true;
                if (this._crosshair) this._crosshair.style.display = 'block';
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
            this._showDamageDirection(dmgDirX, dmgDirZ, dmgTimer);
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
                    if (fps.isScoped) {
                        fps.isScoped = false;
                        this.camera.fov = 75;
                        this.camera.updateProjectionMatrix();
                        if (this._scopeVignette) this._scopeVignette.style.display = 'none';
                    }
                    if (fps.fpGunGroup) fps.fpGunGroup.visible = false;
                    this.gameMode = 'dead';
                    this._streakCount = 0;
                    this._streakTimer = 0;
                    this._showDeathOverlay();
                    document.exitPointerLock();
                } else if (this.gameMode === 'dead' && alive) {
                    // Respawned (fallback if PLAYER_SPAWNED was missed)
                    this.gameMode = 'playing';
                    this._hideDeathOverlay();
                    this._crosshair.style.display = 'block';
                    this._healthHUD.style.display = 'block';
                    this._ammoHUD.style.display = 'block';
                    if (fps.fpGunGroup) fps.fpGunGroup.visible = true;
                    fps.deathLerp.active = false;
                    this._lastHP = undefined;
                    this._lastAmmo = undefined;
                    this._reloadTrack.wasReloading = false;
                    this._reloadTrack.wasBolting = false;
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
                        this._showFlagBanner(`LOSING ${flagNames[i]}`, '#ffaa00');
                    } else if (contesting === 'capturing') {
                        this._showFlagBanner(`TAKING ${flagNames[i]}`, teamColor);
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
        if (this._scoreA) this._scoreA.textContent = scores.teamA;
        if (this._scoreB) this._scoreB.textContent = scores.teamB;

        // Count flags per team
        let flagsA = 0, flagsB = 0;
        for (const f of this.flags) {
            if (f.owner === 'teamA') flagsA++;
            else if (f.owner === 'teamB') flagsB++;
        }
        if (this._flagCountA) this._flagCountA.textContent = flagsA;
        if (this._flagCountB) this._flagCountB.textContent = flagsB;
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
                        this._isCOM(ev.killerName),
                        this._isCOM(ev.victimName)
                    );
                    this._trackKill(ev.killerName, ev.killerTeam, ev.victimName, ev.victimTeam, ev.weaponId, ev.killerKills, ev.victimDeaths);
                    if (this._scoreboardEl && this._scoreboardEl.style.display !== 'none') {
                        this._showScoreboard();
                    }
                    // Kill banner + hit marker upgrade for local player
                    if (ev.killerName === this._fps.playerName && this._fps.myEntityId >= 0) {
                        this._showHitMarker(ev.headshot ? 'headshot_kill' : 'kill');
                        this._recordKill(ev.headshot);
                    }
                    // Kill hit marker upgrade for spectated COM
                    if (this.gameMode === 'spectator' && this._spectator.mode === 'follow'
                        && this._spectator.targetId !== null && ev.killerEntityId === this._spectator.targetId) {
                        this._showHitMarker(ev.headshot ? 'headshot_kill' : 'kill');
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
                            this._showFlagBanner(`CAPTURED ${fname}`, teamColor);
                        } else {
                            this._showFlagBanner(`LOST ${fname}`, '#ff4444');
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
                    this._updateGameOverCountdown(ev.secondsLeft);
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
            this._showHitMarker('hit');
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

    _showHitMarker(type = 'hit') {
        const color = type === 'headshot_kill' ? '#ffd700'
            : type === 'kill' ? '#ff4444' : '#ffffff';
        this._hitMarkerDuration = type === 'headshot_kill' ? 0.35
            : type === 'kill' ? 0.30 : 0.15;
        this._hitMarkerTimer = this._hitMarkerDuration;

        for (const line of this._hitMarkerLines) {
            line.setAttribute('stroke', color);
        }
        this._hitMarkerScale = (type === 'kill' || type === 'headshot_kill') ? 1.6 : 1;

        this._hitMarker.style.display = 'block';
        this._hitMarker.style.opacity = '1';
        this._hitMarker.style.transform = `translate(-50%,-50%) rotate(45deg) scale(${this._hitMarkerScale})`;
    }

    _updateHitMarker(dt) {
        if (this._hitMarkerTimer > 0) {
            this._hitMarkerTimer -= dt;
            if (this._hitMarkerTimer <= 0) {
                this._hitMarker.style.display = 'none';
            } else {
                this._hitMarker.style.opacity = String(Math.min(1, this._hitMarkerTimer / 0.08));
                if (this._hitMarkerScale > 1) {
                    this._hitMarkerScale = Math.max(1, this._hitMarkerScale - dt * 6);
                    this._hitMarker.style.transform = `translate(-50%,-50%) rotate(45deg) scale(${this._hitMarkerScale})`;
                }
            }
        }
    }

    _showGameOver(winner, scoreA, scoreB) {
        // ── Stop player input: release pointer lock, hide FPS HUD ──
        if (this.gameMode === 'playing' || this.gameMode === 'dead') {
            const fps = this._fps;
            if (fps.isScoped) {
                fps.isScoped = false;
                this.camera.fov = 75;
                this.camera.updateProjectionMatrix();
            }
            if (this._scopeVignette) this._scopeVignette.style.display = 'none';
            if (fps.fpGunGroup) fps.fpGunGroup.visible = false;
            this._crosshair.style.display = 'none';
            this._healthHUD.style.display = 'none';
            this._ammoHUD.style.display = 'none';
            this._reloadIndicator.style.display = 'none';
            this._hideDeathOverlay();
            document.exitPointerLock();
            this.gameMode = 'spectator';
            fps.myEntityId = -1;
        }

        // Remove previous game-over overlay if any
        const prev = document.getElementById('game-over-overlay');
        if (prev) prev.remove();

        const el = document.createElement('div');
        el.id = 'game-over-overlay';
        el.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;
            background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;
            flex-direction:column;z-index:1000;pointer-events:none;
            font-family:Consolas,monospace;backdrop-filter:blur(2px);`;

        const color = winner === 'teamA' ? '#4488ff' : '#ff4444';
        const teamName = winner === 'teamA' ? 'BLUE TEAM' : 'RED TEAM';

        // Winner banner
        const banner = document.createElement('div');
        banner.style.cssText = `text-align:center;margin-bottom:20px;`;
        banner.innerHTML = `
            <div style="color:${color};font-size:48px;font-weight:bold;margin-bottom:8px;
                text-shadow:0 0 20px ${color}44;">${teamName} WINS</div>
            <div style="color:#ccc;font-size:22px">${scoreA} - ${scoreB}</div>`;
        el.appendChild(banner);

        // Reuse scoreboard content — build team columns
        this._updateScoreboardData();
        const sbContainer = document.createElement('div');
        sbContainer.style.cssText = `display:flex;align-items:flex-start;gap:32px;
            background:rgba(0,0,0,0.6);border-radius:10px;padding:20px 28px;
            min-width:600px;border:1px solid rgba(255,255,255,0.1);`;
        sbContainer.innerHTML = `
            <div id="go-teamA" style="flex:1;min-width:260px;"></div>
            <div style="width:1px;background:rgba(255,255,255,0.15);align-self:stretch;"></div>
            <div id="go-teamB" style="flex:1;min-width:260px;"></div>`;
        el.appendChild(sbContainer);

        // Countdown display
        const countdown = document.createElement('div');
        countdown.id = 'go-countdown';
        countdown.style.cssText = `color:#aaa;font-size:16px;margin-top:16px;text-align:center;`;
        countdown.textContent = 'Next round starting...';
        el.appendChild(countdown);

        document.body.appendChild(el);

        // Render team columns
        this._renderGameOverScoreboard();
    }

    /** Build sorted team lists from scoreboard data (shared by scoreboard + game-over). */
    _updateScoreboardData() {
        // Update weapon info from EntityRenderer
        for (const [entityId, entry] of this.entityRenderer.entities) {
            if (entry.isGrenade) continue;
            let name;
            if (this._playerNames.has(entityId)) {
                name = this._playerNames.get(entityId);
            } else if (entry.team === 'teamA') {
                name = `A-${entityId}`;
            } else {
                name = `B-${entityId - TEAM_SIZE}`;
            }
            const sb = this._scoreboard[name];
            if (sb && entry.weaponId) sb.weapon = entry.weaponId;
        }
    }

    /** Render team columns into game-over overlay. */
    _renderGameOverScoreboard() {
        const goA = document.getElementById('go-teamA');
        const goB = document.getElementById('go-teamB');
        if (!goA || !goB) return;

        const teamAList = [];
        const teamBList = [];
        for (const [name, stat] of Object.entries(this._scoreboard)) {
            const entry = { name, ...stat };
            if (stat.team === 'teamA') teamAList.push(entry);
            else teamBList.push(entry);
        }
        teamAList.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
        teamBList.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);

        const localName = this._fps.playerName;

        const renderTeam = (entries, teamColor, teamLabel) => {
            let totalK = 0, totalD = 0;
            for (const e of entries) { totalK += e.kills; totalD += e.deaths; }
            let html = `<div style="color:${teamColor};font-weight:bold;font-size:16px;margin-bottom:8px;text-align:center;">${teamLabel}</div>`;
            html += `<div style="display:flex;color:#888;font-size:11px;padding:2px 6px;border-bottom:1px solid rgba(255,255,255,0.1);margin-bottom:2px;">
                <span style="flex:1">Name</span><span style="width:30px;text-align:center">K</span>
                <span style="width:30px;text-align:center">D</span><span style="width:50px;text-align:right">Wpn</span></div>`;
            for (const e of entries) {
                const isPlayer = e.name === localName && this._fps.myEntityId >= 0;
                const com = this._isCOM(e.name);
                const displayName = com ? `${escapeHTML(e.name)}<span style="color:#666;font-weight:normal">(AI)</span>` : escapeHTML(e.name);
                const bg = isPlayer ? 'rgba(255,255,255,0.1)' : 'transparent';
                const nameColor = isPlayer ? '#fff' : 'rgba(255,255,255,0.75)';
                const wpn = e.weapon || '-';
                html += `<div style="display:flex;font-size:12px;padding:2px 6px;background:${bg};border-radius:2px;">
                    <span style="flex:1;color:${nameColor};font-weight:${isPlayer ? 'bold' : 'normal'}">${displayName}</span>
                    <span style="width:30px;text-align:center;color:#ccc">${e.kills}</span>
                    <span style="width:30px;text-align:center;color:#ccc">${e.deaths}</span>
                    <span style="width:50px;text-align:right;color:#888;font-size:11px">${escapeHTML(wpn)}</span></div>`;
            }
            html += `<div style="display:flex;font-size:12px;padding:4px 6px;margin-top:4px;border-top:1px solid rgba(255,255,255,0.1);color:#aaa;">
                <span style="flex:1;font-weight:bold">Total</span>
                <span style="width:30px;text-align:center">${totalK}</span>
                <span style="width:30px;text-align:center">${totalD}</span>
                <span style="width:50px"></span></div>`;
            return html;
        };

        goA.innerHTML = renderTeam(teamAList, '#4488ff', 'TEAM A');
        goB.innerHTML = renderTeam(teamBList, '#ff4444', 'TEAM B');
    }

    /** Update the countdown number in the game-over overlay. */
    _updateGameOverCountdown(secondsLeft) {
        const el = document.getElementById('go-countdown');
        if (el) el.textContent = `Next round in ${secondsLeft}s`;
    }

    /** Remove game-over overlay and reset client state for a new round. */
    _resetForNewRound() {
        // Remove game-over overlay
        const overlay = document.getElementById('game-over-overlay');
        if (overlay) overlay.remove();

        // Hide TAB scoreboard if open
        this._hideScoreboard();

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
            if (fps.isScoped) {
                fps.isScoped = false;
                this.camera.fov = 75;
                this.camera.updateProjectionMatrix();
            }
            if (this._scopeVignette) this._scopeVignette.style.display = 'none';
            this._crosshair.style.display = 'none';
            this._healthHUD.style.display = 'none';
            this._ammoHUD.style.display = 'none';
            this._reloadIndicator.style.display = 'none';
            this._hideDeathOverlay();
            this._lastHP = undefined;
            this._lastAmmo = undefined;
            this._lastWeaponId = undefined;
            this._lastReloading = undefined;
            this._lastBolting = undefined;
            this._reloadTrack.wasReloading = false;
            this._reloadTrack.wasBolting = false;
            this._reloadTrack.elapsed = 0;
            document.exitPointerLock();
        }

        this.gameMode = 'spectator';
        this._spectator.mode = 'overhead';
        this._spectator.overheadPos.set(0, 120, 0);
        this._spectator.initialized = false;
        this._spectator.lastScoped = false;
        this.spectatorHUD.show();
        this.spectatorHUD.setOverheadMode();
        // Hide follow-mode HUD elements
        this._healthHUD.style.display = 'none';
        this._ammoHUD.style.display = 'none';
        this._reloadIndicator.style.display = 'none';
        this._crosshair.style.display = 'none';

        // Reset scoreboard stats
        for (const key of Object.keys(this._scoreboard)) {
            delete this._scoreboard[key];
        }
        for (let i = 0; i < TEAM_SIZE; i++) {
            this._scoreboard[`A-${i}`] = { kills: 0, deaths: 0, team: 'teamA', weapon: '' };
            this._scoreboard[`B-${i}`] = { kills: 0, deaths: 0, team: 'teamB', weapon: '' };
        }
        this._playerNames.clear();
        this._playerPings = {};
        this._spectatorCount = 0;

        // Clear kill feed
        if (this.killFeed) {
            this.killFeed.entries.length = 0;
            this.killFeed.container.innerHTML = '';
        }

        // Reset kill streak / banner state
        this._streakCount = 0;
        this._streakTimer = 0;
        this._killBannerTimer = 0;
        if (this._killBanner) this._killBanner.style.display = 'none';
        if (this._flagBannerEl) this._flagBannerEl.style.display = 'none';
        this._flagBannerTimer = 0;
        this._prevFlagStates = [];

        console.log('[Client] Round reset — back to spectator');
    }

    _showDeathOverlay() {
        let el = document.getElementById('death-overlay');
        if (!el) {
            el = document.createElement('div');
            el.id = 'death-overlay';
            el.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;
                background:rgba(139,0,0,0.3);display:flex;align-items:center;justify-content:center;
                flex-direction:column;z-index:101;`;
            el.innerHTML = `
                <div style="color:white;font-family:Arial,sans-serif;text-align:center;">
                    <div style="font-size:36px;font-weight:bold;margin-bottom:10px;">YOU DIED</div>
                    <div id="mp-respawn-timer" style="font-size:20px;color:#ccc;"></div>
                    <div id="mp-weapon-select" style="display:none;margin-top:18px;">
                        <div style="font-size:14px;color:#aaa;margin-bottom:8px;">Select weapon:</div>
                        <div style="display:flex;gap:12px;justify-content:center;">
                            ${this._weaponCardHTML('mp-wp', 1, 'AR15', 'ar', true)}
                            ${this._weaponCardHTML('mp-wp', 2, 'SMG', 'smg', false)}
                            ${this._weaponCardHTML('mp-wp', 3, 'LMG', 'lmg', false)}
                            ${this._weaponCardHTML('mp-wp', 4, 'BOLT', 'bolt', false)}
                        </div>
                    </div>
                    <div id="mp-respawn-prompt" style="display:none;flex-direction:column;align-items:center;margin-top:14px;gap:10px;">
                        <div style="display:flex;gap:12px;">
                            <button id="mp-spectate-btn" style="padding:8px 24px;font-size:14px;border:1px solid #666;
                                border-radius:4px;background:transparent;color:#aaa;cursor:pointer">Spectate (Esc)</button>
                            <button id="mp-respawn-btn" style="padding:8px 32px;font-size:16px;font-weight:bold;
                                border:2px solid #4488ff;border-radius:4px;background:rgba(68,136,255,0.3);
                                color:#fff;cursor:pointer">RESPAWN (Space)</button>
                        </div>
                    </div>
                </div>`;
            document.body.appendChild(el);
        }
        el.style.display = 'flex';
        this._crosshair.style.display = 'none';
        this._healthHUD.style.display = 'none';
        this._ammoHUD.style.display = 'none';
        this._reloadIndicator.style.display = 'none';

        // Init death countdown
        this._deathCountdown = 5;
        this._deathCanRespawn = false;
        this._deathSelectedWeapon = this._fps.weaponId;

        // Reset weapon card highlights
        const wpSelect = document.getElementById('mp-weapon-select');
        if (wpSelect) wpSelect.style.display = 'none';
        const prompt = document.getElementById('mp-respawn-prompt');
        if (prompt) prompt.style.display = 'none';
        const timer = document.getElementById('mp-respawn-timer');
        if (timer) timer.textContent = 'Respawn in 5s';
    }

    _hideDeathOverlay() {
        const el = document.getElementById('death-overlay');
        if (el) el.style.display = 'none';
        this._deathCanRespawn = false;
    }

    _updateDeathScreen(dt) {
        if (this._deathCountdown > 0) {
            this._deathCountdown -= dt;
            const sec = Math.max(0, Math.ceil(this._deathCountdown));
            const timer = document.getElementById('mp-respawn-timer');
            if (timer) timer.textContent = `Respawn in ${sec}s`;

            if (this._deathCountdown <= 0) {
                // Countdown done — show weapon selection
                this._deathCanRespawn = true;
                if (timer) timer.textContent = '';
                const wpSelect = document.getElementById('mp-weapon-select');
                if (wpSelect) wpSelect.style.display = 'block';
                const prompt = document.getElementById('mp-respawn-prompt');
                if (prompt) prompt.style.display = 'flex';
                this._highlightDeathWeapon(this._deathSelectedWeapon);
                this._bindDeathClickHandlers();
            }
        }
    }

    _highlightDeathWeapon(weaponId) {
        const map = { AR15: 'ar', SMG: 'smg', LMG: 'lmg', BOLT: 'bolt' };
        for (const [wid, shortId] of Object.entries(map)) {
            const card = document.getElementById(`mp-wp-${shortId}`);
            if (!card) continue;
            if (wid === weaponId) {
                card.style.borderColor = '#4488ff';
                card.style.background = 'rgba(68,136,255,0.15)';
            } else {
                card.style.borderColor = '#888';
                card.style.background = 'transparent';
            }
        }
    }

    _bindDeathClickHandlers() {
        if (this._deathClicksBound) return;
        this._deathClicksBound = true;

        // Weapon card clicks
        const wpMap = { 'mp-wp-ar': 'AR15', 'mp-wp-smg': 'SMG', 'mp-wp-lmg': 'LMG', 'mp-wp-bolt': 'BOLT' };
        for (const [elId, wid] of Object.entries(wpMap)) {
            const card = document.getElementById(elId);
            if (card) card.addEventListener('click', () => {
                if (!this._deathCanRespawn) return;
                this._deathSelectedWeapon = wid;
                this._highlightDeathWeapon(wid);
            });
        }

        // Respawn button
        const respawnBtn = document.getElementById('mp-respawn-btn');
        if (respawnBtn) respawnBtn.addEventListener('click', () => {
            if (!this._deathCanRespawn) return;
            const weaponId = this._deathSelectedWeapon || 'AR15';
            this._fps.weaponId = weaponId;
            const def = WeaponDefs[weaponId];
            this._fps.moveSpeed = MOVE_SPEED * (def?.moveSpeedMult || 1.0);
            this.network.sendRespawn(weaponId);
        });

        // Spectate button
        const spectateBtn = document.getElementById('mp-spectate-btn');
        if (spectateBtn) spectateBtn.addEventListener('click', () => {
            if (!this._deathCanRespawn) return;
            this._leaveGame();
        });
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

        // Island vegetation sway
        if (this.island) {
            this.island.updateSway(this.clock.elapsedTime);
        }

        // VFX
        if (this.tracerSystem) this.tracerSystem.update(dt);
        if (this.impactVFX) this.impactVFX.update(dt);

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
        this._updateVehicleOccupants();

        // Camera mode
        if (this.gameMode === 'playing') {
            this._updateFPSMode(dt);
        } else if (this.gameMode === 'dead') {
            // Death screen countdown + weapon select
            this._updateDeathScreen(dt);

            // Camera position stays frozen at the moment of death.
            // Only the death lerp (below) rotates toward the killer.
        } else if (this.gameMode === 'spectator') {
            if (this._spectator.mode === 'follow') {
                this._updateSpectatorFollow(dt);
            } else {
                this._updateSpectatorOverhead(dt);
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
        this._updateVehicleHUD();

        // Player HUD (health + ammo, works in both playing and spectator follow)
        this._updatePlayerHUD(dt);

        // Reload indicator (spinning circle)
        this._updateReloadIndicator(dt);

        // Hit marker fade
        this._updateHitMarker(dt);

        // Damage direction fade
        this._updateDamageIndicator(dt);

        // Kill banner + flag banner timers
        this._updateKillBannerTimer(dt);
        this._updateFlagBannerTimer(dt);

        // Kill feed decay
        this.killFeed.update(dt);

        // Ping display (update every ~30 frames)
        if (this._pingDisplay && this.network.connected) {
            this._pingFrameCount = (this._pingFrameCount || 0) + 1;
            if (this._pingFrameCount >= 30) {
                this._pingFrameCount = 0;
                const rtt = Math.round(this.network.rtt);
                this._pingDisplay.textContent = `PING: ${rtt}ms`;
                this._pingDisplay.style.color = rtt < 30 ? 'rgba(100,255,100,0.6)'
                    : rtt < 80 ? 'rgba(255,255,100,0.6)' : 'rgba(255,100,100,0.6)';
            }
        }

        // Render
        this.renderer.render(this.scene, this.camera);
        this.stats.end();
    }

    // ═══════════════════════════════════════════════════════
    // FPS Mode
    // ═══════════════════════════════════════════════════════

    _updateFPSMode(dt) {
        const fps = this._fps;

        // ── Grenade throw timer ──
        const grenadeDown = this.input.isKeyDown('KeyG');
        if (grenadeDown && !fps.prevGrenade) {
            fps.grenadeThrowTimer = 0.5;
        }
        fps.prevGrenade = grenadeDown;
        if (fps.grenadeThrowTimer > 0) fps.grenadeThrowTimer -= dt;

        // ── Scope toggle (right-click edge trigger) ──
        const rightDown = this.input.rightMouseDown;
        if (rightDown && !fps.prevRightMouse) {
            const def = WeaponDefs[fps.weaponId];
            if (def && def.scopeFOV && !fps.isReloading && !fps.isBolting && fps.grenadeThrowTimer <= 0) {
                fps.isScoped = !fps.isScoped;
                this.camera.fov = fps.isScoped ? def.scopeFOV : 75;
                this.camera.updateProjectionMatrix();
                if (fps.fpGunGroup) fps.fpGunGroup.visible = !fps.isScoped;
                if (this._scopeVignette) {
                    this._scopeVignette.style.display = fps.isScoped ? 'block' : 'none';
                }
                if (this._crosshair) {
                    this._crosshair.style.display = fps.isScoped ? 'none' : 'block';
                }
            }
        }
        fps.prevRightMouse = rightDown;

        // Force unscope on reload/bolt
        if (fps.isScoped && (fps.isReloading || fps.isBolting)) {
            fps.isScoped = false;
            this.camera.fov = 75;
            this.camera.updateProjectionMatrix();
            if (fps.fpGunGroup) fps.fpGunGroup.visible = true;
            if (this._scopeVignette) this._scopeVignette.style.display = 'none';
            if (this._crosshair) this._crosshair.style.display = 'block';
        }

        // ── Mouse look (with scope sensitivity) ──
        if (this.input.isPointerLocked) {
            const { dx, dy } = this.input.consumeMouseDelta();
            const sens = fps.isScoped ? fps.mouseSensitivity * 0.5 : fps.mouseSensitivity;
            fps.yaw -= dx * sens;
            fps.pitch -= dy * sens;
            fps.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, fps.pitch));
        }

        // Build key bits
        const keys = this._buildKeyBits();

        // Send input to server
        fps.localTick++;
        this.network.sendInput(fps.localTick, keys, 0, 0, fps.yaw, fps.pitch);

        const inVehicle = fps.vehicleId !== 0xFF;

        // Local prediction (skip when in vehicle — server controls position)
        if (!inVehicle) {
            this._predictMovement(dt, keys);

            // Smooth correction toward server position
            const t = Math.min(1, 12 * dt);
            fps.predictedPos.lerp(fps.serverPos, t);
        }

        // ── FP gun animations ──
        if (fps.fpGunGroup) {
            // Recoil recovery
            fps.fpRecoilOffset = Math.max(0, fps.fpRecoilOffset - GunAnim.recoilRecovery * dt);

            // Reload/bolt tilt
            const targetTilt = fps.isReloading ? GunAnim.reloadTilt
                : fps.isBolting ? GunAnim.boltTilt : 0;
            const tiltSpeed = (targetTilt > fps.fpReloadTilt) ? 12 : 8;
            fps.fpReloadTilt += (targetTilt - fps.fpReloadTilt) * Math.min(1, tiltSpeed * dt);

            // Apply to gun group
            fps.fpGunGroup.position.z = -fps.fpRecoilOffset;
            fps.fpGunGroup.rotation.x = fps.fpReloadTilt;
        }

        // ── FP muzzle flash timer ──
        if (fps.fpMuzzleFlashTimer > 0) {
            fps.fpMuzzleFlashTimer -= dt;
            if (fps.fpMuzzleFlashTimer <= 0 && fps.fpMuzzleFlash) {
                fps.fpMuzzleFlash.visible = false;
            }
        }

        // ── Update camera ──
        if (inVehicle) {
            this._updateVehicleCamera();
        } else {
            this.camera.position.set(
                fps.predictedPos.x,
                fps.predictedPos.y + 1.6,
                fps.predictedPos.z
            );
        }
        _euler.set(fps.pitch, fps.yaw, 0, 'YXZ');
        this.camera.quaternion.setFromEuler(_euler);
    }

    /**
     * Position camera in vehicle cockpit/seat.
     */
    _updateVehicleCamera() {
        const fps = this._fps;
        const vEntry = this.vehicleRenderer.vehicles.get(fps.vehicleId);
        if (!vEntry) {
            // Fallback — use predicted pos
            this.camera.position.set(fps.predictedPos.x, fps.predictedPos.y + 1.6, fps.predictedPos.z);
            return;
        }

        // Determine if pilot or passenger
        const isPilot = vEntry.pilotId === fps.myEntityId;
        let offset;

        if (isPilot) {
            offset = { x: HELI_PILOT_OFFSET.x, y: HELI_PILOT_OFFSET.y + 1.6, z: HELI_PILOT_OFFSET.z };
        } else {
            // Find which passenger slot
            let slotIdx = -1;
            for (let i = 0; i < vEntry.passengerIds.length; i++) {
                if (vEntry.passengerIds[i] === fps.myEntityId) {
                    slotIdx = i;
                    break;
                }
            }
            if (slotIdx >= 0 && slotIdx < HELI_PASSENGER_SLOTS.length) {
                const slot = HELI_PASSENGER_SLOTS[slotIdx];
                offset = { x: slot.x, y: slot.y + 1.6, z: slot.z };
            } else {
                offset = { x: 0, y: 0.5, z: 0 };
            }
        }

        const seatPos = this.vehicleRenderer.getSeatWorldPos(fps.vehicleId, offset);
        if (seatPos) {
            this.camera.position.copy(seatPos);
        } else {
            this.camera.position.set(vEntry.mesh.position.x, vEntry.mesh.position.y + 1.6, vEntry.mesh.position.z);
        }
    }

    /**
     * Position entity meshes on vehicle seats with proper sitting pose.
     * Mirrors the single-player AIController.updateContinuous() lines 549-621.
     */
    _updateVehicleOccupants() {
        const fps = this._fps;

        // First: clear all _inVehicle flags so EntityRenderer can animate freed entities
        for (const [, entry] of this.entityRenderer.entities) {
            if (entry._inVehicle) entry._inVehicle = false;
        }

        for (const [, vEntry] of this.vehicleRenderer.vehicles) {
            if (!vEntry.mesh.visible) continue;

            // Get helicopter attitude quaternion from the client attitudeGroup
            vEntry.attitudeGroup.updateWorldMatrix(true, false);
            _seatQuat.setFromRotationMatrix(vEntry.attitudeGroup.matrixWorld);

            // Pilot
            if (vEntry.pilotId !== 0xFFFF) {
                const entry = this.entityRenderer.entities.get(vEntry.pilotId);
                if (entry && entry.mesh) {
                    entry._inVehicle = true;
                    if (vEntry.pilotId === fps.myEntityId) {
                        entry.mesh.visible = false;
                    } else {
                        entry.mesh.visible = true;
                        const seatPos = this.vehicleRenderer.getSeatWorldPos(vEntry.vehicleId, HELI_PILOT_OFFSET);
                        if (seatPos) {
                            entry.mesh.position.copy(seatPos);
                        }
                        // Full attitude quaternion (pitch + roll + yaw)
                        entry.mesh.quaternion.copy(_seatQuat);
                        // Body faces forward relative to helicopter
                        if (entry.lowerBody) entry.lowerBody.rotation.y = Math.PI;
                        if (entry.upperBody) {
                            entry.upperBody.rotation.y = Math.PI;
                            if (entry.shoulderPivot) entry.shoulderPivot.rotation.x = 0;
                        }
                        // Sitting pose — legs bent 90 degrees
                        if (entry.leftLeg) entry.leftLeg.rotation.x = Math.PI / 2;
                        if (entry.rightLeg) entry.rightLeg.rotation.x = Math.PI / 2;
                    }
                }
            }

            // Passengers
            for (let i = 0; i < vEntry.passengerIds.length; i++) {
                const pid = vEntry.passengerIds[i];
                if (pid === 0xFFFF) continue;
                const entry = this.entityRenderer.entities.get(pid);
                if (!entry || !entry.mesh) continue;

                entry._inVehicle = true;
                const slot = HELI_PASSENGER_SLOTS[i];
                if (!slot) continue;

                if (pid === fps.myEntityId) {
                    entry.mesh.visible = false;
                } else {
                    entry.mesh.visible = true;
                    const seatPos = this.vehicleRenderer.getSeatWorldPos(vEntry.vehicleId, slot);
                    if (seatPos) {
                        entry.mesh.position.copy(seatPos);
                    }
                    // Full attitude quaternion
                    entry.mesh.quaternion.copy(_seatQuat);
                    // Lower body faces outward (door direction)
                    if (entry.lowerBody) {
                        entry.lowerBody.rotation.y = slot.facingOffset;
                    }
                    // Upper body aim: server already sends heli-local yaw/pitch, apply directly
                    if (entry.upperBody) {
                        const state = this.entityRenderer.interp.getInterpolated(pid);
                        if (state) {
                            entry.upperBody.rotation.y = state.yaw;
                            if (entry.shoulderPivot) {
                                entry.shoulderPivot.rotation.x = state.pitch;
                            }
                        } else {
                            entry.upperBody.rotation.y = slot.facingOffset;
                            if (entry.shoulderPivot) entry.shoulderPivot.rotation.x = 0;
                        }
                    }
                    // Sitting pose — legs at 45 degrees
                    if (entry.leftLeg) entry.leftLeg.rotation.x = Math.PI / 4;
                    if (entry.rightLeg) entry.rightLeg.rotation.x = Math.PI / 4;
                }
            }
        }
    }

    /**
     * Update vehicle HUD (title, HP bar, controls) and "Press E" prompt.
     */
    _updateVehicleHUD() {
        const fps = this._fps;
        const inVehicle = fps.vehicleId !== 0xFF;

        // Vehicle HUD — show when in vehicle
        if (this._vehicleHUD) {
            if (inVehicle && (this.gameMode === 'playing')) {
                const vEntry = this.vehicleRenderer.vehicles.get(fps.vehicleId);
                if (vEntry) {
                    this._vehicleHUD.style.display = 'block';

                    // Determine role and occupant count
                    const isPilot = vEntry.pilotId === fps.myEntityId;
                    let occ = 0;
                    if (vEntry.pilotId !== 0xFFFF) occ++;
                    for (const pid of vEntry.passengerIds) {
                        if (pid !== 0xFFFF) occ++;
                    }
                    const typeName = `HELICOPTER [${occ}/4]` + (isPilot ? ' PILOT' : ' GUNNER');
                    if (typeName !== this._lastVehicleTitle) {
                        this._lastVehicleTitle = typeName;
                        this._vhudTitle.textContent = typeName;
                        this._vhudControls.textContent = isPilot
                            ? 'WASD Move | Space Up | Shift Down | E Exit'
                            : 'Mouse Aim | LMB Fire | E Exit';
                    }

                    // HP progress bar
                    const maxHP = 6000;
                    const hpPct = Math.round(Math.max(0, vEntry.hp / maxHP * 100));
                    if (hpPct !== this._lastVehicleHpPct) {
                        this._lastVehicleHpPct = hpPct;
                        const hpColor = hpPct > 50 ? '#4f4' : hpPct > 25 ? '#ff4' : '#f44';
                        this._vhudHpBar.style.width = hpPct + '%';
                        this._vhudHpBar.style.background = hpColor;
                    }
                } else {
                    this._vehicleHUD.style.display = 'none';
                }
            } else {
                if (this._lastVehicleTitle) {
                    this._vehicleHUD.style.display = 'none';
                    this._lastVehicleTitle = null;
                    this._lastVehicleHpPct = -1;
                }
            }
        }

        // "Press E" prompt — show when near a vehicle (on foot, playing)
        if (this._vehiclePrompt) {
            if (!inVehicle && this.gameMode === 'playing' && fps.myEntityId >= 0) {
                let nearVehicle = false;
                const pp = fps.predictedPos;
                for (const [, vEntry] of this.vehicleRenderer.vehicles) {
                    if (!vEntry.alive) continue;
                    const vp = vEntry.mesh.position;
                    const dx = pp.x - vp.x;
                    const dy = pp.y - vp.y;
                    const dz = pp.z - vp.z;
                    if (dx * dx + dy * dy + dz * dz < vEntry.enterRadius * vEntry.enterRadius) {
                        nearVehicle = true;
                        break;
                    }
                }
                this._vehiclePrompt.style.display = nearVehicle ? 'block' : 'none';
            } else {
                this._vehiclePrompt.style.display = 'none';
            }
        }
    }

    /**
     * Update health + ammo HUD (dirty-checked DOM writes).
     * Called every frame for both playing mode and spectator follow.
     */
    _updatePlayerHUD(dt) {
        const fps = this._fps;

        // ── Determine data source ──
        let hp, ammo, grenades, weaponId, isReloading, isBolting;
        let isSpectatorFollow = false;

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
                this._ammoHUD.style.display = 'none';
                this._healthHUD.style.display = 'none';
                return;
            }
            isSpectatorFollow = true;
            hp = entry.hp ?? 100;
            weaponId = entry.weaponId;
            isReloading = entry.isReloading;
            isBolting = entry.isBolting;
            ammo = entry.ammo ?? 0;
            grenades = entry.grenades ?? 0;
        } else {
            return;
        }

        // ── Health HUD ──
        const curHP = Math.round(hp);
        if (curHP !== this._lastHP) {
            this._lastHP = curHP;
            const hpColor = curHP > 60 ? '#4f4' : curHP > 30 ? '#ff4' : '#f44';
            const barWidth = Math.max(0, curHP);
            this._healthHUD.innerHTML = `
                <div style="font-size:12px;color:#aaa;margin-bottom:4px">HEALTH</div>
                <div style="font-size:28px;font-weight:bold;color:${hpColor}">${curHP}</div>
                <div style="width:120px;height:6px;background:#333;border-radius:3px;margin-top:4px;">
                    <div style="width:${barWidth}%;height:100%;background:${hpColor};border-radius:3px;"></div>
                </div>`;
        }

        // ── Ammo HUD ──
        const curAmmo = ammo;
        const curWeaponId = weaponId;
        const curGrenades = grenades;
        if (curAmmo !== this._lastAmmo || isReloading !== this._lastReloading
            || isBolting !== this._lastBolting
            || curWeaponId !== this._lastWeaponId || curGrenades !== this._lastGrenades) {
            this._lastAmmo = curAmmo;
            this._lastReloading = isReloading;
            this._lastBolting = isBolting;
            this._lastWeaponId = curWeaponId;
            this._lastGrenades = curGrenades;

            const def = WeaponDefs[curWeaponId];
            const statusText = isReloading ? `<span style="color:#ffaa00">RELOADING...</span>`
                : isBolting ? `<span style="color:#ffaa00">BOLTING...</span>` : '';

            const grenadeText = `<div style="font-size:13px;color:#aaa;margin-top:6px">&#x1F4A3; ${curGrenades}</div>`;
            this._ammoHUD.innerHTML = `
                <div style="font-size:12px;color:#aaa;margin-bottom:4px">${def ? def.name : curWeaponId}</div>
                <div style="font-size:28px;font-weight:bold">
                    ${curAmmo}<span style="font-size:16px;color:#888"> / ${def ? def.magazineSize : 30}</span>
                </div>${statusText}${grenadeText}`;
        }
    }

    /**
     * Update reload indicator (SVG circle progress).
     * Works for both playing mode and spectator follow.
     */
    _updateReloadIndicator(dt) {
        let isReloading = false;
        let progress = 0;
        let weaponId = null;

        if (this.gameMode === 'playing' && this._fps.myEntityId >= 0) {
            weaponId = this._fps.weaponId;
            const track = this._reloadTrack;

            if (this._fps.isReloading) {
                if (!track.wasReloading) {
                    track.elapsed = 0;
                    track.wasReloading = true;
                }
                track.elapsed += dt;
                const def = WeaponDefs[weaponId];
                const duration = def ? def.reloadTime : 2;
                progress = Math.min(1, track.elapsed / duration);
                isReloading = true;
            } else if (this._fps.isBolting) {
                if (!track.wasBolting) {
                    track.elapsed = 0;
                    track.wasBolting = true;
                }
                track.elapsed += dt;
                const def = WeaponDefs[weaponId];
                const duration = def ? (def.boltTime || 1) : 1;
                progress = Math.min(1, track.elapsed / duration);
                isReloading = true;
            } else {
                track.wasReloading = false;
                track.wasBolting = false;
                track.elapsed = 0;
            }
        } else if (this.gameMode === 'spectator' && this._spectator.mode === 'follow') {
            const entry = this._spectator.targetId !== null
                ? this.entityRenderer.entities.get(this._spectator.targetId) : null;
            if (entry && entry.alive) {
                weaponId = entry.weaponId;
                const track = this._reloadTrack;

                if (entry.isReloading) {
                    if (!track.wasReloading) {
                        track.elapsed = 0;
                        track.wasReloading = true;
                    }
                    track.elapsed += dt;
                    const def = WeaponDefs[weaponId];
                    const duration = def ? def.reloadTime : 2;
                    progress = Math.min(1, track.elapsed / duration);
                    isReloading = true;
                } else if (entry.isBolting) {
                    if (!track.wasBolting) {
                        track.elapsed = 0;
                        track.wasBolting = true;
                    }
                    track.elapsed += dt;
                    const def = WeaponDefs[weaponId];
                    const duration = def ? (def.boltTime || 1) : 1;
                    progress = Math.min(1, track.elapsed / duration);
                    isReloading = true;
                } else {
                    track.wasReloading = false;
                    track.wasBolting = false;
                    track.elapsed = 0;
                }
            }
        }

        if (isReloading) {
            this._crosshair.style.display = 'none';
            this._reloadIndicator.style.display = 'block';
            if (!this._reloadArc) this._reloadArc = document.getElementById('reload-arc');
            const circ = 100.53;
            this._reloadArc.setAttribute('stroke-dashoffset', circ * (1 - progress));
        } else {
            this._reloadIndicator.style.display = 'none';
            // Restore crosshair (unless scoped or dead)
            const fps = this._fps;
            const isScoped = this.gameMode === 'playing'
                ? fps.isScoped
                : this._spectator.lastScoped;
            const showCrosshair = !isScoped && (
                this.gameMode === 'playing'
                || (this.gameMode === 'spectator' && this._spectator.mode === 'follow'));
            this._crosshair.style.display = showCrosshair ? 'block' : 'none';
        }
    }

    _buildKeyBits() {
        let keys = 0;
        if (this.input.isKeyDown('KeyW')) keys |= KeyBit.FORWARD;
        if (this.input.isKeyDown('KeyS')) keys |= KeyBit.BACKWARD;
        if (this.input.isKeyDown('KeyA')) keys |= KeyBit.LEFT;
        if (this.input.isKeyDown('KeyD')) keys |= KeyBit.RIGHT;
        if (this.input.isKeyDown('Space')) keys |= KeyBit.JUMP;
        if (this.input.isKeyDown('ShiftLeft') || this.input.isKeyDown('ShiftRight')) keys |= KeyBit.SPRINT;
        if (this.input.mouseDown) keys |= KeyBit.FIRE;
        if (this.input.rightMouseDown) keys |= KeyBit.SCOPE;
        if (this.input.isKeyDown('KeyR')) keys |= KeyBit.RELOAD;
        if (this.input.isKeyDown('KeyG')) keys |= KeyBit.GRENADE;
        if (this.input.isKeyDown('KeyE')) keys |= KeyBit.INTERACT;
        return keys;
    }

    /**
     * Client-side movement prediction.
     * Replicates server movement logic for instant camera response.
     * NavGrid check is skipped (server will correct via InputAck if needed).
     */
    _predictMovement(dt, keys) {
        const fps = this._fps;
        if (!this.island) return;

        const getH = (x, z) => this.island.getHeightAt(x, z);
        const groundY = getH(fps.predictedPos.x, fps.predictedPos.z);

        // Jumping
        if (fps.isJumping) {
            fps.jumpVelY -= GRAVITY * dt;
            fps.predictedPos.y += fps.jumpVelY * dt;
            if (fps.predictedPos.y <= groundY + 0.05) {
                fps.predictedPos.y = groundY + 0.05;
                fps.isJumping = false;
                fps.jumpVelY = 0;
            }
        }

        // Build move direction
        _pForward.set(0, 0, -1);
        _pRight.set(1, 0, 0);
        _pYawQuat.setFromAxisAngle(_pYAxis, fps.yaw);
        _pForward.applyQuaternion(_pYawQuat);
        _pRight.applyQuaternion(_pYawQuat);

        _pMoveDir.set(0, 0, 0);
        if (keys & KeyBit.FORWARD)  _pMoveDir.add(_pForward);
        if (keys & KeyBit.BACKWARD) _pMoveDir.sub(_pForward);
        if (keys & KeyBit.LEFT)     _pMoveDir.sub(_pRight);
        if (keys & KeyBit.RIGHT)    _pMoveDir.add(_pRight);

        // Jump (edge-triggered)
        const jumpDown = !!(keys & KeyBit.JUMP);
        if (jumpDown && !fps.prevSpace && !fps.isJumping) {
            fps.isJumping = true;
            fps.jumpVelY = PLAYER_JUMP_SPEED;
        }
        fps.prevSpace = jumpDown;

        // Target velocity
        let targetVX = 0, targetVZ = 0;
        if (_pMoveDir.lengthSq() > 0) {
            _pMoveDir.normalize();
            targetVX = _pMoveDir.x * fps.moveSpeed;
            targetVZ = _pMoveDir.z * fps.moveSpeed;
        }

        // Inertia lerp
        const rate = (targetVX !== 0 || targetVZ !== 0) ? ACCEL : DECEL;
        const t = Math.min(1, rate * dt);
        fps.velX += (targetVX - fps.velX) * t;
        fps.velZ += (targetVZ - fps.velZ) * t;

        // Snap to zero
        if (fps.velX * fps.velX + fps.velZ * fps.velZ < 0.01) {
            fps.velX = 0;
            fps.velZ = 0;
            if (!fps.isJumping) fps.predictedPos.y = groundY + 0.05;
            return;
        }

        // Position update with NavGrid collision
        let newX = fps.predictedPos.x + fps.velX * dt;
        let newZ = fps.predictedPos.z + fps.velZ * dt;

        if (this._navGrid) {
            const g = this._navGrid.worldToGrid(newX, newZ);
            if (!this._navGrid.isWalkable(g.col, g.row)) {
                const gX = this._navGrid.worldToGrid(newX, fps.predictedPos.z);
                const gZ = this._navGrid.worldToGrid(fps.predictedPos.x, newZ);
                if (this._navGrid.isWalkable(gX.col, gX.row)) {
                    newZ = fps.predictedPos.z;
                } else if (this._navGrid.isWalkable(gZ.col, gZ.row)) {
                    newX = fps.predictedPos.x;
                } else {
                    return; // fully blocked
                }
            }
        }

        const newGroundY = getH(newX, newZ);
        const slopeRise = newGroundY - fps.predictedPos.y;
        const stepX = newX - fps.predictedPos.x;
        const stepZ = newZ - fps.predictedPos.z;
        const slopeRun = Math.sqrt(stepX * stepX + stepZ * stepZ);
        const slopeAngle = slopeRun > 0.001 ? Math.atan2(slopeRise, slopeRun) : 0;
        const maxClimbAngle = Math.PI * 0.42;

        if (slopeAngle < maxClimbAngle) {
            if (newGroundY < 0) {
                return;
            }
            fps.predictedPos.x = newX;
            fps.predictedPos.z = newZ;
            if (!fps.isJumping) fps.predictedPos.y = newGroundY + 0.05;
        } else if (!fps.isJumping) {
            fps.isJumping = true;
            fps.jumpVelY = 2.5;
        }
    }

    // ═══════════════════════════════════════════════════════
    // Spectator Camera
    // ═══════════════════════════════════════════════════════

    _updateSpectatorFollow(dt) {
        const spec = this._spectator;

        if (spec.deathFreezeTimer > 0) {
            spec.deathFreezeTimer -= dt;
            if (spec.deathFreezeTimer <= 0) {
                spec.targetId = null;
                spec.initialized = false;
            }
            return;
        }

        const aliveIds = this.entityRenderer.getAliveEntityIds();
        if (aliveIds.length === 0) return;

        if (spec.targetId !== null) {
            const state = this.entityRenderer.getEntityState(spec.targetId);
            if (!state) {
                spec.deathFreezeTimer = 1.0;
                this._healthHUD.style.display = 'none';
                this._ammoHUD.style.display = 'none';
                this._reloadIndicator.style.display = 'none';
                this._crosshair.style.display = 'none';
                if (spec.lastScoped) {
                    spec.lastScoped = false;
                    if (this._scopeVignette) this._scopeVignette.style.display = 'none';
                    this.camera.fov = 75;
                    this.camera.updateProjectionMatrix();
                }
                return;
            }
        }

        if (spec.targetId === null || !aliveIds.includes(spec.targetId)) {
            spec.targetIndex = spec.targetIndex % aliveIds.length;
            spec.targetId = aliveIds[spec.targetIndex];
            spec.initialized = false;
            // Reset HUD for new target
            this._lastHP = undefined;
            this._lastAmmo = undefined;
            this._lastWeaponId = undefined;
            this._reloadTrack.wasReloading = false;
            this._reloadTrack.wasBolting = false;
            this._reloadTrack.elapsed = 0;
            if (spec.lastScoped) {
                spec.lastScoped = false;
                if (this._scopeVignette) this._scopeVignette.style.display = 'none';
                this.camera.fov = 75;
                this.camera.updateProjectionMatrix();
            }
        }

        const state = this.entityRenderer.getEntityState(spec.targetId);
        if (!state) return;

        // Eye position: use localToWorld so helicopter tilt is applied automatically
        const entry = this.entityRenderer.entities.get(spec.targetId);
        _headLocal.set(0, 1.6, 0);
        entry.mesh.updateWorldMatrix(true, false);
        entry.mesh.localToWorld(_headLocal);
        const headPos = _headLocal;

        // Yaw/pitch: for vehicle occupants, convert heli-local aim to world space
        let yaw = state.yaw;
        let pitch = state.pitch;
        if (entry._inVehicle) {
            const cp = Math.cos(pitch);
            _aimDirVec.set(
                -Math.sin(yaw) * cp,
                Math.sin(pitch),
                -Math.cos(yaw) * cp
            );
            _aimDirVec.applyQuaternion(entry.mesh.quaternion);
            yaw = Math.atan2(-_aimDirVec.x, -_aimDirVec.z);
            const hd = Math.sqrt(_aimDirVec.x * _aimDirVec.x + _aimDirVec.z * _aimDirVec.z);
            pitch = Math.atan2(_aimDirVec.y, hd);
        }

        if (!spec.initialized) {
            spec.lerpYaw = yaw;
            spec.lerpPitch = pitch;
            spec.initialized = true;
        } else {
            const t = Math.min(1, 0.25 * 60 * dt);
            let yawDiff = yaw - spec.lerpYaw;
            if (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
            if (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
            spec.lerpYaw += yawDiff * t;
            spec.lerpPitch += (pitch - spec.lerpPitch) * t;
        }

        this.camera.position.copy(headPos);
        _euler.set(spec.lerpPitch, spec.lerpYaw, 0, 'YXZ');
        this.camera.quaternion.setFromEuler(_euler);

        // Show target info in spectator HUD
        const teamPrefix = state.team === 'teamA' ? 'A' : 'B';
        const displayName = this._playerNames.get(spec.targetId) || `${teamPrefix}-${spec.targetId}`;
        const def = WeaponDefs[entry.weaponId];
        const roleName = def ? def.name : '';
        this.spectatorHUD.updateTarget(
            displayName, roleName, state.team,
            state.hp, 100
        );

        // Show health + ammo HUDs for spectated entity
        this._healthHUD.style.display = 'block';
        this._ammoHUD.style.display = 'block';

        // Scope vignette + FOV for spectated entity
        const isScoped = entry.isScoped && def && def.scopeFOV;
        if (isScoped !== spec.lastScoped) {
            spec.lastScoped = isScoped;
            if (this._scopeVignette)
                this._scopeVignette.style.display = isScoped ? 'block' : 'none';
            this.camera.fov = isScoped ? def.scopeFOV : 75;
            this.camera.updateProjectionMatrix();
            if (this._crosshair)
                this._crosshair.style.display = isScoped ? 'none' : 'block';
        }
    }

    _updateSpectatorOverhead(dt) {
        const spec = this._spectator;

        const speed = spec.panSpeed * dt;
        if (this.input.isKeyDown('KeyW')) spec.overheadPos.z -= speed;
        if (this.input.isKeyDown('KeyS')) spec.overheadPos.z += speed;
        if (this.input.isKeyDown('KeyA')) spec.overheadPos.x -= speed;
        if (this.input.isKeyDown('KeyD')) spec.overheadPos.x += speed;

        const scroll = this.input.consumeScrollDelta();
        if (scroll !== 0) {
            spec.overheadZoom += scroll * 0.1;
            spec.overheadZoom = Math.max(15, Math.min(200, spec.overheadZoom));
        }

        const tiltAngle = Math.PI / 3;
        const camY = spec.overheadZoom * Math.sin(tiltAngle);
        const camZOffset = spec.overheadZoom * Math.cos(tiltAngle);

        this.camera.position.set(
            spec.overheadPos.x,
            camY,
            spec.overheadPos.z + camZOffset
        );
        this.camera.rotation.set(-tiltAngle, 0, 0);
    }

    _nextTarget() {
        const aliveIds = this.entityRenderer.getAliveEntityIds();
        if (aliveIds.length === 0) return;
        this._spectator.deathFreezeTimer = 0;
        this._spectator.targetIndex = (this._spectator.targetIndex + 1) % aliveIds.length;
        this._spectator.targetId = aliveIds[this._spectator.targetIndex];
        this._spectator.initialized = false;
        // Reset HUD dirty-check so info refreshes for new target
        this._lastHP = undefined;
        this._lastAmmo = undefined;
        this._lastWeaponId = undefined;
        this._lastReloading = undefined;
        this._lastBolting = undefined;
        this._reloadTrack.wasReloading = false;
        this._reloadTrack.wasBolting = false;
        this._reloadTrack.elapsed = 0;
    }

    _toggleView() {
        const spec = this._spectator;
        if (spec.mode === 'follow') {
            spec.mode = 'overhead';
            spec.overheadPos.set(
                this.camera.position.x,
                spec.overheadZoom,
                this.camera.position.z
            );
            this.spectatorHUD.setOverheadMode();
            // Hide player HUDs in overhead mode
            this._healthHUD.style.display = 'none';
            this._ammoHUD.style.display = 'none';
            this._reloadIndicator.style.display = 'none';
            this._crosshair.style.display = 'none';
            if (spec.lastScoped) {
                spec.lastScoped = false;
                if (this._scopeVignette) this._scopeVignette.style.display = 'none';
                this.camera.fov = 75;
                this.camera.updateProjectionMatrix();
            }
        } else {
            spec.mode = 'follow';
            spec.initialized = false;
            spec.deathFreezeTimer = 0;
            this.spectatorHUD.setFollowMode();
            // Reset dirty-check so HUDs refresh for new target
            this._lastHP = undefined;
            this._lastAmmo = undefined;
            this._lastWeaponId = undefined;
            this._lastReloading = undefined;
            this._lastBolting = undefined;
            this._reloadTrack.wasReloading = false;
            this._reloadTrack.wasBolting = false;
        }
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
        // Unscope
        if (fps.isScoped) {
            fps.isScoped = false;
            this.camera.fov = 75;
            this.camera.updateProjectionMatrix();
        }
        if (this._scopeVignette) this._scopeVignette.style.display = 'none';

        this._crosshair.style.display = 'none';
        this._healthHUD.style.display = 'none';
        this._ammoHUD.style.display = 'none';
        this._reloadIndicator.style.display = 'none';
        this._hideDeathOverlay();
        // Clear flag banner & stale flag states so spectator doesn't see team notifications
        if (this._flagBannerEl) this._flagBannerEl.style.display = 'none';
        this._flagBannerTimer = 0;
        this._prevFlagStates = [];
        this.spectatorHUD.show();
        this.spectatorHUD.setFollowMode();
        this._spectator.initialized = false;
        this._spectator.lastScoped = false;
        // Reset HUD dirty-check for spectator mode
        this._lastHP = undefined;
        this._lastAmmo = undefined;
        this._lastWeaponId = undefined;
        this._lastReloading = undefined;
        this._lastBolting = undefined;
        this._reloadTrack.wasReloading = false;
        this._reloadTrack.wasBolting = false;
        this._reloadTrack.elapsed = 0;
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
                if (this._joinStep === 2) {
                    // Go back to step 1 (name + team)
                    document.getElementById('join-step1').style.display = 'flex';
                    document.getElementById('join-step2').style.display = 'none';
                    this._joinStep = 1;
                    return;
                }
                if (this._joinKeyHandler) {
                    document.removeEventListener('keydown', this._joinKeyHandler);
                    this._joinKeyHandler = null;
                }
                joinPanel.remove();
                return;
            }
            if (this.gameMode === 'playing' || this.gameMode === 'dead') {
                this._leaveGame();
                return;
            }
        }

        // Dead state — weapon selection + respawn
        if (this.gameMode === 'dead' && this._deathCanRespawn) {
            const weaponKeys = { Digit1: 'AR15', Digit2: 'SMG', Digit3: 'LMG', Digit4: 'BOLT' };
            if (weaponKeys[e.code]) {
                this._deathSelectedWeapon = weaponKeys[e.code];
                this._highlightDeathWeapon(this._deathSelectedWeapon);
                return;
            }
            if (e.code === 'Space') {
                const weaponId = this._deathSelectedWeapon || 'AR15';
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
                    this._nextTarget();
                    break;
                case 'KeyV':
                    this._toggleView();
                    break;
                case 'KeyJ':
                case 'Enter':
                    this._createJoinUI();
                    break;
            }
        }
    }
}
