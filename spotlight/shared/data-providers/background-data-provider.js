// background-data-provider.js - Direct Chrome API implementation for background scripts

import { BaseDataProvider } from './base-data-provider.js';
import { AutocompleteProvider } from './autocomplete-provider.js';
import { Utils } from '../../../utils.js';
import { Logger } from '../../../logger.js';

const TAB_ACTIVITY_STORAGE_KEY = 'tabLastActivity';

export class BackgroundDataProvider extends BaseDataProvider {
    constructor() {
        super();
        this.autocompleteProvider = new AutocompleteProvider();
        // Mark this as a background provider for reliable detection in minified builds
        this.isBackgroundProvider = true;
    }
    
    // Only implement the small data fetchers using direct Chrome APIs
    
    async getOpenTabsData(query = '') {
        try {
            const tabs = await chrome.tabs.query({});
            
            const filteredTabs = tabs.filter(tab => {
                if (!tab.title || !tab.url) return false;
                if (!query) return true;
                return tab.title.toLowerCase().includes(query.toLowerCase()) || 
                       this.getSearchableUrl(tab.url).includes(query.toLowerCase());
            });
            
            return filteredTabs;
        } catch (error) {
            Logger.error('[BackgroundDataProvider] Error querying tabs:', error);
            return [];
        }
    }

    async getRecentTabsData(limit = 5) {
        try {
            const tabs = await chrome.tabs.query({});
            const storage = await chrome.storage.local.get([TAB_ACTIVITY_STORAGE_KEY]);
            const activityData = storage[TAB_ACTIVITY_STORAGE_KEY] || {};
            
            const recentTabs = tabs
                .filter(tab => tab.url && tab.title)
                .map(tab => ({
                    ...tab,
                    lastActivity: activityData[tab.id] || 0
                }))
                .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0))
                .slice(0, limit);
                
            return recentTabs;
        } catch (error) {
            Logger.error('[BackgroundDataProvider] Error getting recent tabs:', error);
            return [];
        }
    }

    async openPinnedTab(pinnedItemId, pinnedUrl) {
        if (!pinnedItemId || !pinnedUrl) {
            throw new Error('Pinned tab result is missing its item ID or URL');
        }
        const tab = await chrome.tabs.create({ url: pinnedUrl, active: false });
        await Utils.setPinnedTabState(tab.id, { pinnedItemId, pinnedUrl });
        await chrome.runtime.sendMessage({
            action: 'pinnedTabOpened',
            tabId: tab.id,
            pinnedItemId
        }).catch(() => {});
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
    }

    async getBookmarksData(query) {
        const bookmarks = await chrome.bookmarks.search(query);
        return bookmarks.filter(bookmark => Boolean(bookmark.url));
    }

    async getHistoryData(query) {
        try {
            const historyItems = await chrome.history.search({
                text: query,
                maxResults: 10,
                startTime: Date.now() - (7 * 24 * 60 * 60 * 1000) // Last 7 days
            });
            return historyItems;
        } catch (error) {
            Logger.error('[BackgroundDataProvider] Error getting history:', error);
            return [];
        }
    }

    async getTopSitesData() {
        try {
            const topSites = await chrome.topSites.get();
            return topSites;
        } catch (error) {
            Logger.error('[BackgroundDataProvider] Error getting top sites:', error);
            return [];
        }
    }

    async getAutocompleteData(query) {
        try {
            const { enableSearchSuggestions } = await Utils.getSettings();
            if (!enableSearchSuggestions) return [];
            return await this.autocompleteProvider.getAutocompleteSuggestions(query);
        } catch (error) {
            Logger.error('[BackgroundDataProvider] Error getting autocomplete data:', error);
            return [];
        }
    }

    async getPinnedTabsData(query = '') {
        try {
            const sidebarState = await Utils.getSidebarState();
            const tabs = await chrome.tabs.query({});
            const pinnedStatesById = await Utils.getPinnedTabStates();
            const pinnedLinks = [];
            Utils.walkPinnedItems(sidebarState.pinnedItems, item => {
                if (item?.type === 'link' && item.url) {
                    pinnedLinks.push(item);
                }
            });

            const normalizedQuery = query.trim().toLowerCase();
            const claimedTabIds = new Set();
            return pinnedLinks
                .filter(item => !normalizedQuery ||
                    item.title.toLowerCase().includes(normalizedQuery) ||
                    this.getSearchableUrl(item.url).includes(normalizedQuery))
                .map(item => {
                    const matchingTab = tabs.find(tab =>
                        !claimedTabIds.has(tab.id) &&
                        pinnedStatesById?.[tab.id]?.pinnedItemId === item.id
                    ) || tabs.find(tab =>
                        !claimedTabIds.has(tab.id) &&
                        !pinnedStatesById?.[tab.id]?.pinnedItemId &&
                        tab.url === item.url
                    );
                    if (matchingTab) claimedTabIds.add(matchingTab.id);
                    return {
                        ...item,
                        tabId: matchingTab?.id || null,
                        windowId: matchingTab?.windowId || null,
                        isActive: Boolean(matchingTab)
                    };
                });
        } catch (error) {
            Logger.error('[BackgroundDataProvider] Error getting pinned tabs data:', error);
            return [];
        }
    }


}
