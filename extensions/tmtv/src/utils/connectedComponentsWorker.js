import { expose } from 'comlink';

const NEIGHBOR_OFFSETS = (() => {
  const offsets = [];

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

const workerApi = {
  extractConnectedComponents: ({ segmentMask, dimensions }) => {
    // [2026-08-26 功能] Web Worker 加速：在后台线程执行 3D Connected Components，避免主线程 UI 卡顿
    const [dimX, dimY, dimZ] = dimensions;
    const voxelCount = dimX * dimY * dimZ;

    if (!segmentMask || voxelCount <= 0 || segmentMask.length < voxelCount) {
      return [];
    }

    const visited = new Uint8Array(voxelCount);
    const components = [];
    const sliceSize = dimX * dimY;

    for (let index = 0; index < voxelCount; index++) {
      if (visited[index] || !segmentMask[index]) {
        continue;
      }

      const voxelIndices = [];
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

          if (visited[neighborIndex] || !segmentMask[neighborIndex]) {
            continue;
          }

          visited[neighborIndex] = 1;
          queue.push(neighborIndex);
        }
      }

      components.push({ voxelIndices });
    }

    return components;
  },
};

expose(workerApi);
