/**
 * Player appearance — the head and leg colours a player picks when joining.
 *
 * The torso always stays the team colour, so friend/foe still reads correctly
 * at distance; only the head and legs are personal. Two 4-bit palette indices
 * pack into a single byte, which is what travels on the wire.
 *
 * Index 0 is the "default" slot and keeps a soldier looking exactly as it did
 * before this feature existed: skin-toned head, team-tinted legs. AI COMs never
 * pick an appearance, so they always resolve through index 0.
 */

/** Palette index 0 means "leave this slot at its default colour". */
export const APPEARANCE_DEFAULT = 0;

/** Neutral appearance byte — both slots on default. */
export const DEFAULT_APPEARANCE = 0;

/** Skin tone used for the head when the head slot is on default. */
export const SKIN_COLOR = 0xddbb99;

/** Legs are this fraction of the team colour when the leg slot is on default. */
export const DEFAULT_LEG_TINT = 0.7;

/**
 * 16 palette slots. Slot 0 is the default sentinel and has no colour of its own;
 * slots 1-15 are picked to stay distinguishable from each other and from both
 * team colours under the game's Lambert lighting.
 */
export const COLOR_PALETTE = [
    { name: 'Default', hex: null },
    { name: 'White',   hex: 0xf0f0f0 },
    { name: 'Black',   hex: 0x202020 },
    { name: 'Grey',    hex: 0x808080 },
    { name: 'Crimson', hex: 0xd83030 },
    { name: 'Orange',  hex: 0xff8000 },
    { name: 'Gold',    hex: 0xffd21e },
    { name: 'Lime',    hex: 0x9acd32 },
    { name: 'Green',   hex: 0x2eaa4a },
    { name: 'Teal',    hex: 0x18c7c7 },
    { name: 'Sky',     hex: 0x40a8ff },
    { name: 'Indigo',  hex: 0x3050d8 },
    { name: 'Violet',  hex: 0x8a3fd0 },
    { name: 'Pink',    hex: 0xff6fb5 },
    { name: 'Brown',   hex: 0x8b5a2b },
    { name: 'Khaki',   hex: 0xc9b783 },
];

/** Clamp an arbitrary value to a valid palette index. */
export function sanitizeIndex(index) {
    const i = Number(index);
    if (!Number.isFinite(i)) return APPEARANCE_DEFAULT;
    return Math.min(COLOR_PALETTE.length - 1, Math.max(0, Math.floor(i)));
}

/**
 * Pack two palette indices into one byte: head in the low nibble, legs in the high.
 * @param {number} headIndex
 * @param {number} legIndex
 * @returns {number} byte in [0, 255]
 */
export function packAppearance(headIndex, legIndex) {
    return (sanitizeIndex(headIndex) & 0x0f) | ((sanitizeIndex(legIndex) & 0x0f) << 4);
}

/**
 * Unpack an appearance byte back into palette indices.
 * @param {number} byte
 * @returns {{head: number, legs: number}}
 */
export function unpackAppearance(byte) {
    const b = Number.isFinite(Number(byte)) ? Number(byte) & 0xff : 0;
    return { head: b & 0x0f, legs: (b >> 4) & 0x0f };
}

/** Round-trip an appearance byte through the clamps, dropping any junk bits. */
export function sanitizeAppearance(byte) {
    const { head, legs } = unpackAppearance(byte);
    return packAppearance(head, legs);
}

/**
 * The colour a palette index stands for, or null for the default slot.
 *
 * Default slots are deliberately left unresolved here: the team tint the legs
 * fall back to is a THREE.Color multiply, which happens in linear space and
 * cannot be reproduced with byte arithmetic. EntityRenderer owns that fallback
 * (see soldierHeadColor / soldierLegColor); this module stays THREE-free so the
 * server can share it.
 *
 * @param {number} index
 * @returns {number|null} hex colour, or null for "use the default"
 */
export function paletteColor(index) {
    return COLOR_PALETTE[sanitizeIndex(index)].hex;
}
