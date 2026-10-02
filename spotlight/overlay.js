/**
 * Spotlight Overlay - Content script implementation of command bar interface
 * 
 * Purpose: Primary spotlight implementation injected into web pages as content script
 * Key Functions: Real-time search across tabs/bookmarks/history, instant suggestions, keyboard navigation
 * Architecture: Self-contained IIFE bundle with embedded UI and shared spotlight modules
 * 
 * Critical Notes:
 * - Injected by background script with automatic popup fallback for restricted URLs
 * - Bundled as single file via Vite for content script compatibility (no ES6 imports)
 * - Only injected on-demand for privacy - no persistent content script presence
 * - Uses modal dialog with backdrop blur for non-intrusive overlay experience
 * - Handles URL prefill, tab ID injection, and optimized navigation for current-tab mode
 */

import { SpotlightUtils } from './shared/ui-utilities.js';
import { SpotlightMessageClient } from './shared/message-client.js';
import { SpotlightTabMode } from './shared/search-types.js';
import {
    getSpotlightMarkup,
    mountSpotlightController
} from './shared/spotlight-controller.js';
import { Logger } from '../logger.js';

// The Spotlight UI lives in a closed shadow root, so page scripts cannot read
// the open tabs, bookmarks and history that it shows.
const SPOTLIGHT_HOST_ID = 'arcify-spotlight-host';
let spotlightDialog = null;

// Reinjection after an extension reload must not invoke handlers from the old,
// invalidated content-script context.
document.getElementById(SPOTLIGHT_HOST_ID)?.remove();

const pinnedNavigationGuard = window.arcifyPinnedNavigationGuard || {
    enabled: false,
    pinnedUrl: null,
    pinnedOrigin: null
};
window.arcifyPinnedNavigationGuard = pinnedNavigationGuard;

function setPinnedNavigationGuardState(nextState = {}) {
    pinnedNavigationGuard.enabled = Boolean(nextState.enabled && nextState.pinnedUrl && nextState.pinnedOrigin);
    pinnedNavigationGuard.pinnedUrl = nextState.pinnedUrl || null;
    pinnedNavigationGuard.pinnedOrigin = nextState.pinnedOrigin || null;
}

function isSupportedGuardUrl(url) {
    return typeof url === 'string' && /^(https?:)?\/\//i.test(url);
}

function isTabSwitcherModifierRelease(event) {
    return (event.key === 'Alt' || event.code === 'AltLeft' || event.code === 'AltRight')
        && !event.altKey;
}

if (!window.arcifyTabSwitcherKeyListenerInstalled) {
    window.arcifyTabSwitcherKeyListenerInstalled = true;
    window.addEventListener('keyup', (event) => {
        if (!isTabSwitcherModifierRelease(event)) {
            return;
        }

        chrome.runtime.sendMessage({ action: 'tabSwitcherKeyUp' }).catch(() => {});
    }, true);
}

function shouldIgnoreGuardedClick(event, anchor) {
    if (!anchor) return true;
    if (event.defaultPrevented || event.button !== 0) return true;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return true;
    if (anchor.target && anchor.target !== '_self') return true;
    if (anchor.hasAttribute('download')) return true;
    return false;
}

function shouldOpenLinkOutsidePinnedTab(destinationUrl) {
    if (!pinnedNavigationGuard.enabled || !pinnedNavigationGuard.pinnedOrigin || !isSupportedGuardUrl(destinationUrl)) {
        return false;
    }

    try {
        return new URL(destinationUrl, window.location.href).origin !== pinnedNavigationGuard.pinnedOrigin;
    } catch {
        return false;
    }
}

async function syncPinnedNavigationGuardState() {
    try {
        const response = await chrome.runtime.sendMessage({ action: 'getPinnedNavigationGuardState' });
        if (response?.success) {
            setPinnedNavigationGuardState(response);
        }
    } catch (error) {
        Logger.log('[PinnedNavigationGuard] Failed to sync state:', error);
    }
}

async function handlePinnedNavigationClick(event) {
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (shouldIgnoreGuardedClick(event, anchor)) {
        return;
    }

    const href = anchor.href;
    if (!shouldOpenLinkOutsidePinnedTab(href)) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();

    try {
        await chrome.runtime.sendMessage({
            action: 'openPinnedNavigationLink',
            url: href
        });
    } catch (error) {
        Logger.log('[PinnedNavigationGuard] Failed to open outbound link in new tab:', error);
        window.location.href = href;
    }
}

if (window.arcifyPinnedNavigationClickListener) {
    try {
        document.removeEventListener('click', window.arcifyPinnedNavigationClickListener, true);
    } catch {
        // A listener from an invalidated extension context can be discarded.
    }
}
window.arcifyPinnedNavigationClickListener = handlePinnedNavigationClick;
document.addEventListener('click', handlePinnedNavigationClick, true);

/**
 * DORMANT CONTENT SCRIPT ARCHITECTURE
 * 
 * Problem: Traditional script injection via chrome.scripting.executeScript() causes 1-2s delays
 * on slow-loading pages because it waits for the page's resources to load before injection.
 * 
 * Solution: Pre-inject spotlight as a dormant content script that loads immediately when the
 * page starts (document_start), then activate it instantly via messaging when needed.
 * 
 * Benefits:
 * - Eliminates injection delay: 1-2s → 50-100ms (20-40x faster)
 * - No blocking on page load resources (images, stylesheets, etc.)
 * - Instant activation via lightweight message passing
 * - Graceful fallback to legacy injection for compatibility
 */

function handleArcifyRuntimeMessage(message, sender, sendResponse) {
    if (message.action === 'activateSpotlight') {
        window.arcifySpotlightTabMode = message.mode;
        window.arcifyCurrentTabUrl = message.tabUrl;
        window.arcifyCurrentTabId = message.tabId;

        void activateSpotlight(message.mode)
            .then(() => sendResponse({ success: true }))
            .catch((error) => {
                Logger.error('[Spotlight] Activation failed:', error);
                sendResponse({
                    success: false,
                    error: error instanceof Error ? error.message : String(error)
                });
            });
        return true;
    } else if (message.action === 'updatePinnedNavigationGuard') {
        setPinnedNavigationGuardState(message);
        sendResponse({ success: true });
    } else if (message.action === 'spotlightRelayKey') {
        if (!window.arcifySpotlightRelayKey) return false;
        window.arcifySpotlightRelayKey(message.keyEvent);
        sendResponse({ success: true });
    }
    return false;
}

if (window.arcifyRuntimeMessageListener) {
    try {
        chrome.runtime.onMessage.removeListener(window.arcifyRuntimeMessageListener);
    } catch {
        // A listener from an invalidated extension context can be discarded.
    }
}
window.arcifyRuntimeMessageListener = handleArcifyRuntimeMessage;
chrome.runtime.onMessage.addListener(handleArcifyRuntimeMessage);

syncPinnedNavigationGuardState();

// Main spotlight activation function
async function activateSpotlight(spotlightTabMode = 'current-tab') {

    // Handle toggle functionality for existing spotlight
    const existingDialog = spotlightDialog?.isConnected ? spotlightDialog : null;
    if (existingDialog) {
        if (existingDialog.open) {
            existingDialog.close();
            return;
        }
        document.getElementById(SPOTLIGHT_HOST_ID)?.remove();
        spotlightDialog = null;
        window.arcifySpotlightInjected = false;
        window.arcifySpotlightRelayKey = null;
    }

    // Mark as injected only when creating new dialog
    window.arcifySpotlightInjected = true;

    const accentColorDefinitions = SpotlightUtils.getAccentColorCSS();
    const spotlightCSS = `
        ${accentColorDefinitions}
        
        /* Smooth transitions for color changes */
        :host {
            transition: --spotlight-accent-color 0.3s ease,
                       --spotlight-accent-color-15 0.3s ease,
                       --spotlight-accent-color-20 0.3s ease,
                       --spotlight-accent-color-80 0.3s ease;
        }
        
        #arcify-spotlight-dialog {
            margin: 0;
            position: fixed;
            /* Not fully centered but this looks better than 50vh */
            top: calc(35vh);
            left: 50%;
            transform: translateX(-50%);
            border: none;
            padding: 0;
            background: transparent;
            border-radius: 12px;
            width: 650px;
            max-width: 90vw;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
        }

        #arcify-spotlight-dialog::backdrop {
            background: transparent;
        }

        .arcify-spotlight-container {
            background: #2D2D2D;
            border-radius: 12px;
            border: 1px solid rgba(255, 255, 255, 0.1);
            padding: 0;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            color: #ffffff;
            position: relative;
            overflow: hidden;
        }

        #arcify-spotlight-dialog .arcify-spotlight-input-wrapper {
            display: flex;
            align-items: center;
            padding: 12px 24px 12px 20px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        }

        #arcify-spotlight-dialog .arcify-spotlight-search-icon {
            width: 20px;
            height: 20px;
            margin-right: 12px;
            opacity: 0.6;
            flex-shrink: 0;
        }

        /* 
            Specific CSS directives to override styling on specific pages (stackoverflow, chrome docs).
            Otherwise the spotlight bar has a white background and some other weird UI.
        */
        #arcify-spotlight-dialog .arcify-spotlight-input {
            flex: 1 !important;
            background: transparent !important;
            background-color: transparent !important;
            background-image: none !important;
            border: none !important;
            border-style: none !important;
            border-width: 0 !important;
            border-color: transparent !important;
            color: #ffffff !important;
            font-size: 18px !important;
            line-height: 24px !important;
            padding: 8px 0 !important;
            margin: 0 !important;
            outline: none !important;
            outline-style: none !important;
            outline-width: 0 !important;
            font-weight: 400 !important;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
            box-shadow: none !important;
            border-radius: 0 !important;
            appearance: none !important;
            -webkit-appearance: none !important;
            -moz-appearance: none !important;
            text-indent: 0 !important;
            text-shadow: none !important;
            vertical-align: baseline !important;
            text-decoration: none !important;
            box-sizing: border-box !important;
        }

        #arcify-spotlight-dialog .arcify-spotlight-input::placeholder {
            color: rgba(255, 255, 255, 0.5) !important;
            opacity: 1 !important;
        }

        #arcify-spotlight-dialog .arcify-spotlight-input:focus {
            outline: none !important;
            outline-style: none !important;
            outline-width: 0 !important;
            border: none !important;
            box-shadow: none !important;
            background: transparent !important;
            background-color: transparent !important;
        }

        .arcify-spotlight-results {
            max-height: 270px;
            overflow-y: auto;
            padding: 8px 0;
            scroll-behavior: smooth;
            scrollbar-width: none; /* Firefox */
            -ms-overflow-style: none; /* IE and Edge */
        }

        .arcify-spotlight-results::-webkit-scrollbar {
            display: none; /* Chrome, Safari and Opera */
        }

        .arcify-spotlight-result-item {
            display: flex;
            align-items: center;
            padding: 12px 24px 12px 20px;
            min-height: 44px;
            cursor: pointer;
            transition: background-color 0.15s ease;
            border: none;
            background: none;
            width: 100%;
            text-align: left;
            color: inherit;
            font-family: inherit;
        }

        .arcify-spotlight-result-item:hover,
        .arcify-spotlight-result-item:focus {
            background: var(--spotlight-accent-color-15);
            outline: none;
        }

        .arcify-spotlight-result-item.selected {
            background: var(--spotlight-accent-color-20);
        }

        .arcify-spotlight-result-favicon {
            width: 20px;
            height: 20px;
            margin-right: 12px;
            border-radius: 4px;
            flex-shrink: 0;
        }

        .arcify-spotlight-result-content {
            flex: 1;
            min-width: 0;
            min-height: 32px;
            display: flex;
            flex-direction: column;
            justify-content: center;
        }

        .arcify-spotlight-result-title {
            font-size: 14px;
            font-weight: 500;
            color: #ffffff;
            margin: 0 0 2px 0;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .arcify-spotlight-result-url {
            font-size: 12px;
            color: rgba(255, 255, 255, 0.6);
            margin: 0;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .arcify-spotlight-result-url:empty {
            display: none;
        }

        .arcify-spotlight-result-action {
            font-size: 12px;
            color: var(--spotlight-accent-color-80);
            margin-left: 12px;
            flex-shrink: 0;
        }

        .arcify-spotlight-loading {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 24px;
            color: rgba(255, 255, 255, 0.6);
        }

        .arcify-spotlight-empty {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 24px;
            color: rgba(255, 255, 255, 0.6);
            font-size: 14px;
        }

        #arcify-spotlight-dialog {
            animation: arcify-spotlight-show 0.2s ease-out;
        }

        @keyframes arcify-spotlight-show {
            from {
                opacity: 0;
                transform: translateX(-50%) scale(0.95);
            }
            to {
                opacity: 1;
                transform: translateX(-50%) scale(1);
            }
        }

        @media (max-width: 640px) {
            #arcify-spotlight-dialog {
                width: 95vw;
                margin: 20px auto;
            }
            
            #arcify-spotlight-dialog .arcify-spotlight-input {
                font-size: 16px !important;
            }
        }
    `;

    const host = document.createElement('div');
    host.id = SPOTLIGHT_HOST_ID;
    const shadowRoot = host.attachShadow({ mode: 'closed' });
    // Outside the shadow root these events target the host div, not an input, so
    // site shortcut and paste handlers would act on them. Spotlight's own handlers
    // inside the shadow root have already run when the event reaches the host.
    for (const type of [
        'keydown', 'keypress', 'keyup', 'beforeinput', 'input',
        'paste', 'copy', 'cut', 'compositionstart', 'compositionupdate', 'compositionend'
    ]) {
        host.addEventListener(type, event => event.stopPropagation());
    }

    const styleSheet = document.createElement('style');
    styleSheet.textContent = spotlightCSS;
    shadowRoot.appendChild(styleSheet);

    // Create spotlight dialog
    const dialog = document.createElement('dialog');
    dialog.id = 'arcify-spotlight-dialog';

    dialog.innerHTML = `
        <div class="arcify-spotlight-container">
            ${getSpotlightMarkup('Search or enter URL...')}
        </div>
    `;

    shadowRoot.appendChild(dialog);
    document.body.appendChild(host);
    spotlightDialog = dialog;
    const mode = spotlightTabMode === SpotlightTabMode.NEW_TAB
        ? SpotlightTabMode.NEW_TAB
        : SpotlightTabMode.CURRENT_TAB;
    const initialValue = mode === SpotlightTabMode.CURRENT_TAB
        ? window.arcifyCurrentTabUrl || ''
        : '';

    let closing = false;
    let removeGlobalCloseListener = () => {};
    function closeSpotlight() {
        if (closing) return;
        closing = true;
        removeGlobalCloseListener();
        if (dialog.open) dialog.close();
        SpotlightMessageClient.notifyClosed();
        host.remove();
        if (spotlightDialog === dialog) spotlightDialog = null;
        window.arcifySpotlightInjected = false;
    }

    // Handle backdrop clicks
    dialog.addEventListener('click', (e) => {
        if (e.target === dialog) {
            closeSpotlight();
        }
    });

    dialog.addEventListener('close', closeSpotlight);

    // Listen for global close messages from background script
    removeGlobalCloseListener = SpotlightMessageClient.setupGlobalCloseListener(() => {
        if (dialog.isConnected && dialog.open) {
            closeSpotlight();
        }
    });

    // Show dialog and focus input
    dialog.showModal();

    // Notify background that spotlight opened in this tab
    SpotlightMessageClient.notifyOpened();

    const controller = mountSpotlightController({
        root: dialog,
        mode,
        initialValue,
        onBeforeAction: closeSpotlight,
        onEscape: closeSpotlight
    });
    window.arcifySpotlightRelayKey = controller.relayKey;
}
