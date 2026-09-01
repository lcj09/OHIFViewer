import createTMTVZoomSynchronizer, { TMTV_ZOOM_TYPE } from './createTMTVZoomSynchronizer';

const zoomIds = ['zoomSync', 'tmtvZoomBaseline', 'tmtvZoomFollowup'];

/** 2026-08-31 功能说明：缩放按检查分组，只有开启两次检查同步才合并；未就绪视口不挂接。 */
export default function applyTMTVZoomSync(servicesManager, isComparison: boolean) {
  const { syncGroupService, cornerstoneViewportService, customizationService } =
    servicesManager?.services || {};
  if (!syncGroupService || !cornerstoneViewportService) return;
  // 2026-09-01 功能说明：替换无运行时校验的通用 zoompan 回调，阻断滚轮事件传播非法 zoom。
  syncGroupService.addSynchronizerType?.(TMTV_ZOOM_TYPE, createTMTVZoomSynchronizer);
  const settings = customizationService?.getCustomization?.('syncSettings') || {};
  const enabled = settings.zoomSync === true;
  const separate = isComparison && settings.comparisonStudySync !== true;
  const desired = enabled ? (separate ? zoomIds.slice(1) : [zoomIds[0]]) : [];
  for (const id of zoomIds) {
    syncGroupService.getSynchronizer?.(id)?.setEnabled(desired.includes(id));
  }
  if (!enabled) return;
  for (const viewportId of cornerstoneViewportService.getViewportIds?.() || []) {
    try {
      if (
        isComparison &&
        !/^(baseline|followup)(CTAxial|PTAxial|FusionAxial|MIPSagittal)$/.test(viewportId)
      )
        continue;
      const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);
      const parallelScale = viewport?.getCamera?.()?.parallelScale;
      const initialParallelScale = viewport?.initialCamera?.parallelScale;
      const engineId = viewport?.getRenderingEngine?.()?.id || viewport?.renderingEngineId;
      if (
        !engineId ||
        !Number.isFinite(parallelScale) ||
        parallelScale <= 0 ||
        !Number.isFinite(initialParallelScale) ||
        initialParallelScale <= 0
      )
        continue;
      const id = separate
        ? viewportId.startsWith('baseline')
          ? zoomIds[1]
          : zoomIds[2]
        : zoomIds[0];
      syncGroupService.addViewportToSyncGroup(viewportId, engineId, [
        {
          type: TMTV_ZOOM_TYPE,
          id,
          source: true,
          target: true,
        },
      ]);
      syncGroupService.getSynchronizer?.(id)?.setEnabled(true);
    } catch {
      // 布局销毁或加载中，等待下一次视口就绪事件。
    }
  }
}
