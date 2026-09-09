const MIP_VIEWPORT_IDS = ['baselineMIPSagittal', 'followupMIPSagittal'];
const CAMERA_VECTOR_KEYS = ['focalPoint', 'position', 'viewUp', 'viewPlaneNormal'];

const copyCameraTransform = camera => {
  if (!camera) return null;
  return CAMERA_VECTOR_KEYS.reduce((result, key) => {
    if (Array.isArray(camera[key]) && camera[key].every(Number.isFinite))
      result[key] = [...camera[key]];
    return result;
  }, {});
};

const vectorsDiffer = (first, second) =>
  first?.length !== second?.length || first?.some((value, index) => value !== second[index]);
const cameraTransformChanged = (camera, transform) =>
  Object.entries(transform).some(([key, value]) => vectorsDiffer(camera?.[key], value));
const getActorSignature = viewport => {
  const ids = (viewport?.getActors?.() || [])
    .map(actor => actor?.referencedId || actor?.uid)
    .filter(Boolean);
  return ids.length ? ids.join('|') : null;
};

const pauseSynchronizers = (syncGroupService, viewportIds) => {
  const synchronizers = new Set<any>();
  viewportIds.forEach(viewportId => {
    (syncGroupService?.getSynchronizersForViewport?.(viewportId) || []).forEach(synchronizer => {
      if (synchronizers.has(synchronizer) || synchronizer.isDisabled?.()) return;
      synchronizers.add(synchronizer);
      synchronizer.setEnabled?.(false);
    });
  });
  return synchronizers;
};

const restoreSynchronizers = synchronizers => {
  synchronizers.forEach(synchronizer => {
    try {
      synchronizer.setEnabled?.(true);
    } catch {
      // 布局退出时同步器可能已经销毁。
    }
  });
};

export type ComparisonMIPResizeGuard = {
  capture: () => void;
  restore: () => void;
  dispose: () => void;
};

/** 2026-09-08 功能说明：跨布局重建保存 MIP 相机，并在 resize 期间保护旋转中心和朝向。 */
export default function installComparisonMIPResizeGuard(
  servicesManager: any,
  isComparisonActive: () => boolean
): ComparisonMIPResizeGuard {
  const { cornerstoneViewportService, syncGroupService } = servicesManager?.services || {};
  const originalPerformResize = cornerstoneViewportService?.performResize;
  const savedTransforms = new Map<string, { transform: any; actorSignature: string | null }>();

  const capture = () => {
    if (!isComparisonActive()) return;
    MIP_VIEWPORT_IDS.forEach(viewportId => {
      try {
        const viewport = cornerstoneViewportService?.getCornerstoneViewport?.(viewportId);
        const transform = copyCameraTransform(viewport?.getCamera?.());
        if (viewport && transform && Object.keys(transform).length) {
          savedTransforms.set(viewportId, {
            transform,
            actorSignature: getActorSignature(viewport),
          });
        }
      } catch {
        // 布局销毁中的视口按缺失处理。
      }
    });
  };

  const restore = () => {
    if (!isComparisonActive() || !savedTransforms.size) return;
    const pending: { viewport: any; transform: any }[] = [];
    savedTransforms.forEach(({ transform, actorSignature }, viewportId) => {
      try {
        const viewport = cornerstoneViewportService?.getCornerstoneViewport?.(viewportId);
        const currentSignature = getActorSignature(viewport);
        if (
          !viewport ||
          (actorSignature && currentSignature && actorSignature !== currentSignature) ||
          !cameraTransformChanged(viewport.getCamera?.(), transform)
        )
          return;
        pending.push({ viewport, transform });
      } catch {
        // 尚未完成重建的视口等待下一次 Volume 或尺寸事件。
      }
    });
    const synchronizers = pauseSynchronizers(syncGroupService, MIP_VIEWPORT_IDS);
    try {
      pending.forEach(({ viewport, transform }) => {
        viewport.setCamera?.(transform);
        viewport.render?.();
      });
    } finally {
      restoreSynchronizers(synchronizers);
    }
  };

  const guardedPerformResize = function (...args) {
    if (!isComparisonActive()) return originalPerformResize.apply(this, args);
    const currentTransforms = new Map<string, { viewport: any; transform: any }>();
    MIP_VIEWPORT_IDS.forEach(viewportId => {
      try {
        const viewport = cornerstoneViewportService.getCornerstoneViewport?.(viewportId);
        const transform = copyCameraTransform(viewport?.getCamera?.());
        if (viewport && transform && Object.keys(transform).length)
          currentTransforms.set(viewportId, { viewport, transform });
      } catch {
        // 布局销毁中的视口按缺失处理。
      }
    });
    const synchronizers = pauseSynchronizers(syncGroupService, [...currentTransforms.keys()]);
    try {
      return originalPerformResize.apply(this, args);
    } finally {
      currentTransforms.forEach(({ viewport, transform }) => {
        try {
          if (cameraTransformChanged(viewport.getCamera?.(), transform)) {
            viewport.setCamera?.(transform);
            viewport.render?.();
          }
        } catch {
          // resize 过程中被替换的视口不再恢复。
        }
      });
      restoreSynchronizers(synchronizers);
    }
  };

  if (typeof originalPerformResize === 'function')
    cornerstoneViewportService.performResize = guardedPerformResize;
  const dispose = () => {
    if (cornerstoneViewportService?.performResize === guardedPerformResize)
      cornerstoneViewportService.performResize = originalPerformResize;
    savedTransforms.clear();
  };
  return { capture, restore, dispose };
}
