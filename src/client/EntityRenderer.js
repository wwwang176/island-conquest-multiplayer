import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { WeaponDefs } from '../entities/WeaponDefs.js';
import { InterpolationManager } from './Interpolation.js';
import { EntityType } from '../shared/protocol.js';

const WATER_Y = -0.3;
const BODY_CENTER_OFFSET = 0.8;
const RAGDOLL_DURATION = 4.5;
const RAGDOLL_HIDE_TIME = 0.5;
const RAGDOLL_MAX_SPEED = 15;
const RAGDOLL_MAX_SPEED_SQ = RAGDOLL_MAX_SPEED * RAGDOLL_MAX_SPEED;
const RAGDOLL_IMPULSE_FORCE = 60;
const RAGDOLL_IMPULSE_UP = 10;
const RAGDOLL_TORQUE_OFFSET = 0.6;

const _splashPos = new THREE.Vector3();
const _upDir = new THREE.Vector3(0, 1, 0);
const _gunWorldPos = new THREE.Vector3();
const _gunWorldQuat = new THREE.Quaternion();

const TEAM_COLORS = {
    teamA: 0x4488ff,
    teamB: 0xff4444,
};

/** Create a trapezoid stock from a BoxGeometry. */
function trapezoidGeo(w, frontH, backH, depth, cx, topY, zFront) {
    const geo = new THREE.BoxGeometry(w, backH, depth);
    const pos = geo.attributes.position;
    const halfD = depth / 2, halfH = backH / 2;
    for (let i = 0; i < pos.count; i++) {
        if (pos.getY(i) < 0) {
            const t = (pos.getZ(i) + halfD) / depth;
            pos.setY(i, halfH - (frontH + (backH - frontH) * t));
        }
    }
    pos.needsUpdate = true;
    geo.translate(cx, topY - halfH, zFront + halfD);
    geo.computeVertexNormals();
    return geo;
}

function _setVertexColor(geo, color) {
    const count = geo.attributes.position.count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
        colors[i * 3] = color.r;
        colors[i * 3 + 1] = color.g;
        colors[i * 3 + 2] = color.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

let _muzzleFlashGeo = null;
let _muzzleFlashMat = null;

export function createMuzzleFlashMesh() {
    if (!_muzzleFlashGeo) {
        const outerR = 0.27, innerR = 0.0675;
        const pts = [];
        for (let i = 0; i < 8; i++) {
            const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
            const r = i % 2 === 0 ? outerR : innerR;
            pts.push(Math.cos(a) * r, Math.sin(a) * r, 0);
        }
        const verts = [];
        for (let i = 0; i < 8; i++) {
            const j = (i + 1) % 8;
            verts.push(0, 0, 0, pts[i * 3], pts[i * 3 + 1], 0, pts[j * 3], pts[j * 3 + 1], 0);
        }
        _muzzleFlashGeo = new THREE.BufferGeometry();
        _muzzleFlashGeo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
        _muzzleFlashMat = new THREE.MeshBasicMaterial({
            color: 0xffcc44, transparent: true, opacity: 0.9,
            blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
        });
    }
    return new THREE.Mesh(_muzzleFlashGeo, _muzzleFlashMat);
}

const _gunMeshCache = {};

export function buildGunMesh(weaponId) {
    if (!_gunMeshCache[weaponId]) {
        const geos = [];
        if (weaponId === 'LMG') {
            geos.push(new THREE.BoxGeometry(0.10, 0.10, 0.50));
            const barrelGeo = new THREE.CylinderGeometry(0.022, 0.022, 0.35, 6);
            barrelGeo.rotateX(Math.PI / 2);
            barrelGeo.translate(0, 0.01, -0.42);
            geos.push(barrelGeo);
            const drumGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.08, 8);
            drumGeo.translate(0, -0.10, 0.05);
            geos.push(drumGeo);
            geos.push(trapezoidGeo(0.06, 0.06, 0.12, 0.25, 0, 0.03, 0.22));
        } else if (weaponId === 'SMG') {
            const bodyGeo = new THREE.BoxGeometry(0.08, 0.08, 0.30);
            bodyGeo.translate(0, 0, 0.10);
            geos.push(bodyGeo);
            const barrelGeo = new THREE.CylinderGeometry(0.018, 0.018, 0.15, 6);
            barrelGeo.rotateX(Math.PI / 2);
            barrelGeo.translate(0, 0.01, -0.15);
            geos.push(barrelGeo);
            const magGeo = new THREE.BoxGeometry(0.04, 0.18, 0.04);
            magGeo.translate(0, -0.13, 0.10);
            geos.push(magGeo);
            geos.push(trapezoidGeo(0.05, 0.05, 0.10, 0.20, 0, 0.02, 0.22));
        } else if (weaponId === 'BOLT') {
            geos.push(new THREE.BoxGeometry(0.07, 0.07, 0.50));
            const barrelGeo = new THREE.CylinderGeometry(0.014, 0.014, 0.55, 6);
            barrelGeo.rotateX(Math.PI / 2);
            barrelGeo.translate(0, 0.01, -0.52);
            geos.push(barrelGeo);
            const scopeGeo = new THREE.CylinderGeometry(0.025, 0.025, 0.30, 8);
            scopeGeo.rotateX(Math.PI / 2);
            scopeGeo.translate(0, 0.07, -0.05);
            geos.push(scopeGeo);
            geos.push(trapezoidGeo(0.06, 0.06, 0.14, 0.30, 0, 0.025, 0.22));
        } else {
            geos.push(new THREE.BoxGeometry(0.08, 0.08, 0.50));
            const barrelGeo = new THREE.CylinderGeometry(0.018, 0.018, 0.35, 6);
            barrelGeo.rotateX(Math.PI / 2);
            barrelGeo.translate(0, 0.01, -0.42);
            geos.push(barrelGeo);
            const magGeo = new THREE.BoxGeometry(0.04, 0.12, 0.05);
            magGeo.translate(0, -0.10, 0);
            geos.push(magGeo);
            geos.push(trapezoidGeo(0.06, 0.06, 0.12, 0.25, 0, 0.03, 0.22));
        }
        const merged = mergeGeometries(geos);
        for (const g of geos) g.dispose();
        _gunMeshCache[weaponId] = new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ color: 0x333333 }));
    }
    return _gunMeshCache[weaponId].clone();
}

/**
 * Manages rendering of all remote entities (AI soldiers + other players).
 * Creates/updates/removes soldier meshes based on server snapshot data.
 */
export class EntityRenderer {
    constructor(scene) {
        this.scene = scene;
        this.interp = new InterpolationManager();

        /** @type {Map<number, {mesh: THREE.Group, team: string, alive: boolean, upperBody, shoulderPivot, lowerBody, leftLeg, rightLeg, walkPhase: number}>} */
        this.entities = new Map();

        this.ragdollWorld = null;       // Set by ClientGame
        this.impactVFX = null;          // Set by ClientGame
        this.getHeightAt = null;        // Set by ClientGame
        this._recentCharHits = [];      // FIRED CHARACTER hit records
        this._lastGrenadeExplode = null; // Most recent GRENADE_EXPLODE {x,y,z,time}
        this._pendingKills = [];         // KILLED events buffer
        this._deferredDeaths = [];       // Deaths deferred until update() (after events arrive)
        this._droppedWeapons = [];       // Dropped weapon meshes + physics bodies
    }

    /**
     * Process a snapshot — create/update entities.
     */
    onSnapshot(tick, entityData) {
        const seen = new Set();

        for (const e of entityData) {
            seen.add(e.entityId);

            // Push state for interpolation
            this.interp.pushState(e.entityId, tick, e.x, e.y, e.z, e.yaw, e.pitch);

            let entry = this.entities.get(e.entityId);
            if (!entry) {
                if (e.type === EntityType.GRENADE) {
                    entry = this._createGrenade(e.entityId, e.team);
                } else {
                    entry = this._createEntity(e.entityId, e.team, e.weaponId);
                }
                this.entities.set(e.entityId, entry);
            }

            // Grenades skip alive/death/ragdoll logic
            if (entry.isGrenade) continue;

            // Update alive state + animation bits
            const wasAlive = entry.alive;
            entry.alive = (e.state & 1) !== 0;
            entry.hp = e.hp;
            entry.isReloading = (e.state & 2) !== 0;
            entry.isBolting = (e.state & 4) !== 0;
            entry.isScoped = (e.state & 8) !== 0;
            entry.ammo = e.ammo;
            entry.grenades = e.grenades;

            if (!entry.alive && wasAlive) {
                // Defer ragdoll start to update() — KILLED event arrives in a
                // separate WebSocket message AFTER the snapshot, so _pendingKills
                // is still empty here.  By the next requestAnimationFrame both
                // the snapshot and events have been processed.
                this._deferredDeaths.push({ entry, entityId: e.entityId });
            } else if (entry.alive && !wasAlive) {
                // Remove stale deferred death — entity already respawned
                const idx = this._deferredDeaths.findIndex(d => d.entry === entry);
                if (idx !== -1) this._deferredDeaths.splice(idx, 1);
                this._stopRagdoll(entry);

                // Sync mesh position immediately to avoid 1-frame flash at
                // old death location (matches single-player Soldier.respawn).
                // Also reset interp buffer so it won't lerp from death pos.
                entry.mesh.position.set(e.x, e.y, e.z);
                const ei = this.interp.entities.get(e.entityId);
                if (ei) { ei.states.length = 0; }
                this.interp.pushState(e.entityId, tick, e.x, e.y, e.z, e.yaw, e.pitch);

                entry.mesh.visible = true;
                if (entry.gun) entry.gun.visible = true;
                entry.mesh.rotation.set(0, 0, 0);
                if (entry.upperBody) entry.upperBody.rotation.set(0, 0, 0);
                if (entry.lowerBody) entry.lowerBody.rotation.set(0, 0, 0);
                if (entry.leftLeg) entry.leftLeg.rotation.set(0, 0, 0);
                if (entry.rightLeg) entry.rightLeg.rotation.set(0, 0, 0);

                // Swap gun model if weapon changed on respawn
                if (e.weaponId !== entry.weaponId) {
                    this._swapGun(entry, e.weaponId);
                }
            }
        }

        // Remove entities no longer in snapshot
        for (const [id, entry] of this.entities) {
            if (!seen.has(id)) {
                if (entry.isGrenade) {
                    entry.mesh.geometry.dispose();
                    entry.mesh.material.dispose();
                }
                this._stopRagdoll(entry);
                this.scene.remove(entry.mesh);
                this.entities.delete(id);
                this.interp.remove(id);
            }
        }
    }

    /**
     * Update interpolated positions each render frame.
     */
    update(dt, suppressVFX = false) {
        // Process deferred deaths — by now the KILLED events have arrived
        // via _onEvents() and populated _pendingKills with impulse info.
        if (this._deferredDeaths.length > 0) {
            if (suppressVFX) {
                // Tab was hidden — skip ragdoll/dropped-weapon, just hide
                for (const { entry } of this._deferredDeaths) {
                    entry.mesh.visible = false;
                    if (entry.gun) entry.gun.visible = false;
                }
                this._deferredDeaths.length = 0;
                this._pendingKills.length = 0;
            } else {
                for (const { entry, entityId } of this._deferredDeaths) {
                    this._startRagdoll(entry, entityId);
                }
                this._deferredDeaths.length = 0;
            }
        }

        // Update dropped weapons (physics sync, fade, cleanup)
        this._updateDroppedWeapons(dt);

        // Clean up expired hit records
        const now = performance.now();
        while (this._recentCharHits.length > 0 && now - this._recentCharHits[0].time > 1000) {
            this._recentCharHits.shift();
        }

        for (const [id, entry] of this.entities) {
            // Grenades: position-only interpolation
            if (entry.isGrenade) {
                const state = this.interp.getInterpolated(id);
                if (state) entry.mesh.position.set(state.x, state.y, state.z);
                continue;
            }

            if (!entry.alive) {
                if (entry._ragdoll) this._updateRagdoll(entry, dt);
                continue;
            }

            // Vehicle occupants: only run gun animations (muzzle flash,
            // recoil, reload tilt). Position/rotation/pose handled by
            // _updateVehicleOccupants.
            if (entry._inVehicle) {
                // Reload / bolt tilt
                const targetTilt = entry.isReloading ? 0.5 : (entry.isBolting ? 0.25 : 0);
                const tiltSpeed = entry.isReloading ? 12 : 8;
                entry._gunReloadTilt += (targetTilt - entry._gunReloadTilt) * Math.min(1, tiltSpeed * dt);

                // Muzzle flash timer
                if (entry._muzzleFlashTimer > 0) {
                    entry._muzzleFlashTimer -= dt;
                    if (entry._muzzleFlashTimer <= 0 && entry._muzzleFlash) {
                        entry._muzzleFlash.visible = false;
                    }
                }

                // Gun recoil recovery
                if (entry._gunRecoilZ > 0) {
                    entry._gunRecoilZ = Math.max(0, entry._gunRecoilZ - 2 * dt);
                }
                if (entry.gun) {
                    entry.gun.position.z = -0.45 + entry._gunRecoilZ;
                }
                if (entry._reloadPivot) {
                    entry._reloadPivot.rotation.x = entry._gunReloadTilt;
                }
                continue;
            }

            const state = this.interp.getInterpolated(id);
            if (!state) continue;

            // Position
            entry.mesh.position.set(state.x, state.y, state.z);

            // Upper body yaw (aim direction)
            if (entry.upperBody) {
                entry.upperBody.rotation.y = state.yaw;
            }

            // Shoulder pitch (aim angle only)
            if (entry.shoulderPivot) {
                entry.shoulderPivot.rotation.x = state.pitch;
            }

            // Lower body — lerp toward movement direction
            const dx = state.x - (entry._lastX ?? state.x);
            const dz = state.z - (entry._lastZ ?? state.z);
            const rawSpeed = Math.sqrt(dx * dx + dz * dz) / Math.max(dt, 0.001);
            // Smooth speed: interpolation is tick-based so position only changes
            // on snapshot frames; keep speed alive between snapshots.
            if (rawSpeed > 0.01) {
                entry._moveSpeed = rawSpeed;
                entry._moveAngle = Math.atan2(-dx, -dz);
            } else {
                entry._moveSpeed *= Math.exp(-5 * dt);
            }
            const moveSpeed = entry._moveSpeed;

            if (entry.lowerBody) {
                if (moveSpeed > 0.3) {
                    entry.lowerBody.rotation.y = lerpAngle(
                        entry.lowerBody.rotation.y, entry._moveAngle,
                        1 - Math.exp(-10 * dt)
                    );
                } else {
                    entry.lowerBody.rotation.y = lerpAngle(
                        entry.lowerBody.rotation.y, state.yaw,
                        1 - Math.exp(-5 * dt)
                    );
                }
            }

            // Walk animation (matched to Soldier.js:405-423)
            if (moveSpeed > 0.3 && entry.leftLeg && entry.rightLeg) {
                entry.walkPhase += dt * 10.4;
                const swing = Math.sin(entry.walkPhase) * 0.6;
                entry.leftLeg.rotation.x = swing;
                entry.rightLeg.rotation.x = -swing;
            } else if (entry.leftLeg && entry.rightLeg) {
                const decay = Math.exp(-10 * dt);
                entry.leftLeg.rotation.x *= decay;
                entry.rightLeg.rotation.x *= decay;
                entry.walkPhase = 0;
            }

            // Track velocity for ragdoll momentum inheritance
            entry._lastVelX = (state.x - (entry._lastX ?? state.x)) / Math.max(dt, 0.001);
            entry._lastVelY = (state.y - (entry._lastY ?? state.y)) / Math.max(dt, 0.001);
            entry._lastVelZ = (state.z - (entry._lastZ ?? state.z)) / Math.max(dt, 0.001);

            entry._lastX = state.x;
            entry._lastY = state.y;
            entry._lastZ = state.z;

            // Gun recoil recovery (Soldier.js:707-711, recoilRecovery=2)
            if (entry._gunRecoilZ > 0) {
                entry._gunRecoilZ = Math.max(0, entry._gunRecoilZ - 2 * dt);
            }
            if (entry.gun) {
                entry.gun.position.z = -0.45 + entry._gunRecoilZ;
            }

            // Reload / bolt tilt (Soldier.js:690-695, WeaponDefs reloadTilt=0.5, boltTilt=0.25)
            const targetTilt = entry.isReloading ? 0.5 : (entry.isBolting ? 0.25 : 0);
            const tiltSpeed = entry.isReloading ? 12 : 8;
            entry._gunReloadTilt += (targetTilt - entry._gunReloadTilt) * Math.min(1, tiltSpeed * dt);
            if (entry._reloadPivot) {
                entry._reloadPivot.rotation.x = entry._gunReloadTilt;
            }

            // Muzzle flash timer
            if (entry._muzzleFlashTimer > 0) {
                entry._muzzleFlashTimer -= dt;
                if (entry._muzzleFlashTimer <= 0 && entry._muzzleFlash) {
                    entry._muzzleFlash.visible = false;
                }
            }
        }
    }

    /**
     * Get the mesh for a specific entity (for spectator camera follow).
     */
    getMesh(entityId) {
        const entry = this.entities.get(entityId);
        return entry ? entry.mesh : null;
    }

    /**
     * Get all alive entity meshes.
     */
    getAliveMeshes() {
        const meshes = [];
        for (const [, entry] of this.entities) {
            if (entry.alive && !entry.isGrenade) meshes.push(entry.mesh);
        }
        return meshes;
    }

    /**
     * Get entity list for minimap.
     */
    getEntityPositions() {
        const result = [];
        for (const [id, entry] of this.entities) {
            if (!entry.alive || entry.isGrenade) continue;
            result.push({
                id,
                team: entry.team,
                x: entry.mesh.position.x,
                y: entry.mesh.position.y,
                z: entry.mesh.position.z,
            });
        }
        return result;
    }

    /**
     * Get soldiers for a team in Minimap-compatible format.
     * Returns objects with { id, alive, getPosition() }.
     */
    getTeamSoldiers(team) {
        const result = [];
        for (const [id, entry] of this.entities) {
            if (entry.team !== team || entry.isGrenade) continue;
            const mesh = entry.mesh;
            result.push({
                id,
                alive: entry.alive,
                getPosition() { return mesh.position; },
            });
        }
        return result;
    }

    /**
     * Get alive entity IDs for spectator target list.
     */
    getAliveEntityIds() {
        const ids = [];
        for (const [id, entry] of this.entities) {
            if (entry.alive && !entry.isGrenade) ids.push(id);
        }
        return ids;
    }

    /**
     * Get entity state for spectator camera follow.
     */
    getEntityState(entityId) {
        const entry = this.entities.get(entityId);
        if (!entry || !entry.alive) return null;
        return {
            position: entry.mesh.position,
            yaw: entry.upperBody ? entry.upperBody.rotation.y : 0,
            pitch: entry.shoulderPivot ? entry.shoulderPivot.rotation.x : 0,
            team: entry.team,
            hp: entry.hp ?? 100,
        };
    }

    clear() {
        for (const [, entry] of this.entities) {
            this._stopRagdoll(entry);
            this.scene.remove(entry.mesh);
        }
        this.entities.clear();
        this.interp.clear();

        // Clean up dropped weapons
        for (const gun of this._droppedWeapons) {
            this.scene.remove(gun.mesh);
            gun.mesh.geometry.dispose();
            gun.mesh.material.dispose();
            if (this.ragdollWorld) this.ragdollWorld.removeBody(gun.body);
        }
        this._droppedWeapons.length = 0;
    }

    /**
     * Trigger muzzle flash on a specific entity's gun.
     */
    showMuzzleFlash(entityId) {
        const entry = this.entities.get(entityId);
        if (!entry || !entry._muzzleFlash) return;
        entry._muzzleFlash.visible = true;
        entry._muzzleFlash.scale.setScalar(0.85 + Math.random() * 0.3);
        entry._muzzleFlash.rotation.z = (Math.random() - 0.5) * (10 * Math.PI / 180);
        entry._muzzleFlashTimer = 0.04;
        entry._gunRecoilZ = 0.06;
    }

    // ── Event recording ──

    recordCharacterHit(ev) {
        const hitX = ev.originX + ev.dirX * ev.hitDist;
        const hitY = ev.originY + ev.dirY * ev.hitDist;
        const hitZ = ev.originZ + ev.dirZ * ev.hitDist;
        this._recentCharHits.push({
            dirX: ev.dirX, dirY: ev.dirY, dirZ: ev.dirZ,
            hitX, hitY, hitZ,
            time: performance.now(),
        });
        if (this._recentCharHits.length > 20) this._recentCharHits.shift();
    }

    recordGrenadeExplode(x, y, z) {
        this._lastGrenadeExplode = { x, y, z, time: performance.now() };
    }

    recordKill(ev) {
        this._pendingKills.push({
            victimEntityId: ev.victimEntityId,
            killerEntityId: ev.killerEntityId,
            weaponId: ev.weaponId,
            time: performance.now(),
        });
        if (this._pendingKills.length > 30) this._pendingKills.shift();
    }

    // ── Ragdoll ──

    _startRagdoll(entry, entityId) {
        // Safety: skip if entity already respawned
        if (entry.alive) return;
        if (!this.ragdollWorld) {
            // No physics world — fall back to hiding
            entry.mesh.visible = false;
            return;
        }

        const pos = entry.mesh.position;

        // Create cannon-es dynamic body (cylinder shape matching Soldier.js)
        const body = new CANNON.Body({
            mass: 60,
            shape: new CANNON.Cylinder(0.3, 0.3, 1.6, 8),
            position: new CANNON.Vec3(pos.x, pos.y + BODY_CENTER_OFFSET, pos.z),
            fixedRotation: false,
            angularDamping: 0.4,
            linearDamping: 0.4,
        });
        body.collisionResponse = true;

        // Determine death cause from pending kills
        const killIdx = this._pendingKills.findIndex(k => k.victimEntityId === entityId);
        const killRecord = killIdx >= 0 ? this._pendingKills.splice(killIdx, 1)[0] : null;

        let impulseDir = null; // Direction for dropped weapon impulse

        if (killRecord && killRecord.weaponId === 'GRENADE' && this._lastGrenadeExplode) {
            // Grenade kill — blast impulse
            const ge = this._lastGrenadeExplode;
            const dx = pos.x - ge.x;
            const dy = (pos.y + BODY_CENTER_OFFSET) - ge.y;
            const dz = pos.z - ge.z;
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
            const blastRadius = WeaponDefs.GRENADE.blastRadius;
            if (dist < blastRadius && dist > 0.01) {
                const strength = 600 * (1 - dist / blastRadius);
                const nx = dx / dist;
                const ny = dy / dist;
                const nz = dz / dist;
                body.applyImpulse(
                    new CANNON.Vec3(nx * strength, ny * strength + strength * 0.7, nz * strength),
                    new CANNON.Vec3(0, RAGDOLL_TORQUE_OFFSET, 0)
                );
                impulseDir = { x: nx, z: nz };
            } else {
                // Fallback — small upward impulse
                body.applyImpulse(
                    new CANNON.Vec3(0, 5, 0),
                    new CANNON.Vec3(0, RAGDOLL_TORQUE_OFFSET, 0)
                );
            }
        } else if (killRecord) {
            // Bullet kill — find matching hit record
            const now = performance.now();
            let bestHit = null;
            let bestDist = Infinity;
            for (const hit of this._recentCharHits) {
                if (now - hit.time > 500) continue;
                const dx = hit.hitX - pos.x;
                const dy = hit.hitY - (pos.y + BODY_CENTER_OFFSET);
                const dz = hit.hitZ - pos.z;
                const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
                if (d < 5 && d < bestDist) {
                    bestDist = d;
                    bestHit = hit;
                }
            }
            if (bestHit) {
                // Normalize direction in XZ plane (match Soldier.js which uses
                // 2D-normalized (victim - attacker) direction for full horizontal force)
                const hdx = bestHit.dirX;
                const hdz = bestHit.dirZ;
                const hLen = Math.sqrt(hdx * hdx + hdz * hdz);
                const nx = hLen > 0.01 ? hdx / hLen : 0;
                const nz = hLen > 0.01 ? hdz / hLen : 0;
                body.applyImpulse(
                    new CANNON.Vec3(
                        nx * RAGDOLL_IMPULSE_FORCE,
                        RAGDOLL_IMPULSE_UP,
                        nz * RAGDOLL_IMPULSE_FORCE
                    ),
                    new CANNON.Vec3(0, RAGDOLL_TORQUE_OFFSET, 0)
                );
                impulseDir = { x: nx, z: nz };
            } else {
                // No matching hit — small upward impulse
                body.applyImpulse(
                    new CANNON.Vec3(0, 5, 0),
                    new CANNON.Vec3(0, RAGDOLL_TORQUE_OFFSET, 0)
                );
            }
        } else {
            // Unknown cause — small upward impulse
            body.applyImpulse(
                new CANNON.Vec3(0, 5, 0),
                new CANNON.Vec3(0, RAGDOLL_TORQUE_OFFSET, 0)
            );
        }

        // Inherit movement velocity
        body.velocity.x += (entry._lastVelX || 0);
        body.velocity.z += (entry._lastVelZ || 0);

        this.ragdollWorld.addBody(body);
        entry._ragdoll = { body, timer: RAGDOLL_DURATION, waterSplashed: false };
        entry.mesh.visible = true;

        // Hide muzzle flash before cloning gun for dropped weapon
        if (entry._muzzleFlash) entry._muzzleFlash.visible = false;
        entry._muzzleFlashTimer = 0;

        // Spawn dropped weapon + hide gun on corpse
        this._spawnDroppedWeapon(entry, impulseDir);
        if (entry.gun) entry.gun.visible = false;
    }

    _updateRagdoll(entry, dt) {
        const rd = entry._ragdoll;
        rd.timer -= dt;

        // Clamp velocity to prevent physics explosions
        const v = rd.body.velocity;
        const spd2 = v.x * v.x + v.y * v.y + v.z * v.z;
        if (spd2 > RAGDOLL_MAX_SPEED_SQ) {
            const s = RAGDOLL_MAX_SPEED / Math.sqrt(spd2);
            v.x *= s; v.y *= s; v.z *= s;
        }

        // Sync mesh quaternion from physics body
        entry.mesh.quaternion.set(
            rd.body.quaternion.x,
            rd.body.quaternion.y,
            rd.body.quaternion.z,
            rd.body.quaternion.w
        );

        // Mesh position = body center + rotated (0, -0.8, 0) offset
        const ox = 0, oy = -BODY_CENTER_OFFSET, oz = 0;
        const q = rd.body.quaternion;
        const ix = q.w * ox + q.y * oz - q.z * oy;
        const iy = q.w * oy + q.z * ox - q.x * oz;
        const iz = q.w * oz + q.x * oy - q.y * ox;
        const iw = -q.x * ox - q.y * oy - q.z * oz;
        const rx = ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y;
        const ry = iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z;
        const rz = iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x;
        entry.mesh.position.set(
            rd.body.position.x + rx,
            rd.body.position.y + ry,
            rd.body.position.z + rz
        );

        // Water splash
        if (!rd.waterSplashed && rd.body.position.y <= WATER_Y && this.impactVFX) {
            rd.waterSplashed = true;
            _splashPos.set(rd.body.position.x, WATER_Y, rd.body.position.z);
            this.impactVFX.spawn('water', _splashPos, _upDir);
        }

        // Hide mesh near end of ragdoll and clean up
        if (rd.timer <= RAGDOLL_HIDE_TIME) {
            entry.mesh.visible = false;
            this._stopRagdoll(entry);
        }
    }

    _stopRagdoll(entry) {
        if (!entry._ragdoll) return;
        if (this.ragdollWorld) {
            this.ragdollWorld.removeBody(entry._ragdoll.body);
        }
        entry._ragdoll = null;
    }

    // ── Dropped weapons ──

    _spawnDroppedWeapon(entry, impulseDir) {
        if (!entry.gun || !this.ragdollWorld) return;

        // Get gun world transform before hiding (matches DroppedGunManager.spawn)
        entry.gun.updateWorldMatrix(true, false);
        entry.gun.getWorldPosition(_gunWorldPos);
        entry.gun.getWorldQuaternion(_gunWorldQuat);

        const clone = entry.gun.clone();
        clone.material = clone.material.clone();
        clone.position.copy(_gunWorldPos);
        clone.quaternion.copy(_gunWorldQuat);

        this.scene.add(clone);

        const body = new CANNON.Body({
            mass: 2,
            linearDamping: 0.3,
            angularDamping: 0.3,
        });
        body.addShape(new CANNON.Box(new CANNON.Vec3(0.15, 0.03, 0.25)));
        body.position.set(_gunWorldPos.x, _gunWorldPos.y, _gunWorldPos.z);
        body.quaternion.set(_gunWorldQuat.x, _gunWorldQuat.y, _gunWorldQuat.z, _gunWorldQuat.w);

        // Inherit movement velocity (matches DroppedGunManager.spawn)
        body.velocity.set(
            entry._lastVelX || 0,
            entry._lastVelY || 0,
            entry._lastVelZ || 0
        );

        // Directional impulse from bullet/explosion, or random toss
        if (impulseDir) {
            body.applyImpulse(new CANNON.Vec3(
                impulseDir.x * 4 + (Math.random() - 0.5) * 3,
                3 + Math.random() * 2,
                impulseDir.z * 4 + (Math.random() - 0.5) * 3
            ));
        } else {
            body.applyImpulse(new CANNON.Vec3(
                (Math.random() - 0.5) * 4,
                3 + Math.random() * 2,
                (Math.random() - 0.5) * 4
            ));
        }

        // Random spin
        body.angularVelocity.set(
            (Math.random() - 0.5) * 10,
            (Math.random() - 0.5) * 10,
            (Math.random() - 0.5) * 10
        );

        this.ragdollWorld.addBody(body);
        this._droppedWeapons.push({ mesh: clone, body, life: 8, waterSplashed: false });
    }

    _updateDroppedWeapons(dt) {
        for (let i = this._droppedWeapons.length - 1; i >= 0; i--) {
            const gun = this._droppedWeapons[i];
            gun.life -= dt;

            // Sync mesh from physics body
            const bp = gun.body.position;
            const bq = gun.body.quaternion;
            gun.mesh.position.set(bp.x, bp.y, bp.z);
            gun.mesh.quaternion.set(bq.x, bq.y, bq.z, bq.w);

            // Water splash VFX
            if (!gun.waterSplashed && gun.body.position.y < WATER_Y && this.impactVFX) {
                gun.waterSplashed = true;
                _splashPos.set(gun.body.position.x, WATER_Y, gun.body.position.z);
                this.impactVFX.spawn('water', _splashPos, _upDir);
            }

            // Fade out last 1.5 seconds
            if (gun.life <= 1.5) {
                gun.mesh.material.transparent = true;
                gun.mesh.material.opacity = Math.max(0, gun.life / 1.5);
            }

            // Remove when expired
            if (gun.life <= 0) {
                this.scene.remove(gun.mesh);
                gun.mesh.geometry.dispose();
                gun.mesh.material.dispose();
                this.ragdollWorld.removeBody(gun.body);
                this._droppedWeapons.splice(i, 1);
            }
        }
    }

    // ── Grenade blast on existing ragdolls & dropped weapons ──

    applyGrenadeBlast(x, y, z) {
        const blastRadius = 6;

        // Push ragdolls
        for (const [, entry] of this.entities) {
            if (!entry._ragdoll) continue;
            const bp = entry._ragdoll.body.position;
            const dx = bp.x - x;
            const dy = bp.y - y;
            const dz = bp.z - z;
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (dist >= blastRadius || dist < 0.01) continue;
            const strength = 600 * (1 - dist / blastRadius);
            const nx = dx / dist;
            const ny = dy / dist;
            const nz = dz / dist;
            entry._ragdoll.body.applyImpulse(
                new CANNON.Vec3(nx * strength, ny * strength + strength * 0.7, nz * strength)
            );
        }

        // Push dropped weapons
        for (const gun of this._droppedWeapons) {
            const bp = gun.body.position;
            const dx = bp.x - x;
            const dy = bp.y - y;
            const dz = bp.z - z;
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (dist >= blastRadius || dist < 0.01) continue;
            const strength = 50 * (1 - dist / blastRadius);
            const nx = dx / dist;
            const ny = dy / dist;
            const nz = dz / dist;
            gun.body.applyImpulse(
                new CANNON.Vec3(nx * strength, ny * strength + strength * 0.7, nz * strength)
            );
        }
    }

    // ── Private ──

    _createGrenade(entityId, team) {
        const geo = new THREE.SphereGeometry(0.08, 8, 6);
        const mat = new THREE.MeshLambertMaterial({ color: 0x333333 });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.castShadow = false;
        this.scene.add(mesh);
        return { mesh, team, isGrenade: true, alive: true };
    }

    _createEntity(entityId, team, weaponId) {
        const color = TEAM_COLORS[team] || 0xaaaaaa;
        const mesh = this._buildSoldierMesh(color, weaponId);
        mesh.userData.entityId = entityId;
        mesh.userData.team = team;
        this.scene.add(mesh);

        return {
            mesh,
            team,
            alive: true,
            hp: 100,
            weaponId,
            upperBody: mesh.userData._upperBody,
            shoulderPivot: mesh.userData._shoulderPivot,
            lowerBody: mesh.userData._lowerBody,
            leftLeg: mesh.userData._leftLeg,
            rightLeg: mesh.userData._rightLeg,
            gun: mesh.userData._gun,
            _reloadPivot: mesh.userData._reloadPivot,
            leftArm: mesh.userData._leftArm,
            walkPhase: Math.random() * Math.PI * 2,
            _moveSpeed: 0,
            _moveAngle: 0,
            _lastX: 0,
            _lastZ: 0,
            _muzzleFlash: mesh.userData._muzzleFlash,
            _muzzleFlashTimer: 0,
            _gunRecoilZ: 0,
            _gunReloadTilt: 0,
            isReloading: false,
            isBolting: false,
            isScoped: false,
            ammo: 0,
            grenades: 0,
        };
    }

    _buildSoldierMesh(color, weaponId) {
        const tc = new THREE.Color(color);
        const limbColor = tc.clone().multiplyScalar(0.7);
        const hipColor = tc.clone().multiplyScalar(0.5);
        const skinColor = new THREE.Color(0xddbb99);

        const group = new THREE.Group();

        // ── Lower body ──
        const lowerBody = new THREE.Group();

        const hips = new THREE.Mesh(
            new THREE.BoxGeometry(0.5, 0.15, 0.3),
            new THREE.MeshLambertMaterial({ color: hipColor })
        );
        hips.position.y = 0.75;
        hips.castShadow = false;
        lowerBody.add(hips);

        const limbMat = new THREE.MeshLambertMaterial({ color: limbColor });

        const leftLeg = new THREE.Group();
        leftLeg.position.set(-0.13, 0.7, 0);
        const leftLegMesh = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.70, 0.18), limbMat);
        leftLegMesh.position.y = -0.35;
        leftLegMesh.castShadow = false;
        leftLeg.add(leftLegMesh);
        lowerBody.add(leftLeg);

        const rightLeg = new THREE.Group();
        rightLeg.position.set(0.13, 0.7, 0);
        const rightLegMesh = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.70, 0.18), limbMat);
        rightLegMesh.position.y = -0.35;
        rightLegMesh.castShadow = false;
        rightLeg.add(rightLegMesh);
        lowerBody.add(rightLeg);
        group.add(lowerBody);

        // ── Upper body (torso + head merged with vertex colors) ──
        const upperBody = new THREE.Group();

        const torsoGeo = new THREE.BoxGeometry(0.5, 0.6, 0.3);
        torsoGeo.translate(0, 1.125, 0);
        _setVertexColor(torsoGeo, tc);

        const headGeo = new THREE.BoxGeometry(0.3, 0.3, 0.3);
        headGeo.translate(0, 1.575, 0);
        _setVertexColor(headGeo, skinColor);

        const merged = mergeGeometries([torsoGeo, headGeo]);
        torsoGeo.dispose(); headGeo.dispose();
        const torsoHead = new THREE.Mesh(
            merged,
            new THREE.MeshLambertMaterial({ vertexColors: true })
        );
        torsoHead.castShadow = true;
        upperBody.add(torsoHead);

        const shoulderPivot = new THREE.Group();
        shoulderPivot.position.y = 1.35;
        upperBody.add(shoulderPivot);

        // Reload pivot — tilts arms+gun without affecting aim pitch
        const reloadPivot = new THREE.Group();
        shoulderPivot.add(reloadPivot);

        // Arms
        const rightArmGeo = new THREE.BoxGeometry(0.15, 0.4, 0.15);
        rightArmGeo.translate(0, -0.2, 0);
        const rightArm = new THREE.Mesh(rightArmGeo, limbMat);
        rightArm.position.set(0.2, 0, 0);
        rightArm.rotation.set(1.1, 0, 0);
        rightArm.castShadow = true;
        reloadPivot.add(rightArm);

        const leftArmGeo = new THREE.BoxGeometry(0.15, 0.55, 0.15);
        leftArmGeo.translate(0, -0.275, 0);
        const leftArm = new THREE.Mesh(leftArmGeo, limbMat);
        leftArm.position.set(-0.2, 0, 0);
        leftArm.rotation.set(1.2, 0, 0.5);
        leftArm.castShadow = true;
        reloadPivot.add(leftArm);

        // Gun — detailed model matching original Soldier.js
        const gun = buildGunMesh(weaponId);
        gun.position.set(0.05, -0.05, -0.45);
        gun.castShadow = false;
        reloadPivot.add(gun);

        // Muzzle flash
        const flash = createMuzzleFlashMesh();
        flash.visible = false;
        const flashDef = WeaponDefs[weaponId];
        if (flashDef) flash.position.set(0, 0.01, flashDef.tpMuzzleZ);
        gun.add(flash);

        // Adjust left arm per weapon
        const def = WeaponDefs[weaponId];
        if (def && def.tpLeftArmRotX !== undefined) {
            leftArm.rotation.x = def.tpLeftArmRotX;
        }

        group.add(upperBody);

        // Store refs for animation
        group.userData._upperBody = upperBody;
        group.userData._shoulderPivot = shoulderPivot;
        group.userData._lowerBody = lowerBody;
        group.userData._leftLeg = leftLeg;
        group.userData._rightLeg = rightLeg;
        group.userData._muzzleFlash = flash;
        group.userData._gun = gun;
        group.userData._reloadPivot = reloadPivot;
        group.userData._leftArm = leftArm;

        return group;
    }

    _swapGun(entry, weaponId) {
        const parent = entry._reloadPivot || entry.shoulderPivot;
        if (!parent) return;

        // Remove old gun (muzzle flash is a child, removed with it)
        if (entry.gun) {
            parent.remove(entry.gun);
            entry.gun.traverse(child => {
                if (child.isMesh) {
                    child.geometry?.dispose();
                    child.material?.dispose();
                }
            });
        }

        // Build new gun
        const gun = buildGunMesh(weaponId);
        gun.position.set(0.05, -0.05, -0.45);
        gun.castShadow = false;
        parent.add(gun);

        // Muzzle flash
        const flash = createMuzzleFlashMesh();
        flash.visible = false;
        const def = WeaponDefs[weaponId];
        if (def) flash.position.set(0, 0.01, def.tpMuzzleZ);
        gun.add(flash);

        // Adjust left arm pose
        if (entry.leftArm && def && def.tpLeftArmRotX !== undefined) {
            entry.leftArm.rotation.x = def.tpLeftArmRotX;
        }

        // Update entry refs
        entry.gun = gun;
        entry._muzzleFlash = flash;
        entry.weaponId = weaponId;
    }
}

function lerpAngle(a, b, t) {
    let diff = b - a;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    return a + diff * t;
}
