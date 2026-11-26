import { cache, Enums, eventTarget, EVENTS } from '@cornerstonejs/core';

/** 2026-11-25 功能说明：PT 首屏切片达到流式重绘阈值后开启矢状 MIP，后续数据继续渐进补全投影。 */
export default function installDeferredMIPSagittal({ cornerstoneViewportService, viewportGridService }) {
  let disposed = false;
  let checkTimer: ReturnType<typeof setTimeout> | null = null;

  const applyWhenPTIsLoaded = () => {
    if (disposed) return;

    const viewport = cornerstoneViewportService?.getCornerstoneViewport?.('mipSagittal');
    if (!viewport) return;
    if (viewport.getBlendMode?.() === Enums.BlendModes.MAXIMUM_INTENSITY_BLEND) return;

    const volumeIds = viewport.getAllVolumeIds?.() ?? [];
    // mipSagittal is bound to ptDisplaySet by the TMTV hanging protocol, so its first volume is PT.
    const ptVolume = volumeIds.map(volumeId => cache.getVolume(volumeId)).find(Boolean);

    if (!ptVolume) return;
    const totalFrames = ptVolume.totalNumFrames || ptVolume.imageIds?.length || 0;
    const firstRenderFrameCount = Math.ceil(totalFrames * 0.02) + 1;
    if (!ptVolume.loadStatus?.loaded && (ptVolume.framesProcessed ?? 0) < firstRenderFrameCount) {
      return;
    }

    try {
      viewport.setBlendMode?.(Enums.BlendModes.MAXIMUM_INTENSITY_BLEND, [], false);
      viewport.render?.();
    } catch (error) {
      console.warn('[TMTV] Deferred MIP activation failed', error);
    }
  };

  const scheduleCheck = () => {
    if (disposed || checkTimer !== null) return;
    checkTimer = setTimeout(() => {
      checkTimer = null;
      applyWhenPTIsLoaded();
    }, 0);
  };

  const onVolumeModified = () => scheduleCheck();
  eventTarget.addEventListener(EVENTS.IMAGE_VOLUME_MODIFIED, onVolumeModified);

  const readyEvent = viewportGridService?.EVENTS?.VIEWPORTS_READY;
  const readySubscription = readyEvent
    ? viewportGridService.subscribe(readyEvent, scheduleCheck)
    : null;
  scheduleCheck();

  return {
    /** 2026-11-25 功能说明：幂等移除事件订阅与待执行检查，避免模式退出后保留服务引用。 */
    dispose() {
      if (disposed) return;
      disposed = true;
      eventTarget.removeEventListener(EVENTS.IMAGE_VOLUME_MODIFIED, onVolumeModified);
      readySubscription?.unsubscribe?.();
      if (checkTimer !== null) {
        clearTimeout(checkTimer);
        checkTimer = null;
      }
    },
  };
}
