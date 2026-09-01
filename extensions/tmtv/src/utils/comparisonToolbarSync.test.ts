import applyTMTVZoomSync from './applyTMTVZoomSync';
import { syncComparisonCamera } from './createComparisonCameraSynchronizer';
import { syncTMTVZoom, TMTV_ZOOM_TYPE } from './createTMTVZoomSynchronizer';
import { syncTMTVSameStudyCamera } from './createTMTVSameStudyCameraSynchronizer';
import initialState from '../services/TMTVComparisonInitialState';

jest.mock('@cornerstonejs/core', () => ({ Enums: { Events: { CAMERA_MODIFIED: 'camera' } } }));
jest.mock('@cornerstonejs/tools', () => ({ SynchronizerManager: { createSynchronizer: jest.fn() } }));
jest.mock('../services/TMTVComparisonInitialState', () => ({
  __esModule: true,
  default: { get: jest.fn() },
}));

describe('comparison toolbar camera and zoom combinations', () => {
  let servicesManager;
  let settings;
  let viewports;
  let groups;
  let protocol;
  const source = { viewportId: 'baselineCTAxial', renderingEngineId: 'engine' };
  const target = { viewportId: 'followupCTAxial', renderingEngineId: 'engine' };
  const camera = () => ({
    focalPoint: [10, 20, 30],
    position: [10, 20, 130],
    viewUp: [0, -1, 0],
    viewPlaneNormal: [0, 0, 1],
    parallelScale: 90,
    flipHorizontal: false,
    flipVertical: false,
  });
  const sync = (next, previous = camera(), from = source, to = target) =>
    syncComparisonCamera(
      null,
      from,
      to,
      { detail: { camera: next, previousCamera: previous } },
      { servicesManager }
    );

  beforeEach(() => {
    settings = { comparisonStudySync: true, orientationSync: true, zoomSync: false };
    protocol = '@ohif/extension-tmtv.hangingProtocolModule.ptCTCompare';
    viewports = new Map();
    groups = new Map();
    for (const side of ['baseline', 'followup']) {
      for (const suffix of ['CTAxial', 'PTAxial', 'FusionAxial', 'MIPSagittal']) {
        const id = `${side}${suffix}`;
        const offset = side === 'baseline' ? 0 : 100;
        let current = {
          ...camera(),
          focalPoint: [10 + offset, 20, 30],
          position: [10 + offset, 20, 130],
          parallelScale: 150,
        };
        viewports.set(id, {
          id,
          renderingEngineId: 'engine',
          initialCamera: { parallelScale: 150 },
          getZoom: () => 1,
          getCamera: () => current,
          setCamera: jest.fn(patch => {
            current = { ...current, ...patch };
          }),
          render: jest.fn(),
        });
      }
    }
    (initialState.get as jest.Mock).mockImplementation(
      viewport =>
        viewport && {
          camera: { focalPoint: [viewport.id.startsWith('baseline') ? 10 : 110, 20, 30] },
        }
    );
    servicesManager = {
      services: {
        hangingProtocolService: { getActiveProtocol: () => ({ protocol: { id: protocol } }) },
        customizationService: { getCustomization: () => settings },
        cornerstoneViewportService: {
          getCornerstoneViewport: id => viewports.get(id),
          getViewportIds: () => [...viewports.keys()],
        },
        syncGroupService: {
          getSynchronizer: id => groups.get(id),
          addSynchronizerType: jest.fn(),
          addViewportToSyncGroup: jest.fn((viewportId, engineId, configs) => {
            for (const config of configs) {
              if (!groups.has(config.id))
                groups.set(config.id, {
                  enabled: true,
                  type: config.type,
                  members: new Set(),
                  setEnabled(value) {
                    this.enabled = value;
                  },
                });
              groups.get(config.id).members.add(viewportId);
            }
          }),
        },
      },
    };
  });

  afterEach(() => jest.clearAllMocks());

  it('maps scroll and pan relative to separate initial centers, without copying zoom', () => {
    const next = {
      ...camera(),
      focalPoint: [15, 25, 35],
      position: [15, 25, 135],
      parallelScale: 40,
    };
    sync(next);
    expect(viewports.get(target.viewportId).getCamera()).toMatchObject({
      focalPoint: [115, 25, 35],
      position: [115, 25, 135],
      parallelScale: 150,
    });
    expect(viewports.get(target.viewportId).setCamera.mock.calls[0][0]).not.toHaveProperty(
      'parallelScale'
    );
    sync(next);
    expect(viewports.get(target.viewportId).getCamera().focalPoint).toEqual([115, 25, 35]);
  });

  it('uses the same study anchor for CT, PET and fusion to avoid cumulative offsets', () => {
    for (const suffix of ['CTAxial', 'PTAxial', 'FusionAxial']) {
      sync(
        { ...camera(), focalPoint: [10, 20, 40], position: [10, 20, 140] },
        camera(),
        { ...source, viewportId: `baseline${suffix}` },
        { ...target, viewportId: `followup${suffix}` }
      );
      expect(viewports.get(`followup${suffix}`).getCamera().focalPoint).toEqual([110, 20, 40]);
    }
  });

  it('maps in the opposite direction without accumulating displacement', () => {
    sync(
      { ...camera(), focalPoint: [115, 25, 35], position: [115, 25, 135] },
      camera(),
      target,
      source
    );
    expect(viewports.get(source.viewportId).getCamera().focalPoint).toEqual([15, 25, 35]);
  });

  it('synchronizes rotation and flip while retaining the peer center and scale', () => {
    sync({ ...camera(), viewUp: [1, 0, 0], flipHorizontal: true });
    expect(viewports.get(target.viewportId).getCamera()).toMatchObject({
      focalPoint: [110, 20, 30],
      viewUp: [1, 0, 0],
      flipHorizontal: true,
      parallelScale: 150,
    });
  });

  it('keeps target orientation when orientation sync is off and still allows slice movement', () => {
    settings.orientationSync = false;
    sync({
      ...camera(),
      focalPoint: [10, 20, 40],
      position: [10, 20, 140],
      viewUp: [1, 0, 0],
      flipHorizontal: true,
    });
    expect(viewports.get(target.viewportId).getCamera()).toMatchObject({
      focalPoint: [110, 20, 40],
      position: [110, 20, 140],
      viewUp: [0, -1, 0],
      flipHorizontal: false,
    });
  });

  it('does not turn a zoom-only event into camera movement', () => {
    sync({ ...camera(), parallelScale: 20 });
    expect(viewports.get(target.viewportId).setCamera).not.toHaveBeenCalled();
  });

  it('rotates MIP about its own center rather than copying the source center', () => {
    const from = { ...source, viewportId: 'baselineMIPSagittal' };
    const to = { ...target, viewportId: 'followupMIPSagittal' };
    sync(
      { ...camera(), position: [110, 20, 30], viewPlaneNormal: [1, 0, 0], viewUp: [0, 0, 1] },
      camera(),
      from,
      to
    );
    expect(viewports.get(to.viewportId).getCamera()).toMatchObject({
      focalPoint: [110, 20, 30],
      position: [210, 20, 30],
      viewPlaneNormal: [1, 0, 0],
    });
  });

  it('blocks feedback from another modality synchronizer during a camera update', () => {
    viewports
      .get(target.viewportId)
      .setCamera.mockImplementation(() =>
        sync({ ...camera(), flipHorizontal: true }, camera(), target, source)
      );
    sync({ ...camera(), flipHorizontal: true });
    expect(viewports.get(source.viewportId).setCamera).not.toHaveBeenCalled();
  });

  it('releases the feedback guard after a failed render', () => {
    viewports.get(target.viewportId).render.mockImplementationOnce(() => {
      throw new Error('disposed');
    });
    expect(() => sync({ ...camera(), flipHorizontal: true })).toThrow('disposed');
    sync({ ...camera(), flipHorizontal: true, flipVertical: true });
    expect(viewports.get(target.viewportId).setCamera).toHaveBeenCalledTimes(2);
  });

  it('uses absolute coordinates for a genuinely shared reference frame', () => {
    viewports.get(source.viewportId).getFrameOfReferenceUID = () => 'shared';
    viewports.get(target.viewportId).getFrameOfReferenceUID = () => 'shared';
    sync({ ...camera(), focalPoint: [15, 25, 35], position: [15, 25, 135] });
    expect(viewports.get(target.viewportId).getCamera().focalPoint).toEqual([15, 25, 35]);
  });

  it('ignores disabled comparison, ordinary mode, invalid cameras and missing initial state', () => {
    const next = { ...camera(), flipHorizontal: true };
    settings.comparisonStudySync = false;
    sync(next);
    settings.comparisonStudySync = true;
    protocol = 'ordinary';
    sync(next);
    protocol = '@ohif/extension-tmtv.hangingProtocolModule.ptCTCompare';
    sync({ ...next, focalPoint: [NaN, 0, 0] });
    (initialState.get as jest.Mock).mockReturnValue(undefined);
    sync(next);
    expect(viewports.get(target.viewportId).setCamera).not.toHaveBeenCalled();
  });

  it('does not lazily create zoom synchronizers while zoom is disabled', () => {
    applyTMTVZoomSync(servicesManager, true);
    expect(groups.size).toBe(0);
  });

  it('splits zoom groups immediately when comparison is disabled, and combines them when enabled', () => {
    settings.zoomSync = true;
    applyTMTVZoomSync(servicesManager, true);
    expect(groups.get('zoomSync').members.size).toBe(8);
    expect(groups.get('zoomSync').type).toBe(TMTV_ZOOM_TYPE);
    settings.comparisonStudySync = false;
    applyTMTVZoomSync(servicesManager, true);
    expect(groups.get('zoomSync').enabled).toBe(false);
    expect([...groups.get('tmtvZoomBaseline').members].every(id => id.startsWith('baseline'))).toBe(
      true
    );
    expect(groups.get('tmtvZoomBaseline').members.size).toBe(4);
    expect(groups.get('tmtvZoomFollowup').members.size).toBe(4);
    settings.comparisonStudySync = true;
    applyTMTVZoomSync(servicesManager, true);
    expect(groups.get('zoomSync').enabled).toBe(true);
    expect(groups.get('tmtvZoomBaseline').enabled).toBe(false);
    expect(groups.get('tmtvZoomFollowup').enabled).toBe(false);
    settings.zoomSync = false;
    applyTMTVZoomSync(servicesManager, true);
    expect([...groups.values()].every(group => !group.enabled)).toBe(true);
  });

  it('waits for valid camera scales and rejoins loaded viewports idempotently', () => {
    settings.zoomSync = true;
    viewports.get(source.viewportId).setCamera({ parallelScale: NaN });
    applyTMTVZoomSync(servicesManager, true);
    expect(groups.get('zoomSync').members.size).toBe(7);
    viewports.get(source.viewportId).setCamera({ parallelScale: 150 });
    applyTMTVZoomSync(servicesManager, true);
    applyTMTVZoomSync(servicesManager, true);
    expect(groups.get('zoomSync').members.size).toBe(8);
  });

  it('disables comparison-only zoom groups on returning to ordinary layout', () => {
    settings.zoomSync = true;
    settings.comparisonStudySync = false;
    applyTMTVZoomSync(servicesManager, true);
    viewports = new Map([
      [
        'ctAXIAL',
        {
          id: 'ctAXIAL',
          initialCamera: { parallelScale: 150 },
          getCamera: () => ({ parallelScale: 150 }),
          renderingEngineId: 'engine',
        },
      ],
    ]);
    applyTMTVZoomSync(servicesManager, false);
    expect(groups.get('tmtvZoomBaseline').enabled).toBe(false);
    expect(groups.get('zoomSync').members.has('ctAXIAL')).toBe(true);
  });

  it('ignores wheel navigation events whose scale did not change', () => {
    const targetViewport = viewports.get(target.viewportId);

    syncTMTVZoom(
      null,
      source,
      target,
      {
        detail: {
          previousCamera: { ...camera(), focalPoint: [10, 20, 30], parallelScale: 150 },
          camera: { ...camera(), focalPoint: [10, 20, 31], parallelScale: 150 },
        },
      },
      { servicesManager }
    );

    expect(targetViewport.setCamera).not.toHaveBeenCalled();
    expect(targetViewport.render).not.toHaveBeenCalled();
  });

  it('applies a valid normalized zoom idempotently and rejects stale or invalid camera events', () => {
    const sourceViewport = viewports.get(source.viewportId);
    const targetViewport = viewports.get(target.viewportId);
    sourceViewport.setCamera({ parallelScale: 120 });
    sourceViewport.setCamera.mockClear();
    targetViewport.setCamera.mockClear();

    const apply = (previousScale, currentScale) =>
      syncTMTVZoom(
        null,
        source,
        target,
        {
          detail: {
            previousCamera: { ...camera(), parallelScale: previousScale },
            camera: { ...camera(), parallelScale: currentScale },
          },
        },
        { servicesManager }
      );

    apply(150, 120);
    expect(targetViewport.setCamera).toHaveBeenCalledWith({ parallelScale: 120 });
    expect(targetViewport.render).toHaveBeenCalledTimes(1);

    targetViewport.setCamera.mockClear();
    apply(150, 120);
    apply(120, Number.NaN);
    apply(120, 100);
    expect(targetViewport.setCamera).not.toHaveBeenCalled();
  });

  it('preserves each viewport initial fit while synchronizing the same zoom level', () => {
    const sourceViewport = viewports.get(source.viewportId);
    const targetViewport = viewports.get(target.viewportId);
    sourceViewport.setCamera({ parallelScale: 120 });
    targetViewport.initialCamera.parallelScale = 300;
    targetViewport.setCamera({ parallelScale: 300 });
    targetViewport.setCamera.mockClear();

    syncTMTVZoom(
      null,
      source,
      target,
      {
        detail: {
          previousCamera: { ...camera(), parallelScale: 150 },
          camera: { ...camera(), parallelScale: 120 },
        },
      },
      { servicesManager }
    );

    expect(targetViewport.setCamera).toHaveBeenCalledWith({ parallelScale: 240 });
  });

  it('keeps the target scale while same-study scrolling and orientation are synchronized', () => {
    const from = { ...source, viewportId: 'baselineCTAxial' };
    const to = { ...target, viewportId: 'baselinePTAxial' };
    const targetViewport = viewports.get(to.viewportId);

    syncTMTVSameStudyCamera(
      null,
      from,
      to,
      {
        detail: {
          previousCamera: camera(),
          camera: {
            ...camera(),
            focalPoint: [10, 20, 40],
            position: [110, 20, 40],
            viewUp: [0, 0, 1],
            viewPlaneNormal: [1, 0, 0],
            parallelScale: 40,
          },
        },
      },
      { servicesManager }
    );

    expect(targetViewport.setCamera).toHaveBeenCalledWith(
      expect.not.objectContaining({ parallelScale: expect.anything() })
    );
    expect(targetViewport.getCamera().parallelScale).toBe(150);
  });

  it('does not turn a same-study zoom-only event into camera synchronization', () => {
    const targetViewport = viewports.get('baselinePTAxial');

    syncTMTVSameStudyCamera(
      null,
      source,
      { ...target, viewportId: 'baselinePTAxial' },
      {
        detail: {
          previousCamera: { ...camera(), parallelScale: 150 },
          camera: { ...camera(), parallelScale: 120 },
        },
      },
      { servicesManager }
    );

    expect(targetViewport.setCamera).not.toHaveBeenCalled();
  });
});
