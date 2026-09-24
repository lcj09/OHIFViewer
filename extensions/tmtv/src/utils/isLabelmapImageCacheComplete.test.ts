import { cache } from '@cornerstonejs/core';
import isLabelmapImageCacheComplete from './isLabelmapImageCacheComplete';

describe('isLabelmapImageCacheComplete', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('accepts volume-only labelmaps', () => {
    expect(isLabelmapImageCacheComplete({})).toBe(true);
  });

  it('accepts image-backed labelmaps when every image is cached', () => {
    jest.spyOn(cache, 'getImage').mockReturnValue({} as any);

    expect(isLabelmapImageCacheComplete({ imageIds: ['seg-1', 'seg-2'] })).toBe(true);
  });

  it('rejects image-backed labelmaps when a cached image is missing', () => {
    jest
      .spyOn(cache, 'getImage')
      .mockReturnValueOnce({} as any)
      .mockReturnValueOnce(undefined);

    expect(isLabelmapImageCacheComplete({ imageIds: ['seg-1', 'seg-2'] })).toBe(false);
  });
});
