import { MsgType } from '../shared/protocol.js';

// Per-message-type rate limits: { capacity, refillPerSec }
const RATE_LIMITS = {
    [MsgType.INPUT]:   { capacity: 300, refillPerSec: 200 }, // support up to ~200fps clients
    [MsgType.PING]:    { capacity: 3,   refillPerSec: 1   },
    [MsgType.JOIN]:    { capacity: 2,   refillPerSec: 1   },
    [MsgType.RESPAWN]: { capacity: 2,   refillPerSec: 1   },
    [MsgType.LEAVE]:   { capacity: 2,   refillPerSec: 1   },
};

const VIOLATION_KICK_THRESHOLD = 100;
const VIOLATION_DECAY_PER_SEC = 5; // violations decay over time

/**
 * Per-client token bucket rate limiter.
 * Each message type has its own bucket with independent capacity and refill rate.
 */
export class RateLimiter {
    constructor() {
        this._buckets = {};
        const now = performance.now();
        for (const [msgType, cfg] of Object.entries(RATE_LIMITS)) {
            this._buckets[msgType] = { tokens: cfg.capacity, lastRefill: now };
        }
        this._violations = 0;
        this._lastViolationDecay = now;
    }

    /**
     * Try to consume one token for the given message type.
     * @param {number} msgType
     * @returns {'ok'|'drop'|'kick'} — 'ok' if allowed, 'drop' to silently discard, 'kick' to disconnect
     */
    consume(msgType) {
        const cfg = RATE_LIMITS[msgType];
        if (!cfg) return 'ok'; // no limit configured for this type

        const bucket = this._buckets[msgType];
        const now = performance.now();
        const elapsed = (now - bucket.lastRefill) / 1000;
        bucket.tokens = Math.min(cfg.capacity, bucket.tokens + elapsed * cfg.refillPerSec);
        bucket.lastRefill = now;

        if (bucket.tokens < 1) {
            // Decay violations over time so transient bursts don't accumulate to a kick
            const decayElapsed = (now - this._lastViolationDecay) / 1000;
            this._violations = Math.max(0, this._violations - decayElapsed * VIOLATION_DECAY_PER_SEC);
            this._lastViolationDecay = now;

            this._violations++;
            return this._violations >= VIOLATION_KICK_THRESHOLD ? 'kick' : 'drop';
        }

        bucket.tokens -= 1;
        return 'ok';
    }
}
