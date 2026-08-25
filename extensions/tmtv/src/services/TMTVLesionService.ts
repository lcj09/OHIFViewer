import * as csTools from '@cornerstonejs/tools';
import extractConnectedComponents from '../utils/extractConnectedComponents';
import {
  computeLesionStatisticsForComponent,
  computePatientTotals,
  getCachedVolume,
  getDimensions,
  getScalarData,
} from './TMTVStatisticsService';

const { SegmentationRepresentations } = csTools.Enums;

export type TMTVLesionStatus = 'candidate' | 'confirmed' | 'rejected';
export type TMTVLesionCreatedBy = 'threshold' | 'brush' | 'manual';

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
  suvMin: number | null;
  suvMax: number | null;
  suvMean: number | null;
  tlg: number | null;
  centroid: [number, number, number];
  centroidIJK: [number, number, number];
  // [2026-08-25 功能] 第一阶段 Lesion 确认流程：candidate/confirmed/rejected 只作为业务状态，不改 Segment 1 voxel
  status: TMTVLesionStatus;
  createdBy: TMTVLesionCreatedBy;
  modified: boolean;
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

type TMTVLesionMeta = Pick<TMTVLesion, 'status' | 'createdBy' | 'modified'>;

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
  private lesionMetaByGroupId = new Map<string, Map<string, TMTVLesionMeta>>();

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
    const previousMeta = this.lesionMetaByGroupId.get(groupId) ?? new Map();
    const hasPreviousLesionMeta = previousMeta.size > 0;
    lesions.forEach(lesion => {
      const meta = previousMeta.get(getLesionIdentityKey(lesion));
      const wasEditedBySegmentationTool = !meta && hasPreviousLesionMeta;

      // [2026-08-25 功能] 第二阶段 Brush/Eraser 后形状变化的 lesion 回到 candidate，避免沿用旧确认/拒绝状态
      lesion.status = meta?.status ?? 'candidate';
      lesion.createdBy = meta?.createdBy ?? (wasEditedBySegmentationTool ? 'brush' : 'threshold');
      lesion.modified = meta?.modified ?? wasEditedBySegmentationTool;
    });

    const previousSelectedLesionId = this.selectedLesionIdByGroupId.get(groupId) ?? null;
    const selectedLesionId = lesions.some(lesion => lesion.id === previousSelectedLesionId)
      ? previousSelectedLesionId
      : null;

    const totals = computeConfirmedTotals(lesions);

    const state: TMTVLesionState = {
      segmentationIds,
      segmentIndex,
      selectedLesionId,
      lesions,
      totals,
      updatedAt: Date.now(),
    };

    this.lesionMetaByGroupId.set(groupId, this.createMetaMap(lesions));
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

  public setLesionStatus(
    segmentationIds: string[],
    lesionId: string,
    status: TMTVLesionStatus
  ): TMTVLesionState | null {
    // [2026-08-25 功能] Confirm/Reject 只更新 lesion 业务状态并重算 confirmed totals，不修改真实 Segment 1
    const groupId = this.getGroupId(segmentationIds);
    const state = this.getState(segmentationIds);
    const lesions = state.lesions.map(lesion =>
      lesion.id === lesionId
        ? {
            ...lesion,
            status,
          }
        : lesion
    );

    if (!lesions.some(lesion => lesion.id === lesionId)) {
      return null;
    }

    const nextState = {
      ...state,
      lesions,
      totals: computeConfirmedTotals(lesions),
      updatedAt: Date.now(),
    };

    this.lesionMetaByGroupId.set(groupId, this.createMetaMap(lesions));
    this.stateByGroupId.set(groupId, nextState);
    this.notify();

    return nextState;
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
      const groupId = this.getGroupId(segmentationIds);
      this.stateByGroupId.delete(groupId);
      this.lesionMetaByGroupId.delete(groupId);
    } else {
      this.stateByGroupId.clear();
      this.lesionMetaByGroupId.clear();
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

    const components = extractConnectedComponents({
      scalarData: labelmapScalarData,
      dimensions,
      segmentIndex,
    });

    return components.map((component, componentIndex) => {
      // [2026-08-25 功能] 第三阶段病灶统计统一委托给 TMTVStatisticsService，LesionService 只负责生命周期和列表状态
      const stats = computeLesionStatisticsForComponent({
        voxelIndices: component.voxelIndices,
        dimensions,
        segmentationVolume,
        segmentationVolumeId,
      });

      return {
        id: `${segmentationId}:${segmentIndex}:${componentIndex + 1}`,
        lesionNumber: componentIndex + 1,
        segmentationId,
        segmentIndex,
        voxelIndices: component.voxelIndices,
        voxelCount: component.voxelIndices.length,
        boundsIJK: stats.boundsIJK,
        volume: stats.volume,
        suvMin: stats.suvMin,
        suvMax: stats.suvMax,
        suvMean: stats.suvMean,
        tlg: stats.tlg,
        centroid: stats.centroid,
        centroidIJK: stats.centroidIJK,
        status: 'candidate',
        createdBy: 'threshold',
        modified: false,
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
    const selectedLesionId = state.selectedLesionId === lesionId ? null : state.selectedLesionId;
    const nextState = {
      ...state,
      selectedLesionId,
      lesions,
      totals: computeConfirmedTotals(lesions),
      updatedAt: Date.now(),
    };

    this.lesionMetaByGroupId.set(groupId, this.createMetaMap(lesions));
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

  private createMetaMap(lesions: TMTVLesion[]): Map<string, TMTVLesionMeta> {
    return new Map(
      lesions.map(lesion => [
        getLesionIdentityKey(lesion),
        {
          status: lesion.status,
          createdBy: lesion.createdBy,
          modified: lesion.modified,
        },
      ])
    );
  }
}

function computeConfirmedTotals(lesions: TMTVLesion[]): TMTVLesionState['totals'] {
  // [2026-08-25 功能] 第三阶段患者级 TMTV/TLG 由统计服务统一计算，只纳入 confirmed lesions
  return computePatientTotals(lesions);
}

function getLesionIdentityKey(lesion: TMTVLesion): string {
  // [2026-08-25 功能] 第二阶段用几何身份判断 lesion 是否被 Brush/Eraser 改变；避免删除前序病灶后因重新编号丢失状态
  const { min, max } = lesion.boundsIJK;

  return [
    lesion.segmentationId,
    lesion.segmentIndex,
    lesion.voxelCount,
    getVoxelIndicesHash(lesion.voxelIndices),
    min.join(':'),
    max.join(':'),
  ].join('|');
}

function getVoxelIndicesHash(voxelIndices: number[]): string {
  // [2026-08-25 功能] 第二阶段用轻量 hash 捕捉包围盒不变但内部 voxel 被 Brush/Eraser 改动的情况
  let hash = 2166136261;

  voxelIndices.forEach(voxelIndex => {
    hash ^= voxelIndex;
    hash = Math.imul(hash, 16777619);
  });

  return (hash >>> 0).toString(36);
}

function setScalarValue(
  volume,
  scalarData: ArrayLike<number>,
  voxelIndex: number,
  value: number
): void {
  if (volume?.voxelManager?.setAtIndex) {
    volume.voxelManager.setAtIndex(voxelIndex, value);
    return;
  }

  (scalarData as number[])[voxelIndex] = value;
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

const tmtvLesionService = new TMTVLesionService();

export default tmtvLesionService;
