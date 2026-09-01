/**
 * 2026-09-01 功能说明：切换重建方位时保留原世界空间缩放，避免 setOrientation
 * 内部 resetCamera 重新适配体积边界后，矢状位或冠状位图像突然变小。
 */
export default function setOrientationPreservingScale(viewport: any, orientation: string): void {
  const parallelScale = viewport?.getCamera?.()?.parallelScale;

  viewport.setOrientation(orientation);

  if (Number.isFinite(parallelScale) && parallelScale > 0) {
    viewport.setCamera({ parallelScale });
  }
}
