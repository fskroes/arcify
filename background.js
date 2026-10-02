/**
 * Background Service Worker (Manifest V3) - Core extension orchestrator
 * 
 * Purpose: Manages extension lifecycle, message passing, and system integrations
 * Key Functions: Spotlight injection/fallback, auto-archive system, tab activity tracking, Chrome API access
 * Architecture: Service worker that handles all Chrome API calls and coordinates between content scripts
 * 
 * Critical Notes:
 * - Only context with full Chrome API access (tabs, storage, search, etc.)
 * - Handles spotlight injection with automatic popup fallback for restricted URLs
 * - Manages tab activity tracking for auto-archive functionality
 * - All content script Chrome API requests must route through here via message passing
 */

import { Utils } from './utils.js';
import { SearchEngine } from './spotlight/shared/search-engine.js';
import { BackgroundDataProvider } from './spotlight/shared/data-providers/background-data-provider.js';
import { Logger } from './logger.js';
import { reconcileTabs } from './src/sidebar/reconcile.ts';

// Enum for spotlight tab modes
const SpotlightTabMode = {
    CURRENT_TAB: 'current-tab',
    NEW_TAB: 'new-tab'
};

// Create a single SearchEngine instance with BackgroundDataProvider
const backgroundSearchEngine = new SearchEngine(new BackgroundDataProvider());

function invalidateSpotlightSearchCache() {
    backgroundSearchEngine.cache.clear();
}

const AUTO_ARCHIVE_ALARM_NAME = 'autoArchiveTabsAlarm';
const TAB_ACTIVITY_STORAGE_KEY = 'tabLastActivity'; // Key to store timestamps
const TAB_SWITCHER_FALLBACK_TIMEOUT_MS = 3000;
const TAB_SWITCHER_SESSION_TIMEOUT_MS = TAB_SWITCHER_FALLBACK_TIMEOUT_MS;
const TAB_SWITCHER_HISTORY_LIMIT = 7;
let tabSwitcherSession = null;
let tabSwitcherModifierReleased = false;
const tabPreviewCache = new Map();
const pendingTabSwitcherHideTimers = new Map();

function getOrigin(url) {
    if (!url) return null;
    try {
        return new URL(url).origin;
    } catch {
        return null;
    }
}

async function getPinnedNavigationGuardStateForTab(tabId) {
    if (!tabId) {
        return { enabled: false, pinnedUrl: null, pinnedOrigin: null };
    }

    const pinnedState = await Utils.getPinnedTabState(tabId);
    const pinnedUrl = pinnedState?.pinnedUrl || null;
    const pinnedOrigin = getOrigin(pinnedUrl);

    return {
        enabled: Boolean(pinnedUrl && pinnedOrigin),
        pinnedUrl,
        pinnedOrigin
    };
}

async function sendPinnedNavigationGuardState(tabId) {
    if (!tabId) return;

    let tab = null;
    try {
        tab = await chrome.tabs.get(tabId);
    } catch {
        return;
    }

    if (!supportsContentScripts(tab?.url)) {
        return;
    }

    const message = {
        action: 'updatePinnedNavigationGuard',
        ...(await getPinnedNavigationGuardStateForTab(tabId))
    };

    try {
        const response = await chrome.tabs.sendMessage(tabId, message);
        if (response?.success) {
            return;
        }
    } catch {
        // Existing pages lose their content-script context when the extension reloads.
    }

    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            files: ['spotlight/overlay.js']
        });
        await chrome.tabs.sendMessage(tabId, message);
    } catch {
        // The page may reject content-script injection.
    }
}

async function openPinnedNavigationLink({ sourceTabId, url }) {
    if (!sourceTabId || !url) {
        throw new Error('Missing sourceTabId or url');
    }

    const sourceTab = await chrome.tabs.get(sourceTabId);
    const createdTab = await chrome.tabs.create({
        windowId: sourceTab.windowId,
        index: typeof sourceTab.index === 'number' ? sourceTab.index + 1 : undefined,
        openerTabId: sourceTabId,
        url,
        active: true
    });

    return { tabId: createdTab.id };
}

// Helper to handle async message responses with consistent error handling
function handleAsyncMessage(handler, sendResponse, errorContext, defaultErrorData = {}) {
    (async () => {
        try {
            const result = await handler();
            sendResponse({ success: true, ...result });
        } catch (error) {
            Logger.error(`[Background] Error ${errorContext}:`, error);
            sendResponse({ success: false, error: error.message, ...defaultErrorData });
        }
    })();
    return true; // Indicates async response
}

// Configure Chrome side panel behavior
chrome.sidePanel.setPanelBehavior({
    openPanelOnActionClick: true
}).catch(error => Logger.error(error));

// Listen for extension installation
chrome.runtime.onInstalled.addListener(async (details) => {
    if (details.reason === 'install') {
        // Check if onboarding has been completed before
        const result = await chrome.storage.sync.get(['onboardingCompleted']);
        if (!result.onboardingCompleted) {
            chrome.tabs.create({ url: 'installation-onboarding.html', active: true });
        }
    }

    if (chrome.contextMenus) {
        chrome.contextMenus.create({
            id: "openArcify",
            title: "Arcify",
            contexts: ["all"]
        });
    }
});

// Handle context menu clicks
if (chrome.contextMenus) {
    chrome.contextMenus.onClicked.addListener((info, tab) => {
        info.menuItemId === "openArcify" && chrome.sidePanel.open({
            windowId: tab.windowId
        })
    });
}

chrome.commands.onCommand.addListener(async function (command) {
    if (command === "recentTabSwitcher") {
        tabSwitcherModifierReleased = false;
        await switchRecentTab(1);
    } else if (command === "recentTabSwitcherPrevious") {
        tabSwitcherModifierReleased = false;
        await switchRecentTab(-1);
    } else if (command === "toggleSpotlightNewTab") {
        await injectSpotlightScript(SpotlightTabMode.NEW_TAB);
    } else if (command === "copyCurrentUrl") {
        await copyCurrentTabUrlWithFallback();
    } else if (command === "reloadExtension") {
        chrome.runtime.reload();
    }
});

function resetTabSwitcherSession() {
    if (tabSwitcherSession?.timeoutId) {
        clearTimeout(tabSwitcherSession.timeoutId);
    }
    tabSwitcherSession = null;
}

async function finishTabSwitcherSession(sourceTabId = null) {
    const sessionTabIds = tabSwitcherSession?.tabs?.map(tab => tab.id) || [];
    resetTabSwitcherSession();

    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabIds = [...new Set([
        ...sessionTabIds,
        sourceTabId,
        activeTab?.id
    ].filter(Boolean))];

    await Promise.all(tabIds.map(tabId => hideTabSwitcherOverlay(tabId)));
}

function scheduleTabSwitcherSessionReset() {
    if (!tabSwitcherSession) {
        return;
    }

    if (tabSwitcherSession.timeoutId) {
        clearTimeout(tabSwitcherSession.timeoutId);
    }

    tabSwitcherSession.timeoutId = setTimeout(() => {
        tabSwitcherSession = null;
    }, TAB_SWITCHER_SESSION_TIMEOUT_MS);
}

async function getRecentTabsForWindow(windowId, activeTabId) {
    const tabs = await chrome.tabs.query({ windowId });
    const storage = await chrome.storage.local.get([TAB_ACTIVITY_STORAGE_KEY]);
    const activityData = storage[TAB_ACTIVITY_STORAGE_KEY] || {};

    return tabs
        .filter(tab => tab.id && tab.url && tab.title)
        .sort((a, b) => {
            if (a.id === activeTabId) return -1;
            if (b.id === activeTabId) return 1;
            return (activityData[b.id] || 0) - (activityData[a.id] || 0);
        });
}

async function captureActiveTabPreview(windowId, activeTabId = null) {
    try {
        const resolvedActiveTabId = activeTabId ?? (await chrome.tabs.query({ active: true, windowId }))[0]?.id ?? null;
        if (resolvedActiveTabId) {
            await hideTabSwitcherOverlay(resolvedActiveTabId);
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
            format: 'jpeg',
            quality: 45
        });
        const [activeTab] = await chrome.tabs.query({ active: true, windowId });
        if (activeTab?.id && dataUrl) {
            tabPreviewCache.set(activeTab.id, dataUrl);
        }
    } catch (error) {
        Logger.log('[Background] Could not capture tab preview for switcher:', error);
    }
}

async function showTabSwitcherOverlay(targetTabId, tabs, selectedTabId) {
    const targetTab = tabs.find(tab => tab.id === targetTabId);
    if (!targetTab || !supportsContentScripts(targetTab.url)) {
        return;
    }

    const pendingHideTimer = pendingTabSwitcherHideTimers.get(targetTabId);
    if (pendingHideTimer) {
        clearTimeout(pendingHideTimer);
        pendingTabSwitcherHideTimers.delete(targetTabId);
    }

    const overlayTabs = tabs.slice(0, TAB_SWITCHER_HISTORY_LIMIT).map(tab => ({
        id: tab.id,
        title: tab.title,
        url: tab.url,
        favIconUrl: tab.favIconUrl || null,
        previewDataUrl: tabPreviewCache.get(tab.id) || null
    }));

    await chrome.scripting.executeScript({
        target: { tabId: targetTabId },
        func: (overlayItems, currentSelectedTabId, hideAfterMs) => {
                let container = document.getElementById('arcify-tab-switcher');
                if (!container) {
                    container = document.createElement('div');
                    container.id = 'arcify-tab-switcher';
                    container.style.cssText = `
                        position: fixed;
                        inset: 0;
                        pointer-events: none;
                        z-index: 2147483647;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                    `;
                    document.documentElement.appendChild(container);
                }

                const escapeHtml = (value = '') => value
                    .replaceAll('&', '&amp;')
                    .replaceAll('<', '&lt;')
                    .replaceAll('>', '&gt;')
                    .replaceAll('"', '&quot;')
                    .replaceAll("'", '&#39;');

                const cards = overlayItems.map(tab => {
                    const isSelected = tab.id === currentSelectedTabId;
                    const faviconUrl = tab.favIconUrl || `https://www.google.com/s2/favicons?domain=${encodeURIComponent(tab.url || '')}&sz=32`;
                    const previewMarkup = tab.previewDataUrl
                        ? `<div style="height: 108px; border-radius: 12px; overflow: hidden; background: #1f1f1f; margin-bottom: 10px;">
                                <img src="${tab.previewDataUrl}" alt="" style="width: 100%; height: 100%; object-fit: cover; display: block;">
                           </div>`
                        : `<div style="height: 108px; border-radius: 12px; background: linear-gradient(135deg, rgba(255,255,255,.08), rgba(255,255,255,.02)); margin-bottom: 10px; display:flex; align-items:center; justify-content:center;">
                                <img src="${faviconUrl}" alt="" style="width: 28px; height: 28px; border-radius: 8px; flex-shrink: 0;">
                           </div>`;
                    return `
                        <div style="
                            width: 220px;
                            border-radius: 18px;
                            padding: 12px;
                            background: ${isSelected ? 'rgba(56, 189, 248, 0.2)' : 'rgba(26, 26, 26, 0.92)'};
                            border: 1px solid ${isSelected ? 'rgba(56, 189, 248, 0.6)' : 'rgba(255,255,255,0.08)'};
                            box-shadow: ${isSelected ? '0 16px 40px rgba(14, 165, 233, 0.18)' : '0 12px 32px rgba(0,0,0,0.35)'};
                            color: white;
                            backdrop-filter: blur(18px);
                        ">
                            ${previewMarkup}
                            <div style="display:flex; align-items:center; gap: 10px;">
                                <img src="${faviconUrl}" alt="" style="width:16px; height:16px; border-radius:4px; flex-shrink:0;">
                                <div style="min-width:0;">
                                    <div style="font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(tab.title || 'Untitled')}</div>
                                    <div style="font-size: 11px; color: rgba(255,255,255,.65); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(tab.url || '')}</div>
                                </div>
                            </div>
                        </div>
                    `;
                }).join('');

                container.innerHTML = `
                    <div style="
                        display:flex;
                        gap: 14px;
                        align-items: stretch;
                        justify-content: center;
                        max-width: min(92vw, 1120px);
                        padding: 18px;
                    ">
                        ${cards}
                    </div>
                `;

                if (window.arcifyTabSwitcherHideTimer) {
                    clearTimeout(window.arcifyTabSwitcherHideTimer);
                }

                window.arcifyTabSwitcherHideTimer = setTimeout(() => {
                    document.getElementById('arcify-tab-switcher')?.remove();
                    window.arcifyTabSwitcherHideTimer = null;
                }, hideAfterMs);
        },
        args: [overlayTabs, selectedTabId, TAB_SWITCHER_FALLBACK_TIMEOUT_MS]
    });
}

async function showTabSwitcherOverlayWithRetry(tabId, tabs, selectedTabId, retries = 2) {
    if (!tabId) {
        return;
    }

    try {
        await showTabSwitcherOverlay(tabId, tabs, selectedTabId);
    } catch (error) {
        if (retries <= 0) {
            throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 120));
        await showTabSwitcherOverlayWithRetry(tabId, tabs, selectedTabId, retries - 1);
    }
}

async function hideTabSwitcherOverlay(tabId) {
    if (!tabId) {
        return;
    }

    const pendingHideTimer = pendingTabSwitcherHideTimers.get(tabId);
    if (pendingHideTimer) {
        clearTimeout(pendingHideTimer);
        pendingTabSwitcherHideTimers.delete(tabId);
    }

    try {
        const tab = await chrome.tabs.get(tabId);
        if (!supportsContentScripts(tab?.url)) {
            return;
        }
        await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
                if (window.arcifyTabSwitcherHideTimer) {
                    clearTimeout(window.arcifyTabSwitcherHideTimer);
                    window.arcifyTabSwitcherHideTimer = null;
                }
                document.getElementById('arcify-tab-switcher')?.remove();
            }
        });
    } catch (error) {
        Logger.log('[Background] Could not hide tab switcher overlay:', error);
    }
}

async function switchRecentTab(step = 1) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab?.id || !activeTab.windowId) {
        return;
    }

    await captureActiveTabPreview(activeTab.windowId, activeTab.id);

    let sessionTabs = tabSwitcherSession?.tabs || null;
    if (!tabSwitcherSession || tabSwitcherSession.windowId !== activeTab.windowId) {
        sessionTabs = (await getRecentTabsForWindow(activeTab.windowId, activeTab.id))
            .slice(0, TAB_SWITCHER_HISTORY_LIMIT);
        if (sessionTabs.length < 2) {
            return;
        }

        tabSwitcherSession = {
            windowId: activeTab.windowId,
            tabs: sessionTabs,
            currentIndex: step > 0 ? 1 : sessionTabs.length - 1,
            timeoutId: null
        };
    } else {
        sessionTabs = tabSwitcherSession.tabs || [];
        if (sessionTabs.length < 2) {
            resetTabSwitcherSession();
            return;
        }
        tabSwitcherSession.currentIndex =
            (tabSwitcherSession.currentIndex + step + sessionTabs.length) % sessionTabs.length;
    }

    scheduleTabSwitcherSessionReset();

    const targetTabId = tabSwitcherSession.tabs[tabSwitcherSession.currentIndex]?.id;
    const targetTab = sessionTabs.find(tab => tab.id === targetTabId);
    if (!targetTab) {
        return;
    }

    await showTabSwitcherOverlayWithRetry(activeTab.id, sessionTabs, targetTab.id);
    await chrome.tabs.update(targetTab.id, { active: true });
    await chrome.windows.update(targetTab.windowId, { focused: true });
    await new Promise(resolve => setTimeout(resolve, 80));
    await showTabSwitcherOverlayWithRetry(targetTab.id, sessionTabs, targetTab.id);
    if (activeTab.id !== targetTab.id) {
        const hideTimer = setTimeout(() => {
            pendingTabSwitcherHideTimers.delete(activeTab.id);
            hideTabSwitcherOverlay(activeTab.id);
        }, 150);
        pendingTabSwitcherHideTimers.set(activeTab.id, hideTimer);
    }

    // Option can be released while the asynchronous tab switch is still in
    // progress. Finish the session here as well so that release is not lost.
    if (tabSwitcherModifierReleased) {
        await finishTabSwitcherSession();
    }
}

// Track tabs that have spotlight open for efficient closing.
// Mainly used to close spotlight overlays in all tabs when it's
// closed in 1 / user switches to another tab with overlay open.
const spotlightOpenTabs = new Set();

// Close spotlight in tracked tabs only
async function closeSpotlightInTrackedTabs(excludedTabId = null) {
    try {
        const tabIds = Array.from(spotlightOpenTabs).filter(
            tabId => tabId !== excludedTabId
        );
        const closePromises = tabIds.map(tabId =>
            chrome.tabs.sendMessage(tabId, { action: 'closeSpotlight' })
                .catch(() => {})
                .finally(() => spotlightOpenTabs.delete(tabId))
        );
        await Promise.all(closePromises);
    } catch (error) {
        Logger.error('[Background] Error closing spotlight in tracked tabs:', error);
    }
}

/**
 * PERFORMANCE-OPTIMIZED SPOTLIGHT ACTIVATION
 * 
 * Primary Strategy: Fast messaging to dormant content script
 * - Content script pre-loaded on all pages at document_start
 * - Instant activation via chrome.tabs.sendMessage() (~50-100ms)
 * - No waiting for page resources or script injection
 * 
 * Fallback Strategy: Legacy script injection
 * - Used when messaging fails (content script not ready, restricted URLs)
 * - Chrome.scripting.executeScript() with variable setup + script injection
 * - Slower but reliable fallback for edge cases
 * 
 * Final Fallback: Popup mode
 * - Used when all content script methods fail (chrome:// URLs, etc.)
 * - Opens extension popup with same spotlight functionality
 */

// Helper function to check if a URL supports content script injection
function supportsContentScripts(url) {
    if (!url) return false;

    // URLs that don't support content scripts
    const restrictedPatterns = [
        /^chrome:\/\//,
        /^chrome-extension:\/\//,
        /^edge:\/\//,
        /^about:/,
        /^moz-extension:\/\//,
        /^vivaldi:\/\//,
        /^brave:\/\//,
        /^opera:\/\//
    ];

    // Check if URL matches any restricted pattern
    for (const pattern of restrictedPatterns) {
        if (pattern.test(url)) {
            return false;
        }
    }

    return true;
}

// Helper function to activate spotlight via content script messaging
async function injectSpotlightScript(spotlightTabMode) {
    try {
        // Check if spotlight is enabled
        const settings = await Utils.getSettings();
        if (!settings.enableSpotlight) {
            Logger.log("Spotlight is disabled in settings.");

            if (spotlightTabMode === SpotlightTabMode.NEW_TAB) {
                Logger.log("Opening default new tab instead of spotlight new tab.");
                try {
                    await chrome.tabs.create({ url: 'chrome://new-tab-page/' });
                } catch (e) {
                    await chrome.tabs.create({ url: 'chrome-search://local-ntp/local-ntp.html' });
                }
            } else {
                Logger.log("Aborting spotlight injection.");
            }
            return;
        }

        // Get the active tab
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) {
            await closeSpotlightInTrackedTabs(tab.id);

            const spotlightNewTabUrl = chrome.runtime.getURL('spotlight/newtab.html');
            if (
                spotlightTabMode === SpotlightTabMode.NEW_TAB &&
                tab.url?.startsWith(spotlightNewTabUrl)
            ) {
                chrome.runtime
                    .sendMessage({ action: 'focusSpotlightNewTab' })
                    .catch(() => {});
                return;
            }

            // Check if the tab URL supports content scripts
            // If not, skip directly to custom new tab fallback
            if (!supportsContentScripts(tab.url)) {
                Logger.log("Tab URL doesn't support content scripts, opening custom new tab directly:", tab.url);
                await fallbackToChromeTabs(spotlightTabMode);
                return;
            }
            const activationMessage = {
                action: 'activateSpotlight',
                mode: spotlightTabMode,
                tabUrl: tab.url,
                tabId: tab.id
            };
            try {
                await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    files: ['spotlight/overlay.js']
                });
                const response = await chrome.tabs.sendMessage(tab.id, activationMessage);
                if (!response?.success) {
                    throw new Error(
                        response?.error || 'Spotlight activation was not acknowledged'
                    );
                }
                chrome.runtime.sendMessage({
                    action: 'spotlightRelayStarted',
                    tabId: tab.id
                }).catch(() => {});
                return;
            } catch (activationError) {
                Logger.log(
                    "Fresh Spotlight activation failed, using new tab fallback:",
                    activationError
                );
                await fallbackToChromeTabs(spotlightTabMode);
                return;
            }
        }
    } catch (error) {
        Logger.log("All spotlight activation methods failed, using Chrome tab fallback:", error);
        // Final fallback: Chrome tab operations
        await fallbackToChromeTabs(spotlightTabMode);
    }
}

// Helper function for Chrome tab fallback when spotlight injection fails
async function fallbackToChromeTabs(spotlightTabMode) {
    try {
        // First, close any existing spotlights in tracked tabs
        await closeSpotlightInTrackedTabs();

        Logger.log(`Falling back to custom new tab page for mode: ${spotlightTabMode}`);

        // Open custom new tab page with spotlight
        // This provides a better UX than chrome://newtab/ since users can still use spotlight
        // even when it cannot be injected on restricted pages (chrome://, extension pages, etc.)
        await chrome.tabs.create({ url: chrome.runtime.getURL('spotlight/newtab.html'), active: true });
        Logger.log("Spotlight failed - opened custom new tab with spotlight interface");

    } catch (chromeTabError) {
        Logger.error("Error with Chrome tab fallback:", chromeTabError);
        // Final fallback: open side panel
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab) {
                chrome.sidePanel.open({ windowId: tab.windowId });
                Logger.log("Opened side panel as final fallback");
            }
        } catch (sidePanelError) {
            Logger.error("All fallbacks failed:", sidePanelError);
        }
    }
}

// Helper function for URL copying via script injection
async function copyCurrentTabUrlWithFallback() {
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) {
            Logger.error("[URLCopy] No active tab found");
            return;
        }

        Logger.log(`[URLCopy] Copying URL via script injection: ${tab.url}`);

        // PRIMARY: Script injection approach (universal, no permission popups)
        try {
            const results = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                // Chrome serializes this function and runs it in the page, so it
                // must not use any identifier from this module (such as Logger).
                func: (url) => {
                    const copyWithExecCommand = () => {
                        try {
                            const textarea = document.createElement('textarea');
                            textarea.value = url;
                            document.body.appendChild(textarea);
                            textarea.select();
                            const copied = document.execCommand('copy');
                            document.body.removeChild(textarea);
                            return copied;
                        } catch {
                            return false;
                        }
                    };
                    try {
                        return navigator.clipboard.writeText(url)
                            .then(() => true)
                            .catch(copyWithExecCommand);
                    } catch {
                        return copyWithExecCommand();
                    }
                },
                args: [tab.url]
            });

            if (results?.[0]?.result === true) {
                Logger.log(`[URLCopy] Copied URL: ${tab.url}`);
            } else {
                Logger.error(`[URLCopy] Page could not copy URL: ${tab.url}`);
            }
            return;

        } catch (injectionError) {
            Logger.log("[URLCopy] Script injection failed, trying sidebar fallback:", injectionError);
        }

        // FALLBACK: Sidebar approach (works when sidebar is focused)
        try {
            const sidebarResponse = await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error("Sidebar timeout"));
                }, 1000);

                chrome.runtime.sendMessage({
                    command: "copyCurrentUrl",
                    url: tab.url
                }, (response) => {
                    clearTimeout(timeout);
                    if (chrome.runtime.lastError) {
                        reject(chrome.runtime.lastError);
                    } else {
                        resolve(response);
                    }
                });
            });

            Logger.log(`[URLCopy] Sidebar fallback succeeded: ${tab.url}`);
        } catch (sidebarError) {
            Logger.error("[URLCopy] Both script injection and sidebar failed:", sidebarError);
        }

    } catch (error) {
        Logger.error("[URLCopy] Failed to copy URL:", error);
    }
}

// --- Helper: Update Last Activity Timestamp ---
async function updateTabLastActivity(tabId) {
    if (!tabId) return;
    try {
        const result = await chrome.storage.local.get(TAB_ACTIVITY_STORAGE_KEY);
        const activityData = result[TAB_ACTIVITY_STORAGE_KEY] || {};
        activityData[tabId] = Date.now();
        // Optional: Prune old entries if the storage grows too large
        await chrome.storage.local.set({ [TAB_ACTIVITY_STORAGE_KEY]: activityData });
    } catch (error) {
        Logger.error("Error updating tab activity:", error);
    }
}

// --- Helper: Remove Activity Timestamp ---
async function removeTabLastActivity(tabId) {
    if (!tabId) return;
    try {
        const result = await chrome.storage.local.get(TAB_ACTIVITY_STORAGE_KEY);
        const activityData = result[TAB_ACTIVITY_STORAGE_KEY] || {};
        delete activityData[tabId];
        await chrome.storage.local.set({ [TAB_ACTIVITY_STORAGE_KEY]: activityData });
    } catch (error) {
        Logger.error("Error removing tab activity:", error);
    }
}


// --- Alarm Creation ---
async function setupAutoArchiveAlarm() {
    try {
        const settings = await Utils.getSettings();
        if (settings.autoArchiveEnabled && settings.autoArchiveIdleMinutes > 0) {
            // Create the alarm to fire periodically
            // Note: Chrome alarms are not exact, they fire *at least* this often.
            // Minimum period is 1 minute.
            const period = Math.max(1, settings.autoArchiveIdleMinutes / 2); // Check more frequently than the idle time
            await chrome.alarms.create(AUTO_ARCHIVE_ALARM_NAME, {
                periodInMinutes: period
            });
        } else {
            // If disabled, clear any existing alarm
            await chrome.alarms.clear(AUTO_ARCHIVE_ALARM_NAME);
        }
    } catch (error) {
        Logger.error("Error setting up auto-archive alarm:", error);
    }
}

// --- Alarm Listener ---
chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === AUTO_ARCHIVE_ALARM_NAME) {
        await runAutoArchiveCheck();
    }
});

// --- Archiving Logic ---
async function runAutoArchiveCheck() {
    const settings = await Utils.getSettings();
    if (!settings.autoArchiveEnabled || settings.autoArchiveIdleMinutes <= 0) {
        return;
    }

    const idleThresholdMillis = settings.autoArchiveIdleMinutes * 60 * 1000;
    const now = Date.now();

    try {
        const activityResult = await chrome.storage.local.get(TAB_ACTIVITY_STORAGE_KEY);
        const tabActivity = activityResult[TAB_ACTIVITY_STORAGE_KEY] || {};

        const sidebarState = await Utils.getSidebarState();
        const bookmarkedUrls = new Set();
        (sidebarState.pinnedTabIds || []).forEach(bookmark => {
            if (typeof bookmark === 'string') {
                bookmarkedUrls.add(bookmark);
            } else if (bookmark && bookmark.url) {
                bookmarkedUrls.add(bookmark.url);
            }
        });

        // Keep every tab that the sidebar treats as an Arcify pinned tab. The sidebar
        // binds per window, so run its own rule per window, with the stored bindings
        // (they keep a pinned tab after the user navigated away from the pinned URL).
        // URL recovery is on for every window, because the background cannot see which
        // windows have an open sidebar (side panel contexts report windowId -1). So this
        // can keep one temporary tab per pinned item and window (a unique origin+path
        // match). Keeping a tab is safer than closing a pinned one.
        // Stored bindings can be stale (tab IDs restart with the browser) and then claim
        // an item before its real tab. So also keep what the sidebar's init rule binds
        // (no stored bindings, Controller.tsx), and keep the union of both.
        const storedBindings = Object.fromEntries(
            Object.entries(await Utils.getPinnedTabStates())
                .filter(([, state]) => state?.pinnedItemId)
                .map(([tabId, state]) => [tabId, state.pinnedItemId])
        );
        const allTabs = await chrome.tabs.query({});
        const tabsByWindow = new Map();
        for (const tab of allTabs) {
            // Same URL fallback as the sidebar's toSnapshot in src/sidebar/chromeGateway.ts.
            const snapshot = { ...tab, url: tab.url || tab.pendingUrl || `about:blank#arcify-tab-${tab.id}` };
            tabsByWindow.set(tab.windowId, [...(tabsByWindow.get(tab.windowId) || []), snapshot]);
        }
        const pinnedTabIds = new Set();
        for (const windowTabs of tabsByWindow.values()) {
            for (const bindings of [storedBindings, {}]) {
                const { itemIdByTabId } = reconcileTabs(sidebarState, windowTabs, bindings);
                Object.keys(itemIdByTabId).forEach(tabId => pinnedTabIds.add(Number(tabId)));
            }
        }

        const tabs = allTabs.filter(tab => !tab.pinned);
        const tabsToArchive = [];

        for (const tab of tabs) {
            // Skip audible, active, or recently active tabs
            if (tab.audible || tab.active) {
                await updateTabLastActivity(tab.id); // Update activity for active/audible tabs
                continue;
            }

            if (bookmarkedUrls.has(tab.url) || pinnedTabIds.has(tab.id)) {
                // Optionally update activity for bookmarked tabs so they don't get checked repeatedly
                await updateTabLastActivity(tab.id);
                continue;
            }

            const lastActivity = tabActivity[tab.id];

            // If we have no record, or it's older than the threshold, mark for archiving
            // We assume tabs without a record haven't been active since tracking started or last check
            if (!lastActivity || (now - lastActivity > idleThresholdMillis)) {
                // Check if tab still exists before archiving
                try {
                    await chrome.tabs.get(tab.id); // Throws error if tab closed
                    tabsToArchive.push(tab);
                } catch (e) {
                    await removeTabLastActivity(tab.id); // Clean up record for closed tab
                }
            }
        }


        for (const tab of tabsToArchive) {
            const tabData = {
                url: tab.url,
                name: tab.title || tab.url
            };
            await Utils.addArchivedTab(tabData);
            await chrome.tabs.remove(tab.id);
            await removeTabLastActivity(tab.id);
        }

    } catch (error) {
        Logger.error("Error during auto-archive check:", error);
    }
}

// --- Event Listeners to Track Activity and Setup Alarm ---

// Run setup when the extension is installed or updated
chrome.runtime.onInstalled.addListener(() => {
    setupAutoArchiveAlarm();
    // Initialize activity for all existing tabs? Maybe too much overhead.
    // Better to let the alarm handle it over time.
});

// Run setup when Chrome starts
chrome.runtime.onStartup.addListener(() => {
    setupAutoArchiveAlarm();
});

// Listen for changes in storage (e.g., settings updated from options page)
chrome.storage.onChanged.addListener((changes, areaName) => {
    // Check if any of the auto-archive settings changed
    const settingsChanged = ['autoArchiveEnabled', 'autoArchiveIdleMinutes'].some(key => key in changes);

    if ((areaName === 'sync' || areaName === 'local') && settingsChanged) {
        setupAutoArchiveAlarm(); // Re-create or clear the alarm based on new settings
    }

    // Clean up activity data if a tab is removed
    if (areaName === 'local' && TAB_ACTIVITY_STORAGE_KEY in changes) {
        // This might be less reliable than using tab removal events
    }

    if (areaName === 'local' && changes.pinnedTabStatesById) {
        const oldStates = changes.pinnedTabStatesById.oldValue || {};
        const newStates = changes.pinnedTabStatesById.newValue || {};
        const changedTabIds = new Set([
            ...Object.keys(oldStates),
            ...Object.keys(newStates)
        ]);

        changedTabIds.forEach(tabId => {
            sendPinnedNavigationGuardState(parseInt(tabId, 10));
        });
    }
});

// Track tab activation
chrome.tabs.onActivated.addListener(async (activeInfo) => {
    invalidateSpotlightSearchCache();
    await updateTabLastActivity(activeInfo.tabId);

    // Close any open spotlights when switching tabs
    await closeSpotlightInTrackedTabs();

    await sendPinnedNavigationGuardState(activeInfo.tabId);
});

// Track tab updates (e.g., audible status changes)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.url !== undefined || changeInfo.title !== undefined) {
        invalidateSpotlightSearchCache();
    }
    // If a tab becomes active (e.g., navigation finishes) or audible, update its timestamp
    if (changeInfo.status === 'complete' || changeInfo.audible !== undefined) {
        if (tab.active || tab.audible) {
            await updateTabLastActivity(tabId);
        }
    }

    if (changeInfo.status === 'loading' || changeInfo.status === 'complete') {
        await sendPinnedNavigationGuardState(tabId);
    }
});

// Clean up timestamp when a tab is closed
chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
    invalidateSpotlightSearchCache();
    await removeTabLastActivity(tabId);

    // Clean up tab name override for closed tab
    await Utils.removeTabNameOverride(tabId);

    // Clean up spotlight tracking for closed tab
    if (spotlightOpenTabs.has(tabId)) {
        spotlightOpenTabs.delete(tabId);
    }
});

chrome.tabs.onCreated.addListener(invalidateSpotlightSearchCache);

// Optional: Listen for messages from options page to immediately update alarm
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

    if (message.action === 'tabSwitcherKeyUp') {
        tabSwitcherModifierReleased = true;
        void finishTabSwitcherSession(sender.tab?.id);
        return false;
    } else if (message.command === 'toggleSpotlightNewTab') {
        void injectSpotlightScript(SpotlightTabMode.NEW_TAB);
        return false;
    } else if (message.action === 'updateAutoArchiveSettings') {
        Logger.log("Received message to update auto-archive settings.");
        setupAutoArchiveAlarm();
        sendResponse({ success: true });
        return false; // Synchronous response
    } else if (message.action === 'openNewTab') {
        chrome.tabs.create({ url: message.url });
        sendResponse({ success: true });
        return false; // Synchronous response
    } else if (message.action === 'getPinnedNavigationGuardState') {
        return handleAsyncMessage(async () => {
            const tabId = sender.tab?.id;
            return await getPinnedNavigationGuardStateForTab(tabId);
        }, sendResponse, 'getting pinned navigation guard state');
    } else if (message.action === 'ensurePinnedNavigationGuard') {
        return handleAsyncMessage(async () => {
            await sendPinnedNavigationGuardState(message.tabId);
            return {};
        }, sendResponse, 'ensuring pinned navigation guard');
    } else if (message.action === 'openPinnedNavigationLink') {
        return handleAsyncMessage(async () => {
            return await openPinnedNavigationLink({
                sourceTabId: sender.tab?.id,
                url: message.url
            });
        }, sendResponse, 'opening pinned navigation link', { tabId: null });
    } else if (message.action === 'navigateToDefaultNewTab') {
        // Handle navigation to default new tab when custom new tab is disabled
        (async () => {
            try {
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (tab && tab.url && tab.url.includes('newtab.html')) {
                    // Navigate to Chrome's default new tab page
                    // Try the standard URL first, then fallback to local NTP
                    try {
                        await chrome.tabs.update(tab.id, { url: 'chrome://new-tab-page/' });
                    } catch (e) {
                        // Fallback for some browsers or configurations
                        await chrome.tabs.update(tab.id, { url: 'chrome-search://local-ntp/local-ntp.html' });
                    }
                }
                sendResponse({ success: true });
            } catch (error) {
                Logger.error('[Background] Error navigating to default new tab:', error);
                sendResponse({ success: false, error: error.message });
            }
        })();
        return true; // Async response
    } else if (message.action === 'switchToTab') {
        return handleAsyncMessage(async () => {
            await chrome.tabs.update(message.tabId, { active: true });
            await chrome.windows.update(message.windowId, { focused: true });
            return {};
        }, sendResponse, 'switching to tab');

    } else if (message.action === 'searchTabs') {
        return handleAsyncMessage(async () => {
            const tabs = await chrome.tabs.query({});
            const query = message.query?.toLowerCase() || '';
            const filteredTabs = tabs.filter(tab => {
                if (!tab.title || !tab.url) return false;
                if (!query) return true;
                return tab.title.toLowerCase().includes(query) ||
                    tab.url.toLowerCase().includes(query);
            });
            return { tabs: filteredTabs };
        }, sendResponse, 'searching tabs');

    } else if (message.action === 'getRecentTabs') {
        return handleAsyncMessage(async () => {
            const tabs = await chrome.tabs.query({});
            const storage = await chrome.storage.local.get([TAB_ACTIVITY_STORAGE_KEY]);
            const activityData = storage[TAB_ACTIVITY_STORAGE_KEY] || {};

            const tabsWithActivity = tabs
                .filter(tab => tab.url && tab.title)
                .map(tab => ({ ...tab, lastActivity: activityData[tab.id] || 0 }))
                .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0))
                .slice(0, message.limit || 5);

            return { tabs: tabsWithActivity };
        }, sendResponse, 'getting recent tabs');

    } else if (message.action === 'searchBookmarks') {
        return handleAsyncMessage(async () => {
            const bookmarks = await chrome.bookmarks.search(message.query);
            return { bookmarks: bookmarks.filter(b => b.url) };
        }, sendResponse, 'searching bookmarks');

    } else if (message.action === 'searchHistory') {
        return handleAsyncMessage(async () => {
            const historyItems = await chrome.history.search({
                text: message.query,
                maxResults: 10,
                startTime: Date.now() - (7 * 24 * 60 * 60 * 1000)
            });
            return { history: historyItems };
        }, sendResponse, 'searching history');

    } else if (message.action === 'getTopSites') {
        return handleAsyncMessage(async () => {
            const topSites = await chrome.topSites.get();
            return { topSites };
        }, sendResponse, 'getting top sites');

    } else if (message.action === 'getAutocomplete') {
        return handleAsyncMessage(async () => {
            const suggestions = await backgroundSearchEngine.dataProvider.getAutocompleteData(message.query);
            return { suggestions };
        }, sendResponse, 'getting autocomplete suggestions', { suggestions: [] });

    } else if (message.action === 'getPinnedTabs') {
        Logger.log('[Background] Received getPinnedTabs message:', message);
        return handleAsyncMessage(async () => {
            const pinnedTabs = await backgroundSearchEngine.dataProvider.getPinnedTabsData(message.query);
            Logger.log('[Background] Sending pinned tabs response:', pinnedTabs.length, 'tabs');
            return { pinnedTabs };
        }, sendResponse, 'getting pinned tabs', { pinnedTabs: [] });

    } else if (message.action === 'performSearch') {
        return handleAsyncMessage(async () => {
            const disposition = message.mode === SpotlightTabMode.NEW_TAB ? 'NEW_TAB' : 'CURRENT_TAB';
            await chrome.search.query({ text: message.query, disposition });
            return {};
        }, sendResponse, 'performing search');

    } else if (message.action === 'getSpotlightSuggestions') {
        return handleAsyncMessage(async () => {
            const query = message.query.trim();
            const results = query
                ? await backgroundSearchEngine.getSpotlightSuggestionsUsingCache(query, message.mode)
                : await backgroundSearchEngine.getSpotlightSuggestionsImmediate('', message.mode);
            return { results };
        }, sendResponse, 'getting spotlight suggestions', { results: [] });

    } else if (message.action === 'spotlightHandleResult') {
        return handleAsyncMessage(async () => {
            if (!message.result || !message.result.type || !message.mode) {
                throw new Error('Invalid spotlight result message');
            }
            const tabId = sender.tab?.id || message.tabId;
            await backgroundSearchEngine.handleResultAction(message.result, message.mode, tabId);
            return {};
        }, sendResponse, 'handling spotlight result');

    } else if (message.action === 'spotlightOpened') {
        // Track when spotlight opens in a tab
        if (sender.tab && sender.tab.id) {
            spotlightOpenTabs.add(sender.tab.id);
        }
        return false;
    } else if (message.action === 'spotlightClosed') {
        // Track when spotlight closes in a tab
        if (sender.tab && sender.tab.id) {
            spotlightOpenTabs.delete(sender.tab.id);
            chrome.runtime.sendMessage({
                action: 'spotlightRelayStopped',
                tabId: sender.tab.id
            }).catch(() => {});
        }
        return false;
    }

    return false; // No async response needed
});
