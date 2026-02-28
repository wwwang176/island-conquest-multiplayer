import * as CANNON from 'cannon-es';

/**
 * Server-side physics world (cannon-es).
 * Used for grenades, ragdolls, and vehicles.
 */
export class ServerPhysics {
    constructor() {
        this.world = new CANNON.World();
        this.world.gravity.set(0, -9.82, 0);
        this.world.broadphase = new CANNON.SAPBroadphase(this.world);
        this.world.allowSleep = true;

        // Default contact material
        this.defaultMaterial = new CANNON.Material('default');
        const defaultContact = new CANNON.ContactMaterial(
            this.defaultMaterial, this.defaultMaterial,
            { friction: 0.4, restitution: 0.1 }
        );
        this.world.addContactMaterial(defaultContact);
        this.world.defaultContactMaterial = defaultContact;
    }

    addBody(body) {
        this.world.addBody(body);
    }

    removeBody(body) {
        this.world.removeBody(body);
    }

    step(dt) {
        this.world.step(1 / 64, dt, 2);
    }
}
