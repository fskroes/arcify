import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeChrome, flush } from './helpers/fake-chrome.js';

// Imports the real service worker against a fresh fake `chrome` global.
async function loadBackground(options) {
  vi.resetModules();
  const chrome = createFakeChrome(options);
  globalThis.chrome = chrome;
  await import('../background.js');
  await flush();
  return chrome;
}

function sendRuntimeMessage(chrome, message, sender = {}) {
  return new Promise(resolve => {
    chrome.runtime.onMessage.dispatch(message, sender, resolve);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete globalThis.chrome;
});

describe('copy current URL (F4)', () => {
  // Chrome serializes the injected `func` with toString() and runs it in the
  // page's isolated world, so it must not reference anything from this module.
  async function captureInjectedCopy() {
    const tab = { id: 7, windowId: 1, active: true, url: 'https://example.com/page' };
    const chrome = await loadBackground({
      impl: {
        'tabs.query': async () => [tab],
        'scripting.executeScript': async () => [{ frameId: 0, result: true }],
      },
    });
    await Promise.all(chrome.commands.onCommand.dispatch('copyCurrentUrl'));
    const [{ func, args }] = chrome.scripting.executeScript.mock.calls[0];
    return { chrome, func, args };
  }

  function runInPage(func, args, { clipboardRejects }) {
    const copied = [];
    let selected = null;
    const context = {
      navigator: {
        clipboard: {
          writeText: async text => {
            if (clipboardRejects) throw new Error('Document is not focused.');
            copied.push(text);
          },
        },
      },
      document: {
        body: { appendChild() {}, removeChild() {} },
        createElement: () => {
          const element = { value: '', select: () => { selected = element; } };
          return element;
        },
        execCommand: command => {
          if (command !== 'copy' || !selected) return false;
          copied.push(selected.value);
          return true;
        },
      },
    };
    const isolated = vm.runInNewContext(`(${func.toString()})`, context);
    return { result: isolated(...args), copied };
  }

  it('copies with the Clipboard API and reports success', async () => {
    const { func, args } = await captureInjectedCopy();
    const { result, copied } = runInPage(func, args, { clipboardRejects: false });
    await expect(Promise.resolve(result)).resolves.toBe(true);
    expect(copied).toEqual(['https://example.com/page']);
  });

  it('falls back to execCommand when the Clipboard API rejects', async () => {
    const { func, args } = await captureInjectedCopy();
    const { result, copied } = runInPage(func, args, { clipboardRejects: true });
    await expect(Promise.resolve(result)).resolves.toBe(true);
    expect(copied).toEqual(['https://example.com/page']);
  });

  it('does not send a message that nothing receives', async () => {
    const { chrome } = await captureInjectedCopy();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'urlCopySuccess' }),
    );
  });
});

describe('auto-archive (F6)', () => {
  const pinnedMail = {
    id: 'pin-mail',
    type: 'link',
    title: 'Mail',
    url: 'https://mail.example.com/inbox',
    customTitle: false,
    placement: 'sidebar',
  };
  const tabs = [
    // Bound to a pinned item, then navigated away from the pinned URL.
    { id: 11, windowId: 1, url: 'https://other.example.com/x', title: 'Other', active: false, audible: false },
    // Not bound yet (its window has no open sidebar) but shows the pinned URL.
    { id: 12, windowId: 2, url: 'https://mail.example.com/inbox', title: 'Mail', active: false, audible: false },
    // Ordinary idle tab: must still be archived.
    { id: 13, windowId: 1, url: 'https://news.example.com/', title: 'News', active: false, audible: false },
    // Same origin and path as the pin, but other pages. Two of them, so the sidebar's URL
    // recovery cannot pick one: both must still be archived. (A single such tab is kept,
    // because the background cannot tell if a live sidebar already bound tab 11.)
    { id: 14, windowId: 1, url: 'https://mail.example.com/inbox?thread=42', title: 'Thread', active: false, audible: false },
    { id: 17, windowId: 1, url: 'https://mail.example.com/inbox?thread=43', title: 'Thread 2', active: false, audible: false },
    // Old binding to a pinned item that no longer exists (tab IDs restart with the browser).
    { id: 15, windowId: 1, url: 'https://shop.example.com/', title: 'Shop', active: false, audible: false },
    // Pinned tab whose URL hash changed, in a window without a sidebar: the sidebar binds it.
    { id: 16, windowId: 3, url: 'https://mail.example.com/inbox#thread-7', title: 'Mail', active: false, audible: false },
  ];

  it('archives idle tabs but never tabs that the sidebar binds to Arcify pinned items', async () => {
    const chrome = await loadBackground({
      sync: { autoArchiveEnabled: true, autoArchiveIdleMinutes: 60 },
      local: {
        sidebarState: { version: 2, pinnedItems: [pinnedMail] },
        pinnedTabStatesById: {
          11: { pinnedItemId: 'pin-mail', pinnedUrl: pinnedMail.url },
          15: { pinnedItemId: 'pin-deleted', pinnedUrl: 'https://deleted.example.com/' },
        },
        tabLastActivity: {},
      },
      impl: {
        'tabs.query': async () => tabs,
        'tabs.get': async tabId => tabs.find(tab => tab.id === tabId),
      },
    });

    await Promise.all(chrome.alarms.onAlarm.dispatch({ name: 'autoArchiveTabsAlarm' }));

    const removed = chrome.tabs.remove.mock.calls.map(([tabId]) => tabId);
    expect(removed).toEqual([13, 14, 17, 15]);
    // addArchivedTab sorts newest first by Date.now(), so the order depends on timing.
    expect(chrome.storage.local.data.archivedTabs.map(tab => tab.url).sort()).toEqual([
      'https://mail.example.com/inbox?thread=42',
      'https://mail.example.com/inbox?thread=43',
      'https://news.example.com/',
      'https://shop.example.com/',
    ]);
  });

  it('keeps the real pinned tab when a stale tab ID from the last session holds the binding', async () => {
    // Tab IDs restart with the browser: tab 21 was the mail tab last session, now it is news.
    const restartTabs = [
      { id: 21, windowId: 1, url: 'https://news.example.com/', title: 'News', active: false, audible: false },
      { id: 40, windowId: 1, url: 'https://mail.example.com/inbox', title: 'Mail', active: false, audible: false },
    ];
    const chrome = await loadBackground({
      sync: { autoArchiveEnabled: true, autoArchiveIdleMinutes: 60 },
      local: {
        sidebarState: { version: 2, pinnedItems: [pinnedMail] },
        pinnedTabStatesById: { 21: { pinnedItemId: 'pin-mail', pinnedUrl: pinnedMail.url } },
        tabLastActivity: {},
      },
      impl: {
        'tabs.query': async () => restartTabs,
        'tabs.get': async tabId => restartTabs.find(tab => tab.id === tabId),
      },
    });

    await Promise.all(chrome.alarms.onAlarm.dispatch({ name: 'autoArchiveTabsAlarm' }));

    expect(chrome.tabs.remove.mock.calls.map(([tabId]) => tabId)).not.toContain(40);
  });
});

describe('Google search suggestions setting (F2)', () => {
  function stubFetch() {
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ['react hooks', ['react hooks tutorial']],
    }));
    vi.stubGlobal('fetch', fetch);
    return fetch;
  }

  it('sends no request to Google when suggestions are turned off', async () => {
    const fetch = stubFetch();
    const chrome = await loadBackground({ sync: { enableSearchSuggestions: false } });

    const response = await sendRuntimeMessage(chrome, { action: 'getAutocomplete', query: 'react hooks' });

    expect(fetch).not.toHaveBeenCalled();
    expect(response).toEqual({ success: true, suggestions: [] });
  });

  it('keeps fetching suggestions by default', async () => {
    const fetch = stubFetch();
    const chrome = await loadBackground();

    const response = await sendRuntimeMessage(chrome, { action: 'getAutocomplete', query: 'react hooks' });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toContain('clients1.google.com/complete/search');
    expect(response.suggestions.length).toBeGreaterThan(0);
  });
});
