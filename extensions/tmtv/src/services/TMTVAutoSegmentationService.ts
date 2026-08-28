import * as csTools from '@cornerstonejs/tools';
import autoSegmentBySUVThreshold, {
  AutoSegmentBySUVThresholdResult,
} from '../utils/autoSegmentBySUVThreshold';
import { getDimensions, getScalarData } from './TMTVStatisticsService';

export type TMTVAutoSegmentationWriteMode = 'overwrite' | 'append';

export type TMTVAutoSegmentationResult = AutoSegmentBySUVThresholdResult & {
  segmentationId: string;
  segmentIndex: number;
  writeMode: TMTVAutoSegmentationWriteMode;
  changedVoxelCount: number;
  clearedVoxelCount: number;
  skippedOccupiedVoxelCount: number;
  modifiedSlices?: number[];
};

type RunSUVThresholdSegmentationOptions = {
  segmentationId: string;
  segmentationVolume: any;
  referenceVolume: any;
  segmentIndex?: number;
  threshold?: number;
  minVolumeML?: number;
  writeMode?: TMTVAutoSegmentationWriteMode;
};

class TMTVAutoSegmentationService {
  public runSUVThresholdSegmentation({
    segmentationId,
    segmentationVolume,
    referenceVolume,
    segmentIndex = 1,
    threshold = 2.5,
    minVolumeML = 0.1,
    writeMode = 'overwrite',
  }: RunSUVThresholdSegmentationOptions): TMTVAutoSegmentationResult {
    // [2026-08-26 功能] 全身 SUV 自动分割：只写入 Segment 1，并通过 segmentation modified 复用现有 Lesion candidate 重建链路
    const labelmapScalarData = getScalarData(segmentationVolume);
    const suvScalarData = getScalarData(referenceVolume);
    const dimensions = getDimensions(segmentationVolume);
    const referenceDimensions = getDimensions(referenceVolume);
    const spacing = getSpacing(referenceVolume) ?? getSpacing(segmentationVolume);

    if (!segmentationId || !segmentationVolume || !referenceVolume) {
      throw new Error('Auto segmentation requires a Segment 1 labelmap and PT reference volume.');
    }

    if (!labelmapScalarData || !suvScalarData || !dimensions || !referenceDimensions) {
      throw new Error('Auto segmentation could not read volume scalar data or dimensions.');
    }

    if (!haveSameDimensions(dimensions, referenceDimensions)) {
      throw new Error(
        'Auto segmentation requires the PT volume and Segment 1 labelmap dimensions to match.'
      );
    }

    if (minVolumeML > 0 && !hasValidSpacing(spacing)) {
      throw new Error(
        'Auto segmentation requires valid PT spacing when minimum volume filtering is enabled.'
      );
    }

    const thresholdResult = autoSegmentBySUVThreshold({
      suvScalarData,
      dimensions,
      spacing,
      threshold,
      minVolumeML,
      segmentIndex,
    });
    const writeResult = this.writeSegmentMask({
      segmentationVolume,
      scalarData: labelmapScalarData,
      dimensions,
      segmentIndex,
      voxelIndices: thresholdResult.voxelIndices,
      writeMode,
    });

    if (writeResult.changedVoxelCount > 0) {
      segmentationVolume.modified?.();
      csTools.segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(
        segmentationId,
        writeResult.modifiedSlices,
        segmentIndex
      );
    }

    return {
      ...this.releaseThresholdVoxelArrays(thresholdResult),
      segmentationId,
      segmentIndex,
      writeMode,
      ...writeResult,
    };
  }

  private releaseThresholdVoxelArrays(
    thresholdResult: AutoSegmentBySUVThresholdResult
  ): AutoSegmentBySUVThresholdResult {
    // [2026-08-28 功能] 自动分割写入后 UI 只需要统计摘要，避免把候选/写入 voxel 下标大数组跨命令返回并延长保留时间
    return {
      ...thresholdResult,
      candidateVoxelIndices: [],
      voxelIndices: [],
    };
  }

  private writeSegmentMask({
    segmentationVolume,
    scalarData,
    dimensions,
    segmentIndex,
    voxelIndices,
    writeMode,
  }: {
    segmentationVolume: any;
    scalarData: ArrayLike<number>;
    dimensions: [number, number, number];
    segmentIndex: number;
    voxelIndices: number[];
    writeMode: TMTVAutoSegmentationWriteMode;
  }): {
    changedVoxelCount: number;
    clearedVoxelCount: number;
    skippedOccupiedVoxelCount: number;
    modifiedSlices?: number[];
  } {
    const changedVoxelIndices: number[] = [];
    let clearedVoxelCount = 0;
    let skippedOccupiedVoxelCount = 0;

    if (writeMode === 'overwrite') {
      for (let voxelIndex = 0; voxelIndex < scalarData.length; voxelIndex++) {
        if (scalarData[voxelIndex] !== segmentIndex) {
          continue;
        }

        setScalarValue(segmentationVolume, scalarData, voxelIndex, 0);
        changedVoxelIndices.push(voxelIndex);
        clearedVoxelCount++;
      }
    }

    voxelIndices.forEach(voxelIndex => {
      if (voxelIndex < 0 || voxelIndex >= scalarData.length) {
        return;
      }

      const currentValue = scalarData[voxelIndex];

      if (currentValue === segmentIndex) {
        return;
      }

      if (currentValue !== 0) {
        skippedOccupiedVoxelCount++;
        return;
      }

      setScalarValue(segmentationVolume, scalarData, voxelIndex, segmentIndex);
      changedVoxelIndices.push(voxelIndex);
    });

    return {
      changedVoxelCount: changedVoxelIndices.length,
      clearedVoxelCount,
      skippedOccupiedVoxelCount,
      modifiedSlices: getModifiedSlices(changedVoxelIndices, dimensions),
    };
  }
}

function getSpacing(volume): [number, number, number] | null {
  const spacing = volume?.spacing ?? volume?.imageData?.getSpacing?.();

  if (!spacing || spacing.length < 3) {
    return null;
  }

  return [spacing[0], spacing[1], spacing[2]];
}

function hasValidSpacing(spacing: [number, number, number] | null): boolean {
  return !!spacing && spacing.every(value => Number.isFinite(value) && value !== 0);
}

function haveSameDimensions(
  firstDimensions: [number, number, number],
  secondDimensions: [number, number, number]
): boolean {
  return firstDimensions.every((dimension, index) => dimension === secondDimensions[index]);
}

function setScalarValue(
  volume,
  scalarData: ArrayLike<number>,
  voxelIndex: number,
  value: number
): void {
  if (volume?.voxelManager?.setAtIndex) {
    volume.voxelManager.setAtIndex(voxelIndex, value);
    return;
  }

  (scalarData as number[])[voxelIndex] = value;
}

function getModifiedSlices(
  voxelIndices: number[],
  dimensions: [number, number, number] | null
): number[] | undefined {
  if (!dimensions || !voxelIndices.length) {
    return;
  }

  const sliceSize = dimensions[0] * dimensions[1];
  return Array.from(new Set(voxelIndices.map(voxelIndex => Math.floor(voxelIndex / sliceSize))));
}

const tmtvAutoSegmentationService = new TMTVAutoSegmentationService();

export default tmtvAutoSegmentationService;
