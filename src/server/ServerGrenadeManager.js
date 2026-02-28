import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { WeaponDefs } from '../entities/WeaponDefs.js';

const _diff = new THREE.Vector3();
const _impulseVec = new CANNON.Vec3();

/**
 * Server-side grenade — physics body only, no mesh/scene.
 */
class ServerGrenade {
    constructor(physics, origin, velocity, fuseTime, throwerTeam, throwerName, throwerEntityId) {
        this.physics = physics;
        this.throwerTeam = throwerTeam;
        this.throwerName = throwerName;
        this.throwerEntityId = throwerEntityId ?? 0xFFFF;
        this.fuseTime = fuseTime;
        this.alive = true;
        this._waterSplashed = false;

        this.body = new CANNON.Body({
            mass: 0.4,
            material: physics.defaultMaterial,
            linearDamping: 0.0,
            angularDamping: 0.4,
        });
        this.body.addShape(new CANNON.Sphere(0.08));
        this.body.position.set(origin.x, origin.y, origin.z);
        this.body.velocity.set(velocity.x, velocity.y, velocity.z);
        physics.addBody(this.body);
    }

    update(dt) {
        if (!this.alive) return null;
        this.fuseTime -= dt;
        if (this.fuseTime <= 0) {
            const pos = new THREE.Vector3(
                this.body.position.x,
                this.body.position.y,
                this.body.position.z
            );
            this.dispose();
            return { position: pos };
        }
        return null;
    }

    dispose() {
        this.alive = false;
        this.physics.removeBody(this.body);
    }
}

/**
 * Server-side grenade manager — handles physics and damage, no visuals.
 */
export class ServerGrenadeManager {
    constructor(physics, eventBus) {
        this.physics = physics;
        this.eventBus = eventBus;
        this.grenades = [];
        this._nextGrenadeId = 0x8000;
    }

    spawn(origin, velocity, fuseTime, throwerTeam, throwerName = '', throwerEntityId) {
        const grenade = new ServerGrenade(
            this.physics, origin, velocity, fuseTime, throwerTeam, throwerName, throwerEntityId
        );
        grenade._entityId = this._nextGrenadeId++;
        this.grenades.push(grenade);
    }

    update(dt, allSoldiers, player, vehicleManager) {
        for (let i = this.grenades.length - 1; i >= 0; i--) {
            const grenade = this.grenades[i];
            const result = grenade.update(dt);

            if (result) {
                this._handleExplosion(
                    result.position, allSoldiers, player,
                    grenade.throwerTeam, grenade.throwerName, grenade.throwerEntityId,
                    vehicleManager
                );
                this.grenades.splice(i, 1);
            } else if (!grenade.alive) {
                this.grenades.splice(i, 1);
            }
        }
    }

    _handleExplosion(pos, allSoldiers, player, throwerTeam, throwerName, throwerEntityId, vehicleManager) {
        const def = WeaponDefs.GRENADE;

        let enemyHitCount = 0;
        let enemyKillCount = 0;
        for (const soldier of allSoldiers) {
            if (soldier.alive) {
                if (soldier.team !== throwerTeam) {
                    const hpBefore = soldier.hp;
                    const wasAlive = soldier.alive;
                    this._applyBlastDamage(pos, soldier, def);
                    if (soldier.hp < hpBefore) enemyHitCount++;
                    if (wasAlive && !soldier.alive) {
                        enemyKillCount++;
                        const vTeam = soldier.team;
                        const victimName = `${vTeam === 'teamA' ? 'A' : 'B'}-${soldier.id}`;
                        this.eventBus.emit('kill', {
                            killerName: throwerName,
                            killerTeam: throwerTeam,
                            victimName,
                            victimTeam: vTeam,
                            headshot: false,
                            weapon: 'GRENADE',
                            killerEntityId: throwerEntityId,
                            victimEntityId: soldier._entityId,
                        });
                    }
                }
            } else if (soldier.ragdollActive) {
                this._applyBlastImpulse(pos, soldier, def);
            }
        }

        // Damage player
        if (player && player.alive && player.team !== throwerTeam) {
            const wasAlive = player.alive;
            this._applyBlastDamage(pos, player, def);
            if (wasAlive && !player.alive) {
                this.eventBus.emit('kill', {
                    killerName: throwerName,
                    killerTeam: throwerTeam,
                    victimName: 'Player',
                    victimTeam: player.team,
                    headshot: false,
                    weapon: 'GRENADE',
                    killerEntityId: throwerEntityId,
                    victimEntityId: player._entityId,
                });
            }
        }

        // Damage vehicles
        if (vehicleManager) {
            for (const v of vehicleManager.vehicles) {
                if (!v.alive) continue;
                const vp = v.mesh.position;
                _diff.set(vp.x - pos.x, vp.y - pos.y, vp.z - pos.z);
                const dist = _diff.length();
                if (dist < def.blastRadius) {
                    const dmg = def.damageCenter * (1 - dist / def.blastRadius);
                    v.takeDamage(dmg, throwerEntityId, throwerName, throwerTeam);
                }
            }
        }

        this.eventBus.emit('grenadeExploded', { position: pos, team: throwerTeam });
        if (enemyHitCount > 0) {
            this.eventBus.emit('grenadeDamage', {
                throwerName, throwerTeam,
                hitCount: enemyHitCount, killCount: enemyKillCount,
            });
        }
    }

    _applyBlastDamage(pos, target, def) {
        const targetPos = target.getPosition();
        _diff.subVectors(targetPos, pos);
        const dist = _diff.length();
        if (dist >= def.blastRadius) return;

        const dmg = def.damageCenter * (1 - dist / def.blastRadius);
        target.takeDamage(dmg, pos, null);
        this._applyBlastImpulse(pos, target, def);
    }

    _applyBlastImpulse(pos, target, def) {
        if (!target.body) return;
        const targetPos = target.getPosition();
        _diff.subVectors(targetPos, pos);
        const dist = _diff.length();
        if (dist >= def.blastRadius) return;

        const falloff = 1 - dist / def.blastRadius;
        const strength = 600 * falloff;
        _diff.normalize();
        _impulseVec.set(_diff.x * strength, strength * 0.7, _diff.z * strength);
        target.body.applyImpulse(_impulseVec);
    }
}
