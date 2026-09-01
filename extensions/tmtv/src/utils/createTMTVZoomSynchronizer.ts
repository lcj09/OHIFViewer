import { Enums } from '@cornerstonejs/core';
import { SynchronizerManager } from '@cornerstonejs/tools';

// SyncGroupService 创建同步器时会把 type 转为小写查找，注册键必须保持小写。
export const TMTV_ZOOM_TYPE = 'tmtvzoom';

const validScale = value => Number.isFinite(value) && value > 0;

/**
 * 2026-09-01 功能说明：仅同步真实缩放事件，并按源视口初始相机计算归一化 zoom。
 * 滚轮翻页、MIP 旋转和定位产生的 CAMERA_MODIFIED 不应重复调用 setZoom。
 */
export function syncTMTVZoom(_sync, source, target, event, { servicesManager } = {}) {
  const currentScale = event?.detail?.camera?.parallelScale;
  const previousScale = event?.detail?.previousCamera?.parallelScale;
  if (!validScale(currentScale) || !validScale(previousScale) || currentScale === previousScale) {
    return;
  }

  const viewportService = servicesManager?.services?.cornerstoneViewportService;
  const sourceViewport = viewportService?.getCornerstoneViewport?.(source?.viewportId);
  const targetViewport = viewportService?.getCornerstoneViewport?.(target?.viewportId);
  if (!sourceViewport || !targetViewport) {
    return;
  }

  // 事件必须仍对应当前源相机，避免布局重建后把旧事件应用到新视口。
  const liveSourceScale = sourceViewport.getCamera?.()?.parallelScale;
  const targetScale = targetViewport.getCamera?.()?.parallelScale;
  const sourceInitialScale = sourceViewport.initialCamera?.parallelScale;
  const targetInitialScale = targetViewport.initialCamera?.parallelScale;
  if (
    !validScale(liveSourceScale) ||
    !validScale(targetScale) ||
    !validScale(sourceInitialScale) ||
    !validScale(targetInitialScale)
  ) {
    return;
  }

  const tolerance = Math.max(1, Math.abs(currentScale)) * Number.EPSILON * 16;
  if (Math.abs(liveSourceScale - currentScale) > tolerance) {
    return;
  }

  // 使用绝对归一化 zoom，确保 cameraPosition 与缩放同步器先后触发时结果仍幂等。
  const sourceZoom = sourceInitialScale / currentScale;
  const nextScale = targetInitialScale / sourceZoom;
  const targetTolerance = Math.max(1, Math.abs(targetScale)) * Number.EPSILON * 16;
  if (
    !validScale(sourceZoom) ||
    !validScale(nextScale) ||
    Math.abs(nextScale - targetScale) <= targetTolerance
  ) {
    return;
  }

  targetViewport.setCamera({ parallelScale: nextScale });
  targetViewport.render?.();
}

/** 2026-09-01 功能说明：使用官方同步器生命周期管理监听和视口销毁。 */
export default function createTMTVZoomSynchronizer(id, options) {
  return SynchronizerManager.createSynchronizer(
    id,
    Enums.Events.CAMERA_MODIFIED,
    syncTMTVZoom,
    options
  );
}
