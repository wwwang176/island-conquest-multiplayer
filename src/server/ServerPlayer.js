import * as THREE from 'three';
import { ServerSoldier } from './ServerSoldier.js';
import { WeaponDefs } from '../entities/WeaponDefs.js';
import { applyFalloff } from '../shared/DamageFalloff.js';
import { GRAVITY, MOVE_SPEED, ACCEL, DECEL, MAP_WIDTH, MAP_DEPTH } from '../shared/constants.js';
import { KeyBit, SurfaceType } from '../shared/protocol.js';
import { HELI_PILOT_OFFSET, HELI_PASSENGER_SLOTS } from './ServerHelicopter.js';

const PLAYER_JUMP_SPEED = 4; // Matches Player.js (not the shared constant)

// Reusable vectors (avoid per-frame allocation)
const _forward = new THREE.Vector3();
const _right   = new THREE.Vector3();
const _yawQuat = new THREE.Quaternion();
const _moveDir = new THREE.Vector3();
const _yAxis   = new THREE.Vector3(0, 1, 0);
const _raycaster = new THREE.Raycaster();
const _shotOrigin = new THREE.Vector3();
const _shotDir = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _tmpVec = new THREE.Vector3();
const _tmpQuat = new THREE.Quaternion();
const _aimDirVec = new THREE.Vector3();

/**
 * Server-side player entity.
 * Extends ServerSoldier with input processing, movement, and shooting.
 * Replicates Player.js movement logic on the server for authoritative control.
 */
export class ServerPlayer extends ServerSoldier {
    constructor(physics, team, id, clientId, playerName, weaponId) {
        super(physics, team, id, true);  // kinematic body — prevents physics drift
        this.addToPhysics(); // Player needs body in physics world for raycast hit detection

        this.isPlayer = true;
        this.clientId = clientId;
        this.playerName = playerName;
        this.weaponId = weaponId;

        // Set weapon model on collision mesh
        this.setWeaponModel(weaponId);

        // Movement
        const def = WeaponDefs[weaponId];
        this.moveSpeed = MOVE_SPEED * (def?.moveSpeedMult || 1.0);
        this.yaw = 0;
        this.pitch = 0;
        this._velX = 0;
        this._velZ = 0;
        this.isJumping = false;
        this.jumpVelY = 0;
        this._prevJump = false;

        // Weapon state
        this.currentAmmo = def?.magazineSize || 30;
        this.magazineSize = def?.magazineSize || 30;
        this.isReloading = false;
        this.reloadTimer = 0;
        this.fireTimer = 0;
        this.isBolting = false;
        this.boltTimer = 0;
        this.currentSpread = def?.baseSpread || 0.003;
        this.triggerHeld = false;

        // Grenade
        this.grenadeCount = WeaponDefs.GRENADE?.maxPerLife || 2;
        this.grenadeCooldown = 0;
        this._prevGrenade = false;
        this._grenadeThrowTimer = 0;

        // Input
        this._latestInput = null;
        this._lastProcessedTick = 0;
        this._prevInteract = false;

        // Terrain/nav references (set by ServerGame after creation)
        this.getHeightAt = null;
        this.navGrid = null;
    }

    /**
     * Buffer an input packet from the client.
     */
    receiveInput(input) {
        this._latestInput = input;
    }

    /**
     * Process the buffered input for this tick.
     * @param {number} dt - Tick interval
     * @param {THREE.Object3D[]} collidables - Terrain/cover meshes for raycast
     * @param {ServerSoldier[]} allSoldiers - All entities for shooting targets
     * @param {Array} eventQueue - Event queue for kills/grenades
     * @param {object} grenadeManager - ServerGrenadeManager
     */
    processInput(dt, collidables, allSoldiers, eventQueue, grenadeManager, vehicleMeshes) {
        const input = this._latestInput;
        if (!input || !this.alive) return;

        this._lastProcessedTick = input.tick;

        // Validate yaw/pitch — reject NaN/Infinity and clamp to valid range
        if (!Number.isFinite(input.yaw) || !Number.isFinite(input.pitch)) return;
        const clampedPitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, input.pitch));
        // Normalize yaw to [-PI, PI]
        let normalizedYaw = input.yaw % (2 * Math.PI);
        if (normalizedYaw > Math.PI) normalizedYaw -= 2 * Math.PI;
        else if (normalizedYaw < -Math.PI) normalizedYaw += 2 * Math.PI;

        // Update yaw/pitch from client
        this.yaw = normalizedYaw;
        this.pitch = clampedPitch;

        // Update mesh rotation to match (for accurate raycasting next tick)
        if (this.upperBody) this.upperBody.rotation.y = this.yaw;
        if (this.shoulderPivot) this.shoulderPivot.rotation.x = this.pitch;

        // Extract key bits
        const keys = input.keys;
        const forward  = !!(keys & KeyBit.FORWARD);
        const backward = !!(keys & KeyBit.BACKWARD);
        const left     = !!(keys & KeyBit.LEFT);
        const right    = !!(keys & KeyBit.RIGHT);
        const jump     = !!(keys & KeyBit.JUMP);
        const fire     = !!(keys & KeyBit.FIRE);
        const reload   = !!(keys & KeyBit.RELOAD);
        const grenade  = !!(keys & KeyBit.GRENADE);

        // Movement
        this._handleMovement(dt, forward, backward, left, right, jump);

        // Timers
        if (this.grenadeCooldown > 0) this.grenadeCooldown -= dt;
        if (this._grenadeThrowTimer > 0) this._grenadeThrowTimer -= dt;

        // Shooting (blocked during grenade throw)
        if (this._grenadeThrowTimer <= 0) {
            this._handleShooting(dt, fire, collidables, allSoldiers, eventQueue, vehicleMeshes);
        }

        // Reload
        if (reload) this._startReload();

        // Grenade
        this._handleGrenade(grenade, grenadeManager, eventQueue);
    }

    _handleMovement(dt, forward, backward, left, right, jump) {
        const pos = this.body.position;
        const getH = this.getHeightAt;
        if (!getH) return;

        const groundY = getH(pos.x, pos.z);

        // Handle jumping (manual parabola)
        if (this.isJumping) {
            this.jumpVelY -= GRAVITY * dt;
            pos.y += this.jumpVelY * dt;
            if (pos.y <= groundY + 0.05) {
                pos.y = groundY + 0.05;
                this.isJumping = false;
                this.jumpVelY = 0;
            }
        }

        // Build move direction from yaw
        _forward.set(0, 0, -1);
        _right.set(1, 0, 0);
        _yawQuat.setFromAxisAngle(_yAxis, this.yaw);
        _forward.applyQuaternion(_yawQuat);
        _right.applyQuaternion(_yawQuat);

        _moveDir.set(0, 0, 0);
        if (forward)  _moveDir.add(_forward);
        if (backward) _moveDir.sub(_forward);
        if (left)     _moveDir.sub(_right);
        if (right)    _moveDir.add(_right);

        // Jump (edge-triggered)
        if (jump && !this._prevJump && !this.isJumping) {
            this.isJumping = true;
            this.jumpVelY = PLAYER_JUMP_SPEED;
        }
        this._prevJump = jump;

        // Target velocity
        let targetVX = 0, targetVZ = 0;
        if (_moveDir.lengthSq() > 0) {
            _moveDir.normalize();
            targetVX = _moveDir.x * this.moveSpeed;
            targetVZ = _moveDir.z * this.moveSpeed;
        }

        // Inertia lerp
        const rate = (targetVX !== 0 || targetVZ !== 0) ? ACCEL : DECEL;
        const t = Math.min(1, rate * dt);
        this._velX += (targetVX - this._velX) * t;
        this._velZ += (targetVZ - this._velZ) * t;

        // Snap to zero when very slow
        if (this._velX * this._velX + this._velZ * this._velZ < 0.01) {
            this._velX = 0;
            this._velZ = 0;
            if (!this.isJumping) pos.y = groundY + 0.05;
            return;
        }

        // Position update
        let finalX = pos.x + this._velX * dt;
        let finalZ = pos.z + this._velZ * dt;

        // NavGrid collision with axis-separated sliding
        if (this.navGrid) {
            const g = this.navGrid.worldToGrid(finalX, finalZ);
            if (!this.navGrid.isWalkable(g.col, g.row)) {
                const gX = this.navGrid.worldToGrid(finalX, pos.z);
                const gZ = this.navGrid.worldToGrid(pos.x, finalZ);
                if (this.navGrid.isWalkable(gX.col, gX.row)) {
                    finalZ = pos.z;
                } else if (this.navGrid.isWalkable(gZ.col, gZ.row)) {
                    finalX = pos.x;
                } else {
                    return; // fully blocked
                }
            }
        }

        // Map boundary clamp
        const halfW = MAP_WIDTH / 2;
        const halfD = MAP_DEPTH / 2;
        finalX = Math.max(-halfW, Math.min(halfW, finalX));
        finalZ = Math.max(-halfD, Math.min(halfD, finalZ));

        // Slope check
        const newGroundY = getH(finalX, finalZ);
        const slopeRise = newGroundY - pos.y;
        const stepX = finalX - pos.x;
        const stepZ = finalZ - pos.z;
        const slopeRun = Math.sqrt(stepX * stepX + stepZ * stepZ);
        const slopeAngle = slopeRun > 0.001 ? Math.atan2(slopeRise, slopeRun) : 0;
        const maxClimbAngle = Math.PI * 0.42; // ~75°

        if (slopeAngle < maxClimbAngle) {
            pos.x = finalX;
            pos.z = finalZ;
            if (!this.isJumping) pos.y = newGroundY + 0.05;
        } else {
            // Steep terrain — auto jump
            if (!this.isJumping) {
                this.isJumping = true;
                this.jumpVelY = 2.5;
                pos.x += _moveDir.x * this.moveSpeed * 0.3 * dt;
                pos.z += _moveDir.z * this.moveSpeed * 0.3 * dt;
            }
        }

        // Zero cannon-es velocity so physics.step() doesn't drift the body.
        // Movement is fully manual (direct position setting), so body.velocity
        // should always be zero. Without this, gravity and collision impulses
        // accumulate in velocity, causing ~0.07m/tick position drift.
        this.body.velocity.set(0, 0, 0);
    }

    _handleShooting(dt, fire, collidables, allSoldiers, eventQueue, vehicleMeshes) {
        const def = WeaponDefs[this.weaponId];
        if (!def) return;

        // Update fire timer
        if (this.fireTimer > 0) this.fireTimer -= dt;

        // Reloading
        if (this.isReloading) {
            this.reloadTimer -= dt;
            if (this.reloadTimer <= 0) {
                this.isReloading = false;
                this.currentAmmo = this.magazineSize;
            }
            return;
        }

        // Bolt cycling
        if (this.isBolting) {
            this.boltTimer -= dt;
            if (this.boltTimer <= 0) this.isBolting = false;
            return;
        }

        // Spread recovery (when not firing)
        if (!fire) {
            this.triggerHeld = false;
            this.currentSpread = Math.max(
                def.baseSpread,
                this.currentSpread - def.spreadRecoveryRate * dt
            );
        } else {
            this.triggerHeld = true;
        }

        if (!fire || this.fireTimer > 0 || this.currentAmmo <= 0) return;

        // Fire!
        this.currentAmmo--;
        this.fireTimer = 60 / def.fireRate;

        // Apply spread
        const spreadX = (Math.random() - 0.5) * this.currentSpread * 2;
        const spreadY = (Math.random() - 0.5) * this.currentSpread * 2;

        // Shot origin = eye position
        _shotOrigin.set(
            this.body.position.x,
            this.body.position.y + this.cameraHeight,
            this.body.position.z
        );

        // Aim direction from yaw/pitch
        _shotDir.set(0, 0, -1);
        _euler.set(this.pitch, this.yaw, 0);
        _shotDir.applyEuler(_euler);

        // Apply spread
        _shotDir.x += spreadX;
        _shotDir.y += spreadY;
        _shotDir.normalize();

        // Raycast
        _raycaster.set(_shotOrigin, _shotDir);
        _raycaster.far = def.maxRange;
        _raycaster.near = 0;

        // Build target list: collidables + all soldier meshes except self + vehicle meshes
        const targets = [...collidables];
        for (const s of allSoldiers) {
            if (s !== this && s.alive && s.mesh) {
                targets.push(s.mesh);
            }
        }
        if (vehicleMeshes) {
            for (const vm of vehicleMeshes) targets.push(vm);
        }

        const hits = _raycaster.intersectObjects(targets, true);

        let hitDist = def.maxRange;
        let hitSoldier = null;
        let hitVehicle = null;
        let hitPoint = null;

        if (hits.length > 0) {
            const hit = hits[0];
            hitDist = hit.distance;
            hitPoint = hit.point;

            // Classify hit — check soldier first, then vehicle
            const soldierRef = hit.object.userData?.soldierRef;
            if (soldierRef && soldierRef !== this && soldierRef.alive) {
                hitSoldier = soldierRef;
            } else {
                // Walk up parent chain to find vehicle userData
                let obj = hit.object;
                while (obj) {
                    if (obj.userData?.vehicle) {
                        hitVehicle = obj.userData.vehicle;
                        break;
                    }
                    obj = obj.parent;
                }
            }
        }

        // Push FIRED event for client VFX
        // Friendly hits count as MISS (no hit marker, no blood VFX)
        let surfaceType = SurfaceType.MISS;
        if (hitSoldier && hitSoldier.team !== this.team) {
            surfaceType = SurfaceType.CHARACTER;
        } else if (hitVehicle && hitVehicle.team !== this.team) {
            surfaceType = SurfaceType.VEHICLE;
        } else if (hits.length > 0 && !hitSoldier && !hitVehicle) {
            // Read surfaceType from hit object (same as single-player Weapon.js)
            const hit = hits[0];
            let obj = hit.object;
            let surface = 'terrain';
            while (obj) {
                if (obj.userData?.surfaceType) { surface = obj.userData.surfaceType; break; }
                obj = obj.parent;
            }
            surfaceType = surface === 'water' ? SurfaceType.WATER
                : surface === 'rock' ? SurfaceType.ROCK
                : SurfaceType.TERRAIN;
        }
        eventQueue.push({
            type: 'fired',
            shooterId: this._entityId,
            originX: _shotOrigin.x, originY: _shotOrigin.y, originZ: _shotOrigin.z,
            dirX: _shotDir.x, dirY: _shotDir.y, dirZ: _shotDir.z,
            hitDist: hitDist,
            surfaceType,
        });

        // Apply damage to soldier (no friendly fire)
        if (hitSoldier && hitSoldier.team !== this.team) {
            const rawDmg = applyFalloff(
                def.damage, hitDist,
                def.falloffStart, def.falloffEnd, def.falloffMinScale
            );
            const result = hitSoldier.takeDamage(rawDmg, _shotOrigin, hitPoint?.y, this);

            if (result.killed && this.eventBus) {
                this.eventBus.emit('kill', {
                    killerName: this.playerName,
                    killerTeam: this.team,
                    victimName: hitSoldier.playerName || `${hitSoldier.team === 'teamA' ? 'A' : 'B'}-${hitSoldier.id}`,
                    victimTeam: hitSoldier.team,
                    weapon: this.weaponId,
                    headshot: result.headshot,
                    killerEntityId: this._entityId,
                    victimEntityId: hitSoldier._entityId,
                });
            }
        }

        // Apply damage to vehicle (no friendly fire)
        if (hitVehicle && hitVehicle.alive && hitVehicle.team !== this.team) {
            const rawDmg = applyFalloff(
                def.damage, hitDist,
                def.falloffStart, def.falloffEnd, def.falloffMinScale
            );
            hitVehicle.takeDamage(rawDmg, this._entityId, this.playerName, this.team);
        }

        // Increase spread
        this.currentSpread = Math.min(
            def.maxSpread,
            this.currentSpread + def.spreadIncreasePerShot
        );
        if (def.minSpread !== undefined) {
            this.currentSpread = Math.max(def.minSpread, this.currentSpread);
        }

        // Bolt action cycling
        if (def.boltTime && this.currentAmmo > 0) {
            this.isBolting = true;
            this.boltTimer = def.boltTime;
        }

        // Auto-reload when empty
        if (this.currentAmmo <= 0) {
            this._startReload();
        }
    }

    _startReload() {
        if (this.isReloading || this.currentAmmo >= this.magazineSize) return;
        const def = WeaponDefs[this.weaponId];
        if (!def) return;
        this.isReloading = true;
        this.reloadTimer = def.reloadTime;
    }

    _handleGrenade(pressed, grenadeManager, eventQueue) {
        if (!pressed || this._prevGrenade) {
            this._prevGrenade = pressed;
            return;
        }
        this._prevGrenade = pressed;

        if (this.grenadeCount <= 0 || this.grenadeCooldown > 0) return;
        if (!grenadeManager) return;

        const def = WeaponDefs.GRENADE;
        const origin = new THREE.Vector3(
            this.body.position.x,
            this.body.position.y + this.cameraHeight,
            this.body.position.z
        );

        const dir = new THREE.Vector3(0, 0, -1);
        _euler.set(this.pitch, this.yaw, 0);
        dir.applyEuler(_euler);

        const velocity = dir.multiplyScalar(def.throwSpeed);
        velocity.x += this._velX;
        velocity.z += this._velZ;

        grenadeManager.spawn(origin, velocity, def.fuseTime, this.team, this.playerName, this._entityId);
        this.grenadeCount--;
        this.grenadeCooldown = 1;
        this._grenadeThrowTimer = 0.5;
    }

    /**
     * Process input while piloting a vehicle.
     * Maps WASD/Space/Shift to vehicle controls, blocks shooting.
     */
    processVehicleInput(dt, vehicle) {
        const input = this._latestInput;
        if (!input || !this.alive) return;

        this._lastProcessedTick = input.tick;
        this.yaw = input.yaw;
        this.pitch = input.pitch;

        const keys = input.keys;
        const vInput = {
            thrust:     (keys & KeyBit.FORWARD) ? 1 : 0,
            brake:      (keys & KeyBit.BACKWARD) ? 1 : 0,
            steerLeft:  !!(keys & KeyBit.LEFT),
            steerRight: !!(keys & KeyBit.RIGHT),
            ascend:     !!(keys & KeyBit.JUMP),
            descend:    !!(keys & KeyBit.SPRINT),
        };

        vehicle.applyInput(vInput, dt);

        // Sync player body + mesh to vehicle seat position (for snapshot + hit detection)
        if (vehicle.type === 'helicopter') {
            vehicle.getWorldSeatPos(_tmpVec, HELI_PILOT_OFFSET);
            this.body.position.set(_tmpVec.x, _tmpVec.y, _tmpVec.z);
            this.mesh.position.copy(_tmpVec);
            // Tilt with helicopter (yaw+pitch+roll via cached quaternion)
            this.mesh.quaternion.copy(vehicle._cachedWorldQuat);
            // Body faces forward relative to helicopter
            if (this.lowerBody) this.lowerBody.rotation.y = Math.PI;
            if (this.upperBody) {
                this.upperBody.rotation.y = Math.PI;
                if (this.shoulderPivot) this.shoulderPivot.rotation.x = 0;
            }
            // Legs forward 90° (sitting pose)
            if (this.leftLeg) this.leftLeg.rotation.x = Math.PI / 2;
            if (this.rightLeg) this.rightLeg.rotation.x = Math.PI / 2;
        } else {
            const vp = vehicle.mesh.position;
            this.body.position.set(vp.x, vp.y, vp.z);
        }
    }

    /**
     * Process input while a passenger in a vehicle.
     * Can shoot (with side restriction for helicopters), but no movement.
     */
    processPassengerInput(dt, vehicle, collidables, allSoldiers, eventQueue, vehicleMeshes) {
        const input = this._latestInput;
        if (!input || !this.alive) return;

        this._lastProcessedTick = input.tick;
        this.yaw = input.yaw;
        this.pitch = input.pitch;

        const keys = input.keys;
        const fire = !!(keys & KeyBit.FIRE);
        const reload = !!(keys & KeyBit.RELOAD);

        // Sync body + mesh to seat BEFORE shooting (so shot origin is correct)
        if (vehicle.type === 'helicopter') {
            const slotIdx = vehicle.passengers.indexOf(this);
            if (slotIdx >= 0 && slotIdx < HELI_PASSENGER_SLOTS.length) {
                const slot = HELI_PASSENGER_SLOTS[slotIdx];
                vehicle.getWorldSeatPos(_tmpVec, slot);
                this.body.position.set(_tmpVec.x, _tmpVec.y, _tmpVec.z);
                this.mesh.position.copy(_tmpVec);
                // Tilt with helicopter (yaw+pitch+roll via cached quaternion)
                this.mesh.quaternion.copy(vehicle._cachedWorldQuat);
                // Lower body: outward relative to helicopter
                if (this.lowerBody) this.lowerBody.rotation.y = slot.facingOffset;
                // Convert world-space aim (yaw/pitch) to helicopter-local space
                if (this.upperBody) {
                    const cp = Math.cos(this.pitch);
                    _aimDirVec.set(
                        -Math.sin(this.yaw) * cp,
                        Math.sin(this.pitch),
                        -Math.cos(this.yaw) * cp
                    );
                    _tmpQuat.copy(vehicle._cachedWorldQuat).invert();
                    _aimDirVec.applyQuaternion(_tmpQuat);
                    this.upperBody.rotation.y = Math.atan2(-_aimDirVec.x, -_aimDirVec.z);
                    if (this.shoulderPivot) {
                        const hd = Math.sqrt(_aimDirVec.x * _aimDirVec.x + _aimDirVec.z * _aimDirVec.z);
                        this.shoulderPivot.rotation.x = Math.atan2(_aimDirVec.y, hd);
                    }
                }
                // Legs forward 45° (sitting pose)
                if (this.leftLeg) this.leftLeg.rotation.x = Math.PI / 4;
                if (this.rightLeg) this.rightLeg.rotation.x = Math.PI / 4;
            }
        } else {
            const vp = vehicle.mesh.position;
            this.body.position.set(vp.x, vp.y, vp.z);
            if (this.upperBody) this.upperBody.rotation.y = this.yaw;
            if (this.shoulderPivot) this.shoulderPivot.rotation.x = this.pitch;
        }

        // Check side restriction for helicopter passengers
        let sideBlocked = false;
        if (vehicle.type === 'helicopter') {
            const slotIdx = vehicle.passengers.indexOf(this);
            if (slotIdx >= 0) {
                const isLeftSeat = slotIdx % 2 === 0;
                // Compute aim direction
                _shotDir.set(0, 0, -1);
                _euler.set(this.pitch, this.yaw, 0);
                _shotDir.applyEuler(_euler);
                const rY = vehicle.rotationY;
                const cross = Math.sin(rY) * _shotDir.z - Math.cos(rY) * _shotDir.x;
                sideBlocked = isLeftSeat ? cross < 0 : cross > 0;
            }
        }

        // Always call _handleShooting so reload/bolt timers keep ticking
        // (matches single-player: _handleShooting always called, canFire controls firing)
        this._handleShooting(dt, sideBlocked ? false : fire, collidables, allSoldiers, eventQueue, vehicleMeshes);

        if (reload) this._startReload();
    }

    respawn(position) {
        super.respawn(position);
        this.addToPhysics(); // Kinematic body removed by super.respawn(); re-add for raycast

        // Reset weapon state
        const def = WeaponDefs[this.weaponId];
        this.currentAmmo = this.magazineSize;
        this.isReloading = false;
        this.reloadTimer = 0;
        this.fireTimer = 0;
        this.isBolting = false;
        this.boltTimer = 0;
        this.currentSpread = def?.baseSpread || 0.003;
        this.triggerHeld = false;
        this._velX = 0;
        this._velZ = 0;
        this.isJumping = false;
        this.jumpVelY = 0;
        this._prevJump = true; // suppress jump on spawn frame
        this.grenadeCount = WeaponDefs.GRENADE?.maxPerLife || 2;
        this.grenadeCooldown = 0;
        this._prevGrenade = false;
        this._grenadeThrowTimer = 0;
        this._latestInput = null;
    }
}
