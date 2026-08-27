import { weaponCardHTML, highlightWeaponCard } from './WeaponCardUI.js';
import { TEAM_COLORS, soldierHeadColor, soldierLegColor } from './EntityRenderer.js';
import { SoldierPreview } from './SoldierPreview.js';
import {
    COLOR_PALETTE, DEFAULT_APPEARANCE, packAppearance, unpackAppearance, sanitizeAppearance,
} from '../shared/Appearance.js';
import { validatePlayerName } from '../shared/PlayerName.js';

/**
 * Build the swatch grid for one appearance slot.
 * Slot 0 renders in its resolved default colour and is labelled as the default.
 * Colours come from the same resolvers the renderer uses, so a swatch matches
 * the soldier exactly.
 * @param {'head'|'legs'} slot
 * @param {number} teamColor
 */
function swatchGridHTML(slot, teamColor) {
    const swatches = COLOR_PALETTE.map((entry, index) => {
        // Probe each slot independently by packing the index into just that nibble.
        const color = slot === 'head'
            ? soldierHeadColor(packAppearance(index, 0))
            : soldierLegColor(packAppearance(0, index), teamColor);
        const isDefault = entry.hex === null;
        return `<button class="color-swatch" data-slot="${slot}" data-index="${index}"
            title="${isDefault ? 'Default' : entry.name}"
            style="width:32px;height:32px;padding:0;border-radius:5px;cursor:pointer;
            background:#${color.getHexString()};border:2px solid transparent;outline:none;
            box-shadow:0 0 0 1px rgba(0,0,0,0.5);${isDefault ? 'position:relative' : ''}">
            ${isDefault ? '<span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:bold;color:rgba(0,0,0,0.55);pointer-events:none">DEF</span>' : ''}
        </button>`;
    }).join('');

    return `<div id="swatches-${slot}" style="display:grid;grid-template-columns:repeat(8,32px);gap:6px">${swatches}</div>`;
}

const APPEARANCE_STORAGE_KEY = 'islandConquest.appearance';

/** Read the last-used appearance so players don't re-pick every round. */
function loadStoredAppearance() {
    try {
        const raw = window.localStorage?.getItem(APPEARANCE_STORAGE_KEY);
        if (raw === null || raw === undefined) return DEFAULT_APPEARANCE;
        return sanitizeAppearance(parseInt(raw, 10));
    } catch {
        return DEFAULT_APPEARANCE;
    }
}

function storeAppearance(appearance) {
    try {
        window.localStorage?.setItem(APPEARANCE_STORAGE_KEY, String(appearance));
    } catch {
        // Private browsing or blocked storage — the choice just won't persist.
    }
}

/**
 * JoinScreen — handles the connection form and the join-game panel
 * (team select → weapon select → colour select) that were previously
 * inline in ClientGame.
 */
export class JoinScreen {
    constructor() {
        this._joinStep = 1;
        this._joinTeam = null;
        this._joinName = 'Player';
        this._joinKeyHandler = null;
        this._blocker = null;
        this._preview = null;

        /**
         * Names already in the match, for the up-front duplicate check.
         * Set by ClientGame; the server still has the final say.
         * @type {() => Iterable<string>}
         */
        this.getTakenNames = () => [];
    }

    // ── public getters ──

    /** Current join step: 1 = name + team, 2 = weapon, 3 = colours */
    get joinStep() {
        return this._joinStep;
    }

    // ═══════════════════════════════════════════════════════
    // Connection UI
    // ═══════════════════════════════════════════════════════

    /**
     * Build the initial connection form inside the #blocker element.
     * @param {(url: string) => void} onConnect — called with the WebSocket URL
     */
    createConnectionUI(onConnect) {
        const blocker = document.getElementById('blocker');
        if (!blocker) return;
        this._blocker = blocker;

        blocker.innerHTML = `
            <h1>Island Conquest</h1>
            <p style="margin-bottom:12px">LAN Multiplayer</p>
            <div style="display:flex;gap:8px;align-items:center">
                <input id="server-url" type="text" value="ws://${location.hostname || 'localhost'}:${location.port || '8088'}"
                    style="padding:8px 12px;font-size:16px;border:none;border-radius:4px;width:280px;
                    background:rgba(255,255,255,0.9);color:#333;outline:none"
                    placeholder="ws://192.168.1.x:8088" />
                <button id="connect-btn"
                    style="padding:8px 20px;font-size:16px;border:none;border-radius:4px;
                    background:#4488ff;color:#fff;cursor:pointer;font-weight:bold">
                    Connect
                </button>
            </div>
            <p id="conn-status" style="margin-top:8px;font-size:14px;color:#aaa"></p>
        `;

        const input = document.getElementById('server-url');
        const btn = document.getElementById('connect-btn');

        const doConnect = () => {
            const url = input.value.trim();
            if (!url) return;
            document.getElementById('conn-status').textContent = 'Connecting...';
            btn.disabled = true;
            onConnect(url);
        };

        btn.addEventListener('click', doConnect);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') doConnect();
        });
    }

    // ── Connection status helpers ──

    /** Show "Connecting..." in the status line. */
    showConnecting() {
        const el = document.getElementById('conn-status');
        if (el) el.textContent = 'Connecting...';
        const btn = document.getElementById('connect-btn');
        if (btn) btn.disabled = true;
    }

    /** Show "Connected!" in the status line. */
    showConnected() {
        const el = document.getElementById('conn-status');
        if (el) el.textContent = 'Connected! Waiting for world data...';
    }

    /** Show disconnected state and re-enable the Connect button. */
    showDisconnected() {
        if (this._blocker) {
            this._blocker.classList.remove('hidden');
            const el = document.getElementById('conn-status');
            if (el) el.textContent = 'Disconnected. Reconnect?';
            const btn = document.getElementById('connect-btn');
            if (btn) btn.disabled = false;
        }
    }

    // ═══════════════════════════════════════════════════════
    // Join Panel (team + weapon select)
    // ═══════════════════════════════════════════════════════

    /**
     * Create and show the join panel overlay.
     * @param {(team: string, weaponId: string, playerName: string, appearance: number) => void} onJoin
     * @param {() => void} onCancel
     * @param {string} [errorMsg='']
     */
    createJoinUI(onJoin, onCancel, errorMsg = '') {
        // Remove existing join panel if any
        const existing = document.getElementById('join-panel');
        if (existing) existing.remove();
        if (this._joinKeyHandler) {
            document.removeEventListener('keydown', this._joinKeyHandler);
            this._joinKeyHandler = null;
        }
        this._preview?.dispose();
        this._preview = null;

        this._joinStep = 1;

        const panel = document.createElement('div');
        panel.id = 'join-panel';
        panel.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;
            background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;
            flex-direction:column;z-index:200;font-family:Arial,sans-serif;`;

        panel.innerHTML = `
            <div id="join-step1" style="display:flex;flex-direction:column;align-items:center;">
                <h2 style="color:#fff;font-size:36px;margin-bottom:24px">JOIN GAME</h2>
                <div style="display:flex;gap:8px;align-items:center;margin-bottom:20px">
                    <label style="color:#aaa;font-size:14px">Name:</label>
                    <input id="player-name" type="text" value="Player" maxlength="16"
                        style="padding:6px 10px;font-size:14px;border:none;border-radius:4px;width:160px;
                        background:rgba(255,255,255,0.9);color:#333;outline:none" />
                </div>
                <p id="join-error" style="color:#ff4444;font-size:14px;margin-top:4px;min-height:18px;font-weight:bold">${errorMsg}</p>
                <div style="font-size:14px;color:#aaa;margin-bottom:12px;">Select team:</div>
                <div style="display:flex;gap:16px;margin-bottom:20px">
                    <button class="team-btn" data-team="teamA"
                        style="padding:12px 32px;font-size:18px;border:2px solid #4488ff;border-radius:6px;
                        background:rgba(68,136,255,0.2);color:#4488ff;cursor:pointer;font-weight:bold">
                        BLUE TEAM
                    </button>
                    <button class="team-btn" data-team="teamB"
                        style="padding:12px 32px;font-size:18px;border:2px solid #ff4444;border-radius:6px;
                        background:rgba(255,68,68,0.2);color:#ff4444;cursor:pointer;font-weight:bold">
                        RED TEAM
                    </button>
                </div>
                <button id="join-cancel" style="margin-top:12px;padding:6px 20px;font-size:13px;
                    border:1px solid #666;border-radius:4px;background:transparent;color:#888;cursor:pointer">
                    Cancel (Esc)
                </button>
            </div>
            <div id="join-step2" style="display:none;flex-direction:column;align-items:center;">
                <h2 style="color:#fff;font-size:36px;margin-bottom:6px">SELECT COLORS</h2>
                <div id="join-team-badge" style="font-size:14px;font-weight:bold;margin-bottom:12px;
                    padding:4px 16px;border-radius:4px;"></div>
                <p style="color:#888;font-size:13px;margin-bottom:16px;max-width:520px;text-align:center">
                    Your torso stays your team's colour. Pick a head and leg colour so your
                    squad can pick you out from the COMs.
                </p>
                <div style="display:flex;gap:36px;align-items:flex-start">
                    <div id="join-color-list" style="display:flex;flex-direction:column;gap:20px"></div>
                    <div id="join-preview" style="border:1px solid #333;border-radius:6px;
                        background:rgba(255,255,255,0.04);line-height:0"></div>
                </div>
                <div style="display:flex;gap:12px;margin-top:20px;">
                    <button id="join-color-back-btn" style="padding:8px 24px;font-size:14px;border:1px solid #666;
                        border-radius:4px;background:transparent;color:#aaa;cursor:pointer">Back (Esc)</button>
                    <button id="join-color-next-btn" style="padding:8px 32px;font-size:16px;font-weight:bold;
                        border:2px solid #4488ff;border-radius:4px;background:rgba(68,136,255,0.3);
                        color:#fff;cursor:pointer">NEXT (Space)</button>
                </div>
            </div>
            <div id="join-step3" style="display:none;flex-direction:column;align-items:center;">
                <h2 style="color:#fff;font-size:36px;margin-bottom:18px">SELECT WEAPON</h2>
                <div style="display:flex;gap:12px;margin-bottom:20px;color:#fff;">
                    ${weaponCardHTML('join-wp', 1, 'AR15', 'ar', true)}
                    ${weaponCardHTML('join-wp', 2, 'SMG', 'smg', false)}
                    ${weaponCardHTML('join-wp', 3, 'LMG', 'lmg', false)}
                    ${weaponCardHTML('join-wp', 4, 'BOLT', 'bolt', false)}
                </div>
                <div style="display:flex;gap:12px;margin-top:16px;">
                    <button id="join-back-btn" style="padding:8px 24px;font-size:14px;border:1px solid #666;
                        border-radius:4px;background:transparent;color:#aaa;cursor:pointer">Back (Esc)</button>
                    <button id="join-deploy-btn" style="padding:8px 32px;font-size:16px;font-weight:bold;
                        border:2px solid #4488ff;border-radius:4px;background:rgba(68,136,255,0.3);
                        color:#fff;cursor:pointer">DEPLOY (Space)</button>
                </div>
            </div>
        `;

        document.body.appendChild(panel);

        let selectedWeapon = 'AR15';

        const highlightJoinWeapon = (weaponId) => {
            selectedWeapon = weaponId;
            highlightWeaponCard('join-wp', weaponId);
        };

        // Weapon card click selection
        const weaponMap = { 'join-wp-ar': 'AR15', 'join-wp-smg': 'SMG', 'join-wp-lmg': 'LMG', 'join-wp-bolt': 'BOLT' };
        for (const [elId, wid] of Object.entries(weaponMap)) {
            const card = document.getElementById(elId);
            if (card) card.addEventListener('click', () => highlightJoinWeapon(wid));
        }

        // Appearance starts from whatever the player picked last time
        let appearance = loadStoredAppearance();

        // Step 2 — colour picker. Built on entry so the default swatches and the
        // preview's torso can use the team colour just chosen on step 1. The
        // preview holds the default rifle; the weapon is picked on the next step.
        const enterColorStep = () => {
            const teamColor = TEAM_COLORS[this._joinTeam] || 0xaaaaaa;

            const list = document.getElementById('join-color-list');
            list.innerHTML = `
                <div>
                    <div style="color:#aaa;font-size:13px;margin-bottom:8px;letter-spacing:1px">HEAD</div>
                    ${swatchGridHTML('head', teamColor)}
                </div>
                <div>
                    <div style="color:#aaa;font-size:13px;margin-bottom:8px;letter-spacing:1px">LEGS</div>
                    ${swatchGridHTML('legs', teamColor)}
                </div>
            `;

            const highlightSwatches = () => {
                const slots = unpackAppearance(appearance);
                for (const slot of ['head', 'legs']) {
                    const grid = document.getElementById(`swatches-${slot}`);
                    if (!grid) continue;
                    grid.querySelectorAll('.color-swatch').forEach((el) => {
                        const active = Number(el.dataset.index) === slots[slot];
                        el.style.borderColor = active ? '#fff' : 'transparent';
                    });
                }
            };

            list.querySelectorAll('.color-swatch').forEach((el) => {
                el.addEventListener('click', () => {
                    const slots = unpackAppearance(appearance);
                    slots[el.dataset.slot] = Number(el.dataset.index);
                    appearance = packAppearance(slots.head, slots.legs);
                    highlightSwatches();
                    this._preview?.setAppearance(appearance);
                });
            });
            highlightSwatches();

            this._preview?.dispose();
            const container = document.getElementById('join-preview');
            container.innerHTML = '';
            this._preview = new SoldierPreview(container, {
                teamColor, weaponId: selectedWeapon, appearance,
            });
        };

        // Move between steps, tearing the preview down when leaving the colour step
        const showStep = (step) => {
            if (this._joinStep === 2 && step !== 2) {
                this._preview?.dispose();
                this._preview = null;
            }
            this._joinStep = step;
            for (const n of [1, 2, 3]) {
                const el = document.getElementById(`join-step${n}`);
                if (el) el.style.display = n === step ? 'flex' : 'none';
            }
            if (step === 2) enterColorStep();
        };
        this._showStep = showStep;

        // Deploy action (shared by button click and Space key)
        const deployAction = () => {
            document.removeEventListener('keydown', this._joinKeyHandler);
            this._joinKeyHandler = null;
            storeAppearance(appearance);
            this._preview?.dispose();
            this._preview = null;
            panel.remove();
            onJoin(this._joinTeam, selectedWeapon, this._joinName, appearance);
        };

        document.getElementById('join-deploy-btn').addEventListener('click', deployAction);
        document.getElementById('join-color-next-btn').addEventListener('click', () => showStep(3));
        document.getElementById('join-color-back-btn').addEventListener('click', () => showStep(1));
        document.getElementById('join-back-btn').addEventListener('click', () => showStep(2));

        // Keyboard handler — Space advances the colour step (2 → 3); weapon
        // selection (Digit1-4) and deploy live on step 3. Escape is handled by the
        // global keydown handler to avoid double-firing.
        this._joinKeyHandler = (e) => {
            if (this._joinStep === 2) {
                if (e.code === 'Space') showStep(3);
            } else if (this._joinStep === 3) {
                const weaponKeys = { Digit1: 'AR15', Digit2: 'SMG', Digit3: 'LMG', Digit4: 'BOLT' };
                if (weaponKeys[e.code]) highlightJoinWeapon(weaponKeys[e.code]);
                if (e.code === 'Space') deployAction();
            }
        };
        document.addEventListener('keydown', this._joinKeyHandler);

        // Team selection submits the name — check it here rather than letting the
        // player pick colours and a weapon only to be rejected on deploy.
        const errorLine = document.getElementById('join-error');
        panel.querySelectorAll('.team-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const nameInput = document.getElementById('player-name');
                const check = validatePlayerName(nameInput.value, this.getTakenNames());
                if (!check.ok) {
                    if (errorLine) errorLine.textContent = check.error;
                    nameInput.focus();
                    nameInput.select();
                    return;
                }
                if (errorLine) errorLine.textContent = '';

                this._joinTeam = btn.dataset.team;
                this._joinName = check.name;

                // Show team badge
                const badge = document.getElementById('join-team-badge');
                if (badge) {
                    const isA = this._joinTeam === 'teamA';
                    badge.textContent = isA ? 'BLUE TEAM' : 'RED TEAM';
                    badge.style.color = isA ? '#4488ff' : '#ff4444';
                    badge.style.border = `1px solid ${isA ? '#4488ff' : '#ff4444'}`;
                    badge.style.background = isA ? 'rgba(68,136,255,0.15)' : 'rgba(255,68,68,0.15)';
                }

                showStep(2);
            });
        });

        // Cancel
        const cancelBtn = document.getElementById('join-cancel');
        cancelBtn.addEventListener('click', () => {
            this.removeJoinPanel();
            onCancel();
        });
    }

    /**
     * Remove the join panel from the DOM and clean up the keyboard handler.
     */
    removeJoinPanel() {
        if (this._joinKeyHandler) {
            document.removeEventListener('keydown', this._joinKeyHandler);
            this._joinKeyHandler = null;
        }
        this._preview?.dispose();
        this._preview = null;
        this._showStep = null;
        const panel = document.getElementById('join-panel');
        if (panel) panel.remove();
    }

    /**
     * Step back one panel: colours → weapon → name + team.
     */
    goBack() {
        if (this._joinStep <= 1 || !this._showStep) return;
        this._showStep(this._joinStep - 1);
    }
}
