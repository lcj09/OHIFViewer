import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { tmtvTabStore, TmtvTab } from './TmtvTabStore';

/**
 * TMTV 多 Tab React Context
 * 基于全局 Store，支持在 React 组件和 mode 生命周期中共享状态
 */

interface TmtvTabContextValue {
  tabs: TmtvTab[];
  activeTabId: string | null;
  activeTab: TmtvTab | null;
  addTab: (tab: Omit<TmtvTab, 'id'>) => string;
  removeTab: (tabId: string) => void;
  switchTab: (tabId: string) => void;
  updateTab: (tabId: string, updates: Partial<TmtvTab>) => void;
}

const TmtvTabContext = createContext<TmtvTabContextValue | null>(null);

export function TmtvTabProvider({ children }: { children: React.ReactNode }) {
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    const unsub = tmtvTabStore.subscribe(() => forceUpdate(n => n + 1));
    return unsub;
  }, []);

  const addTab = useCallback((tab: Omit<TmtvTab, 'id'>) => tmtvTabStore.addTab(tab), []);
  const removeTab = useCallback((tabId: string) => tmtvTabStore.removeTab(tabId), []);
  const switchTab = useCallback((tabId: string) => tmtvTabStore.switchTab(tabId), []);
  const updateTab = useCallback((tabId: string, updates: Partial<TmtvTab>) => tmtvTabStore.updateTab(tabId, updates), []);

  return (
    <TmtvTabContext.Provider
      value={{
        tabs: tmtvTabStore.getTabs(),
        activeTabId: tmtvTabStore.getActiveTabId(),
        activeTab: tmtvTabStore.getActiveTab(),
        addTab,
        removeTab,
        switchTab,
        updateTab,
      }}
    >
      {children}
    </TmtvTabContext.Provider>
  );
}

export function useTmtvTabs(): TmtvTabContextValue {
  const ctx = useContext(TmtvTabContext);
  if (!ctx) {
    throw new Error('useTmtvTabs must be used within TmtvTabProvider');
  }
  return ctx;
}

export { tmtvTabStore };
export type { TmtvTab };
