import { Enums } from '@cornerstonejs/core';
import { SynchronizerManager } from '@cornerstonejs/tools';

export const TMTV_SAME_STUDY_CAMERA_TYPE = 'tmtvsamestudycamera';

const validPoint = point => point?.length === 3 && Array.from(point).every(Number.isFinite);

/**
 * 2026-09-01 功能说明：同步同一次检查的定位、方位和翻转，但不复制 parallelScale。
 * 缩放由独立缩放同步器负责，避免滚轮翻页时相机同步与缩放同步重复放大。
 */
export function syncTMTVSameStudyCamera(_sync, source, target, event, { servicesManager } = {}) {
  const camera = event?.detail?.camera;
  const previous = event?.detail?.previousCamera;
  if (!camera || !previous) {
    return;
  }

  const keys = [
    'focalPoint',
    'position',
    'viewUp',
    'viewPlaneNormal',
    'flipHorizontal',
    'flipVertical',
  ];
  if (keys.every(key => JSON.stringify(camera[key]) === JSON.stringify(previous[key]))) {
    return;
  }

  if (
    !validPoint(camera.focalPoint) ||
    !validPoint(camera.position) ||
    !validPoint(camera.viewUp) ||
    !validPoint(camera.viewPlaneNormal)
  ) {
    return;
  }

  const viewportService = servicesManager?.services?.cornerstoneViewportService;
  const targetViewport = viewportService?.getCornerstoneViewport?.(target?.viewportId);
  const current = targetViewport?.getCamera?.();
  if (!targetViewport || !validPoint(current?.focalPoint) || !validPoint(current?.position)) {
    return;
  }

  const patch: any = {
    focalPoint: [...camera.focalPoint],
    position: [...camera.position],
    viewUp: [...camera.viewUp],
    viewPlaneNormal: [...camera.viewPlaneNormal],
  };
  for (const flag of ['flipHorizontal', 'flipVertical']) {
    if (typeof camera[flag] === 'boolean') {
      patch[flag] = camera[flag];
    }
  }

  if (Object.keys(patch).every(key => JSON.stringify(patch[key]) === JSON.stringify(current[key]))) {
    return;
  }

  targetViewport.setCamera(patch);
  targetViewport.render?.();
}

/** 2026-09-01 功能说明：使用官方同步器生命周期管理相机事件和视口销毁。 */
export default function createTMTVSameStudyCameraSynchronizer(id, options) {
  return SynchronizerManager.createSynchronizer(
    id,
    Enums.Events.CAMERA_MODIFIED,
    syncTMTVSameStudyCamera,
    options
  );
}
