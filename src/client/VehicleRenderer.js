import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const TEAM_COLORS = {
    teamA: 0x3366cc,
    teamB: 0xcc3333,
    neutral: 0x888888,
};

const SNAP_DIST_SQ = 20 * 20;    // snap if > 20 units away (e.g. after tab-hidden)

const ROTOR_SPEED_ACTIVE = 25;   // rad/s when occupied
const ROTOR_SPEED_IDLE = 8;      // rad/s when unoccupied but alive
const ROTOR_SPEED_CRASH = 3;     // rad/s when crashing
const TAIL_ROTOR_MULT = 1.5;

const CRASH_MAX_SPEED = 40;
const CRASH_MAX_SPEED_SQ = CRASH_MAX_SPEED * CRASH_MAX_SPEED;

export const HELI_PILOT_OFFSET = { x: 0, y: -1.08, z: 1.78 };

export const HELI_PASSENGER_SLOTS = [
    { x: -0.90, y: -1.20, z:  0.24, facingOffset:  Math.PI / 2 },
    { x:  0.90, y: -1.20, z:  0.24, facingOffset: -Math.PI / 2 },
    { x: -0.90, y: -1.20, z: -0.84, facingOffset:  Math.PI / 2 },
    { x:  0.90, y: -1.20, z: -0.84, facingOffset: -Math.PI / 2 },
];

const _seatWorldPos = new THREE.Vector3();

/**
 * Client-side vehicle renderer.
 * Creates meshes, animates rotors, updates from server snapshots.
 */
export class VehicleRenderer {
    constructor(scene) {
        this.scene = scene;
        /** @type {Map<number, VehicleEntry>} */
        this.vehicles = new Map();
        /** @type {CANNON.World|null} Client-side ragdoll physics world — set by ClientGame */
        this.ragdollWorld = null;
    }

    /**
     * Process vehicle snapshot data from server.
     * Creates/updates/removes vehicle meshes as needed.
     * @param {Array} vehicleData - Array of vehicle snapshot objects
     */
    onSnapshot(vehicleData) {
        if (!vehicleData) return;

        const seen = new Set();
        for (const vd of vehicleData) {
            seen.add(vd.vehicleId);

            let entry = this.vehicles.get(vd.vehicleId);
            if (!entry) {
                entry = this._createVehicle(vd.vehicleId);
                this.vehicles.set(vd.vehicleId, entry);
                // Snap to server position immediately so the first frame
                // doesn't lerp from (0,0,0) to the actual spawn point.
                entry.mesh.position.set(vd.x, vd.y, vd.z);
                entry.mesh.rotation.set(0, vd.yaw, 0);
            }

            // Snap position on respawn (alive flips false → true) so
            // the helicopter doesn't lerp from its crash site.
            if (vd.alive && !entry.alive) {
                if (entry.crashBody) this._cleanupCrashBody(entry);
                entry.crashFinished = false;
                entry.mesh.position.set(vd.x, vd.y, vd.z);
                entry.mesh.rotation.set(0, vd.yaw, 0);
                entry.attitudeGroup.rotation.set(0, 0, 0);
            }

            // Bake attitude into mesh quaternion when crash starts so the
            // helicopter tumbles from its current tilt instead of leveling out.
            if (vd.crashing && !entry.crashing) {
                _targetEuler.set(entry.attitudeGroup.rotation.x, entry.mesh.rotation.y, entry.attitudeGroup.rotation.z, 'YXZ');
                entry.mesh.quaternion.setFromEuler(_targetEuler);
                entry.attitudeGroup.rotation.set(0, 0, 0);
            }

            // Update state
            entry.alive = vd.alive;
            entry.crashing = vd.crashing;
            entry.team = vd.team;
            entry.hp = vd.hp;
            entry.pilotId = vd.pilotId;
            entry.passengerIds = [vd.passenger0, vd.passenger1, vd.passenger2, vd.passenger3];

            // During crash state, local physics (or pre-crash position) drives the mesh —
            // skip server interpolation targets entirely.
            if (!entry.crashBody && !vd.crashing) {
                entry.targetX = vd.x;
                entry.targetY = vd.y;
                entry.targetZ = vd.z;
                entry.targetYaw = vd.yaw;
                entry.targetPitch = vd.pitch;
                entry.targetRoll = vd.roll;
            }

            // Visibility — visible if alive, or crash body active, or server says crashing
            // but client hasn't finished its crash animation yet
            const visible = vd.alive || !!entry.crashBody || (vd.crashing && !entry.crashFinished);
            entry.mesh.visible = visible;

            // Team stripe color
            const teamKey = vd.team || 'neutral';
            const tc = TEAM_COLORS[teamKey] ?? TEAM_COLORS.neutral;
            if (entry.stripeMat.color.getHex() !== tc) {
                entry.stripeMat.color.setHex(tc);
            }
        }

        // Remove vehicles no longer in snapshot
        for (const [id, entry] of this.vehicles) {
            if (!seen.has(id)) {
                if (entry.crashBody) this._cleanupCrashBody(entry);
                this.scene.remove(entry.mesh);
                this.vehicles.delete(id);
            }
        }
    }

    /**
     * Per-frame animation update.
     * @param {number} dt - Delta time in seconds
     */
    update(dt) {
        for (const [, entry] of this.vehicles) {
            if (!entry.mesh.visible) continue;

            // ── Client-side crash physics ──
            if (entry.crashBody) {
                // Clamp velocity to prevent physics explosions from terrain overlap
                const v = entry.crashBody.velocity;
                const spd2 = v.x * v.x + v.y * v.y + v.z * v.z;
                if (spd2 > CRASH_MAX_SPEED_SQ) {
                    const s = CRASH_MAX_SPEED / Math.sqrt(spd2);
                    v.x *= s; v.y *= s; v.z *= s;
                }

                const bp = entry.crashBody.position;
                const bq = entry.crashBody.quaternion;
                entry.mesh.position.set(bp.x, bp.y, bp.z);
                entry.mesh.quaternion.set(bq.x, bq.y, bq.z, bq.w);
                entry.attitudeGroup.rotation.set(0, 0, 0);

                // Rotor wind-down during crash
                entry.rotorMesh.rotation.y += ROTOR_SPEED_CRASH * dt;
                entry.tailRotorMesh.rotation.x += ROTOR_SPEED_CRASH * TAIL_ROTOR_MULT * dt;

                entry.crashTimer -= dt;
                if (entry.crashTimer <= 0) {
                    this._cleanupCrashBody(entry);
                    entry.crashFinished = true;
                    entry.mesh.visible = false;
                }
                continue;
            }

            // ── Normal interpolation ──
            const lerp = 1 - Math.exp(-12 * dt);
            const pos = entry.mesh.position;
            const dx = entry.targetX - pos.x;
            const dy = entry.targetY - pos.y;
            const dz = entry.targetZ - pos.z;
            const distSq = dx * dx + dy * dy + dz * dz;

            // Snap if too far (e.g. after tab-hidden gap)
            if (distSq > SNAP_DIST_SQ) {
                pos.set(entry.targetX, entry.targetY, entry.targetZ);
                entry.mesh.rotation.y = entry.targetYaw;
                entry.attitudeGroup.rotation.x = entry.targetPitch;
                entry.attitudeGroup.rotation.z = entry.targetRoll;
                continue;
            }

            pos.x += dx * lerp;
            pos.y += dy * lerp;
            pos.z += dz * lerp;

            if (entry.crashing) {
                // During crash: interpolate full quaternion
                const q = entry.mesh.quaternion;
                _targetQuat.setFromEuler(_targetEuler.set(entry.targetPitch, entry.targetYaw, entry.targetRoll, 'YXZ'));
                q.slerp(_targetQuat, lerp);
                entry.attitudeGroup.rotation.set(0, 0, 0);
            } else {
                // Normal flight: yaw on mesh, pitch/roll on attitude group
                // Smooth yaw (shortest path)
                let yawDiff = entry.targetYaw - entry.mesh.rotation.y;
                if (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
                if (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
                entry.mesh.rotation.y += yawDiff * lerp;

                entry.attitudeGroup.rotation.x += (entry.targetPitch - entry.attitudeGroup.rotation.x) * lerp;
                entry.attitudeGroup.rotation.z += (entry.targetRoll - entry.attitudeGroup.rotation.z) * lerp;
            }

            // Rotor animation
            let rotorSpeed;
            if (entry.crashing) {
                rotorSpeed = ROTOR_SPEED_CRASH;
            } else if (entry.pilotId !== 0xFFFF) {
                rotorSpeed = ROTOR_SPEED_ACTIVE;
            } else {
                rotorSpeed = ROTOR_SPEED_IDLE;
            }
            entry.rotorMesh.rotation.y += rotorSpeed * dt;
            entry.tailRotorMesh.rotation.x += rotorSpeed * TAIL_ROTOR_MULT * dt;
        }
    }

    /**
     * Get the world position of a specific seat.
     */
    getSeatWorldPos(vehicleId, offset) {
        const entry = this.vehicles.get(vehicleId);
        if (!entry) return null;
        _seatWorldPos.set(offset.x, offset.y, offset.z);
        entry.attitudeGroup.updateWorldMatrix(true, false);
        entry.attitudeGroup.localToWorld(_seatWorldPos);
        return _seatWorldPos;
    }

    /**
     * Get all vehicle data for minimap.
     */
    getVehicleData() {
        const result = [];
        for (const [, entry] of this.vehicles) {
            if (!entry.mesh.visible) continue;
            result.push({
                x: entry.mesh.position.x,
                z: entry.mesh.position.z,
                rotationY: entry.mesh.rotation.y,
                team: entry.team,
                alive: entry.alive,
            });
        }
        return result;
    }

    /**
     * Spawn a client-side CANNON body to simulate crash wreckage locally at 60fps.
     * Uses the same 3-box compound shape as the server helicopter.
     */
    startCrashPhysics(vehicleId, evData) {
        const entry = this.vehicles.get(vehicleId);
        if (!entry || !this.ragdollWorld) return;

        // Already has a crash body — ignore duplicate event
        if (entry.crashBody) return;

        const body = new CANNON.Body({
            mass: 300,
            linearDamping: 0.1,
            angularDamping: 0.3,
            allowSleep: false,
        });

        // 3-box compound shape — mirrors ServerHelicopter.initPhysicsBody
        body.addShape(
            new CANNON.Box(new CANNON.Vec3(0.9, 0.7, 2.5)),
            new CANNON.Vec3(0, -0.15, 0)
        );
        body.addShape(
            new CANNON.Box(new CANNON.Vec3(0.5, 0.5, 0.5)),
            new CANNON.Vec3(0, -0.2, 2.8)
        );
        body.addShape(
            new CANNON.Box(new CANNON.Vec3(0.2, 0.2, 1.8)),
            new CANNON.Vec3(0, 0.1, -3.2)
        );

        // Position from event data
        body.position.set(evData.x, evData.y, evData.z);

        // Quaternion from current mesh (onSnapshot baked attitude on crash start)
        const mq = entry.mesh.quaternion;
        body.quaternion.set(mq.x, mq.y, mq.z, mq.w);

        // Velocity from event data
        body.velocity.set(evData.vx, evData.vy, evData.vz);
        body.angularVelocity.set(evData.avx, evData.avy, evData.avz);

        this.ragdollWorld.addBody(body);
        entry.crashBody = body;
        entry.crashTimer = 10;
        entry.mesh.visible = true;
    }

    _cleanupCrashBody(entry) {
        if (entry.crashBody && this.ragdollWorld) {
            this.ragdollWorld.removeBody(entry.crashBody);
        }
        entry.crashBody = null;
        entry.crashTimer = 0;
    }

    // ── Internal ──

    _createVehicle(vehicleId) {
        const mat = (c, opts) => new THREE.MeshLambertMaterial({ color: c, flatShading: true, ...opts });

        const group = new THREE.Group();
        const attitudeGroup = new THREE.Group();
        group.add(attitudeGroup);

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

        // Nose frame
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
        const odMesh = new THREE.Mesh(odMerged, mat(0x4a5a2a));
        odMesh.castShadow = true;
        odMesh.receiveShadow = true;
        attitudeGroup.add(odMesh);

        const dkMerged = mergeGeometries(dkGeos);
        const dkMesh = new THREE.Mesh(dkMerged, mat(0x333333));
        dkMesh.castShadow = true;
        dkMesh.receiveShadow = true;
        attitudeGroup.add(dkMesh);

        // Team stripe — original ×1.2
        const stripeGeo = new THREE.BoxGeometry(0.432, 0.432, 0.96);
        place(stripeGeo, 0, 0.12, 4.8);
        const stripeMat = mat(0x888888);
        const stripeMesh = new THREE.Mesh(stripeGeo, stripeMat);
        stripeMesh.castShadow = true;
        stripeMesh.receiveShadow = true;
        attitudeGroup.add(stripeMesh);

        // Nose glass — original ×1.2
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
        const glassMesh = new THREE.Mesh(glassGeo, mat(0x111111, { transparent: true, opacity: 0.5 }));
        glassMesh.castShadow = true;
        glassMesh.receiveShadow = true;
        attitudeGroup.add(glassMesh);

        // Main rotor — original ×1.2
        const rotorMat = mat(0x444444, { side: THREE.DoubleSide });
        const rotorGeo = new THREE.PlaneGeometry(8.4, 0.3);
        rotorGeo.rotateX(-Math.PI / 2);
        const rotorMesh = new THREE.Mesh(rotorGeo, rotorMat);
        rotorMesh.position.y = 1.14;
        attitudeGroup.add(rotorMesh);
        const rotor2Geo = new THREE.PlaneGeometry(0.3, 8.4);
        rotor2Geo.rotateX(-Math.PI / 2);
        rotorMesh.add(new THREE.Mesh(rotor2Geo, rotorMat));

        // Tail rotor — original ×1.2
        const trGeo = new THREE.PlaneGeometry(0.18, 2.16);
        trGeo.rotateY(-Math.PI / 2);
        const tailRotorMesh = new THREE.Mesh(trGeo, rotorMat);
        tailRotorMesh.position.set(-0.264, 0.84, -5.88);
        attitudeGroup.add(tailRotorMesh);

        // Dispose source geometries
        for (const g of odGeos) g.dispose();
        for (const g of dkGeos) g.dispose();

        this.scene.add(group);

        return {
            vehicleId,
            mesh: group,
            attitudeGroup,
            rotorMesh,
            tailRotorMesh,
            stripeMat,
            alive: true,
            crashing: false,
            team: null,
            hp: 6000,
            pilotId: 0xFFFF,
            passengerIds: [0xFFFF, 0xFFFF, 0xFFFF],
            targetX: 0, targetY: 0, targetZ: 0,
            targetYaw: 0, targetPitch: 0, targetRoll: 0,
            enterRadius: 3,
            crashBody: null,
            crashTimer: 0,
            crashFinished: false,
        };
    }
}

// Reusable objects
const _targetQuat = new THREE.Quaternion();
const _targetEuler = new THREE.Euler();
