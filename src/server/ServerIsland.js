import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Noise } from '../world/Noise.js';
import { NavGrid } from '../ai/NavGrid.js';
import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Dummy material for server-side raycasting (Raycaster needs a material on meshes)
const dummyMat = new THREE.MeshBasicMaterial();

/**
 * Server-side island generator.
 * Produces heightData, collidable meshes (with BVH), obstacle descriptors,
 * cannon-es heightfield, and NavGrid — everything needed for authoritative
 * game logic. No rendering, no scene, no visual materials.
 */
export class ServerIsland {
    constructor(physics, coverSystem, seed) {
        this.physics = physics;
        this.coverSystem = coverSystem;
        this.noise = new Noise(seed);

        // Decide flag layout (deterministic from noise, not Math.random)
        this._flagLayout = this.noise.noise2D(seed * 0.001, 0) < -0.17 ? '1-3-1' : 'linear';

        // Island dimensions (must match client Island.js)
        this.width = 300;
        this.depth = 120;
        this.segW = 150;
        this.segD = 60;
        this.maxHeight = 9;

        this.heightData = [];
        this.collidables = [];
        this._obstacleDescs = [];
        this.obstacleBounds = [];
        this._exclusionZones = [];

        // Geometry collection arrays for batch merging
        this._rockGeos = [];
        this._crateGeos = [];
        this._sandbagGeos = [];
        this._wallGeos = [];

        this._generateTerrain();
        this._generateWater();
        this._flagPositionsCache = this.getFlagPositions();
        this.heliSpawnPositions = this._computeHeliSpawns();
        this._generateCovers();
        this._generateBuildings();
        // No vegetation on server (pure visual)
    }

    // ── Height query ──

    getHeightAt(x, z) {
        const u = (x + this.width / 2) / this.width;
        const v = (z + this.depth / 2) / this.depth;
        if (u < 0 || u > 1 || v < 0 || v > 1) return -5;

        const col = Math.min(Math.floor(u * this.segW), this.segW - 1);
        const row = Math.min(Math.floor(v * this.segD), this.segD - 1);
        const col2 = Math.min(col + 1, this.segW);
        const row2 = Math.min(row + 1, this.segD);
        const fx = u * this.segW - col;
        const fy = v * this.segD - row;

        const stride = this.segW + 1;
        const h00 = this.heightData[row * stride + col] || 0;
        const h10 = this.heightData[row * stride + col2] || 0;
        const h01 = this.heightData[row2 * stride + col] || 0;
        const h11 = this.heightData[row2 * stride + col2] || 0;

        return h00 * (1 - fx) * (1 - fy) + h10 * fx * (1 - fy) +
               h01 * (1 - fx) * fy + h11 * fx * fy;
    }

    // ── Terrain ──

    _generateTerrain() {
        const geo = new THREE.PlaneGeometry(this.width, this.depth, this.segW, this.segD);
        geo.rotateX(-Math.PI / 2);

        const positions = geo.attributes.position;
        this.heightData = new Float32Array(positions.count);

        for (let i = 0; i < positions.count; i++) {
            const x = positions.getX(i);
            const z = positions.getZ(i);
            const h = this._calcHeight(x, z);
            positions.setY(i, h);
            this.heightData[i] = h;
        }

        geo.computeVertexNormals();

        this.terrainMesh = new THREE.Mesh(geo, dummyMat);
        this.terrainMesh.userData.surfaceType = 'terrain';
        this.collidables.push(this.terrainMesh);

        // BVH acceleration for raycast
        geo.computeBoundsTree();

        // Physics heightfield
        this._createTerrainPhysics();
    }

    _calcHeight(x, z) {
        const nx = x / this.width;
        const nz = z / this.depth;

        const exScale = this._flagLayout === '1-3-1' ? 0.35 : 0.45;
        const ex = (x / (this.width * exScale));
        const ezScale = this._flagLayout === '1-3-1' ? 0.48 : 0.40;
        const ez = (z / (this.depth * ezScale));
        const distFromCenter = ex * ex + ez * ez;
        const islandMask = Math.max(0, 1 - distFromCenter);
        const smoothMask = islandMask * islandMask * (3 - 2 * islandMask);

        const base = this.noise.fbm(nx * 3, nz * 3, 4, 2, 0.5);
        const ridgeWidth = 2.0;
        const centerRidge = Math.exp(-ez * ez * ridgeWidth) * 0.4;
        const detail = this.noise.fbm(nx * 8 + 100, nz * 8 + 100, 3, 2, 0.4) * 0.3;

        const rawHeight = (base + centerRidge + detail) * this.maxHeight;
        const height = rawHeight * smoothMask;
        return height < 0.3 ? height - 1 : height;
    }

    _createTerrainPhysics() {
        const matrix = [];
        for (let xi = 0; xi <= this.segW; xi++) {
            const row = [];
            for (let yi = 0; yi <= this.segD; yi++) {
                const threeRow = this.segD - yi;
                row.push(this.heightData[threeRow * (this.segW + 1) + xi]);
            }
            matrix.push(row);
        }

        const hfShape = new CANNON.Heightfield(matrix, {
            elementSize: this.depth / this.segD,
        });

        const hfBody = new CANNON.Body({
            mass: 0,
            material: this.physics.defaultMaterial,
        });
        hfBody.addShape(hfShape);
        hfBody.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
        hfBody.position.set(-this.width / 2, 0, this.depth / 2);
        this.physics.addBody(hfBody);
        this.terrainBody = hfBody;
    }

    // ── Water (collidable plane for raycast) ──

    _generateWater() {
        const waterGeo = new THREE.PlaneGeometry(this.width * 2, this.depth * 2);
        const water = new THREE.Mesh(waterGeo, dummyMat);
        water.rotation.x = -Math.PI / 2;
        water.position.y = -0.3;
        water.updateMatrixWorld(true);
        water.userData.surfaceType = 'water';
        this.collidables.push(water);
        waterGeo.computeBoundsTree();
    }

    // ── Flag positions ──

    _getFlagXPositions() {
        const spacing = this.width * 0.7 / 4;
        const startX = -this.width * 0.35;
        return Array.from({ length: 5 }, (_, i) => startX + i * spacing);
    }

    _findFlagPos(targetX, targetZ, scanAxis = 'z') {
        let bestX = targetX, bestZ = targetZ;
        let bestH = -Infinity;
        for (let offset = -10; offset <= 10; offset += 2) {
            const x = scanAxis === 'x' ? targetX + offset : targetX;
            const z = scanAxis === 'z' ? targetZ + offset : targetZ;
            const h = this.getHeightAt(x, z);
            if (h > bestH && h > 0.5) {
                bestH = h;
                bestX = x;
                bestZ = z;
            }
        }
        return new THREE.Vector3(bestX, Math.max(bestH, 1), bestZ);
    }

    getFlagPositions() {
        if (this._flagPositionsCache) return this._flagPositionsCache;

        const xPositions = this._getFlagXPositions();

        if (this._flagLayout === '1-3-1') {
            const midX = xPositions[2];
            const zSpread = 40;
            const baseLeft = (xPositions[0] + xPositions[1]) / 2;
            const baseRight = (xPositions[3] + xPositions[4]) / 2;
            return [
                this._findFlagPos(baseLeft, 0),
                this._findFlagPos(midX, -zSpread, 'x'),
                this._findFlagPos(midX, 0, 'x'),
                this._findFlagPos(midX, zSpread, 'x'),
                this._findFlagPos(baseRight, 0),
            ];
        }

        return xPositions.map(fx => this._findFlagPos(fx, 0));
    }

    // ── Helicopter spawns ──

    _computeHeliSpawns() {
        const flags = this._flagPositionsCache;
        const bases = [flags[0], flags[flags.length - 1]];
        const HELI_CLEAR_RADIUS = 6;
        const positions = [];
        for (const base of bases) {
            let pos = null;
            for (let attempt = 0; attempt < 12; attempt++) {
                const angle = attempt * (Math.PI * 2 / 12);
                const x = base.x + Math.cos(angle) * 8;
                const z = base.z + Math.sin(angle) * 8;
                const h = this.getHeightAt(x, z);
                if (h > 0.5 && h < 6) {
                    pos = { x, y: h, z };
                    break;
                }
            }
            if (!pos) {
                const h = this.getHeightAt(base.x, base.z);
                pos = { x: base.x, y: Math.max(h, 1), z: base.z };
            }
            positions.push(pos);
            this._exclusionZones.push({ x: pos.x, z: pos.z, r: HELI_CLEAR_RADIUS });
        }
        return positions;
    }

    _inExclusionZone(x, z) {
        for (const zone of this._exclusionZones) {
            const dx = x - zone.x;
            const dz = z - zone.z;
            if (dx * dx + dz * dz < zone.r * zone.r) return true;
        }
        return false;
    }

    // ── Cover generation ──

    _generateCovers() {
        const flagPositions = this._flagPositionsCache;

        for (let fi = 0; fi < flagPositions.length; fi++) {
            const fp = flagPositions[fi];
            this._placeCoverCluster(fp.x, fp.z, 14 + Math.floor(this.noise.noise2D(fp.x * 0.1, fi) * 4 + 4));
        }

        if (this._flagLayout === '1-3-1') {
            const bases = [flagPositions[0], flagPositions[4]];
            const centers = [flagPositions[1], flagPositions[2], flagPositions[3]];
            for (const base of bases) {
                for (const center of centers) {
                    const midX = (base.x + center.x) / 2;
                    const midZ = (base.z + center.z) / 2;
                    this._placeCoverCluster(midX, midZ, 8 + Math.floor(this.noise.noise2D(midX * 0.1, midZ * 0.1) * 4));
                }
            }
            for (let i = 0; i < centers.length - 1; i++) {
                const a = centers[i], b = centers[i + 1];
                const midX = (a.x + b.x) / 2;
                const midZ = (a.z + b.z) / 2;
                this._placeCoverCluster(midX, midZ, 8 + Math.floor(this.noise.noise2D(midX * 0.1, 50) * 3));
            }
        } else {
            for (let fi = 0; fi < flagPositions.length - 1; fi++) {
                const a = flagPositions[fi], b = flagPositions[fi + 1];
                const midX = (a.x + b.x) / 2;
                const midZ = (a.z + b.z) / 2;
                this._placeCoverCluster(midX, midZ, 10 + Math.floor(this.noise.noise2D(midX * 0.1, 50) * 4));
                this._placeCoverCluster(midX, midZ + 15, 5 + Math.floor(this.noise.noise2D(midX * 0.1, 70) * 3));
                this._placeCoverCluster(midX, midZ - 15, 5 + Math.floor(this.noise.noise2D(midX * 0.1, 90) * 3));
            }
        }

        for (let i = 0; i < 55; i++) {
            const rx = (this.noise.noise2D(i * 7.3, 200) * 0.8) * this.width / 2;
            const rz = (this.noise.noise2D(i * 3.7, 300) * 0.8) * this.depth / 2;
            const h = this.getHeightAt(rx, rz);
            if (h > 0.5 && !this._inExclusionZone(rx, rz)) {
                this._placeRock(rx, h, rz);
            }
        }

        this._mergeObstacles();
    }

    _placeCoverCluster(cx, cz, count) {
        for (let i = 0; i < count; i++) {
            const angle = this.noise.noise2D(cx + i * 13, cz + i * 7) * Math.PI * 2;
            const radius = 5 + Math.abs(this.noise.noise2D(cx + i * 5, cz + i * 11)) * 15;
            const x = cx + Math.cos(angle) * radius;
            const z = cz + Math.sin(angle) * radius;
            const h = this.getHeightAt(x, z);

            if (h < 0.5) continue;
            if (this._inExclusionZone(x, z)) continue;

            const r = Math.abs(this.noise.noise2D(x * 0.5, z * 0.5));
            if (r < 0.35) {
                this._placeRock(x, h, z);
            } else if (r < 0.6) {
                this._placeCrate(x, h, z);
            } else if (r < 0.8) {
                this._placeSandbag(x, h, z);
            } else {
                this._placeWall(x, h, z);
            }
        }
    }

    _placeRock(x, h, z) {
        const scale = 1 + Math.abs(this.noise.noise2D(x, z)) * 2;
        const geo = new THREE.DodecahedronGeometry(scale, 0);

        const pos = geo.attributes.position;
        const deform = new Float32Array(pos.count * 3);
        for (let i = 0; i < pos.count; i++) {
            const vx = pos.getX(i);
            const vy = pos.getY(i);
            const vz = pos.getZ(i);
            const noise = this.noise.noise2D(vx * 2 + x, vz * 2 + z) * 0.3;
            const mx = 1 + noise;
            const my = 0.6 + Math.abs(noise);
            const mz = 1 + noise;
            pos.setX(i, vx * mx);
            pos.setY(i, vy * my);
            pos.setZ(i, vz * mz);
            deform[i * 3] = mx;
            deform[i * 3 + 1] = my;
            deform[i * 3 + 2] = mz;
        }

        const rotY = this.noise.noise2D(x * 3, z * 3) * Math.PI;

        const mat4 = new THREE.Matrix4();
        mat4.compose(
            new THREE.Vector3(x, h + scale * 0.3, z),
            new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY),
            new THREE.Vector3(1, 1, 1)
        );
        geo.applyMatrix4(mat4);
        geo.computeVertexNormals();
        geo.computeBoundingBox();
        this.obstacleBounds.push(geo.boundingBox.clone());
        this._rockGeos.push(geo);

        this._obstacleDescs.push({
            type: 'rock', x, y: h + scale * 0.3, z, scale, rotY, deform
        });

        // Physics
        const body = new CANNON.Body({ mass: 0, material: this.physics.defaultMaterial });
        body.addShape(new CANNON.Sphere(scale * 0.7));
        body.position.set(x, h + scale * 0.3, z);
        this.physics.addBody(body);

        // Cover
        const normal = new THREE.Vector3(
            this.noise.noise2D(x * 5, z * 5),
            0,
            this.noise.noise2D(z * 5, x * 5)
        ).normalize();
        this.coverSystem.register(new THREE.Vector3(x, h, z), normal, 1.0, 2);
    }

    _placeCrate(x, h, z) {
        const size = 0.8 + Math.abs(this.noise.noise2D(x * 2, z * 2)) * 0.6;
        const w = size * 1.2, ch = size, d = size;
        const geo = new THREE.BoxGeometry(w, ch, d);
        const rotY = this.noise.noise2D(x, z) * Math.PI;

        const mat4 = new THREE.Matrix4();
        mat4.compose(
            new THREE.Vector3(x, h + size / 2, z),
            new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY),
            new THREE.Vector3(1, 1, 1)
        );
        geo.applyMatrix4(mat4);
        geo.computeBoundingBox();
        this.obstacleBounds.push(geo.boundingBox.clone());
        this._crateGeos.push(geo);

        this._obstacleDescs.push({
            type: 'box', x, y: h + size / 2, z, w, h: ch, d, rotY
        });

        const body = new CANNON.Body({ mass: 0, material: this.physics.defaultMaterial });
        body.addShape(new CANNON.Box(new CANNON.Vec3(size * 0.6, size / 2, size / 2)));
        body.position.set(x, h + size / 2, z);
        body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), rotY);
        this.physics.addBody(body);

        this.coverSystem.register(
            new THREE.Vector3(x, h, z),
            new THREE.Vector3(Math.cos(rotY), 0, Math.sin(rotY)),
            0.5, 1
        );
    }

    _placeSandbag(x, h, z) {
        const geo = new THREE.BoxGeometry(2.5, 0.8, 0.6);
        const rotY = this.noise.noise2D(x * 2, z * 2) * Math.PI;

        const mat4 = new THREE.Matrix4();
        mat4.compose(
            new THREE.Vector3(x, h + 0.4, z),
            new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY),
            new THREE.Vector3(1, 1, 1)
        );
        geo.applyMatrix4(mat4);
        geo.computeBoundingBox();
        this.obstacleBounds.push(geo.boundingBox.clone());
        this._sandbagGeos.push(geo);

        this._obstacleDescs.push({
            type: 'box', x, y: h + 0.4, z, w: 2.5, h: 0.8, d: 0.6, rotY
        });

        const body = new CANNON.Body({ mass: 0, material: this.physics.defaultMaterial });
        body.addShape(new CANNON.Box(new CANNON.Vec3(1.25, 0.4, 0.3)));
        body.position.set(x, h + 0.4, z);
        body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), rotY);
        this.physics.addBody(body);

        this.coverSystem.register(
            new THREE.Vector3(x, h, z),
            new THREE.Vector3(Math.cos(rotY + Math.PI / 2), 0, Math.sin(rotY + Math.PI / 2)),
            0.5, 2
        );
    }

    _placeWall(x, h, z) {
        const wallH = 2.5 + Math.abs(this.noise.noise2D(x, z)) * 1.5;
        const wallW = 3 + Math.abs(this.noise.noise2D(x * 3, z * 3)) * 2;
        const geo = new THREE.BoxGeometry(wallW, wallH, 0.4);
        const rotY = this.noise.noise2D(x * 4, z * 4) * Math.PI;

        const mat4 = new THREE.Matrix4();
        mat4.compose(
            new THREE.Vector3(x, h + wallH / 2, z),
            new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY),
            new THREE.Vector3(1, 1, 1)
        );
        geo.applyMatrix4(mat4);
        geo.computeBoundingBox();
        this.obstacleBounds.push(geo.boundingBox.clone());
        this._wallGeos.push(geo);

        this._obstacleDescs.push({
            type: 'box', x, y: h + wallH / 2, z, w: wallW, h: wallH, d: 0.4, rotY
        });

        const body = new CANNON.Body({ mass: 0, material: this.physics.defaultMaterial });
        body.addShape(new CANNON.Box(new CANNON.Vec3(wallW / 2, wallH / 2, 0.2)));
        body.position.set(x, h + wallH / 2, z);
        body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), rotY);
        this.physics.addBody(body);

        const nx = Math.cos(rotY + Math.PI / 2);
        const nz = Math.sin(rotY + Math.PI / 2);
        this.coverSystem.register(new THREE.Vector3(x + nx, h, z + nz), new THREE.Vector3(nx, 0, nz), 1.0, 2);
        this.coverSystem.register(new THREE.Vector3(x - nx, h, z - nz), new THREE.Vector3(-nx, 0, -nz), 1.0, 2);
    }

    _mergeObstacles() {
        const configs = [
            { geos: this._rockGeos, surface: 'rock' },
            { geos: this._crateGeos, surface: 'wood' },
            { geos: this._sandbagGeos, surface: 'dirt' },
            { geos: this._wallGeos, surface: 'rock' },
        ];
        for (const cfg of configs) {
            if (cfg.geos.length === 0) continue;
            const merged = mergeGeometries(cfg.geos);
            for (const g of cfg.geos) g.dispose();
            const mesh = new THREE.Mesh(merged, dummyMat);
            mesh.userData.surfaceType = cfg.surface;
            this.collidables.push(mesh);
            merged.computeBoundsTree();
        }
        this._rockGeos = null;
        this._crateGeos = null;
        this._sandbagGeos = null;
        this._wallGeos = null;
    }

    // ── Fortifications (battlements) ──

    _generateBuildings() {
        const battlementGeos = [];
        const noise = this.noise;
        const flagPositions = this._flagPositionsCache;

        for (let fi = 0; fi < flagPositions.length; fi++) {
            const fp = flagPositions[fi];
            const groundY = this.getHeightAt(fp.x, fp.z);
            if (groundY < 0.5) continue;

            const segCount = 3 + (noise.noise2D(fp.x * 0.5, fi * 10) > 0 ? 1 : 0);
            const baseAngle = fi * 1.2 + noise.noise2D(fi * 7, 50) * 0.5;
            const arcSpan = Math.PI * 0.8;
            const radius = 8 + Math.abs(noise.noise2D(fp.x * 0.2, fp.z * 0.2)) * 4;

            for (let si = 0; si < segCount; si++) {
                const segAngle = baseAngle + (si / (segCount - 1 || 1) - 0.5) * arcSpan;
                const wx = fp.x + Math.cos(segAngle) * radius;
                const wz = fp.z + Math.sin(segAngle) * radius;
                const wGroundY = this.getHeightAt(wx, wz);
                if (wGroundY < 0.5) continue;
                if (this._inExclusionZone(wx, wz)) continue;

                const faceAngle = segAngle + noise.noise2D(wx * 0.4, wz * 0.4) * 0.15;
                this._buildBattlement(battlementGeos, wx, wz, wGroundY, faceAngle);
            }
        }

        if (battlementGeos.length > 0) {
            const merged = mergeGeometries(battlementGeos);
            for (const g of battlementGeos) g.dispose();
            const mesh = new THREE.Mesh(merged, dummyMat);
            mesh.userData.surfaceType = 'sand';
            this.collidables.push(mesh);
            merged.computeBoundsTree();
        }
    }

    _buildBattlement(battlementGeos, cx, cz, groundY, faceAngle) {
        const merlonW = 0.8, merlonH = 1.2, merlonD = 0.8;
        const gapW = 0.3, merlonCount = 3;
        const totalW = merlonCount * merlonW + (merlonCount - 1) * gapW;
        const rotQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), faceAngle);
        const segGeos = [];

        for (let mi = 0; mi < merlonCount; mi++) {
            const localX = -totalW / 2 + mi * (merlonW + gapW) + merlonW / 2;
            const localY = groundY + merlonH / 2;

            const geo = new THREE.BoxGeometry(merlonW, merlonH, merlonD);
            const mat4 = new THREE.Matrix4();
            const offset = new THREE.Vector3(localX, 0, 0).applyQuaternion(rotQ);
            mat4.compose(
                new THREE.Vector3(cx + offset.x, localY, cz + offset.z),
                rotQ,
                new THREE.Vector3(1, 1, 1)
            );
            geo.applyMatrix4(mat4);
            segGeos.push(geo);
        }

        if (segGeos.length > 0) {
            const merged = mergeGeometries(segGeos);
            for (const g of segGeos) g.dispose();
            merged.computeBoundingBox();
            this.obstacleBounds.push(merged.boundingBox.clone());
            battlementGeos.push(merged);
        }

        const bodyW = totalW, bodyH = merlonH, bodyD = merlonD;
        const bodyY = groundY + bodyH / 2;
        const body = new CANNON.Body({ mass: 0, material: this.physics.defaultMaterial });
        body.addShape(new CANNON.Box(new CANNON.Vec3(bodyW / 2, bodyH / 2, bodyD / 2)));
        body.position.set(cx, bodyY, cz);
        body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), faceAngle);
        this.physics.addBody(body);

        this._obstacleDescs.push({
            type: 'box', x: cx, y: bodyY, z: cz,
            w: bodyW, h: bodyH, d: bodyD, rotY: faceAngle
        });

        const nx = Math.cos(faceAngle + Math.PI / 2);
        const nz = Math.sin(faceAngle + Math.PI / 2);
        this.coverSystem.register(
            new THREE.Vector3(cx + nx * 0.5, groundY, cz + nz * 0.5),
            new THREE.Vector3(nx, 0, nz), 1.0, 2
        );
        this.coverSystem.register(
            new THREE.Vector3(cx - nx * 0.5, groundY, cz - nz * 0.5),
            new THREE.Vector3(-nx, 0, -nz), 1.0, 2
        );
    }

    // ── NavGrid (via worker_threads) ──

    buildNavGridAsync() {
        const navCols = this.segW * 4;  // 600
        const navRows = this.segD * 4;  // 240

        return new Promise((resolve, reject) => {
            // Locate the worker script
            const __filename = fileURLToPath(import.meta.url);
            const __dirname = dirname(__filename);
            const workerPath = join(__dirname, '..', 'workers', 'navgrid-worker-node.js');

            const worker = new Worker(workerPath);

            const heightDataCopy = new Float32Array(this.heightData);
            // Clone deform arrays since they'll be transferred
            const obstacleDescs = this._obstacleDescs.map(desc => {
                if (desc.deform) {
                    return { ...desc, deform: new Float32Array(desc.deform) };
                }
                return { ...desc };
            });

            const transferables = [heightDataCopy.buffer];
            for (const desc of obstacleDescs) {
                if (desc.deform) transferables.push(desc.deform.buffer);
            }

            worker.postMessage({
                obstacles: obstacleDescs,
                heightData: heightDataCopy,
                width: this.width,
                depth: this.depth,
                segW: this.segW,
                segD: this.segD,
                navCols,
                navRows,
            }, transferables);

            worker.on('message', (data) => {
                const { grid, heightGrid } = data;

                const navGrid = new NavGrid(this.width, this.depth, navCols, navRows);
                navGrid.grid = grid;
                navGrid._buildProxCost();
                this.navGrid = navGrid;

                worker.terminate();
                resolve({ navGrid, heightGrid });
            });

            worker.on('error', (err) => {
                reject(err);
            });
        });
    }

    /** Stub — server doesn't animate vegetation sway */
    updateSway() {}
}
