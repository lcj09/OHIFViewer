import setOrientationPreservingScale from './setOrientationPreservingScale';

describe('setOrientationPreservingScale', () => {
  it('restores the scale captured before the orientation change', () => {
    let camera = { parallelScale: 120 };
    const viewport = {
      getCamera: jest.fn(() => camera),
      setOrientation: jest.fn(() => {
        camera = { parallelScale: 260 };
      }),
      setCamera: jest.fn(patch => {
        camera = { ...camera, ...patch };
      }),
    };

    setOrientationPreservingScale(viewport, 'sagittal');

    expect(viewport.setOrientation).toHaveBeenCalledWith('sagittal');
    expect(viewport.setCamera).toHaveBeenCalledWith({ parallelScale: 120 });
    expect(camera.parallelScale).toBe(120);
  });

  it.each([undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'does not restore an invalid scale: %s',
    parallelScale => {
      const viewport = {
        getCamera: jest.fn(() => ({ parallelScale })),
        setOrientation: jest.fn(),
        setCamera: jest.fn(),
      };

      setOrientationPreservingScale(viewport, 'coronal');

      expect(viewport.setOrientation).toHaveBeenCalledWith('coronal');
      expect(viewport.setCamera).not.toHaveBeenCalled();
    }
  );
});
