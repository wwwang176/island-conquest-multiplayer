import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { WeaponDefs } from '../entities/WeaponDefs.js';
import { computeHitDamage, applyHealthRegen } from '../shared/DamageModel.js';
import { createCapsuleBody, resetCapsuleShapes } from '../shared/CapsuleBody.js';

const dummyMat = new THREE.MeshBasicMaterial();

/**
 * Server-side soldier entity.
 * Builds the same collision mesh geometry as the client Soldier
 * (for accurate raycast hit detection) but skips all visual extras
 * (colors, shadows, muzzle flash, animations, vertex colors).
 *
 * Implements the same interface that AIController expects from Soldier.
 */
export class ServerSoldier {
    constructor(physics, team, id, kinematic = false) {
        this.physics = physics;
        this.team = team;
        this.id = id;
        this.kinematic = kinematic;

        // Health
        this.maxHP = 100;
        this.hp = this.maxHP;
        this.regenDelay = 5;
        this.regenRate = 10;
        this.timeSinceLastDamage = Infinity;

        // Capsule collision
        this.capsuleRadius = 0.35;
        this.cameraHeight = 1.6;

        // Targeting awareness
        this.targetedByCount = 0;

        // State
        this.alive = true;
        this.deathTimer = 0;
        this.respawnDelay = 5;
        this.vehicle = null;

        // Team color (for AIController references)
        this.teamColor = team === 'teamA' ? 0x4488ff : 0xff4444;

        // Build collision mesh (same geometry as client for accurate raycast)
        this.mesh = this._createMesh();
        this.mesh.userData.soldier = this;
        this.mesh.traverse((child) => {
            Object.defineProperty(child.userData, 'soldierRef', {
                value: this, writable: true, enumerable: false, configurable: true,
            });
        });
        // No scene.add — server doesn't have a scene

        // Physics body
        this.body = createCapsuleBody(
            physics.defaultMaterial, this.capsuleRadius, this.cameraHeight, kinematic, 80, 2
        );
        this._inWorld = true;
        physics.addBody(this.body);

        if (kinematic) {
            this.removeFromPhysics();
        }

        // Damage tracking
        this.lastDamageDirection = null;
        this.damageIndicatorTimer = 0;
        this.lastDamagedTime = 0;

        // Ragdoll state
        this.ragdollActive = false;

        // Movement velocity (for AI)
        this.lastMoveVelocity = new THREE.Vector3();

        // Cached position
        this._posCache = new THREE.Vector3();

        // Muzzle flash timer (stub)
        this._muzzleFlashTimer = 0;

        // Controller ref (set by AIManager)
        this.controller = null;

        // VFX stubs
        this.impactVFX = null;
        this.droppedGunManager = null;

        // Gun mesh reference stubs
        this.gunMesh = null;
        this._gunReloadTilt = 0;
        this._gunRecoilZ = 0;
        this._walkPhase = 0;
    }

    _createMesh() {
        const group = new THREE.Group();

        // ── Lower body ──
        const lowerBody = new THREE.Group();

        // Hips
        const hips = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.15, 0.3), dummyMat);
        hips.position.y = 0.75;
        lowerBody.add(hips);

        // Left leg
        const leftLeg = new THREE.Group();
        leftLeg.position.set(-0.13, 0.7, 0);
        const leftLegMesh = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.70, 0.18), dummyMat);
        leftLegMesh.position.y = -0.35;
        leftLeg.add(leftLegMesh);
        lowerBody.add(leftLeg);

        // Right leg
        const rightLeg = new THREE.Group();
        rightLeg.position.set(0.13, 0.7, 0);
        const rightLegMesh = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.70, 0.18), dummyMat);
        rightLegMesh.position.y = -0.35;
        rightLeg.add(rightLegMesh);
        lowerBody.add(rightLeg);

        group.add(lowerBody);

        // ── Upper body ──
        const upperBody = new THREE.Group();

        // Torso + head merged (with BVH for headshot detection)
        const torsoGeo = new THREE.BoxGeometry(0.5, 0.6, 0.3);
        torsoGeo.translate(0, 1.125, 0);
        const headGeo = new THREE.BoxGeometry(0.3, 0.3, 0.3);
        headGeo.translate(0, 1.575, 0);
        const torsoHeadGeo = mergeGeometries([torsoGeo, headGeo]);
        torsoGeo.dispose();
        headGeo.dispose();
        torsoHeadGeo.computeBoundsTree();
        const torsoHeadMesh = new THREE.Mesh(torsoHeadGeo, dummyMat);
        upperBody.add(torsoHeadMesh);

        // Shoulder pivot (arms + gun pitch)
        const shoulderPivot = new THREE.Group();
        shoulderPivot.position.y = 1.35;
        upperBody.add(shoulderPivot);

        // Right arm
        const rightArmGeo = new THREE.BoxGeometry(0.15, 0.4, 0.15);
        rightArmGeo.translate(0, -0.2, 0);
        const rightArm = new THREE.Mesh(rightArmGeo, dummyMat);
        rightArm.position.set(0.2, 0, 0);
        rightArm.rotation.set(1.1, 0, 0);
        shoulderPivot.add(rightArm);

        // Left arm
        const leftArmGeo = new THREE.BoxGeometry(0.15, 0.55, 0.15);
        leftArmGeo.translate(0, -0.275, 0);
        this._leftArmMesh = new THREE.Mesh(leftArmGeo, dummyMat);
        this._leftArmMesh.position.set(-0.2, 0, 0);
        this._leftArmMesh.rotation.set(1.2, 0, 0.5);
        shoulderPivot.add(this._leftArmMesh);

        // Gun (simplified — just need the mesh for raycast collidable)
        this._gunParent = shoulderPivot;
        this._createGunMesh('AR15');

        group.add(upperBody);

        // Store references for animation/sync
        this.upperBody = upperBody;
        this.shoulderPivot = shoulderPivot;
        this.lowerBody = lowerBody;
        this.leftLeg = leftLeg;
        this.rightLeg = rightLeg;

        return group;
    }

    _createGunMesh(weaponId) {
        if (this.gunMesh) {
            this._gunParent.remove(this.gunMesh);
        }

        // Build simplified gun geometry
        const geos = [];
        if (weaponId === 'LMG') {
            geos.push(new THREE.BoxGeometry(0.10, 0.10, 0.50));
        } else if (weaponId === 'SMG') {
            const g = new THREE.BoxGeometry(0.08, 0.08, 0.30);
            g.translate(0, 0, 0.10);
            geos.push(g);
        } else if (weaponId === 'BOLT') {
            geos.push(new THREE.BoxGeometry(0.07, 0.07, 0.50));
        } else {
            geos.push(new THREE.BoxGeometry(0.08, 0.08, 0.50));
        }

        const merged = mergeGeometries(geos);
        for (const g of geos) g.dispose();
        const gun = new THREE.Mesh(merged, dummyMat);
        gun.position.set(0.05, -0.05, -0.45);
        this._gunParent.add(gun);
        this.gunMesh = gun;

        // Tag for hit classification
        gun.traverse((child) => {
            Object.defineProperty(child.userData, 'soldierRef', {
                value: this, writable: true, enumerable: false, configurable: true,
            });
        });

        // Adjust left arm per weapon
        if (this._leftArmMesh) {
            const def = WeaponDefs[weaponId];
            if (def && def.tpLeftArmRotX !== undefined) {
                this._leftArmMesh.rotation.x = def.tpLeftArmRotX;
            }
        }
    }

    setWeaponModel(weaponId) {
        this._createGunMesh(weaponId);
    }

    /**
     * Sync mesh transform from position/yaw/pitch.
     * Must be called each tick so raycasts hit the correct location.
     */
    syncMesh() {
        this.mesh.position.set(
            this.body.position.x,
            this.body.position.y,
            this.body.position.z
        );
        // Yaw is set by AIController via mesh.rotation.y
        // Pitch is set via shoulderPivot.rotation.x
        this.mesh.updateMatrixWorld(true);
    }

    // ── Stubs for visual-only methods that AI modules call ──

    showMuzzleFlash() { /* no-op on server */ }
    animateWalk() { /* no-op on server */ }

    // ── Physics helpers ──

    removeFromPhysics() {
        if (this._inWorld) {
            this.physics.removeBody(this.body);
            this._inWorld = false;
        }
    }

    addToPhysics() {
        if (!this._inWorld) {
            this.physics.addBody(this.body);
            this._inWorld = true;
        }
    }

    // ── Damage & Death ──

    takeDamage(amount, fromPosition, hitY = null, attacker = null) {
        if (!this.alive) return { killed: false, damage: 0, headshot: false };

        const baseY = this.body.position.y;
        const { actualDamage, headshot } = computeHitDamage(amount, hitY, baseY);
        this.hp = Math.max(0, this.hp - actualDamage);
        this.timeSinceLastDamage = 0;
        this.lastDamagedTime = performance.now();

        // Damage direction
        if (fromPosition) {
            if (!this.lastDamageDirection) this.lastDamageDirection = new THREE.Vector3();
            this.lastDamageDirection.set(
                fromPosition.x - this.body.position.x,
                0,
                fromPosition.z - this.body.position.z
            ).normalize();
            this.damageIndicatorTimer = 1.0;
        }

        if (this.hp <= 0) {
            this.die(fromPosition);
            return { killed: true, damage: actualDamage, headshot };
        }

        if (this.controller && this.controller.onDamaged) {
            this.controller.onDamaged(attacker);
        }

        return { killed: false, damage: actualDamage, headshot };
    }

    die(fromPosition) {
        this.alive = false;
        this.hp = 0;
        this.deathTimer = this.respawnDelay;

        // Exit vehicle — pass died=true so driver death can promote a passenger
        if (this.vehicle) {
            this.vehicle.exit(this, true);
            this.vehicle = null;
            if (this.controller) {
                this.controller.vehicle = null;
                this.controller._vehicleMoveTarget = null;
                this.controller._vehicleOrbitAngle = 0;
            }
        }

        this.ragdollActive = true;

        // Re-add to physics for ragdoll
        this.addToPhysics();

        // Replace shapes with cylinder
        while (this.body.shapes.length > 0) {
            this.body.removeShape(this.body.shapes[0]);
        }
        this.body.position.y += 0.8;
        this.body.addShape(new CANNON.Cylinder(0.3, 0.3, 1.6, 8));

        this.body.type = CANNON.Body.DYNAMIC;
        this.body.mass = 60;
        this.body.fixedRotation = false;
        this.body.updateMassProperties();
        this.body.angularDamping = 0.4;
        this.body.linearDamping = 0.4;
        this.body.collisionResponse = true;
        this.body.wakeUp();

        // Apply bullet-direction impulse
        if (fromPosition) {
            const myPos = this.body.position;
            const dir = new CANNON.Vec3(
                myPos.x - fromPosition.x, 0, myPos.z - fromPosition.z
            );
            const len = Math.sqrt(dir.x * dir.x + dir.z * dir.z);
            if (len > 0.01) { dir.x /= len; dir.z /= len; }
            this.body.applyImpulse(
                new CANNON.Vec3(dir.x * 60, 10, dir.z * 60),
                new CANNON.Vec3(0, 0.6, 0)
            );
        }

        this.body.velocity.x += this.lastMoveVelocity.x;
        this.body.velocity.z += this.lastMoveVelocity.z;

        // No dropped gun on server (pure visual)
    }

    respawn(position) {
        this.alive = true;
        this.hp = this.maxHP;
        this.timeSinceLastDamage = Infinity;
        this.targetedByCount = 0;
        this.mesh.visible = true;
        this.mesh.rotation.set(0, 0, 0);

        if (this.upperBody) this.upperBody.rotation.set(0, 0, 0);
        if (this.shoulderPivot) this.shoulderPivot.rotation.set(0, 0, 0);
        if (this.lowerBody) this.lowerBody.rotation.set(0, 0, 0);
        if (this.leftLeg) this.leftLeg.rotation.set(0, 0, 0);
        if (this.rightLeg) this.rightLeg.rotation.set(0, 0, 0);

        resetCapsuleShapes(this.body, this.capsuleRadius, this.cameraHeight);

        if (this.kinematic) {
            this.body.type = CANNON.Body.KINEMATIC;
            this.body.mass = 0;
            this.body.collisionResponse = false;
        } else {
            this.body.type = CANNON.Body.DYNAMIC;
            this.body.mass = 80;
            this.body.collisionResponse = true;
        }
        this.body.fixedRotation = true;
        this.body.angularDamping = 1.0;
        this.body.linearDamping = 0.9;
        this.body.updateMassProperties();
        this.body.quaternion.set(0, 0, 0, 1);
        this.body.angularVelocity.set(0, 0, 0);
        this.body.position.set(position.x, position.y + 0.05, position.z);
        this.body.velocity.set(0, 0, 0);
        this.mesh.position.set(position.x, position.y + 0.05, position.z);
        this.ragdollActive = false;

        if (this.kinematic) {
            this.removeFromPhysics();
        }
    }

    update(dt) {
        if (!this.alive) {
            this.deathTimer -= dt;
            if (this.ragdollActive) {
                // Clamp ragdoll velocity
                const v = this.body.velocity;
                const spd2 = v.x * v.x + v.y * v.y + v.z * v.z;
                if (spd2 > 225) { // 15^2
                    const s = 15 / Math.sqrt(spd2);
                    v.x *= s; v.y *= s; v.z *= s;
                }
                if (this.deathTimer <= 0.5) {
                    this.ragdollActive = false;
                    this.mesh.visible = false;
                }
            }
            return;
        }

        // Health regen
        applyHealthRegen(this, dt);

        // Damage indicator fade
        if (this.damageIndicatorTimer > 0) {
            this.damageIndicatorTimer -= dt;
        }

        // Sync mesh to physics body
        this.mesh.position.set(
            this.body.position.x,
            this.body.position.y,
            this.body.position.z
        );
    }

    getPosition() {
        return this._posCache.set(this.body.position.x, this.body.position.y, this.body.position.z);
    }

    canRespawn() {
        return !this.alive && this.deathTimer <= 0;
    }
}
