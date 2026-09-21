import getComparisonPatientIdentity from './getComparisonPatientIdentity';

const makeDisplaySet = (
  studyInstanceUID: string,
  patientId?: string,
  patientName?: string | { Alphabetic: string }
) => ({
  StudyInstanceUID: studyInstanceUID,
  instances: [
    { StudyInstanceUID: studyInstanceUID, PatientID: patientId, PatientName: patientName },
  ],
});

describe('getComparisonPatientIdentity', () => {
  it('allows longitudinal comparison only for matching patient IDs', () => {
    expect(
      getComparisonPatientIdentity(
        [makeDisplaySet('study-a', 'patient-1'), makeDisplaySet('study-b', 'patient-1')],
        'study-a',
        'study-b'
      )
    ).toEqual({
      status: 'same',
      baselinePatientId: 'patient-1',
      followupPatientId: 'patient-1',
    });
  });

  it('detects different patients without blocking image comparison metadata', () => {
    expect(
      getComparisonPatientIdentity(
        [makeDisplaySet('study-a', 'patient-1'), makeDisplaySet('study-b', 'patient-2')],
        'study-a',
        'study-b'
      )
    ).toEqual({
      status: 'different',
      baselinePatientId: 'patient-1',
      followupPatientId: 'patient-2',
    });
  });

  it('allows comparison when patient IDs differ but normalized patient names match', () => {
    expect(
      getComparisonPatientIdentity(
        [
          makeDisplaySet('study-a', '202600138', { Alphabetic: 'zhang^shun' }),
          makeDisplaySet('study-b', '202600262', ' ZHANG SHUN '),
        ],
        'study-a',
        'study-b'
      )
    ).toEqual({
      status: 'same',
      baselinePatientId: '202600138',
      followupPatientId: '202600262',
    });
  });

  it('allows comparison by patient name when either patient ID is absent', () => {
    expect(
      getComparisonPatientIdentity(
        [
          makeDisplaySet('study-a', 'patient-1', 'ZHANG^SHUN'),
          makeDisplaySet('study-b', undefined, 'zhang shun'),
        ],
        'study-a',
        'study-b'
      ).status
    ).toBe('same');
  });

  it('detects different patients when both patient IDs and names differ', () => {
    expect(
      getComparisonPatientIdentity(
        [
          makeDisplaySet('study-a', 'patient-1', 'ZHANG^SHUN'),
          makeDisplaySet('study-b', 'patient-2', 'LI^MING'),
        ],
        'study-a',
        'study-b'
      ).status
    ).toBe('different');
  });

  it('returns unknown when either patient ID is absent or inconsistent', () => {
    expect(
      getComparisonPatientIdentity(
        [makeDisplaySet('study-a', 'patient-1'), makeDisplaySet('study-b')],
        'study-a',
        'study-b'
      ).status
    ).toBe('unknown');
    expect(
      getComparisonPatientIdentity(
        [makeDisplaySet('study-a', 'patient-1'), makeDisplaySet('study-a', 'patient-2')],
        'study-a',
        'study-b'
      ).status
    ).toBe('unknown');
  });
});
