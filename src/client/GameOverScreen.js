/**
 * GameOverScreen — manages the game-over overlay DOM element.
 *
 * Displays the winning team banner, score, two team columns (for external
 * scoreboard rendering), and a countdown to the next round.
 */
export class GameOverScreen {
    constructor() {
        /** @type {HTMLElement|null} */
        this._overlay = null;
    }

    /**
     * Create and show the game-over overlay.
     *
     * @param {'teamA'|'teamB'} winner — which team won
     * @param {number} scoreA — Team A final score
     * @param {number} scoreB — Team B final score
     * @returns {{ teamAEl: HTMLElement, teamBEl: HTMLElement }} references to
     *          the two column containers so the caller can render scoreboard
     *          content into them.
     */
    show(winner, scoreA, scoreB) {
        // Remove previous overlay if any
        this.remove();

        const el = document.createElement('div');
        el.id = 'game-over-overlay';
        el.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;
            background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;
            flex-direction:column;z-index:1000;pointer-events:none;
            font-family:Consolas,monospace;backdrop-filter:blur(2px);`;

        const color = winner === 'teamA' ? '#4488ff' : '#ff4444';
        const teamName = winner === 'teamA' ? 'BLUE TEAM' : 'RED TEAM';

        // Winner banner
        const banner = document.createElement('div');
        banner.style.cssText = `text-align:center;margin-bottom:20px;`;
        banner.innerHTML = `
            <div style="color:${color};font-size:48px;font-weight:bold;margin-bottom:8px;
                text-shadow:0 0 20px ${color}44;">${teamName} WINS</div>
            <div style="color:#ccc;font-size:22px">${scoreA} - ${scoreB}</div>`;
        el.appendChild(banner);

        // Scoreboard columns container
        const sbContainer = document.createElement('div');
        sbContainer.style.cssText = `display:flex;align-items:flex-start;gap:32px;
            background:rgba(0,0,0,0.6);border-radius:10px;padding:20px 28px;
            min-width:600px;border:1px solid rgba(255,255,255,0.1);`;
        sbContainer.innerHTML = `
            <div id="go-teamA" style="flex:1;min-width:260px;"></div>
            <div style="width:1px;background:rgba(255,255,255,0.15);align-self:stretch;"></div>
            <div id="go-teamB" style="flex:1;min-width:260px;"></div>`;
        el.appendChild(sbContainer);

        // Countdown display
        const countdown = document.createElement('div');
        countdown.id = 'go-countdown';
        countdown.style.cssText = `color:#aaa;font-size:16px;margin-top:16px;text-align:center;`;
        countdown.textContent = 'Next round starting...';
        el.appendChild(countdown);

        document.body.appendChild(el);
        this._overlay = el;

        return {
            teamAEl: document.getElementById('go-teamA'),
            teamBEl: document.getElementById('go-teamB'),
        };
    }

    /**
     * Update the countdown text in the overlay.
     * @param {number} secondsLeft
     */
    updateCountdown(secondsLeft) {
        const el = document.getElementById('go-countdown');
        if (el) el.textContent = `Next round in ${secondsLeft}s`;
    }

    /**
     * Remove the game-over overlay from the DOM.
     */
    remove() {
        if (this._overlay) {
            this._overlay.remove();
            this._overlay = null;
            return;
        }
        // Fallback: remove by id in case reference was lost
        const prev = document.getElementById('game-over-overlay');
        if (prev) prev.remove();
    }
}
