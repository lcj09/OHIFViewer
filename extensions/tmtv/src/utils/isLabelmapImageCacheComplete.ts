import { cache } from '@cornerstonejs/core';

/** 2026-09-24 功能说明：代谢统计前确认 Labelmap 的派生图像仍完整驻留缓存。 */
export default function isLabelmapImageCacheComplete(labelmapData: {
  imageIds?: string[];
}): boolean {
  if (!labelmapData?.imageIds?.length) {
    return true;
  }

  return labelmapData.imageIds.every(imageId => {
    try {
      return !!cache.getImage(imageId);
    } catch {
      return false;
    }
  });
}
