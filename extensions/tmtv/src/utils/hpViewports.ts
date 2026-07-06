// Common sync group configurations
const cameraPositionSync = (id: string) => ({
  type: 'cameraPosition',
  id,
  source: true,
  target: true,
});

const hydrateSegSync = {
  type: 'hydrateseg',
  id: 'sameFORId',
  source: true,
  target: true,
  options: {
    matchingRules: ['sameFOR'],
  },
};
//融合视图配置
const ctAXIAL: AppTypes.HangingProtocol.Viewport = {
  viewportOptions: {
    viewportId: 'ctAXIAL',
    viewportType: 'volume',//体积视图
    orientation: 'axial',//横截面
    toolGroupId: 'ctToolGroup',//CT工具组
    initialImageOptions: {
      // index: 5,
      preset: 'first', // 'first', 'last', 'middle'
    },
    syncGroups: [
      cameraPositionSync('axialSync'),//与其他轴向视图同步机制
      {
        type: 'voi',
        id: 'ctWLSync',
        source: true,
        target: true,
        options: {
          syncColormap: true,
        },
      },
      hydrateSegSync,
    ],
  },
  displaySets: [
    {
      id: 'ctDisplaySet',
    },
  ],
};

const ctSAGITTAL: AppTypes.HangingProtocol.Viewport = {
  viewportOptions: {
    viewportId: 'ctSAGITTAL',
    viewportType: 'volume',
    orientation: 'sagittal',
    toolGroupId: 'ctToolGroup',
    syncGroups: [
      cameraPositionSync('sagittalSync'),
      {
        type: 'voi',
        id: 'ctWLSync',
        source: true,
        target: true,
        options: {
          syncColormap: true,
        },
      },
      hydrateSegSync,
    ],
  },
  displaySets: [
    {
      id: 'ctDisplaySet',
    },
  ],
};

const ctCORONAL: AppTypes.HangingProtocol.Viewport = {
  viewportOptions: {
    viewportId: 'ctCORONAL',
    viewportType: 'volume',
    orientation: 'coronal',
    toolGroupId: 'ctToolGroup',
    syncGroups: [
      cameraPositionSync('coronalSync'),
      {
        type: 'voi',
        id: 'ctWLSync',
        source: true,
        target: true,
        options: {
          syncColormap: true,
        },
      },
      hydrateSegSync,
    ],
  },
  displaySets: [
    {
      id: 'ctDisplaySet',
    },
  ],
};

const ptAXIAL: AppTypes.HangingProtocol.Viewport = {
  viewportOptions: {
    viewportId: 'ptAXIAL',
    viewportType: 'volume',
    background: [1, 1, 1],
    orientation: 'axial',
    toolGroupId: 'ptToolGroup',
    initialImageOptions: {
      // index: 5,
      preset: 'first', // 'first', 'last', 'middle'
    },
    syncGroups: [
      cameraPositionSync('axialSync'),
      {
        type: 'voi',
        id: 'ptWLSync',
        source: true,
        target: true,
        options: {
          syncColormap: true,
        },
      },
      {
        type: 'voi',
        id: 'ptFusionWLSync',
        source: true,
        target: false,
        options: {
          syncColormap: false,
          syncInvertState: false,
        },
      },
      hydrateSegSync,
    ],
  },
  displaySets: [
    {
      options: {
        voi: {
          custom: 'getPTVOIRange',
        },
        voiInverted: true,
      },
      id: 'ptDisplaySet',
    },
  ],
};

const ptSAGITTAL: AppTypes.HangingProtocol.Viewport = {
  viewportOptions: {
    viewportId: 'ptSAGITTAL',
    viewportType: 'volume',
    orientation: 'sagittal',
    background: [1, 1, 1],
    toolGroupId: 'ptToolGroup',
    syncGroups: [
      cameraPositionSync('sagittalSync'),
      {
        type: 'voi',
        id: 'ptWLSync',
        source: true,
        target: true,
        options: {
          syncColormap: true,
        },
      },
      {
        type: 'voi',
        id: 'ptFusionWLSync',
        source: true,
        target: false,
        options: {
          syncColormap: false,
          syncInvertState: false,
        },
      },
      hydrateSegSync,
    ],
  },
  displaySets: [
    {
      options: {
        voi: {
          custom: 'getPTVOIRange',
        },
        voiInverted: true,
      },
      id: 'ptDisplaySet',
    },
  ],
};

const ptCORONAL: AppTypes.HangingProtocol.Viewport = {
  viewportOptions: {
    viewportId: 'ptCORONAL',
    viewportType: 'volume',
    orientation: 'coronal',
    background: [1, 1, 1],
    toolGroupId: 'ptToolGroup',
    syncGroups: [
      cameraPositionSync('coronalSync'),
      {
        type: 'voi',
        id: 'ptWLSync',
        source: true,
        target: true,
        options: {
          syncColormap: true,
        },
      },
      {
        type: 'voi',
        id: 'ptFusionWLSync',
        source: true,
        target: false,
        options: {
          syncColormap: false,
          syncInvertState: false,
        },
      },
      hydrateSegSync,
    ],
  },
  displaySets: [
    {
      options: {
        voi: {
          custom: 'getPTVOIRange',
        },
        voiInverted: true,
      },
      id: 'ptDisplaySet',
    },
  ],
};

const fusionAXIAL: AppTypes.HangingProtocol.Viewport = {
  viewportOptions: {
    viewportId: 'fusionAXIAL',
    viewportType: 'volume',
    orientation: 'axial',
    toolGroupId: 'fusionToolGroup',
    initialImageOptions: {
      // index: 5,
      preset: 'middle', // 'first', 'last', 'middle'
      // [2026-05-21] 改为'middle'：确保MPR布局中三个正交视图都从体积中间开始，
      // 使十字线工具的工具中心计算正确，避免参考线偏移到视图框外
    },
    syncGroups: [
      cameraPositionSync('axialSync'),
      {
        type: 'voi',
        id: 'ctWLSync',
        source: false,
        target: true,
      },
      {
        type: 'voi',
        id: 'fusionWLSync',
        source: true,
        target: true,
        options: {
          syncColormap: true,
        },
      },
      {
        type: 'voi',
        id: 'ptFusionWLSync',
        source: false,
        target: true,
        options: {
          syncColormap: false,
          syncInvertState: false,
        },
      },
      hydrateSegSync,
    ],
  },
  displaySets: [
    {
      id: 'ctDisplaySet',//底层：CT图像
    },
    {
      id: 'ptDisplaySet',//上层：PT图像
      options: {
        colormap: {
          name: 'hsv',
          opacity: [
            { value: 0, opacity: 0 },
            { value: 0.1, opacity: 0.8 },
            { value: 1, opacity: 0.9 },
          ],
        },
        voi: {
          custom: 'getPTVOIRange',// ← 使用自定义SUV窗宽窗位
        },
      },
    },
  ],
};

const fusionSAGITTAL = {
  viewportOptions: {
    viewportId: 'fusionSAGITTAL',
    viewportType: 'volume',
    orientation: 'sagittal',
    toolGroupId: 'fusionToolGroup',
    // initialImageOptions: {
    //   index: 180,
    //   preset: 'middle', // 'first', 'last', 'middle'
    // },
    syncGroups: [
      cameraPositionSync('sagittalSync'),
      {
        type: 'voi',
        id: 'ctWLSync',
        source: false,
        target: true,
      },
      {
        type: 'voi',
        id: 'fusionWLSync',
        source: true,
        target: true,
        options: {
          syncColormap: true,
        },
      },
      {
        type: 'voi',
        id: 'ptFusionWLSync',
        source: false,
        target: true,
        options: {
          syncColormap: false,
          syncInvertState: false,
        },
      },
      hydrateSegSync,
    ],
  },
  displaySets: [
    {
      id: 'ctDisplaySet',
    },
    {
      id: 'ptDisplaySet',
      options: {
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
      },
    },
  ],
};

const fusionCORONAL = {
  viewportOptions: {
    viewportId: 'fusionCoronal',
    viewportType: 'volume',
    orientation: 'coronal',
    toolGroupId: 'fusionToolGroup',
    // initialImageOptions: {
    //   index: 180,
    //   preset: 'middle', // 'first', 'last', 'middle'
    // },
    syncGroups: [
      cameraPositionSync('coronalSync'),
      {
        type: 'voi',
        id: 'ctWLSync',
        source: false,
        target: true,
      },
      {
        type: 'voi',
        id: 'fusionWLSync',
        source: true,
        target: true,
        options: {
          syncColormap: true,
        },
      },
      {
        type: 'voi',
        id: 'ptFusionWLSync',
        source: false,
        target: true,
        options: {
          syncColormap: false,
          syncInvertState: false,
        },
      },
      hydrateSegSync,
    ],
  },
  displaySets: [
    {
      id: 'ctDisplaySet',
    },
    {
      id: 'ptDisplaySet',
      options: {
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
      },
    },
  ],
};

const mipSAGITTAL: AppTypes.HangingProtocol.Viewport = {
  viewportOptions: {
    viewportId: 'mipSagittal',
    viewportType: 'volume',
    orientation: 'sagittal',
    background: [1, 1, 1],
    toolGroupId: 'mipToolGroup',
    syncGroups: [
      {
        type: 'voi',
        id: 'ptWLSync',
        source: true,
        target: true,
        options: {
          syncColormap: true,
        },
      },
      {
        type: 'voi',
        id: 'ptFusionWLSync',
        source: true,
        target: false,
        options: {
          syncColormap: false,
          syncInvertState: false,
        },
      },
      hydrateSegSync,
    ],

    // Custom props can be used to set custom properties which extensions
    // can react on.
    customViewportProps: {
      // We use viewportDisplay to filter the viewports which are displayed
      // in mip and we set the scrollbar according to their rotation index
      // in the cornerstone extension.
      hideOverlays: true,
    },
  },
  displaySets: [
    {
      // [2026-05-11 优化] slabThickness: 500mm（减少GPU显存占用，原:fullVolume）
      options: {
        blendMode: 'MIP',
        slabThickness: 500,
        voi: {
          custom: 'getPTVOIRange',
        },
        voiInverted: true,
      },
      id: 'ptDisplaySet',
    },
  ],
};

// ============================================================================
// [2026-05-11 新增] MIP轴位视图 - 用于横截面+MIP图布局
// ============================================================================
// 功能：显示PT数据的最大密度投影（轴向）
// 特点：
//   - 使用MIP混合模式，显示整个体积的最大强度值
//   - 轴向视角，从上往下看
//   - 与PT视图同步窗宽窗位
//   - 隐藏叠加层以获得更清晰的MIP效果
// 用途：用于快速查看全身PET扫描的整体代谢情况
// ============================================================================
const mipAXIAL: AppTypes.HangingProtocol.Viewport = {
  viewportOptions: {
    viewportId: 'mipAxial',
    viewportType: 'volume',
    orientation: 'axial',  // 轴向（横截面）
    background: [1, 1, 1],
    toolGroupId: 'mipToolGroup',
    syncGroups: [
      {
        type: 'voi',
        id: 'ptWLSync',
        source: true,
        target: true,
        options: {
          syncColormap: true,
        },
      },
      {
        type: 'voi',
        id: 'ptFusionWLSync',
        source: true,
        target: false,
        options: {
          syncColormap: false,
          syncInvertState: false,
        },
      },
      hydrateSegSync,
    ],
    customViewportProps: {
      hideOverlays: true,
    },
  },
  displaySets: [
    {
      // [2026-05-11 优化] slabThickness: 500mm（减少GPU显存占用）
      options: {
        blendMode: 'MIP',
        slabThickness: 500,  // 原: 'fullVolume'
        voi: {
          custom: 'getPTVOIRange',
        },
        voiInverted: true,
      },
      id: 'ptDisplaySet',
    },
  ],
};

// ============================================================================
// [2026-05-11 新增] MIP冠状位视图 - 用于冠状位+MIP图布局
// ============================================================================
// 功能：显示PT数据的最大密度投影（冠状向）
// 特点：
//   - 使用MIP混合模式，显示整个体积的最大强度值
//   - 冠状向视角，从前向后看
//   - 与PT视图同步窗宽窗位
//   - 隐藏叠加层以获得更清晰的MIP效果
// 用途：用于快速查看全身PET扫描的前后方向整体代谢分布
// ============================================================================
const mipCORONAL: AppTypes.HangingProtocol.Viewport = {
  viewportOptions: {
    viewportId: 'mipCoronal',
    viewportType: 'volume',
    orientation: 'coronal',  // 冠状向
    background: [1, 1, 1],
    toolGroupId: 'mipToolGroup',
    syncGroups: [
      {
        type: 'voi',
        id: 'ptWLSync',
        source: true,
        target: true,
        options: {
          syncColormap: true,
        },
      },
      {
        type: 'voi',
        id: 'ptFusionWLSync',
        source: true,
        target: false,
        options: {
          syncColormap: false,
          syncInvertState: false,
        },
      },
      hydrateSegSync,
    ],
    customViewportProps: {
      hideOverlays: true,
    },
  },
  displaySets: [
    {
      // [2026-05-11 优化] slabThickness: 500mm（减少GPU显存占用）
      options: {
        blendMode: 'MIP',
        slabThickness: 500,
        voi: {
          custom: 'getPTVOIRange',
        },
        voiInverted: true,
      },
      id: 'ptDisplaySet',
    },
  ],
};

export {
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
  mipAXIAL,    // [2026-05-11 新增] MIP轴位视图
  mipCORONAL,  // [2026-05-11 新增] MIP冠状位视图
};
