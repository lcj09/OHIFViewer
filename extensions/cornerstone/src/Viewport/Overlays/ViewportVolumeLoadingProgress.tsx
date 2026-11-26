import React, { useEffect, useState } from 'react';
import { cache, eventTarget, EVENTS } from '@cornerstonejs/core';

/** 2026-11-25 功能说明：按当前视口关联 volume 的已处理切片数显示真实加载百分比。 */
function ViewportVolumeLoadingProgress({
  viewportId,
  cornerstoneViewportService,
  aggregateAllViewports = false,
  mode = 'compact',
}) {
  const [progress, setProgress] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;

    const refreshProgress = () => {
      if (!active) return;
      const viewportIds = aggregateAllViewports
        ? cornerstoneViewportService?.getViewportIds?.() ?? []
        : [viewportId];
      const volumeIds = Array.from(
        new Set(
          viewportIds.flatMap(id => {
            const viewport = cornerstoneViewportService?.getCornerstoneViewport?.(id);
            return viewport?.getAllVolumeIds?.() ?? [];
          })
        )
      );
      if (!volumeIds.length) return;

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

      let nextProgress = Math.max(0, Math.min(100, Math.round(completedPercent / volumeIds.length)));
      // TMTV requires both CT and PT; keep the global overlay until both unique volumes are known.
      if (aggregateAllViewports && volumeIds.length < 2) nextProgress = Math.min(nextProgress, 99);
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
    refreshProgress();

    return () => {
      active = false;
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      eventTarget.removeEventListener(EVENTS.IMAGE_VOLUME_MODIFIED, onVolumeProgress);
      eventTarget.removeEventListener(
        EVENTS.IMAGE_VOLUME_LOADING_COMPLETED,
        onVolumeLoadingCompleted
      );
    };
  }, [aggregateAllViewports, cornerstoneViewportService, viewportId]);

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
