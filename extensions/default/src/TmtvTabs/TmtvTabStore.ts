/**
 * TMTV 多 Tab 全局 Store
 * 使用事件驱动模式，可在 React 组件内外共享状态
 */

export interface TmtvTab {
  id: string;
  studyInstanceUid: string;
  ctSeriesInstanceUid: string;
  ptSeriesInstanceUid: string;
  ctDescription: string;
  ptDescription: string;
  patientName?: string;
}

type Listener = () => void;

let tabIdCounter = 0;
function generateTabId(): string {
  return `tmtv-tab-${++tabIdCounter}-${Date.now()}`;
}

class TmtvTabStore {
  private tabs: TmtvTab[] = [];
  private activeTabId: string | null = null;
  private listeners: Set<Listener> = new Set();

  getTabs(): TmtvTab[] {
    return this.tabs;
  }

  getActiveTabId(): string | null {
    return this.activeTabId;
  }

  getActiveTab(): TmtvTab | null {
    return this.tabs.find(t => t.id === this.activeTabId) || null;
  }

  addTab(tabData: Omit<TmtvTab, 'id'>): string {
    const id = generateTabId();
    const newTab: TmtvTab = { ...tabData, id };
    this.tabs = [...this.tabs, newTab];
    if (this.tabs.length === 1) {
      this.activeTabId = id;
    }
    this.emit();
    return id;
  }

  removeTab(tabId: string): void {
    const idx = this.tabs.findIndex(t => t.id === tabId);
    if (idx === -1) return;
    this.tabs = this.tabs.filter(t => t.id !== tabId);
    if (tabId === this.activeTabId) {
      if (this.tabs.length > 0) {
        const newIdx = Math.min(idx, this.tabs.length - 1);
        this.activeTabId = this.tabs[newIdx].id;
      } else {
        this.activeTabId = null;
      }
    }
    this.emit();
  }

  switchTab(tabId: string): void {
    this.activeTabId = tabId;
    this.emit();
  }

  updateTab(tabId: string, updates: Partial<TmtvTab>): void {
    this.tabs = this.tabs.map(t => (t.id === tabId ? { ...t, ...updates } : t));
    this.emit();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    this.listeners.forEach(fn => fn());
  }
}

// 全局单例
export const tmtvTabStore = new TmtvTabStore();
