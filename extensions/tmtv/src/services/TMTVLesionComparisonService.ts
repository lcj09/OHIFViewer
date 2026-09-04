import type { TMTVLesion, TMTVLesionState } from './TMTVLesionService';
import type { TMTVSession, TMTVSessionSide } from './TMTVSessionService';

export const DEFAULT_LESION_MATCH_DISTANCE_MM = 50;

export type TMTVLesionMatchStatus = 'persistent' | 'new' | 'resolved' | 'unmatched';

export type TMTVLesionMatch = {
  matchId: string;
  baselineLesionId?: string;
  followupLesionId?: string;
  status: TMTVLesionMatchStatus;
  source: 'auto';
  distanceMM?: number;
  confidence?: number;
  reason: 'nearest' | 'no-candidate' | 'conflict' | 'invalid-centroid';
};

export type TMTVLesionComparisonResult = {
  comparisonId: string;
  baselineSessionId: string;
  followupSessionId: string;
  baselineStateUpdatedAt: number;
  followupStateUpdatedAt: number;
  maxDistanceMM: number;
  matches: TMTVLesionMatch[];
  counts: Record<TMTVLesionMatchStatus, number>;
  updatedAt: number;
};

type Subscription = { unsubscribe: () => void };
type ComparisonListener = (result: TMTVLesionComparisonResult | null) => void;
type LesionServiceLike = {
  subscribe: (listener: () => void) => Subscription;
  getState: (segmentationIds?: string[], sessionId?: string) => TMTVLesionState;
};
type SessionServiceLike = {
  subscribe: (listener: (session: TMTVSession | null) => void) => Subscription;
  getSession: (side: TMTVSessionSide) => TMTVSession | null;
};
type NearestCandidate = {
  lesion: TMTVLesion;
  distanceMM: number;
  ambiguous: boolean;
};

const DISTANCE_EPSILON = 1e-6;

function isValidCentroid(centroid: unknown): centroid is [number, number, number] {
  return (
    Array.isArray(centroid) &&
    centroid.length === 3 &&
    centroid.every(value => typeof value === 'number' && Number.isFinite(value))
  );
}

function getConfirmedLesions(lesions: TMTVLesion[] = []): TMTVLesion[] {
  const uniqueLesions = new Map<string, TMTVLesion>();
  (lesions || []).forEach(lesion => {
    if (lesion?.status === 'confirmed' && lesion.id && !uniqueLesions.has(lesion.id)) {
      uniqueLesions.set(lesion.id, lesion);
    }
  });
  return [...uniqueLesions.values()].sort(compareLesions);
}

function compareLesions(first: TMTVLesion, second: TMTVLesion): number {
  const displayIndexDifference = (first.displayIndex ?? 0) - (second.displayIndex ?? 0);
  return displayIndexDifference || first.id.localeCompare(second.id);
}

function getDistanceMM(first: [number, number, number], second: [number, number, number]): number {
  return Math.hypot(first[0] - second[0], first[1] - second[1], first[2] - second[2]);
}

function getCellKey(centroid: [number, number, number], cellSize: number): string {
  return centroid.map(value => Math.floor(value / cellSize)).join(',');
}

function updateNearestCandidate(
  candidates: Map<string, NearestCandidate>,
  lesionId: string,
  candidateLesion: TMTVLesion,
  distanceMM: number
): void {
  const current = candidates.get(lesionId);
  if (!current || distanceMM < current.distanceMM - DISTANCE_EPSILON) {
    candidates.set(lesionId, { lesion: candidateLesion, distanceMM, ambiguous: false });
    return;
  }

  if (Math.abs(distanceMM - current.distanceMM) <= DISTANCE_EPSILON) {
    const preferredLesion =
      candidateLesion.id.localeCompare(current.lesion.id) < 0 ? candidateLesion : current.lesion;
    candidates.set(lesionId, {
      lesion: preferredLesion,
      distanceMM: current.distanceMM,
      ambiguous: true,
    });
  }
}

function createMatch(
  status: TMTVLesionMatchStatus,
  baselineLesion?: TMTVLesion,
  followupLesion?: TMTVLesion,
  distanceMM?: number,
  reason: TMTVLesionMatch['reason'] = 'no-candidate',
  maxDistanceMM = DEFAULT_LESION_MATCH_DISTANCE_MM
): TMTVLesionMatch {
  const baselineLesionId = baselineLesion?.id;
  const followupLesionId = followupLesion?.id;
  const baselineMatchKey = baselineLesionId ? encodeURIComponent(baselineLesionId) : '-';
  const followupMatchKey = followupLesionId ? encodeURIComponent(followupLesionId) : '-';
  const hasDistance = typeof distanceMM === 'number' && Number.isFinite(distanceMM);

  return {
    matchId: `auto:${status}:${baselineMatchKey}:${followupMatchKey}`,
    baselineLesionId,
    followupLesionId,
    status,
    source: 'auto',
    distanceMM: hasDistance ? distanceMM : undefined,
    confidence: hasDistance ? Math.max(0, 1 - distanceMM / maxDistanceMM) : undefined,
    reason,
  };
}

/** 2026-09-03 功能说明：使用空间网格和相互最近规则生成 confirmed lesion 一对一候选匹配。 */
export function matchTMTVLesionsByCentroid(
  baselineLesions: TMTVLesion[] = [],
  followupLesions: TMTVLesion[] = [],
  maxDistanceMM = DEFAULT_LESION_MATCH_DISTANCE_MM
): TMTVLesionMatch[] {
  const distanceThreshold =
    Number.isFinite(maxDistanceMM) && maxDistanceMM > 0
      ? maxDistanceMM
      : DEFAULT_LESION_MATCH_DISTANCE_MM;
  const baselineConfirmed = getConfirmedLesions(baselineLesions);
  const followupConfirmed = getConfirmedLesions(followupLesions);
  const validBaseline = baselineConfirmed.filter(lesion => isValidCentroid(lesion.centroid));
  const validFollowup = followupConfirmed.filter(lesion => isValidCentroid(lesion.centroid));
  const invalidBaseline = baselineConfirmed.filter(lesion => !isValidCentroid(lesion.centroid));
  const invalidFollowup = followupConfirmed.filter(lesion => !isValidCentroid(lesion.centroid));
  const followupGrid = new Map<string, TMTVLesion[]>();

  validFollowup.forEach(lesion => {
    const cellKey = getCellKey(lesion.centroid, distanceThreshold);
    const cell = followupGrid.get(cellKey) || [];
    cell.push(lesion);
    followupGrid.set(cellKey, cell);
  });

  const nearestFollowupByBaseline = new Map<string, NearestCandidate>();
  const nearestBaselineByFollowup = new Map<string, NearestCandidate>();
  const baselineWithCandidate = new Set<string>();
  const followupWithCandidate = new Set<string>();

  validBaseline.forEach(baselineLesion => {
    const [cellX, cellY, cellZ] = baselineLesion.centroid.map(value =>
      Math.floor(value / distanceThreshold)
    );

    for (let offsetX = -1; offsetX <= 1; offsetX++) {
      for (let offsetY = -1; offsetY <= 1; offsetY++) {
        for (let offsetZ = -1; offsetZ <= 1; offsetZ++) {
          const cell = followupGrid.get(`${cellX + offsetX},${cellY + offsetY},${cellZ + offsetZ}`);
          if (!cell) continue;

          cell.forEach(followupLesion => {
            const distanceMM = getDistanceMM(baselineLesion.centroid, followupLesion.centroid);
            if (distanceMM > distanceThreshold) return;

            baselineWithCandidate.add(baselineLesion.id);
            followupWithCandidate.add(followupLesion.id);
            updateNearestCandidate(
              nearestFollowupByBaseline,
              baselineLesion.id,
              followupLesion,
              distanceMM
            );
            updateNearestCandidate(
              nearestBaselineByFollowup,
              followupLesion.id,
              baselineLesion,
              distanceMM
            );
          });
        }
      }
    }
  });

  const matches: TMTVLesionMatch[] = [];
  const matchedBaselineIds = new Set<string>();
  const matchedFollowupIds = new Set<string>();

  validBaseline.forEach(baselineLesion => {
    const nearestFollowup = nearestFollowupByBaseline.get(baselineLesion.id);
    if (!nearestFollowup || nearestFollowup.ambiguous) return;
    const nearestBaseline = nearestBaselineByFollowup.get(nearestFollowup.lesion.id);
    if (
      !nearestBaseline ||
      nearestBaseline.ambiguous ||
      nearestBaseline.lesion.id !== baselineLesion.id
    ) {
      return;
    }

    matchedBaselineIds.add(baselineLesion.id);
    matchedFollowupIds.add(nearestFollowup.lesion.id);
    matches.push(
      createMatch(
        'persistent',
        baselineLesion,
        nearestFollowup.lesion,
        nearestFollowup.distanceMM,
        'nearest',
        distanceThreshold
      )
    );
  });

  validBaseline.forEach(lesion => {
    if (matchedBaselineIds.has(lesion.id)) return;
    const hasCandidate = baselineWithCandidate.has(lesion.id);
    matches.push(
      createMatch(
        hasCandidate ? 'unmatched' : 'resolved',
        lesion,
        undefined,
        undefined,
        hasCandidate ? 'conflict' : 'no-candidate'
      )
    );
  });
  invalidBaseline.forEach(lesion =>
    matches.push(createMatch('unmatched', lesion, undefined, undefined, 'invalid-centroid'))
  );
  validFollowup.forEach(lesion => {
    if (matchedFollowupIds.has(lesion.id)) return;
    const hasCandidate = followupWithCandidate.has(lesion.id);
    matches.push(
      createMatch(
        hasCandidate ? 'unmatched' : 'new',
        undefined,
        lesion,
        undefined,
        hasCandidate ? 'conflict' : 'no-candidate'
      )
    );
  });
  invalidFollowup.forEach(lesion =>
    matches.push(createMatch('unmatched', undefined, lesion, undefined, 'invalid-centroid'))
  );

  return matches;
}

function cloneResult(result: TMTVLesionComparisonResult | null): TMTVLesionComparisonResult | null {
  return result
    ? {
        ...result,
        matches: result.matches.map(match => ({ ...match })),
        counts: { ...result.counts },
      }
    : null;
}

function getLesionStateSignature(state: TMTVLesionState): string {
  const lesions = (state.lesions || [])
    .map(lesion => `${lesion.id}:${lesion.status}:${lesion.centroid?.join(',') || 'invalid'}`)
    .sort()
    .join('|');
  return `${state.sessionId || ''}:${state.updatedAt}:${lesions}`;
}

/** 2026-09-03 功能说明：由双侧轻量病灶状态构造统一匹配快照，供服务通知和面板兜底共用。 */
export function createTMTVLesionComparisonResult(
  baselineSession: Pick<TMTVSession, 'sessionId'>,
  followupSession: Pick<TMTVSession, 'sessionId'>,
  baselineState: TMTVLesionState,
  followupState: TMTVLesionState,
  maxDistanceMM = DEFAULT_LESION_MATCH_DISTANCE_MM
): TMTVLesionComparisonResult | null {
  if (
    !baselineSession?.sessionId ||
    !followupSession?.sessionId ||
    !baselineState?.updatedAt ||
    !followupState?.updatedAt
  ) {
    return null;
  }

  const distanceThreshold =
    Number.isFinite(maxDistanceMM) && maxDistanceMM > 0
      ? maxDistanceMM
      : DEFAULT_LESION_MATCH_DISTANCE_MM;
  const matches = matchTMTVLesionsByCentroid(
    baselineState.lesions,
    followupState.lesions,
    distanceThreshold
  );
  const counts = matches.reduce<Record<TMTVLesionMatchStatus, number>>(
    (result, match) => {
      result[match.status] += 1;
      return result;
    },
    { persistent: 0, new: 0, resolved: 0, unmatched: 0 }
  );

  return {
    comparisonId: `${baselineSession.sessionId}::${followupSession.sessionId}`,
    baselineSessionId: baselineSession.sessionId,
    followupSessionId: followupSession.sessionId,
    baselineStateUpdatedAt: baselineState.updatedAt,
    followupStateUpdatedAt: followupState.updatedAt,
    maxDistanceMM: distanceThreshold,
    matches,
    counts,
    updatedAt: Date.now(),
  };
}

/** 2026-09-03 功能说明：维护轻量自动匹配结果，并随双 Session lesion 状态变化自动重算。 */
export class TMTVLesionComparisonService {
  private lesionService: LesionServiceLike | null = null;
  private sessionService: SessionServiceLike | null = null;
  private lesionSubscription: Subscription | null = null;
  private sessionSubscription: Subscription | null = null;
  private listeners = new Set<ComparisonListener>();
  private result: TMTVLesionComparisonResult | null = null;
  private inputSignature = '';
  private maxDistanceMM = DEFAULT_LESION_MATCH_DISTANCE_MM;

  /** 2026-09-03 功能说明：面板按需补齐匹配服务初始化，已绑定相同依赖时不重复订阅。 */
  public ensureInitialized({
    lesionService,
    sessionService,
    maxDistanceMM = DEFAULT_LESION_MATCH_DISTANCE_MM,
  }: {
    lesionService: LesionServiceLike;
    sessionService: SessionServiceLike;
    maxDistanceMM?: number;
  }): boolean {
    if (
      this.lesionService === lesionService &&
      this.sessionService === sessionService &&
      this.lesionSubscription &&
      this.sessionSubscription
    ) {
      this.recalculate();
      return false;
    }

    this.init({ lesionService, sessionService, maxDistanceMM });
    return !!this.lesionService && !!this.sessionService;
  }

  public init({
    lesionService,
    sessionService,
    maxDistanceMM = DEFAULT_LESION_MATCH_DISTANCE_MM,
  }: {
    lesionService: LesionServiceLike;
    sessionService: SessionServiceLike;
    maxDistanceMM?: number;
  }): void {
    this.destroy();
    if (
      !lesionService?.subscribe ||
      !lesionService?.getState ||
      !sessionService?.subscribe ||
      !sessionService?.getSession
    ) {
      return;
    }
    this.lesionService = lesionService;
    this.sessionService = sessionService;
    this.maxDistanceMM =
      Number.isFinite(maxDistanceMM) && maxDistanceMM > 0
        ? maxDistanceMM
        : DEFAULT_LESION_MATCH_DISTANCE_MM;
    this.sessionSubscription = sessionService.subscribe(() => this.recalculate());
    this.lesionSubscription = lesionService.subscribe(() => this.recalculate());
    this.recalculate();
  }

  public subscribe(listener: ComparisonListener): Subscription {
    if (typeof listener !== 'function') return { unsubscribe: () => {} };
    this.listeners.add(listener);
    listener(this.getResult());
    return { unsubscribe: () => this.listeners.delete(listener) };
  }

  public getResult(): TMTVLesionComparisonResult | null {
    return cloneResult(this.result);
  }

  public recalculate(): TMTVLesionComparisonResult | null {
    if (!this.lesionService || !this.sessionService) return null;
    const baselineSession = this.sessionService.getSession('baseline');
    const followupSession = this.sessionService.getSession('followup');
    if (!baselineSession || !followupSession) {
      this.commitResult(null, 'inactive');
      return null;
    }

    const baselineState = this.lesionService.getState(
      baselineSession.segmentationIds,
      baselineSession.sessionId
    );
    const followupState = this.lesionService.getState(
      followupSession.segmentationIds,
      followupSession.sessionId
    );
    const inputSignature = `${baselineSession.sessionId}:${getLesionStateSignature(
      baselineState
    )}::${followupSession.sessionId}:${getLesionStateSignature(followupState)}`;
    if (inputSignature === this.inputSignature) return this.getResult();

    if (!baselineState.updatedAt || !followupState.updatedAt) {
      this.commitResult(null, inputSignature);
      return null;
    }

    const result = createTMTVLesionComparisonResult(
      baselineSession,
      followupSession,
      baselineState,
      followupState,
      this.maxDistanceMM
    );
    if (!result) {
      this.commitResult(null, inputSignature);
      return null;
    }
    this.commitResult(result, inputSignature);
    return this.getResult();
  }

  /** 2026-09-03 功能说明：退出模式时取消订阅并断开服务和匹配结果引用，允许 GC 回收旧病例对象。 */
  public destroy(): void {
    this.lesionSubscription?.unsubscribe();
    this.sessionSubscription?.unsubscribe();
    this.lesionSubscription = null;
    this.sessionSubscription = null;
    this.lesionService = null;
    this.sessionService = null;
    this.result = null;
    this.inputSignature = '';
    this.listeners.clear();
  }

  private commitResult(result: TMTVLesionComparisonResult | null, inputSignature: string): void {
    const didChange = inputSignature !== this.inputSignature || result !== this.result;
    this.inputSignature = inputSignature;
    this.result = result;
    if (!didChange) return;
    this.listeners.forEach(listener => {
      try {
        listener(this.getResult());
      } catch (error) {
        console.warn('[TMTVLesionComparisonService] 通知病灶匹配状态失败', error);
      }
    });
  }
}

export default new TMTVLesionComparisonService();
