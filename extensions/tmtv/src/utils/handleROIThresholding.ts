export const handleROIThresholding = async ({
  commandsManager,
  segmentationService,
  segmentations,
}: {
  commandsManager: any;
  segmentationService: any;
  segmentationId: string;
  segmentations?: any[];
}) => {
  // 2026-09-02 功能说明：统计前过滤空对象和未完成 labelmap 注册的分割，避免底层读取空 representationData。
  const currentSegmentations = (segmentations ?? segmentationService.getSegmentations()).filter(
    segmentation =>
      !!segmentation?.segmentationId &&
      !!(
        segmentation.representationData?.Labelmap ||
        Object.values(segmentation.representationData || {}).length
      )
  );

  if (!currentSegmentations.length) {
    return null;
  }

  const tmtv = await commandsManager.run('calculateTMTV', { segmentations: currentSegmentations });

  if (tmtv == null) {
    return null;
  }

  // add the tmtv to all the segment cachedStats, although it is a global
  // value but we don't have any other way to display it for now
  // Update all segmentations with the calculated TMTV
  currentSegmentations.forEach(segmentation => {
    segmentation.cachedStats = {
      ...segmentation.cachedStats,
      tmtv,
    };

    segmentationService.addOrUpdateSegmentation(segmentation);
  });

  return tmtv;
};
