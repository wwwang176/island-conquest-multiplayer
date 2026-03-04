import { WeaponDefs } from '../entities/WeaponDefs.js';

const WEAPON_SHORT_IDS = { AR15: 'ar', SMG: 'smg', LMG: 'lmg', BOLT: 'bolt' };

/**
 * Returns an HTML string of stat bars (DMG, ROF, RNG, ACC, MOB) for the given weapon.
 */
export function weaponStatBars(weaponId) {
    const def = WeaponDefs[weaponId];
    let maxDmg = 0, maxRof = 0, maxRng = 0, maxSpread = 0, maxMob = 0;
    for (const k in WeaponDefs) {
        const w = WeaponDefs[k];
        if (!w.fireRate) continue;
        if (w.damage > maxDmg) maxDmg = w.damage;
        if (w.fireRate > maxRof) maxRof = w.fireRate;
        if (w.maxRange > maxRng) maxRng = w.maxRange;
        if (w.baseSpread > maxSpread) maxSpread = w.baseSpread;
        if ((w.moveSpeedMult || 1) > maxMob) maxMob = w.moveSpeedMult || 1;
    }
    const stats = [
        ['DMG', def.damage / maxDmg],
        ['ROF', def.fireRate / maxRof],
        ['RNG', def.maxRange / maxRng],
        ['ACC', 1 - def.baseSpread / (maxSpread * 1.25)],
        ['MOB', (def.moveSpeedMult || 1) / maxMob],
    ];
    const barW = 64;
    return stats.map(([label, ratio]) => {
        const pct = Math.round(Math.min(1, Math.max(0, ratio)) * 100);
        return `<div style="display:flex;align-items:center;gap:5px;margin-top:3px;">
                <span style="font-size:9px;color:#888;width:24px;text-align:right;">${label}</span>
                <div style="width:${barW}px;height:5px;background:rgba(255,255,255,0.12);border-radius:2px;overflow:hidden;">
                    <div style="width:${pct}%;height:100%;background:rgba(255,255,255,0.6);border-radius:2px;"></div>
                </div>
                <span style="font-size:9px;color:#aaa;width:20px;text-align:right;">${pct}</span>
            </div>`;
    }).join('');
}

/**
 * Returns an HTML string for a weapon selection card.
 * @param {string} idPrefix - DOM id prefix (e.g. 'join-wp' or 'mp-wp')
 * @param {number} num - Display number for the card (e.g. 1, 2, 3, 4)
 * @param {string} weaponId - Weapon key in WeaponDefs (e.g. 'AR15')
 * @param {string} shortId - Short suffix for the DOM id (e.g. 'ar', 'smg')
 * @param {boolean} selected - Whether this card is initially selected
 */
export function weaponCardHTML(idPrefix, num, weaponId, shortId, selected) {
    const def = WeaponDefs[weaponId];
    const border = selected ? '#4488ff' : '#888';
    const bg = selected ? 'rgba(68,136,255,0.15)' : 'transparent';
    return `<div id="${idPrefix}-${shortId}" style="border:2px solid ${border};border-radius:8px;padding:10px 14px;
            background:${bg};cursor:pointer;min-width:140px;transition:background 0.15s,border-color 0.15s;"
            onmouseenter="if(this.style.borderColor!=='rgb(68, 136, 255)')this.style.background='rgba(255,255,255,0.07)'"
            onmouseleave="if(this.style.borderColor!=='rgb(68, 136, 255)')this.style.background='transparent'">
            <div style="font-size:16px;font-weight:bold;">[${num}] ${def.name}</div>
            <div style="font-size:11px;color:#aaa;margin-top:3px;">${def.fireRate} RPM &middot; ${def.magazineSize} rds</div>
            ${weaponStatBars(weaponId)}
        </div>`;
}

/**
 * Highlights the selected weapon card and un-highlights all others.
 * @param {string} idPrefix - DOM id prefix (e.g. 'join-wp' or 'mp-wp')
 * @param {string} weaponId - Weapon key to highlight (e.g. 'AR15')
 */
export function highlightWeaponCard(idPrefix, weaponId) {
    for (const [wid, shortId] of Object.entries(WEAPON_SHORT_IDS)) {
        const card = document.getElementById(`${idPrefix}-${shortId}`);
        if (!card) continue;
        if (wid === weaponId) {
            card.style.borderColor = '#4488ff';
            card.style.background = 'rgba(68,136,255,0.15)';
        } else {
            card.style.borderColor = '#888';
            card.style.background = 'transparent';
        }
    }
}
