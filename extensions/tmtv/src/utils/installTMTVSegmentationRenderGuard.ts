import { cache, Enums as csEnums } from '@cornerstonejs/core';
import { Enums as csToolsEnums } from '@cornerstonejs/tools';

type SegmentationRepresentationInput = {
  segmentationId?: string;
  type?: string;
  config?: {
    blendMode?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type TMTVSegmentationRenderGuard = {
  dispose: () => void;
};

const getCachedVolume = (volumeId?: string) => {
  if (!volumeId) return null;

  try {
    return cache.getVolume(volumeId);
  } catch {
    return null;
  }
};

/**
 * 2026-09-24 功能说明：布局重建期间 Labelmap 体积尚未回到缓存时，避免边缘投影直接读取空 volume.dimensions。
 */
export function getSafeTMTVSegmentationRepresentation(
  segmentationService: any,
  representation: SegmentationRepresentationInput
): SegmentationRepresentationInput | null {
  const { LABELMAP_EDGE_PROJECTION_BLEND, MAXIMUM_INTENSITY_BLEND } = csEnums.BlendModes;
  if (representation?.config?.blendMode !== LABELMAP_EDGE_PROJECTION_BLEND) {
    return representation;
  }

  const segmentation = segmentationService?.getSegmentation?.(representation.segmentationId);
  const labelmapData =
    segmentation?.representationData?.[csToolsEnums.SegmentationRepresentations.Labelmap] ??
    segmentation?.representationData?.Labelmap;
  const volumeId = labelmapData?.volumeId;

  if (!volumeId || getCachedVolume(volumeId)) {
    return representation;
  }

  if (!Array.isArray(labelmapData?.imageIds) || !labelmapData.imageIds.length) {
    return null;
  }

  return {
    ...representation,
    config: {
      ...representation.config,
      blendMode: MAXIMUM_INTENSITY_BLEND,
    },
  };
}

/** 2026-09-24 功能说明：仅在 TMTV 模式内保护分割挂载竞态，退出模式时恢复原方法。 */
export default function installTMTVSegmentationRenderGuard(
  servicesManager: any
): TMTVSegmentationRenderGuard {
  const segmentationService = servicesManager?.services?.segmentationService;
  const originalAddSegmentationRepresentation = segmentationService?.addSegmentationRepresentation;

  if (typeof originalAddSegmentationRepresentation !== 'function') {
    return { dispose: () => {} };
  }

  const guardedAddSegmentationRepresentation = function (
    viewportId: string,
    representation: SegmentationRepresentationInput
  ) {
    const safeRepresentation = getSafeTMTVSegmentationRepresentation(
      segmentationService,
      representation
    );

    if (!safeRepresentation) {
      console.warn(
        `[TMTV] Skip stale segmentation representation ${representation?.segmentationId || ''} for ${viewportId}`
      );
      return Promise.resolve();
    }

    return originalAddSegmentationRepresentation.call(this, viewportId, safeRepresentation);
  };

  segmentationService.addSegmentationRepresentation = guardedAddSegmentationRepresentation;

  return {
    dispose: () => {
      if (
        segmentationService.addSegmentationRepresentation === guardedAddSegmentationRepresentation
      ) {
        segmentationService.addSegmentationRepresentation = originalAddSegmentationRepresentation;
      }
    },
  };
}
