import {
  ctAXIAL,
  ctCORONAL,
  ctSAGITTAL,
  fusionAXIAL,
  fusionCORONAL,
  fusionSAGITTAL,
  mipAXIAL, // [2026-05-11 新增] MIP轴位视图，用于轴位2x2布局
  mipCORONAL, // [2026-05-11 新增] MIP冠状位视图，用于冠状位2x2布局
  mipSAGITTAL,
  ptAXIAL,
  ptCORONAL,
  ptSAGITTAL,
} from './utils/hpViewports';

const tmtvCompareProtocolId = '@ohif/extension-tmtv.hangingProtocolModule.ptCTCompare';

const studyIndexMatchingRule = (studyInstanceUIDsIndex: number) => ({
  attribute: 'studyInstanceUIDsIndex',
  from: 'options',
  required: true,
  constraint: {
    equals: { value: studyInstanceUIDsIndex },
  },
});

const reconstructableModalityRule = (modality: 'CT' | 'PT') => ({
  attribute: 'Modality',
  required: true,
  constraint: {
    equals: {
      value: modality,
    },
  },
});

const reconstructableRule = {
  attribute: 'isReconstructable',
  required: true,
  constraint: {
    equals: {
      value: true,
    },
  },
};

const preferredUrlSeriesRule = {
  attribute: 'isDisplaySetFromUrl',
  weight: 20,
  constraint: {
    equals: true,
  },
};

const createStudyModalitySelector = (studyInstanceUIDsIndex: number, modality: 'CT' | 'PT') => ({
  studyMatchingRules: [studyIndexMatchingRule(studyInstanceUIDsIndex)],
  seriesMatchingRules: [
    reconstructableModalityRule(modality),
    reconstructableRule,
    preferredUrlSeriesRule,
  ],
});

/**
 * [2026-08-28 修复] 构建对比模式 syncGroups。
 * 关键：CT/PT/Fusion（axial 方位）共享 cameraPositionSync，确保缩放率一致，
 * 避免 PET 因 volume bounds 较大独立 fit 后显示偏小（参照原 TMTV axialSync 机制）。
 * Baseline 与 Follow-up 分别用独立 sync 组，避免流式加载期间互相污染相机。
 * MIP 为 sagittal 方位，不加入 axial 相机同步，但与同侧 PT 共享 VOI。
 */
const buildCompareSyncGroups = (side: string, modality: string) => {
  const sideKey = side === 'Baseline' ? 'Baseline' : 'Followup';
  const groups: any[] = [];

  // axial/coronal 方位的 CT/PT/Fusion 共享相机位置同步组（按 side 分组）
  if (modality !== 'MIP') {
    groups.push({
      type: 'cameraPosition',
      id: `axialSync${sideKey}`,
      source: true,
      target: true,
    });
  }

  // VOI 窗宽窗位同步（参照原 TMTV ctAXIAL/ptAXIAL/fusionAXIAL/mipSAGITTAL 配置）
  if (modality === 'CT') {
    groups.push({
      type: 'voi',
      id: `ctWLSync${sideKey}`,
      source: true,
      target: true,
      options: { syncColormap: true },
    });
  } else if (modality === 'PT' || modality === 'MIP') {
    groups.push({
      type: 'voi',
      id: `ptWLSync${sideKey}`,
      source: true,
      target: true,
      options: { syncColormap: true },
    });
  } else if (modality === 'Fusion') {
    // Fusion: CT VOI 仅作为 target 接收，fusion VOI 双向，ptFusion 仅 target
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
};

const createCompareVolumeViewport = ({
  viewportId,
  side,
  modality,
  orientation = 'axial',
  displaySets,
}) => ({
  viewportOptions: {
    viewportId,
    viewportType: 'volume',
    orientation,
    // [2026-08-28 功能] 新增 MIP 分支，toolGroupId=mipToolGroup，背景白色与原 mipSAGITTAL 一致
    toolGroupId:
      modality === 'CT'
        ? 'ctToolGroup'
        : modality === 'PT'
        ? 'ptToolGroup'
        : modality === 'MIP'
        ? 'mipToolGroup'
        : 'fusionToolGroup',
    ...(modality === 'PT' || modality === 'MIP' ? { background: [1, 1, 1] } : {}),
    initialImageOptions: {
      // 2026-08-31 功能说明：MIP 围绕体积中心旋转，不能像普通切片一样定位在首层。
      preset: modality === 'Fusion' || modality === 'MIP' ? 'middle' : 'first',
    },
    // [2026-08-28 修复] 补充 syncGroups，确保同侧 CT/PT/Fusion 缩放率一致
    syncGroups: buildCompareSyncGroups(side, modality),
    // [2026-08-28 功能] 标记对比视口归属，供覆盖层和后续工具作用对象隔离复用。
    customViewportProps: {
      tmtvComparisonSide: side,
      tmtvComparisonModality: modality,
    },
  },
  displaySets,
});

const ptCompareDisplaySetOptions = {
  voi: {
    custom: 'getPTVOIRange',
  },
  voiInverted: true,
};

const fusionComparePTDisplaySetOptions = {
  colormap: {
    name: 'hsv',
    opacity: [
      { value: 0, opacity: 0 },
      { value: 0.1, opacity: 0.8 },
      { value: 1, opacity: 0.9 },
    ],
  },
  voi: {
    custom: 'getPTVOIRange',
  },
};

// [2026-08-28 功能] MIP 视口 displaySet 选项，复用 PT 数据做最大密度投影（参照原 mipSAGITTAL）
const mipCompareDisplaySetOptions = {
  blendMode: 'MIP',
  slabThickness: 500,
  voi: {
    custom: 'getPTVOIRange',
  },
  voiInverted: true,
};

const baselineCTCompare = createCompareVolumeViewport({
  viewportId: 'baselineCTAxial',
  side: 'Baseline',
  modality: 'CT',
  displaySets: [{ id: 'baselineCTDisplaySet' }],
});

const followupCTCompare = createCompareVolumeViewport({
  viewportId: 'followupCTAxial',
  side: 'Follow-up',
  modality: 'CT',
  displaySets: [{ id: 'followupCTDisplaySet' }],
});

const baselinePTCompare = createCompareVolumeViewport({
  viewportId: 'baselinePTAxial',
  side: 'Baseline',
  modality: 'PT',
  displaySets: [{ id: 'baselinePTDisplaySet', options: ptCompareDisplaySetOptions }],
});

const followupPTCompare = createCompareVolumeViewport({
  viewportId: 'followupPTAxial',
  side: 'Follow-up',
  modality: 'PT',
  displaySets: [{ id: 'followupPTDisplaySet', options: ptCompareDisplaySetOptions }],
});

const baselineFusionCompare = createCompareVolumeViewport({
  viewportId: 'baselineFusionAxial',
  side: 'Baseline',
  modality: 'Fusion',
  displaySets: [
    { id: 'baselineCTDisplaySet' },
    { id: 'baselinePTDisplaySet', options: fusionComparePTDisplaySetOptions },
  ],
});

const followupFusionCompare = createCompareVolumeViewport({
  viewportId: 'followupFusionAxial',
  side: 'Follow-up',
  modality: 'Fusion',
  displaySets: [
    { id: 'followupCTDisplaySet' },
    { id: 'followupPTDisplaySet', options: fusionComparePTDisplaySetOptions },
  ],
});

// [2026-08-28 功能] 对比模式 MIP 视口，复用各自 PT displaySet 做最大密度投影，方位 sagittal 与原 mipSAGITTAL 一致
const baselineMIPCompare = createCompareVolumeViewport({
  viewportId: 'baselineMIPSagittal',
  side: 'Baseline',
  modality: 'MIP',
  orientation: 'sagittal',
  displaySets: [{ id: 'baselinePTDisplaySet', options: mipCompareDisplaySetOptions }],
});

const followupMIPCompare = createCompareVolumeViewport({
  viewportId: 'followupMIPSagittal',
  side: 'Follow-up',
  modality: 'MIP',
  orientation: 'sagittal',
  displaySets: [{ id: 'followupPTDisplaySet', options: mipCompareDisplaySetOptions }],
});

/**
 * [2026-08-28 功能] TMTV 两次检查对比布局：左 Baseline 2x2，右 Follow-up 2x2。
 *
 * 布局结构：2行 × 4列（grid 按行填充）
 *   ┌──────────────┬──────────────┬──────────────┬──────────────┐
 *   │ Baseline CT  │ Baseline PT  │ Follow-up CT │ Follow-up PT │
 *   ├──────────────┼──────────────┼──────────────┼──────────────┤
 *   │ Baseline Fsn │ Baseline MIP │ Follow-up Fsn│ Follow-up MIP│
 *   └──────────────┴──────────────┴──────────────┴──────────────┘
 * 左两列=Baseline（CT/PT/Fusion/MIP），右两列=Follow-up（CT/PT/Fusion/MIP）。
 */
const compareStage2x4: AppTypes.HangingProtocol.ProtocolStage = {
  name: 'TMTV Compare 2x4',
  id: 'tmtv-comparison-2x4',
  stageActivation: {
    enabled: {
      minViewportsMatched: 8,
    },
  },
  viewportStructure: {
    layoutType: 'grid',
    properties: {
      rows: 2,
      columns: 4,
    },
  },
  viewports: [
    baselineCTCompare,
    baselinePTCompare,
    followupCTCompare,
    followupPTCompare,
    baselineFusionCompare,
    baselineMIPCompare,
    followupFusionCompare,
    followupMIPCompare,
  ],
};

/**
 * represents a 3x4 viewport layout configuration. The layout displays CT axial, sagittal, and coronal
 * images in the first row, PT axial, sagittal, and coronal images in the second row, and fusion axial,
 * sagittal, and coronal images in the third row. The fourth column is fully spanned by a MIP sagittal
 * image, covering all three rows. It has synchronizers for windowLevel for all CT and PT images, and
 * also camera synchronizer for each orientation
 */
const stage1: AppTypes.HangingProtocol.ProtocolStage = {
  name: 'default',
  id: 'default',
  viewportStructure: {
    layoutType: 'grid',
    properties: {
      rows: 3,
      columns: 4,
      layoutOptions: [
        {
          x: 0,
          y: 0,
          width: 1 / 4,
          height: 1 / 3,
        },
        {
          x: 1 / 4,
          y: 0,
          width: 1 / 4,
          height: 1 / 3,
        },
        {
          x: 2 / 4,
          y: 0,
          width: 1 / 4,
          height: 1 / 3,
        },
        {
          x: 0,
          y: 1 / 3,
          width: 1 / 4,
          height: 1 / 3,
        },
        {
          x: 1 / 4,
          y: 1 / 3,
          width: 1 / 4,
          height: 1 / 3,
        },
        {
          x: 2 / 4,
          y: 1 / 3,
          width: 1 / 4,
          height: 1 / 3,
        },
        {
          x: 0,
          y: 2 / 3,
          width: 1 / 4,
          height: 1 / 3,
        },
        {
          x: 1 / 4,
          y: 2 / 3,
          width: 1 / 4,
          height: 1 / 3,
        },
        {
          x: 2 / 4,
          y: 2 / 3,
          width: 1 / 4,
          height: 1 / 3,
        },
        {
          x: 3 / 4,
          y: 0,
          width: 1 / 4,
          height: 1,
        },
      ],
    },
  },
  viewports: [
    ctAXIAL,
    ctSAGITTAL,
    ctCORONAL,
    ptAXIAL,
    ptSAGITTAL,
    ptCORONAL,
    fusionAXIAL,
    fusionSAGITTAL,
    fusionCORONAL,
    mipSAGITTAL,
  ],
  createdDate: '2021-02-23T18:32:42.850Z',
};

/**
 * The layout displays CT axial image in the top-left viewport, fusion axial image
 * in the top-right viewport, PT axial image in the bottom-left viewport, and MIP
 * sagittal image in the bottom-right viewport. The layout follows a simple grid
 * pattern with 2 rows and 2 columns. It includes synchronizers as well.
 */
const stage2 = {
  name: 'Fusion 2x2',
  id: 'Fusion-2x2',
  viewportStructure: {
    layoutType: 'grid',
    properties: {
      rows: 2,
      columns: 2,
    },
  },
  viewports: [ctAXIAL, fusionAXIAL, ptAXIAL, mipSAGITTAL],
};

/**
 * [2026-05-11 修改] 轴位 2×2 布局
 *
 * 布局结构：2行 × 2列
 *   ┌─────────────┬─────────────┐
 *   │  CT 轴位    │  PET 轴位   │
 *   ├─────────────┼─────────────┤
 *   │ Fusion 轴位 │   MIP 图    │
 *   └─────────────┴─────────────┘
 *
 * 注意：此布局中每个 toolGroup 只有1个视口，
 * 十字线工具无法在不同方向之间画参考线（需要至少2个不同方向的视口）。
 * 但通过安全补丁，十字线工具不会崩溃。
 */
const stage3: AppTypes.HangingProtocol.ProtocolStage = {
  name: 'Axial',
  id: '2x3-layout',
  viewportStructure: {
    layoutType: 'grid',
    properties: {
      rows: 2,
      columns: 2,
    },
  },
  viewports: [ctAXIAL, ptAXIAL, fusionAXIAL, mipSAGITTAL],
};

/**
 * [2026-05-11 修改] 矢状位 2×2 布局
 *
 * 布局结构：2行 × 2列
 *   ┌─────────────┬─────────────┐
 *   │ CT 矢状位   │ PET 矢状位  │
 *   ├─────────────┼─────────────┤
 *   │Fusion矢状位 │   MIP 图    │
 *   └─────────────┴─────────────┘
 */
const stage4: AppTypes.HangingProtocol.ProtocolStage = {
  name: 'Sagittal',
  id: '2x4-layout',
  viewportStructure: {
    layoutType: 'grid',
    properties: {
      rows: 2,
      columns: 2,
    },
  },
  viewports: [ctSAGITTAL, ptSAGITTAL, fusionSAGITTAL, mipSAGITTAL],
};

/**
 * [2026-05-11 新增] 冠状位 2×2 布局
 *
 * 布局结构：2行 × 2列
 *   ┌─────────────┬─────────────┐
 *   │ CT 冠状位   │ PET 冠状位  │
 *   ├─────────────┼─────────────┤
 *   │Fusion冠状位 │   MIP 图    │
 *   └─────────────┴─────────────┘
 */
const stage5: AppTypes.HangingProtocol.ProtocolStage = {
  name: 'Coronal',
  id: 'coronal-mip-layout',
  viewportStructure: {
    layoutType: 'grid',
    properties: {
      rows: 2,
      columns: 2,
    },
  },
  viewports: [ctCORONAL, ptCORONAL, fusionCORONAL, mipCORONAL],
};

/**
 * [2026-05-11 恢复] 原始 2×3 布局（CT + PT 三视图）
 *
 * 布局结构：2行 × 3列
 *   ┌─────────────┬─────────────┬─────────────┐
 *   │  CT 轴位    │ CT 矢状位   │ CT 冠状位   │
 *   ├─────────────┼─────────────┼─────────────┤
 *   │  PT 轴位    │ PT 矢状位   │ PT 冠状位   │
 *   └─────────────┴─────────────┴─────────────┘
 *
 * 十字线：✅ 正常工作（每个toolGroup有3个不同方向视口）
 */
const stage6: AppTypes.HangingProtocol.ProtocolStage = {
  name: '2x3',
  id: '2x3-original-layout',
  viewportStructure: {
    layoutType: 'grid',
    properties: {
      rows: 2,
      columns: 3,
    },
  },
  viewports: [ctAXIAL, ctSAGITTAL, ctCORONAL, ptAXIAL, ptSAGITTAL, ptCORONAL],
};

/**
 * [2026-05-11 恢复] 原始 2×4 布局（PT三视图 + MIP + Fusion三视图）
 *
 * 布局结构：2行 × 4列（MIP跨行）
 *   ┌─────────────┬─────────────┬─────────────┬─────────────┐
 *   │ PT 冠状位   │ PT 矢状位   │  PT 轴位    │             │
 *   ├─────────────┼─────────────┼─────────────┤   MIP 图    │
 *   │Fusion冠状位 │Fusion矢状位 │Fusion轴位   │             │
 *   └─────────────┴─────────────┴─────────────┴─────────────┘
 *
 * 十字线：✅ 正常工作（ptToolGroup和fusionToolGroup各有3个方向视口）
 */
const stage7: AppTypes.HangingProtocol.ProtocolStage = {
  name: '2x4',
  id: '2x4-original-layout',
  viewportStructure: {
    layoutType: 'grid',
    properties: {
      rows: 2,
      columns: 4,
      layoutOptions: [
        { x: 0, y: 0, width: 1 / 4, height: 1 / 2 },
        { x: 1 / 4, y: 0, width: 1 / 4, height: 1 / 2 },
        { x: 2 / 4, y: 0, width: 1 / 4, height: 1 / 2 },
        { x: 3 / 4, y: 0, width: 1 / 4, height: 1 },
        { x: 0, y: 1 / 2, width: 1 / 4, height: 1 / 2 },
        { x: 1 / 4, y: 1 / 2, width: 1 / 4, height: 1 / 2 },
        { x: 2 / 4, y: 1 / 2, width: 1 / 4, height: 1 / 2 },
      ],
    },
  },
  viewports: [
    ptCORONAL,
    ptSAGITTAL,
    ptAXIAL,
    mipSAGITTAL,
    fusionCORONAL,
    fusionSAGITTAL,
    fusionAXIAL,
  ],
};

/**
 * [2026-05-11 新增] TMTV 专用 MPR 布局（Fusion 三视图 + 十字线）
 *
 * 布局结构：1行 × 3列
 *   ┌─────────────┬─────────────┬─────────────┐
 *   │Fusion 轴位  │Fusion矢状位 │Fusion冠状位  │
 *   └─────────────┴─────────────┴─────────────┘
 *
 * 特点：
 *   - 所有视口使用 fusionToolGroup，加载 Fusion 融合图像
 *   - fusionToolGroup 有3个不同方向视口 → Crosshairs 正常工作 ✅
 *   - 无论选中 CT/PET/Fusion 视口，都显示 Fusion 图像
 */
const stage8: AppTypes.HangingProtocol.ProtocolStage = {
  name: 'MPR',
  id: 'tmtv-mpr-layout',
  viewportStructure: {
    layoutType: 'grid',
    properties: {
      rows: 1,
      columns: 3,
    },
  },
  viewports: [fusionAXIAL, fusionSAGITTAL, fusionCORONAL],
};

// const stage0: AppTypes.HangingProtocol.ProtocolStage = {
//   name: 'Fusion 1x3',
//   viewportStructure: {
//     layoutType: 'grid',
//     properties: {
//       rows: 1,
//       columns: 3,
//     },
//   },
//   viewports: [fusionAXIAL, fusionSAGITTAL, fusionCORONAL],
// };

const ptCT: AppTypes.HangingProtocol.Protocol = {
  id: '@ohif/extension-tmtv.hangingProtocolModule.ptCT',
  locked: true,
  name: 'Default',
  createdDate: '2021-02-23T19:22:08.894Z',
  modifiedDate: '2022-10-04T19:22:08.894Z',
  availableTo: {},
  editableBy: {},
  // [2026-05-11] 图像加载策略配置
  // 可选值: 'default' | 'interleaveTopToBottom' | 'interleaveCenter' | 'nth'
  // 注意：'nth' 策略可能导致布局切换时出现 VOI 同步错误
  imageLoadStrategy: 'interleaveTopToBottom',
  //匹配规则，必须包含 PT 和 CT
  protocolMatchingRules: [
    {
      attribute: 'ModalitiesInStudy',
      constraint: {
        contains: ['CT', 'PT'],
      },
    },
    {
      attribute: 'StudyDescription',
      constraint: {
        contains: 'PETCT',
      },
    },
    {
      attribute: 'StudyDescription',
      constraint: {
        contains: 'PET/CT',
      },
    },
  ],
  // DisplaySet 选择器
  displaySetSelectors: {
    ctDisplaySet: {
      seriesMatchingRules: [
        {
          attribute: 'Modality',
          constraint: {
            equals: {
              value: 'CT',
            },
          },
          required: true,
        },
        {
          attribute: 'isReconstructable',
          constraint: {
            equals: {
              value: true,
            },
          },
          required: true,
        },
        {
          attribute: 'SeriesDescription',
          constraint: {
            contains: 'CT',
          },
        },
        {
          attribute: 'SeriesDescription',
          constraint: {
            contains: 'CT WB',
          },
        },
      ],
    },
    ptDisplaySet: {
      seriesMatchingRules: [
        {
          attribute: 'Modality',
          constraint: {
            equals: 'PT',
          },
          required: true,
        },
        {
          attribute: 'isReconstructable',
          constraint: {
            equals: {
              value: true,
            },
          },
          required: true,
        },
        {
          attribute: 'SeriesDescription',
          constraint: {
            contains: 'Corrected',
          },
        },
        {
          weight: 2,
          attribute: 'SeriesDescription',
          constraint: {
            doesNotContain: {
              value: 'Uncorrected',
            },
          },
        },
      ],
    },
  },
  // [2026-05-11 修改] 扩展stages数组，新增冠状位2x2、原始2x3、原始2x4、TMTV MPR布局
  // [2026-06-30 修改] 默认布局改为 Axial（stage3），将 stage3 放到第一位
  //可选的多种布局
  stages: [stage3, stage1, stage2, stage4, stage5, stage6, stage7, stage8],
  numberOfPriorsReferenced: -1,
};

/**
 * [2026-08-28 功能] TMTV 两次检查对比协议，复用 basic hpCompare 的 studyInstanceUIDsIndex 分流思路。
 */
const ptCTCompare: AppTypes.HangingProtocol.Protocol = {
  id: tmtvCompareProtocolId,
  locked: true,
  name: 'TMTV Compare',
  description: 'Compare two PET/CT studies in TMTV',
  createdDate: '2026-08-28T00:00:00.000Z',
  modifiedDate: '2026-08-28T00:00:00.000Z',
  availableTo: {},
  editableBy: {},
  imageLoadStrategy: 'interleaveTopToBottom',
  numberOfPriorsReferenced: 1,
  protocolMatchingRules: [
    {
      id: 'Two PET CT Studies',
      weight: 1000,
      attribute: 'StudyInstanceUID',
      from: 'prior',
      required: true,
      constraint: {
        notNull: true,
      },
    },
  ],
  // [2026-08-28 功能] 新增 mipToolGroup，供 MIP 视口使用
  toolGroupIds: ['ctToolGroup', 'ptToolGroup', 'fusionToolGroup', 'mipToolGroup'],
  displaySetSelectors: {
    baselineCTDisplaySet: createStudyModalitySelector(0, 'CT'),
    baselinePTDisplaySet: createStudyModalitySelector(0, 'PT'),
    followupCTDisplaySet: createStudyModalitySelector(1, 'CT'),
    followupPTDisplaySet: createStudyModalitySelector(1, 'PT'),
  },
  stages: [compareStage2x4],
};

function getHangingProtocolModule() {
  return [
    {
      name: ptCT.id,
      protocol: ptCT,
    },
    {
      name: ptCTCompare.id,
      protocol: ptCTCompare,
    },
  ];
}

export default getHangingProtocolModule;
