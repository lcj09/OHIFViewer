import extractConnectedComponents from './extractConnectedComponents';

export type AutoSegmentBySUVThresholdOptions = {
  suvScalarData: ArrayLike<number> | null | undefined;
  dimensions: [number, number, number] | null | undefined;
  spacing: [number, number, number] | null | undefined;
  threshold?: number;
  minVolumeML?: number;
  segmentIndex?: number;
};

export type AutoSegmentBySUVThresholdResult = {
  threshold: number;
  minVolumeML: number;
  voxelVolumeML: number;
  candidateVoxelIndices: number[];
  voxelIndices: number[];
  candidateVoxelCount: number;
  voxelCount: number;
  componentCount: number;
  keptComponentCount: number;
  filteredComponentCount: number;
  skippedNonFiniteVoxelCount: number;
};

export default function autoSegmentBySUVThreshold({
  suvScalarData,
  dimensions,
  spacing,
  threshold = 2.5,
  minVolumeML = 0.1,
  segmentIndex = 1,
}: AutoSegmentBySUVThresholdOptions): AutoSegmentBySUVThresholdResult {
  // [2026-08-26 功能] 全身 SUV 阈值自动分割：生成候选 mask 并按物理体积过滤小连通域，写入动作交给 TMTVAutoSegmentationService
  const normalizedThreshold = normalizeFiniteNumber(threshold, 2.5);
  const normalizedMinVolumeML = Math.max(0, normalizeFiniteNumber(minVolumeML, 0.1));
  const voxelVolumeML = getVoxelVolumeInML(spacing);
  const emptyResult = createEmptyResult({
    threshold: normalizedThreshold,
    minVolumeML: normalizedMinVolumeML,
    voxelVolumeML,
  });
  const voxelCount = getVoxelCount(dimensions);

  if (!suvScalarData || voxelCount <= 0 || suvScalarData.length < voxelCount) {
    return emptyResult;
  }

  if (normalizedMinVolumeML > 0 && voxelVolumeML <= 0) {
    return emptyResult;
  }

  const candidateMask = new Uint8Array(voxelCount);
  const candidateVoxelIndices: number[] = [];
  let skippedNonFiniteVoxelCount = 0;

  for (let voxelIndex = 0; voxelIndex < voxelCount; voxelIndex++) {
    const suv = suvScalarData[voxelIndex];

    if (!Number.isFinite(suv)) {
      skippedNonFiniteVoxelCount++;
      continue;
    }

    if (suv >= normalizedThreshold) {
      candidateMask[voxelIndex] = segmentIndex;
      candidateVoxelIndices.push(voxelIndex);
    }
  }

  if (!candidateVoxelIndices.length) {
    return {
      ...emptyResult,
      skippedNonFiniteVoxelCount,
    };
  }

  const components = extractConnectedComponents({
    scalarData: candidateMask,
    dimensions,
    segmentIndex,
  });
  const minVoxelCount =
    normalizedMinVolumeML > 0 ? Math.ceil(normalizedMinVolumeML / voxelVolumeML) : 1;
  const keptComponents = components.filter(
    component => component.voxelIndices.length >= minVoxelCount
  );
  const voxelIndices = keptComponents.flatMap(component => component.voxelIndices);

  return {
    threshold: normalizedThreshold,
    minVolumeML: normalizedMinVolumeML,
    voxelVolumeML,
    candidateVoxelIndices,
    voxelIndices,
    candidateVoxelCount: candidateVoxelIndices.length,
    voxelCount: voxelIndices.length,
    componentCount: components.length,
    keptComponentCount: keptComponents.length,
    filteredComponentCount: components.length - keptComponents.length,
    skippedNonFiniteVoxelCount,
  };
}

function createEmptyResult({
  threshold,
  minVolumeML,
  voxelVolumeML,
}: {
  threshold: number;
  minVolumeML: number;
  voxelVolumeML: number;
}): AutoSegmentBySUVThresholdResult {
  return {
    threshold,
    minVolumeML,
    voxelVolumeML,
    candidateVoxelIndices: [],
    voxelIndices: [],
    candidateVoxelCount: 0,
    voxelCount: 0,
    componentCount: 0,
    keptComponentCount: 0,
    filteredComponentCount: 0,
    skippedNonFiniteVoxelCount: 0,
  };
}

function getVoxelCount(dimensions: [number, number, number] | null | undefined): number {
  if (!dimensions || dimensions.length < 3) {
    return 0;
  }

  const [dimX, dimY, dimZ] = dimensions;

  if (![dimX, dimY, dimZ].every(dimension => Number.isInteger(dimension) && dimension > 0)) {
    return 0;
  }

  return dimX * dimY * dimZ;
}

function getVoxelVolumeInML(spacing: [number, number, number] | null | undefined): number {
  if (!spacing || spacing.length < 3) {
    return 0;
  }

  const [spacingX, spacingY, spacingZ] = spacing;

  if (![spacingX, spacingY, spacingZ].every(value => Number.isFinite(value) && value !== 0)) {
    return 0;
  }

  return Math.abs(spacingX * spacingY * spacingZ) / 1000;
}

function normalizeFiniteNumber(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}
