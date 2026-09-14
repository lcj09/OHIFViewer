import { cache, imageLoadPoolManager, Enums } from '@cornerstonejs/core';
import zip from 'lodash.zip';
import compact from 'lodash.compact';
import flatten from 'lodash.flatten';

// Map of volumeId and SeriesInstanceId
const volumeIdMapsToLoad = new Map<string, string>();
const viewportIdVolumeInputArrayMap = new Map<string, unknown[]>();

type TmtvVolumeMemoryStats = {
  generatedAt: string;
  uniqueVolumeCount: number;
  totalRawMB: number;
  volumes: Array<{
    volumeId: string;
    modality: string;
    dimensions: number[];
    dataType: string;
    imageCount: number;
    rawMB: number;
    viewportIds: string[];
  }>;
};

const memoryStatsTarget = globalThis as typeof globalThis & {
  __tmtvVolumeMemoryStats?: TmtvVolumeMemoryStats;
};

const bytesPerVoxelByDataType: Record<string, number> = {
  Uint8Array: 1,
  Int8Array: 1,
  Uint16Array: 2,
  Int16Array: 2,
  Uint32Array: 4,
  Int32Array: 4,
  Float32Array: 4,
  Float64Array: 8,
};

/**
 * 2026-09-09 功能说明：安全读取体积字节数；流式体积尚未创建体素管理器时，
 * sizeInBytes getter 可能抛错，此时使用尺寸和数据类型估算。
 */
function getVolumeRawBytes(volume, estimatedBytes: number): number {
  try {
    const sizeInBytes = volume?.sizeInBytes;
    return Number.isFinite(sizeInBytes) ? sizeInBytes : estimatedBytes;
  } catch {
    return estimatedBytes;
  }
}

/**
 * 2026-09-09 功能说明：发布不含 Cornerstone 对象引用的体积内存快照，
 * 用于 production 环境定位重复体积和超大纹理。
 */
function publishVolumeMemoryStats(volumes) {
  const viewportIdsByVolumeId = new Map<string, Set<string>>();

  viewportIdVolumeInputArrayMap.forEach((volumeInputs, viewportId) => {
    volumeInputs.forEach((volumeInput: { volumeId?: string }) => {
      if (!volumeInput?.volumeId) return;

      const viewportIds = viewportIdsByVolumeId.get(volumeInput.volumeId) ?? new Set<string>();
      viewportIds.add(viewportId);
      viewportIdsByVolumeId.set(volumeInput.volumeId, viewportIds);
    });
  });

  const volumeStats = volumes.filter(Boolean).map(volume => {
    const dimensions = Array.from(volume.dimensions ?? [], Number);
    const dataType = volume.dataType ?? 'unknown';
    const voxelCount = dimensions.reduce((total, value) => total * value, 1);
    const metadataBytesPerVoxel = Number(volume.metadata?.BitsAllocated) / 8;
    const bytesPerVoxel =
      bytesPerVoxelByDataType[dataType] ??
      (Number.isFinite(metadataBytesPerVoxel) ? metadataBytesPerVoxel : 0);
    const estimatedBytes = voxelCount * bytesPerVoxel;
    const rawBytes = getVolumeRawBytes(volume, estimatedBytes);

    return {
      volumeId: String(volume.volumeId),
      modality: String(volume.metadata?.Modality ?? ''),
      dimensions,
      dataType: String(dataType),
      imageCount: volume.imageIds?.length ?? 0,
      rawMB: Number((rawBytes / 1024 / 1024).toFixed(1)),
      viewportIds: Array.from(viewportIdsByVolumeId.get(volume.volumeId) ?? []),
    };
  });

  memoryStatsTarget.__tmtvVolumeMemoryStats = {
    generatedAt: new Date().toISOString(),
    uniqueVolumeCount: volumeStats.length,
    totalRawMB: Number(
      volumeStats.reduce((total, volume) => total + volume.rawMB, 0).toFixed(1)
    ),
    volumes: volumeStats,
  };
}

/**
 * Clears module-level Maps that hold volume/viewport references.
 * Called on mode exit to prevent references to volumes and volume input
 * arrays from being retained after the viewer is closed.
 */
export function clearLoaderCache() {
  volumeIdMapsToLoad.clear();
  viewportIdVolumeInputArrayMap.clear();
  delete memoryStatsTarget.__tmtvVolumeMemoryStats;
}

/**
 * This function caches the volumeIds until all the volumes inside the
 * hanging protocol are initialized. Then it goes through the imageIds
 * of the volumes, and interleave them, in order for the volumes to be loaded
 * together from middle to the start and the end.
 * @param {Object} {viewportData, displaySetMatchDetails}
 * @returns
 */
export default function interleaveTopToBottom({
  data: { viewportId, volumeInputArray },
  displaySetsMatchDetails,
  viewportMatchDetails: matchDetails,
}) {
  viewportIdVolumeInputArrayMap.set(viewportId, volumeInputArray);

  // Based on the volumeInputs store the volumeIds and SeriesInstanceIds
  // to keep track of the volumes being loaded
  for (const volumeInput of volumeInputArray) {
    const { volumeId } = volumeInput;
    const volume = cache.getVolume(volumeId);

    if (!volume) {
      return;
    }

    // if the volumeUID is not in the volumeUIDs array, add it
    if (!volumeIdMapsToLoad.has(volumeId)) {
      const { metadata } = volume;
      volumeIdMapsToLoad.set(volumeId, metadata.SeriesInstanceUID);
    }
  }

  /**
   * The following is checking if all the viewports that were matched in the HP has been
   * successfully created their cornerstone viewport or not. Todo: This can be
   * improved by not checking it, and as soon as the matched DisplaySets have their
   * volume loaded, we start the loading, but that comes at the cost of viewports
   * not being created yet (e.g., in a 10 viewport ptCT fusion, when one ct viewport and one
   * pt viewport are created we have a guarantee that the volumes are created in the cache
   * but the rest of the viewports (fusion, mip etc.) are not created yet. So
   * we can't initiate setting the volumes for those viewports. One solution can be
   * to add an event when a viewport is created (not enabled element event) and then
   * listen to it and as the other viewports are created we can set the volumes for them
   * since volumes are already started loading.
   */
  const uniqueViewportVolumeDisplaySetUIDs = new Set();
  viewportIdVolumeInputArrayMap.forEach((volumeInputArray, viewportId) => {
    volumeInputArray.forEach(volumeInput => {
      const { volumeId } = volumeInput;
      uniqueViewportVolumeDisplaySetUIDs.add(volumeId);
    });
  });

  const uniqueMatchedDisplaySetUIDs = new Set();

  matchDetails.forEach(matchDetail => {
    const { displaySetsInfo } = matchDetail;
    displaySetsInfo.forEach(({ displaySetInstanceUID }) => {
      uniqueMatchedDisplaySetUIDs.add(displaySetInstanceUID);
    });
  });

  if (uniqueViewportVolumeDisplaySetUIDs.size !== uniqueMatchedDisplaySetUIDs.size) {
    return;
  }

  const volumeIds = Array.from(volumeIdMapsToLoad.keys()).slice();
  // get volumes from cache
  const volumes = volumeIds.map(volumeId => {
    return cache.getVolume(volumeId);
  });

  try {
    publishVolumeMemoryStats(volumes);
  } catch (error) {
    delete memoryStatsTarget.__tmtvVolumeMemoryStats;
    console.warn('[TMTV] Failed to collect volume memory stats', error);
  }

  // iterate over all volumes, and get their imageIds, and interleave
  // the imageIds and save them in AllRequests for later use
  const AllRequests = [];
  volumes.forEach(volume => {
    const requests = volume.getImageLoadRequests?.() ?? [];

    if (!requests?.[0]?.imageId) {
      return;
    }

    // reverse the requests
    AllRequests.push(requests.reverse());
  });

  // flatten the AllRequests array, which will result in a list of all the
  // imageIds for all the volumes but interleaved
  const interleavedRequests = compact(flatten(zip(...AllRequests)));

  // set the finalRequests to the imageLoadPoolManager
  const finalRequests = [];
  interleavedRequests.forEach(request => {
    const { imageId } = request;

    AllRequests.forEach(volumeRequests => {
      const volumeImageIdRequest = volumeRequests.find(req => req.imageId === imageId);
      if (volumeImageIdRequest) {
        finalRequests.push(volumeImageIdRequest);
      }
    });
  });

  const requestType = Enums.RequestType.Prefetch;
  const priority = 0;

  finalRequests.forEach(({ callLoadImage, additionalDetails, imageId, imageIdIndex, options }) => {
    const callLoadImageBound = callLoadImage.bind(null, imageId, imageIdIndex, options);

    imageLoadPoolManager.addRequest(callLoadImageBound, requestType, additionalDetails, priority);
  });

  // clear the volumeIdMapsToLoad
  volumeIdMapsToLoad.clear();

  // copy the viewportIdVolumeInputArrayMap
  const viewportIdVolumeInputArrayMapCopy = new Map(viewportIdVolumeInputArrayMap);

  // reset the viewportIdVolumeInputArrayMap
  viewportIdVolumeInputArrayMap.clear();

  return viewportIdVolumeInputArrayMapCopy;
}
