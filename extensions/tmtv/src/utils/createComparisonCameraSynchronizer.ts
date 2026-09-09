import { Enums } from '@cornerstonejs/core';
import { SynchronizerManager } from '@cornerstonejs/tools';
import initialState from '../services/TMTVComparisonInitialState';

export const COMPARISON_CAMERA_TYPE = 'tmtvComparisonCamera';
const applying = new WeakSet<object>();
const validPoint = point => point?.length === 3 && Array.from(point).every(Number.isFinite);
const pointsDiffer = (first, second) =>
  !validPoint(first) ||
  !validPoint(second) ||
  first.some((value, index) => Math.abs(value - second[index]) > 1e-6);

const getDistance = (first, second) =>
  Math.sqrt(first.reduce((sum, value, index) => sum + (value - second[index]) ** 2, 0));
const dot = (first, second) => first.reduce((sum, value, index) => sum + value * second[index], 0);
const cross = (first, second) => [
  first[1] * second[2] - first[2] * second[1],
  first[2] * second[0] - first[0] * second[2],
  first[0] * second[1] - first[1] * second[0],
];
const normalize = point => {
  if (!validPoint(point)) return null;
  const length = Math.sqrt(dot(point, point));
  return Number.isFinite(length) && length > 1e-8 ? point.map(value => value / length) : null;
};
const getCameraBasis = camera => {
  const normal = normalize(camera?.viewPlaneNormal);
  const right = normal && normalize(cross(camera?.viewUp, normal));
  const up = right && normalize(cross(normal, right));
  return normal && right && up ? { right, up, normal } : null;
};
const applyBasisRotation = (point, from, to) => {
  if (!validPoint(point) || !from || !to) return null;
  const coordinates = [dot(point, from.right), dot(point, from.up), dot(point, from.normal)];
  return to.right.map(
    (value, index) =>
      value * coordinates[0] + to.up[index] * coordinates[1] + to.normal[index] * coordinates[2]
  );
};

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
    const previous = event.detail?.previousCamera;
    const mipRotation =
      mip &&
      previous &&
      (pointsDiffer(previous.viewUp, camera.viewUp) ||
        pointsDiffer(previous.viewPlaneNormal, camera.viewPlaneNormal));
    if (mipRotation) {
      const distance = getDistance(current.position, current.focalPoint);
      const previousBasis = getCameraBasis(previous);
      const sourceBasis = getCameraBasis(camera);
      const targetNormal = applyBasisRotation(current.viewPlaneNormal, previousBasis, sourceBasis);
      const targetUp = applyBasisRotation(current.viewUp, previousBasis, sourceBasis);
      if (
        !Number.isFinite(distance) ||
        distance <= 0 ||
        !validPoint(targetNormal) ||
        !validPoint(targetUp)
      )
        return;
      // 2026-09-08 功能说明：MIP 只同步本次旋转增量，保留目标检查自己的方向基准、中心和观察距离。
      patch.focalPoint = [...current.focalPoint];
      patch.position = current.focalPoint.map(
        (value, index) => value + targetNormal[index] * distance
      );
      patch.viewUp = targetUp;
      // 2026-09-08 功能说明：与 Cornerstone 原生旋转一致，由 position-focalPoint 推导法向，避免重复方向输入触发 VTK 相机校正。
    } else {
      patch.position = camera.position.map((value, i) => value + offset[i]);
      patch.viewUp = [...camera.viewUp];
      patch.viewPlaneNormal = [...camera.viewPlaneNormal];
    }
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
  return SynchronizerManager.createSynchronizer(
    id,
    Enums.Events.CAMERA_MODIFIED,
    syncComparisonCamera,
    options
  );
}
