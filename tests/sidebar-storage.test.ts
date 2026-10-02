import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDurableStore, type DurableStore } from '../src/sidebar/storage';
import type { DurableSidebarState, PinnedLink } from '../src/sidebar/types';
import { createFakeChrome, flush } from './helpers/fake-chrome.js';

const link = (id: string, title = id): PinnedLink => ({
  id,
  type: 'link',
  title,
  url: `https://${id}.example.com/`,
  customTitle: false,
  placement: 'sidebar',
});

const state = (...items: PinnedLink[]): DurableSidebarState => ({ version: 2, pinnedItems: items });

const titles = (value: DurableSidebarState | null | undefined) =>
  (value?.pinnedItems ?? []).map(item => item.title);

let chrome: ReturnType<typeof createFakeChrome>;
let stores: DurableStore[] = [];

beforeEach(() => {
  chrome = createFakeChrome({ local: { sidebarState: state(link('a')) } });
  (globalThis as Record<string, unknown>).chrome = chrome;
  stores = [];
});

afterEach(() => {
  stores.forEach(store => store.dispose());
  delete (globalThis as Record<string, unknown>).chrome;
});

// Models one sidebar window: React state plus the save effect that runs after
// every durable change, also after a change that came from another window.
async function openSidebarWindow() {
  const window = {
    state: null as DurableSidebarState | null,
    store: null as unknown as DurableStore,
    edit(next: DurableSidebarState) {
      window.state = next;
      return window.store.save(next);
    },
  };
  window.store = createDurableStore(next => {
    window.state = next;
    void window.store.save(next);
  });
  stores.push(window.store);
  window.state = await window.store.load();
  window.store.ready();
  await window.store.save(window.state);
  return window;
}

const storedTitles = () => titles(chrome.storage.local.data.sidebarState);
const writeCount = () => chrome.storage.local.set.mock.calls.length;

describe('sidebar durable store across windows (F1)', () => {
  it('does not write when a window only opens', async () => {
    await openSidebarWindow();
    await openSidebarWindow();
    await flush();
    expect(writeCount()).toBe(0);
  });

  it('keeps a pin added in one window when another window edits later', async () => {
    const first = await openSidebarWindow();
    const second = await openSidebarWindow();

    await first.edit(state(link('a'), link('b')));
    await flush();
    expect(titles(second.state)).toEqual(['a', 'b']);

    const [a, ...rest] = second.state!.pinnedItems as PinnedLink[];
    await second.edit(state({ ...a, title: 'renamed', customTitle: true }, ...rest));
    await flush();

    expect(storedTitles()).toEqual(['renamed', 'b']);
    expect(titles(first.state)).toEqual(['renamed', 'b']);
  });

  it('settles without a write loop when two windows save at the same time', async () => {
    const first = await openSidebarWindow();
    const second = await openSidebarWindow();

    await Promise.all([
      first.edit(state(link('a'), link('from-first'))),
      second.edit(state(link('a'), link('from-second'))),
    ]);
    await flush(20);

    expect(writeCount()).toBe(2);
    expect(titles(first.state)).toEqual(storedTitles());
    expect(titles(second.state)).toEqual(storedTitles());
  });

  it('delivers a change that arrives between load and ready', async () => {
    const other = await openSidebarWindow();
    const received: DurableSidebarState[] = [];
    const late = createDurableStore(next => received.push(next));
    stores.push(late);

    expect(titles(await late.load())).toEqual(['a']);
    await other.edit(state(link('a'), link('b')));
    await flush();
    expect(received).toEqual([]);

    late.ready();
    expect(received.map(titles)).toEqual([['a', 'b']]);
  });

  it('ignores storage changes after dispose', async () => {
    const other = await openSidebarWindow();
    const received: DurableSidebarState[] = [];
    const closed = createDurableStore(next => received.push(next));
    await closed.load();
    closed.ready();
    closed.dispose();

    await other.edit(state(link('a'), link('b')));
    await flush();
    expect(received).toEqual([]);
  });
});
