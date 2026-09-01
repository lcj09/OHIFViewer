import { toolGroupIds } from './initToolGroups';
import i18n from 'i18next';

import { MIN_SEGMENTATION_DRAWING_RADIUS, MAX_SEGMENTATION_DRAWING_RADIUS } from './constants';

// 2026-04-28 - 添加mipToolGroup，使十字线等工具在所有布局中可用
// [2026-05-11 修改] 移除 toolGroupIds.MPR（TMTV不再覆盖基础查看器的MPR工具组）
const setToolActiveToolbar = {
  commandName: 'setToolActiveToolbar',
  commandOptions: {
    toolGroupIds: [toolGroupIds.CT, toolGroupIds.PT, toolGroupIds.Fusion, toolGroupIds.MIP],
  },
};
const setSegmentationToolActiveToolbar = {
  commandName: 'setToolActiveToolbar',
  commandOptions: {
    // [2026-08-27 功能] TMTV 分割编辑只绑定 PT/Fusion，避免 CT/MIP 视口坐标写入 PT labelmap 时出现偏移
    toolGroupIds: [toolGroupIds.PT, toolGroupIds.Fusion],
  },
};
const ensurePrimaryTMTVSegmentationActive = {
  commandName: 'ensurePrimaryTMTVSegmentationActive',
  commandOptions: {
    clearSelection: true,
  },
};

const toolbarButtons = [
  // ============================================================================
  // [2026-05-12 修改] TMTV模式重置视图按钮
  // 使用TMTV专用 resetTMTVViewport 命令（正确恢复PET SUV窗宽窗位和MIP slabThickness）
  // ============================================================================
  {
    id: 'ResetTMTV',
    uiType: 'ohif.toolButton',
    props: {
      icon: 'tool-reset',
      label: i18n.t('Buttons:Reset View'),
      tooltip: i18n.t('Buttons:Reset View'),
      commands: 'resetTMTVViewport',
      evaluate: 'evaluate.action',
    },
  },
  // [2026-08-17 新增] TMTV视口顺时针旋转90度按钮
  // 功能：快速将当前视口按90°顺时针旋转，便于查看方向变化后的图像
  {
    id: 'Rotate90',
    uiType: 'ohif.toolButton',
    props: {
      icon: 'tool-rotate-right',
      label: i18n.t('Buttons:Rotate Right'),
      tooltip: i18n.t('Buttons:Rotate +90'),
      commands: 'rotateViewportCW',
      evaluate: 'evaluate.action',
    },
  },
  // [2026-08-18 修改] TMTV视口翻转按钮（水平翻转）
  // 功能：水平翻转当前视口图像。用户确认原系统中已有Flip Horizontal（水平翻转）功能，
  // 故使用原系统按钮定义（图标 tool-flip-horizontal、命令 flipViewportHorizontal、
  // evaluate 均沿用原系统 basic 模式），替代此前自定义的180°旋转（rotateViewportCWSet）
  {
    id: 'FlipHorizontal',
    uiType: 'ohif.toolButton',
    props: {
      icon: 'tool-flip-horizontal',
      label: i18n.t('Buttons:Flip Horizontal'),
      tooltip: i18n.t('Buttons:Flip Horizontally'),
      commands: 'flipViewportHorizontal',
      evaluate: [
        'evaluate.viewportProperties.toggle',
        {
          name: 'evaluate.viewport.supported',
          unsupportedViewportTypes: ['video', 'volume3d'],
        },
      ],
    },
  },
  {
    id: 'Save',
    uiType: 'ohif.saveMenu',
    props: {
      evaluate: 'evaluate.action',
    },
  },

  {
    id: 'MeasurementTools',
    uiType: 'ohif.toolButtonList',
    props: {
      buttonSection: true,
    },
  },
  {
    id: 'SegmentationTools',
    uiType: 'ohif.toolBoxButton',
    props: {
      buttonSection: true,
    },
  },
  {
    id: 'BrushTools',
    uiType: 'ohif.toolBoxButtonGroup',
    props: {
      buttonSection: true,
    },
  },
  {
    id: 'AdvancedRenderingControls',
    uiType: 'ohif.advancedRenderingControls',
    props: {
      buttonSection: true,
      evaluate: {
        name: 'evaluate.advancedRenderingControls',
        hideWhenDisabled: true,
      },
    },
  },
  {
    id: 'modalityLoadBadge',
    uiType: 'ohif.modalityLoadBadge',
    props: {
      icon: 'Status',
      label: i18n.t('Buttons:Status'),
      tooltip: i18n.t('Buttons:Status'),
      evaluate: {
        name: 'evaluate.modalityLoadBadge',
        hideWhenDisabled: true,
      },
    },
  },
  {
    id: 'Colorbar',
    uiType: 'ohif.colorbar',
    props: {
      type: 'tool',
      label: i18n.t('Buttons:Colorbar'),
    },
  },
  {
    id: 'navigationComponent',
    uiType: 'ohif.navigationComponent',
    props: {
      icon: 'Navigation',
      label: i18n.t('Buttons:Navigation'),
      tooltip: i18n.t('Buttons:Navigate between segments/measurements and manage their visibility'),
      evaluate: {
        name: 'evaluate.navigationComponent',
        hideWhenDisabled: true,
      },
    },
  },
  {
    id: 'windowLevelMenuEmbedded',
    uiType: 'ohif.windowLevelMenuEmbedded',
    props: {
      icon: 'WindowLevel',
      label: i18n.t('Buttons:Window Level'),
      tooltip: i18n.t('Buttons:Adjust window/level presets and customize image contrast settings'),
      evaluate: {
        name: 'evaluate.windowLevelMenuEmbedded',
        hideWhenDisabled: true,
      },
    },
  },
  {
    id: 'trackingStatus',
    uiType: 'ohif.trackingStatus',
    props: {
      icon: 'TrackingStatus',
      label: i18n.t('Buttons:Tracking Status'),
      tooltip: i18n.t('Buttons:View and manage tracking status of measurements and annotations'),
      evaluate: {
        name: 'evaluate.trackingStatus',
        hideWhenDisabled: true,
      },
    },
  },
  {
    id: 'Length',
    uiType: 'ohif.toolButton',
    props: {
      icon: 'tool-length',
      label: i18n.t('Buttons:Length'),
      tooltip: i18n.t('Buttons:Length Tool'),
      commands: setToolActiveToolbar,
      evaluate: 'evaluate.cornerstoneTool',
    },
  },
  {
    id: 'Bidirectional',
    uiType: 'ohif.toolButton',
    props: {
      icon: 'tool-bidirectional',
      label: i18n.t('Buttons:Bidirectional'),
      tooltip: i18n.t('Buttons:Bidirectional Tool'),
      commands: setToolActiveToolbar,
      evaluate: 'evaluate.cornerstoneTool',
    },
  },
  {
    id: 'ArrowAnnotate',
    uiType: 'ohif.toolButton',
    props: {
      icon: 'tool-annotate',
      label: i18n.t('Buttons:Arrow Annotate'),
      tooltip: i18n.t('Buttons:Arrow Annotate Tool'),
      commands: setToolActiveToolbar,
      evaluate: 'evaluate.cornerstoneTool',
    },
  },
  {
    id: 'EllipticalROI',
    uiType: 'ohif.toolButton',
    props: {
      icon: 'tool-ellipse',
      label: i18n.t('Buttons:Ellipse'),
      tooltip: i18n.t('Buttons:Ellipse Tool'),
      commands: setToolActiveToolbar,
      evaluate: 'evaluate.cornerstoneTool',
    },
  },
  // [2026-08-17 新增] 矩形测量工具（RectangleROI）
  // 功能：用于绘制矩形ROI，快速测量规则矩形区域的面积和统计值
  {
    id: 'RectangleROI',
    uiType: 'ohif.toolButton',
    props: {
      icon: 'tool-rectangle',
      label: i18n.t('Buttons:Rectangle'),
      tooltip: i18n.t('Buttons:Rectangle ROI'),
      commands: setToolActiveToolbar,
      evaluate: 'evaluate.cornerstoneTool',
    },
  },
  // 2026-04-29 - 添加多边形测量和圆测量工具（PlanarFreehandROI）
  // 功能：用于绘制自由形状的多边形测量，适用于不规则区域的测量
  {
    id: 'PlanarFreehandROI',
    uiType: 'ohif.toolButton',
    props: {
      icon: 'tool-freehand-roi',
      label: i18n.t('Buttons:Polygon'),
      tooltip: i18n.t('Buttons:Polygon Tool'),
      commands: setToolActiveToolbar,
      evaluate: 'evaluate.cornerstoneTool',
    },
  },
  // 2026-04-29 - 添加圆测量工具（CircleROI）
  // 功能：用于绘制圆形测量，适用于圆形或近似圆形区域的测量
  {
    id: 'CircleROI',
    uiType: 'ohif.toolButton',
    props: {
      icon: 'tool-circle',
      label: i18n.t('Buttons:Circle'),
      tooltip: i18n.t('Buttons:Circle Tool'),
      commands: setToolActiveToolbar,
      evaluate: 'evaluate.cornerstoneTool',
    },
  },
  // [2026-06-26 新增] 球体测量工具（SphereROI）
  // 功能：绘制圆形构建3D球体，计算 SUV Max/Min/Mean、面积、体积
  // 适用于PT和CT视口，支持SUVbw和HU单位
  {
    id: 'SphereROI',
    uiType: 'ohif.toolButton',
    props: {
      icon: 'tool-sphere-roi',
      label: i18n.t('Buttons:Sphere'),
      tooltip: i18n.t('Buttons:Sphere Tool'),
      commands: setToolActiveToolbar,
      evaluate: 'evaluate.cornerstoneTool',
    },
  },
  // [2026-05-15 新增] 角度测量工具（Angle）
  // 功能：通过三点绘制角度，测量两条线段之间的夹角
  // 参考：基础查看器 modes/basic/src/toolbarButtons.ts 中的 Angle 按钮定义
  {
    id: 'Angle',
    uiType: 'ohif.toolButton',
    props: {
      icon: 'tool-angle',
      label: i18n.t('Buttons:Angle'),
      tooltip: i18n.t('Buttons:Angle'),
      commands: setToolActiveToolbar,
      evaluate: 'evaluate.cornerstoneTool',
    },
  },
  // [2026-05-15 新增] Cobb角测量工具（CobbAngle）
  // 功能：通过四点绘制Cobb角，用于脊柱侧弯角度的测量
  // 参考：基础查看器 modes/basic/src/toolbarButtons.ts 中的 CobbAngle 按钮定义
  {
    id: 'CobbAngle',
    uiType: 'ohif.toolButton',
    props: {
      icon: 'icon-tool-cobb-angle',
      label: i18n.t('Buttons:Cobb Angle'),
      tooltip: i18n.t('Buttons:Cobb Angle'),
      commands: setToolActiveToolbar,
      evaluate: 'evaluate.cornerstoneTool',
    },
  },
  // 2026-08-31 功能说明：对比时仅清除当前检查，普通 TMTV 保留原清除行为。
  {
    id: 'ClearMeasurements',
    uiType: 'ohif.toolButton',
    props: {
      icon: 'old-trash',
      label: i18n.t('Buttons:Clear'),
      tooltip: i18n.t('Buttons:Clear Measurements'),
      commands: {
        commandName: 'clearTMTVMeasurements',
        context: 'TMTV:CORNERSTONE',
        commandOptions: {},
      },
    },
  },
  {
    id: 'Zoom',
    uiType: 'ohif.toolButton',
    props: {
      icon: 'tool-zoom',
      label: i18n.t('Buttons:Zoom'),
      commands: setToolActiveToolbar,
      evaluate: 'evaluate.cornerstoneTool',
    },
  },
  // [2026-08-20 修改] 调窗按钮改为拆分交互按钮（ohif.tmtvWindowLevelMenu）
  // 左键点击激活WindowLevel工具（手动调窗，与其他工具互斥），右键点击展开CT预设（仅应用到CT视口）
  {
    id: 'WindowLevel',
    uiType: 'ohif.tmtvWindowLevelMenu',
    props: {
      icon: 'tool-window-level',
      label: i18n.t('Buttons:Window Level'),
      commands: setToolActiveToolbar,
      evaluate: 'evaluate.cornerstoneTool',
    },
  },
  {
    id: 'Crosshairs',
    uiType: 'ohif.toolButton',
    props: {
      icon: 'tool-crosshair',
      label: i18n.t('Buttons:Crosshairs'),
      commands: 'toggleTMTVCrosshairs',
      // [2026-08-04] 使用自定义 evaluator，在 TMTV 布局时基于 tmtvCrosshairService.getVisible()
      // 决定 isActive（蓝色背景），在非 TMTV 布局时回退到标准 toolGroup 检查。
      // 原 evaluate.action 不返回 isActive，导致按钮永远不显示蓝色激活态。
      evaluate: 'evaluate.tmtvCrosshair',
    },
  },
  // [2026-05-19 新增, 2026-08-06 修改] 单切线旋转按钮
  // [2026-08-06] 改为通过 CrosshairDisplayService 统一管理显示状态
  // 不再直接绑定 SingleSliceLineTool，而是统一入口：
  //   - TMTV 布局 → SVG overlay 显示十字线
  //   - 旧 MPR 布局 → Cornerstone CrosshairsTool 显示十字线
  {
    id: 'SingleSliceLine',
    uiType: 'ohif.toolButton',
    props: {
      icon: 'tool-single-slice-line',
      label: i18n.t('Buttons:Single Slice Line'),
      tooltip: i18n.t('Buttons:Single Slice Line Tool'),
      commands: 'enableSingleLine',
      evaluate: 'evaluate.singleLine',
    },
  },
  // [2026-05-22 新增] 手动微调按钮 - 融合图像位置微调
  // 功能：点击激活FusionAdjustTool，左键平移PET图像
  // 下拉菜单包含重置和操作说明
  {
    id: 'FusionAdjust',
    uiType: 'ohif.fusionAdjustMenu',
    props: {
      icon: 'tool-fusion-adjust',
      label: i18n.t('Buttons:Fusion Adjust'),
      tooltip: i18n.t('Buttons:Fusion Adjust'),
      evaluate: 'evaluate.action',
    },
  },
  // [2026-07-01 新增] 覆盖层菜单按钮 - 控制十字线和患者信息的显示/隐藏
  {
    id: 'Overlay',
    uiType: 'ohif.overlayMenu',
    props: {
      icon: 'EyeVisible',
      label: i18n.t('Buttons:Overlay'),
      tooltip: i18n.t('Buttons:Toggle overlay visibility (crosshairs, patient info)'),
      evaluate: 'evaluate.action',
    },
  },
  // [2026-08-06 新增] 同步设置菜单按钮 - 控制方位切换是否同步到其他视口
  {
    id: 'SyncMenu',
    uiType: 'ohif.syncMenu',
    props: {
      icon: 'icon-sync',
      label: '同步',
      tooltip: '同步设置',
      evaluate: 'evaluate.action',
    },
  },
  // [2026-07-06 新增] 伪彩色菜单按钮 - 切换PT volume的伪彩色映射
  {
    id: 'Colormap',
    uiType: 'ohif.colormapMenu',
    props: {
      icon: 'icon-color-lut',
      label: '伪彩色',
      tooltip: '切换伪彩色映射',
      evaluate: 'evaluate.action',
    },
  },
  // [2026-07-08 新增] SUV阈值菜单按钮 - 快速设置PET窗位(体部SUV=6/头部SUV=10)
  {
    id: 'SuvThreshold',
    uiType: 'ohif.suvThresholdMenu',
    props: {
      icon: 'Threshold',
      label: 'SUV阈值',
      tooltip: '设置SUV窗位阈值',
      evaluate: 'evaluate.action',
    },
  },
  // [2026-05-11 新增] 3D旋转按钮 - 仅在MIP视口和3D视口中可用
  // 功能：鼠标左键拖拽旋转MIP图像或3D体积
  // 限制：CT/PT/Fusion等2D视口不可用（工具未注册到对应toolGroup）
  {
    id: 'TrackballRotate',
    uiType: 'ohif.toolButton',
    props: {
      type: 'tool',
      icon: 'tool-3d-rotate',
      label: i18n.t('Buttons:3D Rotate'),
      commands: {
        commandName: 'setToolActiveToolbar',
        commandOptions: {
          // [2026-05-11] MIP工具组：旋转MIP图像；volume3d工具组：旋转3D体积
          // CT/PT/Fusion工具组不包含此工具，按钮自动禁用
          toolGroupIds: [toolGroupIds.MIP, 'volume3d'],
        },
      },
      evaluate: {
        name: 'evaluate.cornerstoneTool',
        disabledText: i18n.t('Buttons:Select a MIP or 3D viewport to enable this tool'),
      },
    },
  },
  {
    id: 'Pan',
    uiType: 'ohif.toolButton',
    props: {
      icon: 'tool-move',
      label: i18n.t('Buttons:Pan'),
      commands: setToolActiveToolbar,
      evaluate: 'evaluate.cornerstoneTool',
    },
  },
  {
    id: 'RectangleROIStartEndThreshold',
    uiType: 'ohif.toolBoxButton',
    props: {
      icon: 'tool-create-threshold',
      label: i18n.t('Buttons:Rectangle ROI Threshold'),
      commands: setSegmentationToolActiveToolbar,
      evaluate: [
        'evaluate.cornerstone.segmentation',
        {
          name: 'evaluate.cornerstoneTool',
          disabledText: i18n.t('Buttons:Select the PT or Fusion viewport to enable this tool'),
        },
      ],
      options: 'tmtv.RectangleROIThresholdOptions',
    },
  },

  // [2026-06-08 新增] 打点分割（一键点击分割）按钮
  // 功能：鼠标悬停显示预览（+号），点击自动分割病灶区域，无需手动涂抹
  {
    id: 'RegionSegmentPlus',
    uiType: 'ohif.toolBoxButton',
    props: {
      icon: 'icon-tool-click-segment',
      label: i18n.t('Buttons:One Click Segment'),
      tooltip: i18n.t(
        'Buttons:Detects segmentable regions with one click. Hover for visual feedback—click when a plus sign appears to auto-segment the lesion.'
      ),
      evaluate: [
        {
          name: 'evaluate.cornerstone.segmentation',
          toolNames: ['RegionSegmentPlus'],
          disabledText: i18n.t('Buttons:Create new segmentation to enable this tool.'),
        },
        {
          name: 'evaluate.cornerstone.hasSegmentationOfType',
          segmentationRepresentationType: 'Labelmap',
        },
      ],
      commands: [
        setSegmentationToolActiveToolbar,
        {
          commandName: 'activateSelectedSegmentationOfType',
          commandOptions: {
            segmentationRepresentationType: 'Labelmap',
          },
        },
        ensurePrimaryTMTVSegmentationActive,
      ],
    },
  },

  {
    id: 'Brush',
    uiType: 'ohif.toolButton',
    props: {
      icon: 'icon-tool-brush',
      label: i18n.t('Buttons:Brush'),
      commands: [setSegmentationToolActiveToolbar, ensurePrimaryTMTVSegmentationActive],
      evaluate: [
        {
          name: 'evaluate.cornerstone.segmentation',
          toolNames: ['CircularBrush', 'SphereBrush'],
          disabledText: i18n.t('Buttons:Create new segmentation to enable this tool.'),
        },
        {
          name: 'evaluate.cornerstone.segmentation.synchronizeDrawingRadius',
          radiusOptionId: 'brush-radius',
        },
      ],
      options: [
        {
          name: i18n.t('Buttons:Radius (mm)'),
          id: 'brush-radius',
          type: 'range',
          explicitRunOnly: true,
          min: MIN_SEGMENTATION_DRAWING_RADIUS,
          max: MAX_SEGMENTATION_DRAWING_RADIUS,
          step: 0.5,
          value: 25,
          commands: {
            commandName: 'setBrushSize',
            commandOptions: { toolNames: ['CircularBrush', 'SphereBrush'] },
          },
        },
        {
          name: i18n.t('Buttons:Shape'),
          type: 'radio',
          id: 'brush-mode',
          value: 'CircularBrush',
          values: [
            { value: 'CircularBrush', label: i18n.t('Buttons:Circle') },
            { value: 'SphereBrush', label: i18n.t('Buttons:Sphere') },
          ],
          commands: setSegmentationToolActiveToolbar,
        },
      ],
    },
  },
  {
    id: 'Eraser',
    uiType: 'ohif.toolButton',
    props: {
      icon: 'icon-tool-eraser',
      label: i18n.t('Buttons:Eraser'),
      commands: [setSegmentationToolActiveToolbar, ensurePrimaryTMTVSegmentationActive],
      evaluate: [
        {
          name: 'evaluate.cornerstone.segmentation',
          toolNames: ['CircularEraser', 'SphereEraser'],
        },
        {
          name: 'evaluate.cornerstone.segmentation.synchronizeDrawingRadius',
          radiusOptionId: 'eraser-radius',
        },
      ],
      options: [
        {
          name: i18n.t('Buttons:Radius (mm)'),
          id: 'eraser-radius',
          type: 'range',
          explicitRunOnly: true,
          min: MIN_SEGMENTATION_DRAWING_RADIUS,
          max: MAX_SEGMENTATION_DRAWING_RADIUS,
          step: 0.5,
          value: 25,
          commands: {
            commandName: 'setBrushSize',
            commandOptions: { toolNames: ['CircularEraser', 'SphereEraser'] },
          },
        },
        {
          name: i18n.t('Buttons:Shape'),
          type: 'radio',
          id: 'eraser-mode',
          value: 'CircularEraser',
          values: [
            { value: 'CircularEraser', label: i18n.t('Buttons:Circle') },
            { value: 'SphereEraser', label: i18n.t('Buttons:Sphere') },
          ],
          commands: setSegmentationToolActiveToolbar,
        },
      ],
    },
  },
  {
    id: 'Threshold',
    uiType: 'ohif.toolButton',
    props: {
      icon: 'icon-tool-threshold',
      label: i18n.t('Buttons:Threshold Tool'),
      commands: [setSegmentationToolActiveToolbar, ensurePrimaryTMTVSegmentationActive],
      evaluate: [
        {
          name: 'evaluate.cornerstone.segmentation',
          toolNames: [
            'ThresholdCircularBrush',
            'ThresholdSphereBrush',
            'ThresholdCircularBrushDynamic',
          ],
        },
        {
          name: 'evaluate.cornerstone.segmentation.synchronizeDrawingRadius',
          radiusOptionId: 'threshold-radius',
        },
      ],
      options: [
        {
          name: i18n.t('Buttons:Radius (mm)'),
          id: 'threshold-radius',
          type: 'range',
          explicitRunOnly: true,
          min: MIN_SEGMENTATION_DRAWING_RADIUS,
          max: MAX_SEGMENTATION_DRAWING_RADIUS,
          step: 0.5,
          value: 25,
          commands: {
            commandName: 'setBrushSize',
            commandOptions: {
              toolNames: [
                'ThresholdCircularBrush',
                'ThresholdSphereBrush',
                'ThresholdCircularBrushDynamic',
              ],
            },
          },
        },
        {
          name: i18n.t('Buttons:Threshold'),
          type: 'radio',
          id: 'dynamic-mode',
          value: 'ThresholdRange',
          values: [
            { value: 'ThresholdDynamic', label: i18n.t('Buttons:Dynamic') },
            { value: 'ThresholdRange', label: i18n.t('Buttons:Range') },
          ],
          commands: ({ value, commandsManager }) => {
            if (value === 'ThresholdDynamic') {
              commandsManager.run('setToolActiveToolbar', {
                toolName: 'ThresholdCircularBrushDynamic',
                toolGroupIds: [toolGroupIds.PT, toolGroupIds.Fusion],
              });
            } else {
              commandsManager.run('setToolActiveToolbar', {
                toolName: 'ThresholdCircularBrush',
                toolGroupIds: [toolGroupIds.PT, toolGroupIds.Fusion],
              });
            }
          },
        },
        {
          name: i18n.t('Buttons:Shape'),
          type: 'radio',
          id: 'eraser-mode',
          value: 'ThresholdCircularBrush',
          values: [
            { value: 'ThresholdCircularBrush', label: i18n.t('Buttons:Circle') },
            { value: 'ThresholdSphereBrush', label: i18n.t('Buttons:Sphere') },
          ],
          condition: ({ options }) =>
            options.find(option => option.id === 'dynamic-mode').value === 'ThresholdRange',
          commands: setSegmentationToolActiveToolbar,
        },
        {
          name: i18n.t('ROIThresholdConfiguration:ThresholdRange'),
          type: 'double-range',
          id: 'threshold-range',
          min: 0,
          max: 50,
          step: 0.5,
          value: [2.5, 50],
          condition: ({ options }) =>
            options.find(option => option.id === 'dynamic-mode').value === 'ThresholdRange',
          commands: {
            commandName: 'setThresholdRange',
            commandOptions: {
              toolNames: ['ThresholdCircularBrush', 'ThresholdSphereBrush'],
            },
          },
        },
      ],
    },
  },
  {
    id: 'dataOverlayMenu',
    uiType: 'ohif.dataOverlayMenu',
    props: {
      icon: 'ViewportViews',
      label: i18n.t('Buttons:Data Overlay'),
      tooltip: i18n.t(
        'Buttons:Configure data overlay options and manage foreground/background display sets'
      ),
      evaluate: {
        name: 'evaluate.dataOverlayMenu',
        hideWhenDisabled: true,
      },
    },
  },
  {
    id: 'orientationMenu',
    uiType: 'ohif.orientationMenu',
    props: {
      icon: 'OrientationSwitch',
      label: i18n.t('Buttons:Orientation'),
      tooltip: i18n.t(
        'Buttons:Change viewport orientation between axial, sagittal, coronal and reformat planes'
      ),
      evaluate: {
        name: 'evaluate.orientationMenu',
        hideWhenDisabled: true,
      },
    },
  },
  {
    id: 'windowLevelMenu',
    uiType: 'ohif.windowLevelMenu',
    props: {
      icon: 'WindowLevel',
      label: i18n.t('Buttons:Window Level'),
      tooltip: i18n.t('Buttons:Adjust window/level presets and customize image contrast settings'),
      evaluate: {
        name: 'evaluate.windowLevelMenu',
        hideWhenDisabled: true,
      },
    },
  },
  {
    id: 'voiManualControlMenu',
    uiType: 'ohif.voiManualControlMenu',
    props: {
      icon: 'WindowLevelAdvanced',
      label: i18n.t('Buttons:Advanced Window Level'),
      tooltip: i18n.t('Buttons:Advanced window/level settings with manual controls and presets'),
      evaluate: {
        name: 'evaluate.voiManualControlMenu',
        hideWhenDisabled: true,
      },
    },
  },
  {
    id: 'thresholdMenu',
    uiType: 'ohif.thresholdMenu',
    props: {
      icon: 'Threshold',
      label: i18n.t('Buttons:Threshold'),
      tooltip: i18n.t('Buttons:Image threshold settings'),
      evaluate: {
        name: 'evaluate.thresholdMenu',
        hideWhenDisabled: true,
      },
    },
  },
  {
    id: 'opacityMenu',
    uiType: 'ohif.opacityMenu',
    props: {
      icon: 'Opacity',
      label: i18n.t('Buttons:Opacity'),
      tooltip: i18n.t('Buttons:Image opacity settings'),
      evaluate: {
        name: 'evaluate.opacityMenu',
        hideWhenDisabled: true,
      },
    },
  },
  // 2026-04-29 - TMTV专用布局选择器按钮
  // 功能：仅显示融合相关布局（默认布局、Fusion 2x2、PT+Fusion）及三维布局
  {
    id: 'TmtvLayout',
    uiType: 'ohif.tmtvLayoutSelector',
    props: {
      evaluate: 'evaluate.action',
    },
  },
  // ============================================================================
  // [2026-04-29 新增功能] TMTV模式探针功能按钮配置 (Probe)
  // ============================================================================
  //
  // 按钮ID: 'Probe'
  // 按钮类型: ohif.toolButton (工具按钮)
  // 显示位置: 主工具栏 primary section (独立于测量工具区域)
  // 图标: tool-probe (基础查看器的探针图标)
  //
  // ============================================================================
  // 功能描述:
  //   提供TMTV模式专用的实时像素值探针功能开关。
  //   用户点击此按钮可开启/关闭探针模式，开启后鼠标移入PET/CT图像
  //   视口时会自动显示当前位置的像素坐标和数值（HU或SUVbw）。
  //
  // ============================================================================
  // 与基础查看器(basic viewer)的区别:
  //
  // 基础查看器的Probe:
  //   - 使用Cornerstone3D内置的ProbeTool工具
  //   - 需要先激活工具才能使用
  //   - 属于标准测量工具系统的一部分
  //
  // TMTV模式的Probe (本实现):
  //   - 使用自定义PixelInfoOverlay组件 (非Cornerstone3D ProbeTool)
  //   - 鼠标移入即显示，无需预先激活任何工具
  //   - 独立于标准工具系统运行，但通过互斥逻辑避免冲突
  //   - 支持Fusion视口的PT volume优先显示SUV值
  //
  // ============================================================================
  // 交互行为:
  //
  // 默认状态 (页面加载):
  //   - 按钮不高亮
  //   - 探针功能关闭
  //   - 鼠标移入图像无反应
  //
  // 点击按钮后 (启用):
  //   - 按钮高亮显示 (active状态)
  //   - 自动取消所有测量工具的激活状态 (互斥)
  //   - 鼠标移入CT/PT/Fusion视口 → 显示浮动像素信息提示
  //   - 浮动提示跟随鼠标移动，实时更新坐标和数值
  //
  // 再次点击 (禁用):
  //   - 按钮取消高亮
  //   - 探针功能关闭
  //   - 已显示的浮动提示立即隐藏
  //   - 不自动恢复测量工具 (用户需手动选择)
  //
  // ============================================================================
  // 显示内容格式:
  //
  // CT视口:
  // ┌──────────────────────┐
  // │ P:256 A:320 F:45     │  ← IJK体素坐标
  // │ Value:-1024 HU       │  ← CT值 (Hounsfield Unit)
  // └──────────────────────┘
  //
  // PT/Fusion视口:
  // ┌──────────────────────┐
  // │ P:128 A:256 F:30     │  ← IJK体素坐标
  // │ Value:2.35 SUV bw    │  ← PET值 (Standardized Uptake Value)
  // └──────────────────────┘
  //
  // 样式: 黑色半透明背景(rgba(0,0,0,0.75)) + #00ff00绿色文字 + 圆角边框
  //
  // ============================================================================
  // 技术实现架构:
  //
  // 按钮配置 (本文件)
  //   ↓ 点击触发
  // commandsModule.togglePixelInfo命令
  //   ↓ 执行
  // PixelInfoManager.enable()/disable()
  //   ↓ 更新全局状态
  // window.__pixelInfoEnabled = true/false
  //   ↓ 被读取
  // getToolbarModule.evaluate.pixelInfoActive()
  //   ↓ 返回 { isActive: true/false }
  // 按钮UI更新 (高亮/取消)
  //   ↓ 同时
  // CustomEvent('pixelInfoStateChanged')
  //   ↓ 被监听
  // PixelInfoOverlay组件 × N个实例
  //   ↓ 更新enabled state
  // 开始/停止响应mousemove事件
  //
  // ============================================================================
  // 配置项说明:
  //
  // id: 'Probe'
  //   - 按钮唯一标识符
  //   - 在index.ts中通过此ID注册到工具栏section
  //
  // uiType: 'ohif.toolButton'
  //   - OHIF标准工具按钮类型
  //   - 支持图标、标签、tooltip、命令绑定等属性
  //
  // icon: 'tool-probe'
  //   - 使用OHIF内置的探针图标
  //   - 图标定义位置: platform/ui-next/src/components/Icons/Icons.tsx
  //   - 别名映射: 'tool-probe' → ToolProbe 组件
  //
  // commands.commandName: 'togglePixelInfo'
  //   - 点击按钮时执行的命令名称
  //   - 命令定义位置: extensions/cornerstone/src/commandsModule.ts
  //   - 命令包含互斥逻辑 (启用探针时取消测量工具)
  //
  // evaluate.name: 'evaluate.pixelInfoActive'
  //   - 自定义评估函数名称
  //   - 函数定义位置: extensions/cornerstone/src/getToolbarModule.tsx
  //   - 功能: 读取window.__pixelInfoEnabled返回isActive状态
  //   - 用途: 控制按钮的高亮/非高亮视觉状态
  //
  // ============================================================================
  // 文件位置:
  //   modes/tmtv/src/toolbarButtons.ts (本文件)
  //
  // 相关文件:
  //   - modes/tmtv/src/index.ts (将Probe注册到primary section)
  //   - extensions/cornerstone/src/commandsModule.ts (togglePixelInfo命令实现)
  //   - extensions/cornerstone/src/getToolbarModule.tsx (evaluate.pixelInfoActive函数)
  //   - extensions/cornerstone/src/Viewport/Overlays/PixelInfoOverlay.tsx (核心组件)
  //
  // 修改历史:
  //   [2026-04-29] 初始创建 - 基础按钮配置
  //   [2026-04-29] 从MeasurementTools移动到主工具栏独立显示
  //   [2026-04-29] 改用自定义evaluate函数控制高亮状态
  //
  // ============================================================================
  {
    id: 'Probe', // [2026-04-29] 按钮唯一标识 - 用于在index.ts中引用

    uiType: 'ohif.toolButton', // OHIF标准工具按钮类型

    props: {
      icon: 'tool-probe', // [2026-04-29] 使用基础查看器的探针图标 ( Icons.tsx中定义 )

      label: i18n.t('Buttons:Probe'), // 按钮显示文本 (国际化)

      tooltip: i18n.t('Buttons:Toggle auto probe (mouse move to show pixel values)'), // 鼠标悬停提示文本

      // [2026-04-29] 命令配置 - 定义点击按钮时执行的操作
      commands: {
        commandName: 'togglePixelInfo', // 调用commandsModule中定义的togglePixelInfo命令
        // 该命令实现:
        //   1. 切换PixelInfoManager的全局开关状态
        //   2. 实现与测量工具的互斥逻辑 (启用探针时取消其他工具)
        commandOptions: {}, // 命令参数 (当前无额外参数)
      },

      // [2026-04-29] 状态评估配置 - 控制按钮的active高亮状态
      evaluate: {
        name: 'evaluate.pixelInfoActive', // 自定义评估函数名称
        // 函数定义在 getToolbarModule.tsx 中
        // 功能: 读取 window.__pixelInfoEnabled 全局变量
        // 返回: { isActive: true/false } 控制按钮是否高亮
      },
    },
  },
];

export default toolbarButtons;
