import { cache, Enums } from '@cornerstonejs/core';
import initialState from './TMTVComparisonInitialState';
import createComparisonCameraSynchronizer, {
  COMPARISON_CAMERA_TYPE,
} from '../utils/createComparisonCameraSynchronizer';
import applyTMTVZoomSync from '../utils/applyTMTVZoomSync';
import createTMTVSameStudyCameraSynchronizer, {
  TMTV_SAME_STUDY_CAMERA_TYPE,
} from '../utils/createTMTVSameStudyCameraSynchronizer';
import fitComparisonViewports, {
  reconcileComparisonViewportScales,
} from '../utils/fitComparisonViewports';
import { COMPARISON_VIEWPORT_IDS_BY_SIDE } from '../utils/comparisonViewportIds';

export type TMTVComparisonSide = 'baseline' | 'followup';
type TMTVComparisonModality = 'CT' | 'PT' | 'Fusion' | 'MIP';

type TMTVComparisonState = {
  isComparisonMode: boolean;
  activeSide: TMTVComparisonSide;
  activeViewportId: string | null;
};

type TMTVComparisonListener = (state: TMTVComparisonState) => void;

const TMTV_COMPARE_PROTOCOL_ID = '@ohif/extension-tmtv.hangingProtocolModule.ptCTCompare';

const VIEWPORT_IDS_BY_SIDE: Record<TMTVComparisonSide, readonly string[]> =
  COMPARISON_VIEWPORT_IDS_BY_SIDE;

const VIEWPORT_IDS_BY_SIDE_AND_MODALITY: Record<
  TMTVComparisonSide,
  Record<TMTVComparisonModality, string>
> = {
  baseline: {
    CT: 'baselineCTAxial',
    PT: 'baselinePTAxial',
    Fusion: 'baselineFusionAxial',
    MIP: 'baselineMIPSagittal',
  },
  followup: {
    CT: 'followupCTAxial',
    PT: 'followupPTAxial',
    Fusion: 'followupFusionAxial',
    MIP: 'followupMIPSagittal',
  },
};

const COMPARISON_SYNC_IDS = [
  'tmtvCompareCameraCT',
  'tmtvCompareCameraPT',
  'tmtvCompareCameraFusion',
  'tmtvCompareCameraMIP',
  'tmtvCompareVOICT',
  'tmtvCompareVOIPT',
  'tmtvCompareVOIFusion',
  'tmtvCompareVOIMIP',
];

const COMPARISON_VIEWPORT_PAIRS = [
  {
    modality: 'CT',
    viewportIds: [VIEWPORT_IDS_BY_SIDE.baseline[0], VIEWPORT_IDS_BY_SIDE.followup[0]],
  },
  {
    modality: 'PT',
    viewportIds: [VIEWPORT_IDS_BY_SIDE.baseline[1], VIEWPORT_IDS_BY_SIDE.followup[1]],
  },
  {
    modality: 'Fusion',
    viewportIds: [VIEWPORT_IDS_BY_SIDE.baseline[2], VIEWPORT_IDS_BY_SIDE.followup[2]],
  },
  {
    modality: 'MIP',
    viewportIds: [VIEWPORT_IDS_BY_SIDE.baseline[3], VIEWPORT_IDS_BY_SIDE.followup[3]],
  },
];

const normalizeSide = (side?: string | null): TMTVComparisonSide | null => {
  if (!side) {
    return null;
  }

  const normalized = side.toLowerCase().replace(/[-_\s]/g, '');
  if (normalized === 'baseline') {
    return 'baseline';
  }
  if (normalized === 'followup') {
    return 'followup';
  }

  return null;
};

const normalizeModality = (modality?: string | null): TMTVComparisonModality | null => {
  if (!modality) {
    return null;
  }

  const normalized = modality.toLowerCase();
  if (normalized === 'ct') {
    return 'CT';
  }
  if (normalized === 'pt' || normalized === 'pet') {
    return 'PT';
  }
  if (normalized === 'fusion') {
    return 'Fusion';
  }
  if (normalized === 'mip') {
    return 'MIP';
  }

  return null;
};

class TMTVComparisonService {
  /** 2026-08-31 功能说明：捕获首次鼠标、滚轮或键盘操作前的状态，避开初始化异步调窗尚未完成的时机。 */
  private captureInitialState = (event?: Event) => {
    if (!this.isComparisonProtocolActive()) return;
    const viewportService = this.servicesManager?.services?.cornerstoneViewportService;
    const viewportIds = [...VIEWPORT_IDS_BY_SIDE.baseline, ...VIEWPORT_IDS_BY_SIDE.followup];
    if (event?.type !== 'keydown' && event?.target) {
      const target = event.target as Node;
      const insideComparisonViewport = viewportIds.some(id => {
        const element = viewportService?.getCornerstoneViewport(id)?.element;
        return element === target || element?.contains?.(target);
      });
      if (!insideComparisonViewport) return;
    } else if (event?.type === 'keydown') {
      const activeViewportId =
        this.servicesManager?.services?.viewportGridService?.getState?.()?.activeViewportId;
      if (!viewportIds.includes(activeViewportId)) return;
    }
    this.captureComparisonScaleReferences();
    this.comparisonInteractionStarted = true;
    if (this.initialFitTimer) {
      clearTimeout(this.initialFitTimer);
      this.initialFitTimer = null;
    }
    for (const id of viewportIds) {
      try {
        initialState.capture(viewportService?.getCornerstoneViewport(id));
      } catch {
        // 正在加载或已销毁的视口等待下次就绪的交互。
      }
    }
  };
  private servicesManager: any = null;
  private viewportSubscription: { unsubscribe: () => void } | null = null;
  private gridSubscription: { unsubscribe: () => void } | null = null;
  private initialFitTimer: ReturnType<typeof setTimeout> | null = null;
  private initialFitAttempt = 0;
  private scaleReconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private scaleReconcileAttempt = 0;
  private comparisonScaleReferences = new Map<string, { current: number; initial: number }>();
  private fittedViewports = new WeakMap<object, string>();
  private comparisonInteractionStarted = false;
  private voiBindings = new Map<string, { element: HTMLElement; handler: EventListener }>();
  private applyingVoi = false;

  /** 2026-08-31 功能说明：批量重置期间暂停跨检查调窗回传，异常时也恢复原状态。 */
  public withVOISyncPaused<T>(callback: () => T): T {
    const previous = this.applyingVoi;
    this.applyingVoi = true;
    try {
      return callback();
    } finally {
      this.applyingVoi = previous;
    }
  }
  private listeners = new Set<TMTVComparisonListener>();
  private state: TMTVComparisonState = {
    isComparisonMode: false,
    activeSide: 'baseline',
    activeViewportId: null,
  };

  /**
   * 2026-08-31 功能说明：初始化两次检查对比状态服务，只保存 servicesManager 引用并在退出模式时释放。
   */
  public init(servicesManager: any) {
    if (this.initialFitTimer) clearTimeout(this.initialFitTimer);
    if (this.scaleReconcileTimer) clearTimeout(this.scaleReconcileTimer);
    this.initialFitTimer = null;
    this.scaleReconcileTimer = null;
    this.initialFitAttempt = 0;
    this.scaleReconcileAttempt = 0;
    this.comparisonScaleReferences.clear();
    this.fittedViewports = new WeakMap();
    this.comparisonInteractionStarted = false;
    this.viewportSubscription?.unsubscribe();
    this.viewportSubscription = null;
    this.gridSubscription?.unsubscribe();
    this.gridSubscription = null;
    this.clearVoiBindings();
    this.servicesManager = servicesManager || null;
    // 2026-09-01 功能说明：挂片协议创建视口前注册同检查相机同步器，避免回退到完整相机复制。
    servicesManager?.services?.syncGroupService?.addSynchronizerType?.(
      TMTV_SAME_STUDY_CAMERA_TYPE,
      createTMTVSameStudyCameraSynchronizer
    );
    if (typeof document !== 'undefined') {
      for (const event of ['pointerdown', 'wheel', 'keydown']) {
        document.addEventListener(event, this.captureInitialState, true);
      }
    }
    const viewportService = servicesManager?.services?.cornerstoneViewportService;
    if (viewportService?.EVENTS?.VIEWPORT_VOLUMES_CHANGED) {
      this.viewportSubscription = viewportService.subscribe(
        viewportService.EVENTS.VIEWPORT_VOLUMES_CHANGED,
        () => {
          this.applyComparisonStudySyncFromSettings();
          this.scheduleInitialViewportFit();
          this.scheduleViewportScaleReconciliation();
        }
      );
    }
    const viewportGridService = servicesManager?.services?.viewportGridService;
    if (viewportGridService?.EVENTS?.GRID_STATE_CHANGED) {
      this.gridSubscription = viewportGridService.subscribe(
        viewportGridService.EVENTS.GRID_STATE_CHANGED,
        () => this.scheduleViewportScaleReconciliation()
      );
    }
    this.scheduleInitialViewportFit();
    this.syncFromActiveViewport();
  }

  /** 2026-09-01 功能说明：合并加载/resize 事件，用户交互前仅保留一个可取消的初始 fit 任务。 */
  private scheduleInitialViewportFit(resetAttempts = true) {
    if (!this.isComparisonProtocolActive() || this.comparisonInteractionStarted) return;
    if (resetAttempts) this.initialFitAttempt = 0;
    if (this.initialFitTimer) clearTimeout(this.initialFitTimer);
    this.initialFitTimer = setTimeout(() => {
      this.initialFitTimer = null;
      if (!this.isComparisonProtocolActive() || this.comparisonInteractionStarted) return;
      try {
        fitComparisonViewports(this.servicesManager, this.fittedViewports);
      } catch (error) {
        console.warn('[TMTVComparisonService] 初始化对比视口尺寸失败', error);
      }
      this.initialFitAttempt++;
      if (this.initialFitAttempt < 8 && !this.comparisonInteractionStarted) {
        this.scheduleInitialViewportFit(false);
      }
    }, 250);
  }

  /** 2026-09-01 功能说明：进入 1x1 前保存两侧 CT 尺度，返回布局时继续作为同侧基准。 */
  private captureComparisonScaleReferences() {
    const { viewportGridService, cornerstoneViewportService } = this.servicesManager?.services || {};
    const layout = viewportGridService?.getState?.()?.layout;
    if (layout?.numRows === 1 && layout?.numCols === 1) return;
    for (const side of ['baseline', 'followup']) {
      const viewport = cornerstoneViewportService?.getCornerstoneViewport?.(`${side}CTAxial`);
      const current = viewport?.getCamera?.()?.parallelScale;
      const initial = viewport?.initialCamera?.parallelScale;
      if (Number.isFinite(current) && current > 0 && Number.isFinite(initial) && initial > 0) {
        this.comparisonScaleReferences.set(side, { current, initial });
      }
    }
  }

  /** 2026-09-01 功能说明：布局最大化/还原后有限次数复核同侧显示尺度，不持续轮询。 */
  private scheduleViewportScaleReconciliation(resetAttempts = true) {
    if (!this.isComparisonProtocolActive()) return;
    if (resetAttempts) this.scaleReconcileAttempt = 0;
    if (this.scaleReconcileTimer) clearTimeout(this.scaleReconcileTimer);
    this.scaleReconcileTimer = setTimeout(() => {
      this.scaleReconcileTimer = null;
      if (!this.isComparisonProtocolActive()) return;
      try {
        reconcileComparisonViewportScales(this.servicesManager, this.comparisonScaleReferences);
      } catch (error) {
        console.warn('[TMTVComparisonService] 布局恢复后对齐视口尺度失败', error);
      }
      this.scaleReconcileAttempt++;
      if (this.scaleReconcileAttempt < 4) {
        this.scheduleViewportScaleReconciliation(false);
      }
    }, 150);
  }

  /**
   * 2026-08-31 功能说明：释放订阅和服务引用，避免跨病例保留对比模式状态。
   */
  public reset() {
    if (this.initialFitTimer) clearTimeout(this.initialFitTimer);
    if (this.scaleReconcileTimer) clearTimeout(this.scaleReconcileTimer);
    this.initialFitTimer = null;
    this.scaleReconcileTimer = null;
    this.initialFitAttempt = 0;
    this.scaleReconcileAttempt = 0;
    this.comparisonScaleReferences.clear();
    this.fittedViewports = new WeakMap();
    this.comparisonInteractionStarted = false;
    if (typeof document !== 'undefined') {
      for (const event of ['pointerdown', 'wheel', 'keydown']) {
        document.removeEventListener(event, this.captureInitialState, true);
      }
    }
    initialState.clear();
    this.viewportSubscription?.unsubscribe();
    this.viewportSubscription = null;
    this.gridSubscription?.unsubscribe();
    this.gridSubscription = null;
    this.removeComparisonStudySync();
    this.servicesManager = null;
    this.listeners.clear();
    this.state = {
      isComparisonMode: false,
      activeSide: 'baseline',
      activeViewportId: null,
    };
  }

  public subscribe(listener: TMTVComparisonListener) {
    if (typeof listener !== 'function') {
      return { unsubscribe: () => {} };
    }

    this.listeners.add(listener);
    listener(this.getState());

    return {
      unsubscribe: () => {
        this.listeners.delete(listener);
      },
    };
  }

  public getState(): TMTVComparisonState {
    return { ...this.state };
  }

  public getActiveSide(): TMTVComparisonSide {
    return this.state.activeSide;
  }

  // 2026-08-31 功能说明：使用挂片服务的公开接口读取当前协议，避免同步开关误判为非对比模式。
  public isComparisonProtocolActive(servicesManager = this.servicesManager): boolean {
    const hangingProtocolService = servicesManager?.services?.hangingProtocolService;
    const protocol = hangingProtocolService?.getActiveProtocol?.()?.protocol;
    return protocol?.id === TMTV_COMPARE_PROTOCOL_ID;
  }

  public getSideForViewportId(viewportId?: string | null): TMTVComparisonSide | null {
    if (!viewportId) {
      return null;
    }

    if (viewportId.startsWith('baseline')) {
      return 'baseline';
    }
    if (viewportId.startsWith('followup')) {
      return 'followup';
    }

    const viewportState = this.getViewportState(viewportId);
    const side = viewportState?.viewportOptions?.customViewportProps?.tmtvComparisonSide;
    return normalizeSide(typeof side === 'string' ? side : null);
  }

  public getModalityForViewportId(viewportId?: string | null): TMTVComparisonModality | null {
    if (!viewportId) {
      return null;
    }

    const lowerViewportId = viewportId.toLowerCase();
    if (lowerViewportId.includes('fusion')) {
      return 'Fusion';
    }
    if (lowerViewportId.includes('mip')) {
      return 'MIP';
    }
    if (lowerViewportId.includes('pt')) {
      return 'PT';
    }
    if (lowerViewportId.includes('ct')) {
      return 'CT';
    }

    const viewportState = this.getViewportState(viewportId);
    const modality = viewportState?.viewportOptions?.customViewportProps?.tmtvComparisonModality;
    return normalizeModality(typeof modality === 'string' ? modality : null);
  }

  public isComparisonStudySyncEnabled(servicesManager = this.servicesManager): boolean {
    const customizationService = servicesManager?.services?.customizationService;
    const syncSettings = customizationService?.getCustomization?.('syncSettings');
    return syncSettings?.comparisonStudySync === true;
  }

  /**
   * 2026-08-31 功能说明：保存并应用两次检查之间的同模态同步开关。
   */
  public setComparisonStudySyncEnabled(
    enabled: boolean,
    servicesManager = this.servicesManager,
    includeVoi?: boolean
  ) {
    if (servicesManager) {
      this.servicesManager = servicesManager;
    }
    this.captureInitialState();

    const customizationService = servicesManager?.services?.customizationService;
    const syncSettings = customizationService?.getCustomization?.('syncSettings') || {};
    const nextSettings = {
      orientationSync: syncSettings.orientationSync !== false,
      voiSync: syncSettings.voiSync !== false,
      zoomSync: syncSettings.zoomSync === true,
      ...syncSettings,
      comparisonStudySync: enabled,
    };

    try {
      customizationService?.setCustomizations?.({
        syncSettings: nextSettings,
      });
    } catch (e) {
      console.warn('[TMTVComparisonService] 保存两次检查同步状态失败', e);
    }

    if (enabled) {
      this.ensureComparisonStudySync(
        servicesManager,
        typeof includeVoi === 'boolean' ? includeVoi : nextSettings.voiSync !== false
      );
    } else {
      this.removeComparisonStudySync(servicesManager);
    }

    applyTMTVZoomSync(servicesManager, this.isComparisonProtocolActive(servicesManager));
    this.notify();
  }

  /**
   * 2026-08-31 功能说明：按当前同步配置恢复或清理对比模式跨检查同步组。
   */
  public applyComparisonStudySyncFromSettings(servicesManager = this.servicesManager) {
    if (servicesManager) {
      this.servicesManager = servicesManager;
    }

    const customizationService = servicesManager?.services?.customizationService;
    const syncSettings = customizationService?.getCustomization?.('syncSettings') || {};
    const compareOn =
      this.isComparisonProtocolActive(servicesManager) && syncSettings.comparisonStudySync === true;

    applyTMTVZoomSync(servicesManager, this.isComparisonProtocolActive(servicesManager));

    if (compareOn) {
      this.ensureComparisonStudySync(servicesManager, syncSettings.voiSync !== false);
    } else {
      this.removeComparisonStudySync(servicesManager);
    }

    this.notify();
  }

  /**
   * 2026-08-31 功能说明：移除对比模式跨首次/随访检查同步组，避免切布局后残留同步器。
   */
  public removeComparisonStudySync(servicesManager = this.servicesManager) {
    this.clearVoiBindings();
    const { syncGroupService, cornerstoneViewportService } = servicesManager?.services || {};
    if (!syncGroupService || !cornerstoneViewportService) {
      return;
    }

    COMPARISON_VIEWPORT_PAIRS.forEach(({ viewportIds }) => {
      viewportIds.forEach(viewportId => {
        try {
          const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);
          if (!viewport) {
            return;
          }

          const renderingEngineId =
            viewport.getRenderingEngine?.()?.id || viewport.renderingEngineId;
          if (!renderingEngineId) {
            return;
          }

          COMPARISON_SYNC_IDS.forEach(syncId => {
            try {
              syncGroupService.removeViewportFromSyncGroup(viewportId, renderingEngineId, syncId);
            } catch {
              // ignore missing synchronizer
            }
          });
        } catch {
          // ignore invalid viewport
        }
      });
    });
  }

  /**
   * 2026-08-31 功能说明：按同模态成对建立首次/随访检查的相机和窗位同步。
   */
  public ensureComparisonStudySync(servicesManager = this.servicesManager, includeVoi = true) {
    const { syncGroupService, cornerstoneViewportService } = servicesManager?.services || {};
    if (!syncGroupService || !cornerstoneViewportService) {
      return;
    }

    if (!this.isComparisonProtocolActive(servicesManager)) {
      this.removeComparisonStudySync(servicesManager);
      return;
    }
    syncGroupService.addSynchronizerType?.(
      COMPARISON_CAMERA_TYPE,
      createComparisonCameraSynchronizer
    );

    if (!includeVoi) {
      this.clearVoiBindings();
    }

    // 2026-08-31 功能说明：视口被移除或替换后立即解绑旧 DOM，避免等待退出模式才回收。
    this.voiBindings.forEach((binding, viewportId) => {
      let element: HTMLElement | undefined;
      try {
        element = cornerstoneViewportService.getCornerstoneViewport(viewportId)?.element;
      } catch {
        // 已销毁视口按缺失处理。
      }
      if (element !== binding.element) {
        binding.element.removeEventListener(Enums.Events.VOI_MODIFIED, binding.handler);
        this.voiBindings.delete(viewportId);
      }
    });

    COMPARISON_VIEWPORT_PAIRS.forEach(({ modality, viewportIds }) => {
      viewportIds.forEach(viewportId => {
        try {
          const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);
          if (!viewport) {
            return;
          }

          const renderingEngineId =
            viewport.getRenderingEngine?.()?.id || viewport.renderingEngineId;
          if (!renderingEngineId) {
            return;
          }

          const syncGroups: any[] = [
            {
              type: COMPARISON_CAMERA_TYPE,
              id: `tmtvCompareCamera${modality}`,
              source: true,
              target: true,
            },
          ];

          syncGroupService.addViewportToSyncGroup(viewportId, renderingEngineId, syncGroups);
          if (includeVoi && viewport.element) {
            this.bindComparisonVoi(viewportId, viewport.element);
          }
        } catch {
          // ignore invalid viewport while layouts are still hydrating
        }
      });
    });
  }

  /** 2026-08-31 功能说明：幂等绑定调窗事件，并用原始 element 和 handler 释放旧视口监听。 */
  private bindComparisonVoi(viewportId: string, element: HTMLElement) {
    const previous = this.voiBindings.get(viewportId);
    if (previous?.element === element) {
      return;
    }
    previous?.element.removeEventListener(Enums.Events.VOI_MODIFIED, previous.handler);
    const handler: EventListener = event => this.syncComparisonVoi(viewportId, event);
    element.addEventListener(Enums.Events.VOI_MODIFIED, handler);
    this.voiBindings.set(viewportId, { element, handler });
  }

  /** 2026-08-31 功能说明：关闭同步或退出模式时清理调窗监听，不保留 DOM 和视口引用。 */
  private clearVoiBindings() {
    this.voiBindings.forEach(({ element, handler }) => {
      element.removeEventListener(Enums.Events.VOI_MODIFIED, handler);
    });
    this.voiBindings.clear();
  }

  /** 2026-08-31 功能说明：按模态映射目标检查的 Volume，同步窗宽窗位并保留 PET/融合的配色与反色。 */
  private syncComparisonVoi(sourceViewportId: string, event: Event) {
    if (
      this.applyingVoi ||
      !this.isComparisonProtocolActive() ||
      !this.isComparisonStudySyncEnabled()
    ) {
      return;
    }
    const settings =
      this.servicesManager?.services?.customizationService?.getCustomization?.('syncSettings');
    if (settings?.voiSync === false) return;
    const { range, volumeId } = (event as CustomEvent).detail || {};
    if (
      !range ||
      !Number.isFinite(range.lower) ||
      !Number.isFinite(range.upper) ||
      range.upper <= range.lower
    ) {
      return;
    }
    const sourceSide = this.getSideForViewportId(sourceViewportId);
    if (!sourceSide || !volumeId) return;
    const modality = cache.getVolume(volumeId)?.metadata?.Modality;
    if (modality !== 'CT' && modality !== 'PT') return;
    const viewportService = this.servicesManager?.services?.cornerstoneViewportService;
    const targetSide = sourceSide === 'baseline' ? 'followup' : 'baseline';

    this.applyingVoi = true;
    try {
      for (const viewportId of VIEWPORT_IDS_BY_SIDE[targetSide]) {
        try {
          const viewport = viewportService?.getCornerstoneViewport(viewportId);
          const actors = viewport?.getActors?.() || [];
          const targetActor = actors.find(actor => {
            const id = actor.referencedId || actor.uid;
            return id && cache.getVolume(id)?.metadata?.Modality === modality;
          });
          if (!targetActor) continue;
          const targetVolumeId = targetActor.referencedId || targetActor.uid;
          const currentRange = viewport.getProperties?.(targetVolumeId)?.voiRange;
          if (currentRange?.lower === range.lower && currentRange?.upper === range.upper) continue;
          // 保留 VOI 事件以刷新窗位数值与同侧同步，由 applyingVoi 阻止跨检查回传。
          viewport.setProperties({ voiRange: { ...range } }, targetVolumeId, false);
          viewport.render();
        } catch {
          // 布局切换时某个目标可能已销毁，不阻断其余视口。
        }
      }
    } finally {
      this.applyingVoi = false;
    }
  }

  /**
   * 2026-08-31 功能说明：根据当前 active viewport 推导正在操作的 Baseline/Follow-up 侧。
   */
  public syncFromActiveViewport(servicesManager = this.servicesManager) {
    if (servicesManager) {
      this.servicesManager = servicesManager;
    }

    const viewportGridService = servicesManager?.services?.viewportGridService;
    const activeViewportId =
      viewportGridService?.getActiveViewportId?.() ||
      viewportGridService?.getState?.()?.activeViewportId ||
      null;

    this.syncFromViewport(activeViewportId, servicesManager);
  }

  /**
   * 2026-08-31 功能说明：响应 active viewport 或布局变化，刷新对比模式和活动检查侧。
   */
  public syncFromViewport(viewportId?: string | null, servicesManager = this.servicesManager) {
    if (servicesManager) {
      this.servicesManager = servicesManager;
    }

    const side = this.getSideForViewportId(viewportId);
    const isComparisonMode = this.isComparisonProtocolActive(servicesManager) || !!side;
    const nextState: TMTVComparisonState = {
      isComparisonMode,
      activeSide: side || this.state.activeSide,
      activeViewportId: viewportId || null,
    };

    this.setState(nextState);
  }

  /**
   * 2026-08-31 功能说明：工具栏切换 Baseline/Follow-up 时，将 active viewport 切到同侧真实视口。
   */
  public setActiveSide(side: TMTVComparisonSide, options: { activateViewport?: boolean } = {}) {
    const nextSide = normalizeSide(side);
    if (!nextSide) {
      return;
    }

    const currentModality = this.getModalityForViewportId(this.state.activeViewportId);
    const targetViewportId = options.activateViewport
      ? this.getPreferredViewportIdForSide(nextSide, currentModality)
      : null;

    if (targetViewportId) {
      try {
        this.servicesManager?.services?.viewportGridService?.setActiveViewportId?.(
          targetViewportId
        );
      } catch (e) {
        console.warn('[TMTVComparisonService] 切换活动对比视口失败', e);
      }
    }

    this.setState({
      isComparisonMode: this.isComparisonProtocolActive() || this.state.isComparisonMode,
      activeSide: nextSide,
      activeViewportId: targetViewportId || this.state.activeViewportId,
    });

    const activeViewportId = targetViewportId || this.state.activeViewportId;
    if (activeViewportId) {
      try {
        this.servicesManager?.services?.toolbarService?.refreshToolbarState?.({
          viewportId: activeViewportId,
        });
      } catch (e) {
        console.warn('[TMTVComparisonService] 刷新工具栏状态失败', e);
      }
    }
  }

  private getViewportState(viewportId: string) {
    try {
      return this.servicesManager?.services?.viewportGridService?.getViewportState?.(viewportId);
    } catch {
      return null;
    }
  }

  private getPreferredViewportIdForSide(
    side: TMTVComparisonSide,
    preferredModality?: TMTVComparisonModality | null
  ): string | null {
    const viewportGridService = this.servicesManager?.services?.viewportGridService;
    const state = viewportGridService?.getState?.();
    const viewports = state?.viewports;
    const candidates = VIEWPORT_IDS_BY_SIDE[side] || [];

    if (!viewports || typeof viewports.has !== 'function') {
      return null;
    }

    const preferredViewportId = preferredModality
      ? VIEWPORT_IDS_BY_SIDE_AND_MODALITY[side]?.[preferredModality]
      : null;

    if (preferredViewportId && viewports.has(preferredViewportId)) {
      return preferredViewportId;
    }

    return candidates.find(viewportId => viewports.has(viewportId)) || null;
  }

  private setState(nextState: TMTVComparisonState) {
    const previous = this.state;
    const changed =
      previous.isComparisonMode !== nextState.isComparisonMode ||
      previous.activeSide !== nextState.activeSide ||
      previous.activeViewportId !== nextState.activeViewportId;

    if (!changed) {
      return;
    }

    this.state = nextState;
    this.notify();
  }

  private notify() {
    const snapshot = this.getState();
    this.listeners.forEach(listener => {
      try {
        listener(snapshot);
      } catch (e) {
        console.warn('[TMTVComparisonService] 通知对比状态监听器失败', e);
      }
    });
  }
}

export { TMTV_COMPARE_PROTOCOL_ID, VIEWPORT_IDS_BY_SIDE, COMPARISON_SYNC_IDS };
export default new TMTVComparisonService();
