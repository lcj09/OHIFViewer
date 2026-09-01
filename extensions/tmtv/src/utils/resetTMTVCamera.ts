const RESET_CAMERA_OPTIONS = {
  resetZoom: true,
  resetPan: true,
  resetToCenter: true,
  storeAsInitialCamera: true,
};

/** 2026-09-01 功能说明：恢复初始视野并重建缩放基准，确保重置后的 getZoom() 为 1。 */
export default function resetTMTVCamera(viewport, initialCamera?): boolean {
  if (!viewport?.resetCamera) return false;

  viewport.resetCamera(RESET_CAMERA_OPTIONS);
  if (initialCamera && viewport.setCamera) {
    viewport.setCamera(JSON.parse(JSON.stringify(initialCamera)), true);
  }

  return true;
}
