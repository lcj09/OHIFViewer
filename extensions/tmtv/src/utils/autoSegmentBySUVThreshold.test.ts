import autoSegmentBySUVThreshold from './autoSegmentBySUVThreshold';

describe('autoSegmentBySUVThreshold', () => {
  it('keeps SUV voxels at or above threshold and filters small components by volume', () => {
    const suvScalarData = new Float32Array(4 * 4 * 1);
    suvScalarData[0] = 3;
    suvScalarData[1] = 4;
    suvScalarData[15] = 5;

    const result = autoSegmentBySUVThreshold({
      suvScalarData,
      dimensions: [4, 4, 1],
      spacing: [5, 5, 2],
      threshold: 2.5,
      minVolumeML: 0.1,
    });

    expect(result.candidateVoxelIndices).toEqual([0, 1, 15]);
    expect(result.voxelIndices).toEqual([0, 1]);
    expect(result.componentCount).toBe(2);
    expect(result.keptComponentCount).toBe(1);
    expect(result.filteredComponentCount).toBe(1);
  });

  it('returns no voxels when dimensions or scalar data are invalid', () => {
    const result = autoSegmentBySUVThreshold({
      suvScalarData: new Float32Array([3, 4]),
      dimensions: [2, 2, 1],
      spacing: [1, 1, 1],
    });

    expect(result.voxelIndices).toEqual([]);
    expect(result.candidateVoxelCount).toBe(0);
  });

  it('does not apply clinical volume filtering without valid spacing', () => {
    const result = autoSegmentBySUVThreshold({
      suvScalarData: new Float32Array([3, 4, 5, 6]),
      dimensions: [2, 2, 1],
      spacing: null,
      minVolumeML: 0.1,
    });

    expect(result.voxelIndices).toEqual([]);
    expect(result.voxelVolumeML).toBe(0);
  });

  it('ignores NaN and infinite SUV values', () => {
    const result = autoSegmentBySUVThreshold({
      suvScalarData: new Float32Array([3, NaN, Infinity, 1]),
      dimensions: [2, 2, 1],
      spacing: [10, 10, 10],
      threshold: 2.5,
      minVolumeML: 0,
    });

    expect(result.voxelIndices).toEqual([0]);
    expect(result.skippedNonFiniteVoxelCount).toBe(2);
  });
});
