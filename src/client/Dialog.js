/**
 * A single modal message dialog, shared by anything that needs to stop the
 * player and tell them something — join rejections today.
 *
 * Styling lives in an injected stylesheet rather than inline attributes so the
 * look is defined once and reused, following the same pattern as TouchControls.
 * The panel treatment is borrowed from the scoreboard overlay (translucent,
 * blurred, hairline border) and the button from the join panel, so a dialog
 * reads as part of the same UI wherever it appears.
 *
 * Only one dialog exists at a time, so the open dialog's state lives at module
 * scope; opening a second one replaces the first.
 */

const STYLE_ID = 'ui-dialog-style';
const DIALOG_ID = 'ui-dialog';

let _keyHandler = null;
let _onDismiss = null;

function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
.ui-dialog-overlay {
    position: fixed; inset: 0; z-index: 250;
    background: rgba(0,0,0,0.6);
    display: flex; align-items: center; justify-content: center;
    font-family: Arial, sans-serif;
}
.ui-dialog {
    background: rgba(0,0,0,0.8);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 10px;
    backdrop-filter: blur(4px);
    padding: 24px 32px;
    display: flex; flex-direction: column; align-items: center; gap: 12px;
    min-width: 300px; max-width: min(90vw, 420px);
    text-align: center;
}
.ui-dialog-title   { color: #fff;     font-size: 22px; font-weight: bold; }
.ui-dialog-message { color: #ff4444;  font-size: 15px; font-weight: bold; }

/* Matches the join panel's primary button */
.ui-btn-primary {
    padding: 8px 32px;
    font-size: 16px; font-weight: bold; font-family: inherit;
    border: 2px solid #4488ff; border-radius: 4px;
    background: rgba(68,136,255,0.3); color: #fff;
    cursor: pointer;
    transition: background 0.15s;
}
.ui-btn-primary:hover { background: rgba(68,136,255,0.45); }

/* Landscape phones have ~390px of height — give the dialog less of it */
@media (max-height: 480px) {
    .ui-dialog { padding: 16px 24px; gap: 9px; min-width: 260px; }
    .ui-dialog-title   { font-size: 18px; }
    .ui-dialog-message { font-size: 14px; }
    .ui-btn-primary    { padding: 6px 26px; font-size: 15px; }
}`;
    document.head.appendChild(style);
}

/** True while a dialog is up — it owns Escape, so other handlers should stand down. */
export function isDialogOpen() {
    return !!document.getElementById(DIALOG_ID);
}

/**
 * Show a modal message over everything else.
 *
 * @param {object} options
 * @param {string} options.title
 * @param {string} options.message
 * @param {string} [options.confirmLabel='OK']
 * @param {() => void} [options.onDismiss] - run after the dialog closes
 */
export function showDialog({ title, message, confirmLabel = 'OK', onDismiss }) {
    dismissDialog();
    injectStyle();
    _onDismiss = onDismiss ?? null;

    const overlay = document.createElement('div');
    overlay.id = DIALOG_ID;
    overlay.className = 'ui-dialog-overlay';
    overlay.innerHTML = `
        <div class="ui-dialog">
            <div class="ui-dialog-title"></div>
            <div class="ui-dialog-message"></div>
            <button class="ui-btn-primary" type="button"></button>
        </div>`;

    // Text via textContent — messages come from the server and never go near an
    // HTML parser.
    overlay.querySelector('.ui-dialog-title').textContent = title;
    overlay.querySelector('.ui-dialog-message').textContent = message;
    const okBtn = overlay.querySelector('.ui-btn-primary');
    okBtn.textContent = confirmLabel;

    document.body.appendChild(overlay);

    okBtn.addEventListener('click', dismissDialog);
    // The backdrop dismisses; a click inside the panel must not
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) dismissDialog();
    });
    okBtn.focus();

    _keyHandler = (e) => {
        if (e.code === 'Escape' || e.code === 'Enter' || e.code === 'Space') {
            e.preventDefault();
            dismissDialog();
        }
    };
    document.addEventListener('keydown', _keyHandler);
}

/** Close the dialog and hand the keyboard back. Safe to call when none is open. */
export function dismissDialog() {
    if (_keyHandler) {
        document.removeEventListener('keydown', _keyHandler);
        _keyHandler = null;
    }
    const overlay = document.getElementById(DIALOG_ID);
    overlay?.remove();

    const callback = _onDismiss;
    _onDismiss = null;
    if (overlay) callback?.();
}
