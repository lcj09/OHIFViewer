import sessionService from './TMTVSessionService';

jest.mock('./TMTVComparisonService', () => {
  let state = { isComparisonMode: false, activeSide: 'baseline', activeViewportId: null };
  let protocolActive = false;
  const listeners = new Set<any>();
  const service = {
    subscribe: jest.fn(listener => {
      listeners.add(listener);
      listener({ ...state });
      return { unsubscribe: jest.fn(() => listeners.delete(listener)) };
    }),
    getState: jest.fn(() => ({ ...state })),
    isComparisonProtocolActive: jest.fn(() => protocolActive),
    emit: nextState => {
      state = { ...state, ...nextState };
      listeners.forEach(listener => listener({ ...state }));
    },
    configure: options => {
      protocolActive = options.protocolActive;
      state = {
        isComparisonMode: options.isComparisonMode,
        activeSide: options.activeSide || 'baseline',
        activeViewportId: options.activeViewportId || null,
      };
    },
    listenerCount: () => listeners.size,
  };
  return {
    __esModule: true,
    default: service,
    VIEWPORT_IDS_BY_SIDE: {
      baseline: [
        'baselineCTAxial',
        'baselinePTAxial',
        'baselineFusionAxial',
        'baselineMIPSagittal',
      ],
      followup: [
        'followupCTAxial',
        'followupPTAxial',
        'followupFusionAxial',
        'followupMIPSagittal',
      ],
    },
  };
});

const comparison: any = jest.requireMock('./TMTVComparisonService').default;

describe('TMTVSessionService', () => {
  let manager;

  const setStudyQuery = (singleOrBaseline?: string, followup?: string) => {
    const query = new URLSearchParams();
    if (singleOrBaseline) {
      query.set(
        'StudyInstanceUIDs',
        followup ? `${singleOrBaseline},${followup}` : singleOrBaseline
      );
    }
    if (followup) {
      query.set('tmtvbaselinestudyinstanceuid', singleOrBaseline);
      query.set('tmtvfollowupstudyinstanceuid', followup);
    }
    window.history.replaceState({}, '', `/?${query.toString()}`);
  };

  beforeEach(() => {
    comparison.configure({ protocolActive: false, isComparisonMode: false });
    setStudyQuery();
    manager = {
      services: {
        cornerstoneViewportService: {
          EVENTS: { VIEWPORT_VOLUMES_CHANGED: 'VIEWPORT_VOLUMES_CHANGED' },
          subscribe: jest.fn(),
          getViewportDisplaySets: jest.fn(),
        },
      },
    };
  });

  afterEach(() => {
    sessionService.reset();
    jest.clearAllMocks();
  });

  it('keeps ordinary TMTV in one backward-compatible session', () => {
    setStudyQuery('study-single');

    sessionService.init(manager);

    expect(sessionService.getActiveSide()).toBe('single');
    expect(sessionService.getSessions()).toHaveLength(1);
    expect(sessionService.getActiveSession()).toEqual(
      expect.objectContaining({
        sessionId: 'tmtv:single:study-single',
        side: 'single',
        studyInstanceUID: 'study-single',
        segmentationIds: [],
      })
    );
  });

  it('creates isolated baseline and follow-up sessions and follows the active side', () => {
    comparison.configure({
      protocolActive: true,
      isComparisonMode: true,
      activeSide: 'baseline',
    });
    setStudyQuery('study-a', 'study-b');

    sessionService.init(manager);
    sessionService.setSegmentationIds('baseline', ['seg-a'], 'seg-a');
    sessionService.setTotals('baseline', { tmtv: 12.5, tlg: 30 });
    sessionService.setSegmentationIds('followup', ['seg-b'], 'seg-b');
    sessionService.setTotals('followup', { tmtv: 8, tlg: 18 });

    expect(sessionService.getSession('baseline')).toEqual(
      expect.objectContaining({ studyInstanceUID: 'study-a', segmentationIds: ['seg-a'] })
    );
    expect(sessionService.getSession('followup')).toEqual(
      expect.objectContaining({ studyInstanceUID: 'study-b', segmentationIds: ['seg-b'] })
    );
    comparison.emit({ activeSide: 'followup' });
    expect(sessionService.getActiveSession()).toEqual(
      expect.objectContaining({ side: 'followup', segmentationIds: ['seg-b'] })
    );
  });

  it('clears only the reused side when route ownership changes', () => {
    comparison.configure({
      protocolActive: true,
      isComparisonMode: true,
      activeSide: 'baseline',
    });
    setStudyQuery('study-a', 'study-b');
    sessionService.init(manager);
    sessionService.setSegmentationIds('baseline', ['seg-a']);
    sessionService.setSegmentationIds('followup', ['seg-b']);

    setStudyQuery('study-c', 'study-b');
    comparison.emit({ activeSide: 'followup' });

    expect(sessionService.getSession('baseline')).toEqual(
      expect.objectContaining({ studyInstanceUID: 'study-c', segmentationIds: [] })
    );
    expect(sessionService.getSession('followup')).toEqual(
      expect.objectContaining({ studyInstanceUID: 'study-b', segmentationIds: ['seg-b'] })
    );
  });

  it('returns defensive snapshots and rejects invalid totals', () => {
    setStudyQuery('study-single');
    sessionService.init(manager);
    sessionService.setSegmentationIds('single', ['seg-1', '', 'seg-1']);
    const snapshot = sessionService.getSession('single');
    snapshot.segmentationIds.push('external-change');
    snapshot.totals.tmtv = 999;

    expect(sessionService.getSession('single')).toEqual(
      expect.objectContaining({ segmentationIds: ['seg-1'], totals: { tmtv: 0, tlg: null } })
    );
    expect(sessionService.setTotals('single', { tmtv: NaN, tlg: 1 })).toBeNull();
    expect(sessionService.setTotals('single', { tmtv: 1, tlg: Infinity })).toBeNull();
  });

  it('is idempotent on reset and ignores callbacks from a previous generation', () => {
    setStudyQuery('study-single');
    sessionService.init(manager);

    sessionService.reset();
    sessionService.reset();
    comparison.emit({ isComparisonMode: true, activeSide: 'followup' });

    expect(sessionService.getSessions()).toEqual([]);
    expect(comparison.listenerCount()).toBe(0);
  });

  it('does not subscribe to or inspect Cornerstone viewports during initialization', () => {
    setStudyQuery('study-a', 'study-b');
    comparison.configure({ protocolActive: true, isComparisonMode: true });

    sessionService.init(manager);

    expect(manager.services.cornerstoneViewportService.subscribe).not.toHaveBeenCalled();
    expect(manager.services.cornerstoneViewportService.getViewportDisplaySets).not.toHaveBeenCalled();
  });
});
