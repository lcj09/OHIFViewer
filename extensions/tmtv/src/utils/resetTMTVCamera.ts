const RESET_CAMERA_OPTIONS = {
  resetZoom: true,
  resetPan: true,
  resetToCenter: true,
  storeAsInitialCamera: true,
};

const distance3 = (a, b) =>
  Math.hypot(
    Number(a?.[0]) - Number(b?.[0]),
    Number(a?.[1]) - Number(b?.[1]),
    Number(a?.[2]) - Number(b?.[2])
  );

/** 2026-09-09 功能说明：拒绝图像完成定位前抓取的占位相机，避免重置后 MIP 围绕错误中心旋转。 */
function isCompatibleInitialCamera(initialCamera, fittedCamera): boolean {
  const fittedDistance = distance3(fittedCamera?.position, fittedCamera?.focalPoint);
  const focalOffset = distance3(initialCamera?.focalPoint, fittedCamera?.focalPoint);

  // 缺少完整几何信息时沿用既有恢复行为；Cornerstone Volume 视口会提供这些向量。
  if (!Number.isFinite(fittedDistance) || fittedDistance <= 0 || !Number.isFinite(focalOffset)) {
    return true;
  }

  return focalOffset <= fittedDistance;
}

/** 2026-09-09 功能说明：恢复有效初始视野并重建缩放基准，确保重置后的 getZoom() 为 1。 */
export default function resetTMTVCamera(viewport, initialCamera?): boolean {
  if (!viewport?.resetCamera) return false;

  viewport.resetCamera(RESET_CAMERA_OPTIONS);
  const fittedCamera = viewport.getCamera?.();
  if (
    initialCamera &&
    viewport.setCamera &&
    isCompatibleInitialCamera(initialCamera, fittedCamera)
  ) {
    viewport.setCamera(JSON.parse(JSON.stringify(initialCamera)), true);
  }

  return true;
}
