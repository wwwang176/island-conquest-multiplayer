import { describe, it, expect } from 'vitest';
import {
    COLOR_PALETTE, DEFAULT_APPEARANCE,
    packAppearance, unpackAppearance, sanitizeAppearance, sanitizeIndex, paletteColor,
} from '../src/shared/Appearance.js';
import {
    encodeJoin, decodeJoin, encodePlayerAppearance, decodePlayerAppearance, MsgType,
} from '../src/shared/protocol.js';

describe('Appearance packing', () => {
    it('round-trips every palette combination through a single byte', () => {
        for (let head = 0; head < COLOR_PALETTE.length; head++) {
            for (let legs = 0; legs < COLOR_PALETTE.length; legs++) {
                const packed = packAppearance(head, legs);
                expect(packed).toBeGreaterThanOrEqual(0);
                expect(packed).toBeLessThanOrEqual(255);
                expect(unpackAppearance(packed)).toEqual({ head, legs });
            }
        }
    });

    it('clamps out-of-range and junk indices to a valid slot', () => {
        expect(sanitizeIndex(-5)).toBe(0);
        expect(sanitizeIndex(99)).toBe(COLOR_PALETTE.length - 1);
        expect(sanitizeIndex(NaN)).toBe(0);
        expect(sanitizeIndex(undefined)).toBe(0);
        expect(sanitizeIndex(3.7)).toBe(3);
    });

    it('drops junk bits when sanitizing an appearance byte', () => {
        expect(sanitizeAppearance(0xff)).toBe(0xff);   // both nibbles already valid
        expect(sanitizeAppearance(0x1ff)).toBe(0xff);  // high bits ignored
        expect(sanitizeAppearance(undefined)).toBe(DEFAULT_APPEARANCE);
    });
});

describe('Palette lookup', () => {
    it('reports the default slot as unresolved so the renderer can fall back', () => {
        expect(paletteColor(0)).toBeNull();
    });

    it('returns the palette colour for every non-default slot', () => {
        for (let i = 1; i < COLOR_PALETTE.length; i++) {
            expect(paletteColor(i)).toBe(COLOR_PALETTE[i].hex);
        }
    });

    it('clamps an out-of-range index rather than returning undefined', () => {
        expect(paletteColor(99)).toBe(COLOR_PALETTE[COLOR_PALETTE.length - 1].hex);
        expect(paletteColor(-1)).toBeNull();
    });
});

describe('Join protocol with appearance', () => {
    it('carries the appearance byte through encode/decode', () => {
        const appearance = packAppearance(5, 12);
        const decoded = decodeJoin(encodeJoin(1, 'BOLT', 'Rifleman', appearance));
        expect(decoded).toEqual({
            team: 'teamB',
            weaponId: 'BOLT',
            playerName: 'Rifleman',
            appearance,
        });
    });

    it('defaults the appearance when a join arrives without the trailing byte', () => {
        // Simulate a pre-appearance client: same layout, one byte short.
        const full = encodeJoin(0, 'AR15', 'Old', packAppearance(7, 7));
        const legacy = full.slice(0, full.byteLength - 1);
        expect(decodeJoin(legacy).appearance).toBe(DEFAULT_APPEARANCE);
        expect(decodeJoin(legacy).playerName).toBe('Old');
    });
});

describe('PlayerAppearance message', () => {
    it('round-trips a batch of entries', () => {
        const entries = [
            { entityId: 3, appearance: packAppearance(1, 2) },
            { entityId: 4097, appearance: packAppearance(15, 0) },
        ];
        const buf = encodePlayerAppearance(entries);
        expect(new DataView(buf).getUint8(0)).toBe(MsgType.PLAYER_APPEARANCE);
        expect(decodePlayerAppearance(buf).entries).toEqual(entries);
    });

    it('encodes an empty batch without error', () => {
        expect(decodePlayerAppearance(encodePlayerAppearance([])).entries).toEqual([]);
    });
});
