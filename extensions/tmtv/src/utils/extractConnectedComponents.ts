export type ConnectedComponent = {
  voxelIndices: number[];
};

type ExtractConnectedComponentsOptions = {
  scalarData: ArrayLike<number>;
  dimensions: [number, number, number];
  segmentIndex: number;
};

const NEIGHBOR_OFFSETS = (() => {
  const offsets: Array<[number, number, number]> = [];

  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0 && dz === 0) {
          continue;
        }

        offsets.push([dx, dy, dz]);
      }
    }
  }

  return offsets;
})();

export default function extractConnectedComponents({
  scalarData,
  dimensions,
  segmentIndex,
}: ExtractConnectedComponentsOptions): ConnectedComponent[] {
  const [dimX, dimY, dimZ] = dimensions;
  const voxelCount = dimX * dimY * dimZ;

  if (!scalarData || voxelCount <= 0 || scalarData.length < voxelCount) {
    return [];
  }

  const visited = new Uint8Array(voxelCount);
  const components: ConnectedComponent[] = [];
  const sliceSize = dimX * dimY;

  for (let index = 0; index < voxelCount; index++) {
    if (visited[index] || scalarData[index] !== segmentIndex) {
      continue;
    }

    const voxelIndices: number[] = [];
    const queue = [index];
    visited[index] = 1;

    for (let queueIndex = 0; queueIndex < queue.length; queueIndex++) {
      const currentIndex = queue[queueIndex];
      voxelIndices.push(currentIndex);

      const z = Math.floor(currentIndex / sliceSize);
      const remainder = currentIndex - z * sliceSize;
      const y = Math.floor(remainder / dimX);
      const x = remainder - y * dimX;

      for (const [dx, dy, dz] of NEIGHBOR_OFFSETS) {
        const nx = x + dx;
        const ny = y + dy;
        const nz = z + dz;

        if (nx < 0 || nx >= dimX || ny < 0 || ny >= dimY || nz < 0 || nz >= dimZ) {
          continue;
        }

        const neighborIndex = nx + ny * dimX + nz * sliceSize;
        if (visited[neighborIndex] || scalarData[neighborIndex] !== segmentIndex) {
          continue;
        }

        visited[neighborIndex] = 1;
        queue.push(neighborIndex);
      }
    }

    components.push({ voxelIndices });
  }

  return components;
}
