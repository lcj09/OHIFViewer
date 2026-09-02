import {
  findModalityDisplaySetForSide,
  getExistingSessionSegmentationIds,
} from './tmtvSegmentationScope';

describe('TMTV segmentation scope', () => {
  const displaySets = new Map([
    ['base-ct', { displaySetInstanceUID: 'base-ct', Modality: 'CT' }],
    ['base-pt', { displaySetInstanceUID: 'base-pt', Modality: 'PT' }],
    ['follow-ct', { displaySetInstanceUID: 'follow-ct', Modality: 'CT' }],
    ['follow-pt', { displaySetInstanceUID: 'follow-pt', Modality: 'PT' }],
  ]);
  const displaySetService = { getDisplaySetByUID: uid => displaySets.get(uid) };
  const matchDetails = new Map([
    ['baselineCTAxial', { displaySetsInfo: [{ displaySetInstanceUID: 'base-ct' }] }],
    ['baselinePTAxial', { displaySetsInfo: [{ displaySetInstanceUID: 'base-pt' }] }],
    ['followupCTAxial', { displaySetsInfo: [{ displaySetInstanceUID: 'follow-ct' }] }],
    ['followupPTAxial', { displaySetsInfo: [{ displaySetInstanceUID: 'follow-pt' }] }],
  ]);

  it.each([
    ['baseline', 'PT', 'base-pt'],
    ['baseline', 'CT', 'base-ct'],
    ['followup', 'PT', 'follow-pt'],
    ['followup', 'CT', 'follow-ct'],
  ])('selects the %s %s display set', (side: any, modality: any, expectedUID) => {
    expect(
      findModalityDisplaySetForSide(matchDetails, displaySetService, modality, side)
        ?.displaySetInstanceUID
    ).toBe(expectedUID);
  });

  it('keeps ordinary TMTV first-match behavior and tolerates missing data', () => {
    expect(
      findModalityDisplaySetForSide(matchDetails, displaySetService, 'PT', 'single')
        ?.displaySetInstanceUID
    ).toBe('base-pt');
    expect(findModalityDisplaySetForSide(null, displaySetService, 'PT', 'single')).toBeNull();
  });

  it('returns only existing non-highlight segmentation IDs', () => {
    const service = { getSegmentation: id => (id === 'seg-a' ? { segmentationId: id } : null) };
    expect(
      getExistingSessionSegmentationIds(
        { segmentationIds: ['seg-a', 'missing', 'highlight:1'] },
        service,
        id => id?.startsWith('highlight')
      )
    ).toEqual(['seg-a']);
  });
});
