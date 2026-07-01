import React, { useEffect, useCallback } from 'react';
import { tmtvTabStore } from './TmtvTabStore';
import { getDisplaySetInstanceUIDsForSeries, getViewportDisplaySetMapping } from './seriesToDisplaySets';

interface TabSwitcherProps {
  servicesManager: any;
}

/**
 * Tab 切换控制器
 * 监听 activeTab 变化，自动切换 viewport 中的 display sets
 */
const TabSwitcher: React.FC<TabSwitcherProps> = ({ servicesManager }) => {
  const { viewportGridService, displaySetService } = servicesManager.services;

  const switchDisplaySets = useCallback((tab) => {
    if (!tab) return;

    console.log('[TmtvTabs] Switching to tab:', tab.id, tab.ctDescription, tab.ptDescription);

    const mapping = getDisplaySetInstanceUIDsForSeries(
      displaySetService,
      tab.ctSeriesInstanceUid,
      tab.ptSeriesInstanceUid
    );

    if (!mapping) {
      console.error('[TmtvTabs] Failed to get display set mapping for tab:', tab);
      return;
    }

    const { ctDisplaySetUID, ptDisplaySetUID } = mapping;
    const viewportMappings = getViewportDisplaySetMapping(ctDisplaySetUID, ptDisplaySetUID);

    viewportGridService.setDisplaySetsForViewports(viewportMappings);
    console.log('[TmtvTabs] Display sets switched successfully');
  }, [viewportGridService, displaySetService]);

  useEffect(() => {
    const unsub = tmtvTabStore.subscribe(() => {
      const tab = tmtvTabStore.getActiveTab();
      if (tab) {
        switchDisplaySets(tab);
      }
    });
    return unsub;
  }, [switchDisplaySets]);

  return null;
};

export default TabSwitcher;
