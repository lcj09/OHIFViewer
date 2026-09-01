import { TMTV_SAME_STUDY_CAMERA_TYPE } from './createTMTVSameStudyCameraSynchronizer';

/**
 * 2026-09-01 功能说明：构建两次检查对比视口的同检查同步组。
 * Baseline 与 Follow-up 使用独立组，跨检查传播由 ComparisonService 负责。
 */
export default function buildCompareSyncGroups(side: string, modality: string): any[] {
  const sideKey = side === 'Baseline' ? 'Baseline' : 'Followup';
  const groups: any[] = [];

  if (modality !== 'MIP') {
    groups.push({
      type: TMTV_SAME_STUDY_CAMERA_TYPE,
      id: `axialSync${sideKey}`,
      source: true,
      target: true,
    });
  }

  if (modality === 'CT') {
    groups.push({
      type: 'voi',
      id: `ctWLSync${sideKey}`,
      source: true,
      target: true,
      options: { syncColormap: true },
    });
  } else if (modality === 'PT') {
    groups.push({
      type: 'voi',
      id: `ptWLSync${sideKey}`,
      source: true,
      target: true,
      options: { syncColormap: true },
    });
    groups.push({
      type: 'voi',
      id: `ptFusionWLSync${sideKey}`,
      source: true,
      target: false,
      options: { syncColormap: false, syncInvertState: false },
    });
  } else if (modality === 'MIP') {
    groups.push({
      type: 'voi',
      id: `ptWLSync${sideKey}`,
      source: true,
      target: true,
      options: { syncColormap: true },
    });
  } else if (modality === 'Fusion') {
    groups.push({ type: 'voi', id: `ctWLSync${sideKey}`, source: false, target: true });
    groups.push({
      type: 'voi',
      id: `fusionWLSync${sideKey}`,
      source: true,
      target: true,
      options: { syncColormap: true },
    });
    groups.push({
      type: 'voi',
      id: `ptFusionWLSync${sideKey}`,
      source: false,
      target: true,
      options: { syncColormap: false, syncInvertState: false },
    });
  }

  groups.push({
    type: 'hydrateseg',
    id: 'sameFORId',
    source: true,
    target: true,
    options: { matchingRules: ['sameFOR'] },
  });

  return groups;
}
