import { cache } from '@cornerstonejs/core';
import * as csTools from '@cornerstonejs/tools';

type NumericArray = ArrayLike<number>;

export type TMTVLesionStatistics = {
  volume: number;
  suvMin: number | null;
  suvMax: number | null;
  suvMean: number | null;
  tlg: number | null;
  centroid: [number, number, number];
  centroidIJK: [number, number, number];
  boundsIJK: {
    min: [number, number, number];
    max: [number, number, number];
  };
};

export type TMTVPatientTotals = {
  tmtv: number;
  tlg: number | null;
};

export type TMTVLesionForPatientTotals = {
  status?: string;
  volume: number;
  tlg: number | null;
};

type ComputeLesionStatisticsInput = {
  voxelIndices: number[];
  dimensions: [number, number, number];
  segmentationVolume;
  segmentationVolumeId: string;
};

export function computeLesionStatisticsForComponent({
  voxelIndices,
  dimensions,
  segmentationVolume,
  segmentationVolumeId,
}: ComputeLesionStatisticsInput): TMTVLesionStatistics {
  // [2026-08-25 功能] 第三阶段集中计算病灶级 Volume/SUV/TLG/空间信息，供 Lesion 管理、患者级定量和后续报告复用
  const referenceVolume = getReferenceVolume(segmentationVolumeId);
  const suvScalarData = getScalarData(referenceVolume);
  const spacing = getSpacing(referenceVolume) ?? getSpacing(segmentationVolume);
  const voxelVolume = getVoxelVolumeInML(spacing);
  const suvStats = computeSUVStats(voxelIndices, suvScalarData);
  const volume = voxelIndices.length * voxelVolume;
  const centroidIJK = computeCentroidIJK(voxelIndices, dimensions);
  const boundsIJK = computeBoundsIJK(voxelIndices, dimensions);
  const centroid = transformIndexToWorld(referenceVolume ?? segmentationVolume, centroidIJK);

  return {
    volume,
    suvMin: suvStats.suvMin,
    suvMax: suvStats.suvMax,
    suvMean: suvStats.suvMean,
    tlg: suvStats.suvMean === null ? null : suvStats.suvMean * volume,
    centroid,
    centroidIJK,
    boundsIJK,
  };
}

export function computePatientTotals(
  lesions: TMTVLesionForPatientTotals[],
  includedStatus = 'confirmed'
): TMTVPatientTotals {
  // [2026-08-25 功能] 第三阶段患者级 TMTV/TLG 明确只汇总最终纳入的 confirmed lesions
  const includedLesions = lesions.filter(lesion => lesion.status === includedStatus);
  const tmtv = includedLesions.reduce((sum, lesion) => sum + lesion.volume, 0);
  const hasTLG = includedLesions.some(lesion => lesion.tlg !== null);
  const tlg = includedLesions.reduce(
    (sum, lesion) => (lesion.tlg === null ? sum : sum + lesion.tlg),
    0
  );

  return {
    tmtv,
    tlg: includedLesions.length ? (hasTLG ? tlg : null) : 0,
  };
}

export function getCachedVolume(volumeId: string) {
  try {
    return cache.getVolume(volumeId);
  } catch (error) {
    return null;
  }
}

export function getScalarData(volume): NumericArray | null {
  return (
    volume?.voxelManager?.getCompleteScalarDataArray?.() ??
    volume?.voxelManager?.getScalarData?.() ??
    volume?.scalarData ??
    null
  );
}

export function getDimensions(volume): [number, number, number] | null {
  const dimensions = volume?.dimensions ?? volume?.imageData?.getDimensions?.();

  if (!dimensions || dimensions.length < 3) {
    return null;
  }

  return [dimensions[0], dimensions[1], dimensions[2]];
}

function getSpacing(volume): [number, number, number] | null {
  const spacing = volume?.spacing ?? volume?.imageData?.getSpacing?.();

  if (!spacing || spacing.length < 3) {
    return null;
  }

  return [spacing[0], spacing[1], spacing[2]];
}

function getVoxelVolumeInML(spacing: [number, number, number] | null): number {
  if (!spacing) {
    return 0;
  }

  return Math.abs(spacing[0] * spacing[1] * spacing[2]) / 1000;
}

function getReferenceVolume(segmentationVolumeId: string) {
  try {
    return csTools.utilities.segmentation.getReferenceVolumeForSegmentationVolume(
      segmentationVolumeId
    );
  } catch (error) {
    return null;
  }
}

function computeSUVStats(voxelIndices: number[], scalarData: NumericArray | null) {
  if (!scalarData) {
    return {
      suvMin: null,
      suvMax: null,
      suvMean: null,
    };
  }

  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let count = 0;

  voxelIndices.forEach(voxelIndex => {
    const value = scalarData[voxelIndex];

    if (typeof value !== 'number' || Number.isNaN(value)) {
      return;
    }

    if (value < min) {
      min = value;
    }

    if (value > max) {
      max = value;
    }

    sum += value;
    count++;
  });

  if (!count) {
    return {
      suvMin: null,
      suvMax: null,
      suvMean: null,
    };
  }

  return {
    suvMin: min,
    suvMax: max,
    suvMean: sum / count,
  };
}

function computeCentroidIJK(
  voxelIndices: number[],
  dimensions: [number, number, number]
): [number, number, number] {
  const [dimX, dimY] = dimensions;
  const sliceSize = dimX * dimY;
  let sumX = 0;
  let sumY = 0;
  let sumZ = 0;

  voxelIndices.forEach(voxelIndex => {
    const z = Math.floor(voxelIndex / sliceSize);
    const remainder = voxelIndex - z * sliceSize;
    const y = Math.floor(remainder / dimX);
    const x = remainder - y * dimX;

    sumX += x;
    sumY += y;
    sumZ += z;
  });

  const count = voxelIndices.length || 1;

  return [sumX / count, sumY / count, sumZ / count];
}

function computeBoundsIJK(
  voxelIndices: number[],
  dimensions: [number, number, number]
): { min: [number, number, number]; max: [number, number, number] } {
  const [dimX, dimY] = dimensions;
  const sliceSize = dimX * dimY;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  voxelIndices.forEach(voxelIndex => {
    const z = Math.floor(voxelIndex / sliceSize);
    const remainder = voxelIndex - z * sliceSize;
    const y = Math.floor(remainder / dimX);
    const x = remainder - y * dimX;

    min[0] = Math.min(min[0], x);
    min[1] = Math.min(min[1], y);
    min[2] = Math.min(min[2], z);
    max[0] = Math.max(max[0], x);
    max[1] = Math.max(max[1], y);
    max[2] = Math.max(max[2], z);
  });

  return { min, max };
}

function transformIndexToWorld(volume, ijk: [number, number, number]): [number, number, number] {
  const imageData = volume?.imageData;

  if (imageData?.indexToWorld) {
    return imageData.indexToWorld(ijk);
  }

  const origin = volume?.origin ?? imageData?.getOrigin?.() ?? [0, 0, 0];
  const spacing = getSpacing(volume) ?? [1, 1, 1];
  const direction = volume?.direction ?? imageData?.getDirection?.();

  if (!direction || direction.length < 9) {
    return [
      origin[0] + ijk[0] * spacing[0],
      origin[1] + ijk[1] * spacing[1],
      origin[2] + ijk[2] * spacing[2],
    ];
  }

  const scaledI = ijk[0] * spacing[0];
  const scaledJ = ijk[1] * spacing[1];
  const scaledK = ijk[2] * spacing[2];

  return [
    origin[0] + direction[0] * scaledI + direction[3] * scaledJ + direction[6] * scaledK,
    origin[1] + direction[1] * scaledI + direction[4] * scaledJ + direction[7] * scaledK,
    origin[2] + direction[2] * scaledI + direction[5] * scaledJ + direction[8] * scaledK,
  ];
}
