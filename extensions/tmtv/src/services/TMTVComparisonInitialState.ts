import { cache } from '@cornerstonejs/core';

type InitialState = {
  volumeIds: string[];
  camera: any;
  ranges: Record<string, { lower: number; upper: number }>;
};

/** 2026-08-31 功能说明：只保存相机数值和窗位，弱引用视口，不持有 Volume、像素或 DOM。 */
class TMTVComparisonInitialState {
  private snapshots = new WeakMap<object, InitialState>();

  /** 2026-08-31 功能说明：首次交互前记录已就绪视口；同一视口换序列后重新记录。 */
  capture(viewport: any): void {
    if (!viewport) return;
    const actors = viewport.getActors?.() || [];
    const volumeIds = actors
      .map(actor => actor.referencedId || actor.uid)
      .filter(id => {
        const modality = cache.getVolume(id)?.metadata?.Modality;
        return modality === 'CT' || modality === 'PT';
      });
    if (!volumeIds.length || this.get(viewport)) return;
    const camera = viewport.getCamera?.();
    const vectors = ['position', 'focalPoint', 'viewUp', 'viewPlaneNormal'];
    if (
      !camera ||
      !Number.isFinite(camera.parallelScale) ||
      camera.parallelScale <= 0 ||
      vectors.some(
        key =>
          !camera[key] ||
          camera[key].length !== 3 ||
          !Array.from(camera[key]).every(Number.isFinite)
      )
    )
      return;
    const ranges: InitialState['ranges'] = {};
    for (const id of volumeIds) {
      const range = viewport.getProperties?.(id)?.voiRange;
      if (
        !range ||
        !Number.isFinite(range.lower) ||
        !Number.isFinite(range.upper) ||
        range.upper <= range.lower
      )
        return;
      ranges[id] = { lower: range.lower, upper: range.upper };
    }
    // Cornerstone Camera 是数值、布尔值及数组组成的数据对象，不保存内部 vtk 引用。
    this.snapshots.set(viewport, { volumeIds, camera: JSON.parse(JSON.stringify(camera)), ranges });
  }

  /** 2026-08-31 功能说明：只返回与当前序列一致的快照，防止视口复用时恢复上一检查的数据。 */
  get(viewport: any): InitialState | undefined {
    if (!viewport) return;
    const snapshot = this.snapshots.get(viewport);
    if (!snapshot) return;
    const ids = (viewport.getActors?.() || [])
      .map(actor => actor.referencedId || actor.uid)
      .filter(id => ['CT', 'PT'].includes(cache.getVolume(id)?.metadata?.Modality));
    if (
      snapshot.volumeIds.length !== ids.length ||
      snapshot.volumeIds.some((id, index) => id !== ids[index])
    ) {
      this.snapshots.delete(viewport);
      return;
    }
    return snapshot;
  }

  /** 2026-08-31 功能说明：退出模式时丢弃全部初始状态。 */
  clear(): void {
    this.snapshots = new WeakMap();
  }
}

export default new TMTVComparisonInitialState();
