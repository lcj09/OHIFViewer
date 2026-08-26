import { getWebWorkerManager } from '@cornerstonejs/core';
import extractConnectedComponents, { ConnectedComponent } from './extractConnectedComponents';

type ExtractConnectedComponentsAsyncOptions = {
  scalarData: ArrayLike<number>;
  dimensions: [number, number, number];
  segmentIndex: number;
};

const WORKER_NAME = 'tmtv-connected-components-worker';
const WorkerOptions = {
  maxWorkerInstances: 1,
  autoTerminateOnIdle: {
    enabled: true,
    idleTimeThreshold: 2000,
  },
};

let isWorkerRegistered = false;

function ensureWorkerRegistered(): void {
  if (isWorkerRegistered || typeof Worker === 'undefined') {
    return;
  }

  // [2026-08-26 功能] Web Worker 加速：复用 Cornerstone workerManager 管理 worker 生命周期，避免手写 worker 泄漏
  getWebWorkerManager().registerWorker(
    WORKER_NAME,
    () =>
      new Worker(new URL('./connectedComponentsWorker.js', import.meta.url), {
        name: WORKER_NAME,
      }),
    WorkerOptions
  );
  isWorkerRegistered = true;
}

export default async function extractConnectedComponentsAsync({
  scalarData,
  dimensions,
  segmentIndex,
}: ExtractConnectedComponentsAsyncOptions): Promise<ConnectedComponent[]> {
  ensureWorkerRegistered();

  if (!isWorkerRegistered) {
    return extractConnectedComponents({ scalarData, dimensions, segmentIndex });
  }

  try {
    const segmentMask = createSegmentMask(scalarData, segmentIndex);

    return await getWebWorkerManager().executeTask(WORKER_NAME, 'extractConnectedComponents', {
      segmentMask,
      dimensions,
    });
  } catch (error) {
    // [2026-08-26 功能] Web Worker 加速：worker 初始化/执行失败时回退主线程算法，保证临床流程不中断
    console.warn('[TMTV] Connected components worker failed, fallback to main thread.', error);
    return extractConnectedComponents({ scalarData, dimensions, segmentIndex });
  }
}

function createSegmentMask(scalarData: ArrayLike<number>, segmentIndex: number): Uint8Array {
  // [2026-08-26 功能] Web Worker 加速：复制二值 mask 给 worker，避免转移原始 labelmap buffer 导致 Cornerstone 数据失效
  const segmentMask = new Uint8Array(scalarData.length);

  for (let voxelIndex = 0; voxelIndex < scalarData.length; voxelIndex++) {
    segmentMask[voxelIndex] = scalarData[voxelIndex] === segmentIndex ? 1 : 0;
  }

  return segmentMask;
}
