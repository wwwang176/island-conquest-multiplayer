import { WeaponDefs } from '../entities/WeaponDefs.js';

/**
 * ClientHUD — manages all in-game HUD DOM elements:
 * ScoreHUD, Crosshair + HitMarker, ScopeVignette, PlayerHUD (health/ammo/reload),
 * DamageIndicator, PingDisplay, KillBanner, FlagBanner.
 *
 * Does NOT include: Scoreboard, Vehicle HUD, Vehicle Prompt, Connection UI,
 * Join UI, Death overlay, Game Over overlay.
 */
export class ClientHUD {
    constructor() {
        // ── Score HUD ──
        this._createScoreHUD();

        // ── Crosshair + Hit Marker ──
        this._createCrosshair();

        // ── Scope Vignette ──
        this._createScopeVignette();

        // ── Player HUD (health + ammo + reload indicator) ──
        this._createPlayerHUD();

        // ── Damage Indicator ──
        this._createDamageIndicator();

        // ── Ping Display ──
        this._createPingDisplay();

        // ── Kill Banner ──
        this._createKillBanner();

        // ── Flag Banner ──
        this._createFlagBanner();

        // ── Kill streak state ──
        this._streakCount = 0;
        this._streakTimer = 0;

        // ── Kill banner timer ──
        this._killBannerTimer = 0;
        this._killBannerFadeOut = false;

        // ── Flag banner timer ──
        this._flagBannerTimer = 0;
        this._flagBannerFadeOut = false;
    }

    // ═══════════════════════════════════════════════════════
    // DOM element creation
    // ═══════════════════════════════════════════════════════

    _createScoreHUD() {
        const el = document.createElement('div');
        el.id = 'net-score';
        el.style.cssText = `position:fixed;top:15px;left:50%;transform:translateX(-50%);
            color:white;font-family:Consolas,monospace;font-size:18px;
            background:rgba(0,0,0,0.5);padding:8px 24px;border-radius:6px;
            pointer-events:none;z-index:100;text-align:center;`;
        el.innerHTML = `
            <span style="color:#4488ff;font-weight:bold"><span id="score-a">0</span></span>
            <span style="color:#aaa;font-size:14px;margin:0 6px">
                Team A [<span id="flag-count-a">0</span>] &mdash; [<span id="flag-count-b">0</span>] Team B
            </span>
            <span style="color:#ff4444;font-weight:bold"><span id="score-b">0</span></span>`;
        document.body.appendChild(el);
        this._scoreA = document.getElementById('score-a');
        this._scoreB = document.getElementById('score-b');
        this._flagCountA = document.getElementById('flag-count-a');
        this._flagCountB = document.getElementById('flag-count-b');
    }

    _createCrosshair() {
        const el = document.createElement('div');
        el.id = 'crosshair';
        el.style.cssText = `position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
            width:30px;height:30px;pointer-events:none;z-index:100;display:none;`;
        el.innerHTML = `
            <svg width="30" height="30" viewBox="0 0 30 30">
                <line x1="15" y1="3" x2="15" y2="12" stroke="white" stroke-width="2" opacity="0.8"/>
                <line x1="15" y1="18" x2="15" y2="27" stroke="white" stroke-width="2" opacity="0.8"/>
                <line x1="3" y1="15" x2="12" y2="15" stroke="white" stroke-width="2" opacity="0.8"/>
                <line x1="18" y1="15" x2="27" y2="15" stroke="white" stroke-width="2" opacity="0.8"/>
            </svg>`;
        document.body.appendChild(el);
        this.crosshair = el;

        // Hit marker (X shape, separate from crosshair)
        const hm = document.createElement('div');
        hm.id = 'hit-marker';
        hm.style.cssText = `position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(45deg);
            width:30px;height:30px;pointer-events:none;z-index:101;display:none;`;
        hm.innerHTML = `<svg width="30" height="30" viewBox="0 0 20 20">
            <line x1="10" y1="2" x2="10" y2="7" stroke="white" stroke-width="1.5"/>
            <line x1="10" y1="13" x2="10" y2="18" stroke="white" stroke-width="1.5"/>
            <line x1="2" y1="10" x2="7" y2="10" stroke="white" stroke-width="1.5"/>
            <line x1="13" y1="10" x2="18" y2="10" stroke="white" stroke-width="1.5"/></svg>`;
        document.body.appendChild(hm);
        this._hitMarker = hm;
        this._hitMarkerLines = hm.querySelectorAll('line');
        this._hitMarkerScale = 1;
        this._hitMarkerDuration = 0.15;
        this._hitMarkerTimer = 0;
    }

    _createScopeVignette() {
        const el = document.createElement('div');
        el.id = 'scope-vignette';
        el.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;
            pointer-events:none;z-index:99;display:none;
            background:radial-gradient(circle, transparent 30%, rgba(0,0,0,0.9) 70%);`;
        el.innerHTML = `
            <div style="position:absolute;top:50%;left:0;width:100%;height:1px;background:rgba(255,255,255,0.5);"></div>
            <div style="position:absolute;top:0;left:50%;width:1px;height:100%;background:rgba(255,255,255,0.5);"></div>
            <div style="position:absolute;top:50%;left:50%;width:6px;height:6px;transform:translate(-50%,-50%);
                border:1px solid rgba(255,255,255,0.6);border-radius:50%;"></div>`;
        document.body.appendChild(el);
        this.scopeVignette = el;
    }

    _createPlayerHUD() {
        // ── Health HUD (bottom-left) ──
        const health = document.createElement('div');
        health.id = 'health-hud';
        health.style.cssText = `position:fixed;bottom:30px;left:30px;color:white;
            font-family:Consolas,monospace;background:rgba(0,0,0,0.5);
            padding:12px 18px;border-radius:6px;pointer-events:none;z-index:100;
            min-width:150px;display:none;`;
        document.body.appendChild(health);
        this.healthHUD = health;

        // ── Ammo HUD (bottom-right) ──
        const ammo = document.createElement('div');
        ammo.id = 'ammo-hud';
        ammo.style.cssText = `position:fixed;bottom:30px;right:30px;color:white;
            font-family:Consolas,monospace;font-size:16px;background:rgba(0,0,0,0.5);
            padding:12px 18px;border-radius:6px;pointer-events:none;z-index:100;
            min-width:120px;display:none;`;
        document.body.appendChild(ammo);
        this.ammoHUD = ammo;

        // ── Reload Indicator (center, SVG circle) ──
        const ri = document.createElement('div');
        ri.id = 'reload-indicator';
        ri.style.cssText = `position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
            width:40px;height:40px;pointer-events:none;z-index:100;display:none;`;
        ri.innerHTML = `<svg width="40" height="40" viewBox="0 0 40 40" style="transform:rotate(-90deg)">
            <circle cx="20" cy="20" r="16" fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="3"/>
            <circle id="reload-arc" cx="20" cy="20" r="16" fill="none" stroke="white" stroke-width="3"
                stroke-dasharray="100.53" stroke-dashoffset="100.53" stroke-linecap="round" opacity="0.85"/>
        </svg>`;
        document.body.appendChild(ri);
        this.reloadIndicator = ri;
        this._reloadArc = null; // lazy-cached

        // Dirty-check caches
        this._lastAmmo = undefined;
        this._lastHP = undefined;
        this._lastWeaponId = undefined;
        this._lastReloading = undefined;
        this._lastBolting = undefined;
        this._lastGrenades = undefined;

        // Reload progress tracking (local timer since server only sends state bits)
        this._reloadTrack = {
            wasReloading: false,
            wasBolting: false,
            elapsed: 0,
        };
    }

    _createDamageIndicator() {
        const el = document.createElement('div');
        el.id = 'damage-indicator';
        el.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;
            pointer-events:none;z-index:99;`;
        document.body.appendChild(el);
        this._dmgIndicator = el;
        this._dmgIndicatorTimer = 0;
    }

    _createPingDisplay() {
        const el = document.createElement('div');
        el.id = 'ping-display';
        el.style.cssText = `position:fixed;top:10px;right:10px;
            font-family:Consolas,monospace;font-size:12px;
            color:rgba(255,255,255,0.5);z-index:100;pointer-events:none;`;
        el.textContent = 'PING: --';
        document.body.appendChild(el);
        this._pingDisplay = el;
    }

    _createKillBanner() {
        const el = document.createElement('div');
        el.id = 'kill-banner';
        el.style.cssText = `position:fixed;top:calc(50% + 60px);left:50%;transform:translateX(-50%);
            pointer-events:none;z-index:102;display:none;
            font-family:Arial,sans-serif;font-size:18px;font-weight:bold;
            text-shadow:0 0 6px rgba(0,0,0,0.8);letter-spacing:2px;
            transition:opacity 0.15s ease-out, transform 0.15s ease-out;`;
        const span = document.createElement('span');
        el.appendChild(span);
        document.body.appendChild(el);
        this._killBannerEl = el;
        this._killBannerText = span;
    }

    _createFlagBanner() {
        const el = document.createElement('div');
        el.id = 'flag-banner';
        el.style.cssText = `position:fixed;top:25%;left:50%;transform:translateX(-50%);
            pointer-events:none;z-index:102;display:none;
            font-family:Consolas,monospace;font-size:20px;font-weight:bold;
            letter-spacing:2px;background:rgba(0,0,0,0.5);padding:8px 24px;border-radius:6px;
            transition:opacity 0.15s ease-out, transform 0.15s ease-out;`;
        const span = document.createElement('span');
        el.appendChild(span);
        document.body.appendChild(el);
        this._flagBannerEl = el;
        this._flagBannerTextEl = span;
    }

    // ═══════════════════════════════════════════════════════
    // Update methods
    // ═══════════════════════════════════════════════════════

    /**
     * Update health and ammo HUD elements.
     * @param {number} dt - Delta time in seconds.
     * @param {Object} data - HUD data from caller.
     * @param {number} data.hp - Current hit points.
     * @param {number} data.ammo - Current ammo count.
     * @param {number} data.grenades - Current grenade count.
     * @param {string} data.weaponId - Current weapon ID (e.g. 'AR15').
     * @param {boolean} data.isReloading - Whether currently reloading.
     * @param {boolean} data.isBolting - Whether currently cycling bolt action.
     */
    updatePlayerHUD(dt, { hp, ammo, grenades, weaponId, isReloading, isBolting }) {
        // ── Health HUD ──
        const curHP = Math.round(hp);
        if (curHP !== this._lastHP) {
            this._lastHP = curHP;
            const hpColor = curHP > 60 ? '#4f4' : curHP > 30 ? '#ff4' : '#f44';
            const barWidth = Math.max(0, curHP);
            this.healthHUD.innerHTML = `
                <div style="font-size:12px;color:#aaa;margin-bottom:4px">HEALTH</div>
                <div style="font-size:28px;font-weight:bold;color:${hpColor}">${curHP}</div>
                <div style="width:120px;height:6px;background:#333;border-radius:3px;margin-top:4px;">
                    <div style="width:${barWidth}%;height:100%;background:${hpColor};border-radius:3px;"></div>
                </div>`;
        }

        // ── Ammo HUD ──
        const curAmmo = ammo;
        const curWeaponId = weaponId;
        const curGrenades = grenades;
        if (curAmmo !== this._lastAmmo || isReloading !== this._lastReloading
            || isBolting !== this._lastBolting
            || curWeaponId !== this._lastWeaponId || curGrenades !== this._lastGrenades) {
            this._lastAmmo = curAmmo;
            this._lastReloading = isReloading;
            this._lastBolting = isBolting;
            this._lastWeaponId = curWeaponId;
            this._lastGrenades = curGrenades;

            const def = WeaponDefs[curWeaponId];
            const statusText = isReloading ? `<span style="color:#ffaa00">RELOADING...</span>`
                : isBolting ? `<span style="color:#ffaa00">BOLTING...</span>` : '';

            const grenadeText = `<div style="font-size:13px;color:#aaa;margin-top:6px">&#x1F4A3; ${curGrenades}</div>`;
            this.ammoHUD.innerHTML = `
                <div style="font-size:12px;color:#aaa;margin-bottom:4px">${def ? def.name : curWeaponId}</div>
                <div style="font-size:28px;font-weight:bold">
                    ${curAmmo}<span style="font-size:16px;color:#888"> / ${def ? def.magazineSize : 30}</span>
                </div>${statusText}${grenadeText}`;
        }
    }

    /**
     * Update reload indicator (SVG circle progress).
     * @param {number} dt - Delta time in seconds.
     * @param {Object} data - Reload state from caller.
     * @param {boolean} data.isReloading - Whether currently reloading.
     * @param {boolean} data.isBolting - Whether currently cycling bolt action.
     * @param {string} data.weaponId - Current weapon ID.
     * @param {boolean} data.isScoped - Whether currently scoped in.
     * @param {boolean} data.showCrosshair - Whether the crosshair should be visible when not reloading.
     */
    updateReloadIndicator(dt, { isReloading, isBolting, weaponId, isScoped, showCrosshair }) {
        const track = this._reloadTrack;
        let reloading = false;
        let progress = 0;

        if (isReloading) {
            if (!track.wasReloading) {
                track.elapsed = 0;
                track.wasReloading = true;
            }
            track.elapsed += dt;
            const def = WeaponDefs[weaponId];
            const duration = def ? def.reloadTime : 2;
            progress = Math.min(1, track.elapsed / duration);
            reloading = true;
        } else if (isBolting) {
            if (!track.wasBolting) {
                track.elapsed = 0;
                track.wasBolting = true;
            }
            track.elapsed += dt;
            const def = WeaponDefs[weaponId];
            const duration = def ? (def.boltTime || 1) : 1;
            progress = Math.min(1, track.elapsed / duration);
            reloading = true;
        } else {
            track.wasReloading = false;
            track.wasBolting = false;
            track.elapsed = 0;
        }

        if (reloading) {
            this.crosshair.style.display = 'none';
            this.reloadIndicator.style.display = 'block';
            if (!this._reloadArc) this._reloadArc = document.getElementById('reload-arc');
            const circ = 100.53;
            this._reloadArc.setAttribute('stroke-dashoffset', circ * (1 - progress));
        } else {
            this.reloadIndicator.style.display = 'none';
            // Restore crosshair based on caller state
            this.crosshair.style.display = (!isScoped && showCrosshair) ? 'block' : 'none';
        }
    }

    /**
     * Show hit marker with type-dependent color and scale.
     * @param {'hit'|'kill'|'headshot_kill'} type
     */
    showHitMarker(type = 'hit') {
        const color = type === 'headshot_kill' ? '#ffd700'
            : type === 'kill' ? '#ff4444' : '#ffffff';
        this._hitMarkerDuration = type === 'headshot_kill' ? 0.35
            : type === 'kill' ? 0.30 : 0.15;
        this._hitMarkerTimer = this._hitMarkerDuration;

        for (const line of this._hitMarkerLines) {
            line.setAttribute('stroke', color);
        }
        this._hitMarkerScale = (type === 'kill' || type === 'headshot_kill') ? 1.6 : 1;

        this._hitMarker.style.display = 'block';
        this._hitMarker.style.opacity = '1';
        this._hitMarker.style.transform = `translate(-50%,-50%) rotate(45deg) scale(${this._hitMarkerScale})`;
    }

    /**
     * Animate hit marker fade / shrink each frame.
     * @param {number} dt - Delta time in seconds.
     */
    updateHitMarker(dt) {
        if (this._hitMarkerTimer > 0) {
            this._hitMarkerTimer -= dt;
            if (this._hitMarkerTimer <= 0) {
                this._hitMarker.style.display = 'none';
            } else {
                this._hitMarker.style.opacity = String(Math.min(1, this._hitMarkerTimer / 0.08));
                if (this._hitMarkerScale > 1) {
                    this._hitMarkerScale = Math.max(1, this._hitMarkerScale - dt * 6);
                    this._hitMarker.style.transform = `translate(-50%,-50%) rotate(45deg) scale(${this._hitMarkerScale})`;
                }
            }
        }
    }

    /**
     * Show directional damage indicator.
     * @param {number} dirX - Attack direction X component.
     * @param {number} dirZ - Attack direction Z component.
     * @param {number} timer - Duration to show the indicator.
     * @param {number} playerYaw - Current player yaw for relative angle calculation.
     */
    showDamageDirection(dirX, dirZ, timer, playerYaw) {
        if (!this._dmgIndicator) return;
        const attackAngle = Math.atan2(dirX, -dirZ);
        const relAngle = attackAngle - playerYaw;
        const gradAngle = (-relAngle * 180 / Math.PI + 90);
        const opacity = Math.min(1, timer) * 0.6;

        this._dmgIndicator.style.background = `linear-gradient(${gradAngle}deg,
            rgba(255,0,0,${opacity}) 0%, transparent 30%, transparent 100%)`;
        this._dmgIndicator.style.opacity = '1';
        this._dmgIndicatorTimer = timer;
    }

    /**
     * Fade out the damage indicator over time.
     * @param {number} dt - Delta time in seconds.
     */
    updateDamageIndicator(dt) {
        if (this._dmgIndicatorTimer > 0) {
            this._dmgIndicatorTimer -= dt;
            if (this._dmgIndicatorTimer <= 0) {
                this._dmgIndicator.style.background = 'none';
            }
        }
    }

    /**
     * Record a kill for the kill banner (streak tracking + display).
     * @param {boolean} isHeadshot - Whether the kill was a headshot.
     */
    recordKill(isHeadshot) {
        this._streakCount++;
        this._streakTimer = 4;

        let text, color, isStreak;
        if (this._streakCount >= 2) {
            const labels = ['', '', 'DOUBLE KILL', 'TRIPLE KILL', 'MULTI KILL', 'RAMPAGE'];
            text = this._streakCount >= labels.length
                ? 'RAMPAGE' : labels[this._streakCount];
            color = '#ffd700';
            isStreak = true;
        } else {
            text = isHeadshot ? 'HEADSHOT' : 'ELIMINATED';
            color = isHeadshot ? '#ffd700' : '#ffffff';
            isStreak = false;
        }

        this._killBannerText.textContent = text;
        this._killBannerText.style.color = color;
        this._killBannerTimer = isStreak ? 2 : 1.5;
        this._killBannerFadeOut = false;

        if (isStreak) {
            this._killBannerEl.style.transition = 'transform 0.2s cubic-bezier(0.34,1.56,0.64,1), opacity 0.15s ease-out';
            this._killBannerEl.style.fontSize = '28px';
            this._killBannerEl.style.display = 'block';
            this._killBannerEl.style.opacity = '1';
            this._killBannerEl.style.transform = 'translateX(-50%) scale(0.5)';
            this._killBannerEl.offsetHeight; // reflow
            this._killBannerEl.style.transform = 'translateX(-50%) scale(1)';
        } else {
            this._killBannerEl.style.transition = 'opacity 0.15s ease-out, transform 0.15s ease-out';
            this._killBannerEl.style.fontSize = '18px';
            this._killBannerEl.style.display = 'block';
            this._killBannerEl.style.opacity = '0';
            this._killBannerEl.style.transform = 'translateX(-50%) translateY(8px)';
            this._killBannerEl.offsetHeight; // reflow
            this._killBannerEl.style.opacity = '1';
            this._killBannerEl.style.transform = 'translateX(-50%) translateY(0)';
        }
    }

    /**
     * Show a flag capture/lost banner.
     * @param {string} text - Banner text (e.g. "FLAG CAPTURED").
     * @param {string} color - CSS color for the text.
     */
    showFlagBanner(text, color) {
        this._flagBannerTextEl.textContent = text;
        this._flagBannerTextEl.style.color = color;
        this._flagBannerTimer = 2.0;
        this._flagBannerFadeOut = false;

        this._flagBannerEl.style.transition = 'opacity 0.15s ease-out, transform 0.15s ease-out';
        this._flagBannerEl.style.display = 'block';
        this._flagBannerEl.style.opacity = '0';
        this._flagBannerEl.style.transform = 'translateX(-50%) translateY(-8px)';
        this._flagBannerEl.offsetHeight; // reflow
        this._flagBannerEl.style.opacity = '1';
        this._flagBannerEl.style.transform = 'translateX(-50%) translateY(0)';
    }

    /**
     * Tick the kill banner timer (streak window + fade out).
     * @param {number} dt - Delta time in seconds.
     */
    updateKillBannerTimer(dt) {
        // Streak window countdown
        if (this._streakTimer > 0) {
            this._streakTimer -= dt;
            if (this._streakTimer <= 0) {
                this._streakCount = 0;
            }
        }
        if (this._killBannerTimer <= 0) return;
        this._killBannerTimer -= dt;
        if (this._killBannerTimer <= 0.3 && !this._killBannerFadeOut) {
            this._killBannerFadeOut = true;
            this._killBannerEl.style.opacity = '0';
            this._killBannerEl.style.transform = 'translateX(-50%) translateY(-8px)';
        }
        if (this._killBannerTimer <= 0) {
            this._killBannerEl.style.display = 'none';
            this._killBannerTimer = 0;
        }
    }

    /**
     * Tick the flag banner timer (fade out).
     * @param {number} dt - Delta time in seconds.
     */
    updateFlagBannerTimer(dt) {
        if (this._flagBannerTimer <= 0) return;
        this._flagBannerTimer -= dt;
        if (this._flagBannerTimer <= 0.3 && !this._flagBannerFadeOut) {
            this._flagBannerFadeOut = true;
            this._flagBannerEl.style.opacity = '0';
            this._flagBannerEl.style.transform = 'translateX(-50%) translateY(-8px)';
        }
        if (this._flagBannerTimer <= 0) {
            this._flagBannerEl.style.display = 'none';
            this._flagBannerTimer = 0;
        }
    }

    // ═══════════════════════════════════════════════════════
    // Score + Ping display
    // ═══════════════════════════════════════════════════════

    /**
     * Update the score HUD with current team scores and flag counts.
     * @param {number} scoreA - Team A score.
     * @param {number} scoreB - Team B score.
     * @param {number} flagsA - Number of flags held by Team A.
     * @param {number} flagsB - Number of flags held by Team B.
     */
    updateScores(scoreA, scoreB, flagsA, flagsB) {
        this._scoreA.textContent = scoreA;
        this._scoreB.textContent = scoreB;
        this._flagCountA.textContent = flagsA;
        this._flagCountB.textContent = flagsB;
    }

    /**
     * Update the ping display.
     * @param {number} rtt - Round-trip time in milliseconds.
     */
    updatePing(rtt) {
        this._pingDisplay.textContent = `PING: ${rtt}ms`;
        this._pingDisplay.style.color = rtt < 30 ? 'rgba(100,255,100,0.6)'
            : rtt < 80 ? 'rgba(255,255,100,0.6)' : 'rgba(255,100,100,0.6)';
    }

    // ═══════════════════════════════════════════════════════
    // Helper methods
    // ═══════════════════════════════════════════════════════

    /** Reset dirty-check caches so HUD refreshes on next frame. */
    resetCache() {
        this._lastHP = undefined;
        this._lastAmmo = undefined;
        this._lastWeaponId = undefined;
        this._lastReloading = undefined;
        this._lastBolting = undefined;
        this._lastGrenades = undefined;
        this._reloadTrack.wasReloading = false;
        this._reloadTrack.wasBolting = false;
        this._reloadTrack.elapsed = 0;
    }

    /** Hide all playing-mode HUD elements. */
    hidePlayingHUD() {
        this.crosshair.style.display = 'none';
        this.healthHUD.style.display = 'none';
        this.ammoHUD.style.display = 'none';
        this.reloadIndicator.style.display = 'none';
        if (this.scopeVignette) this.scopeVignette.style.display = 'none';
    }
}
