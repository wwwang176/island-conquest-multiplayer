import * as THREE from 'three';

/**
 * Storm visual effects: rain particles + ground splashes + lightning flashes.
 * 2 draw calls total (rain Points + splash Points). Lightning is pure light manipulation.
 */

// ── Rain config ──
const RAIN_COUNT = 4000;
const RAIN_AREA = 60;        // horizontal spread around camera
const RAIN_HEIGHT = 40;      // vertical range above camera
const RAIN_SPEED = 25;       // fall speed (m/s)
const WIND_X = 3;            // horizontal wind drift
const WIND_Z = 1;

// ── Splash config ──
const SPLASH_COUNT = 800;
const SPLASH_SPAWN_RATE = 250; // per second
const SPLASH_RADIUS = 30;    // spawn radius around camera
const SPLASH_LIFE_MIN = 0.15;
const SPLASH_LIFE_MAX = 0.3;

// ── Lightning state machine ──
const LIT_IDLE = 0;
const LIT_FLASH1 = 1;
const LIT_GAP = 2;
const LIT_FLASH2 = 3;
const LIT_DECAY = 4;

const DEAD_Y = -9999;

// ── Rain shaders ──
const rainVertexShader = /* glsl */`
    attribute float aOpacity;
    varying float vOpacity;
    void main() {
        vOpacity = aOpacity;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        // Large point so the fragment shader can carve a thin vertical streak
        gl_PointSize = max(2.0, 10.0 * (200.0 / -mvPosition.z));
        gl_Position = projectionMatrix * mvPosition;
    }
`;

const rainFragmentShader = /* glsl */`
    varying float vOpacity;
    void main() {
        vec2 uv = gl_PointCoord;
        // Hair-thin vertical streak
        float xDist = abs(uv.x - 0.5);
        float maskX = smoothstep(0.008, 0.0, xDist);     // sub-pixel hairline
        float maskY = smoothstep(0.5, 0.05, abs(uv.y - 0.5)); // full height, soft tips
        float mask = maskX * maskY;
        if (mask < 0.01) discard;
        gl_FragColor = vec4(0.75, 0.8, 0.85, vOpacity * mask * 0.5);
    }
`;

// ── Splash shaders ──
const splashVertexShader = /* glsl */`
    attribute float aSize;
    attribute float aOpacity;
    varying float vOpacity;
    void main() {
        vOpacity = aOpacity;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * (200.0 / -mvPosition.z);
        gl_Position = projectionMatrix * mvPosition;
    }
`;

const splashFragmentShader = /* glsl */`
    varying float vOpacity;
    void main() {
        float d = length(gl_PointCoord - vec2(0.5));
        if (d > 0.5) discard;
        float alpha = vOpacity * (1.0 - d * 2.0);
        gl_FragColor = vec4(0.8, 0.85, 0.9, alpha);
    }
`;

export class StormVFX {
    /**
     * @param {THREE.Scene} scene
     * @param {THREE.Camera} camera
     * @param {{ sun: THREE.DirectionalLight, ambient: THREE.AmbientLight, hemi: THREE.HemisphereLight }} lights
     * @param {(x: number, z: number) => number} getHeightAt
     */
    constructor(scene, camera, lights, getHeightAt) {
        this.scene = scene;
        this.camera = camera;
        this.lights = lights;
        this.getHeightAt = getHeightAt;

        // ── Rain particles ──
        this._initRain();

        // ── Ground splashes ──
        this._initSplashes();

        // ── Lightning state ──
        this._litState = LIT_IDLE;
        this._litTimer = 2 + Math.random() * 8; // initial wait
        this._litDecayTimer = 0;
        this._litDoDouble = false;

        // Storm baseline intensities (set after _applyTimeOfDay)
        this._baseSunIntensity = lights.sun.intensity;
        this._baseAmbientIntensity = lights.ambient.intensity;
        this._baseHemiIntensity = lights.hemi.intensity;
    }

    // ═══════════════════════════════════════════════════════
    // Rain
    // ═══════════════════════════════════════════════════════

    _initRain() {
        const positions = new Float32Array(RAIN_COUNT * 3);
        const opacities = new Float32Array(RAIN_COUNT);

        // Scatter initial positions randomly
        for (let i = 0; i < RAIN_COUNT; i++) {
            const i3 = i * 3;
            positions[i3]     = (Math.random() - 0.5) * RAIN_AREA;
            positions[i3 + 1] = Math.random() * RAIN_HEIGHT;
            positions[i3 + 2] = (Math.random() - 0.5) * RAIN_AREA;
            opacities[i] = 0.3 + Math.random() * 0.7;
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.setAttribute('aOpacity', new THREE.BufferAttribute(opacities, 1));

        const mat = new THREE.ShaderMaterial({
            vertexShader: rainVertexShader,
            fragmentShader: rainFragmentShader,
            transparent: true,
            depthWrite: false,
        });

        const points = new THREE.Points(geo, mat);
        points.frustumCulled = false;
        this.scene.add(points);

        this._rainPositions = positions;
        this._rainOpacities = opacities;
        this._rainGeo = geo;
        this._rainMesh = points;
    }

    _updateRain(dt, camPos) {
        const pos = this._rainPositions;
        const halfArea = RAIN_AREA * 0.5;
        const fallDist = RAIN_SPEED * dt;
        const windDx = WIND_X * dt;
        const windDz = WIND_Z * dt;

        for (let i = 0; i < RAIN_COUNT; i++) {
            const i3 = i * 3;
            pos[i3]     += windDx;
            pos[i3 + 1] -= fallDist;
            pos[i3 + 2] += windDz;

            // Wrap around camera position
            let dx = pos[i3] - camPos.x;
            let dz = pos[i3 + 2] - camPos.z;

            if (dx > halfArea) pos[i3] -= RAIN_AREA;
            else if (dx < -halfArea) pos[i3] += RAIN_AREA;

            if (dz > halfArea) pos[i3 + 2] -= RAIN_AREA;
            else if (dz < -halfArea) pos[i3 + 2] += RAIN_AREA;

            // Respawn above camera when below ground
            const groundY = this.getHeightAt(pos[i3], pos[i3 + 2]);
            if (pos[i3 + 1] < groundY) {
                pos[i3]     = camPos.x + (Math.random() - 0.5) * RAIN_AREA;
                pos[i3 + 1] = camPos.y + RAIN_HEIGHT * 0.5 + Math.random() * RAIN_HEIGHT * 0.5;
                pos[i3 + 2] = camPos.z + (Math.random() - 0.5) * RAIN_AREA;
            }
        }

        this._rainGeo.attributes.position.needsUpdate = true;
    }

    // ═══════════════════════════════════════════════════════
    // Ground Splashes
    // ═══════════════════════════════════════════════════════

    _initSplashes() {
        const positions = new Float32Array(SPLASH_COUNT * 3);
        const sizes = new Float32Array(SPLASH_COUNT);
        const opacities = new Float32Array(SPLASH_COUNT);

        // All dead initially
        for (let i = 0; i < SPLASH_COUNT; i++) {
            positions[i * 3 + 1] = DEAD_Y;
            sizes[i] = 0;
            opacities[i] = 0;
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
        geo.setAttribute('aOpacity', new THREE.BufferAttribute(opacities, 1));

        const mat = new THREE.ShaderMaterial({
            vertexShader: splashVertexShader,
            fragmentShader: splashFragmentShader,
            transparent: true,
            depthWrite: false,
        });

        const points = new THREE.Points(geo, mat);
        points.frustumCulled = false;
        this.scene.add(points);

        this._splashPositions = positions;
        this._splashSizes = sizes;
        this._splashOpacities = opacities;
        this._splashGeo = geo;
        this._splashMesh = points;

        // Per-particle state
        this._splashLife = new Float32Array(SPLASH_COUNT);     // remaining life
        this._splashMaxLife = new Float32Array(SPLASH_COUNT);  // max life
        this._splashVx = new Float32Array(SPLASH_COUNT);
        this._splashVy = new Float32Array(SPLASH_COUNT);
        this._splashVz = new Float32Array(SPLASH_COUNT);
        this._splashNextIndex = 0;
        this._splashAccum = 0; // fractional spawn accumulator
    }

    _updateSplashes(dt, camPos) {
        // Spawn new splashes
        this._splashAccum += SPLASH_SPAWN_RATE * dt;
        while (this._splashAccum >= 1) {
            this._splashAccum -= 1;
            this._spawnOneSplash(camPos);
        }

        // Update existing splashes
        const pos = this._splashPositions;
        const life = this._splashLife;
        const maxLife = this._splashMaxLife;
        const opac = this._splashOpacities;
        const sz = this._splashSizes;
        const vx = this._splashVx;
        const vy = this._splashVy;
        const vz = this._splashVz;
        let anyAlive = false;

        for (let i = 0; i < SPLASH_COUNT; i++) {
            if (life[i] <= 0) continue;
            anyAlive = true;
            life[i] -= dt;

            const i3 = i * 3;
            // Apply velocity + gravity
            vy[i] -= 12 * dt;
            pos[i3]     += vx[i] * dt;
            pos[i3 + 1] += vy[i] * dt;
            pos[i3 + 2] += vz[i] * dt;

            if (life[i] <= 0) {
                life[i] = 0;
                pos[i3 + 1] = DEAD_Y;
                sz[i] = 0;
                opac[i] = 0;
            } else {
                // Fade out
                const t = life[i] / maxLife[i];
                opac[i] = t * 0.8;
            }
        }

        if (anyAlive || this._splashAccum > 0) {
            this._splashGeo.attributes.position.needsUpdate = true;
            this._splashGeo.attributes.aSize.needsUpdate = true;
            this._splashGeo.attributes.aOpacity.needsUpdate = true;
        }
    }

    _spawnOneSplash(camPos) {
        const idx = this._splashNextIndex;
        this._splashNextIndex = (this._splashNextIndex + 1) % SPLASH_COUNT;

        // Random position on ground near camera
        const rx = camPos.x + (Math.random() - 0.5) * SPLASH_RADIUS * 2;
        const rz = camPos.z + (Math.random() - 0.5) * SPLASH_RADIUS * 2;
        const groundY = this.getHeightAt(rx, rz);

        const i3 = idx * 3;
        this._splashPositions[i3]     = rx;
        this._splashPositions[i3 + 1] = groundY + 0.05;
        this._splashPositions[i3 + 2] = rz;

        // Small upward + random horizontal velocity
        this._splashVx[idx] = (Math.random() - 0.5) * 1.5;
        this._splashVy[idx] = 1.5 + Math.random() * 2;
        this._splashVz[idx] = (Math.random() - 0.5) * 1.5;

        // Life
        const lifeVal = SPLASH_LIFE_MIN + Math.random() * (SPLASH_LIFE_MAX - SPLASH_LIFE_MIN);
        this._splashLife[idx] = lifeVal;
        this._splashMaxLife[idx] = lifeVal;

        // Size + opacity
        this._splashSizes[idx] = 0.3 + Math.random() * 0.4;
        this._splashOpacities[idx] = 0.7;
    }

    // ═══════════════════════════════════════════════════════
    // Lightning (pure light intensity manipulation)
    // ═══════════════════════════════════════════════════════

    _updateLightning(dt) {
        const L = this.lights;

        switch (this._litState) {
            case LIT_IDLE:
                this._litTimer -= dt;
                if (this._litTimer <= 0) {
                    // Start flash sequence
                    this._litState = LIT_FLASH1;
                    this._litTimer = 0.08; // flash1 duration
                    this._litDoDouble = Math.random() < 0.5;
                    // Instant brightness spike
                    L.sun.intensity = 2.5;
                    L.ambient.intensity = 1.8;
                    L.hemi.intensity = 1.2;
                }
                break;

            case LIT_FLASH1:
                this._litTimer -= dt;
                if (this._litTimer <= 0) {
                    if (this._litDoDouble) {
                        this._litState = LIT_GAP;
                        this._litTimer = 0.06; // brief dark gap
                        // Drop back to baseline
                        L.sun.intensity = this._baseSunIntensity;
                        L.ambient.intensity = this._baseAmbientIntensity;
                        L.hemi.intensity = this._baseHemiIntensity;
                    } else {
                        // Single flash → decay
                        this._litState = LIT_DECAY;
                        this._litDecayTimer = 0.3;
                    }
                }
                break;

            case LIT_GAP:
                this._litTimer -= dt;
                if (this._litTimer <= 0) {
                    // Second flash
                    this._litState = LIT_FLASH2;
                    this._litTimer = 0.06;
                    L.sun.intensity = 2.0;
                    L.ambient.intensity = 1.5;
                    L.hemi.intensity = 1.0;
                }
                break;

            case LIT_FLASH2:
                this._litTimer -= dt;
                if (this._litTimer <= 0) {
                    this._litState = LIT_DECAY;
                    this._litDecayTimer = 0.3;
                }
                break;

            case LIT_DECAY: {
                this._litDecayTimer -= dt;
                const t = Math.max(0, this._litDecayTimer / 0.3);
                // Lerp from bright back to baseline
                L.sun.intensity = this._baseSunIntensity + (2.0 - this._baseSunIntensity) * t;
                L.ambient.intensity = this._baseAmbientIntensity + (1.5 - this._baseAmbientIntensity) * t;
                L.hemi.intensity = this._baseHemiIntensity + (1.0 - this._baseHemiIntensity) * t;

                if (this._litDecayTimer <= 0) {
                    // Back to idle, schedule next flash
                    this._litState = LIT_IDLE;
                    this._litTimer = 3 + Math.random() * 7;
                    L.sun.intensity = this._baseSunIntensity;
                    L.ambient.intensity = this._baseAmbientIntensity;
                    L.hemi.intensity = this._baseHemiIntensity;
                }
                break;
            }
        }
    }

    // ═══════════════════════════════════════════════════════
    // Main update
    // ═══════════════════════════════════════════════════════

    update(dt, cameraPosition) {
        this._updateRain(dt, cameraPosition);
        this._updateSplashes(dt, cameraPosition);
        this._updateLightning(dt);
    }

    // ═══════════════════════════════════════════════════════
    // Cleanup
    // ═══════════════════════════════════════════════════════

    dispose() {
        // Rain
        this._rainGeo.dispose();
        this._rainMesh.material.dispose();
        this.scene.remove(this._rainMesh);

        // Splashes
        this._splashGeo.dispose();
        this._splashMesh.material.dispose();
        this.scene.remove(this._splashMesh);

        // Restore baseline light intensities
        this.lights.sun.intensity = this._baseSunIntensity;
        this.lights.ambient.intensity = this._baseAmbientIntensity;
        this.lights.hemi.intensity = this._baseHemiIntensity;
    }
}
