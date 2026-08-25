/**
 * TouchControls — virtual on-screen controls for touch devices.
 *
 * Design: this module is a *second input source* for InputManager. It writes
 * into the exact same fields the keyboard/mouse path writes (`input.keys`,
 * `input.mouseDown`, `input.rightMouseDown`, `input.mouseDeltaX/Y`), so nothing
 * downstream — FPSController, the input protocol, prediction, the server —
 * needs to know touch exists.
 *
 * Layout (landscape):
 *   left  — movement stick
 *   right — look area (drag anywhere to turn) with action buttons floating on top
 *
 * Dragging *from* an action button keeps turning the view, which is what makes
 * "fire while aiming" possible with two thumbs.
 */

// ── Stick geometry (CSS px) ──
const STICK_BASE     = 140;
const STICK_KNOB     = 60;
const STICK_DEADZONE = 8;
const STICK_MAX      = 55;   // travel radius of the knob
const STICK_GRAB_PAD = 1.4;  // forgiveness multiplier on the grab radius
const DIR_THRESHOLD  = 0.35; // analog → 8-way digital cutoff

// ── Timing ──
// A tap must stay "held" long enough for the rising-edge detectors that run on
// animation frames (FPSController prevGrenade/prevRightMouse, server
// _prevInteract) to observe it. 100ms ≈ 6 frames @60fps.
const PULSE_MS = 100;

// ── Overhead map gestures ──
const PINCH_MIN_POINTERS = 2;

// ── Look sensitivity ──
const TOUCH_SCALE     = 3.2;   // scales against ClientGame's mouseSensitivity 0.002
const BOOST_MIN_SPEED = 900;   // px/s — below this, no acceleration (precise aim)
const BOOST_RANGE     = 2400;  // px/s span over which boost ramps 1.0 → 2.0

import { WeaponDefs } from '../entities/WeaponDefs.js';

/**
 * True when the client should present touch controls instead of pointer lock.
 * `?touch=1` forces it on for desktop debugging.
 */
export function isTouchDevice() {
    try {
        if (new URLSearchParams(location.search).has('touch')) return true;
    } catch { /* no-op */ }
    return navigator.maxTouchPoints > 0
        && window.matchMedia('(pointer: coarse)').matches;
}

export class TouchControls {
    /**
     * @param {import('../core/InputManager.js').InputManager} input
     * @param {object} callbacks
     * @param {() => void} callbacks.onScoreboardDown
     * @param {() => void} callbacks.onScoreboardUp
     * @param {() => void} callbacks.onLeave
     * @param {() => void} callbacks.onSpectatorNext
     * @param {() => void} callbacks.onSpectatorView
     * @param {() => void} callbacks.onSpectatorJoin
     */
    constructor(input, callbacks = {}) {
        this.input = input;
        this.cb = callbacks;

        this.enabled = false;      // any control layer visible
        this.lookEnabled = false;  // right-half drag turns the view
        this.mapEnabled = false;   // overhead spectator map: drag to pan, pinch to zoom
        this._syncKey = null;      // last synced state signature
        this._pinchPrev = null;    // previous two-finger distance

        /** @type {Map<number, {role:string, look:boolean, btn:HTMLElement|null, x:number, y:number, t:number}>} */
        this._pointers = new Map();
        /** @type {Map<string, number>} pulse timers keyed by button id */
        this._pulseTimers = new Map();

        this._injectStyle();
        this._buildDOM();
        this._buildRotatePrompt();
        this._decorateVehiclePrompt();
        this._bindEvents();
    }

    // ═══════════════════════════════════════════════════════
    // Fullscreen + orientation
    //
    // Both are touch-only concerns: the layer itself only exists on touch
    // devices, so the desktop path never reaches any of this. Fullscreen must
    // be requested synchronously inside a user gesture, which is why the checks
    // hang off button presses rather than a timer.
    // ═══════════════════════════════════════════════════════

    _isPortrait() {
        return window.innerHeight > window.innerWidth;
    }

    /** Ask for fullscreen + landscape. Safe to call repeatedly. */
    _enterPresentation() {
        // This runs on every in-game button press, so bail out immediately in
        // the common case rather than re-entering the orientation API each time.
        if (document.fullscreenElement && !this._isPortrait()) {
            if (this.rotatePrompt.style.display !== 'none') this._updateRotatePrompt();
            return;
        }

        if (!document.fullscreenElement) {
            const el = document.documentElement;
            const req = el.requestFullscreen || el.webkitRequestFullscreen;
            // iOS Safari has no element fullscreen — the rotate prompt is the
            // only backstop there, so a rejection is expected, not an error.
            try {
                const p = req?.call(el, { navigationUI: 'hide' });
                if (p?.then) p.then(() => this._lockLandscape()).catch(() => {});
            } catch { /* no-op */ }
        }
        this._lockLandscape();
        this._updateRotatePrompt();
    }

    _lockLandscape() {
        try {
            const p = screen.orientation?.lock?.('landscape');
            if (p?.catch) p.catch(() => {});   // unsupported on iOS, and on desktop Firefox
        } catch { /* no-op */ }
    }

    _buildRotatePrompt() {
        const el = document.createElement('div');
        el.id = 'touch-rotate-prompt';
        el.innerHTML = `
            <div class="trp-icon">⟳</div>
            <div class="trp-title">請將裝置轉為橫向</div>
            <div class="trp-sub">Rotate your device to landscape</div>`;
        document.body.appendChild(el);
        this.rotatePrompt = el;
        this._updateRotatePrompt();
    }

    _updateRotatePrompt() {
        if (!this.rotatePrompt) return;
        this.rotatePrompt.style.display = this._isPortrait() ? 'flex' : 'none';
    }

    // ═══════════════════════════════════════════════════════
    // DOM
    // ═══════════════════════════════════════════════════════

    _injectStyle() {
        const style = document.createElement('style');
        style.id = 'touch-controls-style';
        style.textContent = `
/* ── Touch control layer ── */
#touch-controls {
    position: fixed; inset: 0; z-index: 120;
    pointer-events: none;
    font-family: Consolas, monospace;
    -webkit-user-select: none; user-select: none;
}
#touch-controls .tb {
    position: absolute;
    pointer-events: auto;
    display: flex; align-items: center; justify-content: center;
    color: rgba(255,255,255,0.85);
    background: rgba(0,0,0,0.28);
    border: 2px solid rgba(255,255,255,0.30);
    border-radius: 50%;
    font-size: 12px; font-weight: bold; letter-spacing: 0.5px;
    text-shadow: 0 1px 2px rgba(0,0,0,0.8);
    -webkit-tap-highlight-color: transparent;
    touch-action: none;
    transition: background 90ms linear, transform 90ms linear;
}
#touch-controls .tb.tb-active {
    background: rgba(255,255,255,0.34);
    transform: scale(0.94);
    transition: none;   /* press reads instantly; only the release fades */
}
#touch-controls .tb.tb-hidden { display: none; }

/* Movement stick */
#tc-stick {
    position: absolute;
    left: calc(28px + env(safe-area-inset-left));
    bottom: calc(28px + env(safe-area-inset-bottom));
    width: ${STICK_BASE}px; height: ${STICK_BASE}px;
    border-radius: 50%;
    background: rgba(0,0,0,0.22);
    border: 2px solid rgba(255,255,255,0.22);
    pointer-events: auto;
    touch-action: none;
}
#tc-stick-knob {
    position: absolute; left: 50%; top: 50%;
    width: ${STICK_KNOB}px; height: ${STICK_KNOB}px;
    margin-left: ${-STICK_KNOB / 2}px; margin-top: ${-STICK_KNOB / 2}px;
    border-radius: 50%;
    background: rgba(255,255,255,0.32);
    border: 2px solid rgba(255,255,255,0.45);
    pointer-events: none;
}

/* Right-hand cluster — anchored to the bottom-right safe area.
   Kept low and wide rather than tall: landscape phones are only ~390px high,
   so a vertical stack would run into the kill feed. */
#touch-controls .tb-fire {
    width: 88px; height: 88px; font-size: 14px;
    right: calc(24px + env(safe-area-inset-right));
    bottom: calc(110px + env(safe-area-inset-bottom));
}
#touch-controls .tb-slot-a {   /* ADS / ASC — up-left of fire */
    width: 56px; height: 56px;
    right: calc(126px + env(safe-area-inset-right));
    bottom: calc(150px + env(safe-area-inset-bottom));
}
#touch-controls .tb-slot-b {   /* JUMP / DESC — directly under fire */
    width: 56px; height: 56px;
    right: calc(44px + env(safe-area-inset-right));
    bottom: calc(44px + env(safe-area-inset-bottom));
}
#touch-controls .tb-slot-c {   /* RELOAD */
    width: 56px; height: 56px;
    right: calc(126px + env(safe-area-inset-right));
    bottom: calc(44px + env(safe-area-inset-bottom));
}
#touch-controls .tb-slot-d {   /* NADE / EXIT */
    width: 56px; height: 56px;
    right: calc(194px + env(safe-area-inset-right));
    bottom: calc(44px + env(safe-area-inset-bottom));
}

/* Top-right utility buttons */
#touch-controls .tb-top {
    width: 44px; height: 44px;
    border-radius: 8px;
    font-size: 11px;
    top: calc(8px + env(safe-area-inset-top));
}
#touch-controls .tb-tab   { right: calc(72px + env(safe-area-inset-right)); }
#touch-controls .tb-leave { right: calc(20px + env(safe-area-inset-right)); font-size: 18px; }

/* Spectator buttons */
#touch-controls .tb-spec {
    width: auto; height: 46px; padding: 0 20px;
    border-radius: 23px;
    bottom: calc(36px + env(safe-area-inset-bottom));
}
#touch-controls .tb-spec-next { left: calc(28px + env(safe-area-inset-left)); }
#touch-controls .tb-spec-view { left: calc(140px + env(safe-area-inset-left)); }
#touch-controls .tb-spec-join { right: calc(28px + env(safe-area-inset-right)); }

/* ── Rotate-to-landscape prompt ──
   Above the join panel (200) but below the game-over screen (1000). */
#touch-rotate-prompt {
    position: fixed; inset: 0; z-index: 500;
    display: none;
    flex-direction: column; align-items: center; justify-content: center;
    gap: 14px;
    background: rgba(0,0,0,0.72);
    backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px);
    color: rgba(255,255,255,0.9);
    font-family: Arial, sans-serif; text-align: center;
    pointer-events: auto;
    padding: env(safe-area-inset-top) env(safe-area-inset-right)
             env(safe-area-inset-bottom) env(safe-area-inset-left);
}
#touch-rotate-prompt .trp-icon {
    font-size: 56px; line-height: 1;
    animation: trp-spin 2.4s ease-in-out infinite;
}
#touch-rotate-prompt .trp-title { font-size: 19px; font-weight: bold; }
#touch-rotate-prompt .trp-sub { font-size: 13px; color: rgba(255,255,255,0.5); }
@keyframes trp-spin {
    0%, 45% { transform: rotate(0deg); }
    55%, 100% { transform: rotate(90deg); }
}

/* ── Repositioned game HUD (touch only) ── */
/* Both readouts become centred horizontal strips at the bottom of the screen:
   weapon / ammo / grenades on top, health bar underneath. The blocks are built
   as stacked <div>s with inline margins, so flex + a margin reset turns them
   into a row without touching ClientHUD. */
.touch-mode #health-hud,
.touch-mode #ammo-hud {
    left: 50% !important;
    right: auto !important;
    min-width: 0 !important;
    padding: 5px 14px !important;
    white-space: nowrap;
    display: flex !important; align-items: center; gap: 12px;
    transform: translateX(-50%) scale(0.85);
    transform-origin: bottom center;
}
/* !important above is needed to beat ClientHUD's inline display:block, so the
   inline display:none it uses to hide the HUD has to be re-asserted here. */
.touch-mode #health-hud[style*="display: none"],
.touch-mode #ammo-hud[style*="display: none"] { display: none !important; }
.touch-mode #health-hud > *,
.touch-mode #ammo-hud > * { margin: 0 !important; }
.touch-mode #ammo-hud {
    bottom: calc(56px + env(safe-area-inset-bottom)) !important;
}
.touch-mode #health-hud {
    bottom: calc(14px + env(safe-area-inset-bottom)) !important;
}

/* Spectating: SpectatorHUD already shows the target's HP bar, so the player
   health strip would just repeat it. Drop it and drop the target readout to
   the very bottom, with ammo stacked above. */
.touch-mode.spectating #health-hud { display: none !important; }
.touch-mode.spectating #ammo-hud {
    bottom: calc(84px + env(safe-area-inset-bottom)) !important;
}
.touch-mode.spectating #spectator-target {
    bottom: calc(30px + env(safe-area-inset-bottom)) !important;
}
.touch-mode #minimap {
    top: calc(12px + env(safe-area-inset-top)) !important;
    left: calc(12px + env(safe-area-inset-left)) !important;
    width: 120px !important; height: 120px !important;
}
.touch-mode #minimap canvas { width: 100%; height: 100%; }
/* The right column belongs to ammo + buttons on touch, so the kill feed moves
   under the score readout and is capped to a few rows. */
.touch-mode #kill-feed {
    top: calc(62px + env(safe-area-inset-top)) !important;
    right: auto !important;
    left: 50% !important;
    transform: translateX(-50%);
    text-align: center !important;
    font-size: 11px !important;
    max-height: 78px; overflow: hidden;
}
.touch-mode #ping-display {
    top: calc(14px + env(safe-area-inset-top)) !important;
    right: calc(130px + env(safe-area-inset-right)) !important;
}
/* Both of these sat at 150px, which on a ~390px-tall landscape screen lands
   right on the centre crosshair. Keep them clear of it. */
.touch-mode #vehicle-hud {
    bottom: calc(100px + env(safe-area-inset-bottom)) !important;
    padding: 6px 16px !important;
}
/* Keyboard legend — meaningless on touch, and it makes the panel tall. */
.touch-mode #vhud-controls { display: none !important; }
.touch-mode #vehicle-prompt {
    bottom: calc(118px + env(safe-area-inset-bottom)) !important;
    z-index: 120 !important;
    pointer-events: auto !important;
    padding: 12px 26px !important;
    font-weight: bold;
    border: 2px solid rgba(255,255,255,0.30);
    -webkit-tap-highlight-color: transparent;
    touch-action: none;
}
.touch-mode #vehicle-prompt.tb-active { background: rgba(255,255,255,0.34) !important; }
/* Keyboard hints are meaningless on touch */
.touch-mode #spectator-hints { display: none !important; }
`;
        document.head.appendChild(style);
    }

    _buildDOM() {
        const root = document.createElement('div');
        root.id = 'touch-controls';
        document.body.appendChild(root);
        this.root = root;

        // ── Movement stick ──
        const base = document.createElement('div');
        base.id = 'tc-stick';
        const knob = document.createElement('div');
        knob.id = 'tc-stick-knob';
        base.appendChild(knob);
        root.appendChild(base);
        this.stickBase = base;
        this.stickKnob = knob;

        // ── Action buttons ──
        // Infantry set
        this.infantryButtons = [
            this._makeButton({ id: 'fire',   label: 'FIRE',   cls: 'tb-fire',   mode: 'hold',  act: 'fire' }),
            this._makeButton({ id: 'ads',    label: 'ADS',    cls: 'tb-slot-a', mode: 'pulse', act: 'scope' }),
            this._makeButton({ id: 'jump',   label: 'JUMP',   cls: 'tb-slot-b', mode: 'pulse', key: 'Space' }),
            this._makeButton({ id: 'reload', label: 'RELOAD', cls: 'tb-slot-c', mode: 'pulse', key: 'KeyR' }),
            this._makeButton({ id: 'nade',   label: 'NADE',   cls: 'tb-slot-d', mode: 'pulse', key: 'KeyG' }),
        ];

        // Vehicle set — SPRINT is helicopter descend, JUMP is ascend (ServerPlayer.js)
        this.vehicleButtons = [
            this._makeButton({ id: 'vfire',   label: 'FIRE',   cls: 'tb-fire',   mode: 'hold',  act: 'fire' }),
            this._makeButton({ id: 'asc',     label: 'ASC',    cls: 'tb-slot-a', mode: 'hold',  key: 'Space' }),
            this._makeButton({ id: 'desc',    label: 'DESC',   cls: 'tb-slot-b', mode: 'hold',  key: 'ShiftLeft' }),
            this._makeButton({ id: 'vreload', label: 'RELOAD', cls: 'tb-slot-c', mode: 'pulse', key: 'KeyR' }),
            this._makeButton({ id: 'exit',    label: 'EXIT',   cls: 'tb-slot-d', mode: 'pulse', key: 'KeyE' }),
        ];

        // Top-right utilities
        this.topButtons = [
            this._makeButton({
                id: 'tab', label: 'TAB', cls: 'tb-top tb-tab', mode: 'hold', noLook: true,
                onDown: () => this.cb.onScoreboardDown?.(),
                onUp:   () => this.cb.onScoreboardUp?.(),
            }),
            this._makeButton({
                // '✕' rather than 'EXIT' — the vehicle button already uses EXIT
                id: 'leave', label: '✕', cls: 'tb-top tb-leave', mode: 'pulse', noLook: true,
                onDown: () => this.cb.onLeave?.(),
            }),
        ];

        // Spectator controls
        this.spectatorButtons = [
            this._makeButton({
                id: 'spec-next', label: 'NEXT', cls: 'tb-spec tb-spec-next', mode: 'pulse', noLook: true,
                onDown: () => this.cb.onSpectatorNext?.(),
            }),
            this._makeButton({
                id: 'spec-view', label: 'VIEW', cls: 'tb-spec tb-spec-view', mode: 'pulse', noLook: true,
                onDown: () => this.cb.onSpectatorView?.(),
            }),
            this._makeButton({
                id: 'spec-join', label: 'JOIN GAME', cls: 'tb-spec tb-spec-join', mode: 'pulse', noLook: true,
                onDown: () => this.cb.onSpectatorJoin?.(),
            }),
        ];

        this.adsButton = this.root.querySelector('[data-tb="ads"]');

        this._allButtons = [
            ...this.infantryButtons, ...this.vehicleButtons,
            ...this.topButtons, ...this.spectatorButtons,
        ];
        this._setVisible(this._allButtons, false);
        this.stickBase.style.display = 'none';
    }

    _makeButton(def) {
        const el = document.createElement('div');
        el.className = `tb ${def.cls}`;
        el.dataset.tb = def.id;
        el.textContent = def.label;
        el._tbDef = def;
        this.root.appendChild(el);
        return el;
    }

    /**
     * The "Press E to board" prompt already knows when it should be visible,
     * so reuse it as the board button rather than duplicating the proximity check.
     */
    _decorateVehiclePrompt() {
        const el = document.getElementById('vehicle-prompt');
        if (!el) return;
        el.dataset.tb = 'use';
        el.textContent = 'BOARD';
        el._tbDef = { id: 'use', mode: 'pulse', key: 'KeyE' };
        this.vehiclePrompt = el;
    }

    // ═══════════════════════════════════════════════════════
    // Event wiring
    // ═══════════════════════════════════════════════════════

    _bindEvents() {
        this._onPointerDown = this._onPointerDown.bind(this);
        this._onPointerMove = this._onPointerMove.bind(this);
        this._onPointerUp = this._onPointerUp.bind(this);
        this._releaseAll = this._releaseAll.bind(this);

        window.addEventListener('pointerdown', this._onPointerDown, { passive: false });
        window.addEventListener('pointermove', this._onPointerMove, { passive: false });
        window.addEventListener('pointerup', this._onPointerUp);
        window.addEventListener('pointercancel', this._onPointerUp);
        // Incoming call, notification shade, app switch — never leave a key stuck down.
        window.addEventListener('blur', this._releaseAll);
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) this._releaseAll();
        });

        // Keep the rotate prompt live rather than only refreshing it on a press.
        this._onOrientation = () => this._updateRotatePrompt();
        window.addEventListener('resize', this._onOrientation);
        window.addEventListener('orientationchange', this._onOrientation);
        document.addEventListener('fullscreenchange', this._onOrientation);
    }

    _onPointerDown(e) {
        if (!this.enabled) return;

        // Look and map drags are only claimed when the finger lands on the 3D
        // canvas. Claiming "anything that isn't a button" swallowed presses on
        // overlay UI — the join panel's name field could never take focus,
        // because on mobile focus rides on the events preventDefault() cancels.
        const onCanvas = (e.target instanceof Element) && e.target.tagName === 'CANVAS';

        // ── Button (may also start a look drag) ──
        const btn = (e.target instanceof Element) ? e.target.closest('[data-tb]') : null;
        if (btn && btn._tbDef) {
            const def = btn._tbDef;
            const look = this.lookEnabled && !def.noLook && e.clientX > window.innerWidth * 0.5;
            this._pointers.set(e.pointerId, {
                role: 'button', look, btn,
                x: e.clientX, y: e.clientY, t: performance.now(),
            });
            this._press(btn);
            e.preventDefault();
            return;
        }

        // ── Movement stick ──
        if (this.stickBase.style.display !== 'none' && this._insideStick(e.clientX, e.clientY)) {
            this._pointers.set(e.pointerId, {
                role: 'stick', look: false, btn: null,
                x: e.clientX, y: e.clientY, t: performance.now(),
            });
            this._updateStick(e.clientX, e.clientY);
            e.preventDefault();
            return;
        }

        // ── Bare look drag (right half only) ──
        if (onCanvas && this.lookEnabled && e.clientX > window.innerWidth * 0.5) {
            this._pointers.set(e.pointerId, {
                role: 'look', look: true, btn: null,
                x: e.clientX, y: e.clientY, t: performance.now(),
            });
            e.preventDefault();
            return;
        }

        // ── Overhead map: anywhere on the canvas ──
        if (onCanvas && this.mapEnabled) {
            this._pointers.set(e.pointerId, {
                role: 'map', look: false, btn: null,
                x: e.clientX, y: e.clientY, t: performance.now(),
            });
            this._pinchPrev = null;  // a new finger restarts the pinch baseline
            e.preventDefault();
        }
    }

    _onPointerMove(e) {
        const p = this._pointers.get(e.pointerId);
        if (!p) return;

        if (p.role === 'stick') {
            this._updateStick(e.clientX, e.clientY);
            e.preventDefault();
            return;
        }

        if (p.role === 'map') {
            const dx = e.clientX - p.x;
            const dy = e.clientY - p.y;
            p.x = e.clientX;
            p.y = e.clientY;

            const maps = [];
            for (const [, q] of this._pointers) {
                if (q.role === 'map') maps.push(q);
            }

            if (maps.length >= PINCH_MIN_POINTERS) {
                // Two fingers: pinch to zoom, panning is suppressed to keep it steady.
                const [a, b] = maps;
                const dist = Math.hypot(a.x - b.x, a.y - b.y);
                if (this._pinchPrev !== null) this.input.pinchDelta += dist - this._pinchPrev;
                this._pinchPrev = dist;
            } else {
                this._pinchPrev = null;
                this.input.panDeltaX += dx;
                this.input.panDeltaY += dy;
            }
            e.preventDefault();
            return;
        }

        if (!p.look) return;

        const now = performance.now();
        const dt = Math.max(1, now - p.t) / 1000;
        const dx = e.clientX - p.x;
        const dy = e.clientY - p.y;

        // Speed-dependent boost: slow drags stay 1:1 for precise aim, fast flicks
        // scale up to 2× so a 180° turnaround fits in a single swipe.
        const speed = Math.hypot(dx, dy) / dt;
        const boost = 1 + Math.min(1, Math.max(0, (speed - BOOST_MIN_SPEED) / BOOST_RANGE));

        this.input.mouseDeltaX += dx * boost * TOUCH_SCALE;
        this.input.mouseDeltaY += dy * boost * TOUCH_SCALE;

        p.x = e.clientX;
        p.y = e.clientY;
        p.t = now;
        e.preventDefault();
    }

    _onPointerUp(e) {
        const p = this._pointers.get(e.pointerId);
        if (!p) return;
        this._pointers.delete(e.pointerId);

        if (p.role === 'stick') this._resetStick();
        if (p.role === 'map') this._pinchPrev = null;
        if (p.btn) this._release(p.btn);
    }

    // ═══════════════════════════════════════════════════════
    // Stick
    // ═══════════════════════════════════════════════════════

    _stickCenter() {
        const r = this.stickBase.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }

    _insideStick(x, y) {
        const c = this._stickCenter();
        const dx = x - c.x;
        const dy = y - c.y;
        const r = (STICK_BASE / 2) * STICK_GRAB_PAD;
        return dx * dx + dy * dy <= r * r;
    }

    _updateStick(x, y) {
        const c = this._stickCenter();
        let dx = x - c.x;
        let dy = y - c.y;
        const len = Math.hypot(dx, dy);

        if (len > STICK_MAX) {
            dx = (dx / len) * STICK_MAX;
            dy = (dy / len) * STICK_MAX;
        }
        this.stickKnob.style.transform = `translate(${dx}px, ${dy}px)`;

        if (len < STICK_DEADZONE) {
            this._applyDirection(0, 0);
            return;
        }
        this._applyDirection(dx / STICK_MAX, dy / STICK_MAX);
    }

    /**
     * The input protocol carries boolean direction bits, not an analog vector
     * (ServerPlayer reads KeyBit.FORWARD/BACKWARD/LEFT/RIGHT), so the stick
     * necessarily quantises to 8 directions.
     */
    _applyDirection(nx, ny) {
        const k = this.input.keys;
        k['KeyD'] = nx > DIR_THRESHOLD;
        k['KeyA'] = nx < -DIR_THRESHOLD;
        k['KeyW'] = ny < -DIR_THRESHOLD;
        k['KeyS'] = ny > DIR_THRESHOLD;
    }

    _resetStick() {
        this.stickKnob.style.transform = 'translate(0px, 0px)';
        this._applyDirection(0, 0);
    }

    // ═══════════════════════════════════════════════════════
    // Buttons
    // ═══════════════════════════════════════════════════════

    _press(btn) {
        const def = btn._tbDef;
        btn.classList.add('tb-active');

        // Register the input FIRST. Everything below is bookkeeping, and none of
        // it may sit between the finger landing and the key bit being set.
        if (def.mode === 'hold') {
            this._setInput(def, true);
        } else if (def.key || def.act) {
            this._pulse(def);
        }
        if (def.onDown) def.onDown();

        // JOIN is the entry point into the game, so that press is what claims
        // fullscreen + landscape. Every in-game press re-checks, because the
        // user can drop out of fullscreen at any time (back gesture, notification
        // shade) and only a gesture can get it back. Still inside the same
        // synchronous handler, so it still counts as a user gesture.
        if (def.id === 'spec-join' || this.lookEnabled) this._enterPresentation();
    }

    _release(btn) {
        const def = btn._tbDef;
        btn.classList.remove('tb-active');

        if (def.onUp) def.onUp();
        if (def.mode === 'hold') this._setInput(def, false);
        // Pulse buttons clear on their own timer, so a quick tap still registers.
    }

    _pulse(def) {
        const prev = this._pulseTimers.get(def.id);
        if (prev) clearTimeout(prev);
        this._setInput(def, true);
        this._pulseTimers.set(def.id, setTimeout(() => {
            this._setInput(def, false);
            this._pulseTimers.delete(def.id);
        }, PULSE_MS));
    }

    _setInput(def, value) {
        if (def.act === 'fire') {
            this.input.mouseDown = value;
        } else if (def.act === 'scope') {
            this.input.rightMouseDown = value;
        } else if (def.key) {
            this.input.keys[def.key] = value;
        }
    }

    /** Drop every held input and visual press state. */
    _releaseAll() {
        for (const [, p] of this._pointers) {
            if (p.btn) p.btn.classList.remove('tb-active');
        }
        this._pointers.clear();
        for (const [, t] of this._pulseTimers) clearTimeout(t);
        this._pulseTimers.clear();

        this._resetStick();
        this.input.mouseDown = false;
        this.input.rightMouseDown = false;
        for (const code of ['Space', 'KeyR', 'KeyG', 'KeyE', 'ShiftLeft']) {
            this.input.keys[code] = false;
        }
    }

    // ═══════════════════════════════════════════════════════
    // Mode switching
    // ═══════════════════════════════════════════════════════

    _setVisible(list, visible) {
        for (const el of list) el.classList.toggle('tb-hidden', !visible);
    }

    /**
     * Reconcile the control layer with the current game state. Cheap and
     * idempotent — call it every frame from the animation loop.
     * @param {object} state
     * @param {string} state.gameMode   'connecting' | 'spectator' | 'playing' | 'dead'
     * @param {boolean} state.inVehicle
     * @param {string} state.weaponId
     * @param {boolean} state.overhead  spectator is in overhead map view
     */
    sync({ gameMode, inVehicle, weaponId, overhead }) {
        const key = `${gameMode}|${inVehicle}|${weaponId}|${overhead}`;
        if (key === this._syncKey) return;
        this._syncKey = key;

        this._releaseAll();

        const playing = gameMode === 'playing';
        const spectating = gameMode === 'spectator';

        this.enabled = playing || spectating;
        this.lookEnabled = playing;
        this.mapEnabled = spectating && !!overhead;
        document.body.classList.toggle('spectating', spectating);

        this.stickBase.style.display = playing ? 'block' : 'none';
        this._setVisible(this.infantryButtons, playing && !inVehicle);
        this._setVisible(this.vehicleButtons, playing && inVehicle);
        this._setVisible(this.topButtons, playing);
        this._setVisible(this.spectatorButtons, spectating);

        // ADS only exists for weapons that actually have a scope — an always-on
        // button that does nothing is worse on touch than on desktop, where a
        // dead right-click costs nothing.
        const hasScope = !!WeaponDefs[weaponId]?.scopeFOV;
        this.adsButton.classList.toggle('tb-hidden', !(playing && !inVehicle && hasScope));
    }

    dispose() {
        this._releaseAll();
        window.removeEventListener('pointerdown', this._onPointerDown);
        window.removeEventListener('pointermove', this._onPointerMove);
        window.removeEventListener('pointerup', this._onPointerUp);
        window.removeEventListener('pointercancel', this._onPointerUp);
        window.removeEventListener('blur', this._releaseAll);
        window.removeEventListener('resize', this._onOrientation);
        window.removeEventListener('orientationchange', this._onOrientation);
        document.removeEventListener('fullscreenchange', this._onOrientation);
        this.root.remove();
        this.rotatePrompt?.remove();
        document.getElementById('touch-controls-style')?.remove();
    }
}
