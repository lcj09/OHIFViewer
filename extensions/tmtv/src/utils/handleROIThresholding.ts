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
  // [2026-08-25 功能] 支持调用方传入真实 TMTV segmentations，避免 lesion 高亮层混入 TMTV/TLG 统计
  const currentSegmentations = segmentations ?? segmentationService.getSegmentations();
  const tmtv = await commandsManager.run('calculateTMTV', { segmentations: currentSegmentations });

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
};
