import { eventTarget } from '@cornerstonejs/core';
import { Enums as csToolsEnums } from '@cornerstonejs/tools';

const cloneVector = value => (Array.isArray(value) ? [...value] : value);

const cloneCamera = camera =>
  camera
    ? {
        ...camera,
        focalPoint: cloneVector(camera.focalPoint),
        position: cloneVector(camera.position),
        viewPlaneNormal: cloneVector(camera.viewPlaneNormal),
        viewUp: cloneVector(camera.viewUp),
      }
    : null;

const waitForSegmentationRendered = (viewportId: string, segmentationId: string) => {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let settled = false;
  let resolvePromise: () => void = () => {};

  const cleanup = () => {
    eventTarget.removeEventListener(csToolsEnums.Events.SEGMENTATION_RENDERED, onRendered);
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = null;
  };
  const finish = () => {
    if (settled) return;
    settled = true;
    cleanup();
    resolvePromise();
  };
  const onRendered = event => {
    const detail = event?.detail;
    if (detail?.viewportId === viewportId && detail?.segmentationId === segmentationId) finish();
  };
  const promise = new Promise<void>(resolve => {
    resolvePromise = resolve;
    eventTarget.addEventListener(csToolsEnums.Events.SEGMENTATION_RENDERED, onRendered);
    // 销毁或隐藏视口可能不发渲染事件，超时仅用于释放监听器并继续异常收尾。
    timeoutId = setTimeout(finish, 1000);
  });

  return { promise, cancel: finish };
};

/** 2026-09-02 功能说明：添加分割 actor 时保持目标视口相机，并阻止临时缩放通过同步器传播。 */
export default async function addSegmentationRepresentationPreservingCamera(
  servicesManager,
  viewportId: string,
  segmentationId: string,
  representationOptions: Record<string, unknown> = {}
): Promise<void> {
  const { cornerstoneViewportService, segmentationService, syncGroupService } =
    servicesManager?.services || {};
  const viewport = cornerstoneViewportService?.getCornerstoneViewport?.(viewportId);
  const representation = { ...representationOptions, segmentationId };

  if (!viewport) {
    await segmentationService.addSegmentationRepresentation(viewportId, representation);
    return;
  }

  const camera = cloneCamera(viewport.getCamera?.());
  const initialCamera = cloneCamera(viewport.initialCamera);
  const enabledSynchronizers = new Set<any>();

  for (const synchronizer of syncGroupService?.getSynchronizersForViewport?.(viewportId) || []) {
    if (synchronizer?.isDisabled?.() === true || enabledSynchronizers.has(synchronizer)) continue;
    enabledSynchronizers.add(synchronizer);
    synchronizer.setEnabled(false);
  }

  const rendered = waitForSegmentationRendered(viewportId, segmentationId);
  try {
    await segmentationService.addSegmentationRepresentation(viewportId, representation);
    await rendered.promise;
  } finally {
    rendered.cancel();
    // 异步期间布局可能替换视口；只恢复原对象，避免旧请求修改新布局。
    const currentViewport = cornerstoneViewportService?.getCornerstoneViewport?.(viewportId);
    if (currentViewport === viewport) {
      if (camera) viewport.setCamera?.(camera);
      if (initialCamera) {
        if (viewport.setInitialCamera) viewport.setInitialCamera(initialCamera);
        else viewport.initialCamera = initialCamera;
      }
      viewport.render?.();
    }

    enabledSynchronizers.forEach(synchronizer => {
      try {
        synchronizer.setEnabled(true);
      } catch {
        // 布局退出时同步器可能已经销毁。
      }
    });
  }
}
