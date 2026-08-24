import { cache } from '@cornerstonejs/core';
import * as csTools from '@cornerstonejs/tools';
import extractConnectedComponents from '../utils/extractConnectedComponents';

const { SegmentationRepresentations } = csTools.Enums;

type NumericArray = ArrayLike<number>;

export type TMTVLesion = {
  id: string;
  lesionNumber: number;
  segmentationId: string;
  segmentIndex: number;
  voxelIndices: number[];
  voxelCount: number;
  volume: number;
  suvMax: number | null;
  suvMean: number | null;
  tlg: number | null;
  centroid: [number, number, number];
  centroidIJK: [number, number, number];
};

export type TMTVLesionState = {
  segmentationIds: string[];
  segmentIndex: number;
  lesions: TMTVLesion[];
  totals: {
    tmtv: number;
    tlg: number | null;
  };
  updatedAt: number;
};

type Subscription = {
  unsubscribe: () => void;
};

const EMPTY_STATE: TMTVLesionState = {
  segmentationIds: [],
  segmentIndex: 1,
  lesions: [],
  totals: {
    tmtv: 0,
    tlg: null,
  },
  updatedAt: 0,
};

class TMTVLesionService {
  private stateByGroupId = new Map<string, TMTVLesionState>();
  private listeners = new Set<() => void>();

  public subscribe(listener: () => void): Subscription {
    this.listeners.add(listener);

    return {
      unsubscribe: () => {
        this.listeners.delete(listener);
      },
    };
  }

  public getState(segmentationIds: string[] = []): TMTVLesionState {
    const groupId = this.getGroupId(segmentationIds);
    return (
      this.stateByGroupId.get(groupId) ?? {
        ...EMPTY_STATE,
        segmentationIds: [...segmentationIds],
      }
    );
  }

  public extractLesionsForSegmentations(
    segmentations: any[] = [],
    segmentIndex = 1
  ): TMTVLesionState {
    const segmentationIds = segmentations
      .map(segmentation => segmentation?.segmentationId)
      .filter(Boolean);
    const lesions: TMTVLesion[] = [];

    segmentations.forEach(segmentation => {
      lesions.push(...this.extractLesionsForSegmentation(segmentation, segmentIndex));
    });

    lesions.forEach((lesion, index) => {
      lesion.lesionNumber = index + 1;
    });

    const totalTMTV = lesions.reduce((sum, lesion) => sum + lesion.volume, 0);
    const totalTLG = lesions.reduce(
      (sum, lesion) => (lesion.tlg === null ? sum : sum + lesion.tlg),
      0
    );
    const hasTLG = lesions.some(lesion => lesion.tlg !== null);

    const state: TMTVLesionState = {
      segmentationIds,
      segmentIndex,
      lesions,
      totals: {
        tmtv: totalTMTV,
        tlg: hasTLG ? totalTLG : null,
      },
      updatedAt: Date.now(),
    };

    this.stateByGroupId.set(this.getGroupId(segmentationIds), state);
    this.notify();

    return state;
  }

  public reset(segmentationIds?: string[]): void {
    if (segmentationIds?.length) {
      this.stateByGroupId.delete(this.getGroupId(segmentationIds));
    } else {
      this.stateByGroupId.clear();
    }

    this.notify();
  }

  private extractLesionsForSegmentation(segmentation: any, segmentIndex: number): TMTVLesion[] {
    const segmentationId = segmentation?.segmentationId;
    const labelmapData =
      segmentation?.representationData?.[SegmentationRepresentations.Labelmap] ??
      segmentation?.representationData?.Labelmap;
    const segmentationVolumeId = labelmapData?.volumeId;

    if (!segmentationId || !segmentationVolumeId) {
      return [];
    }

    const segmentationVolume = getCachedVolume(segmentationVolumeId);
    const labelmapScalarData = getScalarData(segmentationVolume);
    const dimensions = getDimensions(segmentationVolume);

    if (!labelmapScalarData || !dimensions) {
      return [];
    }

    const referenceVolume = getReferenceVolume(segmentationVolumeId);
    const suvScalarData = getScalarData(referenceVolume);
    const spacing = getSpacing(referenceVolume) ?? getSpacing(segmentationVolume);
    const voxelVolume = getVoxelVolumeInML(spacing);
    const components = extractConnectedComponents({
      scalarData: labelmapScalarData,
      dimensions,
      segmentIndex,
    });

    return components.map((component, componentIndex) => {
      const stats = computeSUVStats(component.voxelIndices, suvScalarData);
      const volume = component.voxelIndices.length * voxelVolume;
      const centroidIJK = computeCentroidIJK(component.voxelIndices, dimensions);
      const centroid = transformIndexToWorld(referenceVolume ?? segmentationVolume, centroidIJK);

      return {
        id: `${segmentationId}:${segmentIndex}:${componentIndex + 1}`,
        lesionNumber: componentIndex + 1,
        segmentationId,
        segmentIndex,
        voxelIndices: component.voxelIndices,
        voxelCount: component.voxelIndices.length,
        volume,
        suvMax: stats.suvMax,
        suvMean: stats.suvMean,
        tlg: stats.suvMean === null ? null : stats.suvMean * volume,
        centroid,
        centroidIJK,
      };
    });
  }

  private getGroupId(segmentationIds: string[]): string {
    return [...segmentationIds].sort().join(',');
  }

  private notify(): void {
    this.listeners.forEach(listener => listener());
  }
}

function getScalarData(volume): NumericArray | null {
  return (
    volume?.voxelManager?.getCompleteScalarDataArray?.() ??
    volume?.voxelManager?.getScalarData?.() ??
    volume?.scalarData ??
    null
  );
}

function getCachedVolume(volumeId: string) {
  try {
    return cache.getVolume(volumeId);
  } catch (error) {
    return null;
  }
}

function getDimensions(volume): [number, number, number] | null {
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
      suvMax: null,
      suvMean: null,
    };
  }

  let max = -Infinity;
  let sum = 0;
  let count = 0;

  voxelIndices.forEach(voxelIndex => {
    const value = scalarData[voxelIndex];

    if (typeof value !== 'number' || Number.isNaN(value)) {
      return;
    }

    if (value > max) {
      max = value;
    }

    sum += value;
    count++;
  });

  if (!count) {
    return {
      suvMax: null,
      suvMean: null,
    };
  }

  return {
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

const tmtvLesionService = new TMTVLesionService();

export default tmtvLesionService;
