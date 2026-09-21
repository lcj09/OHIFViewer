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

const normalizePatientName = (value: unknown): string | null => {
  const patientNameValue =
    typeof value === 'object' && value !== null
      ? (value as { Alphabetic?: unknown }).Alphabetic
      : value;
  const patientName = normalizeValue(patientNameValue);

  return patientName ? patientName.replace(/\^+/g, ' ').replace(/\s+/g, ' ').toUpperCase() : null;
};

const getDisplaySetInstance = displaySet => displaySet?.instances?.[0] || displaySet?.instance;

/** 2026-09-21 功能说明：按检查汇总唯一的登记号和姓名，避免同一检查内矛盾元数据被误用。 */
const getPatientIdentityForStudy = (displaySets: any[], studyInstanceUID?: string | null) => {
  if (!studyInstanceUID) return { patientId: null, patientName: null };
  const patientIds = new Set<string>();
  const patientNames = new Set<string>();

  (displaySets || []).forEach(displaySet => {
    const instance = getDisplaySetInstance(displaySet);
    const displaySetStudyUID = normalizeValue(
      displaySet?.StudyInstanceUID || displaySet?.studyInstanceUid || instance?.StudyInstanceUID
    );
    if (displaySetStudyUID !== studyInstanceUID) return;
    const patientId = normalizeValue(displaySet?.PatientID || instance?.PatientID);
    const patientName = normalizePatientName(displaySet?.PatientName || instance?.PatientName);
    if (patientId) patientIds.add(patientId);
    if (patientName) patientNames.add(patientName);
  });

  return {
    patientId: patientIds.size === 1 ? [...patientIds][0] : null,
    patientName: patientNames.size === 1 ? [...patientNames][0] : null,
  };
};

/** 2026-09-21 功能说明：临时兼容手工登记号，登记号或姓名任一一致即可进行纵向对比。 */
export default function getComparisonPatientIdentity(
  displaySets: any[] = [],
  baselineStudyInstanceUID?: string | null,
  followupStudyInstanceUID?: string | null
): TMTVComparisonPatientIdentity {
  const baseline = getPatientIdentityForStudy(displaySets, baselineStudyInstanceUID);
  const followup = getPatientIdentityForStudy(displaySets, followupStudyInstanceUID);
  const patientIdMatches =
    !!baseline.patientId && !!followup.patientId && baseline.patientId === followup.patientId;
  const patientNameMatches =
    !!baseline.patientName &&
    !!followup.patientName &&
    baseline.patientName === followup.patientName;
  const hasComparablePatientId = !!baseline.patientId && !!followup.patientId;
  const hasComparablePatientName = !!baseline.patientName && !!followup.patientName;

  return {
    status:
      patientIdMatches || patientNameMatches
        ? 'same'
        : hasComparablePatientId || hasComparablePatientName
          ? 'different'
          : 'unknown',
    baselinePatientId: baseline.patientId,
    followupPatientId: followup.patientId,
  };
}
