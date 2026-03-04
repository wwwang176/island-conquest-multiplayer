import { weaponCardHTML, highlightWeaponCard } from './WeaponCardUI.js';

const RESPAWN_COUNTDOWN = 5;
const WEAPON_CARD_MAP = { 'mp-wp-ar': 'AR15', 'mp-wp-smg': 'SMG', 'mp-wp-lmg': 'LMG', 'mp-wp-bolt': 'BOLT' };

export class DeathScreen {
    constructor() {
        this.canRespawn = false;
        this.selectedWeapon = 'AR15';
        this.countdown = 0;
        this._clicksBound = false;
    }

    /**
     * Shows the death overlay with a respawn countdown.
     * Creates the DOM element on first call.
     * @param {string} currentWeaponId - The weapon the player was using when they died
     */
    show(currentWeaponId) {
        let el = document.getElementById('death-overlay');
        if (!el) {
            el = document.createElement('div');
            el.id = 'death-overlay';
            el.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;
                background:rgba(139,0,0,0.3);display:flex;align-items:center;justify-content:center;
                flex-direction:column;z-index:101;`;
            el.innerHTML = `
                <div style="color:white;font-family:Arial,sans-serif;text-align:center;">
                    <div style="font-size:36px;font-weight:bold;margin-bottom:10px;">YOU DIED</div>
                    <div id="mp-respawn-timer" style="font-size:20px;color:#ccc;"></div>
                    <div id="mp-weapon-select" style="display:none;margin-top:18px;">
                        <div style="font-size:14px;color:#aaa;margin-bottom:8px;">Select weapon:</div>
                        <div style="display:flex;gap:12px;justify-content:center;">
                            ${weaponCardHTML('mp-wp', 1, 'AR15', 'ar', true)}
                            ${weaponCardHTML('mp-wp', 2, 'SMG', 'smg', false)}
                            ${weaponCardHTML('mp-wp', 3, 'LMG', 'lmg', false)}
                            ${weaponCardHTML('mp-wp', 4, 'BOLT', 'bolt', false)}
                        </div>
                    </div>
                    <div id="mp-respawn-prompt" style="display:none;flex-direction:column;align-items:center;margin-top:14px;gap:10px;">
                        <div style="display:flex;gap:12px;">
                            <button id="mp-spectate-btn" style="padding:8px 24px;font-size:14px;border:1px solid #666;
                                border-radius:4px;background:transparent;color:#aaa;cursor:pointer">Spectate (Esc)</button>
                            <button id="mp-respawn-btn" style="padding:8px 32px;font-size:16px;font-weight:bold;
                                border:2px solid #4488ff;border-radius:4px;background:rgba(68,136,255,0.3);
                                color:#fff;cursor:pointer">RESPAWN (Space)</button>
                        </div>
                    </div>
                </div>`;
            document.body.appendChild(el);
        }
        el.style.display = 'flex';

        // Init death countdown
        this.countdown = RESPAWN_COUNTDOWN;
        this.canRespawn = false;
        this.selectedWeapon = currentWeaponId;

        // Reset weapon card highlights
        const wpSelect = document.getElementById('mp-weapon-select');
        if (wpSelect) wpSelect.style.display = 'none';
        const prompt = document.getElementById('mp-respawn-prompt');
        if (prompt) prompt.style.display = 'none';
        const timer = document.getElementById('mp-respawn-timer');
        if (timer) timer.textContent = `Respawn in ${RESPAWN_COUNTDOWN}s`;
    }

    /**
     * Hides the death overlay.
     */
    hide() {
        const el = document.getElementById('death-overlay');
        if (el) el.style.display = 'none';
        this.canRespawn = false;
    }

    /**
     * Updates the countdown timer. When the timer expires, shows the weapon
     * selection panel and respawn/spectate buttons.
     * @param {number} dt - Delta time in seconds
     */
    update(dt) {
        if (this.countdown > 0) {
            this.countdown -= dt;
            const sec = Math.max(0, Math.ceil(this.countdown));
            const timer = document.getElementById('mp-respawn-timer');
            if (timer) timer.textContent = `Respawn in ${sec}s`;

            if (this.countdown <= 0) {
                // Countdown done — show weapon selection
                this.canRespawn = true;
                if (timer) timer.textContent = '';
                const wpSelect = document.getElementById('mp-weapon-select');
                if (wpSelect) wpSelect.style.display = 'block';
                const prompt = document.getElementById('mp-respawn-prompt');
                if (prompt) prompt.style.display = 'flex';
                this.highlightWeapon(this.selectedWeapon);
                this.bindClickHandlers();
            }
        }
    }

    /**
     * Highlights the given weapon card and un-highlights all others.
     * @param {string} weaponId - Weapon key to highlight (e.g. 'AR15')
     */
    highlightWeapon(weaponId) {
        highlightWeaponCard('mp-wp', weaponId);
    }

    /**
     * Binds click handlers for weapon cards, respawn button, and spectate button.
     * Only binds once; subsequent calls are no-ops.
     * @param {Function} [onRespawn] - Called with the selected weaponId when respawn is clicked
     * @param {Function} [onSpectate] - Called when spectate is clicked
     */
    bindClickHandlers(onRespawn, onSpectate) {
        if (this._clicksBound) return;
        this._clicksBound = true;

        // Store callbacks for internal use (first call sets them)
        if (onRespawn) this._onRespawn = onRespawn;
        if (onSpectate) this._onSpectate = onSpectate;

        // Weapon card clicks
        for (const [elId, wid] of Object.entries(WEAPON_CARD_MAP)) {
            const card = document.getElementById(elId);
            if (card) card.addEventListener('click', () => {
                if (!this.canRespawn) return;
                this.selectedWeapon = wid;
                this.highlightWeapon(wid);
            });
        }

        // Respawn button
        const respawnBtn = document.getElementById('mp-respawn-btn');
        if (respawnBtn) respawnBtn.addEventListener('click', () => {
            if (!this.canRespawn) return;
            const weaponId = this.selectedWeapon || 'AR15';
            if (this._onRespawn) this._onRespawn(weaponId);
        });

        // Spectate button
        const spectateBtn = document.getElementById('mp-spectate-btn');
        if (spectateBtn) spectateBtn.addEventListener('click', () => {
            if (!this.canRespawn) return;
            if (this._onSpectate) this._onSpectate();
        });
    }
}
