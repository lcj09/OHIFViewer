import { COMPARISON_VIEWPORT_IDS_BY_SIDE as VIEWPORT_IDS_BY_SIDE } from './comparisonViewportIds';

const validScale = value => Number.isFinite(value) && value > 0;

const getActorId = actor => actor?.referencedId || actor?.uid;

const scalesDiffer = (first, second) =>
  !validScale(first) ||
  !validScale(second) ||
  Math.abs(first - second) > Number.EPSILON * Math.max(1, Math.abs(first), Math.abs(second));

const getViewportSafely = (viewportService, id) => {
  try {
    return viewportService?.getCornerstoneViewport?.(id);
  } catch {
    return undefined;
  }
};

const pauseComparisonSynchronizers = (syncGroupService, viewportIds) => {
  const enabledSynchronizers = new Set<any>();
  for (const id of viewportIds) {
    for (const synchronizer of syncGroupService?.getSynchronizersForViewport?.(id) || []) {
      if (enabledSynchronizers.has(synchronizer) || synchronizer.isDisabled?.()) continue;
      enabledSynchronizers.add(synchronizer);
      synchronizer.setEnabled(false);
    }
  }
  return enabledSynchronizers;
};

const restoreSynchronizers = enabledSynchronizers => {
  enabledSynchronizers.forEach(synchronizer => {
    try {
      synchronizer.setEnabled(true);
    } catch {
      // 布局退出时同步器可能已经销毁。
    }
  });
};

/**
 * 2026-09-01 功能说明：双击最大化/还原布局后，以各侧 CT 的当前及初始尺度
 * 修复 PET/Fusion/MIP，不重置切片位置、方位或平移。
 */
export function reconcileComparisonViewportScales(
  servicesManager: any,
  referenceScales: Map<string, { current: number; initial: number }> = new Map()
): boolean {
  const { cornerstoneViewportService, syncGroupService } = servicesManager?.services || {};
  if (!cornerstoneViewportService) return false;
  const viewportIds = [...VIEWPORT_IDS_BY_SIDE.baseline, ...VIEWPORT_IDS_BY_SIDE.followup];
  const enabledSynchronizers = pauseComparisonSynchronizers(syncGroupService, viewportIds);
  let changed = false;
  try {
    for (const side of ['baseline', 'followup']) {
      const ctViewport = getViewportSafely(cornerstoneViewportService, `${side}CTAxial`);
      const reference = referenceScales.get(side);
      const ctScale = reference?.current ?? ctViewport?.getCamera?.()?.parallelScale;
      const ctInitialScale = reference?.initial ?? ctViewport?.initialCamera?.parallelScale;
      if (!validScale(ctScale) || !validScale(ctInitialScale)) continue;

      for (const suffix of ['CTAxial', 'PTAxial', 'FusionAxial', 'MIPSagittal']) {
        const viewport = getViewportSafely(cornerstoneViewportService, `${side}${suffix}`);
        const currentScale = viewport?.getCamera?.()?.parallelScale;
        const initialCamera = viewport?.initialCamera;
        if (!viewport || !validScale(currentScale) || !initialCamera) continue;
        const currentChanged = scalesDiffer(currentScale, ctScale);
        const initialChanged = scalesDiffer(initialCamera.parallelScale, ctInitialScale);
        if (!currentChanged && !initialChanged) continue;

        if (currentChanged) viewport.setCamera({ parallelScale: ctScale });
        if (initialChanged) {
          const nextInitialCamera = { ...initialCamera, parallelScale: ctInitialScale };
          if (viewport.setInitialCamera) viewport.setInitialCamera(nextInitialCamera);
          else viewport.initialCamera = nextInitialCamera;
        }
        viewport.render?.();
        changed = true;
      }
    }
    return changed;
  } finally {
    restoreSynchronizers(enabledSynchronizers);
  }
}

/** 2026-09-01 功能说明：以 Volume、视口尺寸生成一次性 fit 标识，布局变化后允许重新校正。 */
export function getComparisonFitSignature(viewport: any): string | null {
  const actorIds = (viewport?.getActors?.() || []).map(getActorId).filter(Boolean);
  const isFusion = viewport?.id?.includes('Fusion');
  if (!actorIds.length || (isFusion && actorIds.length < 2) || !viewport?.resetCamera) {
    return null;
  }
  const element = viewport.element || viewport.canvas;
  const width = element?.clientWidth || viewport.canvas?.clientWidth;
  const height = element?.clientHeight || viewport.canvas?.clientHeight;
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    return null;
  }
  return `${actorIds.join('|')}@${width}x${height}`;
}

/**
 * 2026-09-01 功能说明：布局稳定后重做对比视口 fit；PET/Fusion/MIP 全部使用同检查
 * CT 的物理显示尺度。执行期间暂停同步器，避免初始化事件回传。
 */
export default function fitComparisonViewports(
  servicesManager: any,
  fittedViewports: WeakMap<object, string>
): boolean {
  const { cornerstoneViewportService, syncGroupService } = servicesManager?.services || {};
  if (!cornerstoneViewportService || !fittedViewports) {
    return false;
  }

  const getViewport = id => getViewportSafely(cornerstoneViewportService, id);
  const entries = [...VIEWPORT_IDS_BY_SIDE.baseline, ...VIEWPORT_IDS_BY_SIDE.followup]
    .map(id => {
      const viewport = getViewport(id);
      return { id, viewport, signature: getComparisonFitSignature(viewport) };
    })
    .filter(entry => entry.viewport && entry.signature);
  const pendingFit = entries.filter(
    entry => fittedViewports.get(entry.viewport) !== entry.signature
  );
  const needsScaleAlignment = ['baseline', 'followup'].some(side => {
    const ctScale = getViewport(`${side}CTAxial`)?.getCamera?.()?.parallelScale;
    if (!validScale(ctScale)) return false;
    return ['PTAxial', 'FusionAxial', 'MIPSagittal'].some(suffix => {
      const scale = getViewport(`${side}${suffix}`)?.getCamera?.()?.parallelScale;
      return validScale(scale) && Math.abs(scale - ctScale) > Number.EPSILON * Math.max(1, ctScale);
    });
  });
  if (!pendingFit.length && !needsScaleAlignment) {
    return false;
  }

  const enabledSynchronizers = pauseComparisonSynchronizers(
    syncGroupService,
    entries.map(entry => entry.id)
  );
  try {
    const fittedNow = new Set<any>();
    const changedViewports = new Set<any>();
    for (const { viewport } of pendingFit) {
      try {
        viewport.resetCamera({
          resetZoom: true,
          resetPan: true,
          resetToCenter: true,
          storeAsInitialCamera: true,
        });
        fittedNow.add(viewport);
        changedViewports.add(viewport);
      } catch {
        // 视口可能在延迟 fit 期间被布局替换，等待下一次 Volume 事件。
      }
    }

    for (const side of ['baseline', 'followup']) {
      const ctViewport = getViewport(`${side}CTAxial`);
      const ctScale = ctViewport?.getCamera?.()?.parallelScale;
      if (!validScale(ctScale)) continue;
      for (const suffix of ['PTAxial', 'FusionAxial', 'MIPSagittal']) {
        const viewport = getViewport(`${side}${suffix}`);
        if (!viewport || !getComparisonFitSignature(viewport)) continue;
        const scale = viewport.getCamera?.()?.parallelScale;
        if (
          validScale(scale) &&
          Math.abs(scale - ctScale) <= Number.EPSILON * Math.max(1, ctScale)
        )
          continue;
        try {
          viewport.setCamera({ parallelScale: ctScale }, true);
          changedViewports.add(viewport);
        } catch {
          fittedNow.delete(viewport);
        }
      }
    }

    for (const { viewport, signature } of entries) {
      if (!fittedNow.has(viewport) && fittedViewports.get(viewport) !== signature) continue;
      fittedViewports.set(viewport, signature);
      if (!changedViewports.has(viewport)) continue;
      try {
        viewport.render?.();
      } catch {
        fittedViewports.delete(viewport);
      }
    }
    return changedViewports.size > 0;
  } finally {
    restoreSynchronizers(enabledSynchronizers);
  }
}
