import buildCompareSyncGroups from './comparisonSyncGroups';
import { TMTV_SAME_STUDY_CAMERA_TYPE } from './createTMTVSameStudyCameraSynchronizer';

describe('comparison sync groups', () => {
  it('uses a same-study camera group that does not own zoom', () => {
    expect(buildCompareSyncGroups('Baseline', 'CT')).toContainEqual({
      type: TMTV_SAME_STUDY_CAMERA_TYPE,
      id: 'axialSyncBaseline',
      source: true,
      target: true,
    });
  });

  it.each([
    ['Baseline', 'Baseline'],
    ['Follow-up', 'Followup'],
  ])('links %s PET to its same-examination fusion viewport', (side, sideKey) => {
    const ptGroups = buildCompareSyncGroups(side, 'PT');
    const fusionGroups = buildCompareSyncGroups(side, 'Fusion');

    expect(ptGroups).toContainEqual({
      type: 'voi',
      id: `ptFusionWLSync${sideKey}`,
      source: true,
      target: false,
      options: { syncColormap: false, syncInvertState: false },
    });
    expect(fusionGroups).toContainEqual({
      type: 'voi',
      id: `ptFusionWLSync${sideKey}`,
      source: false,
      target: true,
      options: { syncColormap: false, syncInvertState: false },
    });
  });

  it('does not make MIP a source for fusion VOI', () => {
    const groups = buildCompareSyncGroups('Baseline', 'MIP');

    expect(groups.some(group => group.id === 'ptFusionWLSyncBaseline')).toBe(false);
  });
});
