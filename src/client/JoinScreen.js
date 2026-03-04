import { weaponCardHTML, highlightWeaponCard } from './WeaponCardUI.js';

/**
 * JoinScreen — handles the connection form and the join-game panel
 * (team select + weapon select) that were previously inline in ClientGame.
 */
export class JoinScreen {
    constructor() {
        this._joinStep = 1;
        this._joinTeam = null;
        this._joinName = 'Player';
        this._joinKeyHandler = null;
        this._blocker = null;
    }

    // ── public getters ──

    /** Current join step: 1 = team select, 2 = weapon select */
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
     * @param {(team: string, weaponId: string, playerName: string) => void} onJoin
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
                <h2 style="color:#fff;font-size:36px;margin-bottom:12px">SELECT WEAPON</h2>
                <div id="join-team-badge" style="font-size:14px;font-weight:bold;margin-bottom:18px;
                    padding:4px 16px;border-radius:4px;"></div>
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

        // Deploy action (shared by button click and Space key)
        const deployAction = () => {
            document.removeEventListener('keydown', this._joinKeyHandler);
            this._joinKeyHandler = null;
            panel.remove();
            onJoin(this._joinTeam, selectedWeapon, this._joinName);
        };

        // Back action (shared by button click and Esc key)
        const backAction = () => {
            this._joinStep = 1;
            document.getElementById('join-step2').style.display = 'none';
            document.getElementById('join-step1').style.display = 'flex';
        };

        // Deploy button
        document.getElementById('join-deploy-btn').addEventListener('click', deployAction);

        // Back button
        document.getElementById('join-back-btn').addEventListener('click', backAction);

        // Keyboard handler — weapon selection (Digit1-4) + deploy (Space) + back (Esc) in step 2
        this._joinKeyHandler = (e) => {
            if (this._joinStep !== 2) return;
            const weaponKeys = { Digit1: 'AR15', Digit2: 'SMG', Digit3: 'LMG', Digit4: 'BOLT' };
            if (weaponKeys[e.code]) {
                highlightJoinWeapon(weaponKeys[e.code]);
            }
            if (e.code === 'Space') {
                deployAction();
            }
            // Escape is handled by the global keydown handler (avoids double-fire)
        };
        document.addEventListener('keydown', this._joinKeyHandler);

        // Team selection -> advance to step 2
        panel.querySelectorAll('.team-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this._joinTeam = btn.dataset.team;
                this._joinName = document.getElementById('player-name').value.trim() || 'Player';
                this._joinStep = 2;

                // Show team badge
                const badge = document.getElementById('join-team-badge');
                if (badge) {
                    const isA = this._joinTeam === 'teamA';
                    badge.textContent = isA ? 'BLUE TEAM' : 'RED TEAM';
                    badge.style.color = isA ? '#4488ff' : '#ff4444';
                    badge.style.border = `1px solid ${isA ? '#4488ff' : '#ff4444'}`;
                    badge.style.background = isA ? 'rgba(68,136,255,0.15)' : 'rgba(255,68,68,0.15)';
                }

                document.getElementById('join-step1').style.display = 'none';
                document.getElementById('join-step2').style.display = 'flex';
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
        const panel = document.getElementById('join-panel');
        if (panel) panel.remove();
    }

    /**
     * Go back from weapon select (step 2) to team select (step 1).
     */
    goBackToStep1() {
        this._joinStep = 1;
        const step2 = document.getElementById('join-step2');
        const step1 = document.getElementById('join-step1');
        if (step2) step2.style.display = 'none';
        if (step1) step1.style.display = 'flex';
    }
}
