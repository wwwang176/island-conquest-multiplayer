import * as THREE from 'three';
import { ServerHelicopter } from './ServerHelicopter.js';

const WATER_Y = -0.3;

/**
 * Server-side vehicle manager.
 * Creates, tracks, and updates all vehicles. Handles enter/exit for players and AI.
 * Ported from single-player VehicleManager.js.
 */
export class ServerVehicleManager {
    constructor(physics, flags, getHeightAt, eventBus) {
        this.physics = physics;
        this.flags = flags;
        this.getHeightAt = getHeightAt;
        this.eventBus = eventBus;

        /** @type {ServerHelicopter[]} */
        this.vehicles = [];

        this._nextVehicleId = 0;
        this._spawnInitialVehicles();
    }

    _spawnInitialVehicles() {
        this._spawnHelicopter(0, this.flags[0]);
        this._spawnHelicopter(1, this.flags[this.flags.length - 1]);
    }

    _spawnHelicopter(spawnIdx, flag) {
        const heliPos = this._findLandSpawn(flag.position, 8);
        if (heliPos) {
            const id = this._nextVehicleId++;
            const heli = new ServerHelicopter(id, heliPos);
            heli.rotationY = spawnIdx === 0 ? 0 : Math.PI;
            heli.spawnRotationY = heli.rotationY;
            heli.mesh.rotation.y = heli.rotationY;
            heli.getHeightAt = this.getHeightAt;
            heli.eventBus = this.eventBus;
            heli.spawnFlag = flag;
            heli.initPhysicsBody(this.physics);
            this.vehicles.push(heli);
        }
    }

    _findLandSpawn(basePos, radius) {
        for (let attempt = 0; attempt < 12; attempt++) {
            const angle = attempt * (Math.PI * 2 / 12);
            const x = basePos.x + Math.cos(angle) * radius;
            const z = basePos.z + Math.sin(angle) * radius;
            const h = this.getHeightAt(x, z);
            if (h > 0.5 && h < 6) {
                return new THREE.Vector3(x, h, z);
            }
        }
        const h = this.getHeightAt(basePos.x, basePos.z);
        return new THREE.Vector3(basePos.x, Math.max(h, 1), basePos.z);
    }

    /**
     * Per-tick update: update all vehicles.
     */
    update(dt) {
        for (const v of this.vehicles) {
            v.update(dt);
        }
    }

    /**
     * Try to enter the nearest available vehicle.
     * @param {object} entity - ServerPlayer or ServerSoldier
     * @returns {ServerHelicopter|null}
     */
    tryEnterVehicle(entity) {
        let closest = null;
        let closestDist = Infinity;

        for (const v of this.vehicles) {
            if (!v.canEnter(entity)) continue;
            const pos = entity.getPosition();
            const vp = v.mesh.position;
            const dist = (pos.x - vp.x) ** 2 + (pos.z - vp.z) ** 2;
            if (dist < closestDist) {
                closestDist = dist;
                closest = v;
            }
        }
        return closest;
    }

    /**
     * Exit the entity from their current vehicle.
     * @param {object} entity
     * @returns {THREE.Vector3|null} exit position
     */
    exitVehicle(entity) {
        for (const v of this.vehicles) {
            const isOccupant = v.driver === entity ||
                (v.passengers && v.passengers.includes(entity));
            if (!isOccupant) continue;

            const exitPos = v.exit(entity);
            const h = this.getHeightAt(exitPos.x, exitPos.z);
            exitPos.y = Math.max(h + 0.1, WATER_Y + 0.5);
            return exitPos;
        }
        return null;
    }

    /**
     * Find the nearest available vehicle for an AI soldier.
     */
    findNearestVehicle(entity, maxDist = 80) {
        let closest = null;
        let closestDist = maxDist * maxDist;

        for (const v of this.vehicles) {
            if (!v.alive) continue;
            if (v.team !== null && v.team !== entity.team) continue;
            if (v.occupantCount >= 5) continue;
            const pos = entity.getPosition();
            const vp = v.mesh.position;
            const dist = (pos.x - vp.x) ** 2 + (pos.z - vp.z) ** 2;
            if (dist < closestDist) {
                closestDist = dist;
                closest = v;
            }
        }
        return closest;
    }

    /**
     * Get all vehicle meshes for hitscan target list.
     */
    getVehicleMeshes() {
        const meshes = [];
        for (const v of this.vehicles) {
            const visible = v.alive || (v._crashing && v.mesh);
            if (!visible || !v.mesh) continue;
            meshes.push(v.mesh);
        }
        return meshes;
    }

    /**
     * Get vehicle snapshot data for all vehicles.
     */
    getVehicleSnapshotData() {
        const data = [];
        for (const v of this.vehicles) {
            data.push(v.getSnapshotData());
        }
        return data;
    }

    /**
     * Find which vehicle an entity is in.
     * @returns {ServerHelicopter|null}
     */
    getVehicleOf(entity) {
        for (const v of this.vehicles) {
            if (v.driver === entity) return v;
            if (v.passengers.includes(entity)) return v;
        }
        return null;
    }

    /**
     * Sync all vehicle meshes (for accurate raycasting).
     */
    syncAllMeshes() {
        for (const v of this.vehicles) {
            v.syncMesh();
        }
    }
}
