import * as THREE from 'three';
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

export const HELI_PILOT_OFFSET = { x: 0, y: -1.15, z: 1.4 };

export const HELI_PASSENGER_SLOTS = [
    { x: -0.75, y: -1.2, z:  0.2, facingOffset:  Math.PI / 2 },
    { x:  0.75, y: -1.2, z:  0.2, facingOffset: -Math.PI / 2 },
    { x: -0.75, y: -1.2, z: -0.7, facingOffset:  Math.PI / 2 },
    { x:  0.75, y: -1.2, z: -0.7, facingOffset: -Math.PI / 2 },
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

            // Interpolation targets
            entry.targetX = vd.x;
            entry.targetY = vd.y;
            entry.targetZ = vd.z;
            entry.targetYaw = vd.yaw;
            entry.targetPitch = vd.pitch;
            entry.targetRoll = vd.roll;

            // Visibility
            const visible = vd.alive || vd.crashing;
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

            // Smooth position interpolation
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

        // Cabin
        odGeos.push(place(new THREE.BoxGeometry(1.8, 0.12, 2.6), 0, -0.55, 0));
        odGeos.push(place(new THREE.BoxGeometry(1.8, 0.12, 2.6), 0, 0.65, 0));
        odGeos.push(place(new THREE.BoxGeometry(1.8, 1.2, 0.12), 0, 0.05, 1.3));
        odGeos.push(place(new THREE.BoxGeometry(0.08, 1.2, 0.08), -0.9, 0.05, -1.25));
        odGeos.push(place(new THREE.BoxGeometry(0.08, 1.2, 0.08), 0.9, 0.05, -1.25));

        // Nose frame
        const noseLen = 1.5;
        const noseCZ = -2.05;
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
        odGeos.push(place(edgeStrip(0.10, 0.10, 0.0, -0.90), 0, 0.0, noseCZ));
        odGeos.push(place(edgeStrip(0.10, 0.10, 0.0,  0.90), 0, 0.0, noseCZ));
        const frontW = 1.7 * (1 - TAPER);
        odGeos.push(place(new THREE.BoxGeometry(frontW, 0.10, 0.10), 0, 0.0, -2.80));
        odGeos.push(place(new THREE.BoxGeometry(0.10, 0.29, 0.10), 0, -0.145, -2.80));
        const kbGeo = new THREE.BoxGeometry(0.15, 0.06, noseLen);
        kbGeo.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.atan2(0.196, noseLen)));
        odGeos.push(place(kbGeo, 0, -0.442, noseCZ));

        // Tail + fin + stabilizer + mast
        odGeos.push(place(new THREE.BoxGeometry(0.35, 0.35, 3.5), 0, 0.1, 3.2));
        odGeos.push(place(new THREE.BoxGeometry(0.1, 1.0, 0.7), 0, 0.7, 4.9));
        odGeos.push(place(new THREE.BoxGeometry(1.4, 0.08, 0.5), 0, 0.15, 4.9));
        odGeos.push(place(new THREE.CylinderGeometry(0.06, 0.06, 0.35, 6), 0, 0.8, 0));

        // Landing skids
        for (const side of [-1, 1]) {
            dkGeos.push(place(new THREE.BoxGeometry(0.08, 0.08, 3.0), side * 0.95, -1.0, -0.2));
            for (const zOff of [-0.8, 0.6]) {
                dkGeos.push(place(new THREE.BoxGeometry(0.06, 0.45, 0.06), side * 0.95, -0.75, zOff));
            }
        }

        const odMerged = mergeGeometries(odGeos);
        const odMesh = new THREE.Mesh(odMerged, mat(0x4a5a2a));
        odMesh.castShadow = true;
        attitudeGroup.add(odMesh);

        const dkMerged = mergeGeometries(dkGeos);
        attitudeGroup.add(new THREE.Mesh(dkMerged, mat(0x333333)));

        // Team stripe
        const stripeGeo = new THREE.BoxGeometry(0.36, 0.36, 0.8);
        place(stripeGeo, 0, 0.1, 4.0);
        const stripeMat = mat(0x888888);
        attitudeGroup.add(new THREE.Mesh(stripeGeo, stripeMat));

        // Nose glass
        const halfLen = noseLen / 2;
        const bx = 0.9, bTop = 0.59, bBot = -0.49;
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
        attitudeGroup.add(new THREE.Mesh(glassGeo, mat(0x111111, { transparent: true, opacity: 0.5 })));

        // Main rotor
        const rotorMat = mat(0x444444, { side: THREE.DoubleSide });
        const rotorGeo = new THREE.PlaneGeometry(7, 0.25);
        rotorGeo.rotateX(-Math.PI / 2);
        const rotorMesh = new THREE.Mesh(rotorGeo, rotorMat);
        rotorMesh.position.y = 0.95;
        attitudeGroup.add(rotorMesh);
        const rotor2Geo = new THREE.PlaneGeometry(0.25, 7);
        rotor2Geo.rotateX(-Math.PI / 2);
        rotorMesh.add(new THREE.Mesh(rotor2Geo, rotorMat));

        // Tail rotor
        const trGeo = new THREE.PlaneGeometry(0.15, 1.8);
        trGeo.rotateY(-Math.PI / 2);
        const tailRotorMesh = new THREE.Mesh(trGeo, rotorMat);
        tailRotorMesh.position.set(-0.22, 0.7, -4.9);
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
        };
    }
}

// Reusable objects
const _targetQuat = new THREE.Quaternion();
const _targetEuler = new THREE.Euler();
