import { describe, it, expect } from 'vitest';
import { isNameplateVisible } from '../src/client/Nameplate.js';

const alive = (team) => ({ alive: true, team });
const dead = (team) => ({ alive: false, team });

const SPECTATING = null;
const NO_ENTITY = -1;

describe('Nameplate visibility', () => {
    it('shows every player while spectating', () => {
        expect(isNameplateVisible(alive('teamA'), 30, SPECTATING, NO_ENTITY)).toBe(true);
        expect(isNameplateVisible(alive('teamB'), 31, SPECTATING, NO_ENTITY)).toBe(true);
    });

    it('shows only teammates once the viewer has joined a team', () => {
        expect(isNameplateVisible(alive('teamB'), 31, 'teamB', 32)).toBe(true);
        expect(isNameplateVisible(alive('teamA'), 30, 'teamB', 32)).toBe(false);
    });

    it('never shows the viewer their own plate', () => {
        expect(isNameplateVisible(alive('teamB'), 32, 'teamB', 32)).toBe(false);
        // ...not even while spectating, where every other plate is visible
        expect(isNameplateVisible(alive('teamB'), 32, SPECTATING, 32)).toBe(false);
    });

    it('hides dead players regardless of team or viewer', () => {
        expect(isNameplateVisible(dead('teamA'), 30, SPECTATING, NO_ENTITY)).toBe(false);
        expect(isNameplateVisible(dead('teamB'), 31, 'teamB', 32)).toBe(false);
    });
});
