/**
 * 根据 seriesInstanceUid 从 DisplaySetService 获取对应的 displaySetInstanceUID
 * 用于 Tab 切换时快速定位 display set
 */
export function getDisplaySetInstanceUIDsForSeries(
  displaySetService: any,
  ctSeriesInstanceUid: string,
  ptSeriesInstanceUid: string
): { ctDisplaySetUID: string; ptDisplaySetUID: string } | null {
  const activeDisplaySets = displaySetService.getActiveDisplaySets();

  console.log('[TmtvTabs] Searching for display sets:', {
    ctSeriesInstanceUid,
    ptSeriesInstanceUid,
    totalDisplaySets: activeDisplaySets.length,
  });

  let ctDisplaySetUID: string | null = null;
  let ptDisplaySetUID: string | null = null;

  for (const ds of activeDisplaySets) {
    const seriesUid = ds.SeriesInstanceUID || ds.seriesInstanceUid;
    
    // 尝试多种方式获取 display set UID
    const dsUID = ds.displaySetInstanceUID 
      || ds.DisplaySetInstanceUID 
      || ds.uid 
      || ds.id
      || ds.DisplaySetInstanceUid;

    console.log('[TmtvTabs] Checking display set:', {
      seriesUid,
      dsUID,
      modality: ds.Modality || ds.modality,
      matchesCT: seriesUid === ctSeriesInstanceUid,
      matchesPT: seriesUid === ptSeriesInstanceUid,
    });

    if (seriesUid === ctSeriesInstanceUid) {
      ctDisplaySetUID = dsUID;
      console.log('[TmtvTabs] Found CT display set:', dsUID);
    } else if (seriesUid === ptSeriesInstanceUid) {
      ptDisplaySetUID = dsUID;
      console.log('[TmtvTabs] Found PT display set:', dsUID);
    }
  }

  if (!ctDisplaySetUID || !ptDisplaySetUID) {
    console.warn(`[TmtvTabs] Display sets not found for series: CT=${ctSeriesInstanceUid}, PT=${ptSeriesInstanceUid}`);
    console.log('[TmtvTabs] All display sets:', activeDisplaySets.map(ds => ({
      uid: ds.SeriesInstanceUID || ds.seriesInstanceUid,
      modality: ds.Modality || ds.modality,
      dsUID: ds.displaySetInstanceUID || ds.DisplaySetInstanceUID || ds.uid || ds.id,
    })));
    return null;
  }

  return { ctDisplaySetUID, ptDisplaySetUID };
}

/**
 * 获取 viewport 到 display set 的映射配置
 * 用于 setDisplaySetsForViewports 调用
 */
export function getViewportDisplaySetMapping(
  ctDisplaySetUID: string,
  ptDisplaySetUID: string
): Array<{ viewportId: string; displaySetInstanceUIDs: string[] }> {
  return [
    {
      viewportId: 'ctAXIAL',
      displaySetInstanceUIDs: [ctDisplaySetUID],
    },
    {
      viewportId: 'ctSAGITTAL',
      displaySetInstanceUIDs: [ctDisplaySetUID],
    },
    {
      viewportId: 'ctCORONAL',
      displaySetInstanceUIDs: [ctDisplaySetUID],
    },
    {
      viewportId: 'ptAXIAL',
      displaySetInstanceUIDs: [ptDisplaySetUID],
    },
    {
      viewportId: 'ptSAGITTAL',
      displaySetInstanceUIDs: [ptDisplaySetUID],
    },
    {
      viewportId: 'ptCORONAL',
      displaySetInstanceUIDs: [ptDisplaySetUID],
    },
    {
      viewportId: 'fusionAXIAL',
      displaySetInstanceUIDs: [ctDisplaySetUID, ptDisplaySetUID],
    },
    {
      viewportId: 'fusionSAGITTAL',
      displaySetInstanceUIDs: [ctDisplaySetUID, ptDisplaySetUID],
    },
    {
      viewportId: 'fusionCoronal',
      displaySetInstanceUIDs: [ctDisplaySetUID, ptDisplaySetUID],
    },
    {
      viewportId: 'mipSagittal',
      displaySetInstanceUIDs: [ptDisplaySetUID],
    },
  ];
}
