import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useActiveViewportSegmentationRepresentations } from '@ohif/extension-cornerstone';
import { handleROIThresholding } from '../../utils/handleROIThresholding';
import { debounce } from '@ohif/core/src/utils';
import { useSystem } from '@ohif/core/src';
import { Button } from '@ohif/ui-next';
import { useTranslation } from 'react-i18next';
import tmtvLesionService from '../../services/TMTVLesionService';
import tmtvLesionHighlightService from '../../services/TMTVLesionHighlightService';

const SEGMENT_INDEX = 1;
const LESION_FILTERS = ['all', 'confirmed', 'candidate', 'rejected'];
const LESION_SORT_OPTIONS = ['volume', 'suvMax', 'tlg', 'displayIndex'];

function formatStat(value: number | null | undefined, digits = 3) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '';
}

function getFiniteInputNumber(value: string, fallback: number): number {
  const numericValue = Number(value);

  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function getSortableNumber(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : -Infinity;
}

function setPrimaryTMTVSegmentationActive({
  cornerstoneViewportService,
  segmentationIds,
  segmentationService,
  viewportGridService,
}) {
  // [2026-08-26 功能] IndexedDB mask 恢复后恢复真实 Segment 1 为 active，避免 Brush/Eraser 编辑到高亮层或错误 segmentation
  const primarySegmentationId = segmentationIds.find(
    segmentationId => !tmtvLesionHighlightService.isHighlightSegmentationId(segmentationId)
  );

  if (!primarySegmentationId) {
    return;
  }

  segmentationService.setActiveSegment?.(primarySegmentationId, SEGMENT_INDEX);

  const viewportIds =
    cornerstoneViewportService?.getViewportIds?.() ??
    viewportGridService?.getViewportIds?.() ??
    Array.from(viewportGridService?.getState?.()?.viewports?.keys?.() ?? []);

  viewportIds.forEach(viewportId => {
    const representations = segmentationService.getSegmentationRepresentations?.(viewportId, {
      segmentationId: primarySegmentationId,
    });

    if (!representations?.length) {
      return;
    }

    segmentationService.setActiveSegmentation?.(viewportId, primarySegmentationId);
  });
}

export default function PanelRoiThresholdSegmentation() {
  const { t } = useTranslation('ROIThresholdConfiguration');
  const { commandsManager, servicesManager } = useSystem();
  const { cornerstoneViewportService, segmentationService, viewportGridService } =
    servicesManager.services;
  const { segmentationsWithRepresentations: segmentationsInfo } =
    useActiveViewportSegmentationRepresentations();

  // [2026-08-25 功能] 右侧统计只处理真实 TMTV Segment 1，排除“选中 lesion 高亮层”
  const tmtvSegmentationsInfo =
    segmentationsInfo?.filter(
      info =>
        !tmtvLesionHighlightService.isHighlightSegmentationId(info.segmentation.segmentationId)
    ) || [];
  const segmentationIds = tmtvSegmentationsInfo.map(info => info.segmentation.segmentationId);
  const segmentations = tmtvSegmentationsInfo.map(info => info.segmentation);
  const segmentationGroupId = useMemo(
    () => [...segmentationIds].sort().join(','),
    [segmentationsInfo]
  );
  const [lesionState, setLesionState] = useState(() => tmtvLesionService.getState(segmentationIds));
  const [lesionFilter, setLesionFilter] = useState('all');
  const [exportConfirmedOnly, setExportConfirmedOnly] = useState(true);
  const [mergeSelectionIds, setMergeSelectionIds] = useState<string[]>([]);
  const [hasPersistedMask, setHasPersistedMask] = useState(false);
  const [isRestoringPersistedMask, setIsRestoringPersistedMask] = useState(false);
  const [autoSUVThreshold, setAutoSUVThreshold] = useState(2.5);
  const [autoMinVolumeML, setAutoMinVolumeML] = useState(0.1);
  const [autoWriteMode, setAutoWriteMode] = useState<'overwrite' | 'append'>('overwrite');
  const [isRunningAutoSegmentation, setIsRunningAutoSegmentation] = useState(false);
  const [autoSegmentationSummary, setAutoSegmentationSummary] = useState('');
  const [isAutoSegmentationExpanded, setIsAutoSegmentationExpanded] = useState(true);
  const [lesionSortKey, setLesionSortKey] = useState('volume');
  const [lesionSortDirection, setLesionSortDirection] = useState<'asc' | 'desc'>('desc');
  const hasAttemptedInitialMaskRestoreRef = useRef(false);

  const refreshTMTVAndLesions = useCallback(
    async (segmentationId?: string, options: { restorePersistedMask?: boolean } = {}) => {
      // [2026-08-24 功能] Segment 1 更新后同步刷新整体 TMTV/TLG 和 lesion 级统计
      const currentSegmentations = segmentationIds.length
        ? segmentationIds.map(id => segmentationService.getSegmentation(id)).filter(Boolean)
        : segmentationService
            .getSegmentations()
            .filter(
              segmentation =>
                !tmtvLesionHighlightService.isHighlightSegmentationId(segmentation.segmentationId)
            );

      await handleROIThresholding({
        segmentationId,
        commandsManager,
        segmentationService,
        segmentations: currentSegmentations,
      });

      const nextLesionState = await tmtvLesionService.extractLesionsForSegmentationsAsync(
        currentSegmentations,
        SEGMENT_INDEX,
        {
          restorePersistedMask: options.restorePersistedMask,
        }
      );

      setLesionState(nextLesionState);

      // [2026-08-25 功能] Brush/Eraser 修改 Segment 1 后同步刷新 confirmed totals，避免分割已清空但 TMTV/TLG 仍显示旧值
      segmentationService.setSegmentationGroupStats(nextLesionState.segmentationIds, {
        tmtv: nextLesionState.totals.tmtv,
        tlg: nextLesionState.totals.tlg,
      });

      setPrimaryTMTVSegmentationActive({
        cornerstoneViewportService,
        segmentationIds: nextLesionState.segmentationIds,
        segmentationService,
        viewportGridService,
      });

      // [2026-08-25 功能] 第二阶段编辑后重建 lesion 时同步更新选中高亮层，避免橡皮擦后仍显示旧 mask
      const selectedLesion =
        nextLesionState.lesions.find(lesion => lesion.id === nextLesionState.selectedLesionId) ??
        null;
      await tmtvLesionHighlightService.highlightLesion(
        nextLesionState.segmentationIds,
        selectedLesion
      );
    },
    [
      commandsManager,
      cornerstoneViewportService,
      segmentationGroupId,
      segmentationService,
      viewportGridService,
    ]
  );

  useEffect(() => {
    // [2026-08-24 功能] 订阅 TMTVLesionService 状态，让右侧 lesion 面板响应选中/删除/重算
    const subscription = tmtvLesionService.subscribe(() => {
      const nextLesionState = tmtvLesionService.getState(segmentationIds);
      setLesionState(nextLesionState);
      setMergeSelectionIds(previousSelectionIds =>
        previousSelectionIds.filter(lesionId =>
          nextLesionState.lesions.some(lesion => lesion.id === lesionId)
        )
      );
    });

    setLesionState(tmtvLesionService.getState(segmentationIds));

    return () => {
      subscription.unsubscribe();
      tmtvLesionHighlightService.removeHighlight(segmentationIds);
    };
  }, [segmentationGroupId]);

  useEffect(() => {
    const initialRun = async () => {
      if (!segmentationIds.length) {
        // [2026-08-26 功能] IndexedDB 稀疏保存/恢复 Segment 1 mask：没有现成 segmentation 时不自动创建，避免刷新后改变 viewport 几何或工具编辑目标
        hasAttemptedInitialMaskRestoreRef.current = true;
        const hasMask = await commandsManager.runCommand('hasPersistedTMTVSegmentMask');
        setHasPersistedMask(!!hasMask);
        return;
      }

      setHasPersistedMask(false);

      for (const segmentationId of segmentationIds) {
        await refreshTMTVAndLesions(segmentationId, {
          restorePersistedMask: !hasAttemptedInitialMaskRestoreRef.current,
        });
      }

      hasAttemptedInitialMaskRestoreRef.current = true;
    };

    initialRun();
  }, [commandsManager, refreshTMTVAndLesions, segmentationGroupId]);

  const handleRestorePersistedMask = async () => {
    // [2026-08-26 功能] 本地分割恢复：由医生显式点击后才创建 Segment 1 并恢复 IndexedDB mask，避免打开面板即改变图像状态
    if (isRestoringPersistedMask) {
      return;
    }

    setIsRestoringPersistedMask(true);

    try {
      const restoredSegmentationId = await commandsManager.runCommand('createNewLabelmapFromPT', {
        label: 'TMTV Segmentation',
        restoreOnlyIfPersistedMask: true,
      });

      if (restoredSegmentationId) {
        await refreshTMTVAndLesions(restoredSegmentationId, {
          restorePersistedMask: true,
        });
        setHasPersistedMask(false);
      }
    } finally {
      setIsRestoringPersistedMask(false);
    }
  };

  useEffect(() => {
    const debouncedHandleROIThresholding = debounce(async eventDetail => {
      const { segmentationId } = eventDetail;
      await refreshTMTVAndLesions(segmentationId);
    }, 100);

    const dataModifiedCallback = eventDetail => {
      // [2026-08-26 功能] Brush/Eraser 事件容错：部分底层工具可能不带 segmentationId，仍需刷新真实 Segment 1 的 lesion 列表
      const modifiedSegmentationId = eventDetail?.segmentationId;

      if (tmtvLesionHighlightService.isHighlightSegmentationId(modifiedSegmentationId)) {
        return;
      }

      if (
        modifiedSegmentationId &&
        segmentationIds.length &&
        !segmentationIds.includes(modifiedSegmentationId)
      ) {
        return;
      }

      if (
        modifiedSegmentationId &&
        tmtvLesionService.consumeSkipNextFullRefresh(modifiedSegmentationId)
      ) {
        return;
      }

      debouncedHandleROIThresholding({
        ...eventDetail,
        segmentationId: modifiedSegmentationId ?? segmentationIds[0],
      });
    };

    const dataModifiedSubscription = segmentationService.subscribe(
      segmentationService.EVENTS.SEGMENTATION_DATA_MODIFIED,
      dataModifiedCallback
    );

    return () => {
      // [2026-08-25 功能] 面板卸载时清理 debounce timeout，避免切换面板后延迟刷新造成额外计算/潜在泄漏
      debouncedHandleROIThresholding.clearDebounceTimeout?.();
      dataModifiedSubscription.unsubscribe();
    };
  }, [refreshTMTVAndLesions, segmentationService]);

  // [2026-08-25 功能] 第一阶段 Header TMTV/TLG 只统计 confirmed lesions，candidate/rejected 不进入总量
  const tmtvValue = lesionState.totals.tmtv;
  const tlgValue = lesionState.totals.tlg;
  const lesionCount = lesionState.lesions.length;
  const selectedLesionId = lesionState.selectedLesionId;
  const confirmedCount = lesionState.lesions.filter(lesion => lesion.status === 'confirmed').length;
  const candidateCount = lesionState.lesions.filter(lesion => lesion.status === 'candidate').length;
  const rejectedCount = lesionState.lesions.filter(lesion => lesion.status === 'rejected').length;
  const filteredLesions = useMemo(
    () =>
      lesionFilter === 'all'
        ? lesionState.lesions
        : lesionState.lesions.filter(lesion => lesion.status === lesionFilter),
    [lesionFilter, lesionState.lesions]
  );
  const visibleLesions = useMemo(() => {
    // [2026-08-26 功能] 自动分割审核排序：默认大体积优先，减少医生在几十个候选中查找重点病灶的成本
    const sortDirectionMultiplier = lesionSortDirection === 'asc' ? 1 : -1;

    return [...filteredLesions].sort((firstLesion, secondLesion) => {
      const firstValue = getLesionSortValue(firstLesion, lesionSortKey);
      const secondValue = getLesionSortValue(secondLesion, lesionSortKey);
      const valueDiff = (firstValue - secondValue) * sortDirectionMultiplier;

      if (valueDiff !== 0) {
        return valueDiff;
      }

      return (firstLesion.displayIndex ?? 0) - (secondLesion.displayIndex ?? 0);
    });
  }, [filteredLesions, lesionSortDirection, lesionSortKey]);
  const currentBatchLesions = useMemo(
    () =>
      lesionFilter === 'all'
        ? filteredLesions.filter(lesion => lesion.status === 'candidate')
        : filteredLesions,
    [filteredLesions, lesionFilter]
  );

  const handleSelectLesion = lesionId => {
    // [2026-08-25 功能] 点击 lesion 后只触发右侧选中和图像高亮，不执行视图定位
    const nextLesionId = selectedLesionId === lesionId ? null : lesionId;

    commandsManager.runCommand('selectTMTVLesion', {
      segmentationIds,
      lesionId: nextLesionId,
    });
  };

  const handleSetLesionStatus = (event, lesionId, status) => {
    // [2026-08-25 功能] 第一阶段 Confirm/Reject/Restore 只改变 lesion 业务状态，不物理删除 voxel
    event.stopPropagation();
    commandsManager.runCommand('setTMTVLesionStatus', {
      segmentationIds,
      lesionId,
      status,
    });
  };

  const handleSetLesionStatuses = (lesionIds: string[], status) => {
    // [2026-08-26 功能] 批量 Confirm/Reject：复用当前筛选和勾选状态，减少自动分割后逐个审核成本
    const targetLesionIds = Array.from(new Set((lesionIds ?? []).filter(Boolean)));

    if (!targetLesionIds.length) {
      return;
    }

    commandsManager.runCommand('setTMTVLesionStatuses', {
      segmentationIds,
      lesionIds: targetLesionIds,
      status,
    });
    setMergeSelectionIds(previousSelectionIds =>
      previousSelectionIds.filter(lesionId => !targetLesionIds.includes(lesionId))
    );
  };

  const shouldBatchSetLesionStatus = (lesion, status) => {
    // [2026-08-27 功能] 批量确认只处理 candidate；rejected 需要先恢复，减少误确认
    if (status === 'confirmed') {
      return lesion.status === 'candidate';
    }

    return lesion.status !== status;
  };

  const handleSetFilteredLesionsStatus = status => {
    const targetLesionIds = currentBatchLesions
      .filter(lesion => shouldBatchSetLesionStatus(lesion, status))
      .map(lesion => lesion.id);

    handleSetLesionStatuses(targetLesionIds, status);
  };

  const handleSetSelectedLesionsStatus = status => {
    const selectedLesionIds = lesionState.lesions
      .filter(
        lesion =>
          mergeSelectionIds.includes(lesion.id) && shouldBatchSetLesionStatus(lesion, status)
      )
      .map(lesion => lesion.id);

    handleSetLesionStatuses(selectedLesionIds, status);
  };

  const handleToggleMergeSelection = (event, lesionId) => {
    // [2026-08-26 功能] Merge Lesions：复选框只控制业务合并选择，不触发 lesion 高亮/定位
    event.stopPropagation();
    setMergeSelectionIds(previousSelectionIds =>
      previousSelectionIds.includes(lesionId)
        ? previousSelectionIds.filter(selectedLesionId => selectedLesionId !== lesionId)
        : [...previousSelectionIds, lesionId]
    );
  };

  const handleMergeSelectedLesions = () => {
    if (mergeSelectionIds.length < 2) {
      return;
    }

    commandsManager.runCommand('mergeTMTVLesions', {
      segmentationIds,
      lesionIds: mergeSelectionIds,
    });
    setMergeSelectionIds([]);
  };

  const filteredConfirmCount = currentBatchLesions.filter(
    lesion => lesion.status === 'candidate'
  ).length;
  const filteredRejectCount = currentBatchLesions.filter(
    lesion => lesion.status !== 'rejected'
  ).length;
  const selectedConfirmCount = lesionState.lesions.filter(
    lesion => mergeSelectionIds.includes(lesion.id) && lesion.status === 'candidate'
  ).length;
  const selectedRejectCount = lesionState.lesions.filter(
    lesion => mergeSelectionIds.includes(lesion.id) && lesion.status !== 'rejected'
  ).length;
  const filteredRestoreCount = currentBatchLesions.filter(
    lesion => lesion.status === 'rejected'
  ).length;
  const selectedRestoreCount = lesionState.lesions.filter(
    lesion => mergeSelectionIds.includes(lesion.id) && lesion.status === 'rejected'
  ).length;
  const filteredDeleteCount = filteredRestoreCount;
  const selectedDeleteCount = selectedRestoreCount;

  const handleDeleteLesion = (event, lesionId) => {
    // [2026-08-25 功能] 第二阶段 Delete 才真实修改 Segment 1 voxel；仅从 rejected lesion 暴露，避免误删
    event.stopPropagation();

    const shouldDelete =
      typeof window === 'undefined' ||
      window.confirm?.(
        t('Delete rejected lesion confirmation', {
          defaultValue: 'Delete this rejected lesion from Segment 1? This cannot be restored.',
        })
      );

    if (!shouldDelete) {
      return;
    }

    commandsManager.runCommand('deleteTMTVLesion', {
      segmentationIds,
      lesionId,
    });
  };

  const handleRestoreFilteredRejectedLesions = () => {
    // [2026-08-27 功能] 批量恢复 rejected：只把拒绝态拉回候选，confirmed 不被误改
    handleSetLesionStatuses(
      currentBatchLesions.filter(lesion => lesion.status === 'rejected').map(lesion => lesion.id),
      'candidate'
    );
  };

  const handleRestoreSelectedRejectedLesions = () => {
    // [2026-08-27 功能] 批量恢复勾选 rejected：复用勾选区，减少几十个小病灶逐个恢复成本
    handleSetLesionStatuses(
      lesionState.lesions
        .filter(lesion => mergeSelectionIds.includes(lesion.id) && lesion.status === 'rejected')
        .map(lesion => lesion.id),
      'candidate'
    );
  };

  const handleDeleteLesions = (lesionIds: string[]) => {
    // [2026-08-27 功能] 批量删除 rejected：真实清除 Segment 1 voxel，适合替代大范围逐层橡皮擦
    const targetLesionIds = Array.from(new Set((lesionIds ?? []).filter(Boolean)));

    if (!targetLesionIds.length) {
      return;
    }

    const shouldDelete =
      typeof window === 'undefined' ||
      window.confirm?.(
        t('Delete rejected lesions confirmation', {
          defaultValue: 'Delete selected rejected lesions from Segment 1? This cannot be restored.',
        })
      );

    if (!shouldDelete) {
      return;
    }

    commandsManager.runCommand('deleteTMTVLesions', {
      segmentationIds,
      lesionIds: targetLesionIds,
    });
    setMergeSelectionIds(previousSelectionIds =>
      previousSelectionIds.filter(lesionId => !targetLesionIds.includes(lesionId))
    );
  };

  const handleDeleteFilteredRejectedLesions = () => {
    handleDeleteLesions(
      currentBatchLesions.filter(lesion => lesion.status === 'rejected').map(lesion => lesion.id)
    );
  };

  const handleDeleteSelectedRejectedLesions = () => {
    handleDeleteLesions(
      lesionState.lesions
        .filter(lesion => mergeSelectionIds.includes(lesion.id) && lesion.status === 'rejected')
        .map(lesion => lesion.id)
    );
  };

  const handleRunAutoSegmentation = async () => {
    // [2026-08-26 功能] 全身 SUV 阈值自动分割入口：写入 Segment 1 后立即复用现有 lesion candidate 刷新链路
    if (isRunningAutoSegmentation) {
      return;
    }

    const shouldOverwrite =
      autoWriteMode === 'overwrite' &&
      segmentationIds.length > 0 &&
      lesionState.lesions.length > 0 &&
      (typeof window === 'undefined' ||
        window.confirm?.(
          t('Overwrite Segment 1 confirmation', {
            defaultValue:
              'Overwrite current Segment 1 auto/manual mask? Existing Segment 1 voxels will be cleared.',
          })
        ));

    if (
      autoWriteMode === 'overwrite' &&
      segmentationIds.length > 0 &&
      lesionState.lesions.length > 0 &&
      !shouldOverwrite
    ) {
      return;
    }

    setIsRunningAutoSegmentation(true);

    try {
      const result = await commandsManager.runCommand('autoSegmentTMTVBySUVThreshold', {
        segmentationId: segmentationIds[0],
        threshold: autoSUVThreshold,
        minVolumeML: autoMinVolumeML,
        writeMode: autoWriteMode,
        segmentIndex: SEGMENT_INDEX,
      });

      if (!result) {
        setAutoSegmentationSummary('');
        return;
      }

      setHasPersistedMask(false);
      setAutoSegmentationSummary(
        t('Auto segmentation summary', {
          defaultValue: 'Kept {{kept}} candidates, filtered {{filtered}}, wrote {{voxels}} voxels.',
          kept: result.keptComponentCount,
          filtered: result.filteredComponentCount,
          voxels: result.voxelCount,
        })
      );
      setIsAutoSegmentationExpanded(false);
      await refreshTMTVAndLesions(result.segmentationId);
    } finally {
      setIsRunningAutoSegmentation(false);
    }
  };

  const getReportLesions = () =>
    exportConfirmedOnly
      ? lesionState.lesions.filter(lesion => lesion.status === 'confirmed')
      : lesionState.lesions;

  const handleExportCSV = () => {
    if (!segmentations.length) {
      return;
    }

    commandsManager.runCommand('exportTMTVReportCSV', {
      segmentations,
      tmtv: tmtvValue,
      lesions: getReportLesions(),
      lesionTotals: lesionState.totals,
      config: {},
    });
  };

  const handleExportExcel = () => {
    // [2026-08-26 功能] 本地 Excel 报告：右侧面板直接下载 .xls，沿用“仅导出已确认病灶”选项
    if (!segmentations.length) {
      return;
    }

    commandsManager.runCommand('exportTMTVReportExcel', {
      segmentations,
      tmtv: tmtvValue,
      lesions: getReportLesions(),
      lesionTotals: lesionState.totals,
      config: {},
    });
  };

  const handleExportPDF = () => {
    // [2026-08-26 功能] 本地 PDF 报告：打开打印窗口，医生可选择保存为 PDF，不依赖服务端
    if (!segmentations.length) {
      return;
    }

    commandsManager.runCommand('exportTMTVReportPDF', {
      segmentations,
      tmtv: tmtvValue,
      lesions: getReportLesions(),
      lesionTotals: lesionState.totals,
      config: {},
    });
  };

  const getStatusLabel = status => {
    if (status === 'confirmed') {
      return `✓ ${t('Confirmed', { defaultValue: 'Confirmed' })}`;
    }

    if (status === 'rejected') {
      return `× ${t('Rejected', { defaultValue: 'Rejected' })}`;
    }

    return t('Candidate', { defaultValue: 'Candidate' });
  };

  const getFilterLabel = filter => {
    if (filter === 'all') {
      return t('All', { defaultValue: 'All' });
    }

    if (filter === 'confirmed') {
      return t('Confirmed', { defaultValue: 'Confirmed' });
    }

    if (filter === 'rejected') {
      return t('Rejected', { defaultValue: 'Rejected' });
    }

    return t('Candidate', { defaultValue: 'Candidate' });
  };

  const getFilterCount = filter => {
    if (filter === 'confirmed') {
      return confirmedCount;
    }

    if (filter === 'candidate') {
      return candidateCount;
    }

    if (filter === 'rejected') {
      return rejectedCount;
    }

    return lesionCount;
  };

  function getSortLabel(sortKey) {
    if (sortKey === 'suvMax') {
      return t('SUVmax', { defaultValue: 'SUVmax' });
    }

    if (sortKey === 'tlg') {
      return t('TLG', { defaultValue: 'TLG' });
    }

    if (sortKey === 'displayIndex') {
      return t('Lesion number', { defaultValue: 'Lesion number' });
    }

    return t('Volume', { defaultValue: 'Volume' });
  }

  function getLesionSortValue(lesion, sortKey) {
    if (sortKey === 'suvMax') {
      return getSortableNumber(lesion.suvMax);
    }

    if (sortKey === 'tlg') {
      return getSortableNumber(lesion.tlg);
    }

    if (sortKey === 'displayIndex') {
      return getSortableNumber(lesion.displayIndex);
    }

    return getSortableNumber(lesion.volume);
  }

  const getStatusAccentClass = lesion => {
    // [2026-08-26 功能] Lesion 视觉层级：用边框和底色表达状态，减少医生阅读负担
    if (lesion.status === 'confirmed') {
      return 'border-l-green-500 bg-green-500/5';
    }

    if (lesion.status === 'rejected') {
      return 'border-l-red-500 bg-red-500/5 opacity-45';
    }

    return 'border-l-primary/80 bg-popover/70';
  };

  const getStatusDotClass = status => {
    if (status === 'confirmed') {
      return 'bg-green-400';
    }

    if (status === 'rejected') {
      return 'bg-red-400';
    }

    return 'bg-primary';
  };

  return (
    <div className="mb-2 flex min-h-0 flex-1 flex-col">
      {/* [2026-08-26 功能] Lesion 管理区使用 flex 剩余高度，避免阈值工具展开后高级分割数据栏悬浮/重叠 */}
      <div className="bg-background flex min-h-[180px] flex-1 flex-col overflow-hidden">
        {/* [2026-08-26 功能] 压缩 TMTV 顶部统计区：统计一行、导出一行，给 Lesion 列表释放更多可视高度 */}
        <div className="bg-popover flex flex-shrink-0 flex-col gap-1 px-2 py-1">
          <div className="grid grid-cols-2 gap-2 text-sm leading-5">
            <div className="min-w-0 whitespace-nowrap">
              <span className="text-muted-foreground font-bold uppercase">{'TMTV：'}</span>
              <span className="text-foreground">{`${formatStat(tmtvValue)} mL`}</span>
            </div>
            <div className="min-w-0 whitespace-nowrap">
              <span className="text-muted-foreground font-bold uppercase">{'TLG：'}</span>
              <span className="text-foreground">{formatStat(tlgValue)}</span>
            </div>
          </div>
          <div className="flex items-center justify-between gap-2">
            <label className="text-muted-foreground flex min-w-0 cursor-pointer items-center gap-1 whitespace-nowrap text-[11px]">
              <input
                type="checkbox"
                className="accent-primary h-3 w-3 flex-shrink-0"
                checked={exportConfirmedOnly}
                onChange={event => setExportConfirmedOnly(event.target.checked)}
              />
              <span>{t('Export confirmed only', { defaultValue: 'Export confirmed only' })}</span>
            </label>
            <div className="flex flex-shrink-0 items-center gap-1">
              {/* [2026-08-26 功能] 本地报告导出：CSV/XLS/PDF 使用紧凑按钮，避免压缩 Lesion 列表高度 */}
              <Button
                dataCY="exportTmtvCsvReport"
                size="sm"
                variant="ghost"
                className="h-6 px-1.5 text-xs"
                onClick={handleExportCSV}
              >
                <span>CSV</span>
              </Button>
              <Button
                dataCY="exportTmtvExcelReport"
                size="sm"
                variant="ghost"
                className="h-6 px-1.5 text-xs"
                onClick={handleExportExcel}
              >
                <span>XLS</span>
              </Button>
              <Button
                dataCY="exportTmtvPdfReport"
                size="sm"
                variant="ghost"
                className="h-6 px-1.5 text-xs"
                onClick={handleExportPDF}
              >
                <span>PDF</span>
              </Button>
            </div>
          </div>
        </div>
        <div className="border-border bg-background flex flex-shrink-0 flex-col border-t px-2 py-1">
          {/* [2026-08-26 功能] 自动分割区折叠展示：运行后收起参数，给病灶审核列表让出高度 */}
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="text-muted-foreground flex min-w-0 flex-1 items-center gap-1 text-left text-xs font-semibold uppercase"
              onClick={() => setIsAutoSegmentationExpanded(isExpanded => !isExpanded)}
            >
              <span>{isAutoSegmentationExpanded ? '▾' : '▸'}</span>
              <span>{t('Auto segmentation', { defaultValue: 'Auto segmentation' })}</span>
              {!isAutoSegmentationExpanded && (
                <span className="truncate text-[11px] font-normal normal-case">
                  {`${autoSUVThreshold} / ${autoMinVolumeML} mL / ${t(
                    autoWriteMode === 'append' ? 'Append' : 'Overwrite',
                    {
                      defaultValue: autoWriteMode === 'append' ? 'Append' : 'Overwrite',
                    }
                  )}`}
                </span>
              )}
            </button>
            <Button
              dataCY="runTmtvAutoSegmentation"
              size="sm"
              variant="default"
              className="h-7 flex-shrink-0 px-2 text-xs"
              disabled={isRunningAutoSegmentation}
              onClick={handleRunAutoSegmentation}
            >
              <span>
                {isRunningAutoSegmentation
                  ? t('Running', { defaultValue: 'Running...' })
                  : t('Run', { defaultValue: 'Run' })}
              </span>
            </Button>
          </div>
          {isAutoSegmentationExpanded && (
            <div className="mt-1 grid grid-cols-[1fr_1fr_1.15fr] gap-1">
              <label className="text-muted-foreground flex min-w-0 flex-col gap-0.5 text-[11px]">
                <span>{t('SUV threshold', { defaultValue: 'SUV threshold' })}</span>
                <input
                  data-cy="tmtvAutoSUVThreshold"
                  type="number"
                  min="0"
                  step="0.1"
                  className="border-input bg-popover text-foreground h-7 rounded border px-1.5 text-xs"
                  value={autoSUVThreshold}
                  onChange={event =>
                    setAutoSUVThreshold(getFiniteInputNumber(event.target.value, 2.5))
                  }
                />
              </label>
              <label className="text-muted-foreground flex min-w-0 flex-col gap-0.5 text-[11px]">
                <span>{t('Min volume mL', { defaultValue: 'Min volume mL' })}</span>
                <input
                  data-cy="tmtvAutoMinVolume"
                  type="number"
                  min="0"
                  step="0.1"
                  className="border-input bg-popover text-foreground h-7 rounded border px-1.5 text-xs"
                  value={autoMinVolumeML}
                  onChange={event =>
                    setAutoMinVolumeML(getFiniteInputNumber(event.target.value, 0.1))
                  }
                />
              </label>
              <label className="text-muted-foreground flex min-w-0 flex-col gap-0.5 text-[11px]">
                <span>{t('Write mode', { defaultValue: 'Write mode' })}</span>
                <select
                  data-cy="tmtvAutoWriteMode"
                  className="border-input bg-popover text-foreground h-7 min-w-0 rounded border px-1.5 text-xs"
                  value={autoWriteMode}
                  onChange={event =>
                    setAutoWriteMode(event.target.value === 'append' ? 'append' : 'overwrite')
                  }
                >
                  <option value="overwrite">{t('Overwrite', { defaultValue: 'Overwrite' })}</option>
                  <option value="append">{t('Append', { defaultValue: 'Append' })}</option>
                </select>
              </label>
            </div>
          )}
          {!!autoSegmentationSummary && (
            <div className="text-muted-foreground mt-0.5 truncate text-[11px]">
              {autoSegmentationSummary}
            </div>
          )}
        </div>
        <div className="border-border flex flex-shrink-0 flex-col gap-1 border-t px-2 py-1">
          {/* [2026-08-26 功能] 病灶审核头部：计数压缩成一行状态摘要，减少自动分割后右侧面板拥挤 */}
          <div className="text-muted-foreground flex items-center gap-2 text-xs font-semibold uppercase">
            <span className="text-foreground">{`${t('Lesions', {
              defaultValue: 'Lesions',
            })} ${lesionCount}`}</span>
            <span className="text-green-400">{`${t('Confirmed', {
              defaultValue: 'Confirmed',
            })} ${confirmedCount}`}</span>
            <span>{`${t('Candidate', { defaultValue: 'Candidate' })} ${candidateCount}`}</span>
            <span className="text-red-400">{`${t('Rejected', {
              defaultValue: 'Rejected',
            })} ${rejectedCount}`}</span>
          </div>
        </div>
        <div className="border-border flex flex-shrink-0 flex-col gap-1 border-t px-2 py-1">
          {/* [2026-08-25 功能] Lesion 过滤仅改变右侧展示，不触发重新分割或统计，避免额外性能开销 */}
          <div className="flex flex-wrap gap-1">
            {LESION_FILTERS.map(filter => {
              const isActive = lesionFilter === filter;

              return (
                <button
                  key={filter}
                  type="button"
                  className={`rounded px-2 py-0.5 text-[11px] ${
                    isActive
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground'
                  }`}
                  onClick={() => setLesionFilter(filter)}
                >
                  {`${getFilterLabel(filter)} ${getFilterCount(filter)}`}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-1">
            <select
              data-cy="tmtvLesionSort"
              className="border-input bg-popover text-foreground h-7 min-w-0 flex-1 rounded border px-1.5 text-xs"
              value={lesionSortKey}
              onChange={event => setLesionSortKey(event.target.value)}
            >
              {LESION_SORT_OPTIONS.map(sortKey => (
                <option
                  key={sortKey}
                  value={sortKey}
                >
                  {getSortLabel(sortKey)}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="bg-muted text-muted-foreground h-7 w-12 rounded text-xs"
              onClick={() =>
                setLesionSortDirection(direction => (direction === 'asc' ? 'desc' : 'asc'))
              }
            >
              {lesionSortDirection === 'asc'
                ? t('Ascending', { defaultValue: 'Asc' })
                : t('Descending', { defaultValue: 'Desc' })}
            </button>
          </div>
        </div>
        {(filteredConfirmCount > 0 ||
          filteredRejectCount > 0 ||
          selectedConfirmCount > 0 ||
          selectedRejectCount > 0 ||
          filteredRestoreCount > 0 ||
          selectedRestoreCount > 0 ||
          filteredDeleteCount > 0 ||
          selectedDeleteCount > 0 ||
          mergeSelectionIds.length >= 2) && (
          <div className="border-border flex flex-shrink-0 flex-wrap gap-1 border-t px-2 py-1">
            {/* [2026-08-26 功能] 自动分割批量审核：当前筛选和勾选病灶都支持一键 Confirm/Reject */}
            {filteredConfirmCount > 0 && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs text-green-400"
                onClick={() => handleSetFilteredLesionsStatus('confirmed')}
              >
                {`${t('Confirm current', {
                  defaultValue: 'Confirm current',
                })} ${filteredConfirmCount}`}
              </Button>
            )}
            {filteredRejectCount > 0 && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs text-red-300"
                onClick={() => handleSetFilteredLesionsStatus('rejected')}
              >
                {`${t('Reject current', {
                  defaultValue: 'Reject current',
                })} ${filteredRejectCount}`}
              </Button>
            )}
            {selectedConfirmCount > 0 && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs text-green-400"
                onClick={() => handleSetSelectedLesionsStatus('confirmed')}
              >
                {`${t('Confirm selected', {
                  defaultValue: 'Confirm selected',
                })} ${selectedConfirmCount}`}
              </Button>
            )}
            {selectedRejectCount > 0 && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs text-red-300"
                onClick={() => handleSetSelectedLesionsStatus('rejected')}
              >
                {`${t('Reject selected', {
                  defaultValue: 'Reject selected',
                })} ${selectedRejectCount}`}
              </Button>
            )}
            {filteredRestoreCount > 0 && (
              <Button
                size="sm"
                variant="ghost"
                className="text-primary h-6 px-2 text-xs"
                onClick={handleRestoreFilteredRejectedLesions}
              >
                {`${t('Restore current', {
                  defaultValue: 'Restore current',
                })} ${filteredRestoreCount}`}
              </Button>
            )}
            {selectedRestoreCount > 0 && (
              <Button
                size="sm"
                variant="ghost"
                className="text-primary h-6 px-2 text-xs"
                onClick={handleRestoreSelectedRejectedLesions}
              >
                {`${t('Restore selected', {
                  defaultValue: 'Restore selected',
                })} ${selectedRestoreCount}`}
              </Button>
            )}
            {filteredDeleteCount > 0 && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs text-red-400 hover:text-red-300"
                onClick={handleDeleteFilteredRejectedLesions}
              >
                {`${t('Delete current', {
                  defaultValue: 'Delete current',
                })} ${filteredDeleteCount}`}
              </Button>
            )}
            {selectedDeleteCount > 0 && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs text-red-400 hover:text-red-300"
                onClick={handleDeleteSelectedRejectedLesions}
              >
                {`${t('Delete selected', {
                  defaultValue: 'Delete selected',
                })} ${selectedDeleteCount}`}
              </Button>
            )}
            {mergeSelectionIds.length >= 2 && (
              <Button
                size="sm"
                variant="ghost"
                className="text-primary h-6 px-2 text-xs"
                onClick={handleMergeSelectedLesions}
              >
                {`${t('Merge selected lesions', {
                  defaultValue: 'Merge selected lesions',
                })} ${mergeSelectionIds.length}`}
              </Button>
            )}
          </div>
        )}
        {/* [2026-08-26 功能] Lesion 列表紧凑显示：减少卡片间距，提升右侧小面板中的可见病灶数量 */}
        <div className="ohif-scrollbar ohif-scrollbar-stable-gutter min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-1.5 py-1">
          {!lesionCount && (
            <div className="text-muted-foreground flex flex-col gap-2 py-2 text-sm">
              <span>
                {t('No Segment 1 lesions found.', {
                  defaultValue: 'No Segment 1 lesions found.',
                })}
              </span>
              {hasPersistedMask && (
                <Button
                  dataCY="restoreTmtvPersistedMask"
                  size="sm"
                  variant="default"
                  className="mr-auto h-7 px-2 text-xs"
                  disabled={isRestoringPersistedMask}
                  onClick={handleRestorePersistedMask}
                >
                  <span>
                    {isRestoringPersistedMask
                      ? t('Restoring local segmentation', {
                          defaultValue: 'Restoring local segmentation...',
                        })
                      : t('Restore local segmentation', {
                          defaultValue: 'Restore local segmentation',
                        })}
                  </span>
                </Button>
              )}
            </div>
          )}
          {!!lesionCount && !visibleLesions.length && (
            <div className="text-muted-foreground py-2 text-sm">
              {t('No lesions match the current filter.', {
                defaultValue: 'No lesions match the current filter.',
              })}
            </div>
          )}
          {visibleLesions.map(lesion => {
            const isSelected = lesion.id === selectedLesionId;
            const isConfirmed = lesion.status === 'confirmed';
            const isRejected = lesion.status === 'rejected';

            return (
              <div
                key={lesion.id}
                role="button"
                tabIndex={0}
                className={`border-border mb-1.5 w-full rounded-md border border-l-2 pb-1.5 text-left shadow-sm last:mb-0 ${getStatusAccentClass(
                  lesion
                )} ${isSelected ? 'ring-primary/80 bg-primary/10 ring-1' : ''}`}
                onClick={() => handleSelectLesion(lesion.id)}
                onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    handleSelectLesion(lesion.id);
                  }
                }}
              >
                <div className="mb-0.5 flex items-start justify-between gap-1.5 px-1 pt-1">
                  <div className="flex min-w-0 gap-2">
                    <input
                      type="checkbox"
                      className="accent-primary mt-1 h-3 w-3 flex-shrink-0"
                      checked={mergeSelectionIds.includes(lesion.id)}
                      onClick={event => event.stopPropagation()}
                      onChange={event => handleToggleMergeSelection(event, lesion.id)}
                      aria-label={`${t('Select for merge', {
                        defaultValue: 'Select for merge',
                      })} ${lesion.displayIndex ?? lesion.lesionNumber}`}
                    />
                    <div>
                      <div className="text-foreground text-sm font-semibold">
                        <span className="inline-flex items-center gap-1.5">
                          <span
                            className={`h-2 w-2 rounded-full ${getStatusDotClass(lesion.status)}`}
                          />
                          <span>
                            {`${isSelected ? '★ ' : ''}${t('Lesion', {
                              defaultValue: 'Lesion',
                            })} ${lesion.displayIndex ?? lesion.lesionNumber}`}
                          </span>
                        </span>
                      </div>
                      <div
                        className={`mt-0.5 text-[11px] font-semibold uppercase ${
                          isConfirmed
                            ? 'text-green-400'
                            : isRejected
                              ? 'text-red-400'
                              : 'text-muted-foreground'
                        }`}
                      >
                        <span>{getStatusLabel(lesion.status)}</span>
                        {!!lesion.mergedLesionIds?.length && lesion.mergedLesionIds.length > 1 && (
                          <span className="text-primary ml-2">
                            {`${t('Merged', { defaultValue: 'Merged' })} ${
                              lesion.mergedLesionIds.length
                            }`}
                          </span>
                        )}
                        {lesion.modified && (
                          <span className="text-primary ml-2">
                            {t('Edited', { defaultValue: 'Edited' })}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap justify-end gap-0.5">
                    {!isConfirmed && !isRejected && (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-1.5 text-xs text-green-400 hover:text-green-300"
                          onClick={event => handleSetLesionStatus(event, lesion.id, 'confirmed')}
                        >
                          {t('Confirm', { defaultValue: 'Confirm' })}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-1.5 text-xs text-red-300 hover:text-red-200"
                          onClick={event => handleSetLesionStatus(event, lesion.id, 'rejected')}
                        >
                          {t('Reject', { defaultValue: 'Reject' })}
                        </Button>
                      </>
                    )}
                    {isConfirmed && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-1.5 text-xs text-red-300 hover:text-red-200"
                        onClick={event => handleSetLesionStatus(event, lesion.id, 'rejected')}
                      >
                        {t('Reject', { defaultValue: 'Reject' })}
                      </Button>
                    )}
                    {isRejected && (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-primary h-6 px-1.5 text-xs"
                          onClick={event => handleSetLesionStatus(event, lesion.id, 'candidate')}
                        >
                          {t('Restore', { defaultValue: 'Restore' })}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-1.5 text-xs text-red-400 hover:text-red-300"
                          onClick={event => handleDeleteLesion(event, lesion.id)}
                        >
                          {t('Delete', { defaultValue: 'Delete' })}
                        </Button>
                      </>
                    )}
                  </div>
                </div>
                {/* [2026-08-26 功能] Lesion 指标改成两列紧凑格，减少单个病灶卡片高度 */}
                <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 px-1 pb-0.5 text-[11px] leading-5">
                  <div className="flex min-w-0 justify-between gap-1">
                    <span className="text-muted-foreground">
                      {t('Volume', { defaultValue: 'Volume' })}
                    </span>
                    <span className="text-foreground whitespace-nowrap">{`${formatStat(
                      lesion.volume
                    )} mL`}</span>
                  </div>
                  <div className="flex min-w-0 justify-between gap-1">
                    <span className="text-muted-foreground">
                      {t('SUVmax', { defaultValue: 'SUVmax' })}
                    </span>
                    <span className="text-foreground whitespace-nowrap">
                      {formatStat(lesion.suvMax)}
                    </span>
                  </div>
                  <div className="flex min-w-0 justify-between gap-1">
                    <span className="text-muted-foreground">
                      {t('SUVmin', { defaultValue: 'SUVmin' })}
                    </span>
                    <span className="text-foreground whitespace-nowrap">
                      {formatStat(lesion.suvMin)}
                    </span>
                  </div>
                  <div className="flex min-w-0 justify-between gap-1">
                    <span className="text-muted-foreground">
                      {t('SUVmean', { defaultValue: 'SUVmean' })}
                    </span>
                    <span className="text-foreground whitespace-nowrap">
                      {formatStat(lesion.suvMean)}
                    </span>
                  </div>
                  <div className="col-span-2 flex min-w-0 justify-between gap-1">
                    <span className="text-muted-foreground">
                      {t('TLG', { defaultValue: 'TLG' })}
                    </span>
                    <span className="text-foreground whitespace-nowrap">
                      {formatStat(lesion.tlg)}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
