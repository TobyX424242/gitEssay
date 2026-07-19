/**
 * gitEssay — chat + versions side-panel stores.
 *
 * Both docks use the shared createSidePanelStore (open + persisted width +
 * collapse-on-shrink). Named back-compat exports keep the existing call sites
 * (ChatSidebar, the app bar) working; new code can import the store objects
 * directly.
 *
 * The left dock's TAB (versions | literature) is a tiny shared store too, so
 * the app bar and the edge reopen tabs can deep-link into the Literature tab.
 */
import {useSyncExternalStore} from 'react';

import {
  createSidePanelStore,
  useSidePanel,
  type SidePanelStore,
} from '../ui/sidePanelStore';

/** Right dock — AI chat. */
export const chatPanel: SidePanelStore = createSidePanelStore({
  storageKey: 'gitessay-chat-panel',
  defaultOpen: true,
  defaultWidth: 400,
  // Low rest minimum so the dock can be dragged narrow and left there (a
  // temporary "fold" you pull back by dragging). It only closes when dragged
  // essentially shut (≤ collapseAt).
  minWidth: 120,
  maxWidth: 720,
  collapseAt: 134,
});

/** Left dock — checkpoints / versions. */
export const versionsPanel: SidePanelStore = createSidePanelStore({
  storageKey: 'gitessay-versions-panel',
  defaultOpen: false,
  defaultWidth: 340,
  minWidth: 100,
  maxWidth: 560,
  collapseAt: 114,
});

// --- chat back-compat named exports ---
export const openPanel = (): void => chatPanel.open();
export const closePanel = (): void => chatPanel.close();
export const togglePanel = (): void => chatPanel.toggle();
export const isPanelOpen = (): boolean => chatPanel.getState().open;
export const usePanelOpen = (): boolean => useSidePanel(chatPanel).open;
export const usePanelWidth = (): number => useSidePanel(chatPanel).width;
export const setPanelWidth = (w: number): void => chatPanel.setWidth(w);

// --- left dock tab (versions | literature) ---------------------------------
export type LeftDockTab = 'versions' | 'literature';

let leftTab: LeftDockTab = 'versions';
const tabListeners = new Set<() => void>();

export function setLeftDockTab(t: LeftDockTab): void {
  if (leftTab !== t) {
    leftTab = t;
    tabListeners.forEach(l => l());
  }
}

function subscribeTab(fn: () => void): () => void {
  tabListeners.add(fn);
  return () => {
    tabListeners.delete(fn);
  };
}

/** Reactive left-dock tab. */
export function useLeftDockTab(): LeftDockTab {
  return useSyncExternalStore(
    subscribeTab,
    () => leftTab,
    () => leftTab,
  );
}

/** Open the left dock directly on a given tab (app bar / edge tabs). */
export function openLeftDock(tab: LeftDockTab): void {
  setLeftDockTab(tab);
  versionsPanel.open();
}
