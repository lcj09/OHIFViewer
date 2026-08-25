import { cache } from '@cornerstonejs/core';
import * as csTools from '@cornerstonejs/tools';
import extractConnectedComponents from '../utils/extractConnectedComponents';

const { SegmentationRepresentations } = csTools.Enums;

type NumericArray = ArrayLike<number>;

export type TMTVLesion = {
  id: string;
  lesionNumber: number;
  segmentationId: string;
  segmentIndex: number;
  voxelIndices: number[];
  voxelCount: number;
  // [2026-08-24 功能] 保存病灶 IJK 包围盒，供后续定位、高亮、编辑工作流复用
  boundsIJK: {
    min: [number, number, number];
    max: [number, number, number];
  };
  volume: number;
  suvMax: number | null;
  suvMean: number | null;
  tlg: number | null;
  centroid: [number, number, number];
  centroidIJK: [number, number, number];
};

export type TMTVLesionState = {
  segmentationIds: string[];
  segmentIndex: number;
  // [2026-08-24 功能] UI 层维护当前选中病灶，不拆分或新增 Cornerstone segment
  selectedLesionId: string | null;
  lesions: TMTVLesion[];
  totals: {
    tmtv: number;
    tlg: number | null;
  };
  updatedAt: number;
};

type Subscription = {
  unsubscribe: () => void;
};

const EMPTY_STATE: TMTVLesionState = {
  segmentationIds: [],
  segmentIndex: 1,
  selectedLesionId: null,
  lesions: [],
  totals: {
    tmtv: 0,
    tlg: null,
  },
  updatedAt: 0,
};

class TMTVLesionService {
  private stateByGroupId = new Map<string, TMTVLesionState>();
  private listeners = new Set<() => void>();
  private selectedLesionIdByGroupId = new Map<string, string | null>();
  private skipNextFullRefreshSegmentationIds = new Set<string>();

  public subscribe(listener: () => void): Subscription {
    this.listeners.add(listener);

    return {
      unsubscribe: () => {
        this.listeners.delete(listener);
      },
    };
  }

  public getState(segmentationIds: string[] = []): TMTVLesionState {
    const groupId = this.getGroupId(segmentationIds);
    return (
      this.stateByGroupId.get(groupId) ?? {
        ...EMPTY_STATE,
        segmentationIds: [...segmentationIds],
      }
    );
  }

  public extractLesionsForSegmentations(
    segmentations: any[] = [],
    segmentIndex = 1
  ): TMTVLesionState {
    // [2026-08-24 功能] 从 Segment 1 labelmap 重新提取 3D 连通病灶并生成统计状态
    const segmentationIds = segmentations
      .map(segmentation => segmentation?.segmentationId)
      .filter(Boolean);
    const lesions: TMTVLesion[] = [];

    segmentations.forEach(segmentation => {
      lesions.push(...this.extractLesionsForSegmentation(segmentation, segmentIndex));
    });

    lesions.forEach((lesion, index) => {
      lesion.lesionNumber = index + 1;
    });

    const groupId = this.getGroupId(segmentationIds);
    const previousSelectedLesionId = this.selectedLesionIdByGroupId.get(groupId) ?? null;
    const selectedLesionId = lesions.some(lesion => lesion.id === previousSelectedLesionId)
      ? previousSelectedLesionId
      : null;

    const totalTMTV = lesions.reduce((sum, lesion) => sum + lesion.volume, 0);
    const totalTLG = lesions.reduce(
      (sum, lesion) => (lesion.tlg === null ? sum : sum + lesion.tlg),
      0
    );
    const hasTLG = lesions.some(lesion => lesion.tlg !== null);

    const state: TMTVLesionState = {
      segmentationIds,
      segmentIndex,
      selectedLesionId,
      lesions,
      totals: {
        tmtv: totalTMTV,
        // [2026-08-25 功能] 无 lesion 时总 TLG 明确清零，避免面板/导出沿用旧统计值
        tlg: lesions.length ? (hasTLG ? totalTLG : null) : 0,
      },
      updatedAt: Date.now(),
    };

    this.selectedLesionIdByGroupId.set(groupId, selectedLesionId);
    this.stateByGroupId.set(groupId, state);
    this.notify();

    return state;
  }

  public selectLesion(segmentationIds: string[], lesionId: string | null): TMTVLesion | null {
    // [2026-08-24 功能] 只更新 TMTV lesion 选中状态，保持底层 Segment 1 不变
    const groupId = this.getGroupId(segmentationIds);
    const state = this.getState(segmentationIds);
    const selectedLesion = lesionId
      ? (state.lesions.find(lesion => lesion.id === lesionId) ?? null)
      : null;
    const selectedLesionId = selectedLesion?.id ?? null;

    this.selectedLesionIdByGroupId.set(groupId, selectedLesionId);
    this.stateByGroupId.set(groupId, {
      ...state,
      selectedLesionId,
    });
    this.notify();

    return selectedLesion;
  }

  public deleteLesion(lesionId: string, segmentIndex = 1): TMTVLesionState | null {
    // [2026-08-24 功能] 删除病灶时真实回写 Segment 1 labelmap，而不是只从 UI 数组移除
    const state = this.findStateForLesion(lesionId);
    const lesion = state?.lesions.find(candidate => candidate.id === lesionId);

    if (!state || !lesion) {
      return null;
    }

    const segmentationVolume = this.getSegmentationVolume(lesion.segmentationId);
    const scalarData = getScalarData(segmentationVolume);

    if (!segmentationVolume || !scalarData) {
      return null;
    }

    lesion.voxelIndices.forEach(voxelIndex => {
      if (scalarData[voxelIndex] === segmentIndex) {
        setScalarValue(segmentationVolume, scalarData, voxelIndex, 0);
      }
    });

    // [2026-08-24 功能] 删除单个完整连通域时增量更新 lesion state，避免立即全量扫描 labelmap
    const nextState = this.removeLesionFromState(state, lesionId);
    this.skipNextFullRefreshSegmentationIds.add(lesion.segmentationId);
    segmentationVolume.modified?.();
    csTools.segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(
      lesion.segmentationId,
      getModifiedSlices(lesion.voxelIndices, getDimensions(segmentationVolume)),
      segmentIndex
    );

    return nextState;
  }

  public consumeSkipNextFullRefresh(segmentationId: string): boolean {
    // [2026-08-24 功能] lesion 删除已增量更新 state，消费一次标记以跳过面板全量重算
    if (!this.skipNextFullRefreshSegmentationIds.has(segmentationId)) {
      return false;
    }

    this.skipNextFullRefreshSegmentationIds.delete(segmentationId);
    return true;
  }

  public reset(segmentationIds?: string[]): void {
    if (segmentationIds?.length) {
      this.stateByGroupId.delete(this.getGroupId(segmentationIds));
    } else {
      this.stateByGroupId.clear();
    }

    this.notify();
  }

  private extractLesionsForSegmentation(segmentation: any, segmentIndex: number): TMTVLesion[] {
    // [2026-08-24 功能] 读取指定 segmentation 的 volume labelmap，按 Segment 1 做 lesion separation
    const segmentationId = segmentation?.segmentationId;
    const labelmapData =
      segmentation?.representationData?.[SegmentationRepresentations.Labelmap] ??
      segmentation?.representationData?.Labelmap;
    const segmentationVolumeId = (labelmapData as any)?.volumeId;

    if (!segmentationId || !segmentationVolumeId) {
      return [];
    }

    const segmentationVolume = getCachedVolume(segmentationVolumeId);
    const labelmapScalarData = getScalarData(segmentationVolume);
    const dimensions = getDimensions(segmentationVolume);

    if (!labelmapScalarData || !dimensions) {
      return [];
    }

    const referenceVolume = getReferenceVolume(segmentationVolumeId);
    const suvScalarData = getScalarData(referenceVolume);
    const spacing = getSpacing(referenceVolume) ?? getSpacing(segmentationVolume);
    const voxelVolume = getVoxelVolumeInML(spacing);
    const components = extractConnectedComponents({
      scalarData: labelmapScalarData,
      dimensions,
      segmentIndex,
    });

    return components.map((component, componentIndex) => {
      // [2026-08-24 功能] 对单个 lesion 计算 Volume、SUVmax、SUVmean、TLG、中心点和包围盒
      const stats = computeSUVStats(component.voxelIndices, suvScalarData);
      const volume = component.voxelIndices.length * voxelVolume;
      const centroidIJK = computeCentroidIJK(component.voxelIndices, dimensions);
      const boundsIJK = computeBoundsIJK(component.voxelIndices, dimensions);
      const centroid = transformIndexToWorld(referenceVolume ?? segmentationVolume, centroidIJK);

      return {
        id: `${segmentationId}:${segmentIndex}:${componentIndex + 1}`,
        lesionNumber: componentIndex + 1,
        segmentationId,
        segmentIndex,
        voxelIndices: component.voxelIndices,
        voxelCount: component.voxelIndices.length,
        boundsIJK,
        volume,
        suvMax: stats.suvMax,
        suvMean: stats.suvMean,
        tlg: stats.suvMean === null ? null : stats.suvMean * volume,
        centroid,
        centroidIJK,
      };
    });
  }

  private getGroupId(segmentationIds: string[]): string {
    return [...segmentationIds].sort().join(',');
  }

  private findStateForLesion(lesionId: string): TMTVLesionState | null {
    for (const state of this.stateByGroupId.values()) {
      if (state.lesions.some(lesion => lesion.id === lesionId)) {
        return state;
      }
    }

    return null;
  }

  private removeLesionFromState(state: TMTVLesionState, lesionId: string): TMTVLesionState {
    const groupId = this.getGroupId(state.segmentationIds);
    const lesions = state.lesions
      .filter(lesion => lesion.id !== lesionId)
      .map((lesion, index) => ({
        ...lesion,
        lesionNumber: index + 1,
      }));
    const totalTMTV = lesions.reduce((sum, lesion) => sum + lesion.volume, 0);
    const hasTLG = lesions.some(lesion => lesion.tlg !== null);
    const totalTLG = lesions.reduce(
      (sum, lesion) => (lesion.tlg === null ? sum : sum + lesion.tlg),
      0
    );
    const selectedLesionId = state.selectedLesionId === lesionId ? null : state.selectedLesionId;
    const nextState = {
      ...state,
      selectedLesionId,
      lesions,
      totals: {
        tmtv: totalTMTV,
        // [2026-08-25 功能] 删除最后一个 lesion 后总 TLG 清零，和 TMTV=0 保持一致
        tlg: lesions.length ? (hasTLG ? totalTLG : null) : 0,
      },
      updatedAt: Date.now(),
    };

    this.selectedLesionIdByGroupId.set(groupId, selectedLesionId);
    this.stateByGroupId.set(groupId, nextState);
    this.notify();

    return nextState;
  }

  private getSegmentationVolume(segmentationId: string) {
    const segmentation = csTools.segmentation.state.getSegmentation(segmentationId);
    const labelmapData =
      segmentation?.representationData?.[SegmentationRepresentations.Labelmap] ??
      segmentation?.representationData?.Labelmap;
    const segmentationVolumeId = (labelmapData as any)?.volumeId;

    if (!segmentationVolumeId) {
      return null;
    }

    return getCachedVolume(segmentationVolumeId);
  }

  private notify(): void {
    this.listeners.forEach(listener => listener());
  }
}

function getScalarData(volume): NumericArray | null {
  return (
    volume?.voxelManager?.getCompleteScalarDataArray?.() ??
    volume?.voxelManager?.getScalarData?.() ??
    volume?.scalarData ??
    null
  );
}

function setScalarValue(volume, scalarData: NumericArray, voxelIndex: number, value: number): void {
  if (volume?.voxelManager?.setAtIndex) {
    volume.voxelManager.setAtIndex(voxelIndex, value);
    return;
  }

  (scalarData as number[])[voxelIndex] = value;
}

function getCachedVolume(volumeId: string) {
  try {
    return cache.getVolume(volumeId);
  } catch (error) {
    return null;
  }
}

function getDimensions(volume): [number, number, number] | null {
  const dimensions = volume?.dimensions ?? volume?.imageData?.getDimensions?.();

  if (!dimensions || dimensions.length < 3) {
    return null;
  }

  return [dimensions[0], dimensions[1], dimensions[2]];
}

function getSpacing(volume): [number, number, number] | null {
  const spacing = volume?.spacing ?? volume?.imageData?.getSpacing?.();

  if (!spacing || spacing.length < 3) {
    return null;
  }

  return [spacing[0], spacing[1], spacing[2]];
}

function getVoxelVolumeInML(spacing: [number, number, number] | null): number {
  if (!spacing) {
    return 0;
  }

  return Math.abs(spacing[0] * spacing[1] * spacing[2]) / 1000;
}

function getReferenceVolume(segmentationVolumeId: string) {
  try {
    return csTools.utilities.segmentation.getReferenceVolumeForSegmentationVolume(
      segmentationVolumeId
    );
  } catch (error) {
    return null;
  }
}

function computeSUVStats(voxelIndices: number[], scalarData: NumericArray | null) {
  if (!scalarData) {
    return {
      suvMax: null,
      suvMean: null,
    };
  }

  let max = -Infinity;
  let sum = 0;
  let count = 0;

  voxelIndices.forEach(voxelIndex => {
    const value = scalarData[voxelIndex];

    if (typeof value !== 'number' || Number.isNaN(value)) {
      return;
    }

    if (value > max) {
      max = value;
    }

    sum += value;
    count++;
  });

  if (!count) {
    return {
      suvMax: null,
      suvMean: null,
    };
  }

  return {
    suvMax: max,
    suvMean: sum / count,
  };
}

function computeCentroidIJK(
  voxelIndices: number[],
  dimensions: [number, number, number]
): [number, number, number] {
  const [dimX, dimY] = dimensions;
  const sliceSize = dimX * dimY;
  let sumX = 0;
  let sumY = 0;
  let sumZ = 0;

  voxelIndices.forEach(voxelIndex => {
    const z = Math.floor(voxelIndex / sliceSize);
    const remainder = voxelIndex - z * sliceSize;
    const y = Math.floor(remainder / dimX);
    const x = remainder - y * dimX;

    sumX += x;
    sumY += y;
    sumZ += z;
  });

  const count = voxelIndices.length || 1;

  return [sumX / count, sumY / count, sumZ / count];
}

function computeBoundsIJK(
  voxelIndices: number[],
  dimensions: [number, number, number]
): { min: [number, number, number]; max: [number, number, number] } {
  const [dimX, dimY] = dimensions;
  const sliceSize = dimX * dimY;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  voxelIndices.forEach(voxelIndex => {
    const z = Math.floor(voxelIndex / sliceSize);
    const remainder = voxelIndex - z * sliceSize;
    const y = Math.floor(remainder / dimX);
    const x = remainder - y * dimX;

    min[0] = Math.min(min[0], x);
    min[1] = Math.min(min[1], y);
    min[2] = Math.min(min[2], z);
    max[0] = Math.max(max[0], x);
    max[1] = Math.max(max[1], y);
    max[2] = Math.max(max[2], z);
  });

  return { min, max };
}

function getModifiedSlices(
  voxelIndices: number[],
  dimensions: [number, number, number] | null
): number[] | undefined {
  if (!dimensions) {
    return;
  }

  const sliceSize = dimensions[0] * dimensions[1];
  return Array.from(new Set(voxelIndices.map(voxelIndex => Math.floor(voxelIndex / sliceSize))));
}

function transformIndexToWorld(volume, ijk: [number, number, number]): [number, number, number] {
  const imageData = volume?.imageData;

  if (imageData?.indexToWorld) {
    return imageData.indexToWorld(ijk);
  }

  const origin = volume?.origin ?? imageData?.getOrigin?.() ?? [0, 0, 0];
  const spacing = getSpacing(volume) ?? [1, 1, 1];
  const direction = volume?.direction ?? imageData?.getDirection?.();

  if (!direction || direction.length < 9) {
    return [
      origin[0] + ijk[0] * spacing[0],
      origin[1] + ijk[1] * spacing[1],
      origin[2] + ijk[2] * spacing[2],
    ];
  }

  const scaledI = ijk[0] * spacing[0];
  const scaledJ = ijk[1] * spacing[1];
  const scaledK = ijk[2] * spacing[2];

  return [
    origin[0] + direction[0] * scaledI + direction[3] * scaledJ + direction[6] * scaledK,
    origin[1] + direction[1] * scaledI + direction[4] * scaledJ + direction[7] * scaledK,
    origin[2] + direction[2] * scaledI + direction[5] * scaledJ + direction[8] * scaledK,
  ];
}

const tmtvLesionService = new TMTVLesionService();

export default tmtvLesionService;
