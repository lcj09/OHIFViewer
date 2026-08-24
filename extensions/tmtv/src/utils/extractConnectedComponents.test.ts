import extractConnectedComponents from './extractConnectedComponents';

describe('extractConnectedComponents', () => {
  it('separates disconnected Segment 1 voxels in 3D labelmaps', () => {
    const scalarData = new Uint8Array(5 * 5 * 2);
    scalarData[0] = 1;
    scalarData[1] = 1;
    scalarData[4 + 4 * 5 + 1 * 25] = 1;

    const components = extractConnectedComponents({
      scalarData,
      dimensions: [5, 5, 2],
      segmentIndex: 1,
    });

    expect(components).toHaveLength(2);
    expect(components.map(component => component.voxelIndices.length)).toEqual([2, 1]);
  });

  it('uses 26-neighbor connectivity across slices', () => {
    const scalarData = new Uint8Array(3 * 3 * 2);
    scalarData[0] = 1;
    scalarData[1 + 1 * 3 + 1 * 9] = 1;

    const components = extractConnectedComponents({
      scalarData,
      dimensions: [3, 3, 2],
      segmentIndex: 1,
    });

    expect(components).toHaveLength(1);
    expect(components[0].voxelIndices).toEqual([0, 13]);
  });

  it('ignores other segment indices', () => {
    const scalarData = new Uint8Array(4);
    scalarData[0] = 1;
    scalarData[1] = 2;
    scalarData[2] = 2;

    const components = extractConnectedComponents({
      scalarData,
      dimensions: [2, 2, 1],
      segmentIndex: 2,
    });

    expect(components).toHaveLength(1);
    expect(components[0].voxelIndices).toEqual([1, 2]);
  });
});
