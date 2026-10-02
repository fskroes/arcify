// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeChrome, flush } from './helpers/fake-chrome.js';

const otherTab = {
  type: 'open-tab',
  title: 'Private bank statement',
  url: 'https://bank.example.com/statement',
  score: 100,
  metadata: { tabId: 5, windowId: 1 },
};

async function openSpotlightInPage() {
  vi.resetModules();
  // jsdom has no modal dialog, scrolling or window focus support.
  HTMLDialogElement.prototype.showModal ??= function showModal() { this.open = true; };
  HTMLDialogElement.prototype.close ??= function close() {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
  Element.prototype.scrollIntoView ??= () => {};
  vi.spyOn(window, 'focus').mockImplementation(() => {});
  const chrome = createFakeChrome({
    impl: {
      'runtime.sendMessage': async message =>
        message.action === 'getSpotlightSuggestions'
          ? { success: true, results: [otherTab] }
          : { success: true },
    },
  });
  globalThis.chrome = chrome;
  const shadowRoots = [];
  const attachShadow = Element.prototype.attachShadow;
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (init) {
    const root = attachShadow.call(this, init);
    shadowRoots.push(root);
    return root;
  });
  await import('../spotlight/overlay.js');
  await new Promise(resolve => {
    chrome.runtime.onMessage.dispatch(
      { action: 'activateSpotlight', mode: 'current-tab', tabUrl: 'https://page.example.com/', tabId: 1 },
      {},
      resolve,
    );
  });
  await flush(20);
  return { chrome, shadowRoots };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
  delete globalThis.chrome;
});

describe('Spotlight overlay in a web page (F3)', () => {
  it('shows results that page scripts cannot read', async () => {
    const { shadowRoots } = await openSpotlightInPage();

    // The extension renders the result...
    expect(shadowRoots).toHaveLength(1);
    const [root] = shadowRoots;
    expect(root.querySelector('dialog').open).toBe(true);
    const renderedTitles = [...root.querySelectorAll('.arcify-spotlight-result-title')].map(node => node.textContent);
    expect(renderedTitles).toContain('Private bank statement');

    // ...but the page sees only an empty host element.
    const pageVisible = [
      ...document.querySelectorAll('dialog, input, .arcify-spotlight-result-item'),
    ];
    expect(pageVisible).toEqual([]);
    expect(document.body.textContent).not.toContain('Private bank statement');
    expect(document.head.querySelector('style')).toBeNull();

    const host = document.getElementById('arcify-spotlight-host');
    expect(host).not.toBeNull();
    expect(host.shadowRoot).toBeNull();
  });

  it('removes the host when Spotlight closes', async () => {
    const { shadowRoots } = await openSpotlightInPage();
    shadowRoots[0].querySelector('dialog').close();
    expect(document.getElementById('arcify-spotlight-host')).toBeNull();
  });

  it('does not trigger page keyboard shortcuts while the user types', async () => {
    const { shadowRoots } = await openSpotlightInPage();
    const input = shadowRoots[0].querySelector('input');
    // Typical site shortcut handler (YouTube, Gmail, GitHub): skip keys typed in a text field.
    const shortcuts = [];
    const pageHandler = event => {
      if (event.target instanceof HTMLInputElement) return;
      shortcuts.push(`${event.type}:${event.key ?? ''}`);
    };
    const types = ['keydown', 'keypress', 'keyup', 'beforeinput', 'input',
      'paste', 'copy', 'cut', 'compositionstart', 'compositionupdate', 'compositionend'];
    types.forEach(type => document.addEventListener(type, pageHandler));

    for (const key of ['k', 'f', 'm', '#']) {
      for (const type of ['keydown', 'keypress', 'keyup']) {
        input.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, composed: true, cancelable: true }));
      }
      input.dispatchEvent(new InputEvent('input', { data: key, bubbles: true, composed: true }));
    }
    for (const type of ['paste', 'copy', 'cut']) {
      input.dispatchEvent(new Event(type, { bubbles: true, composed: true, cancelable: true }));
    }
    for (const type of ['compositionstart', 'compositionupdate', 'compositionend']) {
      input.dispatchEvent(new CompositionEvent(type, { data: 'に', bubbles: true, composed: true }));
    }

    types.forEach(type => document.removeEventListener(type, pageHandler));
    expect(shortcuts).toEqual([]);
  });
});
