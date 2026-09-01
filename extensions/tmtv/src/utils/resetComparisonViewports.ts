import { cache, utilities } from '@cornerstonejs/core';
import comparison, { VIEWPORT_IDS_BY_SIDE } from '../services/TMTVComparisonService';
import crosshairs from '../services/TMTVCrosshairService';
import initialState from '../services/TMTVComparisonInitialState';
import resetTMTVCamera from './resetTMTVCamera';

const isValidRange = range =>
  range &&
  Number.isFinite(range.lower) &&
  Number.isFinite(range.upper) &&
  range.upper > range.lower;

/** 2026-08-31 功能说明：从当前 Volume 获取初始窗位，不依赖单检查 ptDisplaySet，也不触发新图像加载。 */
function getInitialRange(volume, metadataProvider) {
  const imageIds = volume.imageIds || [];
  const firstImageId = imageIds[0];
  const imageId = imageIds[Math.floor(imageIds.length / 2)];
  const scaling = firstImageId && metadataProvider.get('scalingModule', firstImageId);
  if (volume.metadata?.Modality === 'PT' && scaling?.suvbw) {
    return utilities.windowLevel.toLowHighRange(5, 2.5);
  }

  const voi =
    (imageId && metadataProvider.get('voiLutModule', imageId)) || volume.metadata?.voiLut?.[0];
  const width = Number(Array.isArray(voi?.windowWidth) ? voi.windowWidth[0] : voi?.windowWidth);
  const center = Number(Array.isArray(voi?.windowCenter) ? voi.windowCenter[0] : voi?.windowCenter);
  if (Number.isFinite(width) && width > 0 && Number.isFinite(center)) {
    const range = utilities.windowLevel.toLowHighRange(width, center, voi?.voiLUTFunction);
    if (isValidRange(range)) return range;
  }

  // 只读已缓存的显示域像素范围，避免 resetProperties 内部异步加载后覆盖刚恢复的窗位。
  const image = imageId && cache.getImage(imageId);
  const minMax = image?.voxelManager?.getMinMax?.();
  const range = minMax && { lower: minMax.min, upper: minMax.max };
  return isValidRange(range) ? range : undefined;
}

/** 2026-09-01 功能说明：分别恢复 CT/PET 图层、MIP 参数和初始相机，使重置缩放归一为 1。 */
function resetViewport(viewport, modality, metadataProvider) {
  const actors = viewport.getActors?.() || [];
  if (!actors.length) return;

  const initial = initialState.get(viewport);
  resetTMTVCamera(viewport, initial?.camera);

  let defaultRange;
  const defaultVolumeId = viewport.getVolumeId?.() || actors[0]?.referencedId || actors[0]?.uid;

  for (const actor of actors) {
    const volumeId = actor.referencedId || actor.uid;
    const volume = volumeId && cache.getVolume(volumeId);
    const volumeModality = volume?.metadata?.Modality;
    if (volumeModality !== 'CT' && volumeModality !== 'PT') continue;
    const voiRange = initial?.ranges[volumeId] || getInitialRange(volume, metadataProvider);
    const isFusionPT = modality === 'Fusion' && volumeModality === 'PT';
    const properties: any = {
      // setProperties 先 invert 再 colormap；先清零标志，再重建标准色表。
      invert: false,
      colormap: isFusionPT
        ? {
            name: 'hsv',
            opacity: [
              { value: 0, opacity: 0 },
              { value: 0.1, opacity: 0.8 },
              { value: 1, opacity: 0.9 },
            ],
          }
        : { name: 'Grayscale' },
    };
    if (voiRange) properties.voiRange = voiRange;
    if (modality === 'MIP') properties.slabThickness = 500;
    viewport.setProperties(properties, volumeId);
    if (volumeModality === 'PT' && !isFusionPT) {
      // 新色表已是非反色，显式反转一次，不依赖此前 viewportProperties.invert 的值。
      viewport.setInvert(true, volumeId);
    }
    if (volumeId === defaultVolumeId) defaultRange = voiRange;
  }
  // 融合最后更新 PET 会把角标留在 PET 窗位；最后通知主图层，恢复 CT 的窗位显示。
  if (defaultRange) viewport.setProperties({ voiRange: { ...defaultRange } }, defaultVolumeId);
  viewport.render();
}

/** 2026-08-31 功能说明：对比重置以检查为单位，暂停同步后分别恢复相机与图层，finally 恢复开关状态。 */
export default function resetComparisonViewports(servicesManager, metadataProvider): boolean {
  if (!comparison.isComparisonProtocolActive(servicesManager)) return false;
  const {
    viewportGridService,
    cornerstoneViewportService,
    syncGroupService,
    uiNotificationService,
  } = servicesManager.services;
  const activeId = viewportGridService?.getState?.()?.activeViewportId;
  const side = comparison.getSideForViewportId(activeId);
  if (!side) return true;
  const bothSides = comparison.isComparisonStudySyncEnabled(servicesManager);
  const viewportIds = bothSides
    ? [...VIEWPORT_IDS_BY_SIDE.baseline, ...VIEWPORT_IDS_BY_SIDE.followup]
    : VIEWPORT_IDS_BY_SIDE[side];

  crosshairs.stopInteractions();
  const enabledSynchronizers = new Set<any>();
  let failures = 0;
  try {
    for (const id of viewportIds) {
      if (!cornerstoneViewportService.getCornerstoneViewport(id)) continue;
      const synchronizers = syncGroupService?.getSynchronizersForViewport?.(id) || [];
      for (const synchronizer of synchronizers) {
        if (synchronizer.isDisabled()) continue;
        enabledSynchronizers.add(synchronizer);
        synchronizer.setEnabled(false);
      }
    }
    comparison.withVOISyncPaused(() => {
      for (const id of viewportIds) {
        try {
          const viewport = cornerstoneViewportService.getCornerstoneViewport(id);
          if (!viewport) continue;
          resetViewport(viewport, comparison.getModalityForViewportId(id), metadataProvider);
        } catch (error) {
          failures++;
          console.warn(`[TMTV] 重置对比视口失败 (${id})`, error);
        }
      }
      crosshairs.resetRotationAngles(bothSides ? undefined : side);
    });
  } catch (error) {
    failures++;
    console.warn('[TMTV] 暂停同步并重置失败', error);
  } finally {
    enabledSynchronizers.forEach(synchronizer => {
      try {
        synchronizer.setEnabled(true);
      } catch {
        // 退出模式时同步器可能已经销毁。
      }
    });
  }
  if (failures) {
    uiNotificationService?.show?.({
      title: '重置视图',
      message: '部分视口未能重置，请等待图像加载完成后重试。',
      type: 'warning',
    });
  }
  return true;
}
