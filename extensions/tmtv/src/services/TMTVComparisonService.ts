export type TMTVComparisonSide = 'baseline' | 'followup';

type TMTVComparisonState = {
  isComparisonMode: boolean;
  activeSide: TMTVComparisonSide;
  activeViewportId: string | null;
};

type TMTVComparisonListener = (state: TMTVComparisonState) => void;

const TMTV_COMPARE_PROTOCOL_ID = '@ohif/extension-tmtv.hangingProtocolModule.ptCTCompare';

const VIEWPORT_IDS_BY_SIDE: Record<TMTVComparisonSide, string[]> = {
  baseline: ['baselineCTAxial', 'baselinePTAxial', 'baselineFusionAxial', 'baselineMIPSagittal'],
  followup: ['followupCTAxial', 'followupPTAxial', 'followupFusionAxial', 'followupMIPSagittal'],
};

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

class TMTVComparisonService {
  private servicesManager: any = null;
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
    this.servicesManager = servicesManager || null;
    this.syncFromActiveViewport();
  }

  /**
   * 2026-08-31 功能说明：释放订阅和服务引用，避免跨病例保留对比模式状态。
   */
  public reset() {
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

  public isComparisonProtocolActive(servicesManager = this.servicesManager): boolean {
    const hangingProtocolService = servicesManager?.services?.hangingProtocolService;
    const protocol = hangingProtocolService?.getProtocol?.();
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

    const targetViewportId = options.activateViewport
      ? this.getPreferredViewportIdForSide(nextSide)
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

  private getPreferredViewportIdForSide(side: TMTVComparisonSide): string | null {
    const viewportGridService = this.servicesManager?.services?.viewportGridService;
    const state = viewportGridService?.getState?.();
    const viewports = state?.viewports;
    const candidates = VIEWPORT_IDS_BY_SIDE[side] || [];

    if (!viewports || typeof viewports.has !== 'function') {
      return null;
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

export { TMTV_COMPARE_PROTOCOL_ID, VIEWPORT_IDS_BY_SIDE };
export default new TMTVComparisonService();
