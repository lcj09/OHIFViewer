import * as csTools from '@cornerstonejs/tools';
import extractConnectedComponents, {
  ConnectedComponent,
} from '../utils/extractConnectedComponents';
import extractConnectedComponentsAsync from '../utils/extractConnectedComponentsAsync';
import {
  computeLesionStatisticsForComponent,
  computePatientTotals,
  getCachedVolume,
  getDimensions,
  getScalarData,
} from './TMTVStatisticsService';
import tmtvSegmentMaskStorageService from './TMTVSegmentMaskStorageService';

const { SegmentationRepresentations } = csTools.Enums;

export type TMTVLesionStatus = 'candidate' | 'confirmed' | 'rejected';
export type TMTVLesionCreatedBy = 'threshold' | 'brush' | 'manual';

export type TMTVLesion = {
  id: string;
  // [2026-08-25 功能] Stable Lesion ID：displayIndex 只用于 UI/报告显示，不能作为 lesion 永久身份
  displayIndex: number;
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
  // [2026-08-26 功能] Merge Lesions：业务合并可包含多个非连续 connected components，但仍不新增 Segment
  mergedLesionIds?: string[];
  // [2026-08-26 功能] Lesion 状态持久化：记录合并前 component 的几何身份，用于刷新后恢复业务合并关系
  mergedLesionIdentityKeys?: string[];
};

export type TMTVLesionState = {
  // 2026-09-02 功能说明：对比模式显式记录 Session 所有权；单检查保持为空以兼容原持久化键。
  sessionId?: string;
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

type VoxelChange = {
  voxelIndex: number;
  before: number;
  after: number;
};

export type TMTVLesionHistoryEntry =
  | {
      type: 'STATUS';
      sessionId?: string;
      segmentationIds: string[];
      lesionId: string;
      displayIndex: number;
      beforeStatus: TMTVLesionStatus;
      afterStatus: TMTVLesionStatus;
    }
  | {
      type: 'BATCH_STATUS';
      sessionId?: string;
      segmentationIds: string[];
      changes: Array<{
        lesionId: string;
        displayIndex: number;
        beforeStatus: TMTVLesionStatus;
        afterStatus: TMTVLesionStatus;
      }>;
    }
  | {
      type: 'LABELMAP';
      sessionId?: string;
      segmentationIds: string[];
      segmentationId: string;
      segmentIndex: number;
      changes: VoxelChange[];
    };

type PendingStatusHistoryApplication = {
  entry: Extract<TMTVLesionHistoryEntry, { type: 'STATUS' }>;
  direction: 'undo' | 'redo';
};

type PersistedTMTVLesion = {
  id: string;
  identityKey: string;
  displayIndex: number;
  lesionNumber: number;
  status: TMTVLesionStatus;
  createdBy: TMTVLesionCreatedBy;
  modified: boolean;
  mergedLesionIdentityKeys?: string[];
};

type PersistedTMTVLesionState = {
  version: 1;
  updatedAt: number;
  lesions: PersistedTMTVLesion[];
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
const PERSISTENCE_KEY_PREFIX = 'ohif:tmtv:lesions:v1:';

export class TMTVLesionService {
  private stateByGroupId = new Map<string, TMTVLesionState>();
  private listeners = new Set<() => void>();
  private selectedLesionIdByGroupId = new Map<string, string | null>();
  private skipNextFullRefreshSegmentationIds = new Set<string>();
  private labelmapSnapshotBySegmentationId = new Map<string, Uint8Array>();
  private historyStack: TMTVLesionHistoryEntry[] = [];
  private redoStack: TMTVLesionHistoryEntry[] = [];
  private isApplyingHistory = false;
  private pendingStatusHistoryByGroupId = new Map<string, PendingStatusHistoryApplication>();
  private mergeGroupByGroupId = new Map<string, Map<string, string>>();
  private asyncExtractionRequestIdByGroupId = new Map<string, number>();
  private generation = 0;

  public subscribe(listener: () => void): Subscription {
    this.listeners.add(listener);

    return {
      unsubscribe: () => {
        this.listeners.delete(listener);
      },
    };
  }

  public getState(segmentationIds: string[] = [], sessionId?: string): TMTVLesionState {
    const groupId = this.getGroupId(segmentationIds, sessionId);
    return (
      this.stateByGroupId.get(groupId) ?? {
        ...EMPTY_STATE,
        sessionId,
        segmentationIds: [...segmentationIds],
      }
    );
  }

  public extractLesionsForSegmentations(
    segmentations: any[] = [],
    segmentIndex = 1,
    sessionId?: string
  ): TMTVLesionState {
    // [2026-08-24 功能] 从 Segment 1 labelmap 重新提取 3D 连通病灶并生成统计状态
    const segmentationIds = segmentations
      .map(segmentation => segmentation?.segmentationId)
      .filter(Boolean);
    const lesions: TMTVLesion[] = [];

    segmentations.forEach(segmentation => {
      this.recordLabelmapHistoryFromSegmentation(
        segmentation,
        segmentIndex,
        segmentationIds,
        sessionId
      );
      lesions.push(...this.extractLesionsForSegmentation(segmentation, segmentIndex));
      this.schedulePersistedSegmentMaskSave(segmentation, segmentIndex);
    });

    return this.finalizeExtractedLesionState(segmentationIds, segmentIndex, lesions, sessionId);
  }

  private finalizeExtractedLesionState(
    segmentationIds: string[],
    segmentIndex: number,
    lesions: TMTVLesion[],
    sessionId?: string
  ): TMTVLesionState {
    // [2026-08-26 功能] Web Worker 加速：同步/异步 connected components 共用状态收敛逻辑，避免两条链路结果不一致
    const groupId = this.getGroupId(segmentationIds, sessionId);
    const stableLesions = this.reconcileStableLesionIdentities(groupId, lesions);
    this.restorePersistedMergeGroups(groupId, stableLesions);
    const reconciledLesions = this.applyMergeGroups(groupId, stableLesions);

    const previousSelectedLesionId = this.selectedLesionIdByGroupId.get(groupId) ?? null;
    const selectedLesionId = reconciledLesions.some(
      lesion => lesion.id === previousSelectedLesionId
    )
      ? previousSelectedLesionId
      : null;

    const totals = computeConfirmedTotals(reconciledLesions);

    const state: TMTVLesionState = {
      sessionId,
      segmentationIds,
      segmentIndex,
      selectedLesionId,
      lesions: reconciledLesions,
      totals,
      updatedAt: Date.now(),
    };

    this.selectedLesionIdByGroupId.set(groupId, selectedLesionId);
    this.stateByGroupId.set(groupId, state);
    this.applyPendingStatusHistoryApplication(groupId);
    this.persistState(groupId, this.stateByGroupId.get(groupId) ?? state);
    this.notify();

    return state;
  }

  public async extractLesionsForSegmentationsAsync(
    segmentations: any[] = [],
    segmentIndex = 1,
    options: { restorePersistedMask?: boolean; sessionId?: string } = {}
  ): Promise<TMTVLesionState> {
    // [2026-08-26 功能] Web Worker 加速：异步提取 Segment 1 连通病灶，避免大 labelmap 分析阻塞右侧面板
    const segmentationIds = segmentations
      .map(segmentation => segmentation?.segmentationId)
      .filter(Boolean);
    const sessionId = options.sessionId;
    const groupId = this.getGroupId(segmentationIds, sessionId);
    const requestId = (this.asyncExtractionRequestIdByGroupId.get(groupId) ?? 0) + 1;
    const requestGeneration = this.generation;

    this.asyncExtractionRequestIdByGroupId.set(groupId, requestId);

    if (options.restorePersistedMask) {
      await Promise.all(
        segmentations.map(segmentation =>
          this.restorePersistedSegmentMaskIfNeeded(segmentation, segmentIndex, requestGeneration)
        )
      );
    }

    if (
      this.generation !== requestGeneration ||
      this.asyncExtractionRequestIdByGroupId.get(groupId) !== requestId
    ) {
      return this.getState(segmentationIds, sessionId);
    }

    const lesionGroups = await Promise.all(
      segmentations.map(async segmentation => {
        this.recordLabelmapHistoryFromSegmentation(
          segmentation,
          segmentIndex,
          segmentationIds,
          sessionId
        );
        const lesions = await this.extractLesionsForSegmentationAsync(
          segmentation,
          segmentIndex,
          requestGeneration
        );
        return lesions;
      })
    );
    const lesions = lesionGroups.flat();

    if (
      this.generation !== requestGeneration ||
      this.asyncExtractionRequestIdByGroupId.get(groupId) !== requestId
    ) {
      return this.getState(segmentationIds, sessionId);
    }

    segmentations.forEach(segmentation => {
      this.schedulePersistedSegmentMaskSave(segmentation, segmentIndex);
    });

    return this.finalizeExtractedLesionState(segmentationIds, segmentIndex, lesions, sessionId);
  }

  public selectLesion(
    segmentationIds: string[],
    lesionId: string | null,
    sessionId?: string
  ): TMTVLesion | null {
    // [2026-08-24 功能] 只更新 TMTV lesion 选中状态，保持底层 Segment 1 不变
    const groupId = this.getGroupId(segmentationIds, sessionId);
    const state = this.getState(segmentationIds, sessionId);
    const selectedLesion = lesionId
      ? (state.lesions.find(lesion => lesion.id === lesionId) ?? null)
      : null;
    const selectedLesionId = selectedLesion?.id ?? null;

    this.selectedLesionIdByGroupId.set(groupId, selectedLesionId);
    this.stateByGroupId.set(groupId, {
      ...state,
      selectedLesionId,
    });
    this.persistState(groupId, this.stateByGroupId.get(groupId) ?? state);
    this.notify();

    return selectedLesion;
  }

  public setLesionStatus(
    segmentationIds: string[],
    lesionId: string,
    status: TMTVLesionStatus,
    recordHistory = true,
    sessionId?: string
  ): TMTVLesionState | null {
    // [2026-08-25 功能] Confirm/Reject 只更新 lesion 业务状态并重算 confirmed totals，不修改真实 Segment 1
    const groupId = this.getGroupId(segmentationIds, sessionId);
    const state = this.getState(segmentationIds, sessionId);
    const previousLesion = state.lesions.find(lesion => lesion.id === lesionId);

    if (!previousLesion || previousLesion.status === status) {
      return null;
    }

    const lesions = state.lesions.map(lesion =>
      lesion.id === lesionId
        ? {
            ...lesion,
            status,
          }
        : lesion
    );

    const nextState = {
      ...state,
      lesions,
      totals: computeConfirmedTotals(lesions),
      updatedAt: Date.now(),
    };

    if (recordHistory && !this.isApplyingHistory) {
      this.pushHistory({
        type: 'STATUS',
        sessionId,
        segmentationIds: [...segmentationIds],
        lesionId,
        displayIndex: previousLesion.displayIndex,
        beforeStatus: previousLesion.status,
        afterStatus: status,
      });
    }

    this.stateByGroupId.set(groupId, nextState);
    this.persistState(groupId, nextState);
    this.notify();

    return nextState;
  }

  public setLesionStatuses(
    segmentationIds: string[],
    lesionIds: string[],
    status: TMTVLesionStatus,
    recordHistory = true,
    sessionId?: string
  ): TMTVLesionState | null {
    // [2026-08-26 功能] 批量 Confirm/Reject：一次更新多个 lesion 业务状态，避免几十个候选需要逐个点击
    const groupId = this.getGroupId(segmentationIds, sessionId);
    const state = this.getState(segmentationIds, sessionId);
    const targetLesionIds = new Set((lesionIds ?? []).filter(Boolean));

    if (!targetLesionIds.size) {
      return null;
    }

    const changes = state.lesions
      .filter(lesion => targetLesionIds.has(lesion.id) && lesion.status !== status)
      .map(lesion => ({
        lesionId: lesion.id,
        displayIndex: lesion.displayIndex,
        beforeStatus: lesion.status,
        afterStatus: status,
      }));

    if (!changes.length) {
      return null;
    }

    const changeByLesionId = new Map(changes.map(change => [change.lesionId, change]));
    const lesions = state.lesions.map(lesion => {
      const change = changeByLesionId.get(lesion.id);

      return change
        ? {
            ...lesion,
            status: change.afterStatus,
          }
        : lesion;
    });
    const nextSelectedLesionId =
      state.selectedLesionId && lesions.some(lesion => lesion.id === state.selectedLesionId)
        ? state.selectedLesionId
        : null;
    const nextState = {
      ...state,
      selectedLesionId: nextSelectedLesionId,
      lesions,
      totals: computeConfirmedTotals(lesions),
      updatedAt: Date.now(),
    };

    if (recordHistory && !this.isApplyingHistory) {
      this.pushHistory({
        type: 'BATCH_STATUS',
        sessionId,
        segmentationIds: [...segmentationIds],
        changes,
      });
    }

    this.selectedLesionIdByGroupId.set(groupId, nextSelectedLesionId);
    this.stateByGroupId.set(groupId, nextState);
    this.persistState(groupId, nextState);
    this.notify();

    return nextState;
  }

  public deleteLesion(
    lesionId: string,
    segmentIndex = 1,
    sessionId?: string
  ): TMTVLesionState | null {
    // [2026-08-24 功能] 删除病灶时真实回写 Segment 1 labelmap，而不是只从 UI 数组移除
    const state = this.findStateForLesion(lesionId, sessionId);
    const lesion = state?.lesions.find(candidate => candidate.id === lesionId);

    if (!state || !lesion) {
      return null;
    }

    const segmentationVolume = this.getSegmentationVolume(lesion.segmentationId);
    const scalarData = getScalarData(segmentationVolume);

    if (!segmentationVolume || !scalarData) {
      return null;
    }

    const changes: VoxelChange[] = [];
    lesion.voxelIndices.forEach(voxelIndex => {
      if (scalarData[voxelIndex] === segmentIndex) {
        changes.push({
          voxelIndex,
          before: segmentIndex,
          after: 0,
        });
        setScalarValue(segmentationVolume, scalarData, voxelIndex, 0);
      }
    });

    if (changes.length && !this.isApplyingHistory) {
      this.pushHistory({
        type: 'LABELMAP',
        sessionId: state.sessionId,
        segmentationIds: [...state.segmentationIds],
        segmentationId: lesion.segmentationId,
        segmentIndex,
        changes,
      });
      this.updateLabelmapSnapshot(lesion.segmentationId, scalarData, segmentIndex);
    }

    // [2026-08-24 功能] 删除单个完整连通域时增量更新 lesion state，避免立即全量扫描 labelmap
    const nextState = this.removeLesionFromState(state, lesionId);
    this.skipNextFullRefreshSegmentationIds.add(lesion.segmentationId);
    this.savePersistedSegmentMaskNow(
      {
        segmentationId: lesion.segmentationId,
        representationData: {
          [SegmentationRepresentations.Labelmap]: {
            volumeId: segmentationVolume.volumeId,
          },
        },
      },
      segmentIndex
    );
    segmentationVolume.modified?.();
    csTools.segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(
      lesion.segmentationId,
      getModifiedSlices(lesion.voxelIndices, getDimensions(segmentationVolume)),
      segmentIndex
    );

    return nextState;
  }

  public deleteLesions(
    segmentationIds: string[],
    lesionIds: string[],
    segmentIndex = 1,
    sessionId?: string
  ): TMTVLesionState | null {
    // [2026-08-27 功能] 批量删除 rejected 病灶：一次清空多个 connected components，避免医生逐层用橡皮擦扫除
    const state = this.getState(segmentationIds, sessionId);
    const targetLesionIds = new Set((lesionIds ?? []).filter(Boolean));

    if (!targetLesionIds.size) {
      return null;
    }

    const lesionsToDelete = state.lesions.filter(lesion => targetLesionIds.has(lesion.id));

    if (!lesionsToDelete.length) {
      return null;
    }

    const volumeDataBySegmentationId = new Map<
      string,
      {
        segmentationVolume: any;
        scalarData: ArrayLike<number>;
        changes: VoxelChange[];
        voxelIndices: number[];
      }
    >();
    const deletableLesionIds = new Set<string>();

    lesionsToDelete.forEach(lesion => {
      const segmentationVolume = this.getSegmentationVolume(lesion.segmentationId);
      const scalarData = getScalarData(segmentationVolume);

      if (!segmentationVolume || !scalarData) {
        return;
      }

      let volumeData = volumeDataBySegmentationId.get(lesion.segmentationId);

      if (!volumeData) {
        volumeData = {
          segmentationVolume,
          scalarData,
          changes: [],
          voxelIndices: [],
        };
        volumeDataBySegmentationId.set(lesion.segmentationId, volumeData);
      }

      deletableLesionIds.add(lesion.id);

      lesion.voxelIndices.forEach(voxelIndex => {
        if (scalarData[voxelIndex] !== segmentIndex) {
          return;
        }

        volumeData.changes.push({
          voxelIndex,
          before: segmentIndex,
          after: 0,
        });
        volumeData.voxelIndices.push(voxelIndex);
        setScalarValue(segmentationVolume, scalarData, voxelIndex, 0);
      });
    });

    if (!volumeDataBySegmentationId.size) {
      return null;
    }

    volumeDataBySegmentationId.forEach((volumeData, segmentationId) => {
      if (!volumeData.changes.length) {
        return;
      }

      if (!this.isApplyingHistory) {
        this.pushHistory({
          type: 'LABELMAP',
          sessionId: state.sessionId,
          segmentationIds: [...state.segmentationIds],
          segmentationId,
          segmentIndex,
          changes: volumeData.changes,
        });
        this.updateLabelmapSnapshot(segmentationId, volumeData.scalarData, segmentIndex);
      }

      this.skipNextFullRefreshSegmentationIds.add(segmentationId);
      this.savePersistedSegmentMaskNow(
        {
          segmentationId,
          representationData: {
            [SegmentationRepresentations.Labelmap]: {
              volumeId: volumeData.segmentationVolume.volumeId,
            },
          },
        },
        segmentIndex
      );
      volumeData.segmentationVolume.modified?.();
      csTools.segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(
        segmentationId,
        getModifiedSlices(volumeData.voxelIndices, getDimensions(volumeData.segmentationVolume)),
        segmentIndex
      );
    });

    return this.removeLesionsFromState(state, Array.from(deletableLesionIds));
  }

  public mergeLesions(
    segmentationIds: string[],
    lesionIds: string[],
    sessionId?: string
  ): TMTVLesionState | null {
    // [2026-08-26 功能] Merge Lesions：只做 lesion/finding 业务合并，不强行修改 Segment 1 voxel 或创建桥接区域
    const groupId = this.getGroupId(segmentationIds, sessionId);
    const state = this.getState(segmentationIds, sessionId);
    const uniqueLesionIds = Array.from(new Set(lesionIds));
    const lesionsToMerge = uniqueLesionIds
      .map(lesionId => state.lesions.find(lesion => lesion.id === lesionId))
      .filter(Boolean) as TMTVLesion[];

    if (lesionsToMerge.length < 2) {
      return null;
    }

    const primaryLesion = lesionsToMerge.reduce((primary, lesion) =>
      lesion.displayIndex < primary.displayIndex ? lesion : primary
    );
    const mergeGroup = this.mergeGroupByGroupId.get(groupId) ?? new Map<string, string>();

    lesionsToMerge.forEach(lesion => {
      mergeGroup.set(lesion.id, primaryLesion.id);
      lesion.mergedLesionIds?.forEach(mergedLesionId => {
        mergeGroup.set(mergedLesionId, primaryLesion.id);
      });
    });

    this.mergeGroupByGroupId.set(groupId, mergeGroup);

    const nextLesions = this.applyMergeGroups(groupId, state.lesions);
    const nextState = {
      ...state,
      selectedLesionId: primaryLesion.id,
      lesions: nextLesions,
      totals: computeConfirmedTotals(nextLesions),
      updatedAt: Date.now(),
    };

    this.selectedLesionIdByGroupId.set(groupId, primaryLesion.id);
    this.stateByGroupId.set(groupId, nextState);
    this.persistState(groupId, nextState);
    this.notify();

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

  public reset(segmentationIds?: string[], sessionId?: string): void {
    // 2026-09-02 功能说明：按 Session 重置 lesion 状态，并释放对应 snapshot/history 中的大体素索引引用。
    if (sessionId || segmentationIds?.length) {
      const requestedSegmentationIds = segmentationIds || [];
      const groupId = this.getGroupId(requestedSegmentationIds, sessionId);
      const ownedSegmentationIds = this.stateByGroupId.get(groupId)?.segmentationIds || [];
      const segmentationIdSet = new Set([...requestedSegmentationIds, ...ownedSegmentationIds]);

      this.stateByGroupId.delete(groupId);
      this.mergeGroupByGroupId.delete(groupId);
      this.selectedLesionIdByGroupId.delete(groupId);
      this.asyncExtractionRequestIdByGroupId.set(
        groupId,
        (this.asyncExtractionRequestIdByGroupId.get(groupId) ?? 0) + 1
      );
      segmentationIdSet.forEach(segmentationId => {
        this.skipNextFullRefreshSegmentationIds.delete(segmentationId);
        this.labelmapSnapshotBySegmentationId.delete(segmentationId);
      });
      this.historyStack = this.historyStack.filter(entry =>
        sessionId
          ? entry.sessionId !== sessionId
          : !doesHistoryEntryTouchSegmentations(entry, segmentationIdSet)
      );
      this.redoStack = this.redoStack.filter(entry =>
        sessionId
          ? entry.sessionId !== sessionId
          : !doesHistoryEntryTouchSegmentations(entry, segmentationIdSet)
      );
      this.pendingStatusHistoryByGroupId.delete(groupId);
      this.asyncExtractionRequestIdByGroupId.delete(groupId);
    } else {
      this.clearState();
    }

    this.notify();
  }

  public destroy(): void {
    // [2026-08-28 功能] TMTV 模式退出时释放单例持有的 listener 闭包、lesion voxelIndices、labelmap snapshot 和 undo/redo diff
    this.clearState();
    this.listeners.clear();
  }

  public undo(sessionId?: string): TMTVLesionHistoryEntry | null {
    const entry = this.popHistoryEntry(this.historyStack, sessionId);

    if (!entry) {
      return null;
    }

    this.isApplyingHistory = true;
    const applied = this.applyHistoryEntry(entry, 'undo');
    this.isApplyingHistory = false;

    if (!applied) {
      if (entry.type === 'STATUS') {
        this.pendingStatusHistoryByGroupId.set(
          this.getGroupId(entry.segmentationIds, entry.sessionId),
          { entry, direction: 'undo' }
        );
      }

      return entry;
    }

    this.redoStack.push(entry);

    return entry;
  }

  public redo(sessionId?: string): TMTVLesionHistoryEntry | null {
    const entry = this.popHistoryEntry(this.redoStack, sessionId);

    if (!entry) {
      return null;
    }

    this.isApplyingHistory = true;
    const applied = this.applyHistoryEntry(entry, 'redo');
    this.isApplyingHistory = false;

    if (!applied) {
      if (entry.type === 'STATUS') {
        this.pendingStatusHistoryByGroupId.set(
          this.getGroupId(entry.segmentationIds, entry.sessionId),
          { entry, direction: 'redo' }
        );
      }

      return entry;
    }

    this.historyStack.push(entry);

    return entry;
  }

  private extractLesionsForSegmentation(segmentation: any, segmentIndex: number): TMTVLesion[] {
    // [2026-08-24 功能] 读取指定 segmentation 的 volume labelmap，按 Segment 1 做 lesion separation
    const segmentationData = this.getSegmentationExtractionData(segmentation);

    if (!segmentationData) {
      return [];
    }

    const {
      segmentationId,
      segmentationVolumeId,
      segmentationVolume,
      labelmapScalarData,
      dimensions,
    } = segmentationData;
    const components = extractConnectedComponents({
      scalarData: labelmapScalarData,
      dimensions,
      segmentIndex,
    });

    return this.createLesionsFromComponents({
      components,
      segmentationId,
      segmentIndex,
      segmentationVolume,
      segmentationVolumeId,
      dimensions,
    });
  }

  private getSegmentationExtractionData(segmentation: any): {
    segmentationId: string;
    segmentationVolumeId: string;
    segmentationVolume: any;
    labelmapScalarData: ArrayLike<number>;
    dimensions: [number, number, number];
  } | null {
    const segmentationId = segmentation?.segmentationId;
    const labelmapData =
      segmentation?.representationData?.[SegmentationRepresentations.Labelmap] ??
      segmentation?.representationData?.Labelmap;
    const segmentationVolumeId = (labelmapData as any)?.volumeId;

    if (!segmentationId || !segmentationVolumeId) {
      return null;
    }

    const segmentationVolume = getCachedVolume(segmentationVolumeId);
    const labelmapScalarData = getScalarData(segmentationVolume);
    const dimensions = getDimensions(segmentationVolume);

    if (!segmentationVolume || !labelmapScalarData || !dimensions) {
      return null;
    }

    return {
      segmentationId,
      segmentationVolumeId,
      segmentationVolume,
      labelmapScalarData,
      dimensions,
    };
  }

  private createLesionsFromComponents({
    components,
    segmentationId,
    segmentIndex,
    segmentationVolume,
    segmentationVolumeId,
    dimensions,
  }: {
    components: ConnectedComponent[];
    segmentationId: string;
    segmentIndex: number;
    segmentationVolume: any;
    segmentationVolumeId: string;
    dimensions: [number, number, number];
  }): TMTVLesion[] {
    return components.map((component, componentIndex) => {
      // [2026-08-25 功能] 第三阶段病灶统计统一委托给 TMTVStatisticsService，LesionService 只负责生命周期和列表状态
      const stats = computeLesionStatisticsForComponent({
        voxelIndices: component.voxelIndices,
        dimensions,
        segmentationVolume,
        segmentationVolumeId,
      });

      return {
        id: createStableLesionId(),
        displayIndex: componentIndex + 1,
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

  private async extractLesionsForSegmentationAsync(
    segmentation: any,
    segmentIndex: number,
    requestGeneration: number
  ): Promise<TMTVLesion[]> {
    // [2026-08-26 功能] Web Worker 加速：connected components 在 worker 执行，SUV/World 统计仍留主线程访问 Cornerstone volume
    const segmentationData = this.getSegmentationExtractionData(segmentation);

    if (!segmentationData) {
      return [];
    }

    const {
      segmentationId,
      segmentationVolumeId,
      segmentationVolume,
      labelmapScalarData,
      dimensions,
    } = segmentationData;
    const components = await extractConnectedComponentsAsync({
      scalarData: labelmapScalarData,
      dimensions,
      segmentIndex,
    });

    if (this.generation !== requestGeneration) {
      return [];
    }

    return this.createLesionsFromComponents({
      components,
      segmentationId,
      segmentIndex,
      segmentationVolume,
      segmentationVolumeId,
      dimensions,
    });
  }

  private async restorePersistedSegmentMaskIfNeeded(
    segmentation: any,
    segmentIndex: number,
    requestGeneration: number
  ): Promise<void> {
    // [2026-08-26 功能] IndexedDB 稀疏保存/恢复 Segment 1 mask：仅当当前 Segment 1 为空时恢复，避免覆盖医生已重新绘制的分割
    const segmentationData = this.getSegmentationExtractionData(segmentation);

    if (!segmentationData) {
      return;
    }

    const {
      segmentationId,
      segmentationVolumeId,
      segmentationVolume,
      labelmapScalarData,
      dimensions,
    } = segmentationData;

    if (hasSegmentVoxels(labelmapScalarData, segmentIndex)) {
      return;
    }

    const persistedMask = await tmtvSegmentMaskStorageService.loadSegmentMask({
      segmentationId,
      segmentationVolumeId,
      segmentationVolume,
      segmentIndex,
      dimensions,
    });

    if (this.generation !== requestGeneration || !persistedMask?.voxelIndices?.length) {
      return;
    }

    persistedMask.voxelIndices.forEach(voxelIndex => {
      if (voxelIndex < labelmapScalarData.length) {
        setScalarValue(segmentationVolume, labelmapScalarData, voxelIndex, segmentIndex);
      }
    });

    this.updateLabelmapSnapshot(segmentationId, labelmapScalarData, segmentIndex);
    this.skipNextFullRefreshSegmentationIds.add(segmentationId);
    segmentationVolume.modified?.();
    csTools.segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(
      segmentationId,
      getModifiedSlices(Array.from(persistedMask.voxelIndices), dimensions),
      segmentIndex
    );
  }

  private schedulePersistedSegmentMaskSave(segmentation: any, segmentIndex: number): void {
    // [2026-08-26 功能] IndexedDB 稀疏保存/恢复 Segment 1 mask：分割稳定后保存稀疏 voxel 下标，刷新页面可恢复本地 mask
    const segmentationData = this.getSegmentationExtractionData(segmentation);

    if (!segmentationData) {
      return;
    }

    const {
      segmentationId,
      segmentationVolumeId,
      segmentationVolume,
      labelmapScalarData,
      dimensions,
    } = segmentationData;

    tmtvSegmentMaskStorageService.scheduleSaveSegmentMask({
      segmentationId,
      segmentationVolumeId,
      segmentationVolume,
      scalarData: labelmapScalarData,
      segmentIndex,
      dimensions,
    });
  }

  private savePersistedSegmentMaskNow(segmentation: any, segmentIndex: number): void {
    // [2026-08-27 功能] 删除病灶后立即同步本地 mask；如果 Segment 1 已空，IndexedDB 记录会立刻清除
    const segmentationData = this.getSegmentationExtractionData(segmentation);

    if (!segmentationData) {
      return;
    }

    const {
      segmentationId,
      segmentationVolumeId,
      segmentationVolume,
      labelmapScalarData,
      dimensions,
    } = segmentationData;

    tmtvSegmentMaskStorageService.saveSegmentMask({
      segmentationId,
      segmentationVolumeId,
      segmentationVolume,
      scalarData: labelmapScalarData,
      segmentIndex,
      dimensions,
    });
  }

  private getGroupId(segmentationIds: string[], sessionId?: string): string {
    // 2026-09-02 功能说明：对比模式按 Session 隔离；单检查继续沿用 segmentationIds 键。
    return sessionId ? `session:${sessionId}` : [...segmentationIds].sort().join(',');
  }

  private findStateForLesion(lesionId: string, sessionId?: string): TMTVLesionState | null {
    if (sessionId) {
      const state = this.stateByGroupId.get(this.getGroupId([], sessionId));
      return state?.lesions.some(lesion => lesion.id === lesionId) ? state : null;
    }

    for (const state of this.stateByGroupId.values()) {
      if (state.lesions.some(lesion => lesion.id === lesionId)) {
        return state;
      }
    }

    return null;
  }

  private removeLesionFromState(state: TMTVLesionState, lesionId: string): TMTVLesionState {
    const groupId = this.getGroupId(state.segmentationIds, state.sessionId);
    const lesions = state.lesions.filter(lesion => lesion.id !== lesionId);
    const selectedLesionId = state.selectedLesionId === lesionId ? null : state.selectedLesionId;
    const nextState = {
      ...state,
      selectedLesionId,
      lesions,
      totals: computeConfirmedTotals(lesions),
      updatedAt: Date.now(),
    };

    this.selectedLesionIdByGroupId.set(groupId, selectedLesionId);
    this.stateByGroupId.set(groupId, nextState);
    this.persistState(groupId, nextState);
    this.notify();

    return nextState;
  }

  private removeLesionsFromState(state: TMTVLesionState, lesionIds: string[]): TMTVLesionState {
    // [2026-08-27 功能] 批量删除后一次性移除右侧列表项和选中态，避免多次 notify 造成面板抖动
    const groupId = this.getGroupId(state.segmentationIds, state.sessionId);
    const targetLesionIds = new Set(lesionIds);
    const lesions = state.lesions.filter(lesion => !targetLesionIds.has(lesion.id));
    const selectedLesionId =
      state.selectedLesionId && targetLesionIds.has(state.selectedLesionId)
        ? null
        : state.selectedLesionId;
    const nextState = {
      ...state,
      selectedLesionId,
      lesions,
      totals: computeConfirmedTotals(lesions),
      updatedAt: Date.now(),
    };

    this.selectedLesionIdByGroupId.set(groupId, selectedLesionId);
    this.stateByGroupId.set(groupId, nextState);
    this.persistState(groupId, nextState);
    this.notify();

    return nextState;
  }

  private getSegmentationVolume(segmentationId: string) {
    const segmentation = csTools.segmentation.state.getSegmentation(segmentationId);

    return this.getSegmentationVolumeFromSegmentation(segmentation);
  }

  private getSegmentationVolumeFromSegmentation(segmentation: any) {
    const labelmapData =
      segmentation?.representationData?.[SegmentationRepresentations.Labelmap] ??
      segmentation?.representationData?.Labelmap;
    const segmentationVolumeId = (labelmapData as any)?.volumeId;

    if (!segmentationVolumeId) {
      return null;
    }

    return getCachedVolume(segmentationVolumeId);
  }

  private clearState(): void {
    this.generation++;
    this.stateByGroupId.clear();
    this.selectedLesionIdByGroupId.clear();
    this.skipNextFullRefreshSegmentationIds.clear();
    this.labelmapSnapshotBySegmentationId.clear();
    this.historyStack = [];
    this.redoStack = [];
    this.isApplyingHistory = false;
    this.pendingStatusHistoryByGroupId.clear();
    this.mergeGroupByGroupId.clear();
    this.asyncExtractionRequestIdByGroupId.clear();
  }

  private notify(): void {
    this.listeners.forEach(listener => listener());
  }

  private pushHistory(entry: TMTVLesionHistoryEntry): void {
    // 2026-09-02 功能说明：历史记录携带 Session，新增编辑只清空同一 Session 的 redo。
    this.historyStack.push(entry);
    this.redoStack = this.redoStack.filter(item => item.sessionId !== entry.sessionId);
  }

  private popHistoryEntry(
    stack: TMTVLesionHistoryEntry[],
    sessionId?: string
  ): TMTVLesionHistoryEntry | null {
    if (!stack.length) return null;
    if (!sessionId) return stack.pop() ?? null;

    for (let index = stack.length - 1; index >= 0; index--) {
      if (stack[index].sessionId !== sessionId) continue;
      return stack.splice(index, 1)[0];
    }

    return null;
  }

  private applyHistoryEntry(entry: TMTVLesionHistoryEntry, direction: 'undo' | 'redo'): boolean {
    if (entry.type === 'STATUS') {
      return this.applyStatusHistory(entry, direction);
    }

    if (entry.type === 'BATCH_STATUS') {
      return this.applyBatchStatusHistory(entry, direction);
    }

    this.applyLabelmapHistory(entry, direction);
    return true;
  }

  private applyStatusHistory(
    entry: Extract<TMTVLesionHistoryEntry, { type: 'STATUS' }>,
    direction: 'undo' | 'redo'
  ): boolean {
    const state = this.getState(entry.segmentationIds, entry.sessionId);
    const targetLesion =
      state.lesions.find(lesion => lesion.id === entry.lesionId) ??
      state.lesions.find(lesion => lesion.displayIndex === entry.displayIndex);

    if (!targetLesion) {
      return false;
    }

    // [2026-08-26 功能] Redo 状态恢复时用 stable UUID 优先、displayIndex 兜底，解决 Split 重建后状态 Redo 找不到 lesion 的问题
    const desiredStatus = direction === 'undo' ? entry.beforeStatus : entry.afterStatus;

    if (targetLesion.status === desiredStatus) {
      return true;
    }

    return !!this.setLesionStatus(
      entry.segmentationIds,
      targetLesion.id,
      desiredStatus,
      false,
      entry.sessionId
    );
  }

  private applyBatchStatusHistory(
    entry: Extract<TMTVLesionHistoryEntry, { type: 'BATCH_STATUS' }>,
    direction: 'undo' | 'redo'
  ): boolean {
    // [2026-08-26 功能] 批量状态 Undo/Redo：用 stable UUID 优先、displayIndex 兜底，保持批量审核可回退
    const state = this.getState(entry.segmentationIds, entry.sessionId);
    const targetStatusByLesionId = new Map<string, TMTVLesionStatus>();

    entry.changes.forEach(change => {
      const targetLesion =
        state.lesions.find(lesion => lesion.id === change.lesionId) ??
        state.lesions.find(lesion => lesion.displayIndex === change.displayIndex);

      if (!targetLesion) {
        return;
      }

      targetStatusByLesionId.set(
        targetLesion.id,
        direction === 'undo' ? change.beforeStatus : change.afterStatus
      );
    });

    if (!targetStatusByLesionId.size) {
      return false;
    }

    const targetLesionIds = Array.from(targetStatusByLesionId.keys());
    const uniqueTargetStatuses = new Set(targetStatusByLesionId.values());

    if (uniqueTargetStatuses.size === 1) {
      return !!this.setLesionStatuses(
        entry.segmentationIds,
        targetLesionIds,
        Array.from(uniqueTargetStatuses)[0],
        false,
        entry.sessionId
      );
    }

    const groupId = this.getGroupId(entry.segmentationIds, entry.sessionId);
    const lesions = state.lesions.map(lesion => {
      const status = targetStatusByLesionId.get(lesion.id);

      return status
        ? {
            ...lesion,
            status,
          }
        : lesion;
    });
    const nextState = {
      ...state,
      lesions,
      totals: computeConfirmedTotals(lesions),
      updatedAt: Date.now(),
    };

    this.stateByGroupId.set(groupId, nextState);
    this.persistState(groupId, nextState);
    this.notify();

    return true;
  }

  private applyPendingStatusHistoryApplication(groupId: string): void {
    const pendingApplication = this.pendingStatusHistoryByGroupId.get(groupId);
    if (!pendingApplication) {
      return;
    }

    const { entry, direction } = pendingApplication;
    this.isApplyingHistory = true;
    const applied = this.applyStatusHistory(entry, direction);
    this.isApplyingHistory = false;

    if (!applied) {
      return;
    }

    this.pendingStatusHistoryByGroupId.delete(groupId);

    if (direction === 'undo') {
      this.redoStack.push(entry);
    } else {
      this.historyStack.push(entry);
    }
  }

  private applyLabelmapHistory(
    entry: Extract<TMTVLesionHistoryEntry, { type: 'LABELMAP' }>,
    direction: 'undo' | 'redo'
  ): void {
    const segmentationVolume = this.getSegmentationVolume(entry.segmentationId);
    const scalarData = getScalarData(segmentationVolume);

    if (!segmentationVolume || !scalarData) {
      return;
    }

    entry.changes.forEach(change => {
      setScalarValue(
        segmentationVolume,
        scalarData,
        change.voxelIndex,
        direction === 'undo' ? change.before : change.after
      );
    });

    this.updateLabelmapSnapshot(entry.segmentationId, scalarData, entry.segmentIndex);
    segmentationVolume.modified?.();
    csTools.segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(
      entry.segmentationId,
      getModifiedSlices(
        entry.changes.map(change => change.voxelIndex),
        getDimensions(segmentationVolume)
      ),
      entry.segmentIndex
    );
  }

  private recordLabelmapHistoryFromSegmentation(
    segmentation: any,
    segmentIndex: number,
    segmentationIds: string[],
    sessionId?: string
  ): void {
    const segmentationId = segmentation?.segmentationId;
    const segmentationVolume = this.getSegmentationVolumeFromSegmentation(segmentation);
    const scalarData = getScalarData(segmentationVolume);

    if (!segmentationId || !segmentationVolume || !scalarData) {
      return;
    }

    const previousSnapshot = this.labelmapSnapshotBySegmentationId.get(segmentationId);
    const nextSnapshot = createSegmentMaskSnapshot(scalarData, segmentIndex);

    if (!previousSnapshot) {
      this.labelmapSnapshotBySegmentationId.set(segmentationId, nextSnapshot);
      return;
    }

    if (!this.isApplyingHistory) {
      const changes = getSnapshotVoxelChanges(previousSnapshot, nextSnapshot, segmentIndex);

      if (changes.length) {
        this.pushHistory({
          type: 'LABELMAP',
          sessionId,
          segmentationIds: [...segmentationIds],
          segmentationId,
          segmentIndex,
          changes,
        });
      }
    }

    this.labelmapSnapshotBySegmentationId.set(segmentationId, nextSnapshot);
  }

  private updateLabelmapSnapshot(
    segmentationId: string,
    scalarData: ArrayLike<number>,
    segmentIndex: number
  ): void {
    this.labelmapSnapshotBySegmentationId.set(
      segmentationId,
      createSegmentMaskSnapshot(scalarData, segmentIndex)
    );
  }

  private reconcileStableLesionIdentities(
    groupId: string,
    nextLesions: TMTVLesion[]
  ): TMTVLesion[] {
    // [2026-08-25 功能] Stable Lesion ID：Connected Components 重建后通过 voxel overlap 继承旧 UUID，displayIndex 不随删除/重排漂移
    const previousLesions = this.stateByGroupId.get(groupId)?.lesions ?? [];
    const persistedState = previousLesions.length ? null : this.loadPersistedState(groupId);
    const persistedLesionByIdentityKey = new Map(
      (persistedState?.lesions ?? []).map(lesion => [lesion.identityKey, lesion])
    );
    const usedPreviousLesionIds = new Set<string>();
    let nextDisplayIndex = Math.max(
      getNextDisplayIndex(previousLesions),
      getNextPersistedDisplayIndex(persistedState?.lesions ?? [])
    );

    return nextLesions.map((lesion, index) => {
      const matchedLesion = findBestMatchingPreviousLesion(
        lesion,
        previousLesions,
        usedPreviousLesionIds
      );

      if (!matchedLesion) {
        const persistedLesion = persistedLesionByIdentityKey.get(getLesionIdentityKey(lesion));

        if (persistedLesion) {
          return {
            ...lesion,
            id: persistedLesion.id,
            displayIndex: persistedLesion.displayIndex,
            lesionNumber: persistedLesion.lesionNumber,
            status: persistedLesion.status,
            createdBy: persistedLesion.createdBy,
            modified: persistedLesion.modified,
            mergedLesionIdentityKeys: persistedLesion.mergedLesionIdentityKeys,
          };
        }

        const hasPreviousLesions = previousLesions.length > 0;
        const displayIndex = hasPreviousLesions ? nextDisplayIndex++ : index + 1;
        const wasSplitOrEditedFromPreviousLesion = hasVoxelOverlapWithAnyPreviousLesion(
          lesion,
          previousLesions
        );
        const createdBy = wasSplitOrEditedFromPreviousLesion ? 'brush' : 'manual';

        return {
          ...lesion,
          id: createStableLesionId(),
          displayIndex,
          lesionNumber: displayIndex,
          // [2026-08-26 功能] Manual Add Lesion：Brush 新增的非重叠连通域标记为 manual，不创建新的 Segment
          createdBy: hasPreviousLesions ? createdBy : 'threshold',
          modified: hasPreviousLesions,
        };
      }

      if (usedPreviousLesionIds.has(matchedLesion.id)) {
        const mergedComponentId = createStableLesionId();
        const mergeGroup = this.mergeGroupByGroupId.get(groupId) ?? new Map<string, string>();
        mergeGroup.set(mergedComponentId, matchedLesion.id);
        this.mergeGroupByGroupId.set(groupId, mergeGroup);

        return {
          ...lesion,
          id: mergedComponentId,
          displayIndex: matchedLesion.displayIndex,
          lesionNumber: matchedLesion.displayIndex,
          status: 'candidate',
          createdBy: 'brush',
          modified: true,
        };
      }

      usedPreviousLesionIds.add(matchedLesion.id);

      if (getLesionIdentityKey(lesion) === getLesionIdentityKey(matchedLesion)) {
        return {
          ...lesion,
          id: matchedLesion.id,
          displayIndex: matchedLesion.displayIndex,
          lesionNumber: matchedLesion.displayIndex,
          status: matchedLesion.status,
          createdBy: matchedLesion.createdBy,
          modified: matchedLesion.modified,
        };
      }

      return {
        ...lesion,
        id: matchedLesion.id,
        displayIndex: matchedLesion.displayIndex,
        lesionNumber: matchedLesion.displayIndex,
        // [2026-08-25 功能] Stable ID 匹配到旧病灶但 voxel 形状变化时保留 UUID，状态回到候选等待医生重新确认
        status: 'candidate',
        createdBy: 'brush',
        modified: true,
      };
    });
  }

  private applyMergeGroups(groupId: string, lesions: TMTVLesion[]): TMTVLesion[] {
    const mergeGroup = this.mergeGroupByGroupId.get(groupId);

    if (!mergeGroup?.size) {
      return lesions;
    }

    const lesionById = new Map(lesions.map(lesion => [lesion.id, lesion]));
    const groupedLesions = new Map<string, TMTVLesion[]>();
    const ungroupedLesions: TMTVLesion[] = [];

    lesions.forEach(lesion => {
      const primaryId = mergeGroup.get(lesion.id);

      if (!primaryId || !lesionById.has(primaryId)) {
        ungroupedLesions.push(lesion);
        return;
      }

      const group = groupedLesions.get(primaryId) ?? [];
      group.push(lesion);
      groupedLesions.set(primaryId, group);
    });

    const mergedLesions = Array.from(groupedLesions.values()).map(group => mergeLesionGroup(group));

    return [...ungroupedLesions, ...mergedLesions].sort((a, b) => a.displayIndex - b.displayIndex);
  }

  private restorePersistedMergeGroups(groupId: string, lesions: TMTVLesion[]): void {
    // [2026-08-26 功能] Lesion 状态持久化：刷新后根据几何身份恢复业务合并关系，不保存大体积 labelmap
    if (this.mergeGroupByGroupId.get(groupId)?.size) {
      return;
    }

    const persistedState = this.loadPersistedState(groupId);
    const mergedPersistedLesions =
      persistedState?.lesions.filter(
        lesion => (lesion.mergedLesionIdentityKeys?.length ?? 0) > 1
      ) ?? [];

    if (!mergedPersistedLesions.length) {
      return;
    }

    const lesionByIdentityKey = new Map(
      lesions.map(lesion => [getLesionIdentityKey(lesion), lesion])
    );
    const mergeGroup = new Map<string, string>();

    mergedPersistedLesions.forEach(persistedLesion => {
      const currentLesions = (persistedLesion.mergedLesionIdentityKeys ?? [])
        .map(identityKey => lesionByIdentityKey.get(identityKey))
        .filter(Boolean) as TMTVLesion[];

      if (currentLesions.length < 2) {
        return;
      }

      const primaryLesion =
        currentLesions.find(lesion => lesion.id === persistedLesion.id) ??
        currentLesions.reduce((primary, lesion) =>
          lesion.displayIndex < primary.displayIndex ? lesion : primary
        );

      // [2026-08-26 功能] Lesion 状态持久化：恢复合并病灶的主 UUID，保证刷新后报告/选择身份稳定
      primaryLesion.id = persistedLesion.id;

      currentLesions.forEach(lesion => {
        lesion.displayIndex = persistedLesion.displayIndex;
        lesion.lesionNumber = persistedLesion.displayIndex;
        lesion.status = persistedLesion.status;
        lesion.createdBy = persistedLesion.createdBy;
        lesion.modified = persistedLesion.modified;
        lesion.mergedLesionIdentityKeys = persistedLesion.mergedLesionIdentityKeys;
        mergeGroup.set(lesion.id, primaryLesion.id);
      });
    });

    if (mergeGroup.size) {
      this.mergeGroupByGroupId.set(groupId, mergeGroup);
    }
  }

  private persistState(groupId: string, state: TMTVLesionState): void {
    // [2026-08-26 功能] Lesion 状态持久化：仅保存业务状态和几何身份，避免 localStorage 写入 voxelIndices 导致内存/体积膨胀
    const storage = getTMTVLesionStorage();

    if (!storage || !groupId || !state.segmentationIds.length) {
      return;
    }

    const persistedState: PersistedTMTVLesionState = {
      version: 1,
      updatedAt: Date.now(),
      lesions: state.lesions.map(lesion => ({
        id: lesion.id,
        identityKey: getLesionIdentityKey(lesion),
        displayIndex: lesion.displayIndex,
        lesionNumber: lesion.lesionNumber,
        status: lesion.status,
        createdBy: lesion.createdBy,
        modified: lesion.modified,
        mergedLesionIdentityKeys: lesion.mergedLesionIdentityKeys,
      })),
    };

    try {
      storage.setItem(`${PERSISTENCE_KEY_PREFIX}${groupId}`, JSON.stringify(persistedState));
    } catch {
      // localStorage 可能被浏览器禁用或容量不足；持久化失败不应影响分割主流程。
    }
  }

  private loadPersistedState(groupId: string): PersistedTMTVLesionState | null {
    const storage = getTMTVLesionStorage();

    if (!storage || !groupId) {
      return null;
    }

    try {
      const rawState = storage.getItem(`${PERSISTENCE_KEY_PREFIX}${groupId}`);
      const parsedState = rawState ? JSON.parse(rawState) : null;

      if (parsedState?.version !== 1 || !Array.isArray(parsedState.lesions)) {
        return null;
      }

      return parsedState;
    } catch {
      return null;
    }
  }
}

function computeConfirmedTotals(lesions: TMTVLesion[]): TMTVLesionState['totals'] {
  // [2026-08-25 功能] 第三阶段患者级 TMTV/TLG 由统计服务统一计算，只纳入 confirmed lesions
  return computePatientTotals(lesions);
}

function doesHistoryEntryTouchSegmentations(
  entry: TMTVLesionHistoryEntry,
  segmentationIds: Set<string>
): boolean {
  if (entry.type === 'LABELMAP') {
    return segmentationIds.has(entry.segmentationId);
  }

  return entry.segmentationIds.some(segmentationId => segmentationIds.has(segmentationId));
}

function mergeLesionGroup(lesions: TMTVLesion[]): TMTVLesion {
  // [2026-08-26 功能] Merge Lesions：合并多个 connected components 的业务统计，底层 Segment 1 voxel 保持原状
  const primaryLesion = lesions.reduce((primary, lesion) =>
    lesion.displayIndex < primary.displayIndex ? lesion : primary
  );
  const voxelIndices = lesions.flatMap(lesion => lesion.voxelIndices);
  const volume = lesions.reduce((sum, lesion) => sum + lesion.volume, 0);
  const tlgValues = lesions.map(lesion => lesion.tlg).filter(value => value !== null) as number[];
  const tlg = tlgValues.length ? tlgValues.reduce((sum, value) => sum + value, 0) : null;
  const suvMinValues = lesions
    .map(lesion => lesion.suvMin)
    .filter(value => value !== null) as number[];
  const suvMaxValues = lesions
    .map(lesion => lesion.suvMax)
    .filter(value => value !== null) as number[];
  const weightedSUVSum = lesions.reduce(
    (sum, lesion) => sum + (lesion.suvMean === null ? 0 : lesion.suvMean * lesion.volume),
    0
  );
  const hasSUVMean = lesions.some(lesion => lesion.suvMean !== null);
  const voxelCount = lesions.reduce((sum, lesion) => sum + lesion.voxelCount, 0);
  const centroid = getWeightedPoint(lesions, 'centroid', voxelCount);
  const centroidIJK = getWeightedPoint(lesions, 'centroidIJK', voxelCount);
  const boundsIJK = mergeBoundsIJK(lesions);
  const mergedLesionIds = Array.from(
    new Set(lesions.flatMap(lesion => lesion.mergedLesionIds ?? [lesion.id]))
  );
  const mergedLesionIdentityKeys = Array.from(
    new Set(
      lesions.flatMap(lesion => lesion.mergedLesionIdentityKeys ?? [getLesionIdentityKey(lesion)])
    )
  );

  return {
    ...primaryLesion,
    voxelIndices,
    voxelCount,
    boundsIJK,
    volume,
    suvMin: suvMinValues.length ? Math.min(...suvMinValues) : null,
    suvMax: suvMaxValues.length ? Math.max(...suvMaxValues) : null,
    suvMean: hasSUVMean && volume ? weightedSUVSum / volume : null,
    tlg,
    centroid,
    centroidIJK,
    status: 'candidate',
    createdBy: 'brush',
    modified: true,
    mergedLesionIds,
    mergedLesionIdentityKeys,
  };
}

function getWeightedPoint(
  lesions: TMTVLesion[],
  key: 'centroid' | 'centroidIJK',
  voxelCount: number
): [number, number, number] {
  if (!voxelCount) {
    return [0, 0, 0];
  }

  return [0, 1, 2].map(
    axis =>
      lesions.reduce((sum, lesion) => sum + lesion[key][axis] * lesion.voxelCount, 0) / voxelCount
  ) as [number, number, number];
}

function mergeBoundsIJK(lesions: TMTVLesion[]): TMTVLesion['boundsIJK'] {
  return lesions.reduce(
    (bounds, lesion) => ({
      min: [
        Math.min(bounds.min[0], lesion.boundsIJK.min[0]),
        Math.min(bounds.min[1], lesion.boundsIJK.min[1]),
        Math.min(bounds.min[2], lesion.boundsIJK.min[2]),
      ],
      max: [
        Math.max(bounds.max[0], lesion.boundsIJK.max[0]),
        Math.max(bounds.max[1], lesion.boundsIJK.max[1]),
        Math.max(bounds.max[2], lesion.boundsIJK.max[2]),
      ],
    }),
    {
      min: [Infinity, Infinity, Infinity] as [number, number, number],
      max: [-Infinity, -Infinity, -Infinity] as [number, number, number],
    }
  );
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

function createSegmentMaskSnapshot(
  scalarData: ArrayLike<number>,
  segmentIndex: number
): Uint8Array {
  // [2026-08-26 功能] Undo/Redo 使用二值 mask 快照记录 Segment 1 是否存在，降低 Brush/Eraser 历史内存占用
  const snapshot = new Uint8Array(scalarData.length);

  for (let voxelIndex = 0; voxelIndex < scalarData.length; voxelIndex++) {
    snapshot[voxelIndex] = scalarData[voxelIndex] === segmentIndex ? 1 : 0;
  }

  return snapshot;
}

function getSnapshotVoxelChanges(
  previousSnapshot: Uint8Array,
  nextSnapshot: Uint8Array,
  segmentIndex: number
): VoxelChange[] {
  const length = Math.min(previousSnapshot.length, nextSnapshot.length);
  const changes: VoxelChange[] = [];

  for (let voxelIndex = 0; voxelIndex < length; voxelIndex++) {
    if (previousSnapshot[voxelIndex] === nextSnapshot[voxelIndex]) {
      continue;
    }

    changes.push({
      voxelIndex,
      before: previousSnapshot[voxelIndex] ? segmentIndex : 0,
      after: nextSnapshot[voxelIndex] ? segmentIndex : 0,
    });
  }

  return changes;
}

function findBestMatchingPreviousLesion(
  lesion: TMTVLesion,
  previousLesions: TMTVLesion[],
  usedPreviousLesionIds: Set<string>
): TMTVLesion | null {
  // [2026-08-25 功能] Stable Lesion ID：优先用 voxel overlap 识别同一病灶，避免删除/编辑后 UUID 跟着显示编号漂移
  let bestMatch: TMTVLesion | null = null;
  let bestScore = 0;

  previousLesions.forEach(previousLesion => {
    if (
      (usedPreviousLesionIds.has(previousLesion.id) &&
        (previousLesion.mergedLesionIds?.length ?? 0) < 2) ||
      previousLesion.segmentationId !== lesion.segmentationId ||
      previousLesion.segmentIndex !== lesion.segmentIndex
    ) {
      return;
    }

    const overlapCount = countVoxelOverlap(lesion.voxelIndices, previousLesion.voxelIndices);
    const overlapScore =
      overlapCount / Math.max(1, Math.min(lesion.voxelCount, previousLesion.voxelCount));

    if (overlapScore > bestScore) {
      bestScore = overlapScore;
      bestMatch = previousLesion;
    }
  });

  return bestScore >= 0.2 ? bestMatch : null;
}

function hasVoxelOverlapWithAnyPreviousLesion(
  lesion: TMTVLesion,
  previousLesions: TMTVLesion[]
): boolean {
  // [2026-08-26 功能] 区分 Manual Add 与 Split：全新 Brush 区域无 overlap，擦断旧病灶产生的新分支仍和旧病灶有 overlap
  return previousLesions.some(previousLesion => {
    if (
      previousLesion.segmentationId !== lesion.segmentationId ||
      previousLesion.segmentIndex !== lesion.segmentIndex
    ) {
      return false;
    }

    return countVoxelOverlap(lesion.voxelIndices, previousLesion.voxelIndices) > 0;
  });
}

function countVoxelOverlap(voxelIndices: number[], previousVoxelIndices: number[]): number {
  const smaller =
    voxelIndices.length <= previousVoxelIndices.length ? voxelIndices : previousVoxelIndices;
  const larger =
    voxelIndices.length <= previousVoxelIndices.length ? previousVoxelIndices : voxelIndices;
  const largerVoxelSet = new Set(larger);
  let overlapCount = 0;

  smaller.forEach(voxelIndex => {
    if (largerVoxelSet.has(voxelIndex)) {
      overlapCount++;
    }
  });

  return overlapCount;
}

function getNextDisplayIndex(lesions: TMTVLesion[]): number {
  const maxDisplayIndex = lesions.reduce(
    (max, lesion) => Math.max(max, lesion.displayIndex ?? lesion.lesionNumber ?? 0),
    0
  );

  return maxDisplayIndex + 1;
}

function getNextPersistedDisplayIndex(lesions: PersistedTMTVLesion[]): number {
  const maxDisplayIndex = lesions.reduce(
    (max, lesion) => Math.max(max, lesion.displayIndex ?? lesion.lesionNumber ?? 0),
    0
  );

  return maxDisplayIndex + 1;
}

function createStableLesionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `lesion-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function getTMTVLesionStorage(): Storage | null {
  // [2026-08-26 功能] Lesion 状态持久化：兼容浏览器禁用 localStorage 的环境，失败时自动退回内存态
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function hasSegmentVoxels(scalarData: ArrayLike<number>, segmentIndex: number): boolean {
  // [2026-08-26 功能] IndexedDB 稀疏保存/恢复 Segment 1 mask：恢复前快速判断当前 Segment 是否为空，防止旧 mask 覆盖新编辑
  for (let voxelIndex = 0; voxelIndex < scalarData.length; voxelIndex++) {
    if (scalarData[voxelIndex] === segmentIndex) {
      return true;
    }
  }

  return false;
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
