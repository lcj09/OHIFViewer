import type { TMTVSessionSide } from '../services/TMTVSessionService';

/** 2026-09-02 功能说明：按当前检查侧选择 CT/PET DisplaySet，普通 TMTV 保持原有首个匹配行为。 */
export function findModalityDisplaySetForSide(
  viewportMatchDetails,
  displaySetService,
  modality: 'CT' | 'PT',
  side: TMTVSessionSide
) {
  if (!viewportMatchDetails || !displaySetService) return null;

  for (const [viewportId, viewportDetails] of viewportMatchDetails) {
    if (side !== 'single' && !String(viewportId).toLowerCase().startsWith(side)) {
      continue;
    }

    const displaySetsInfo = viewportDetails?.displaySetsInfo || [];
    for (const { displaySetInstanceUID } of displaySetsInfo) {
      const displaySet = displaySetService.getDisplaySetByUID?.(displaySetInstanceUID);
      if (displaySet?.Modality === modality) return displaySet;
    }
  }

  return null;
}

/** 2026-09-02 功能说明：过滤 Session 中仍存在的真实分割 ID，不持有 segmentation 或 Volume 对象。 */
export function getExistingSessionSegmentationIds(
  session,
  segmentationService,
  isHighlightSegmentationId: (segmentationId?: string) => boolean
): string[] {
  if (!session?.segmentationIds?.length || !segmentationService) return [];

  return session.segmentationIds.filter(
    segmentationId =>
      !!segmentationId &&
      !isHighlightSegmentationId(segmentationId) &&
      !!segmentationService.getSegmentation?.(segmentationId)
  );
}
