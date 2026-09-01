import { cache, getEnabledElement, metaData } from '@cornerstonejs/core';
import { annotation as csAnnotation } from '@cornerstonejs/tools';
import comparisonService from '../services/TMTVComparisonService';

const measurementTools = new Set([
  'Length',
  'Bidirectional',
  'ArrowAnnotate',
  'EllipticalROI',
  'RectangleROI',
  'PlanarFreehandROI',
  'CircleROI',
  'SphereROI',
  'Angle',
  'CobbAngle',
  'Probe',
]);

/** 2026-08-31 功能说明：按当前已加载数据判断检查归属，不使用可能过期的挂片匹配或患者姓名。 */
export function getViewportStudyUID(servicesManager, viewportId: string): string | undefined {
  if (!viewportId) return;
  const displaySets =
    servicesManager?.services?.cornerstoneViewportService?.getViewportDisplaySets?.(viewportId) ||
    [];
  if (!displaySets.length || displaySets.some(ds => !ds?.StudyInstanceUID)) return;
  const studies = new Set<string>(displaySets.map(ds => ds.StudyInstanceUID));
  return studies.size === 1 ? [...studies][0] : undefined;
}

/** 2026-08-31 功能说明：只信任标注自身的图像、体积或测量记录，不按共享空间参考系猜测检查。 */
export function getAnnotationStudyUID(annotation, servicesManager): string | undefined {
  const metadata = annotation?.metadata;
  if (!metadata) return;
  const imageId = metadata.referencedImageId;
  const imageStudy = imageId && metaData.get('instance', imageId)?.StudyInstanceUID;
  if (imageStudy) return imageStudy;
  const volume = metadata.volumeId && cache.getVolume(metadata.volumeId);
  const volumeImageId = volume?.imageIds?.[0];
  const volumeStudy = volumeImageId && metaData.get('instance', volumeImageId)?.StudyInstanceUID;
  if (volumeStudy) return volumeStudy;
  return servicesManager?.services?.measurementService?.getMeasurement?.(annotation.annotationUID)
    ?.referenceStudyUID;
}

/** 2026-08-31 功能说明：在工具实例的显示及命中入口隔离两次检查，保留原有同检查空间过滤。 */
export function installComparisonMeasurementIsolation(servicesManager) {
  const originals = new Map<any, { original: Function; wrapped: Function; own: boolean }>();
  let disposed = false;
  const restore = tool => {
    const { original, wrapped, own } = originals.get(tool);
    if (tool.filterInteractableAnnotationsForElement === wrapped) {
      if (own) tool.filterInteractableAnnotationsForElement = original;
      else delete tool.filterInteractableAnnotationsForElement;
    }
    originals.delete(tool);
  };
  const refresh = () => {
    if (disposed) return;
    const service = servicesManager.services.toolGroupService;
    const currentTools = new Set();
    for (const id of service?.getToolGroupIds?.() || []) {
      const group = service.getToolGroup(id);
      const tools = (group?._toolGroup || group)?._toolInstances || {};
      for (const [name, tool] of Object.entries<any>(tools)) {
        currentTools.add(tool);
        if (!measurementTools.has(name) || originals.has(tool)) continue;
        const original = tool.filterInteractableAnnotationsForElement;
        if (typeof original !== 'function') continue;
        const wrapped = function (element, annotations, ...args) {
          if (disposed || !comparisonService.isComparisonProtocolActive(servicesManager)) {
            return original.call(this, element, annotations, ...args);
          }
          const viewport = getEnabledElement(element)?.viewport;
          const studyUID = getViewportStudyUID(servicesManager, viewport?.id);
          if (!studyUID) return [];
          const ownAnnotations = (annotations || []).filter(
            item => getAnnotationStudyUID(item, servicesManager) === studyUID
          );
          return original.call(this, element, ownAnnotations, ...args);
        };
        originals.set(tool, {
          original,
          wrapped,
          own: Object.prototype.hasOwnProperty.call(
            tool,
            'filterInteractableAnnotationsForElement'
          ),
        });
        tool.filterInteractableAnnotationsForElement = wrapped;
      }
    }
    // 布局替换工具组时立即释放旧实例，不等到退出模式。
    for (const tool of originals.keys()) {
      if (!currentTools.has(tool)) restore(tool);
    }
  };
  // 2026-08-31 功能说明：切换检查时取消另一检查的残留选中项，防止 Delete 快捷键跨检查删除。
  const syncSelection = () => {
    if (disposed || !comparisonService.isComparisonProtocolActive(servicesManager)) return;
    const viewportId = servicesManager.services.viewportGridService.getState()?.activeViewportId;
    const studyUID = getViewportStudyUID(servicesManager, viewportId);
    for (const uid of csAnnotation.selection.getAnnotationsSelected()) {
      const item = csAnnotation.state.getAnnotation(uid);
      if (!measurementTools.has(item?.metadata?.toolName)) continue;
      if (!studyUID || getAnnotationStudyUID(item, servicesManager) !== studyUID) {
        csAnnotation.selection.setAnnotationSelected(uid, false);
      }
    }
  };
  // 2026-08-31 功能说明：退出时恢复实例方法并释放工具引用，重复清理和迟到的挂载通知均无副作用。
  const dispose = () => {
    disposed = true;
    for (const tool of originals.keys()) restore(tool);
    servicesManager = null;
  };
  refresh();
  return { refresh, syncSelection, dispose };
}

/** 2026-08-31 功能说明：对比时仅清除当前检查，未知归属不删除，非对比模式沿用原命令。 */
export function clearTMTVMeasurements(servicesManager, commandsManager) {
  if (!comparisonService.isComparisonProtocolActive(servicesManager)) {
    commandsManager.runCommand('clearMeasurements', {});
    return;
  }
  const { viewportGridService, measurementService, uiNotificationService } =
    servicesManager.services;
  const viewportId = viewportGridService.getState()?.activeViewportId;
  const studyUID = getViewportStudyUID(servicesManager, viewportId);
  if (!studyUID) {
    uiNotificationService?.show({
      title: '无法清除测量',
      message: '当前检查尚未就绪，请选中已加载的图像后重试。',
      type: 'warning',
    });
    return;
  }
  const ownAnnotations = csAnnotation.state
    .getAllAnnotations()
    .filter(
      item =>
        measurementTools.has(item.metadata?.toolName) &&
        getAnnotationStudyUID(item, servicesManager) === studyUID
    );
  const ownUIDs = new Set(ownAnnotations.map(item => item.annotationUID));
  const unmapped = ownAnnotations.filter(
    item => !measurementService.getMeasurement(item.annotationUID)
  );
  commandsManager.runCommand('clearMeasurements', {
    // 只清除实际标注；历史孤立记录没有可用于删除及撤销的 Cornerstone 标注对象。
    measurementFilter: measurement => ownUIDs.has(measurement.uid),
  });
  // 未接入 MeasurementService 的工具（如球体 ROI）仍按所属检查清除，并保留撤销记录。
  for (const item of unmapped) {
    if (!csAnnotation.state.getAnnotation(item.annotationUID)) continue;
    csAnnotation.state.removeAnnotation(item.annotationUID);
    commandsManager.runCommand('triggerCreateAnnotationMemo', {
      annotation: item,
      FrameOfReferenceUID: item.metadata.FrameOfReferenceUID,
      options: { deleting: true },
    });
  }
  servicesManager.services.cornerstoneViewportService.getRenderingEngine()?.render();
}
