import fitComparisonViewports, {
  reconcileComparisonViewportScales,
} from './fitComparisonViewports';

describe('fitComparisonViewports', () => {
  const makeViewport = (id, fitScale) => {
    let camera = { parallelScale: fitScale * 2 };
    const actorCount = id.includes('Fusion') ? 2 : 1;
    return {
      id,
      element: { clientWidth: 400, clientHeight: 300 },
      getActors: () =>
        Array.from({ length: actorCount }, (_, index) => ({ referencedId: `${id}-${index}` })),
      getCamera: () => camera,
      resetCamera: jest.fn(() => {
        camera = { parallelScale: fitScale };
      }),
      setCamera: jest.fn((patch, storeAsInitialCamera) => {
        camera = { ...camera, ...patch };
      }),
      initialCamera: { parallelScale: fitScale },
      setInitialCamera: jest.fn(function (nextCamera) {
        this.initialCamera = nextCamera;
      }),
      render: jest.fn(),
    };
  };

  it('fits once and aligns PET, Fusion and MIP to the same CT display scale', () => {
    const viewports = new Map();
    for (const side of ['baseline', 'followup']) {
      viewports.set(`${side}CTAxial`, makeViewport(`${side}CTAxial`, 100));
      viewports.set(`${side}PTAxial`, makeViewport(`${side}PTAxial`, 180));
      viewports.set(`${side}FusionAxial`, makeViewport(`${side}FusionAxial`, 160));
      viewports.set(`${side}MIPSagittal`, makeViewport(`${side}MIPSagittal`, 240));
    }
    const synchronizer = {
      isDisabled: () => false,
      setEnabled: jest.fn(),
    };
    const servicesManager = {
      services: {
        cornerstoneViewportService: { getCornerstoneViewport: id => viewports.get(id) },
        syncGroupService: { getSynchronizersForViewport: () => [synchronizer] },
      },
    };
    const fitted = new WeakMap();

    expect(fitComparisonViewports(servicesManager, fitted)).toBe(true);
    for (const side of ['baseline', 'followup']) {
      expect(viewports.get(`${side}PTAxial`).getCamera().parallelScale).toBe(100);
      expect(viewports.get(`${side}FusionAxial`).getCamera().parallelScale).toBe(100);
      expect(viewports.get(`${side}MIPSagittal`).getCamera().parallelScale).toBe(100);
    }
    expect(fitComparisonViewports(servicesManager, fitted)).toBe(false);
    viewports.forEach(viewport => expect(viewport.resetCamera).toHaveBeenCalledTimes(1));
    expect(synchronizer.setEnabled.mock.calls).toEqual([[false], [true]]);

    const mip = viewports.get('baselineMIPSagittal');
    mip.setCamera({ parallelScale: 240 });
    mip.resetCamera.mockClear();
    expect(fitComparisonViewports(servicesManager, fitted)).toBe(true);
    expect(mip.getCamera().parallelScale).toBe(100);
    expect(mip.resetCamera).not.toHaveBeenCalled();
  });

  it('refits when viewport dimensions change and skips incomplete fusion viewports', () => {
    const ct = makeViewport('baselineCTAxial', 100);
    const fusion = makeViewport('baselineFusionAxial', 160);
    fusion.getActors = () => [{ referencedId: 'CT-only' }];
    const viewports = new Map([
      [ct.id, ct],
      [fusion.id, fusion],
    ]);
    const servicesManager = {
      services: {
        cornerstoneViewportService: { getCornerstoneViewport: id => viewports.get(id) },
      },
    };
    const fitted = new WeakMap();

    expect(fitComparisonViewports(servicesManager, fitted)).toBe(true);
    expect(fusion.resetCamera).not.toHaveBeenCalled();
    ct.element.clientWidth = 600;
    expect(fitComparisonViewports(servicesManager, fitted)).toBe(true);
    expect(ct.resetCamera).toHaveBeenCalledTimes(2);
  });

  it('restores current and initial scales after maximize/restore without resetting position', () => {
    const ct = makeViewport('baselineCTAxial', 160);
    const pet = makeViewport('baselinePTAxial', 300);
    ct.setCamera({ parallelScale: 80 });
    pet.setCamera({ parallelScale: 260 });
    ct.setCamera.mockClear();
    pet.setCamera.mockClear();
    const viewports = new Map([
      [ct.id, ct],
      [pet.id, pet],
    ]);
    const servicesManager = {
      services: {
        cornerstoneViewportService: { getCornerstoneViewport: id => viewports.get(id) },
      },
    };

    expect(reconcileComparisonViewportScales(servicesManager)).toBe(true);
    expect(pet.setCamera).toHaveBeenCalledWith({ parallelScale: 80 });
    expect(pet.initialCamera.parallelScale).toBe(160);
    expect(pet.resetCamera).not.toHaveBeenCalled();
    pet.setCamera.mockClear();
    expect(reconcileComparisonViewportScales(servicesManager)).toBe(false);
    expect(pet.setCamera).not.toHaveBeenCalled();
  });

  it('uses the pre-one-up scale snapshot even when the 1x1 CT camera was refitted', () => {
    const ct = makeViewport('baselineCTAxial', 160);
    const mip = makeViewport('baselineMIPSagittal', 300);
    ct.setCamera({ parallelScale: 260 });
    ct.initialCamera.parallelScale = 260;
    ct.setCamera.mockClear();
    mip.setCamera.mockClear();
    const viewports = new Map([
      [ct.id, ct],
      [mip.id, mip],
    ]);
    const servicesManager = {
      services: {
        cornerstoneViewportService: { getCornerstoneViewport: id => viewports.get(id) },
      },
    };
    const references = new Map([['baseline', { current: 80, initial: 160 }]]);

    expect(reconcileComparisonViewportScales(servicesManager, references)).toBe(true);
    expect(ct.getCamera().parallelScale).toBe(80);
    expect(ct.initialCamera.parallelScale).toBe(160);
    expect(mip.getCamera().parallelScale).toBe(80);
    expect(mip.initialCamera.parallelScale).toBe(160);
  });
});
