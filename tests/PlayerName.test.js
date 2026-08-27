import { describe, it, expect } from 'vitest';
import {
    sanitizePlayerName, isComStyleName, validatePlayerName,
    MAX_NAME_LENGTH, DEFAULT_NAME,
} from '../src/shared/PlayerName.js';

describe('sanitizePlayerName', () => {
    it('trims and keeps ordinary names intact', () => {
        expect(sanitizePlayerName('  BlueScout  ')).toBe('BlueScout');
        expect(sanitizePlayerName('Red Guard-2')).toBe('Red Guard-2');
    });

    it('strips characters outside word, space and hyphen', () => {
        expect(sanitizePlayerName('<script>hi')).toBe('scripthi');
        expect(sanitizePlayerName('nick@home!')).toBe('nickhome');
    });

    it('truncates to the maximum length', () => {
        const long = 'A'.repeat(40);
        expect(sanitizePlayerName(long)).toHaveLength(MAX_NAME_LENGTH);
    });

    it('falls back to the default when nothing survives', () => {
        expect(sanitizePlayerName('')).toBe(DEFAULT_NAME);
        expect(sanitizePlayerName('   ')).toBe(DEFAULT_NAME);
        expect(sanitizePlayerName('!!!')).toBe(DEFAULT_NAME);
    });

    it('does not leave trailing space after truncation', () => {
        // 16th char lands on a space; it must be trimmed off again
        expect(sanitizePlayerName('AAAAAAAAAAAAAAA BBBB')).toBe('AAAAAAAAAAAAAAA');
    });
});

describe('isComStyleName', () => {
    it('recognises COM callsigns', () => {
        expect(isComStyleName('A-3')).toBe(true);
        expect(isComStyleName('B-14')).toBe(true);
    });

    it('leaves ordinary names alone', () => {
        expect(isComStyleName('A-Team')).toBe(false);
        expect(isComStyleName('C-3')).toBe(false);
        expect(isComStyleName('BlueScout')).toBe(false);
    });
});

describe('validatePlayerName', () => {
    it('accepts a free name and returns its sanitized form', () => {
        expect(validatePlayerName('  BlueScout ', ['RedGuard']))
            .toEqual({ ok: true, name: 'BlueScout', error: null });
    });

    it('rejects a name already in the match', () => {
        const result = validatePlayerName('RedGuard', ['BlueScout', 'RedGuard']);
        expect(result.ok).toBe(false);
        expect(result.error).toBe('Name already taken');
    });

    it('compares against the sanitized form, not the raw input', () => {
        // Trailing spaces and stripped punctuation must not sneak a duplicate through
        expect(validatePlayerName('  RedGuard  ', ['RedGuard']).ok).toBe(false);
        expect(validatePlayerName('Red@Guard', ['RedGuard']).ok).toBe(false);
    });

    it('rejects COM-style names', () => {
        const result = validatePlayerName('A-3', []);
        expect(result.ok).toBe(false);
        expect(result.error).toBe('Name not allowed');
    });

    it('still reports the sanitized name when the check fails', () => {
        expect(validatePlayerName('  A-3  ', []).name).toBe('A-3');
    });

    it('accepts any name when no one is in the match yet', () => {
        expect(validatePlayerName('Solo').ok).toBe(true);
    });

    it('works with a Map iterator, which is how the client supplies names', () => {
        const roster = new Map([[30, 'BlueScout'], [31, 'RedGuard']]);
        expect(validatePlayerName('RedGuard', roster.values()).ok).toBe(false);
        expect(validatePlayerName('Newcomer', roster.values()).ok).toBe(true);
    });
});
