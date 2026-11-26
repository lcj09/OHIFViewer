import React, { useEffect, useState } from 'react';
import { cache, eventTarget, EVENTS } from '@cornerstonejs/core';

/** 2026-11-25 功能说明：按当前视口关联 volume 的已处理切片数显示真实加载百分比。 */
function ViewportVolumeLoadingProgress({
  viewportId,
  cornerstoneViewportService,
  comparisonGridService,
  aggregateAllViewports = false,
  mode = 'compact',
}) {
  const [progress, setProgress] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;

    /** 2026-11-26 功能说明：按对比网格收集两侧已绑定的体数据，等待未绑定的视口并对共享 volume 去重。 */
    const refreshProgress = () => {
      if (!active) return;
      const comparisonViewports: AppTypes.ViewportGrid.Viewports | undefined =
        comparisonGridService?.getState()?.viewports;
      const viewportIds: string[] = comparisonViewports
        ? Array.from(comparisonViewports.values())
            .filter(viewport => viewport.displaySetInstanceUIDs?.length)
            .map(viewport => viewport.viewportId)
        : aggregateAllViewports
          ? cornerstoneViewportService?.getViewportIds?.() ?? []
          : [viewportId];
      const volumeIds = new Set<string>();
      let hasUnboundViewport = false;
      viewportIds.forEach(id => {
        const viewport = cornerstoneViewportService?.getCornerstoneViewport?.(id);
        const ids: string[] = viewport?.getAllVolumeIds?.() ?? [];
        hasUnboundViewport ||= ids.length === 0;
        ids.forEach(volumeId => volumeIds.add(volumeId));
      });
      if (!volumeIds.size) {
        setProgress(null);
        return;
      }

      let completedPercent = 0;
      volumeIds.forEach(volumeId => {
        const volume = cache.getVolume(volumeId);
        const total = volume?.totalNumFrames || volume?.imageIds?.length || 0;
        if (volume?.loadStatus?.loaded) {
          completedPercent += 100;
        } else if (total > 0) {
          completedPercent += (Math.min(total, volume.framesProcessed ?? 0) / total) * 100;
        }
      });

      const waitingForVolumes = comparisonViewports
        ? hasUnboundViewport
        : aggregateAllViewports && volumeIds.size < 2;
      const nextProgress = Math.max(
        0,
        Math.min(waitingForVolumes ? 99 : 100, Math.floor(completedPercent / volumeIds.size))
      );
      setProgress(current => (current === nextProgress ? current : nextProgress));
    };

    // 2026-11-26 功能说明：合并高频切片进度事件，降低加载期间 React 重渲染开销。
    const onVolumeProgress = () => {
      if (refreshTimer !== null) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        refreshProgress();
      }, 100);
    };
    const onVolumeLoadingCompleted = () => {
      if (refreshTimer !== null) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }
      refreshProgress();
    };
    eventTarget.addEventListener(EVENTS.IMAGE_VOLUME_MODIFIED, onVolumeProgress);
    eventTarget.addEventListener(EVENTS.IMAGE_VOLUME_LOADING_COMPLETED, onVolumeLoadingCompleted);
    const layoutSubscription = comparisonGridService?.subscribe(
      comparisonGridService.EVENTS.GRID_STATE_CHANGED,
      onVolumeProgress
    );
    const volumesSubscription = comparisonGridService
      ? cornerstoneViewportService.subscribe(
          cornerstoneViewportService.EVENTS.VIEWPORT_VOLUMES_CHANGED,
          onVolumeProgress
        )
      : undefined;
    refreshProgress();

    return () => {
      active = false;
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      layoutSubscription?.unsubscribe();
      volumesSubscription?.unsubscribe();
      eventTarget.removeEventListener(EVENTS.IMAGE_VOLUME_MODIFIED, onVolumeProgress);
      eventTarget.removeEventListener(
        EVENTS.IMAGE_VOLUME_LOADING_COMPLETED,
        onVolumeLoadingCompleted
      );
    };
  }, [aggregateAllViewports, comparisonGridService, cornerstoneViewportService, viewportId]);

  if (progress === null || progress >= 100) return null;

  const isBlocking = mode === 'blocking';
  const containerClassName = isBlocking
    ? 'fixed inset-0 z-[100] flex items-center justify-center bg-black/80 text-white'
    : 'pointer-events-none fixed right-4 top-20 z-[100] w-56 rounded-md bg-black/70 px-3 py-2 text-white shadow';
  const contentClassName = isBlocking
    ? 'w-72 rounded-lg bg-black/70 px-5 py-4 shadow-xl'
    : '';

  return (
    <div className={containerClassName}>
      <div className={contentClassName}>
        <div className={isBlocking ? 'mb-2 text-sm' : 'mb-1 text-xs'}>正在加载图像</div>
        <div
        className={
          isBlocking
            ? 'h-2 overflow-hidden rounded bg-white/30'
            : 'h-1.5 overflow-hidden rounded bg-white/30'
        }
          role="progressbar"
          aria-label="图像加载进度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <div
            className="h-full rounded bg-primary transition-[width] duration-150"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
    </div>
  );
}

export default ViewportVolumeLoadingProgress;
