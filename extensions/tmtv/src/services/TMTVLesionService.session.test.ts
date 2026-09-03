import { TMTVLesionService, type TMTVLesion, type TMTVLesionState } from './TMTVLesionService';

jest.mock('./TMTVSegmentMaskStorageService', () => ({
  __esModule: true,
  default: {
    saveSegmentMask: jest.fn(),
    restoreSegmentMask: jest.fn(),
  },
}));

const makeLesion = (status: TMTVLesion['status'] = 'candidate'): TMTVLesion => ({
  id: 'shared-lesion-id',
  displayIndex: 1,
  lesionNumber: 1,
  segmentationId: 'shared-segmentation-id',
  segmentIndex: 1,
  voxelIndices: [1],
  voxelCount: 1,
  boundsIJK: { min: [0, 0, 0], max: [0, 0, 0] },
  volume: 1,
  suvMin: 2,
  suvMax: 3,
  suvMean: 2.5,
  tlg: 2.5,
  centroid: [0, 0, 0],
  centroidIJK: [0, 0, 0],
  status,
  createdBy: 'threshold',
  modified: false,
});

const makeState = (sessionId: string): TMTVLesionState => ({
  sessionId,
  segmentationIds: ['shared-segmentation-id'],
  segmentIndex: 1,
  selectedLesionId: null,
  lesions: [makeLesion()],
  totals: { tmtv: 0, tlg: null },
  updatedAt: Date.now(),
});

describe('TMTVLesionService session isolation', () => {
  let service: TMTVLesionService;

  beforeEach(() => {
    service = new TMTVLesionService();
    (service as any).stateByGroupId.set('session:baseline-session', makeState('baseline-session'));
    (service as any).stateByGroupId.set('session:followup-session', makeState('followup-session'));
    window.localStorage.clear();
  });

  afterEach(() => service.destroy());

  it('keeps status, selection and totals independent even when IDs are identical', () => {
    service.selectLesion(['shared-segmentation-id'], 'shared-lesion-id', 'baseline-session');
    service.setLesionStatus(
      ['shared-segmentation-id'],
      'shared-lesion-id',
      'confirmed',
      true,
      'baseline-session'
    );

    const baseline = service.getState(['new-segmentation-id'], 'baseline-session');
    const followup = service.getState(['shared-segmentation-id'], 'followup-session');
    expect(baseline.selectedLesionId).toBe('shared-lesion-id');
    expect(baseline.lesions[0].status).toBe('confirmed');
    expect(baseline.totals.tmtv).toBe(1);
    expect(followup.selectedLesionId).toBeNull();
    expect(followup.lesions[0].status).toBe('candidate');
    expect(followup.totals.tmtv).toBe(0);
  });

  it('undoes only the requested session history', () => {
    service.setLesionStatus(
      ['shared-segmentation-id'],
      'shared-lesion-id',
      'confirmed',
      true,
      'baseline-session'
    );
    service.setLesionStatus(
      ['shared-segmentation-id'],
      'shared-lesion-id',
      'rejected',
      true,
      'followup-session'
    );

    expect(service.undo('baseline-session')?.sessionId).toBe('baseline-session');
    expect(service.getState([], 'baseline-session').lesions[0].status).toBe('candidate');
    expect(service.getState([], 'followup-session').lesions[0].status).toBe('rejected');
    expect(service.redo('baseline-session')?.sessionId).toBe('baseline-session');
    expect(service.getState([], 'baseline-session').lesions[0].status).toBe('confirmed');
  });

  it('resets one session without releasing the other session state', () => {
    (service as any).asyncExtractionRequestIdByGroupId.set('session:baseline-session', 1);
    (service as any).asyncExtractionRequestIdByGroupId.set('session:followup-session', 2);
    const generation = (service as any).generation;

    service.reset(undefined, 'baseline-session');

    expect(service.getState([], 'baseline-session').lesions).toHaveLength(0);
    expect(service.getState([], 'followup-session').lesions).toHaveLength(1);
    expect((service as any).generation).toBe(generation);
    expect((service as any).asyncExtractionRequestIdByGroupId.get('session:followup-session')).toBe(
      2
    );
  });

  it('uses separate persistence keys and releases all retained state on destroy', () => {
    service.setLesionStatus(
      ['shared-segmentation-id'],
      'shared-lesion-id',
      'confirmed',
      true,
      'baseline-session'
    );
    service.setLesionStatus(
      ['shared-segmentation-id'],
      'shared-lesion-id',
      'rejected',
      true,
      'followup-session'
    );

    expect(
      window.localStorage.getItem('ohif:tmtv:lesions:v1:session:baseline-session')
    ).toBeTruthy();
    expect(
      window.localStorage.getItem('ohif:tmtv:lesions:v1:session:followup-session')
    ).toBeTruthy();

    service.destroy();
    expect((service as any).stateByGroupId.size).toBe(0);
    expect((service as any).historyStack).toHaveLength(0);
    expect((service as any).redoStack).toHaveLength(0);
    expect((service as any).pendingStatusHistoryByGroupId.size).toBe(0);
    expect((service as any).listeners.size).toBe(0);
  });
});
