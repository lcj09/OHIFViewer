export type TMTVComparisonPatientIdentity = {
  status: 'same' | 'different' | 'unknown';
  baselinePatientId: string | null;
  followupPatientId: string | null;
};

const normalizeValue = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
};

const getDisplaySetInstance = displaySet => displaySet?.instances?.[0] || displaySet?.instance;

const getPatientIdForStudy = (displaySets: any[], studyInstanceUID?: string | null) => {
  if (!studyInstanceUID) return null;
  const patientIds = new Set<string>();

  (displaySets || []).forEach(displaySet => {
    const instance = getDisplaySetInstance(displaySet);
    const displaySetStudyUID = normalizeValue(
      displaySet?.StudyInstanceUID || displaySet?.studyInstanceUid || instance?.StudyInstanceUID
    );
    if (displaySetStudyUID !== studyInstanceUID) return;
    const patientId = normalizeValue(displaySet?.PatientID || instance?.PatientID);
    if (patientId) patientIds.add(patientId);
  });

  return patientIds.size === 1 ? [...patientIds][0] : null;
};

/** 2026-09-04 功能说明：仅用 StudyInstanceUID 和 PatientID 判断纵向对比资格，不持有影像对象。 */
export default function getComparisonPatientIdentity(
  displaySets: any[] = [],
  baselineStudyInstanceUID?: string | null,
  followupStudyInstanceUID?: string | null
): TMTVComparisonPatientIdentity {
  const baselinePatientId = getPatientIdForStudy(displaySets, baselineStudyInstanceUID);
  const followupPatientId = getPatientIdForStudy(displaySets, followupStudyInstanceUID);

  return {
    status:
      !baselinePatientId || !followupPatientId
        ? 'unknown'
        : baselinePatientId === followupPatientId
          ? 'same'
          : 'different',
    baselinePatientId,
    followupPatientId,
  };
}
