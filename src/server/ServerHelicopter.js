import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const GRAVITY = 9.82;
const WATER_Y = -0.3;
const MAP_HALF_W = 150;
const MAP_HALF_D = 60;
const _cannonYAxis = new CANNON.Vec3(0, 1, 0);
const _euler = new THREE.Euler();
const _threeQuat = new THREE.Quaternion();

export const HELI_PILOT_OFFSET = { x: 0, y: -1.08, z: 1.78 };

export const HELI_PASSENGER_SLOTS = [
    { x: -0.90, y: -1.20, z:  0.24, facingOffset:  Math.PI / 2 },
    { x:  0.90, y: -1.20, z:  0.24, facingOffset: -Math.PI / 2 },
    { x: -0.90, y: -1.20, z: -0.84, facingOffset:  Math.PI / 2 },
    { x:  0.90, y: -1.20, z: -0.84, facingOffset: -Math.PI / 2 },
];

/**
 * Server-side helicopter entity.
 * Authoritative physics, collision mesh for raycasting, occupant management.
 * Ported from single-player Helicopter.js + Vehicle.js.
 */
export class ServerHelicopter {
    constructor(vehicleId, spawnPosition) {
        this.vehicleId = vehicleId;
        this.type = 'helicopter';
        this.team = null;     // neutral until first occupant boards

        // Health
        this.maxHP = 12000;
        this.hp = this.maxHP;
        this.alive = true;

        // Occupants
        this.driver = null;
        this.passengers = [];
        this.maxPassengers = 4;
        this.enterRadius = 3.6;

        // AI perception
        this.detectionRange = 120;
        this.visibilityRange = 120;

        // Flight parameters
        this.maxHSpeed = 45;
        this.maxVSpeed = 8;
        this.hAccel = 14;
        this.vAccel = 14;
        this.hDrag = 2.2;
        this.vDrag = 4;
        this.turnSpeed = 2.2;
        this.minAltitude = WATER_Y + 1;
        this.maxAltitude = 30;

        // Velocity
        this.velX = 0;
        this.velZ = 0;
        this.velocityY = 0;
        this.speed = 0;
        this.altitude = spawnPosition.y;

        // Rotation
        this.rotationY = 0;

        // Visual attitude (synced to client)
        this._visualPitch = 0;
        this._visualRoll = 0;
        this._yawRate = 0;
        this._inputThrust = 0;
        this._inputBrake = 0;

        // Crash state
        this._crashing = false;
        this._wreckageTimer = 0;

        // Spawn
        this.spawnPosition = spawnPosition.clone();
        this.spawnRotationY = 0;
        this.respawnTimer = 0;
        this.respawnDelay = 45;
        this.spawnFlag = null;

        // Event bus — set by ServerVehicleManager
        this.eventBus = null;

        // Terrain height lookup — set by ServerVehicleManager
        this.getHeightAt = null;
        this._groundY = 0;
        this._waterIdleTimer = 0;

        // Physics body
        this.body = null;
        this._physics = null;
        this._preStepListener = null;

        // Collision mesh — full helicopter geometry for raycasting (not added to scene)
        this.mesh = this._createCollisionMesh();
        this.mesh.userData.vehicle = this;
        this.mesh.userData.surfaceType = 'rock';
        this.mesh.position.copy(spawnPosition);
        this.mesh.position.y = spawnPosition.y + 1.32;

        // Attitude sub-group inside mesh (used for pitch/roll on collision mesh)
        // _attitudeGroup is created in _createCollisionMesh

        // Cached world quaternion for AI seat positioning
        this._cachedWorldQuat = new THREE.Quaternion();
    }

    initPhysicsBody(physics) {
        this._physics = physics;

        this.body = new CANNON.Body({
            mass: 300,
            type: CANNON.Body.DYNAMIC,
            collisionFilterGroup: 4,
            collisionFilterMask: 5,
            linearDamping: 0.5,
            angularDamping: 0.0,
            allowSleep: false,
        });

        // Main fuselage box (cabin + nose area) — original ×1.2
        this.body.addShape(
            new CANNON.Box(new CANNON.Vec3(1.08, 0.84, 3.0)),
            new CANNON.Vec3(0, -0.18, 0)
        );
        // Nose cone — original ×1.2
        this.body.addShape(
            new CANNON.Box(new CANNON.Vec3(0.6, 0.6, 0.6)),
            new CANNON.Vec3(0, -0.24, 3.36)
        );
        // Tail boom — original ×1.2
        this.body.addShape(
            new CANNON.Box(new CANNON.Vec3(0.24, 0.24, 2.16)),
            new CANNON.Vec3(0, 0.12, -3.84)
        );

        this._syncBody();
        physics.addBody(this.body);

        this._preStepListener = () => {
            if (!this.body || !this.alive || this._crashing) return;
            this.body.force.y += this.body.mass * GRAVITY;
        };
        physics.world.addEventListener('preStep', this._preStepListener);
    }

    // ── Collision Mesh (for raycasting — mirrors client Helicopter._createMesh) ──

    _createCollisionMesh() {
        const mat = (c, opts) => new THREE.MeshLambertMaterial({ color: c, flatShading: true, ...opts });

        const group = new THREE.Group();
        this._attitudeGroup = new THREE.Group();
        group.add(this._attitudeGroup);

        const hullRot = new THREE.Matrix4().makeRotationY(Math.PI);
        const place = (geo, x, y, z) => {
            const m = new THREE.Matrix4().makeTranslation(x, y, z);
            m.premultiply(hullRot);
            return geo.applyMatrix4(m);
        };

        const odGeos = [];
        const dkGeos = [];

        // Cabin — original ×1.2
        odGeos.push(place(new THREE.BoxGeometry(2.16, 0.144, 3.12), 0, -0.66, 0));
        odGeos.push(place(new THREE.BoxGeometry(2.16, 0.144, 3.12), 0, 0.78, 0));
        odGeos.push(place(new THREE.BoxGeometry(2.16, 1.44, 0.144), 0, 0.06, 1.56));

        // Cockpit bulkhead (half-height, protects pilot lower body)
        odGeos.push(place(new THREE.BoxGeometry(2.16, 0.72, 0.144), 0, -0.30, -1.56));

        // Door-frame pillars — original ×1.2
        odGeos.push(place(new THREE.BoxGeometry(0.096, 1.44, 0.096), -1.08, 0.06, -1.50));
        odGeos.push(place(new THREE.BoxGeometry(0.096, 1.44, 0.096), 1.08, 0.06, -1.50));

        // Nose frame bars
        const noseLen = 1.8;
        const noseCZ = -2.46;
        const TAPER = 0.4;
        const edgeStrip = (stripW, h, centerY, xPos) => {
            const geo = new THREE.BoxGeometry(stripW, h, noseLen);
            const pos = geo.attributes.position;
            const halfD = noseLen / 2;
            const noseCenterY = 0.0;
            const relY = noseCenterY - centerY;
            for (let i = 0; i < pos.count; i++) {
                const z = pos.getZ(i);
                const t = (halfD - z) / noseLen;
                const s = 1 - t * TAPER;
                pos.setX(i, xPos * s + pos.getX(i) * s);
                const y = pos.getY(i);
                pos.setY(i, y + (relY - y) * t * TAPER);
            }
            pos.needsUpdate = true;
            geo.computeVertexNormals();
            return geo;
        };
        odGeos.push(place(edgeStrip(0.12, 0.12, 0.0, -1.08), 0, 0.0, noseCZ));
        odGeos.push(place(edgeStrip(0.12, 0.12, 0.0,  1.08), 0, 0.0, noseCZ));
        const frontW = 2.04 * (1 - TAPER);
        odGeos.push(place(new THREE.BoxGeometry(frontW, 0.12, 0.12), 0, 0.0, -3.36));
        odGeos.push(place(new THREE.BoxGeometry(0.12, 0.348, 0.12), 0, -0.174, -3.36));
        const kbGeo = new THREE.BoxGeometry(0.18, 0.072, noseLen);
        kbGeo.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.atan2(0.235, noseLen)));
        odGeos.push(place(kbGeo, 0, -0.530, noseCZ));

        // Tail + fin + stabilizer + mast — original ×1.2
        odGeos.push(place(new THREE.BoxGeometry(0.42, 0.42, 4.2), 0, 0.12, 3.84));
        odGeos.push(place(new THREE.BoxGeometry(0.12, 1.2, 0.84), 0, 0.84, 5.88));
        odGeos.push(place(new THREE.BoxGeometry(1.68, 0.096, 0.6), 0, 0.18, 5.88));
        odGeos.push(place(new THREE.CylinderGeometry(0.072, 0.072, 0.42, 6), 0, 0.96, 0));

        // Landing skids — original ×1.2
        for (const side of [-1, 1]) {
            dkGeos.push(place(new THREE.BoxGeometry(0.096, 0.096, 3.6), side * 1.14, -1.2, -0.24));
            for (const zOff of [-0.96, 0.72]) {
                dkGeos.push(place(new THREE.BoxGeometry(0.072, 0.54, 0.072), side * 1.14, -0.90, zOff));
            }
        }

        const odMerged = mergeGeometries(odGeos);
        this._attitudeGroup.add(new THREE.Mesh(odMerged, mat(0x4a5a2a)));

        const dkMerged = mergeGeometries(dkGeos);
        this._attitudeGroup.add(new THREE.Mesh(dkMerged, mat(0x333333)));

        // Team stripe — original ×1.2
        const stripeGeo = new THREE.BoxGeometry(0.432, 0.432, 0.96);
        place(stripeGeo, 0, 0.12, 4.8);
        this._attitudeGroup.add(new THREE.Mesh(stripeGeo, mat(0x888888)));

        // Nose glass (truncated pyramid) — original ×1.2
        const halfLen = noseLen / 2;
        const bx = 1.08, bTop = 0.708, bBot = -0.588;
        const fx = bx * (1 - TAPER);
        const fTop = bTop * (1 - TAPER);
        const fBot = bBot * (1 - TAPER);
        const glassGeo = new THREE.BufferGeometry();
        glassGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
            -bx, bBot,  halfLen,   bx, bBot,  halfLen,
            -bx, bTop,  halfLen,   bx, bTop,  halfLen,
            -fx, fBot, -halfLen,   fx, fBot, -halfLen,
            -fx, fTop, -halfLen,   fx, fTop, -halfLen,
        ]), 3));
        glassGeo.setIndex([
            2,7,6, 2,3,7, 0,4,5, 0,5,1, 0,2,6, 0,6,4, 3,1,5, 3,5,7, 6,7,5, 6,5,4,
        ]);
        glassGeo.computeVertexNormals();
        place(glassGeo, 0, 0, noseCZ);
        this._attitudeGroup.add(new THREE.Mesh(glassGeo, mat(0x111111, { transparent: true, opacity: 0.5 })));

        // Dispose geometry arrays to free memory
        for (const g of odGeos) g.dispose();
        for (const g of dkGeos) g.dispose();

        return group;
    }

    // ── Position helpers ──

    getPosition() {
        return this.mesh.position.clone();
    }

    getYawSeatPos(out, offset) {
        const c = Math.cos(this.rotationY);
        const s = Math.sin(this.rotationY);
        const vp = this.mesh.position;
        out.x = vp.x + offset.x * c + offset.z * s;
        out.y = vp.y + offset.y;
        out.z = vp.z - offset.x * s + offset.z * c;
    }

    getWorldSeatPos(out, offset) {
        out.set(offset.x, offset.y, offset.z);
        this._attitudeGroup.updateWorldMatrix(true, false);
        this._attitudeGroup.localToWorld(out);
    }

    _syncBody() {
        if (!this.body) return;
        const p = this.mesh.position;
        this.body.position.set(p.x, p.y, p.z);
        this.body.quaternion.setFromAxisAngle(_cannonYAxis, this.rotationY);
    }

    /** Sync mesh position/rotation from body + attitude. For raycasting. */
    syncMesh() {
        if (!this.alive && !this._crashing) return;
        if (this._crashing) {
            // Server no longer simulates crash physics (moved to client-side).
            // Mesh stays at last valid position; snapshot sends that to clients.
            return;
        }
        this.mesh.rotation.y = this.rotationY;
        this._attitudeGroup.rotation.x = this._visualPitch;
        this._attitudeGroup.rotation.z = this._visualRoll;
    }

    // ── Occupant management ──

    get occupantCount() {
        return (this.driver ? 1 : 0) + this.passengers.length;
    }

    canEnter(entity) {
        if (!this.alive || this._crashing) return false;
        if (this.team !== null && entity.team !== this.team) return false;
        if (this.occupantCount >= 5) return false;
        const pos = entity.getPosition();
        const vp = this.mesh.position;
        const dx = pos.x - vp.x;
        const dy = pos.y - vp.y;
        const dz = pos.z - vp.z;
        return (dx * dx + dy * dy + dz * dz) < this.enterRadius * this.enterRadius;
    }

    enter(entity) {
        if (!this.driver) {
            this.driver = entity;
            entity.seatIndex = -1; // pilot
        } else {
            // Assign first available seat slot
            const taken = new Set(this.passengers.map(p => p.seatIndex));
            let slot = 0;
            while (taken.has(slot)) slot++;
            entity.seatIndex = slot;
            this.passengers.push(entity);
        }
        entity.vehicle = this;
        if (entity.body) entity.body.collisionResponse = false;
        if (this.team === null) {
            this.team = entity.team;
        }
        this._waterIdleTimer = 0;
    }

    exit(entity, died = false) {
        entity.vehicle = null;
        entity.seatIndex = undefined;
        if (entity.body) entity.body.collisionResponse = true;

        if (this.driver === entity) {
            this.driver = null;
            // Only promote a passenger to pilot when driver died
            if (died && this.passengers.length > 0) {
                const newPilot = this.passengers.shift();
                newPilot.seatIndex = -1; // pilot seat
                this.driver = newPilot;
            }
        } else {
            const idx = this.passengers.indexOf(entity);
            if (idx >= 0) this.passengers.splice(idx, 1);
        }

        if (!this.driver && this.passengers.length === 0) {
            this.team = null;
        }

        // Return exit position (side of helicopter)
        const exitPos = this.mesh.position.clone();
        const sideAngle = this.rotationY + Math.PI / 2;
        exitPos.x += Math.cos(sideAngle) * 2.5;
        exitPos.z += Math.sin(sideAngle) * 2.5;
        return exitPos;
    }

    getAllOccupants() {
        const list = [];
        if (this.driver) list.push(this.driver);
        list.push(...this.passengers);
        return list;
    }

    canExitSafely(getHeightAtFn) {
        if (!this.mesh) return false;
        const groundY = getHeightAtFn(this.mesh.position.x, this.mesh.position.z);
        return (this.mesh.position.y - groundY) < 5;
    }

    // ── Damage & Destroy ──

    takeDamage(amount, attackerEntityId, attackerName, attackerTeam) {
        if (!this.alive) return { destroyed: false, damage: 0 };
        // Track last attacker for kill credit on vehicle destruction
        if (attackerEntityId !== undefined) {
            this._lastAttackerEntityId = attackerEntityId;
            this._lastAttackerName = attackerName;
            this._lastAttackerTeam = attackerTeam;
        }
        this.hp = Math.max(0, this.hp - amount);
        if (this.hp <= 0) {
            this.destroy();
            return { destroyed: true, damage: amount };
        }
        return { destroyed: false, damage: amount };
    }

    destroy() {
        this.alive = false;
        this.hp = 0;
        this._crashing = true;
        this._wreckageTimer = 0;

        // Apply random angular velocity for crash tumble, then capture kinematics
        let vx = 0, vy = 0, vz = 0, avx = 0, avy = 0, avz = 0;
        if (this.body) {
            this.body.linearDamping = 0.1;
            this.body.angularDamping = 0.3;
            this.body.angularVelocity.set(
                (Math.random() - 0.5) * 3,
                this.body.angularVelocity.y + (Math.random() - 0.5) * 2,
                (Math.random() - 0.5) * 3
            );
            vx = this.body.velocity.x;
            vy = this.body.velocity.y;
            vz = this.body.velocity.z;
            avx = this.body.angularVelocity.x;
            avy = this.body.angularVelocity.y;
            avz = this.body.angularVelocity.z;
        }

        this._killAllOccupants();

        // Emit destruction event with kinematics for client-side crash physics
        if (this.eventBus) {
            const p = this.mesh.position;
            this.eventBus.emit('vehicleDestroyed', {
                vehicleId: this.vehicleId,
                x: p.x, y: p.y, z: p.z,
                vx, vy, vz,
                avx, avy, avz,
            });
        }

        // Freeze server body — crash physics is now client-side
        if (this.body) {
            this.body.velocity.set(0, 0, 0);
            this.body.angularVelocity.set(0, 0, 0);
            this.body.force.set(0, 0, 0);
            this.body.torque.set(0, 0, 0);
            this.body.position.set(0, -999, 0);
        }
    }

    _killAllOccupants() {
        const occupants = this.getAllOccupants();
        for (const occ of occupants) {
            if (occ.body) occ.body.collisionResponse = true;
            if (occ.vehicle !== undefined) occ.vehicle = null;
            occ.seatIndex = undefined;
            if (occ.controller) {
                occ.controller.vehicle = null;
                occ.controller._vehicleMoveTarget = null;
                occ.controller._vehicleOrbitAngle = 0;
            }
            const wasAlive = occ.alive;
            if (occ.takeDamage) occ.takeDamage(9999);
            // Emit kill event for each occupant killed by vehicle destruction
            if (wasAlive && !occ.alive && this.eventBus) {
                const vTeam = occ.team || 'teamA';
                const isPlayer = occ.isPlayer;
                const victimName = isPlayer
                    ? (occ.playerName || occ.id)
                    : `${vTeam === 'teamA' ? 'A' : 'B'}-${occ.id}`;
                this.eventBus.emit('kill', {
                    killerName: this._lastAttackerName || '?',
                    killerTeam: this._lastAttackerTeam || 'teamA',
                    victimName,
                    victimTeam: vTeam,
                    headshot: false,
                    weapon: 'VEHICLE',
                    killerEntityId: this._lastAttackerEntityId ?? 0xFFFF,
                    victimEntityId: occ._entityId,
                });
            }
        }
        this.driver = null;
        this.passengers = [];
    }

    // ── Update ──

    update(dt) {
        if (this._crashing) {
            this._updateCrash(dt);
            return;
        }

        if (!this.alive) {
            this.respawnTimer -= dt;
            if (this.respawnTimer <= 0) {
                this.respawn();
            }
            return;
        }

        // Read position from physics body
        if (this.body) {
            const bp = this.body.position;
            this.mesh.position.set(bp.x, bp.y, bp.z);
            // Only clear forces for driverless helicopters;
            // driven ones clear inside applyInput() so forces survive until physics.step()
            if (!this.driver) {
                this.body.force.set(0, 0, 0);
                this.body.torque.set(0, 0, 0);
            }
        }

        // Unoccupied behavior
        if (!this.driver && this.passengers.length === 0) {
            if (this.body) {
                this.body.linearDamping = 0.8;
                this.body.force.y -= this.body.mass * GRAVITY;
            }
            this._yawRate *= Math.max(0, 1 - 5 * dt);
            if (this._groundY < WATER_Y) {
                this._waterIdleTimer += dt;
                if (this._waterIdleTimer >= 0.5) {
                    this.destroy();
                    return;
                }
            } else {
                this._waterIdleTimer = 0;
            }
        } else {
            if (this.body) this.body.linearDamping = 0.5;
        }

        // Sync velocity from body
        if (this.body) {
            this.velX = this.body.velocity.x;
            this.velZ = this.body.velocity.z;
            this.velocityY = this.body.velocity.y;
        }

        const fwdX = Math.sin(this.rotationY);
        const fwdZ = Math.cos(this.rotationY);
        this.speed = this.velX * fwdX + this.velZ * fwdZ;

        // Altitude constraints
        let floorY = this.minAltitude;
        if (this.getHeightAt) {
            this._groundY = this.getHeightAt(this.mesh.position.x, this.mesh.position.z);
            floorY = Math.max(floorY, this._groundY + 1.32);
        }
        if (this.mesh.position.y <= floorY) {
            this.mesh.position.y = floorY;
            if (this.body && this.body.velocity.y < 0) this.body.velocity.y = 0;
        }
        if (this.mesh.position.y >= this.maxAltitude) {
            this.mesh.position.y = this.maxAltitude;
            if (this.body && this.body.velocity.y > 0) this.body.velocity.y = 0;
        }

        // Map boundary clamp
        const px = this.mesh.position.x;
        const pz = this.mesh.position.z;
        if (px < -MAP_HALF_W) { this.mesh.position.x = -MAP_HALF_W; if (this.body && this.body.velocity.x < 0) this.body.velocity.x = 0; }
        if (px >  MAP_HALF_W) { this.mesh.position.x =  MAP_HALF_W; if (this.body && this.body.velocity.x > 0) this.body.velocity.x = 0; }
        if (pz < -MAP_HALF_D) { this.mesh.position.z = -MAP_HALF_D; if (this.body && this.body.velocity.z < 0) this.body.velocity.z = 0; }
        if (pz >  MAP_HALF_D) { this.mesh.position.z =  MAP_HALF_D; if (this.body && this.body.velocity.z > 0) this.body.velocity.z = 0; }

        this.altitude = this.mesh.position.y;

        // Sync body back + constrain to Y-only rotation
        if (this.body) {
            this.body.position.set(this.mesh.position.x, this.mesh.position.y, this.mesh.position.z);
            // Yaw damping — always apply (air resistance)
            this._yawRate *= Math.exp(-3 * dt);
            this.body.angularVelocity.x = 0;
            this.body.angularVelocity.z = 0;
            this.body.angularVelocity.y = this._yawRate;
            _euler.set(this._visualPitch, this.rotationY, this._visualRoll, 'YXZ');
            _threeQuat.setFromEuler(_euler);
            this.body.quaternion.set(_threeQuat.x, _threeQuat.y, _threeQuat.z, _threeQuat.w);
        }
        this.mesh.rotation.y = this.rotationY;

        // Visual attitude
        const pitchMax = 0.90;
        const speedPitch = (this.speed / this.maxHSpeed) * pitchMax * 0.7;
        const inputPitch = (this._inputThrust - this._inputBrake) * pitchMax * 0.3;
        const targetPitch = speedPitch + inputPitch - (this.velocityY / this.maxVSpeed) * 0.08;

        const lateralSpeed = -this.velX * fwdZ + this.velZ * fwdX;
        const rollMax = Math.PI / 3;
        const hSpeedMag = Math.sqrt(this.velX * this.velX + this.velZ * this.velZ);
        const speedFactor = Math.min(1, hSpeedMag / (this.maxHSpeed * 0.25));
        const yawNorm = Math.min(Math.max(this._yawRate / this.turnSpeed, -1), 1);
        const driftRoll = (lateralSpeed / this.maxHSpeed) * rollMax * 0.5;
        const targetRoll = -yawNorm * speedFactor * rollMax + driftRoll;

        const tiltLerp = 1 - Math.exp(-6 * dt);
        const recoverLerp = 1 - Math.exp(-3 * dt);
        const pitchLerp = Math.abs(targetPitch) > Math.abs(this._visualPitch) ? tiltLerp : recoverLerp;
        const rollLerp = Math.abs(targetRoll) > Math.abs(this._visualRoll) ? tiltLerp : recoverLerp;
        this._visualPitch += (targetPitch - this._visualPitch) * pitchLerp;
        this._visualRoll += (targetRoll - this._visualRoll) * rollLerp;

        this._attitudeGroup.rotation.x = this._visualPitch;
        this._attitudeGroup.rotation.z = this._visualRoll;

        // Update world matrices for all children so raycasts hit correctly
        this.mesh.updateMatrixWorld(true);
        // Cache world quaternion for AI seat positioning
        this._cachedWorldQuat.setFromRotationMatrix(this._attitudeGroup.matrixWorld);
    }

    applyInput(input, dt) {
        if (!this.alive || !this.body) return;

        // Clear previous tick's forces before applying new input
        this.body.force.set(0, 0, 0);
        this.body.torque.set(0, 0, 0);

        const mass = this.body.mass;
        const fwdX = Math.sin(this.rotationY);
        const fwdZ = Math.cos(this.rotationY);

        this._inputThrust = input.thrust || 0;
        this._inputBrake = input.brake || 0;

        if (input.thrust > 0) {
            this.body.force.x += fwdX * mass * this.hAccel * input.thrust;
            this.body.force.z += fwdZ * mass * this.hAccel * input.thrust;
        }
        if (input.brake > 0) {
            this.body.force.x -= fwdX * mass * this.hAccel * input.brake;
            this.body.force.z -= fwdZ * mass * this.hAccel * input.brake;
        }

        const hSpd = Math.sqrt(this.body.velocity.x ** 2 + this.body.velocity.z ** 2);
        if (hSpd > this.maxHSpeed) {
            const excess = (hSpd - this.maxHSpeed) / hSpd;
            this.body.force.x -= this.body.velocity.x * excess * mass * 10;
            this.body.force.z -= this.body.velocity.z * excess * mass * 10;
        }

        // Steering — yaw with inertia (damping handled in update())
        if (input.steerLeft || input.steerRight) {
            let targetYaw = 0;
            if (input.steerLeft) targetYaw = this.turnSpeed;
            if (input.steerRight) targetYaw = -this.turnSpeed;
            const yawAccel = 1 - Math.exp(-5 * dt);
            this._yawRate += (targetYaw - this._yawRate) * yawAccel;
        }
        this.rotationY += this._yawRate * dt;

        // Vertical thrust (ascendScale/descendScale: 0–1, default 1)
        if (input.ascend) {
            this.body.force.y += mass * this.vAccel * (input.ascendScale ?? 1);
        } else if (input.descend) {
            this.body.force.y -= mass * this.vAccel * (input.descendScale ?? 1);
        }
    }

    _updateCrash(dt) {
        // Server no longer simulates wreckage physics (moved to client-side).
        // Just count down the wreckage timer.
        this._wreckageTimer += dt;
        if (this._wreckageTimer >= 10) {
            this._crashing = false;
            this.respawnTimer = this.respawnDelay;
        }
    }

    respawn() {
        this.team = null;
        this.alive = true;
        this.hp = this.maxHP;
        this.speed = 0;
        this.velX = 0;
        this.velZ = 0;
        this.velocityY = 0;
        this.altitude = this.spawnPosition.y;
        this.rotationY = this.spawnRotationY;
        this._crashing = false;
        this._wreckageTimer = 0;
        this._visualPitch = 0;
        this._visualRoll = 0;
        this._yawRate = 0;
        this._waterIdleTimer = 0;
        this.passengers = [];

        this.mesh.position.copy(this.spawnPosition);
        this.mesh.position.y = this.spawnPosition.y + 1.32;
        this.mesh.rotation.set(0, this.rotationY, 0);
        this._attitudeGroup.rotation.set(0, 0, 0);

        if (this.body) {
            this.body.linearDamping = 0.5;
            this.body.angularDamping = 0.0;
            this.body.velocity.set(0, 0, 0);
            this.body.angularVelocity.set(0, 0, 0);
            this.body.force.set(0, 0, 0);
            this.body.torque.set(0, 0, 0);
            this.body.position.set(this.mesh.position.x, this.mesh.position.y, this.mesh.position.z);
            this.body.quaternion.setFromAxisAngle(_cannonYAxis, this.rotationY);
        }
    }

    // ── Snapshot ──

    _getPassengerIdBySeat(seatIdx) {
        for (const p of this.passengers) {
            if (p.seatIndex === seatIdx) return p._entityId;
        }
        return 0xFFFF;
    }

    getSnapshotData() {
        const p = this.mesh.position;
        return {
            vehicleId: this.vehicleId,
            alive: this.alive,
            crashing: this._crashing,
            team: this.team,
            x: p.x, y: p.y, z: p.z,
            yaw: this.rotationY,
            pitch: this._visualPitch,
            roll: this._visualRoll,
            hp: this.hp,
            pilotId: this.driver ? this.driver._entityId : 0xFFFF,
            passenger0: this._getPassengerIdBySeat(0),
            passenger1: this._getPassengerIdBySeat(1),
            passenger2: this._getPassengerIdBySeat(2),
            passenger3: this._getPassengerIdBySeat(3),
        };
    }
}
