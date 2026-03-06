import * as THREE from 'three';
import { HELI_PILOT_OFFSET, HELI_PASSENGER_SLOTS } from './VehicleRenderer.js';

// Reusable objects for vehicle occupant positioning
const _seatQuat = new THREE.Quaternion();

/**
 * Handles vehicle-related camera, occupant positioning, and HUD for the client.
 */
export class VehicleController {
    constructor() {
        // Vehicle HUD container
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

    /**
     * Position camera in vehicle cockpit/seat.
     * @param {object} fps - Client FPS state (vehicleId, myEntityId, predictedPos)
     * @param {import('./VehicleRenderer.js').VehicleRenderer} vehicleRenderer
     * @param {THREE.Camera} camera
     */
    updateCamera(fps, vehicleRenderer, camera) {
        const vEntry = vehicleRenderer.vehicles.get(fps.vehicleId);
        if (!vEntry) {
            // Fallback — use predicted pos
            camera.position.set(fps.predictedPos.x, fps.predictedPos.y + 1.6, fps.predictedPos.z);
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

        const seatPos = vehicleRenderer.getSeatWorldPos(fps.vehicleId, offset);
        if (seatPos) {
            camera.position.copy(seatPos);
        } else {
            camera.position.set(vEntry.mesh.position.x, vEntry.mesh.position.y + 1.6, vEntry.mesh.position.z);
        }
    }

    /**
     * Position entity meshes on vehicle seats with proper sitting pose.
     * Mirrors the single-player AIController.updateContinuous() lines 549-621.
     * @param {object} fps - Client FPS state (myEntityId)
     * @param {import('./EntityRenderer.js').EntityRenderer} entityRenderer
     * @param {import('./VehicleRenderer.js').VehicleRenderer} vehicleRenderer
     */
    updateOccupants(fps, entityRenderer, vehicleRenderer) {
        // First: clear all _inVehicle flags so EntityRenderer can animate freed entities
        for (const [, entry] of entityRenderer.entities) {
            if (entry._inVehicle) entry._inVehicle = false;
        }

        for (const [, vEntry] of vehicleRenderer.vehicles) {
            if (!vEntry.mesh.visible) continue;

            // Get helicopter attitude quaternion from the client attitudeGroup
            vEntry.attitudeGroup.updateWorldMatrix(true, false);
            _seatQuat.setFromRotationMatrix(vEntry.attitudeGroup.matrixWorld);

            // Pilot
            if (vEntry.pilotId !== 0xFFFF) {
                const entry = entityRenderer.entities.get(vEntry.pilotId);
                if (entry && entry.mesh) {
                    entry._inVehicle = true;
                    if (vEntry.pilotId === fps.myEntityId) {
                        entry.mesh.visible = false;
                    } else {
                        entry.mesh.visible = true;
                        const seatPos = vehicleRenderer.getSeatWorldPos(vEntry.vehicleId, HELI_PILOT_OFFSET);
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
                const entry = entityRenderer.entities.get(pid);
                if (!entry || !entry.mesh) continue;

                entry._inVehicle = true;
                const slot = HELI_PASSENGER_SLOTS[i];
                if (!slot) continue;

                if (pid === fps.myEntityId) {
                    entry.mesh.visible = false;
                } else {
                    entry.mesh.visible = true;
                    const seatPos = vehicleRenderer.getSeatWorldPos(vEntry.vehicleId, slot);
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
                        const state = entityRenderer.interp.getInterpolated(pid);
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
     * @param {object} fps - Client FPS state (vehicleId, myEntityId, predictedPos)
     * @param {import('./VehicleRenderer.js').VehicleRenderer} vehicleRenderer
     * @param {string} gameMode - Current game mode ('playing', 'spectating', etc.)
     */
    updateHUD(fps, vehicleRenderer, gameMode) {
        const inVehicle = fps.vehicleId !== 0xFF;

        // Vehicle HUD — show when in vehicle
        if (this._vehicleHUD) {
            if (inVehicle && (gameMode === 'playing')) {
                const vEntry = vehicleRenderer.vehicles.get(fps.vehicleId);
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
                    const maxHP = 12000;
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
            if (!inVehicle && gameMode === 'playing' && fps.myEntityId >= 0) {
                let nearVehicle = false;
                const pp = fps.predictedPos;
                for (const [, vEntry] of vehicleRenderer.vehicles) {
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
}
