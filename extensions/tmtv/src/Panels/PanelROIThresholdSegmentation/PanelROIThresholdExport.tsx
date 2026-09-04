import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useActiveViewportSegmentationRepresentations } from '@ohif/extension-cornerstone';
import { handleROIThresholding } from '../../utils/handleROIThresholding';
import { debounce } from '@ohif/core/src/utils';
import { useSystem } from '@ohif/core/src';
import { Button, Icons } from '@ohif/ui-next';
import { useTranslation } from 'react-i18next';
import tmtvLesionService from '../../services/TMTVLesionService';
import tmtvLesionHighlightService from '../../services/TMTVLesionHighlightService';
import tmtvComparisonService from '../../services/TMTVComparisonService';
import tmtvSessionService, { type TMTVSession } from '../../services/TMTVSessionService';
import tmtvLesionComparisonService, {
  createTMTVLesionComparisonResult,
  type TMTVLesionComparisonResult,
  type TMTVLesionMatchStatus,
} from '../../services/TMTVLesionComparisonService';
import { calculateTMTVPatientComparison } from '../../utils/calculateTMTVPatientComparison';

const SEGMENT_INDEX = 1;
const LESION_FILTERS = ['all', 'confirmed', 'candidate', 'rejected'];
const LESION_QUALITY_FILTERS = [
  'all',
  'review',
  'smallVolume',
  'lowUptake',
  'highUptake',
  'highBurden',
];
const LESION_SORT_OPTIONS = ['volume', 'suvMax', 'tlg', 'displayIndex'];
const MAX_VISIBLE_LESION_MATCHES = 100;
const LESION_QUALITY_RULES = {
  smallVolumeML: 1,
  lowSUVMax: 3,
  highSUVMax: 10,
  highTLG: 50,
};

type LocalSegmentMaskInfo = {
  voxelCount: number;
  updatedAt: number;
};

type LesionQualityTag = {
  key: string;
  tone: 'warning' | 'danger' | 'accent';
};

function formatStat(value: number | null | undefined, digits = 3) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '';
}

function formatComparisonStat(
  value: number | null | undefined,
  options: { digits?: number; signed?: boolean; suffix?: string } = {}
) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'N/A';
  }

  const { digits = 3, signed = false, suffix = '' } = options;
  const zeroThreshold = 0.5 * 10 ** -digits;
  const normalizedValue = Math.abs(value) < zeroThreshold ? 0 : value;
  const sign = signed && normalizedValue > 0 ? '+' : '';

  return `${sign}${normalizedValue.toFixed(digits)}${suffix}`;
}

function formatLocalMaskUpdatedAt(updatedAt: number | null | undefined) {
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) {
    return '';
  }

  return new Date(updatedAt).toLocaleString();
}

function formatCount(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : '0';
}

function getFiniteInputNumber(value: string, fallback: number): number {
  const numericValue = Number(value);

  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function getLesionMatchStatusLabel(status: TMTVLesionMatchStatus): string {
  if (status === 'persistent') return '持续';
  if (status === 'new') return '新发候选';
  if (status === 'resolved') return '消退候选';
  return '未匹配';
}

function getLesionMatchStatusClassName(status: TMTVLesionMatchStatus): string {
  if (status === 'persistent') return 'text-green-400';
  if (status === 'new') return 'text-primary';
  if (status === 'resolved') return 'text-orange-300';
  return 'text-yellow-300';
}

function getSortableNumber(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : -Infinity;
}

function getLesionQualityTags(lesion): LesionQualityTag[] {
  // [2026-08-27 功能] 自动分割质量控制：基于体积/SUV/TLG 生成可解释标签，只用于筛选和提示，不自动修改 mask
  const tags: LesionQualityTag[] = [];
  const volume = getSortableNumber(lesion.volume);
  const suvMax = getSortableNumber(lesion.suvMax);
  const tlg = getSortableNumber(lesion.tlg);

  if (volume > -Infinity && volume < LESION_QUALITY_RULES.smallVolumeML) {
    tags.push({ key: 'smallVolume', tone: 'warning' });
  }

  if (suvMax > -Infinity && suvMax < LESION_QUALITY_RULES.lowSUVMax) {
    tags.push({ key: 'lowUptake', tone: 'warning' });
  }

  if (suvMax >= LESION_QUALITY_RULES.highSUVMax) {
    tags.push({ key: 'highUptake', tone: 'danger' });
  }

  if (tlg >= LESION_QUALITY_RULES.highTLG) {
    tags.push({ key: 'highBurden', tone: 'accent' });
  }

  if (tags.some(tag => tag.key === 'smallVolume' || tag.key === 'lowUptake')) {
    tags.unshift({ key: 'review', tone: 'warning' });
  }

  return tags;
}

function doesLesionMatchQualityFilter(lesion, qualityFilter: string): boolean {
  if (qualityFilter === 'all') {
    return true;
  }

  return getLesionQualityTags(lesion).some(tag => tag.key === qualityFilter);
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
  const [activeSession, setActiveSession] = useState<TMTVSession | null>(() =>
    tmtvSessionService.getActiveSession()
  );
  const activeSessionRef = useRef<TMTVSession | null>(activeSession);
  const sessionSide = activeSession?.side || tmtvSessionService.getActiveSide();
  const lesionSessionId =
    sessionSide === 'baseline' || sessionSide === 'followup' ? activeSession?.sessionId : undefined;

  // 2026-09-02 功能说明：对比面板只读取当前 Session 的真实分割，切换检查不复用另一侧状态。
  const discoveredTMTVSegmentationsInfo =
    segmentationsInfo?.filter(
      info =>
        !tmtvLesionHighlightService.isHighlightSegmentationId(info.segmentation.segmentationId)
    ) || [];
  const discoveredSegmentationIds = discoveredTMTVSegmentationsInfo.map(
    info => info.segmentation.segmentationId
  );
  const discoveredSegmentationGroupId = [...discoveredSegmentationIds].sort().join(',');
  const activeViewportSide = tmtvComparisonService.getSideForViewportId(
    viewportGridService.getActiveViewportId?.()
  );
  const discoveredSegmentationIdsForSession =
    sessionSide === 'single' || activeViewportSide === sessionSide ? discoveredSegmentationIds : [];
  const sessionSegmentationIds = (activeSession?.segmentationIds || []).filter(
    segmentationId =>
      !tmtvLesionHighlightService.isHighlightSegmentationId(segmentationId) &&
      !!segmentationService.getSegmentation?.(segmentationId)
  );
  const segmentationIds = sessionSegmentationIds.length
    ? sessionSegmentationIds
    : discoveredSegmentationIdsForSession;
  const segmentations = segmentationIds
    .map(segmentationId => segmentationService.getSegmentation(segmentationId))
    .filter(Boolean);
  const segmentationGroupId = useMemo(
    () => `${sessionSide}:${[...segmentationIds].sort().join(',')}`,
    [sessionSide, discoveredSegmentationGroupId, activeSession?.revision]
  );
  const [lesionState, setLesionState] = useState(() =>
    tmtvLesionService.getState(segmentationIds, lesionSessionId)
  );
  const [lesionComparisonResult, setLesionComparisonResult] =
    useState<TMTVLesionComparisonResult | null>(() => tmtvLesionComparisonService.getResult());
  const [lesionFilter, setLesionFilter] = useState('all');
  const [lesionQualityFilter, setLesionQualityFilter] = useState('all');
  const [exportConfirmedOnly, setExportConfirmedOnly] = useState(true);
  const [mergeSelectionIds, setMergeSelectionIds] = useState<string[]>([]);
  const [hasPersistedMask, setHasPersistedMask] = useState(false);
  const [localMaskInfo, setLocalMaskInfo] = useState<LocalSegmentMaskInfo | null>(null);
  const [isCheckingLocalMask, setIsCheckingLocalMask] = useState(false);
  const [isClearingLocalMask, setIsClearingLocalMask] = useState(false);
  const [isRestoringPersistedMask, setIsRestoringPersistedMask] = useState(false);
  const [autoSUVThreshold, setAutoSUVThreshold] = useState(2.5);
  const [autoMinVolumeML, setAutoMinVolumeML] = useState(0.1);
  const [autoWriteMode, setAutoWriteMode] = useState<'overwrite' | 'append'>('overwrite');
  const [isRunningAutoSegmentation, setIsRunningAutoSegmentation] = useState(false);
  const [autoSegmentationSummary, setAutoSegmentationSummary] = useState('');
  const [isAutoSegmentationExpanded, setIsAutoSegmentationExpanded] = useState(true);
  const [isPatientComparisonExpanded, setIsPatientComparisonExpanded] = useState(true);
  // 2026-09-04 功能说明：病灶候选匹配属于辅助信息，进入面板时默认收起以节省右侧空间。
  const [isLesionComparisonExpanded, setIsLesionComparisonExpanded] = useState(false);
  const [lesionSortKey, setLesionSortKey] = useState('volume');
  const [lesionSortDirection, setLesionSortDirection] = useState<'asc' | 'desc'>('desc');
  const hasAttemptedInitialMaskRestoreRef = useRef(false);
  const localMaskRequestIdRef = useRef(0);
  const lesionRefreshRequestIdRef = useRef(0);
  const isRestoringPersistedMaskRef = useRef(false);
  const previousSessionSideRef = useRef(sessionSide);

  useEffect(() => {
    // 2026-09-02 功能说明：同步保存实时 Session，避免切换检查后 lesion 通知读取上一轮 React 闭包。
    const subscription = tmtvSessionService.subscribe(session => {
      activeSessionRef.current = session;
      setActiveSession(session);
    });
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    // 2026-09-03 功能说明：兜底初始化当前模块实例，避免分包后匹配服务未绑定而长期停留在更新状态。
    const ownsInitialization = tmtvLesionComparisonService.ensureInitialized({
      lesionService: tmtvLesionService,
      sessionService: tmtvSessionService,
    });
    const subscription = tmtvLesionComparisonService.subscribe(setLesionComparisonResult);
    tmtvLesionComparisonService.recalculate();
    return () => {
      subscription.unsubscribe();
      // 面板只销毁由自身建立的绑定；模式级实例继续由 onModeExit 统一释放。
      if (ownsInitialization) tmtvLesionComparisonService.destroy();
    };
  }, []);

  useEffect(() => {
    // 2026-09-03 功能说明：面板采用最新 lesion 状态后补触发一次幂等匹配，修复初始化通知早于 Session 登记的时序窗口。
    if (sessionSide === 'baseline' || sessionSide === 'followup') {
      tmtvLesionComparisonService.recalculate();
    }
  }, [lesionState.updatedAt, sessionSide]);

  useEffect(() => {
    if (previousSessionSideRef.current === sessionSide) return;
    // 2026-09-02 功能说明：切换检查时取消旧侧异步刷新并重置本地 mask 检测状态。
    previousSessionSideRef.current = sessionSide;
    lesionRefreshRequestIdRef.current += 1;
    localMaskRequestIdRef.current += 1;
    hasAttemptedInitialMaskRestoreRef.current = false;
    isRestoringPersistedMaskRef.current = false;
    setLocalMaskInfo(null);
    setHasPersistedMask(false);
    setLesionState(tmtvLesionService.getState(segmentationIds, lesionSessionId));
  }, [lesionSessionId, segmentationGroupId, sessionSide]);

  useEffect(() => {
    if (!discoveredSegmentationIdsForSession.length) return;
    const activeViewportId = viewportGridService.getActiveViewportId?.();
    const activeViewportSide = tmtvComparisonService.getSideForViewportId(activeViewportId);
    if (sessionSide !== 'single' && activeViewportSide !== sessionSide) return;

    const currentSession = tmtvSessionService.getSession(sessionSide);
    const existingSessionIds = (currentSession?.segmentationIds || []).filter(segmentationId =>
      segmentationService.getSegmentation?.(segmentationId)
    );
    const nextIds = [...new Set([...existingSessionIds, ...discoveredSegmentationIdsForSession])];
    tmtvSessionService.setSegmentationIds(
      sessionSide,
      nextIds,
      currentSession?.activeSegmentationId || nextIds[0]
    );
  }, [discoveredSegmentationGroupId, segmentationService, sessionSide, viewportGridService]);

  const getCurrentTMTVSegmentations = useCallback(
    (preferredSegmentationId?: string) => {
      // [2026-08-27 功能] 本地 mask 恢复：优先使用刚创建的 segmentation，避免旧 segmentationIds 闭包导致恢复后 lesion 列表为空
      const liveSessionSegmentationIds =
        tmtvSessionService.getSession(sessionSide)?.segmentationIds || [];
      if (
        preferredSegmentationId &&
        (sessionSide === 'single' || liveSessionSegmentationIds.includes(preferredSegmentationId))
      ) {
        const preferredSegmentation = segmentationService.getSegmentation(preferredSegmentationId);

        if (
          preferredSegmentation &&
          !tmtvLesionHighlightService.isHighlightSegmentationId(preferredSegmentationId)
        ) {
          return [preferredSegmentation];
        }
      }

      if (segmentationIds.length) {
        return segmentationIds.map(id => segmentationService.getSegmentation(id)).filter(Boolean);
      }

      return sessionSide === 'single'
        ? segmentationService
            .getSegmentations()
            .filter(
              segmentation =>
                !tmtvLesionHighlightService.isHighlightSegmentationId(segmentation.segmentationId)
            )
        : [];
    },
    [segmentationGroupId, segmentationService, sessionSide]
  );

  const refreshTMTVAndLesions = useCallback(
    async (segmentationId?: string, options: { restorePersistedMask?: boolean } = {}) => {
      // [2026-08-24 功能] Segment 1 更新后同步刷新整体 TMTV/TLG 和 lesion 级统计
      const requestSide = tmtvSessionService.getActiveSide();
      const requestSession = tmtvSessionService.getSession(requestSide);
      const requestLesionSessionId =
        requestSide === 'single' ? undefined : requestSession?.sessionId;
      const requestId = lesionRefreshRequestIdRef.current + 1;
      lesionRefreshRequestIdRef.current = requestId;
      const currentSegmentations = getCurrentTMTVSegmentations(segmentationId);

      if (!currentSegmentations.length) {
        // 2026-09-02 功能说明：新建分割的事件早于 Session/面板刷新时不启动空统计任务。
        return;
      }

      const metabolicStats = await handleROIThresholding({
        segmentationId,
        commandsManager,
        segmentationService,
        segmentations: currentSegmentations,
      });

      if (metabolicStats == null) {
        return;
      }

      if (
        lesionRefreshRequestIdRef.current !== requestId ||
        tmtvSessionService.getActiveSide() !== requestSide
      ) {
        return;
      }

      const nextLesionState = await tmtvLesionService.extractLesionsForSegmentationsAsync(
        currentSegmentations,
        SEGMENT_INDEX,
        {
          restorePersistedMask: options.restorePersistedMask,
          sessionId: requestLesionSessionId,
        }
      );

      if (
        lesionRefreshRequestIdRef.current !== requestId ||
        tmtvSessionService.getActiveSide() !== requestSide
      ) {
        return;
      }

      setLesionState(nextLesionState);
      tmtvSessionService.setSegmentationIds(
        requestSide,
        nextLesionState.segmentationIds,
        segmentationId || nextLesionState.segmentationIds[0]
      );
      tmtvSessionService.setTotals(requestSide, nextLesionState.totals);

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
      getCurrentTMTVSegmentations,
      segmentationGroupId,
      segmentationService,
      viewportGridService,
    ]
  );

  const refreshLocalMaskInfo = useCallback(async () => {
    // [2026-08-27 功能] 本地存储管理 UI：异步刷新当前病例本地 mask 摘要，并用 requestId 避免旧请求覆盖新状态
    const requestId = localMaskRequestIdRef.current + 1;
    localMaskRequestIdRef.current = requestId;
    setIsCheckingLocalMask(true);

    try {
      const info = await commandsManager.runCommand('getTMTVSegmentMaskStorageInfo', {
        segmentIndex: SEGMENT_INDEX,
      });

      if (localMaskRequestIdRef.current !== requestId) {
        return;
      }

      setLocalMaskInfo(info ?? null);
      setHasPersistedMask(!!info);
    } catch {
      if (localMaskRequestIdRef.current === requestId) {
        setLocalMaskInfo(null);
        setHasPersistedMask(false);
      }
    } finally {
      if (localMaskRequestIdRef.current === requestId) {
        setIsCheckingLocalMask(false);
      }
    }
  }, [commandsManager]);

  useEffect(() => {
    // [2026-08-24 功能] 订阅 TMTVLesionService 状态，让右侧 lesion 面板响应选中/删除/重算
    const subscription = tmtvLesionService.subscribe(() => {
      if (isRestoringPersistedMaskRef.current) {
        // [2026-08-27 功能] 本地 mask 恢复：恢复完成前忽略旧订阅闭包，防止空 segmentationIds 把刚恢复的病灶列表清掉
        return;
      }

      // 2026-09-02 功能说明：通知时读取实时检查范围，避免确认/拒绝后被旧 Session 的空状态覆盖。
      const liveSession = activeSessionRef.current ?? tmtvSessionService.getActiveSession();
      const liveSide = liveSession?.side ?? tmtvSessionService.getActiveSide();
      const liveLesionSessionId =
        liveSide === 'baseline' || liveSide === 'followup' ? liveSession?.sessionId : undefined;
      const liveSegmentationIds = (liveSession?.segmentationIds || []).filter(
        segmentationId =>
          !tmtvLesionHighlightService.isHighlightSegmentationId(segmentationId) &&
          !!segmentationService.getSegmentation?.(segmentationId)
      );
      const scopedSegmentationIds = liveSegmentationIds.length
        ? liveSegmentationIds
        : liveSide === sessionSide
          ? segmentationIds
          : [];
      const scopedLesionState = tmtvLesionService.getState(
        scopedSegmentationIds,
        liveLesionSessionId
      );
      setLesionState(scopedLesionState);
      const currentSession = tmtvSessionService.getSession(liveSide);
      tmtvSessionService.setSegmentationIds(
        liveSide,
        scopedLesionState.segmentationIds,
        currentSession?.activeSegmentationId || scopedLesionState.segmentationIds[0]
      );
      tmtvSessionService.setTotals(liveSide, scopedLesionState.totals);
      setMergeSelectionIds(previousSelectionIds =>
        previousSelectionIds.filter(lesionId =>
          scopedLesionState.lesions.some(lesion => lesion.id === lesionId)
        )
      );
    });

    setLesionState(tmtvLesionService.getState(segmentationIds, lesionSessionId));

    return () => {
      subscription.unsubscribe();
      tmtvLesionHighlightService.removeHighlight(segmentationIds);
    };
  }, [lesionSessionId, segmentationGroupId, segmentationService, sessionSide]);

  useEffect(() => {
    const initialRun = async () => {
      if (!segmentationIds.length) {
        // [2026-08-26 功能] IndexedDB 稀疏保存/恢复 Segment 1 mask：没有现成 segmentation 时不自动创建，避免刷新后改变 viewport 几何或工具编辑目标
        hasAttemptedInitialMaskRestoreRef.current = true;
        await refreshLocalMaskInfo();
        return;
      }

      if (isRestoringPersistedMaskRef.current) {
        // [2026-08-27 功能] 本地 mask 显式恢复：创建恢复载体会触发 segmentationGroupId 变化，普通初始化刷新需让位给带 restorePersistedMask 的恢复请求
        return;
      }

      for (const segmentationId of segmentationIds) {
        await refreshTMTVAndLesions(segmentationId, {
          restorePersistedMask: !hasAttemptedInitialMaskRestoreRef.current,
        });
      }

      hasAttemptedInitialMaskRestoreRef.current = true;
      await refreshLocalMaskInfo();
    };

    initialRun();
  }, [refreshLocalMaskInfo, refreshTMTVAndLesions, segmentationGroupId]);

  useEffect(() => {
    // [2026-08-27 功能] 本地存储管理 UI：刷新进入模式时 PT volume 可能晚于面板就绪，做短时复查保证恢复入口能出现
    const timeoutIds = [300, 1200, 3000].map(delay =>
      window.setTimeout(() => {
        refreshLocalMaskInfo();
      }, delay)
    );

    return () => {
      timeoutIds.forEach(timeoutId => window.clearTimeout(timeoutId));
    };
  }, [refreshLocalMaskInfo, segmentationGroupId]);

  useEffect(() => {
    if (!lesionState.updatedAt) {
      return;
    }

    // [2026-08-27 功能] 本地存储管理 UI：分割编辑后等待防抖保存落库，再刷新本地保存状态，避免显示旧时间
    const timeoutId = window.setTimeout(() => {
      refreshLocalMaskInfo();
    }, 1000);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [lesionState.updatedAt, refreshLocalMaskInfo]);

  useEffect(() => {
    return () => {
      localMaskRequestIdRef.current += 1;
      lesionRefreshRequestIdRef.current += 1;
      isRestoringPersistedMaskRef.current = false;
    };
  }, []);

  const handleRestorePersistedMask = async () => {
    // [2026-08-26 功能] 本地分割恢复：由医生显式点击后才创建 Segment 1 并恢复 IndexedDB mask，避免打开面板即改变图像状态
    if (isRestoringPersistedMask) {
      return;
    }

    setIsRestoringPersistedMask(true);
    isRestoringPersistedMaskRef.current = true;

    try {
      const restoredSegmentationId = await commandsManager.runCommand('createNewLabelmapFromPT', {
        label: 'TMTV Segmentation',
        restoreOnlyIfPersistedMask: true,
      });

      if (restoredSegmentationId) {
        await refreshTMTVAndLesions(restoredSegmentationId, {
          restorePersistedMask: true,
        });
        await refreshLocalMaskInfo();
      }
    } finally {
      isRestoringPersistedMaskRef.current = false;
      setIsRestoringPersistedMask(false);
    }
  };

  const handleClearLocalMask = async () => {
    // [2026-08-27 功能] 本地存储管理 UI：仅删除浏览器本地备份，不清空当前影像上的 Segment 1 体素
    if (isClearingLocalMask) {
      return;
    }

    const shouldClear =
      typeof window === 'undefined' ||
      window.confirm?.(
        t('Clear local segmentation confirmation', {
          defaultValue:
            'Clear the browser local Segment 1 backup for this case? This will not clear the current image segmentation.',
        })
      );

    if (!shouldClear) {
      return;
    }

    setIsClearingLocalMask(true);

    try {
      const didClear = await commandsManager.runCommand('clearTMTVSegmentMaskStorage', {
        segmentIndex: SEGMENT_INDEX,
      });

      if (didClear) {
        setLocalMaskInfo(null);
        setHasPersistedMask(false);
      } else {
        await refreshLocalMaskInfo();
      }
    } finally {
      setIsClearingLocalMask(false);
    }
  };

  useEffect(() => {
    const debouncedHandleROIThresholding = debounce(async eventDetail => {
      const { segmentationId } = eventDetail;
      await refreshTMTVAndLesions(segmentationId);
    }, 100);

    const dataModifiedCallback = eventDetail => {
      if (isRestoringPersistedMaskRef.current) {
        // [2026-08-27 功能] 本地 mask 恢复：写回本地 mask 会触发 modified 事件，恢复专用刷新完成前不启动普通重算
        return;
      }

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
  // 2026-09-03 功能说明：患者级对比仅读取两个轻量 Session totals，不触发体素统计或持有影像对象。
  const patientComparison =
    sessionSide === 'baseline' || sessionSide === 'followup'
      ? calculateTMTVPatientComparison(
          tmtvSessionService.getSession('baseline')?.totals,
          tmtvSessionService.getSession('followup')?.totals
        )
      : null;
  const patientComparisonRows = patientComparison
    ? [
        { label: 'TMTV', metric: patientComparison.tmtv },
        { label: 'TLG', metric: patientComparison.tlg },
      ]
    : [];
  const baselineComparisonSession = tmtvSessionService.getSession('baseline');
  const followupComparisonSession = tmtvSessionService.getSession('followup');
  const baselineComparisonState = baselineComparisonSession
    ? tmtvLesionService.getState(
        baselineComparisonSession.segmentationIds,
        baselineComparisonSession.sessionId
      )
    : null;
  const followupComparisonState = followupComparisonSession
    ? tmtvLesionService.getState(
        followupComparisonSession.segmentationIds,
        followupComparisonSession.sessionId
      )
    : null;
  const baselineComparisonReady = !!baselineComparisonState?.updatedAt;
  const followupComparisonReady = !!followupComparisonState?.updatedAt;
  const baselineComparisonSessionId = baselineComparisonSession?.sessionId;
  const followupComparisonSessionId = followupComparisonSession?.sessionId;
  const effectiveLesionComparisonResult = useMemo(() => {
    if (
      lesionComparisonResult?.baselineSessionId === baselineComparisonSessionId &&
      lesionComparisonResult?.followupSessionId === followupComparisonSessionId &&
      lesionComparisonResult?.baselineStateUpdatedAt === baselineComparisonState?.updatedAt &&
      lesionComparisonResult?.followupStateUpdatedAt === followupComparisonState?.updatedAt
    ) {
      return lesionComparisonResult;
    }
    if (
      !baselineComparisonSessionId ||
      !followupComparisonSessionId ||
      !baselineComparisonState ||
      !followupComparisonState
    ) {
      return null;
    }

    // 2026-09-03 功能说明：服务通知缺失时由现有轻量病灶状态同步生成显示快照，不读取或复制影像体素。
    return createTMTVLesionComparisonResult(
      { sessionId: baselineComparisonSessionId },
      { sessionId: followupComparisonSessionId },
      baselineComparisonState,
      followupComparisonState
    );
  }, [
    lesionComparisonResult,
    baselineComparisonSessionId,
    followupComparisonSessionId,
    baselineComparisonState,
    followupComparisonState,
  ]);
  const lesionComparisonPendingMessage =
    !baselineComparisonReady && !followupComparisonReady
      ? '检查一、检查二尚未生成病灶列表'
      : !baselineComparisonReady
        ? '检查一尚未生成病灶列表'
        : !followupComparisonReady
          ? '检查二尚未生成病灶列表'
          : '匹配结果正在更新';
  const comparisonLesionLabels = useMemo(() => {
    const labels = {
      baseline: new Map<string, string>(),
      followup: new Map<string, string>(),
    };
    if (!effectiveLesionComparisonResult) return labels;

    const baselineSession = tmtvSessionService.getSession('baseline');
    const followupSession = tmtvSessionService.getSession('followup');
    const baselineState = baselineSession
      ? tmtvLesionService.getState(baselineSession.segmentationIds, baselineSession.sessionId)
      : null;
    const followupState = followupSession
      ? tmtvLesionService.getState(followupSession.segmentationIds, followupSession.sessionId)
      : null;

    baselineState?.lesions.forEach(lesion =>
      labels.baseline.set(lesion.id, `检查一 #${lesion.displayIndex}`)
    );
    followupState?.lesions.forEach(lesion =>
      labels.followup.set(lesion.id, `检查二 #${lesion.displayIndex}`)
    );
    return labels;
  }, [effectiveLesionComparisonResult]);
  const visibleLesionMatches = effectiveLesionComparisonResult?.matches.slice(
    0,
    MAX_VISIBLE_LESION_MATCHES
  );
  const hiddenLesionMatchCount = Math.max(
    0,
    (effectiveLesionComparisonResult?.matches.length || 0) - MAX_VISIBLE_LESION_MATCHES
  );
  const lesionCount = lesionState.lesions.length;
  const selectedLesionId = lesionState.selectedLesionId;
  const confirmedCount = lesionState.lesions.filter(lesion => lesion.status === 'confirmed').length;
  const candidateCount = lesionState.lesions.filter(lesion => lesion.status === 'candidate').length;
  const rejectedCount = lesionState.lesions.filter(lesion => lesion.status === 'rejected').length;
  const filteredLesions = useMemo(() => {
    // [2026-08-27 功能] 自动分割质量控制：状态筛选和质量筛选叠加生效，批量按钮直接作用于当前筛选结果
    const statusFilteredLesions =
      lesionFilter === 'all'
        ? lesionState.lesions
        : lesionState.lesions.filter(lesion => lesion.status === lesionFilter);

    return statusFilteredLesions.filter(lesion =>
      doesLesionMatchQualityFilter(lesion, lesionQualityFilter)
    );
  }, [lesionFilter, lesionQualityFilter, lesionState.lesions]);
  const qualityCounts = useMemo(() => {
    // [2026-08-27 功能] 自动分割质量控制：为质量筛选下拉提供计数，帮助医生快速判断是否存在低优先级候选
    return LESION_QUALITY_FILTERS.reduce<Record<string, number>>((counts, qualityFilter) => {
      counts[qualityFilter] =
        qualityFilter === 'all'
          ? lesionState.lesions.length
          : lesionState.lesions.filter(lesion =>
              doesLesionMatchQualityFilter(lesion, qualityFilter)
            ).length;

      return counts;
    }, {});
  }, [lesionState.lesions]);
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
    // 2026-09-02 功能说明：确认/拒绝后立即采用命令返回状态，避免等待订阅重渲染时列表短暂清空。
    event.stopPropagation();
    const nextLesionState = commandsManager.runCommand('setTMTVLesionStatus', {
      segmentationIds,
      lesionId,
      status,
    });

    if (nextLesionState) {
      setLesionState(nextLesionState);
    }
  };

  const handleSetLesionStatuses = (lesionIds: string[], status) => {
    // [2026-08-26 功能] 批量 Confirm/Reject：复用当前筛选和勾选状态，减少自动分割后逐个审核成本
    const targetLesionIds = Array.from(new Set((lesionIds ?? []).filter(Boolean)));

    if (!targetLesionIds.length) {
      return;
    }

    const nextLesionState = commandsManager.runCommand('setTMTVLesionStatuses', {
      segmentationIds,
      lesionIds: targetLesionIds,
      status,
    });
    if (nextLesionState) {
      setLesionState(nextLesionState);
    }
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

      setLocalMaskInfo(null);
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

  const getQualityFilterLabel = filter => {
    if (filter === 'review') {
      return t('Needs review', { defaultValue: 'Needs review' });
    }

    if (filter === 'smallVolume') {
      return t('Small volume', { defaultValue: 'Small volume' });
    }

    if (filter === 'lowUptake') {
      return t('Low uptake', { defaultValue: 'Low uptake' });
    }

    if (filter === 'highUptake') {
      return t('High uptake', { defaultValue: 'High uptake' });
    }

    if (filter === 'highBurden') {
      return t('High burden', { defaultValue: 'High burden' });
    }

    return t('All quality', { defaultValue: 'All quality' });
  };

  const getQualityTagLabel = tagKey => {
    if (tagKey === 'review') {
      return t('Needs review', { defaultValue: 'Needs review' });
    }

    if (tagKey === 'smallVolume') {
      return t('Small volume', { defaultValue: 'Small volume' });
    }

    if (tagKey === 'lowUptake') {
      return t('Low uptake', { defaultValue: 'Low uptake' });
    }

    if (tagKey === 'highUptake') {
      return t('High uptake', { defaultValue: 'High uptake' });
    }

    return t('High burden', { defaultValue: 'High burden' });
  };

  const getQualityTagClass = (tone: LesionQualityTag['tone']) => {
    if (tone === 'danger') {
      return 'border-red-400/40 bg-red-500/15 text-red-200';
    }

    if (tone === 'accent') {
      return 'border-primary/40 bg-primary/15 text-primary';
    }

    return 'border-yellow-400/40 bg-yellow-500/15 text-yellow-100';
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
          {patientComparison && (
            <div
              data-cy="tmtvPatientComparisonTotals"
              className="border-border border-t pt-0.5"
            >
              {/* 2026-09-03 功能说明：总量对比可折叠，释放紧凑右侧面板的病灶列表空间。 */}
              <button
                type="button"
                data-cy="toggleTmtvPatientComparisonTotals"
                className="text-muted-foreground flex h-5 w-full items-center justify-between text-[11px] font-semibold"
                aria-expanded={isPatientComparisonExpanded}
                title={isPatientComparisonExpanded ? '收起总量对比' : '展开总量对比'}
                onClick={() => setIsPatientComparisonExpanded(isExpanded => !isExpanded)}
              >
                <span>总量对比</span>
                <Icons.ChevronDown
                  className={`h-3.5 w-3.5 transition-transform ${
                    isPatientComparisonExpanded ? '' : '-rotate-90'
                  }`}
                />
              </button>
              {isPatientComparisonExpanded && (
                <div className="grid grid-cols-[2.75rem_repeat(4,minmax(0,1fr))] gap-x-1 text-[10px] leading-4">
                  <span />
                  <span className="text-muted-foreground truncate text-right">检查一</span>
                  <span className="text-muted-foreground truncate text-right">检查二</span>
                  <span className="text-muted-foreground truncate text-right">差值</span>
                  <span className="text-muted-foreground truncate text-right">变化率</span>
                  {patientComparisonRows.map(({ label, metric }) => (
                    <React.Fragment key={label}>
                      <span className="text-muted-foreground font-semibold">{label}</span>
                      <span
                        className="text-foreground truncate text-right tabular-nums"
                        title={formatComparisonStat(metric.baseline)}
                      >
                        {formatComparisonStat(metric.baseline)}
                      </span>
                      <span
                        className="text-foreground truncate text-right tabular-nums"
                        title={formatComparisonStat(metric.followup)}
                      >
                        {formatComparisonStat(metric.followup)}
                      </span>
                      <span
                        className="text-foreground truncate text-right tabular-nums"
                        title={formatComparisonStat(metric.delta, { signed: true })}
                      >
                        {formatComparisonStat(metric.delta, { signed: true })}
                      </span>
                      <span
                        className="text-foreground truncate text-right tabular-nums"
                        title={formatComparisonStat(metric.percentChange, {
                          digits: 1,
                          signed: true,
                          suffix: '%',
                        })}
                      >
                        {formatComparisonStat(metric.percentChange, {
                          digits: 1,
                          signed: true,
                          suffix: '%',
                        })}
                      </span>
                    </React.Fragment>
                  ))}
                </div>
              )}
            </div>
          )}
          {patientComparison && (
            <div
              data-cy="tmtvLesionComparison"
              className="border-border border-t pt-0.5"
            >
              {/* 2026-09-03 功能说明：病灶匹配列表只读且可折叠，手动校正留到阶段 2.4.3。 */}
              <button
                type="button"
                data-cy="toggleTmtvLesionComparison"
                className="text-muted-foreground flex h-5 w-full items-center justify-between text-[11px] font-semibold"
                aria-expanded={isLesionComparisonExpanded}
                title={isLesionComparisonExpanded ? '收起病灶对比' : '展开病灶对比'}
                onClick={() => setIsLesionComparisonExpanded(isExpanded => !isExpanded)}
              >
                <span>病灶对比</span>
                <Icons.ChevronDown
                  className={`h-3.5 w-3.5 transition-transform ${
                    isLesionComparisonExpanded ? '' : '-rotate-90'
                  }`}
                />
              </button>
              {isLesionComparisonExpanded && (
                <div className="flex flex-col gap-1 pb-0.5">
                  {effectiveLesionComparisonResult ? (
                    <>
                      <div className="flex flex-wrap gap-x-2 gap-y-0 text-[10px] leading-4">
                        <span className="text-green-400">
                          {`持续 ${effectiveLesionComparisonResult.counts.persistent}`}
                        </span>
                        <span className="text-primary">
                          {`新发 ${effectiveLesionComparisonResult.counts.new}`}
                        </span>
                        <span className="text-orange-300">
                          {`消退 ${effectiveLesionComparisonResult.counts.resolved}`}
                        </span>
                        <span className="text-yellow-300">
                          {`未匹配 ${effectiveLesionComparisonResult.counts.unmatched}`}
                        </span>
                      </div>
                      {visibleLesionMatches?.length ? (
                        <div className="ohif-scrollbar max-h-36 overflow-y-auto border-t border-white/10">
                          {visibleLesionMatches.map(match => {
                            const baselineLabel = match.baselineLesionId
                              ? comparisonLesionLabels.baseline.get(match.baselineLesionId) ||
                                '检查一病灶'
                              : '';
                            const followupLabel = match.followupLesionId
                              ? comparisonLesionLabels.followup.get(match.followupLesionId) ||
                                '检查二病灶'
                              : '';
                            const lesionPairLabel =
                              baselineLabel && followupLabel
                                ? `${baselineLabel} → ${followupLabel}`
                                : baselineLabel || followupLabel;

                            return (
                              <div
                                key={match.matchId}
                                className="grid grid-cols-[4.5rem_minmax(0,1fr)_3.5rem] items-center gap-1 border-b border-white/5 py-0.5 text-[10px] leading-4 last:border-b-0"
                                title={`${match.baselineLesionId || '-'} → ${
                                  match.followupLesionId || '-'
                                }`}
                              >
                                <span
                                  className={`truncate font-semibold ${getLesionMatchStatusClassName(
                                    match.status
                                  )}`}
                                >
                                  {getLesionMatchStatusLabel(match.status)}
                                </span>
                                <span className="text-foreground truncate">{lesionPairLabel}</span>
                                <span className="text-muted-foreground text-right tabular-nums">
                                  {typeof match.distanceMM === 'number'
                                    ? `${match.distanceMM.toFixed(1)} mm`
                                    : match.reason === 'conflict'
                                      ? '待确认'
                                      : ''}
                                </span>
                              </div>
                            );
                          })}
                          {hiddenLesionMatchCount > 0 && (
                            <div className="text-muted-foreground py-1 text-center text-[10px]">
                              {`另有 ${hiddenLesionMatchCount} 项未展开`}
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="text-muted-foreground text-[10px]">暂无已确认病灶</div>
                      )}
                    </>
                  ) : (
                    <div className="text-muted-foreground text-[10px]">
                      {lesionComparisonPendingMessage}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
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
        <div className="border-border bg-background flex flex-shrink-0 items-center justify-between gap-2 border-t px-2 py-1">
          {/* [2026-08-27 功能] 本地存储管理 UI：显示当前病例 Segment 1 浏览器本地保存状态，并支持一键清除本地备份 */}
          <div className="min-w-0 text-[11px] leading-4">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="text-muted-foreground font-semibold uppercase">
                {t('Local segmentation storage', {
                  defaultValue: 'Local save',
                })}
              </span>
              <span
                className={
                  localMaskInfo
                    ? 'text-green-400'
                    : isCheckingLocalMask
                      ? 'text-primary'
                      : 'text-muted-foreground'
                }
              >
                {isCheckingLocalMask
                  ? t('Checking', { defaultValue: 'Checking...' })
                  : localMaskInfo
                    ? t('Saved', { defaultValue: 'Saved' })
                    : t('Not saved', { defaultValue: 'Not saved' })}
              </span>
            </div>
            {localMaskInfo && (
              <div className="text-muted-foreground truncate">
                {`${t('Saved at', { defaultValue: 'Saved at' })} ${formatLocalMaskUpdatedAt(
                  localMaskInfo.updatedAt
                )} · ${formatCount(localMaskInfo.voxelCount)} ${t('Voxels', {
                  defaultValue: 'voxels',
                })}`}
              </div>
            )}
          </div>
          {localMaskInfo && (
            <Button
              dataCY="clearTmtvLocalSegmentation"
              size="sm"
              variant="ghost"
              className="h-6 flex-shrink-0 px-2 text-xs text-red-300 hover:text-red-200"
              disabled={isClearingLocalMask}
              onClick={handleClearLocalMask}
            >
              <span>
                {isClearingLocalMask
                  ? t('Clearing', { defaultValue: 'Clearing...' })
                  : t('Clear local segmentation', {
                      defaultValue: 'Clear',
                    })}
              </span>
            </Button>
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
              data-cy="tmtvLesionQualityFilter"
              className="border-input bg-popover text-foreground h-7 min-w-0 flex-1 rounded border px-1.5 text-xs"
              value={lesionQualityFilter}
              onChange={event => setLesionQualityFilter(event.target.value)}
            >
              {LESION_QUALITY_FILTERS.map(qualityFilter => (
                <option
                  key={qualityFilter}
                  value={qualityFilter}
                >
                  {`${getQualityFilterLabel(qualityFilter)} ${qualityCounts[qualityFilter] ?? 0}`}
                </option>
              ))}
            </select>
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
            const qualityTags = getLesionQualityTags(lesion);

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
                      {!!qualityTags.length && (
                        <div className="mt-1 flex max-w-[190px] flex-wrap gap-1">
                          {qualityTags.slice(0, 3).map(tag => (
                            <span
                              key={tag.key}
                              className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold leading-3 ${getQualityTagClass(
                                tag.tone
                              )}`}
                            >
                              {getQualityTagLabel(tag.key)}
                            </span>
                          ))}
                        </div>
                      )}
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
