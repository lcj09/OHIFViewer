export type PhysiologicalUptakeCategory =
  | 'brain'
  | 'liver'
  | 'urinaryBladder'
  | 'renalPair';

export type PhysiologicalUptakeSuggestion = {
  category: PhysiologicalUptakeCategory;
  confidence: 'high';
};

type LesionLike = {
  id: string;
  centroid: [number, number, number];
  volume: number;
  suvMax: number | null;
  suvMean: number | null;
};

type WorldBounds = [number, number, number, number, number, number];

/** 2026-09-23 功能说明：以保守空间规则提示典型脑、整肝、膀胱和双肾样摄取，仅供审核，不删除 mask。 */
export default function classifyPhysiologicalUptake(
  lesions: LesionLike[],
  worldBounds: WorldBounds | null | undefined
): Map<string, PhysiologicalUptakeSuggestion> {
  const suggestions = new Map<string, PhysiologicalUptakeSuggestion>();

  if (!Array.isArray(lesions) || !hasValidBounds(worldBounds)) {
    return suggestions;
  }

  const normalizedLesions = lesions
    .map(lesion => ({ lesion, point: normalizePoint(lesion.centroid, worldBounds) }))
    .filter(({ lesion, point }) => isUsableLesion(lesion) && point !== null) as Array<{
    lesion: LesionLike;
    point: [number, number, number];
  }>;

  normalizedLesions.forEach(({ lesion, point }) => {
    const [x, , z] = point;
    const suvMax = lesion.suvMax ?? 0;
    const suvMean = lesion.suvMean ?? 0;

    if (z >= 0.9 && x >= 0.2 && x <= 0.8 && lesion.volume >= 10 && suvMean >= 4) {
      suggestions.set(lesion.id, { category: 'brain', confidence: 'high' });
      return;
    }

    // 2026-09-23 功能说明：仅提示右上腹、器官量级且摄取较均匀的整肝样区域，
    // 小体积或 SUVmax 明显升高的局灶不套用此规则，避免遮蔽肝内真实病灶。
    if (
      z >= 0.48 &&
      z <= 0.78 &&
      x >= 0.08 &&
      x <= 0.58 &&
      lesion.volume >= 250 &&
      suvMean >= 1.5 &&
      suvMean <= 5.5 &&
      suvMax <= 8.5
    ) {
      suggestions.set(lesion.id, { category: 'liver', confidence: 'high' });
      return;
    }

    if (z <= 0.18 && x >= 0.35 && x <= 0.65 && lesion.volume >= 5 && suvMax >= 6) {
      suggestions.set(lesion.id, { category: 'urinaryBladder', confidence: 'high' });
    }
  });

  const renalCandidates = normalizedLesions.filter(({ lesion, point }) => {
    const [x, , z] = point;
    return (
      z >= 0.35 &&
      z <= 0.65 &&
      (x <= 0.44 || x >= 0.56) &&
      lesion.volume >= 1 &&
      lesion.volume <= 150 &&
      (lesion.suvMax ?? 0) >= 4
    );
  });

  for (let index = 0; index < renalCandidates.length; index++) {
    const left = renalCandidates[index];

    for (let otherIndex = index + 1; otherIndex < renalCandidates.length; otherIndex++) {
      const right = renalCandidates[otherIndex];
      const onOppositeSides = (left.point[0] < 0.5) !== (right.point[0] < 0.5);

      if (
        !onOppositeSides ||
        Math.abs(left.point[2] - right.point[2]) > 0.07 ||
        Math.abs(left.point[1] - right.point[1]) > 0.15 ||
        getRatio(left.lesion.volume, right.lesion.volume) > 3 ||
        getRatio(left.lesion.suvMax ?? 0, right.lesion.suvMax ?? 0) > 3
      ) {
        continue;
      }

      suggestions.set(left.lesion.id, { category: 'renalPair', confidence: 'high' });
      suggestions.set(right.lesion.id, { category: 'renalPair', confidence: 'high' });
    }
  }

  return suggestions;
}

function hasValidBounds(bounds: WorldBounds | null | undefined): bounds is WorldBounds {
  return (
    Array.isArray(bounds) &&
    bounds.length === 6 &&
    bounds.every(Number.isFinite) &&
    bounds[1] > bounds[0] &&
    bounds[3] > bounds[2] &&
    bounds[5] > bounds[4]
  );
}

function normalizePoint(
  point: [number, number, number],
  bounds: WorldBounds
): [number, number, number] | null {
  if (!Array.isArray(point) || point.length < 3 || !point.every(Number.isFinite)) {
    return null;
  }

  return [
    (point[0] - bounds[0]) / (bounds[1] - bounds[0]),
    (point[1] - bounds[2]) / (bounds[3] - bounds[2]),
    (point[2] - bounds[4]) / (bounds[5] - bounds[4]),
  ];
}

function isUsableLesion(lesion: LesionLike): boolean {
  return (
    !!lesion?.id &&
    Number.isFinite(lesion.volume) &&
    lesion.volume > 0 &&
    (lesion.suvMax === null || Number.isFinite(lesion.suvMax)) &&
    (lesion.suvMean === null || Number.isFinite(lesion.suvMean))
  );
}

function getRatio(first: number, second: number): number {
  const smaller = Math.min(first, second);
  const larger = Math.max(first, second);

  return smaller > 0 ? larger / smaller : Infinity;
}
