import type { ArchivedTab, DurableSidebarState, PinnedItem } from './types';

const SIDEBAR_KEY = 'sidebarState';
const ARCHIVE_KEY = 'archivedTabs';

function normalizeItem(raw: unknown): PinnedItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const id = typeof item.id === 'string' ? item.id : crypto.randomUUID();
  const title = typeof item.title === 'string' && item.title ? item.title : 'Untitled';
  if (item.type === 'folder') {
    return {
      id,
      type: 'folder',
      title,
      children: Array.isArray(item.children)
        ? item.children.map(normalizeItem).filter((child): child is PinnedItem => Boolean(child))
        : [],
    };
  }
  return {
    id,
    type: 'link',
    title,
    url: typeof item.url === 'string' ? item.url : '',
    customTitle:
      typeof item.customTitle === 'boolean' ? item.customTitle : true,
    placement: item.placement === 'favorite' ? 'favorite' : 'sidebar',
  };
}

export function defaultDurableState(): DurableSidebarState {
  return { version: 2, pinnedItems: [] };
}

export function normalizeDurableState(raw: unknown): DurableSidebarState {
  if (!raw || typeof raw !== 'object') return defaultDurableState();
  const pinnedItems = (raw as Record<string, unknown>).pinnedItems;
  return {
    version: 2,
    pinnedItems: Array.isArray(pinnedItems)
      ? pinnedItems.map(normalizeItem).filter((item): item is PinnedItem => Boolean(item))
      : [],
  };
}

export interface DurableStore {
  /** Reads the stored state. Changes from other windows are buffered until `ready()`. */
  load(): Promise<DurableSidebarState>;
  /** Starts delivery of changes from other windows, beginning with any buffered change. */
  ready(): void;
  /** Writes the state, unless it is equal to the last state this instance read or wrote. */
  save(state: DurableSidebarState): Promise<void>;
  dispose(): void;
}

/**
 * Every sidebar window keeps its own copy of the pinned items. Without this
 * store, a window that did not see an edit from another window overwrites it
 * with its older copy on its next save.
 */
export function createDurableStore(
  onExternalChange: (state: DurableSidebarState) => void,
): DurableStore {
  let lastSyncedJson: string | null = null;
  let latest: DurableSidebarState | null = null;
  let changedDuringLoad = false;
  let delivering = false;
  let pendingDelivery = false;
  let saveQueue = Promise.resolve();

  const onChanged = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ) => {
    if (areaName !== 'local' || !(SIDEBAR_KEY in changes)) return;
    const next = normalizeDurableState(changes[SIDEBAR_KEY].newValue);
    const json = JSON.stringify(next);
    if (json === lastSyncedJson) return;
    lastSyncedJson = json;
    latest = next;
    changedDuringLoad = true;
    if (delivering) onExternalChange(next);
    else pendingDelivery = true;
  };
  chrome.storage.onChanged.addListener(onChanged);

  return {
    async load() {
      const stored = await chrome.storage.local.get(SIDEBAR_KEY);
      // A change event that arrived while get() ran is at least as new as its result.
      if (!changedDuringLoad) {
        latest = normalizeDurableState(stored[SIDEBAR_KEY]);
        lastSyncedJson = JSON.stringify(latest);
      }
      pendingDelivery = false;
      return structuredClone(latest ?? defaultDurableState());
    },
    ready() {
      delivering = true;
      if (pendingDelivery && latest) {
        pendingDelivery = false;
        onExternalChange(structuredClone(latest));
      }
    },
    save(state) {
      const snapshot = structuredClone(state);
      const normalized = normalizeDurableState(snapshot);
      const json = JSON.stringify(normalized);
      if (json === lastSyncedJson) return saveQueue;
      lastSyncedJson = json;
      latest = normalized;
      saveQueue = saveQueue.catch(() => undefined).then(async () => {
        await chrome.storage.local.set({ [SIDEBAR_KEY]: snapshot });
      });
      return saveQueue;
    },
    dispose() {
      delivering = false;
      chrome.storage.onChanged.removeListener(onChanged);
    },
  };
}

export async function loadArchivedTabs(): Promise<ArchivedTab[]> {
  const stored = await chrome.storage.local.get(ARCHIVE_KEY);
  return Array.isArray(stored[ARCHIVE_KEY]) ? stored[ARCHIVE_KEY] : [];
}

export async function saveArchivedTabs(tabs: ArchivedTab[]): Promise<void> {
  await chrome.storage.local.set({ [ARCHIVE_KEY]: tabs });
}
