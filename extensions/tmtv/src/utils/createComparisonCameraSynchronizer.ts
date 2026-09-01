import { Enums } from '@cornerstonejs/core';
import { SynchronizerManager } from '@cornerstonejs/tools';
import initialState from '../services/TMTVComparisonInitialState';

export const COMPARISON_CAMERA_TYPE = 'tmtvComparisonCamera';
const applying = new WeakSet<object>();
const validPoint = point => point?.length === 3 && Array.from(point).every(Number.isFinite);

/** 2026-08-31 功能说明：按各自初始中心映射相机，保留目标缩放；跨组回传只处理一次，不复制测量。 */
export function syncComparisonCamera(_sync, source, target, event, { servicesManager }) {
  if (!servicesManager || applying.has(servicesManager)) return;
  const {
    cornerstoneViewportService: service,
    customizationService,
    hangingProtocolService,
  } = servicesManager.services;
  const settings = customizationService?.getCustomization?.('syncSettings') || {};
  if (
    settings.comparisonStudySync !== true ||
    hangingProtocolService?.getActiveProtocol?.()?.protocol?.id !==
      '@ohif/extension-tmtv.hangingProtocolModule.ptCTCompare'
  )
    return;
  const sourceSide = source.viewportId.startsWith('baseline') ? 'baseline' : 'followup';
  const targetSide = target.viewportId.startsWith('baseline') ? 'baseline' : 'followup';
  if (sourceSide === targetSide) return;
  const mip = source.viewportId.includes('MIP');
  const anchorSuffix = mip ? 'MIPSagittal' : 'CTAxial';
  const sourceAnchor = initialState.get(
    service.getCornerstoneViewport(`${sourceSide}${anchorSuffix}`)
  )?.camera?.focalPoint;
  const targetAnchor = initialState.get(
    service.getCornerstoneViewport(`${targetSide}${anchorSuffix}`)
  )?.camera?.focalPoint;
  const viewport = service.getCornerstoneViewport(target.viewportId);
  const sourceViewport = service.getCornerstoneViewport(source.viewportId);
  const sourceFOR = sourceViewport?.getFrameOfReferenceUID?.();
  const sharedFOR = sourceFOR && sourceFOR === viewport?.getFrameOfReferenceUID?.();
  const camera = event.detail?.camera;
  const current = viewport?.getCamera?.();
  if (
    ![camera?.focalPoint, camera?.position, current?.focalPoint, current?.position].every(
      validPoint
    )
  )
    return;
  if (!sharedFOR && ![sourceAnchor, targetAnchor].every(validPoint)) return;
  const offset = sharedFOR ? [0, 0, 0] : targetAnchor.map((value, i) => value - sourceAnchor[i]);
  const focalPoint = camera.focalPoint.map((value, i) => value + offset[i]);
  const patch: any = { focalPoint };
  if (settings.orientationSync !== false) {
    if (!validPoint(camera.viewUp) || !validPoint(camera.viewPlaneNormal)) return;
    patch.position = camera.position.map((value, i) => value + offset[i]);
    patch.viewUp = [...camera.viewUp];
    patch.viewPlaneNormal = [...camera.viewPlaneNormal];
    for (const flag of ['flipHorizontal', 'flipVertical']) {
      if (typeof camera[flag] === 'boolean') patch[flag] = camera[flag];
    }
  } else {
    patch.position = current.position.map(
      (value, i) => value + focalPoint[i] - current.focalPoint[i]
    );
  }
  // 缩放只由独立 zoompan 组负责；只变更 parallelScale 的事件不能重新定位目标。
  const previous = event.detail?.previousCamera;
  if (
    previous &&
    ['focalPoint', 'position', 'viewUp', 'viewPlaneNormal', 'flipHorizontal', 'flipVertical'].every(
      key => JSON.stringify(previous[key]) === JSON.stringify(camera[key])
    )
  )
    return;
  if (!validPoint(patch.focalPoint) || !validPoint(patch.position)) return;
  if (Object.keys(patch).every(key => JSON.stringify(patch[key]) === JSON.stringify(current[key])))
    return;
  applying.add(servicesManager);
  try {
    viewport.setCamera(patch);
    viewport.render();
  } finally {
    applying.delete(servicesManager);
  }
}

/** 2026-08-31 功能说明：使用官方同步器生命周期，支持重置/十字线临时暂停及模式退出销毁。 */
export default function createComparisonCameraSynchronizer(id, options) {
  return SynchronizerManager.createSynchronizer(id, Enums.Events.CAMERA_MODIFIED, syncComparisonCamera, options);
}
