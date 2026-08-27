/**
 * Player name rules, shared by the join screen and the server.
 *
 * The server is still the authority — two clients can pick the same name in the
 * same instant, and only the server sees that. The client uses these rules to
 * catch the common cases the moment the name is submitted, so a player is not
 * sent through colour and weapon selection only to be bounced back.
 */

export const MAX_NAME_LENGTH = 16;
export const DEFAULT_NAME = 'Player';

/** COM soldiers are named A-3, B-14 — players may not impersonate them. */
const COM_NAME_PATTERN = /^[AB]-\d+$/;

/** Everything outside word characters, whitespace and hyphens is stripped. */
const DISALLOWED_CHARS = /[^\w\s\-]/g;

/**
 * Reduce raw input to the name that will actually be used.
 * @param {string} raw
 * @returns {string} never empty — falls back to DEFAULT_NAME
 */
export function sanitizePlayerName(raw) {
    const cleaned = String(raw)
        .trim()
        .replace(DISALLOWED_CHARS, '')
        .substring(0, MAX_NAME_LENGTH)
        .trim();
    return cleaned.length === 0 ? DEFAULT_NAME : cleaned;
}

/** Whether a sanitized name looks like a COM callsign. */
export function isComStyleName(name) {
    return COM_NAME_PATTERN.test(name);
}

/**
 * Sanitize and check a name against the names already in the match.
 * @param {string} raw
 * @param {Iterable<string>} takenNames - names of players currently in the game
 * @returns {{ok: boolean, name: string, error: string|null}} `name` is the
 *   sanitized form, usable whether or not the check passed.
 */
export function validatePlayerName(raw, takenNames = []) {
    const name = sanitizePlayerName(raw);

    if (isComStyleName(name)) {
        return { ok: false, name, error: 'Name not allowed' };
    }
    for (const taken of takenNames) {
        if (taken === name) {
            return { ok: false, name, error: 'Name already taken' };
        }
    }
    return { ok: true, name, error: null };
}
