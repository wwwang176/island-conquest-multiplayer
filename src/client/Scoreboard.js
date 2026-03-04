import { TEAM_SIZE } from '../shared/constants.js';

/** Escape HTML special characters to prevent XSS when inserting into innerHTML. */
function escapeHTML(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

export class Scoreboard {
    constructor() {
        /** playerName → { kills, deaths, team, weapon } */
        this.data = {};
        /** entityId → playerName */
        this.playerNames = new Map();
        /** playerName → ping ms */
        this.playerPings = {};
        /** Number of spectators */
        this.spectatorCount = 0;

        this._el = null;
        this._createDOM();
    }

    // ── DOM creation ──

    _createDOM() {
        const el = document.createElement('div');
        el.id = 'scoreboard';
        el.style.cssText = `position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
            background:rgba(0,0,0,0.8);border-radius:10px;padding:20px 28px;
            display:none;flex-direction:column;
            pointer-events:none;z-index:150;font-family:Consolas,monospace;
            min-width:600px;backdrop-filter:blur(4px);border:1px solid rgba(255,255,255,0.1);`;
        el.innerHTML = `
            <div style="display:flex;align-items:flex-start;gap:32px;">
                <div id="sb-teamA" style="flex:1;min-width:280px;"></div>
                <div style="width:1px;background:rgba(255,255,255,0.15);align-self:stretch;"></div>
                <div id="sb-teamB" style="flex:1;min-width:280px;"></div>
            </div>
            <div id="sb-spectators" style="margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.1);display:none;"></div>`;
        document.body.appendChild(el);
        this._el = el;
    }

    // ── Public API ──

    /**
     * Build and display the scoreboard overlay.
     * @param {string} localPlayerName - The local player's display name.
     * @param {number} localEntityId - The local player's entity ID (-1 if spectating).
     * @param {Object} playerPings - Optional override for pings (name → ms).
     */
    show(localPlayerName, localEntityId, playerPings) {
        if (!this._el) return;

        if (playerPings) this.playerPings = playerPings;

        // Split into teams and sort
        const teamAList = [];
        const teamBList = [];
        for (const [name, stat] of Object.entries(this.data)) {
            const entry = { name, ...stat, ping: this.playerPings[name] ?? 0 };
            if (stat.team === 'teamA') teamAList.push(entry);
            else teamBList.push(entry);
        }
        teamAList.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
        teamBList.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);

        const pingColor = (ms) => ms < 30 ? '#6f6' : ms < 80 ? '#ff4' : '#f66';

        const renderTeam = (entries, teamColor, teamLabel) => {
            let totalK = 0, totalD = 0;
            for (const e of entries) { totalK += e.kills; totalD += e.deaths; }
            let html = `<div style="color:${teamColor};font-weight:bold;font-size:16px;margin-bottom:8px;text-align:center;">${teamLabel}</div>`;
            html += `<div style="display:flex;color:#888;font-size:11px;padding:2px 6px;border-bottom:1px solid rgba(255,255,255,0.1);margin-bottom:2px;">
                <span style="flex:1">Name</span><span style="width:30px;text-align:center">K</span>
                <span style="width:30px;text-align:center">D</span><span style="width:50px;text-align:center">Wpn</span><span style="width:48px;text-align:right">Ping</span></div>`;
            for (const e of entries) {
                const isPlayer = e.name === localPlayerName && localEntityId >= 0;
                const com = this.isCOM(e.name);
                const displayName = com ? `${escapeHTML(e.name)}<span style="color:#666;font-weight:normal">(AI)</span>` : escapeHTML(e.name);
                const bg = isPlayer ? 'rgba(255,255,255,0.1)' : 'transparent';
                const nameColor = isPlayer ? '#fff' : 'rgba(255,255,255,0.75)';
                const wpn = e.weapon || '-';
                const pingStr = com ? '<span style="color:#555">-</span>' : `<span style="color:${pingColor(e.ping)}">${e.ping}ms</span>`;
                html += `<div style="display:flex;font-size:12px;padding:2px 6px;background:${bg};border-radius:2px;">
                    <span style="flex:1;color:${nameColor};font-weight:${isPlayer ? 'bold' : 'normal'}">${displayName}</span>
                    <span style="width:30px;text-align:center;color:#ccc">${e.kills}</span>
                    <span style="width:30px;text-align:center;color:#ccc">${e.deaths}</span>
                    <span style="width:50px;text-align:center;color:#888;font-size:11px">${escapeHTML(wpn)}</span>
                    <span style="width:48px;text-align:right;font-size:11px">${pingStr}</span></div>`;
            }
            html += `<div style="display:flex;font-size:12px;padding:4px 6px;margin-top:4px;border-top:1px solid rgba(255,255,255,0.1);color:#aaa;">
                <span style="flex:1;font-weight:bold">Total</span>
                <span style="width:30px;text-align:center">${totalK}</span>
                <span style="width:30px;text-align:center">${totalD}</span>
                <span style="width:50px"></span><span style="width:48px"></span></div>`;
            return html;
        };

        document.getElementById('sb-teamA').innerHTML = renderTeam(teamAList, '#4488ff', 'TEAM A');
        document.getElementById('sb-teamB').innerHTML = renderTeam(teamBList, '#ff4444', 'TEAM B');

        // Spectators section
        const specEl = document.getElementById('sb-spectators');
        if (specEl) {
            if (this.spectatorCount > 0) {
                specEl.innerHTML = `<span style="color:#888;font-size:11px;">Spectators: ${this.spectatorCount}</span>`;
                specEl.style.display = 'block';
            } else {
                specEl.style.display = 'none';
            }
        }

        this._el.style.display = 'flex';
    }

    /** Hide the scoreboard overlay. */
    hide() {
        if (this._el) this._el.style.display = 'none';
    }

    /**
     * Track a kill event, updating killer and victim stats.
     * @param {string} killerName
     * @param {string} killerTeam
     * @param {string} victimName
     * @param {string} victimTeam
     * @param {string} weapon
     * @param {number} [killerKills] - Authoritative kill count from server.
     * @param {number} [victimDeaths] - Authoritative death count from server.
     */
    trackKill(killerName, killerTeam, victimName, victimTeam, weapon, killerKills, victimDeaths) {
        // Track killer — use authoritative server value
        if (!this.data[killerName]) {
            this.data[killerName] = { kills: 0, deaths: 0, team: killerTeam, weapon: '' };
        }
        if (killerKills !== undefined) {
            this.data[killerName].kills = killerKills;
        } else {
            this.data[killerName].kills++;
        }
        this.data[killerName].team = killerTeam;
        if (weapon) this.data[killerName].weapon = weapon;

        // Track victim — use authoritative server value
        if (!this.data[victimName]) {
            this.data[victimName] = { kills: 0, deaths: 0, team: victimTeam, weapon: '' };
        }
        if (victimDeaths !== undefined) {
            this.data[victimName].deaths = victimDeaths;
        } else {
            this.data[victimName].deaths++;
        }
        this.data[victimName].team = victimTeam;
    }

    /**
     * Sync scoreboard from server snapshot.
     * @param {Array} entries - Array of { name, kills, deaths, team, weaponId, ping }.
     * @param {number} [spectatorCount]
     */
    onSync(entries, spectatorCount) {
        for (const e of entries) {
            this.data[e.name] = {
                kills: e.kills,
                deaths: e.deaths,
                team: e.team,
                weapon: e.weaponId,
            };
            if (e.ping !== undefined) {
                this.playerPings[e.name] = e.ping;
            }
        }
        if (spectatorCount !== undefined) {
            this.spectatorCount = spectatorCount;
        }
    }

    /**
     * Returns true if the scoreboard name belongs to a COM (not a real player).
     * @param {string} name
     * @returns {boolean}
     */
    isCOM(name) {
        for (const pn of this.playerNames.values()) {
            if (pn === name) return false;
        }
        return true;
    }

    /**
     * Update weapon data from the entity renderer's current state.
     * @param {object} entityRenderer - The EntityRenderer instance (must have .entities Map).
     * @param {Map} playerNames - entityId → playerName map.
     * @param {number} teamSize - Number of soldiers per team.
     */
    updateWeaponData(entityRenderer, playerNames, teamSize) {
        if (playerNames) this.playerNames = playerNames;
        const ts = teamSize ?? TEAM_SIZE;
        for (const [entityId, entry] of entityRenderer.entities) {
            if (entry.isGrenade) continue;
            let name;
            if (this.playerNames.has(entityId)) {
                name = this.playerNames.get(entityId);
            } else if (entry.team === 'teamA') {
                name = `A-${entityId}`;
            } else {
                name = `B-${entityId - ts}`;
            }
            const sb = this.data[name];
            if (sb && entry.weaponId) sb.weapon = entry.weaponId;
        }
    }

    /** Render team columns into game-over overlay (expects #go-teamA and #go-teamB elements). */
    renderGameOver() {
        const goA = document.getElementById('go-teamA');
        const goB = document.getElementById('go-teamB');
        if (!goA || !goB) return;

        const teamAList = [];
        const teamBList = [];
        for (const [name, stat] of Object.entries(this.data)) {
            const entry = { name, ...stat };
            if (stat.team === 'teamA') teamAList.push(entry);
            else teamBList.push(entry);
        }
        teamAList.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
        teamBList.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);

        const renderTeam = (entries, teamColor, teamLabel) => {
            let totalK = 0, totalD = 0;
            for (const e of entries) { totalK += e.kills; totalD += e.deaths; }
            let html = `<div style="color:${teamColor};font-weight:bold;font-size:16px;margin-bottom:8px;text-align:center;">${teamLabel}</div>`;
            html += `<div style="display:flex;color:#888;font-size:11px;padding:2px 6px;border-bottom:1px solid rgba(255,255,255,0.1);margin-bottom:2px;">
                <span style="flex:1">Name</span><span style="width:30px;text-align:center">K</span>
                <span style="width:30px;text-align:center">D</span><span style="width:50px;text-align:right">Wpn</span></div>`;
            for (const e of entries) {
                const com = this.isCOM(e.name);
                const displayName = com ? `${escapeHTML(e.name)}<span style="color:#666;font-weight:normal">(AI)</span>` : escapeHTML(e.name);
                const bg = 'transparent';
                const nameColor = 'rgba(255,255,255,0.75)';
                const wpn = e.weapon || '-';
                html += `<div style="display:flex;font-size:12px;padding:2px 6px;background:${bg};border-radius:2px;">
                    <span style="flex:1;color:${nameColor};font-weight:normal">${displayName}</span>
                    <span style="width:30px;text-align:center;color:#ccc">${e.kills}</span>
                    <span style="width:30px;text-align:center;color:#ccc">${e.deaths}</span>
                    <span style="width:50px;text-align:right;color:#888;font-size:11px">${escapeHTML(wpn)}</span></div>`;
            }
            html += `<div style="display:flex;font-size:12px;padding:4px 6px;margin-top:4px;border-top:1px solid rgba(255,255,255,0.1);color:#aaa;">
                <span style="flex:1;font-weight:bold">Total</span>
                <span style="width:30px;text-align:center">${totalK}</span>
                <span style="width:30px;text-align:center">${totalD}</span>
                <span style="width:50px"></span></div>`;
            return html;
        };

        goA.innerHTML = renderTeam(teamAList, '#4488ff', 'TEAM A');
        goB.innerHTML = renderTeam(teamBList, '#ff4444', 'TEAM B');
    }

    /**
     * Reset all scoreboard stats for a new round.
     * @param {number} [teamSize] - Soldiers per team (defaults to TEAM_SIZE).
     */
    resetStats(teamSize) {
        const ts = teamSize ?? TEAM_SIZE;
        for (const key of Object.keys(this.data)) {
            delete this.data[key];
        }
        for (let i = 0; i < ts; i++) {
            this.data[`A-${i}`] = { kills: 0, deaths: 0, team: 'teamA', weapon: '' };
            this.data[`B-${i}`] = { kills: 0, deaths: 0, team: 'teamB', weapon: '' };
        }
        this.playerNames.clear();
        this.playerPings = {};
        this.spectatorCount = 0;
    }
}
