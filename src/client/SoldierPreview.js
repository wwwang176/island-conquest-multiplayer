import * as THREE from 'three';
import { buildSoldierMesh, applySoldierAppearance } from './EntityRenderer.js';

/**
 * A small spinning soldier rendered into its own canvas, used by the join
 * screen's colour picker. Builds the same mesh the game uses, so what the
 * player sees here is exactly what everyone else will see in the match.
 */
export class SoldierPreview {
    /**
     * @param {HTMLElement} container - element the canvas is appended to
     * @param {object} options
     * @param {number} options.teamColor - hex team colour
     * @param {string} options.weaponId
     * @param {number} options.appearance - packed head/leg palette indices
     * @param {number} [options.width=240]
     * @param {number} [options.height=340]
     */
    constructor(container, { teamColor, weaponId, appearance, width = 240, height = 340 }) {
        this.teamColor = teamColor;
        this._disposed = false;
        this._rafId = null;

        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.setSize(width, height, false);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.domElement.style.cssText =
            `width:${width}px;height:${height}px;cursor:grab;touch-action:none;`;
        container.appendChild(this.renderer.domElement);

        this.scene = new THREE.Scene();
        this.scene.add(new THREE.AmbientLight(0xffffff, 0.75));
        const key = new THREE.DirectionalLight(0xfff5e0, 1.0);
        key.position.set(3, 5, 4);
        this.scene.add(key);
        const rim = new THREE.DirectionalLight(0x88aaff, 0.35);
        rim.position.set(-3, 2, -4);
        this.scene.add(rim);

        this.camera = new THREE.PerspectiveCamera(32, width / height, 0.1, 50);
        this.camera.position.set(0, 1.05, 4.2);
        this.camera.lookAt(0, 0.95, 0);

        // Pivot lets the soldier spin around its own vertical axis
        this.pivot = new THREE.Group();
        this.scene.add(this.pivot);

        this.mesh = buildSoldierMesh(teamColor, weaponId, appearance);
        this.pivot.add(this.mesh);

        this._autoSpin = true;
        this._attachDragToSpin();

        this._lastTime = performance.now();
        this._loop();
    }

    /** Recolour the preview without rebuilding the mesh. */
    setAppearance(appearance) {
        if (this._disposed) return;
        applySoldierAppearance(this.mesh, appearance, this.teamColor);
    }

    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        if (this._rafId !== null) cancelAnimationFrame(this._rafId);
        this.mesh.traverse((child) => {
            if (child.isMesh) {
                child.geometry?.dispose();
                if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
                else child.material?.dispose();
            }
        });
        this.renderer.dispose();
        this.renderer.domElement.remove();
    }

    _attachDragToSpin() {
        const el = this.renderer.domElement;
        let dragging = false;
        let lastX = 0;

        el.addEventListener('pointerdown', (e) => {
            dragging = true;
            lastX = e.clientX;
            this._autoSpin = false;
            el.style.cursor = 'grabbing';
            el.setPointerCapture(e.pointerId);
        });
        el.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            this.pivot.rotation.y += (e.clientX - lastX) * 0.01;
            lastX = e.clientX;
        });
        const endDrag = (e) => {
            if (!dragging) return;
            dragging = false;
            el.style.cursor = 'grab';
            el.releasePointerCapture?.(e.pointerId);
        };
        el.addEventListener('pointerup', endDrag);
        el.addEventListener('pointercancel', endDrag);
    }

    _loop() {
        if (this._disposed) return;
        const now = performance.now();
        const dt = Math.min((now - this._lastTime) / 1000, 0.1);
        this._lastTime = now;

        if (this._autoSpin) this.pivot.rotation.y += dt * 0.6;

        this.renderer.render(this.scene, this.camera);
        this._rafId = requestAnimationFrame(() => this._loop());
    }
}
