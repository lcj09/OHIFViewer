import {
  DEFAULT_LESION_MATCH_DISTANCE_MM,
  TMTVLesionComparisonService,
  createTMTVLesionComparisonResult,
  matchTMTVLesionsByCentroid,
} from './TMTVLesionComparisonService';

const createLesion = (
  id: string,
  centroid: [number, number, number],
  status: 'candidate' | 'confirmed' | 'rejected' = 'confirmed',
  displayIndex = 1
): any => ({
  id,
  displayIndex,
  lesionNumber: displayIndex,
  segmentationId: 'seg',
  segmentIndex: 1,
  voxelIndices: [],
  voxelCount: 1,
  boundsIJK: { min: [0, 0, 0], max: [0, 0, 0] },
  volume: 1,
  suvMin: 1,
  suvMax: 2,
  suvMean: 1.5,
  tlg: 1.5,
  centroid,
  centroidIJK: [0, 0, 0],
  status,
  createdBy: 'threshold',
  modified: false,
});

describe('matchTMTVLesionsByCentroid', () => {
  it('classifies mutual nearest, new and resolved confirmed lesions', () => {
    const matches = matchTMTVLesionsByCentroid(
      [
        createLesion('baseline-near', [0, 0, 0], 'confirmed', 1),
        createLesion('baseline-resolved', [200, 0, 0], 'confirmed', 2),
        createLesion('baseline-candidate', [400, 0, 0], 'candidate', 3),
      ],
      [
        createLesion('followup-near', [10, 0, 0], 'confirmed', 1),
        createLesion('followup-new', [400, 0, 0], 'confirmed', 2),
        createLesion('followup-rejected', [200, 0, 0], 'rejected', 3),
      ],
      50
    );

    expect(matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          baselineLesionId: 'baseline-near',
          followupLesionId: 'followup-near',
          status: 'persistent',
          distanceMM: 10,
          confidence: 0.8,
        }),
        expect.objectContaining({
          baselineLesionId: 'baseline-resolved',
          status: 'resolved',
        }),
        expect.objectContaining({ followupLesionId: 'followup-new', status: 'new' }),
      ])
    );
    expect(matches).toHaveLength(3);
  });

  it('leaves competing nearby lesions unmatched instead of forcing pairs', () => {
    const matches = matchTMTVLesionsByCentroid(
      [createLesion('baseline-a', [0, 0, 0]), createLesion('baseline-b', [10, 0, 0])],
      [createLesion('followup-a', [2, 0, 0])],
      20
    );

    expect(matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          baselineLesionId: 'baseline-a',
          followupLesionId: 'followup-a',
          status: 'persistent',
        }),
        expect.objectContaining({
          baselineLesionId: 'baseline-b',
          status: 'unmatched',
          reason: 'conflict',
        }),
      ])
    );
  });

  it('does not resolve an equal-distance ambiguity automatically', () => {
    const matches = matchTMTVLesionsByCentroid(
      [createLesion('baseline-a', [-1, 0, 0]), createLesion('baseline-b', [1, 0, 0])],
      [createLesion('followup-a', [0, 0, 0])],
      20
    );

    expect(matches).toHaveLength(3);
    expect(matches.every(match => match.status === 'unmatched')).toBe(true);
  });

  it('marks invalid centroids unmatched and falls back from an invalid threshold', () => {
    const invalid = createLesion('invalid', [Number.NaN, 0, 0]);
    const matches = matchTMTVLesionsByCentroid(
      [invalid, createLesion('baseline-valid', [0, 0, 0])],
      [createLesion('followup-valid', [DEFAULT_LESION_MATCH_DISTANCE_MM - 1, 0, 0])],
      0
    );

    expect(matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          baselineLesionId: 'invalid',
          status: 'unmatched',
          reason: 'invalid-centroid',
        }),
        expect.objectContaining({ status: 'persistent', distanceMM: 49 }),
      ])
    );
  });
});

describe('TMTVLesionComparisonService', () => {
  it('creates a display snapshot directly from two ready lesion states', () => {
    const baselineState: any = {
      sessionId: 'baseline-session',
      lesions: [createLesion('baseline-a', [0, 0, 0])],
      updatedAt: 1,
    };
    const followupState: any = {
      sessionId: 'followup-session',
      lesions: [createLesion('followup-a', [8, 0, 0])],
      updatedAt: 1,
    };

    expect(
      createTMTVLesionComparisonResult(
        { sessionId: 'baseline-session' },
        { sessionId: 'followup-session' },
        baselineState,
        followupState,
        20
      )
    ).toEqual(
      expect.objectContaining({
        baselineSessionId: 'baseline-session',
        followupSessionId: 'followup-session',
        counts: { persistent: 1, new: 0, resolved: 0, unmatched: 0 },
      })
    );
  });

  it('initializes on demand once and does not duplicate subscriptions', () => {
    const lesionListeners = new Set<() => void>();
    const sessionListeners = new Set<(session: any) => void>();
    const lesionService: any = {
      subscribe: listener => {
        lesionListeners.add(listener);
        return { unsubscribe: () => lesionListeners.delete(listener) };
      },
      getState: (_ids, sessionId) => ({
        sessionId,
        segmentationIds: [],
        segmentIndex: 1,
        selectedLesionId: null,
        lesions: [],
        totals: { tmtv: 0, tlg: null },
        updatedAt: 1,
      }),
    };
    const sessionService: any = {
      subscribe: listener => {
        sessionListeners.add(listener);
        return { unsubscribe: () => sessionListeners.delete(listener) };
      },
      getSession: side => ({ sessionId: `${side}-session`, side, segmentationIds: [] }),
    };
    const service = new TMTVLesionComparisonService();

    expect(service.ensureInitialized({ lesionService, sessionService })).toBe(true);
    expect(service.ensureInitialized({ lesionService, sessionService })).toBe(false);
    expect(lesionListeners.size).toBe(1);
    expect(sessionListeners.size).toBe(1);
    expect(service.getResult()).toEqual(
      expect.objectContaining({
        counts: { persistent: 0, new: 0, resolved: 0, unmatched: 0 },
      })
    );

    service.destroy();
    expect(lesionListeners.size).toBe(0);
    expect(sessionListeners.size).toBe(0);
  });

  it('recalculates from both sessions and releases subscriptions and retained results', () => {
    const lesionListeners = new Set<() => void>();
    const sessionListeners = new Set<(session: any) => void>();
    const baselineState: any = {
      sessionId: 'baseline-session',
      segmentationIds: ['baseline-seg'],
      segmentIndex: 1,
      selectedLesionId: null,
      lesions: [createLesion('baseline-a', [0, 0, 0])],
      totals: { tmtv: 1, tlg: 1.5 },
      updatedAt: 1,
    };
    const followupState: any = {
      sessionId: 'followup-session',
      segmentationIds: ['followup-seg'],
      segmentIndex: 1,
      selectedLesionId: null,
      lesions: [createLesion('followup-a', [5, 0, 0])],
      totals: { tmtv: 1, tlg: 1.5 },
      updatedAt: 1,
    };
    const sessions: any = {
      baseline: {
        sessionId: 'baseline-session',
        side: 'baseline',
        segmentationIds: ['baseline-seg'],
      },
      followup: {
        sessionId: 'followup-session',
        side: 'followup',
        segmentationIds: ['followup-seg'],
      },
    };
    const lesionService: any = {
      subscribe: listener => {
        lesionListeners.add(listener);
        return { unsubscribe: () => lesionListeners.delete(listener) };
      },
      getState: (_ids, sessionId) =>
        sessionId === 'baseline-session' ? baselineState : followupState,
    };
    const sessionService: any = {
      subscribe: listener => {
        sessionListeners.add(listener);
        listener(sessions.baseline);
        return { unsubscribe: () => sessionListeners.delete(listener) };
      },
      getSession: side => sessions[side] || null,
    };
    const service = new TMTVLesionComparisonService();

    service.init({ lesionService, sessionService, maxDistanceMM: 20 });
    expect(service.getResult()).toEqual(
      expect.objectContaining({
        counts: { persistent: 1, new: 0, resolved: 0, unmatched: 0 },
      })
    );

    const externalSnapshot = service.getResult();
    externalSnapshot.matches.length = 0;
    expect(service.getResult().matches).toHaveLength(1);

    followupState.lesions[0].status = 'rejected';
    followupState.updatedAt = 2;
    lesionListeners.forEach(listener => listener());
    expect(service.getResult()).toEqual(
      expect.objectContaining({
        counts: { persistent: 0, new: 0, resolved: 1, unmatched: 0 },
      })
    );

    service.destroy();
    expect(lesionListeners.size).toBe(0);
    expect(sessionListeners.size).toBe(0);
    expect(service.getResult()).toBeNull();
  });

  it('waits until both lesion states have completed their first extraction', () => {
    const state: any = {
      sessionId: 'session',
      segmentationIds: [],
      segmentIndex: 1,
      selectedLesionId: null,
      lesions: [],
      totals: { tmtv: 0, tlg: null },
      updatedAt: 0,
    };
    const service = new TMTVLesionComparisonService();
    const lesionService: any = {
      subscribe: () => ({ unsubscribe: jest.fn() }),
      getState: () => state,
    };
    const sessionService: any = {
      subscribe: () => ({ unsubscribe: jest.fn() }),
      getSession: side => ({ sessionId: side, side, segmentationIds: [] }),
    };

    service.init({ lesionService, sessionService });

    expect(service.getResult()).toBeNull();
    service.destroy();
  });
});
