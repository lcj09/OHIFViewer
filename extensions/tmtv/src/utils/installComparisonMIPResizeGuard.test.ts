import installComparisonMIPResizeGuard from './installComparisonMIPResizeGuard';

describe('comparison MIP resize guard', () => {
  const makeViewport = focalPoint => {
    let camera = {
      focalPoint: [...focalPoint],
      position: [focalPoint[0] + 500, focalPoint[1], focalPoint[2]],
      viewUp: [0, 0, 1],
      viewPlaneNormal: [1, 0, 0],
      parallelScale: 200,
    };
    return {
      getCamera: () => camera,
      setCamera: jest.fn(update => (camera = { ...camera, ...update })),
      render: jest.fn(),
      corruptForResize: () => {
        camera = { ...camera, focalPoint: [500, focalPoint[1], focalPoint[2]], parallelScale: 300 };
      },
    };
  };

  it('restores MIP transforms after the deferred resize implementation and preserves new scale', () => {
    const baseline = makeViewport([1, 2, 3]);
    const followup = makeViewport([-1, -145, -104]);
    const synchronizer = { isDisabled: () => false, setEnabled: jest.fn() };
    const viewportService = {
      getCornerstoneViewport: id =>
        id === 'baselineMIPSagittal' ? baseline : id === 'followupMIPSagittal' ? followup : null,
      performResize: jest.fn(() => {
        baseline.corruptForResize();
        followup.corruptForResize();
      }),
    };
    const originalPerformResize = viewportService.performResize;
    const guard = installComparisonMIPResizeGuard(
      {
        services: {
          cornerstoneViewportService: viewportService,
          syncGroupService: { getSynchronizersForViewport: () => [synchronizer] },
        },
      },
      () => true
    );

    viewportService.performResize();

    expect(baseline.getCamera()).toMatchObject({ focalPoint: [1, 2, 3], parallelScale: 300 });
    expect(followup.getCamera()).toMatchObject({
      focalPoint: [-1, -145, -104],
      parallelScale: 300,
    });
    expect(synchronizer.setEnabled.mock.calls).toEqual([[false], [true]]);
    guard.dispose();
    expect(viewportService.performResize).toBe(originalPerformResize);
  });

  it('restores a rebuilt viewport only when it still contains the same volume actor', () => {
    let viewport = makeViewport([-1, -145, -104]);
    viewport.getActors = () => [{ referencedId: 'followup-PT' }];
    const viewportService = {
      getCornerstoneViewport: id => (id === 'followupMIPSagittal' ? viewport : null),
      performResize: jest.fn(),
    };
    const guard = installComparisonMIPResizeGuard(
      { services: { cornerstoneViewportService: viewportService } },
      () => true
    );
    guard.capture();

    viewport = makeViewport([500, -145, -104]);
    viewport.getActors = () => [{ referencedId: 'followup-PT' }];
    guard.restore();
    expect(viewport.getCamera().focalPoint).toEqual([-1, -145, -104]);

    viewport = makeViewport([900, 10, 20]);
    viewport.getActors = () => [{ referencedId: 'replacement-PT' }];
    guard.restore();
    expect(viewport.getCamera().focalPoint).toEqual([900, 10, 20]);
  });

  it('does not intervene outside comparison and restores resources when resize throws', () => {
    const viewport = makeViewport([1, 2, 3]);
    const synchronizer = { isDisabled: () => false, setEnabled: jest.fn() };
    let active = false;
    const failure = new Error('resize failed');
    const viewportService = {
      getCornerstoneViewport: () => viewport,
      performResize: jest.fn(() => {
        viewport.corruptForResize();
        throw failure;
      }),
    };
    installComparisonMIPResizeGuard(
      {
        services: {
          cornerstoneViewportService: viewportService,
          syncGroupService: { getSynchronizersForViewport: () => [synchronizer] },
        },
      },
      () => active
    );

    expect(() => viewportService.performResize()).toThrow(failure);
    expect(synchronizer.setEnabled).not.toHaveBeenCalled();
    viewport.setCamera({ focalPoint: [1, 2, 3] });
    active = true;
    expect(() => viewportService.performResize()).toThrow(failure);
    expect(viewport.getCamera().focalPoint).toEqual([1, 2, 3]);
    expect(synchronizer.setEnabled.mock.calls).toEqual([[false], [true]]);
  });
});
