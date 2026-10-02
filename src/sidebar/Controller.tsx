import { useCallback, useEffect, useRef, useState } from 'react';
import { SidebarApp } from './App';
import type { PinnedTreeActions, TabActions } from './components';
import {
  activateTab,
  bindPinnedTab,
  closeTabSafely,
  closeTabsSafely,
  createTab,
  faviconUrl,
  queryCurrentWindowTabs,
  replacePinnedBindings,
  sendRuntimeMessage,
  subscribeToChromeTabs,
  unbindPinnedTab,
} from './chromeGateway';
import { isNavigatedAway, reconcileTabs } from './reconcile';
import { useSidebarContext } from './state';
import {
  createDurableStore,
  loadArchivedTabs,
  saveArchivedTabs,
  type DurableStore,
} from './storage';
import {
  favoriteItems,
  findPinnedItem,
  findPinnedLink,
  flattenPinnedLinks,
  insertPinnedItem,
  isInsideCollapsedFolder,
  movePinnedItem,
  removePinnedItem,
  sidebarItems,
  updatePinnedItem,
} from './tree';
import type {
  ArchivedTab,
  DragItem,
  DropTarget,
  DurableSidebarState,
  PinnedFolder,
  PinnedItem,
  PinnedLink,
  TabRowViewModel,
  TabSnapshot,
} from './types';

function createLink(tab: TabSnapshot, placement: 'sidebar' | 'favorite'): PinnedLink {
  return {
    id: crypto.randomUUID(),
    type: 'link',
    title: tab.title,
    url: tab.url,
    customTitle: false,
    placement,
  };
}

function pinnedUrlsByItemId(items: PinnedItem[]): Record<string, string> {
  return Object.fromEntries(flattenPinnedLinks(items).map(item => [item.id, item.url]));
}

export function SidebarController() {
  const { state, dispatch } = useSidebarContext();
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archivedTabs, setArchivedTabs] = useState<ArchivedTab[]>([]);
  const [closingKeys, setClosingKeys] = useState<string[]>([]);
  const [surfaceColor, setSurfaceColor] = useState<string | null>(null);
  const [folderPendingDeletion, setFolderPendingDeletion] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const refreshSequence = useRef(0);
  const liveOwnership = useRef<Record<number, string>>({});
  const spotlightRelayTabId = useRef<number | null>(null);
  const pendingNewTabIds = useRef(new Set<number>());
  const temporaryInsertAfterByTabId = useRef(new Map<number, number>());
  const newTabPosition = useRef<'top' | 'bottom'>('bottom');
  const durableStore = useRef<DurableStore | null>(null);

  useEffect(() => {
    void chrome.storage.sync.get(['sidebarSurfaceColor', 'newTabPosition']).then(result => {
      setSurfaceColor(
        typeof result.sidebarSurfaceColor === 'string'
          ? result.sidebarSurfaceColor
          : null,
      );
      newTabPosition.current = result.newTabPosition === 'top' ? 'top' : 'bottom';
    });
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== 'sync') return;
      if (changes.sidebarSurfaceColor) {
        const value = changes.sidebarSurfaceColor.newValue;
        setSurfaceColor(typeof value === 'string' ? value : null);
      }
      if (changes.newTabPosition) {
        newTabPosition.current =
          changes.newTabPosition.newValue === 'top' ? 'top' : 'bottom';
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  const rememberOwnership = (tabId: number, itemId: string | null) => {
    if (itemId) liveOwnership.current[tabId] = itemId;
    else delete liveOwnership.current[tabId];
  };

  const synchronizeTabs = useCallback(
    async (durable: DurableSidebarState) => {
      const sequence = ++refreshSequence.current;
      const tabs = await queryCurrentWindowTabs();
      if (sequence !== refreshSequence.current) return;
      const ownership = reconcileTabs(
        durable,
        tabs,
        liveOwnership.current,
        false,
      );
      const newTemporaryTabIds = [...pendingNewTabIds.current];
      pendingNewTabIds.current.clear();
      const temporaryInsertAfter = Object.fromEntries(
        newTemporaryTabIds.flatMap(tabId => {
          const sourceTabId = temporaryInsertAfterByTabId.current.get(tabId);
          return sourceTabId == null ? [] : [[tabId, sourceTabId]];
        }),
      );
      for (const tabId of newTemporaryTabIds) {
        temporaryInsertAfterByTabId.current.delete(tabId);
      }
      liveOwnership.current = ownership.itemIdByTabId;
      dispatch({
        type: 'tabsSynchronized',
        tabs,
        ...ownership,
        newTemporaryTabIds,
        temporaryInsertAfterByTabId: temporaryInsertAfter,
        newTabPosition: newTabPosition.current,
      });
      await replacePinnedBindings(
        ownership.itemIdByTabId,
        pinnedUrlsByItemId(durable.pinnedItems),
        tabs.map(tab => tab.id),
      );
    },
    [dispatch],
  );

  useEffect(() => {
    let cancelled = false;
    const store = createDurableStore(durable => {
      dispatch({ type: 'replaceDurable', durable });
      void synchronizeTabs(durable);
    });
    durableStore.current = store;
    void (async () => {
      try {
        const [durable, tabs, archive] = await Promise.all([
          store.load(),
          queryCurrentWindowTabs(),
          loadArchivedTabs(),
        ]);
        if (cancelled) return;
        const ownership = reconcileTabs(durable, tabs, {});
        liveOwnership.current = ownership.itemIdByTabId;
        dispatch({ type: 'initialized', durable, tabs, ...ownership });
        store.ready();
        setArchivedTabs(archive);
        await replacePinnedBindings(
          ownership.itemIdByTabId,
          pinnedUrlsByItemId(durable.pinnedItems),
          tabs.map(tab => tab.id),
        );
      } catch (error) {
        dispatch({
          type: 'initializationFailed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return () => {
      cancelled = true;
      store.dispose();
      if (durableStore.current === store) durableStore.current = null;
    };
  }, [dispatch, synchronizeTabs]);

  useEffect(() => {
    if (state.status !== 'ready') return;
    void durableStore.current?.save(state.durable);
  }, [state.durable, state.status]);

  useEffect(() => {
    if (state.status !== 'ready') return;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    return subscribeToChromeTabs({
      onCreated: tab => {
        if (tab.id != null) pendingNewTabIds.current.add(tab.id);
      },
      onChanged: () => {
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(() => void synchronizeTabs(state.durable), 40);
      },
    });
  }, [state.durable, state.status, synchronizeTabs]);

  useEffect(() => {
    const updateRelay = (message: {
      action?: string;
      tabId?: number;
      pinnedItemId?: string;
    }) => {
      if (message.action === 'spotlightRelayStarted' && message.tabId != null) {
        spotlightRelayTabId.current = message.tabId;
      } else if (
        message.action === 'spotlightRelayStopped' &&
        message.tabId === spotlightRelayTabId.current
      ) {
        spotlightRelayTabId.current = null;
      } else if (
        message.action === 'pinnedTabOpened' &&
        message.tabId != null &&
        message.pinnedItemId
      ) {
        liveOwnership.current[message.tabId] = message.pinnedItemId;
      }
    };
    const relayKey = (event: KeyboardEvent) => {
      const tabId = spotlightRelayTabId.current;
      if (tabId == null || event.isComposing) return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      chrome.tabs.sendMessage(tabId, {
        action: 'spotlightRelayKey',
        keyEvent: {
          key: event.key,
          code: event.code,
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
        },
      }).catch(() => {
        if (spotlightRelayTabId.current === tabId) spotlightRelayTabId.current = null;
      });
    };
    chrome.runtime.onMessage.addListener(updateRelay);
    window.addEventListener('keydown', relayKey, true);
    return () => {
      chrome.runtime.onMessage.removeListener(updateRelay);
      window.removeEventListener('keydown', relayKey, true);
    };
  }, []);

  useEffect(() => {
    const onTabSwitcherModifierRelease = (event: KeyboardEvent) => {
      const isAltRelease =
        (event.key === 'Alt' || event.code === 'AltLeft' || event.code === 'AltRight') &&
        !event.altKey;
      if (!isAltRelease) return;

      chrome.runtime.sendMessage({ action: 'tabSwitcherKeyUp' }).catch(() => {});
    };

    window.addEventListener('keyup', onTabSwitcherModifierRelease, true);
    return () => window.removeEventListener('keyup', onTabSwitcherModifierRelease, true);
  }, []);

  const commitDurable = useCallback(
    async (durable: DurableSidebarState) => {
      dispatch({ type: 'replaceDurable', durable });
      await synchronizeTabs(durable);
    },
    [dispatch, synchronizeTabs],
  );

  const tabById = Object.fromEntries(state.runtime.tabs.map(tab => [tab.id, tab]));
  const rowByItemId: Record<string, TabRowViewModel> = {};
  const pinnedLinks = flattenPinnedLinks(state.durable.pinnedItems);
  const pinnedLinkIds = new Set(pinnedLinks.map(item => item.id));
  for (const item of pinnedLinks) {
    const tabId = state.runtime.tabIdByItemId[item.id] ?? null;
    const tab = tabId ? tabById[tabId] : null;
    rowByItemId[item.id] = {
      key: item.id,
      tabId,
      itemId: item.id,
      title: item.customTitle ? item.title : (tab?.title || item.title),
      url: tab?.url || item.url,
      pinnedUrl: item.url,
      faviconUrl: faviconUrl(tab?.url || item.url),
      active: Boolean(tab?.active),
      pinned: true,
      favorite: item.placement === 'favorite',
      open: Boolean(tab),
      navigatedAway: Boolean(tab && isNavigatedAway(tab.url, item.url)),
      splitViewId: tab?.splitViewId ?? null,
    };
  }
  const temporaryOrder = new Map(
    state.runtime.temporaryTabOrder.map((tabId, index) => [tabId, index]),
  );
  const temporaryRows: TabRowViewModel[] = state.runtime.tabs
    .filter(tab => {
      const ownerId = state.runtime.itemIdByTabId[tab.id];
      return !ownerId || !pinnedLinkIds.has(ownerId);
    })
    .sort(
      (left, right) =>
        (temporaryOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
        (temporaryOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER),
    )
    .map(tab => ({
      key: `temporary:${tab.id}`,
      tabId: tab.id,
      itemId: null,
      title: state.runtime.temporaryTitles[tab.id] || tab.title,
      url: tab.url,
      pinnedUrl: null,
      faviconUrl: faviconUrl(tab.url),
      active: tab.active,
      pinned: false,
      favorite: false,
      open: true,
      navigatedAway: false,
      splitViewId: tab.splitViewId,
    }));

  const activateRow = useCallback(
    async (row: TabRowViewModel) => {
      if (row.tabId) {
        await activateTab(row.tabId);
        return;
      }
      if (!row.itemId) return;
      const item = findPinnedLink(state.durable.pinnedItems, row.itemId);
      if (!item) return;
      const tab = await createTab(item.url);
      await bindPinnedTab(tab.id, item);
      rememberOwnership(tab.id, item.id);
      await synchronizeTabs(state.durable);
    },
    [state.durable, synchronizeTabs],
  );

  const closeRow = useCallback(
    async (row: TabRowViewModel) => {
      const shouldCollapse =
        !row.pinned ||
        Boolean(
          row.itemId &&
          isInsideCollapsedFolder(
            state.durable.pinnedItems,
            row.itemId,
            new Set(state.runtime.expandedFolderIds),
          ),
        );
      if (shouldCollapse) {
        setClosingKeys(keys => [...new Set([...keys, row.key])]);
        await new Promise(resolve => setTimeout(resolve, 140));
      }
      if (row.tabId) {
        try {
          await closeTabSafely(row.tabId);
          await unbindPinnedTab(row.tabId);
          rememberOwnership(row.tabId, null);
          await synchronizeTabs(state.durable);
          return;
        } finally {
          setClosingKeys(keys => keys.filter(key => key !== row.key));
        }
      }
      if (!row.itemId) return;
      try {
        const nextItems = removePinnedItem(state.durable.pinnedItems, row.itemId).items;
        await commitDurable({ ...state.durable, pinnedItems: nextItems });
      } finally {
        setClosingKeys(keys => keys.filter(key => key !== row.key));
      }
    },
    [commitDurable, state.durable, state.runtime.expandedFolderIds, synchronizeTabs],
  );

  const tabActions: TabActions = {
    renamingKey,
    closingKeys: new Set(closingKeys),
    onActivate: row => void activateRow(row),
    onClose: row => void closeRow(row),
    onRequestRename: row => renameRow(row),
    onDuplicate: row => void duplicateTab(row),
    onToggleFavorite: row => toggleFavorite(row),
    onTogglePinned: row => void togglePinned(row),
    onReplaceUrl: row => void replacePinnedUrl(row),
    onCloseBelow: row => void closeTemporaryTabsBelow(row),
    onRenameCommit: (key, title) => {
      if (key.startsWith('new-folder:')) {
        const encodedParent = key.slice('new-folder:'.length);
        createFolder(encodedParent === 'root' ? null : encodedParent, title);
      } else if (key.startsWith('item:')) {
        dispatch({ type: 'renameItem', itemId: key.slice(5), title });
      } else if (key.startsWith('tab:')) {
        dispatch({ type: 'renameTemporary', tabId: Number(key.slice(4)), title });
      }
      setRenamingKey(null);
    },
    onRenameCancel: () => setRenamingKey(null),
  };

  const treeActions: PinnedTreeActions = {
    ...tabActions,
    onToggleFolder: folderId => dispatch({ type: 'toggleFolder', folderId }),
    onRequestFolderRename: folderId => setRenamingKey(`item:${folderId}`),
    onRequestSubfolder: folderId => beginCreateFolder(folderId),
    onRequestFolderDeletion: folderId => requestFolderDeletion(folderId),
  };

  const handleDragEnd = useCallback(
    async (active: DragItem, target: DropTarget) => {
      if (active.kind === 'pinned') {
        const item = findPinnedItem(state.durable.pinnedItems, active.itemId);
        if (!item) return;
        if (target.area === 'temporary') {
          if (item.type !== 'link') return;
          const tabId = state.runtime.tabIdByItemId[item.id];
          if (!tabId) return;
          const next = removePinnedItem(state.durable.pinnedItems, item.id).items;
          await unbindPinnedTab(tabId);
          rememberOwnership(tabId, null);
          await commitDurable({ ...state.durable, pinnedItems: next });
          return;
        }
        const placement = target.area === 'favorite' ? 'favorite' : 'sidebar';
        const next = movePinnedItem(
          state.durable.pinnedItems,
          item.id,
          target.area === 'pinned' ? target.parentId : null,
          target.index,
          placement,
        );
        await commitDurable({ ...state.durable, pinnedItems: next });
        return;
      }

      const tab = tabById[active.tabId];
      if (!tab) return;
      if (target.area === 'temporary') {
        dispatch({
          type: 'moveTemporaryTab',
          tabId: tab.id,
          index: target.index,
        });
        return;
      }
      const placement = target.area === 'favorite' ? 'favorite' : 'sidebar';
      const link = createLink(tab, placement);
      const next = insertPinnedItem(
        state.durable.pinnedItems,
        link,
        target.area === 'pinned' ? target.parentId : null,
        target.index,
        placement,
      );
      await bindPinnedTab(tab.id, link);
      rememberOwnership(tab.id, link.id);
      await commitDurable({ ...state.durable, pinnedItems: next });
    },
    [commitDurable, dispatch, state, tabById],
  );

  const renameRow = (row: TabRowViewModel) => {
    if (row.itemId) setRenamingKey(`item:${row.itemId}`);
    else if (row.tabId) setRenamingKey(`tab:${row.tabId}`);
  };

  const toggleFavorite = (row: TabRowViewModel) => {
    if (!row.itemId) return;
    const target = row.favorite ? 'sidebar' : 'favorite';
    const index =
      target === 'favorite'
        ? favoriteItems(state.durable.pinnedItems).length
        : sidebarItems(state.durable.pinnedItems).length;
    dispatch({
      type: 'movePinnedItem',
      itemId: row.itemId,
      parentId: null,
      index,
      placement: target,
    });
  };

  const togglePinned = async (row: TabRowViewModel) => {
    if (row.pinned) {
      await unpinRow(row);
      return;
    }
    const tab = row.tabId ? tabById[row.tabId] : null;
    if (!tab) return;
    const link = createLink(tab, 'sidebar');
    await bindPinnedTab(tab.id, link);
    rememberOwnership(tab.id, link.id);
    await commitDurable({
      ...state.durable,
      pinnedItems: insertPinnedItem(
        state.durable.pinnedItems,
        link,
        null,
        sidebarItems(state.durable.pinnedItems).length,
      ),
    });
  };

  const unpinRow = async (row: TabRowViewModel) => {
    if (!row.itemId) return;
    setClosingKeys(keys => [...new Set([...keys, row.key])]);
    await new Promise(resolve => setTimeout(resolve, 150));
    try {
      if (row.tabId) {
        await unbindPinnedTab(row.tabId);
        rememberOwnership(row.tabId, null);
      }
      await commitDurable({
        ...state.durable,
        pinnedItems: removePinnedItem(
          state.durable.pinnedItems,
          row.itemId,
        ).items,
      });
    } finally {
      setClosingKeys(keys => keys.filter(key => key !== row.key));
    }
  };

  const closeTemporaryTabsBelow = async (row: TabRowViewModel) => {
    if (row.pinned || row.tabId == null) return;
    const index = temporaryRows.findIndex(candidate => candidate.tabId === row.tabId);
    if (index < 0) return;
    await closeTemporaryRows(temporaryRows.slice(index + 1));
  };

  const duplicateTab = async (row: TabRowViewModel) => {
    const tab = await createTab(row.url);
    pendingNewTabIds.current.add(tab.id);
    if (!row.pinned && row.tabId != null) {
      temporaryInsertAfterByTabId.current.set(tab.id, row.tabId);
    }
    rememberOwnership(tab.id, null);
    await synchronizeTabs(state.durable);
  };

  const closeTemporaryRows = async (rows: TabRowViewModel[]) => {
    const tabIds = rows.flatMap(row => row.tabId == null ? [] : [row.tabId]);
    if (tabIds.length === 0) return;
    const keys = new Set(rows.map(row => row.key));
    setClosingKeys(current => [...new Set([...current, ...keys])]);
    await new Promise(resolve => setTimeout(resolve, 140));
    try {
      await closeTabsSafely(tabIds);
    } finally {
      setClosingKeys(current => current.filter(key => !keys.has(key)));
    }
  };

  const replacePinnedUrl = async (row: TabRowViewModel) => {
    if (!row.itemId || !row.tabId) return;
    const tab = tabById[row.tabId];
    if (!tab) return;
    const item = findPinnedLink(state.durable.pinnedItems, row.itemId);
    if (!item) return;
    const nextItem = {
      ...item,
      url: tab.url,
      title: item.customTitle ? item.title : tab.title,
    };
    const nextItems = updatePinnedItem(
      state.durable.pinnedItems,
      item.id,
      () => nextItem,
    );
    await bindPinnedTab(tab.id, nextItem);
    await commitDurable({ ...state.durable, pinnedItems: nextItems });
  };

  function createFolder(parentId: string | null, title: string) {
    const folder: PinnedFolder = {
      id: crypto.randomUUID(),
      type: 'folder',
      title,
      children: [],
    };
    dispatch({
      type: 'insertPinnedItem',
      item: folder,
      parentId,
      index: parentId
        ? ((findPinnedItem(state.durable.pinnedItems, parentId) as PinnedFolder)?.children.length || 0)
        : sidebarItems(state.durable.pinnedItems).length,
      placement: 'sidebar',
    });
  }

  const beginCreateFolder = (parentId: string | null) => {
    if (parentId) {
      if (!state.runtime.expandedFolderIds.includes(parentId)) {
        dispatch({ type: 'toggleFolder', folderId: parentId });
      }
    }
    setRenamingKey(`new-folder:${parentId || 'root'}`);
  };

  const requestFolderDeletion = (folderId: string) => {
    const folder = findPinnedItem(state.durable.pinnedItems, folderId);
    if (folder?.type !== 'folder') return;
    setFolderPendingDeletion({ id: folder.id, title: folder.title });
  };

  const confirmFolderDeletion = async () => {
    if (!folderPendingDeletion) return;
    const folderId = folderPendingDeletion.id;
    setFolderPendingDeletion(null);
    await commitDurable({
      ...state.durable,
      pinnedItems: removePinnedItem(state.durable.pinnedItems, folderId).items,
    });
  };

  return (
    <SidebarApp
      status={state.status}
      error={state.error}
      surfaceColor={surfaceColor}
      pinnedItems={state.durable.pinnedItems}
      rowByItemId={rowByItemId}
      temporaryRows={temporaryRows}
      expandedFolderIds={new Set(state.runtime.expandedFolderIds)}
      archivedTabs={archivedTabs}
      archiveOpen={archiveOpen}
      folderPendingDeletion={folderPendingDeletion}
      tabActions={tabActions}
      treeActions={treeActions}
      onDragEnd={handleDragEnd}
      onCleanAll={() => void closeTemporaryRows(temporaryRows)}
      onNewTab={() => void sendRuntimeMessage({ command: 'toggleSpotlightNewTab' })}
      onCancelFolderDeletion={() => setFolderPendingDeletion(null)}
      onConfirmFolderDeletion={() => void confirmFolderDeletion()}
      onToggleArchive={() => setArchiveOpen(value => !value)}
      onRestoreArchive={tab =>
        void (async () => {
          await createTab(tab.url);
          const next = archivedTabs.filter(candidate => candidate !== tab);
          setArchivedTabs(next);
          await saveArchivedTabs(next);
        })()
      }
      onNewFolder={() => beginCreateFolder(null)}
      onOpenSettings={() => void chrome.runtime.openOptionsPage()}
    />
  );
}
