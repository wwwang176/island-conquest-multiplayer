import * as THREE from 'three';
import { WeaponDefs } from '../entities/WeaponDefs.js';

const _headLocal   = new THREE.Vector3();
const _aimDirVec   = new THREE.Vector3();
const _euler       = new THREE.Euler(0, 0, 0, 'YXZ');

export class SpectatorController {

    /**
     * Follow-mode camera update — locks the camera to the spectated entity's
     * eye position and smoothly interpolates yaw/pitch.
     *
     * @param {number}          dt
     * @param {object}          spec            – _spectator state
     * @param {EntityRenderer}  entityRenderer
     * @param {THREE.Camera}    camera
     * @param {ClientHUD}       hud
     * @param {SpectatorHUD}    spectatorHUD
     * @param {Scoreboard}      scoreboard
     * @param {object}          fpsState        – _fps object (for deathLerp)
     */
    updateFollow(dt, spec, entityRenderer, camera, hud, spectatorHUD, scoreboard, fpsState) {
        if (spec.deathFreezeTimer > 0) {
            spec.deathFreezeTimer -= dt;
            if (spec.deathFreezeTimer <= 0) {
                spec.targetId = null;
                spec.initialized = false;
            }
            return;
        }

        const aliveIds = entityRenderer.getAliveEntityIds();
        if (aliveIds.length === 0) return;

        if (spec.targetId !== null) {
            const state = entityRenderer.getEntityState(spec.targetId);
            if (!state) {
                spec.deathFreezeTimer = 1.0;
                hud.hidePlayingHUD();
                if (spec.lastScoped) {
                    spec.lastScoped = false;
                    camera.fov = 75;
                    camera.updateProjectionMatrix();
                }
                return;
            }
        }

        if (spec.targetId === null || !aliveIds.includes(spec.targetId)) {
            spec.targetIndex = spec.targetIndex % aliveIds.length;
            spec.targetId = aliveIds[spec.targetIndex];
            spec.initialized = false;
            hud.resetCache();
            if (spec.lastScoped) {
                spec.lastScoped = false;
                camera.fov = 75;
                camera.updateProjectionMatrix();
            }
        }

        const state = entityRenderer.getEntityState(spec.targetId);
        if (!state) return;

        // Eye position: use localToWorld so helicopter tilt is applied automatically
        const entry = entityRenderer.entities.get(spec.targetId);
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

        camera.position.copy(headPos);
        _euler.set(spec.lerpPitch, spec.lerpYaw, 0, 'YXZ');
        camera.quaternion.setFromEuler(_euler);

        // Show target info in spectator HUD
        const teamPrefix = state.team === 'teamA' ? 'A' : 'B';
        const displayName = scoreboard.playerNames.get(spec.targetId) || `${teamPrefix}-${spec.targetId}`;
        const def = WeaponDefs[entry.weaponId];
        const roleName = def ? def.name : '';
        spectatorHUD.updateTarget(
            displayName, roleName, state.team,
            state.hp, 100
        );

        // Show health + ammo HUDs for spectated entity
        hud.healthHUD.style.display = 'block';
        hud.ammoHUD.style.display = 'block';

        // Scope vignette + FOV for spectated entity
        const isScoped = entry.isScoped && def && def.scopeFOV;
        if (isScoped !== spec.lastScoped) {
            spec.lastScoped = isScoped;
            if (hud.scopeVignette)
                hud.scopeVignette.style.display = isScoped ? 'block' : 'none';
            camera.fov = isScoped ? def.scopeFOV : 75;
            camera.updateProjectionMatrix();
            if (hud.crosshair)
                hud.crosshair.style.display = isScoped ? 'none' : 'block';
        }
    }

    /**
     * Overhead camera mode — WASD panning + scroll zoom with a tilted view.
     *
     * @param {number}        dt
     * @param {object}        spec   – _spectator state
     * @param {InputManager}  input
     * @param {THREE.Camera}  camera
     */
    updateOverhead(dt, spec, input, camera) {
        const speed = spec.panSpeed * dt;
        if (input.isKeyDown('KeyW')) spec.overheadPos.z -= speed;
        if (input.isKeyDown('KeyS')) spec.overheadPos.z += speed;
        if (input.isKeyDown('KeyA')) spec.overheadPos.x -= speed;
        if (input.isKeyDown('KeyD')) spec.overheadPos.x += speed;

        const scroll = input.consumeScrollDelta();
        if (scroll !== 0) {
            spec.overheadZoom += scroll * 0.1;
            spec.overheadZoom = Math.max(15, Math.min(200, spec.overheadZoom));
        }

        const tiltAngle = Math.PI / 3;
        const camY = spec.overheadZoom * Math.sin(tiltAngle);
        const camZOffset = spec.overheadZoom * Math.cos(tiltAngle);

        camera.position.set(
            spec.overheadPos.x,
            camY,
            spec.overheadPos.z + camZOffset
        );
        camera.rotation.set(-tiltAngle, 0, 0);
    }

    /**
     * Switch to the next alive target in follow mode.
     *
     * @param {object}          spec            – _spectator state
     * @param {EntityRenderer}  entityRenderer
     * @param {ClientHUD}       hud
     */
    nextTarget(spec, entityRenderer, hud) {
        const aliveIds = entityRenderer.getAliveEntityIds();
        if (aliveIds.length === 0) return;
        spec.deathFreezeTimer = 0;
        spec.targetIndex = (spec.targetIndex + 1) % aliveIds.length;
        spec.targetId = aliveIds[spec.targetIndex];
        spec.initialized = false;
        hud.resetCache();
    }

    /**
     * Toggle between follow and overhead spectator modes.
     *
     * @param {object}        spec          – _spectator state
     * @param {THREE.Camera}  camera
     * @param {ClientHUD}     hud
     * @param {SpectatorHUD}  spectatorHUD
     */
    toggleView(spec, camera, hud, spectatorHUD) {
        if (spec.mode === 'follow') {
            spec.mode = 'overhead';
            spec.overheadPos.set(
                camera.position.x,
                spec.overheadZoom,
                camera.position.z
            );
            spectatorHUD.setOverheadMode();
            hud.hidePlayingHUD();
            if (spec.lastScoped) {
                spec.lastScoped = false;
                camera.fov = 75;
                camera.updateProjectionMatrix();
            }
        } else {
            spec.mode = 'follow';
            spec.initialized = false;
            spec.deathFreezeTimer = 0;
            spectatorHUD.setFollowMode();
            hud.resetCache();
        }
    }
}
