import * as THREE from 'three';
import { WeaponDefs, GunAnim } from '../entities/WeaponDefs.js';
import { GRAVITY, MOVE_SPEED, ACCEL, DECEL } from '../shared/constants.js';
import { KeyBit } from '../shared/protocol.js';

// Reusable vectors for FPS prediction
const _pForward = new THREE.Vector3();
const _pRight   = new THREE.Vector3();
const _pYawQuat = new THREE.Quaternion();
const _pMoveDir = new THREE.Vector3();
const _pYAxis   = new THREE.Vector3(0, 1, 0);

const _euler = new THREE.Euler(0, 0, 0, 'YXZ');

const PLAYER_JUMP_SPEED = 4;

export class FPSController {
    constructor() {
        // No state — all state lives in the fps object passed to update()
    }

    /**
     * Build key bitmask from current InputManager state.
     * @param {InputManager} input
     * @returns {number} key bits
     */
    buildKeyBits(input) {
        let keys = 0;
        if (input.isKeyDown('KeyW')) keys |= KeyBit.FORWARD;
        if (input.isKeyDown('KeyS')) keys |= KeyBit.BACKWARD;
        if (input.isKeyDown('KeyA')) keys |= KeyBit.LEFT;
        if (input.isKeyDown('KeyD')) keys |= KeyBit.RIGHT;
        if (input.isKeyDown('Space')) keys |= KeyBit.JUMP;
        if (input.isKeyDown('ShiftLeft') || input.isKeyDown('ShiftRight')) keys |= KeyBit.SPRINT;
        if (input.mouseDown) keys |= KeyBit.FIRE;
        if (input.rightMouseDown) keys |= KeyBit.SCOPE;
        if (input.isKeyDown('KeyR')) keys |= KeyBit.RELOAD;
        if (input.isKeyDown('KeyG')) keys |= KeyBit.GRENADE;
        if (input.isKeyDown('KeyE')) keys |= KeyBit.INTERACT;
        return keys;
    }

    /**
     * Client-side movement prediction.
     * Replicates server movement logic for instant camera response.
     * @param {number} dt - delta time
     * @param {number} keys - key bitmask
     * @param {object} fps - FPS state object
     * @param {Island} island - Island instance (for getHeightAt)
     * @param {NavGrid|null} navGrid - NavGrid instance (can be null)
     */
    predictMovement(dt, keys, fps, island, navGrid) {
        if (!island) return;

        const getH = (x, z) => island.getHeightAt(x, z);
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

        if (navGrid) {
            const g = navGrid.worldToGrid(newX, newZ);
            if (!navGrid.isWalkable(g.col, g.row)) {
                const gX = navGrid.worldToGrid(newX, fps.predictedPos.z);
                const gZ = navGrid.worldToGrid(fps.predictedPos.x, newZ);
                if (navGrid.isWalkable(gX.col, gX.row)) {
                    newZ = fps.predictedPos.z;
                } else if (navGrid.isWalkable(gZ.col, gZ.row)) {
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
            fps.predictedPos.x = newX;
            fps.predictedPos.z = newZ;
            if (!fps.isJumping) fps.predictedPos.y = newGroundY + 0.05;
        } else if (!fps.isJumping) {
            fps.isJumping = true;
            fps.jumpVelY = 2.5;
        }
    }

    /**
     * Unscope helper — resets scope state and updates camera/HUD.
     * @param {object} fps - FPS state object
     * @param {THREE.Camera} camera
     * @param {ClientHUD} hud
     */
    _unscope(fps, camera, hud) {
        if (!fps.isScoped) return;
        fps.isScoped = false;
        camera.fov = 75;
        camera.updateProjectionMatrix();
        if (fps.fpGunGroup) fps.fpGunGroup.visible = true;
        if (hud.scopeVignette) hud.scopeVignette.style.display = 'none';
        if (hud.crosshair) hud.crosshair.style.display = 'block';
    }

    /**
     * Main FPS update — handles grenade timer, scope toggle, mouse look,
     * input sending, movement prediction, smooth correction, gun animations,
     * muzzle flash timer, and camera positioning (when not in vehicle).
     *
     * @param {number} dt - delta time
     * @param {object} fps - the _fps state object from ClientGame
     * @param {InputManager} input - InputManager instance
     * @param {THREE.Camera} camera - the game camera
     * @param {NetworkClient} network - NetworkClient (to call sendInput)
     * @param {Island} island - Island instance
     * @param {NavGrid|null} navGrid - NavGrid instance (can be null)
     * @param {ClientHUD} hud - ClientHUD instance
     */
    update(dt, fps, input, camera, network, island, navGrid, hud) {
        // ── Grenade throw timer ──
        const grenadeDown = input.isKeyDown('KeyG');
        if (grenadeDown && !fps.prevGrenade) {
            fps.grenadeThrowTimer = 0.5;
        }
        fps.prevGrenade = grenadeDown;
        if (fps.grenadeThrowTimer > 0) fps.grenadeThrowTimer -= dt;

        // ── Scope toggle (right-click edge trigger) ──
        const rightDown = input.rightMouseDown;
        if (rightDown && !fps.prevRightMouse) {
            const def = WeaponDefs[fps.weaponId];
            if (def && def.scopeFOV && !fps.isReloading && !fps.isBolting && fps.grenadeThrowTimer <= 0) {
                fps.isScoped = !fps.isScoped;
                camera.fov = fps.isScoped ? def.scopeFOV : 75;
                camera.updateProjectionMatrix();
                if (fps.fpGunGroup) fps.fpGunGroup.visible = !fps.isScoped;
                if (hud.scopeVignette) {
                    hud.scopeVignette.style.display = fps.isScoped ? 'block' : 'none';
                }
                if (hud.crosshair) {
                    hud.crosshair.style.display = fps.isScoped ? 'none' : 'block';
                }
            }
        }
        fps.prevRightMouse = rightDown;

        // Force unscope on reload/bolt
        if (fps.isScoped && (fps.isReloading || fps.isBolting)) {
            this._unscope(fps, camera, hud);
        }

        // ── Mouse look (with scope sensitivity) ──
        if (input.isPointerLocked) {
            const { dx, dy } = input.consumeMouseDelta();
            const sens = fps.isScoped ? fps.mouseSensitivity * 0.5 : fps.mouseSensitivity;
            fps.yaw -= dx * sens;
            fps.pitch -= dy * sens;
            fps.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, fps.pitch));
        }

        // Build key bits
        const keys = this.buildKeyBits(input);

        // Send input to server
        fps.localTick++;
        network.sendInput(fps.localTick, keys, 0, 0, fps.yaw, fps.pitch);

        const inVehicle = fps.vehicleId !== 0xFF;

        // Local prediction (skip when in vehicle — server controls position)
        if (!inVehicle) {
            this.predictMovement(dt, keys, fps, island, navGrid);

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
        // If in vehicle, skip camera positioning (caller handles it via _updateVehicleCamera).
        if (!inVehicle) {
            camera.position.set(
                fps.predictedPos.x,
                fps.predictedPos.y + 1.6,
                fps.predictedPos.z
            );
        }
        // Always set camera quaternion from yaw/pitch
        _euler.set(fps.pitch, fps.yaw, 0, 'YXZ');
        camera.quaternion.setFromEuler(_euler);
    }
}
