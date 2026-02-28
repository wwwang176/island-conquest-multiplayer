import { TICK_INTERVAL, INTERPOLATION_DELAY } from '../shared/constants.js';

/**
 * Interpolation buffer for a single entity.
 * Stores recent snapshot states and provides smooth interpolated position/rotation.
 */
class EntityInterp {
    constructor() {
        // Ring buffer of recent states: { tick, x, y, z, yaw, pitch }
        this.states = [];
        this.maxStates = 6;
    }

    pushState(tick, x, y, z, yaw, pitch) {
        this.states.push({ tick, x, y, z, yaw, pitch });
        if (this.states.length > this.maxStates) {
            this.states.shift();
        }
    }

    /**
     * Get interpolated position/rotation at the given render tick.
     * Uses linear interpolation between the two nearest snapshot states.
     */
    getInterpolated(renderTick) {
        if (this.states.length === 0) return null;
        if (this.states.length === 1) {
            const s = this.states[0];
            return { x: s.x, y: s.y, z: s.z, yaw: s.yaw, pitch: s.pitch };
        }

        // Find the two states that straddle renderTick
        let before = null;
        let after = null;
        for (let i = 0; i < this.states.length; i++) {
            if (this.states[i].tick <= renderTick) {
                before = this.states[i];
            }
            if (this.states[i].tick > renderTick && !after) {
                after = this.states[i];
            }
        }

        if (!before && after) return after;
        if (before && !after) return before;
        if (!before && !after) return this.states[this.states.length - 1];

        // Interpolate between before and after
        const range = after.tick - before.tick;
        const t = range > 0 ? (renderTick - before.tick) / range : 0;
        const ct = Math.max(0, Math.min(1, t));

        return {
            x: before.x + (after.x - before.x) * ct,
            y: before.y + (after.y - before.y) * ct,
            z: before.z + (after.z - before.z) * ct,
            yaw: lerpAngle(before.yaw, after.yaw, ct),
            pitch: before.pitch + (after.pitch - before.pitch) * ct,
        };
    }
}

/** Lerp between two angles with wraparound handling. */
function lerpAngle(a, b, t) {
    let diff = b - a;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    return a + diff * t;
}

/**
 * Manages interpolation for all remote entities.
 */
export class InterpolationManager {
    constructor() {
        /** @type {Map<number, EntityInterp>} entityId → interp buffer */
        this.entities = new Map();
        this.latestServerTick = 0;
    }

    /**
     * Push a snapshot state for an entity.
     */
    pushState(entityId, tick, x, y, z, yaw, pitch) {
        let interp = this.entities.get(entityId);
        if (!interp) {
            interp = new EntityInterp();
            this.entities.set(entityId, interp);
        }
        interp.pushState(tick, x, y, z, yaw, pitch);
        if (tick > this.latestServerTick) {
            this.latestServerTick = tick;
        }
    }

    /**
     * Get interpolated state for an entity at the current render time.
     * Render time = latest server tick - INTERPOLATION_DELAY.
     */
    getInterpolated(entityId) {
        const interp = this.entities.get(entityId);
        if (!interp) return null;
        const renderTick = this.latestServerTick - INTERPOLATION_DELAY;
        return interp.getInterpolated(renderTick);
    }

    /**
     * Remove an entity from interpolation tracking.
     */
    remove(entityId) {
        this.entities.delete(entityId);
    }

    clear() {
        this.entities.clear();
        this.latestServerTick = 0;
    }
}
