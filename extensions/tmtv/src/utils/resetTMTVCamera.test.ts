import resetTMTVCamera from './resetTMTVCamera';

describe('resetTMTVCamera', () => {
  function makeViewport() {
    const viewport: any = {
      camera: { parallelScale: 40, focalPoint: [5, 6, 7] },
      initialCamera: { parallelScale: 100, focalPoint: [0, 0, 0] },
      resetCamera: jest.fn(options => {
        viewport.camera = { parallelScale: 100, focalPoint: [0, 0, 0] };
        if (options.storeAsInitialCamera) {
          viewport.initialCamera = JSON.parse(JSON.stringify(viewport.camera));
        }
      }),
      setCamera: jest.fn((camera, storeAsInitialCamera) => {
        viewport.camera = JSON.parse(JSON.stringify(camera));
        if (storeAsInitialCamera) {
          viewport.initialCamera = JSON.parse(JSON.stringify(viewport.camera));
        }
      }),
      getZoom: () => viewport.initialCamera.parallelScale / viewport.camera.parallelScale,
    };
    return viewport;
  }

  it('returns to the fitted camera and makes normalized zoom equal 1', () => {
    const viewport = makeViewport();

    expect(resetTMTVCamera(viewport)).toBe(true);
    expect(viewport.resetCamera).toHaveBeenCalledWith({
      resetZoom: true,
      resetPan: true,
      resetToCenter: true,
      storeAsInitialCamera: true,
    });
    expect(viewport.setCamera).not.toHaveBeenCalled();
    expect(viewport.getZoom()).toBe(1);
  });

  it('restores a captured comparison camera as the new zoom baseline', () => {
    const viewport = makeViewport();
    const captured = { parallelScale: 85, focalPoint: [10, 20, 30] };

    expect(resetTMTVCamera(viewport, captured)).toBe(true);
    expect(viewport.setCamera).toHaveBeenCalledWith(captured, true);
    expect(viewport.camera).toEqual(captured);
    expect(viewport.initialCamera).toEqual(captured);
    expect(viewport.getZoom()).toBe(1);
  });

  it('ignores a missing or already destroyed viewport', () => {
    expect(resetTMTVCamera(undefined)).toBe(false);
    expect(resetTMTVCamera({})).toBe(false);
  });
});
