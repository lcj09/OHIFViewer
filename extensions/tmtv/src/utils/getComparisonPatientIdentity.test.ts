import getComparisonPatientIdentity from './getComparisonPatientIdentity';

const makeDisplaySet = (studyInstanceUID: string, patientId?: string) => ({
  StudyInstanceUID: studyInstanceUID,
  instances: [{ StudyInstanceUID: studyInstanceUID, PatientID: patientId }],
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
