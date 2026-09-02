import comparisonService, {
  type TMTVComparisonSide,
} from './TMTVComparisonService';

export type TMTVSessionSide = 'single' | TMTVComparisonSide;

export type TMTVSessionTotals = {
  tmtv: number;
  tlg: number | null;
};

export type TMTVSession = {
  sessionId: string;
  side: TMTVSessionSide;
  studyInstanceUID: string | null;
  segmentationIds: string[];
  activeSegmentationId: string | null;
  totals: TMTVSessionTotals;
  revision: number;
  updatedAt: number;
};

type Subscription = { unsubscribe: () => void };
type SessionListener = (session: TMTVSession | null) => void;

const EMPTY_TOTALS: TMTVSessionTotals = { tmtv: 0, tlg: null };

const cloneSession = (session?: TMTVSession): TMTVSession | null =>
  session
    ? {
        ...session,
        segmentationIds: [...session.segmentationIds],
        totals: { ...session.totals },
      }
    : null;

/** 2026-09-01 功能说明：管理单检查或 Baseline/Follow-up 轻量 Session，不持有影像及体素大对象。 */
class TMTVSessionService {
  private servicesManager: any = null;
  private sessions = new Map<TMTVSessionSide, TMTVSession>();
  private listeners = new Set<SessionListener>();
  private comparisonSubscription: Subscription | null = null;
  private activeSide: TMTVSessionSide = 'single';
  private isComparisonMode = false;
  private generation = 0;

  /** 2026-09-02 功能说明：进入模式时仅绑定轻量对比状态，避免 Session 读取介入 Volume 加载事件。 */
  public init(servicesManager: any): void {
    this.reset();
    this.servicesManager = servicesManager || null;
    const generation = this.generation;

    this.comparisonSubscription = comparisonService.subscribe(state => {
      if (generation !== this.generation || !this.servicesManager) return;
      this.syncComparisonState(state);
    });

    this.syncComparisonState(comparisonService.getState());
  }

  public subscribe(listener: SessionListener): Subscription {
    if (typeof listener !== 'function') return { unsubscribe: () => {} };
    this.listeners.add(listener);
    listener(this.getActiveSession());
    return {
      unsubscribe: () => this.listeners.delete(listener),
    };
  }

  public getActiveSide(): TMTVSessionSide {
    return this.activeSide;
  }

  public getActiveSession(): TMTVSession | null {
    return this.getSession(this.activeSide);
  }

  public getSession(side: TMTVSessionSide): TMTVSession | null {
    return cloneSession(this.sessions.get(side));
  }

  public getSessions(): TMTVSession[] {
    return [...this.sessions.values()].map(session => cloneSession(session) as TMTVSession);
  }

  /** 2026-09-01 功能说明：仅登记当前 Session 的分割 ID，去重并拒绝空值，不缓存分割对象。 */
  public setSegmentationIds(
    side: TMTVSessionSide,
    segmentationIds: string[],
    activeSegmentationId?: string | null
  ): TMTVSession | null {
    const session = this.sessions.get(side);
    if (!session) return null;
    const ids = [...new Set((segmentationIds || []).filter(id => typeof id === 'string' && id))];
    const activeId =
      activeSegmentationId && ids.includes(activeSegmentationId)
        ? activeSegmentationId
        : ids[0] || null;

    if (
      session.activeSegmentationId === activeId &&
      session.segmentationIds.length === ids.length &&
      session.segmentationIds.every((id, index) => id === ids[index])
    ) {
      return cloneSession(session);
    }

    const next = this.updateSession(session, {
      segmentationIds: ids,
      activeSegmentationId: activeId,
    });
    this.sessions.set(side, next);
    this.notify();
    return cloneSession(next);
  }

  /** 2026-09-01 功能说明：保存 Session 级汇总摘要，非有限值不会进入后续临床统计链路。 */
  public setTotals(side: TMTVSessionSide, totals: TMTVSessionTotals): TMTVSession | null {
    const session = this.sessions.get(side);
    if (!session || !Number.isFinite(totals?.tmtv) || totals.tmtv < 0) return null;
    if (totals.tlg !== null && (!Number.isFinite(totals.tlg) || totals.tlg < 0)) return null;
    if (session.totals.tmtv === totals.tmtv && session.totals.tlg === totals.tlg) {
      return cloneSession(session);
    }

    const next = this.updateSession(session, { totals: { ...totals } });
    this.sessions.set(side, next);
    this.notify();
    return cloneSession(next);
  }

  /** 2026-09-01 功能说明：退出模式时幂等取消订阅并断开服务引用，阻止旧回调写入新病例。 */
  public reset(): void {
    this.generation++;
    this.releaseRuntimeResources();
    this.servicesManager = null;
    this.sessions.clear();
    this.listeners.clear();
    this.activeSide = 'single';
    this.isComparisonMode = false;
  }

  private syncComparisonState(state: {
    isComparisonMode?: boolean;
    activeSide?: TMTVComparisonSide;
  }): void {
    const comparisonActive =
      state?.isComparisonMode === true ||
      comparisonService.isComparisonProtocolActive(this.servicesManager);
    const nextActiveSide: TMTVSessionSide = comparisonActive
      ? state?.activeSide || 'baseline'
      : 'single';
    const modeChanged = this.isComparisonMode !== comparisonActive;
    const sideChanged = this.activeSide !== nextActiveSide;

    this.isComparisonMode = comparisonActive;
    this.activeSide = nextActiveSide;
    if (comparisonActive) {
      this.sessions.delete('single');
      this.ensureSession('baseline');
      this.ensureSession('followup');
    } else {
      this.sessions.delete('baseline');
      this.sessions.delete('followup');
      this.ensureSession('single');
    }

    const ownershipChanged = this.refreshStudyOwnership(false);
    if (modeChanged || sideChanged || ownershipChanged) this.notify();
  }

  /** 2026-09-02 功能说明：从路由参数解析检查归属，避免读取尚未完成创建的影像视口。 */
  private refreshStudyOwnership(notify = true): boolean {
    let changed = false;
    const sides: TMTVSessionSide[] = this.isComparisonMode ? ['baseline', 'followup'] : ['single'];

    sides.forEach(side => {
      const studyInstanceUID = this.getStudyUIDForSide(side);
      if (!studyInstanceUID) return;
      const session = this.ensureSession(side);
      if (session.studyInstanceUID === studyInstanceUID) return;

      this.sessions.set(
        side,
        this.createSession(
          side,
          studyInstanceUID,
          session.studyInstanceUID ? session.revision + 1 : 0
        )
      );
      changed = true;
    });

    if (changed && notify) this.notify();
    return changed;
  }

  private getStudyUIDForSide(side: TMTVSessionSide): string | null {
    if (typeof window === 'undefined') return null;

    const query = new URLSearchParams(window.location.search);
    const studyUIDs = (query.get('StudyInstanceUIDs') || '')
      .split(',')
      .map(uid => uid.trim())
      .filter(Boolean);
    const value =
      side === 'baseline'
        ? query.get('tmtvbaselinestudyinstanceuid') || studyUIDs[0]
        : side === 'followup'
          ? query.get('tmtvfollowupstudyinstanceuid') || studyUIDs[1]
          : studyUIDs[0];

    return value?.trim() || null;
  }

  private ensureSession(side: TMTVSessionSide): TMTVSession {
    const existing = this.sessions.get(side);
    if (existing) return existing;
    const session = this.createSession(side, null, 0);
    this.sessions.set(side, session);
    return session;
  }

  private createSession(
    side: TMTVSessionSide,
    studyInstanceUID: string | null,
    revision: number
  ): TMTVSession {
    return {
      sessionId: `tmtv:${side}:${studyInstanceUID || 'pending'}`,
      side,
      studyInstanceUID,
      segmentationIds: [],
      activeSegmentationId: null,
      totals: { ...EMPTY_TOTALS },
      revision,
      updatedAt: Date.now(),
    };
  }

  private updateSession(session: TMTVSession, patch: Partial<TMTVSession>): TMTVSession {
    return {
      ...session,
      ...patch,
      revision: session.revision + 1,
      updatedAt: Date.now(),
    };
  }

  private releaseRuntimeResources(): void {
    this.comparisonSubscription?.unsubscribe();
    this.comparisonSubscription = null;
  }

  private notify(): void {
    const activeSession = this.getActiveSession();
    this.listeners.forEach(listener => {
      try {
        listener(activeSession);
      } catch (error) {
        console.warn('[TMTVSessionService] 通知 Session 状态失败', error);
      }
    });
  }
}

export default new TMTVSessionService();
