import * as THREE from 'three';

/**
 * Floating name labels for human players.
 *
 * Built the same way as the flag labels in FlagPoint — a canvas texture on a
 * THREE.Sprite, which always faces the camera for free. Two differences: the
 * text is drawn with an outline so it stays legible over bright terrain, and
 * depth testing is off so a plate is never swallowed by a hill or a building
 * (from the overhead spectator camera, terrain would hide almost everyone).
 */

const CANVAS_W = 256;
const CANVAS_H = 64;
const BASE_FONT_PX = 34;
const TEXT_PADDING = 20;

/** Height above the soldier's origin — the head tops out around y = 1.73. */
export const NAMEPLATE_HEIGHT = 2.05;

/** Fraction of the viewport height a plate should occupy, before clamping. */
const SCREEN_HEIGHT_FRACTION = 0.030;
const MIN_WORLD_HEIGHT = 0.35;
const MAX_WORLD_HEIGHT = 6.0;

const TEAM_TEXT_COLORS = {
    teamA: '#a8c8ff',
    teamB: '#ffb0b0',
};

/** Draw the name into a canvas, shrinking the font if it would overflow. */
function drawNameCanvas(canvas, text, team) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    ctx.font = `bold ${BASE_FONT_PX}px Arial`;
    const maxWidth = CANVAS_W - TEXT_PADDING * 2;
    const measured = ctx.measureText(text).width;
    if (measured > maxWidth) {
        ctx.font = `bold ${Math.floor(BASE_FONT_PX * (maxWidth / measured))}px Arial`;
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(text, CANVAS_W / 2, CANVAS_H / 2);
    ctx.fillStyle = TEAM_TEXT_COLORS[team] || '#ffffff';
    ctx.fillText(text, CANVAS_W / 2, CANVAS_H / 2);
}

/**
 * Create a nameplate sprite.
 * @param {string} text
 * @param {string} team - 'teamA' | 'teamB', picks the text tint
 * @returns {THREE.Sprite}
 */
export function createNameplate(text, team) {
    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
    drawNameCanvas(canvas, text, team);

    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        depthTest: false,
        depthWrite: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.position.y = NAMEPLATE_HEIGHT;
    // Draw after the world so the plate lands on top of everything it overlaps
    sprite.renderOrder = 10;
    sprite.userData._canvas = canvas;
    return sprite;
}

/** Redraw an existing plate's text in place. */
export function updateNameplateText(sprite, text, team) {
    drawNameCanvas(sprite.userData._canvas, text, team);
    sprite.material.map.needsUpdate = true;
}

/**
 * Scale a plate so it covers a constant slice of the viewport regardless of
 * distance, then clamp so it neither vanishes overhead nor fills the screen
 * up close.
 * @param {THREE.Sprite} sprite
 * @param {THREE.PerspectiveCamera} camera
 * @param {number} distance - camera to soldier, in world units
 */
export function updateNameplateScale(sprite, camera, distance) {
    const visibleHeight = 2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const worldHeight = THREE.MathUtils.clamp(
        visibleHeight * SCREEN_HEIGHT_FRACTION, MIN_WORLD_HEIGHT, MAX_WORLD_HEIGHT
    );
    sprite.scale.set(worldHeight * (CANVAS_W / CANVAS_H), worldHeight, 1);
}

/**
 * Whether a player's plate should be drawn this frame.
 *
 * Spectators see everyone; once you have a team you see only teammates, which
 * keeps enemy positions from leaking through the see-through plates. You never
 * see your own name — in first person it would be behind the camera anyway, and
 * in the death cam it reads as a bug.
 *
 * @param {{alive: boolean, team: string}} entry
 * @param {number} entityId
 * @param {string|null} viewerTeam - null while spectating
 * @param {number} viewerEntityId
 */
export function isNameplateVisible(entry, entityId, viewerTeam, viewerEntityId) {
    if (!entry.alive) return false;
    if (entityId === viewerEntityId) return false;
    return viewerTeam === null || entry.team === viewerTeam;
}

/** Release a plate's texture and material. */
export function disposeNameplate(sprite) {
    sprite.material.map?.dispose();
    sprite.material.dispose();
}
