import { MIN_SEGMENTATION_DRAWING_RADIUS, MAX_SEGMENTATION_DRAWING_RADIUS } from './constants';
import { PlanarFreehandROITool, CrosshairsTool } from '@cornerstonejs/tools'; // [2026-05-11 新增] 导入CrosshairsTool，用于修补mouseMoveCallback崩溃问题
import { getRenderingEngine } from '@cornerstonejs/core'; // [2026-05-20 新增] 用于获取视口实例以重置相机旋转
import { wrapGetTextLinesWithSUV } from 'd:/OHIF/extensions/tmtv/src/utils/fusionMeasurementText'; // [2026-07-07 新增] Fusion视口测量结果显示SUV值

// [2026-05-11 修改] 工具组ID定义
// 移除了 MPR: 'mpr'，原因：TMTV模式不再创建独立的MPR工具组，
// 避免覆盖基础查看器的MPR工具组导致黑屏问题
export const toolGroupIds = {
  CT: 'ctToolGroup',
  PT: 'ptToolGroup',
  Fusion: 'fusionToolGroup',
  MIP: 'mipToolGroup',
  default: 'default',
};

function _initToolGroups(toolNames, Enums, toolGroupService, commandsManager) {
  const tools = {
    active: [
      {
        toolName: toolNames.WindowLevel,
        bindings: [{ mouseButton: Enums.MouseBindings.Primary }],
      },
      {
        toolName: toolNames.Pan,
        bindings: [{ mouseButton: Enums.MouseBindings.Auxiliary }],
      },
      {
        // [2026-06-24 修改] zoomToCenter: true - 缩放以视口中心为基准
        // 默认 false 时以鼠标位置为中心，放大后缩小会导致图像位置偏移
        toolName: toolNames.Zoom,
        bindings: [{ mouseButton: Enums.MouseBindings.Secondary }, { numTouchPoints: 2 }],
        configuration: { zoomToCenter: true },
      },
      {
        toolName: toolNames.StackScroll,
        bindings: [{ mouseButton: Enums.MouseBindings.Wheel }, { numTouchPoints: 3 }],
      },
    ],
    passive: [
      { toolName: toolNames.Length },
      { toolName: toolNames.SegmentBidirectional },
      {
        toolName: toolNames.ArrowAnnotate,
        configuration: {
          getTextCallback: (callback, eventDetails) => {
            commandsManager.runCommand('arrowTextCallback', {
              callback,
              eventDetails,
            });
          },
          changeTextCallback: (data, eventDetails, callback) => {
            commandsManager.runCommand('arrowTextCallback', {
              callback,
              data,
              eventDetails,
            });
          },
        },
      },
      { toolName: toolNames.Bidirectional },
      { toolName: toolNames.DragProbe },
      { toolName: toolNames.Probe },
      { toolName: toolNames.EllipticalROI },
      { toolName: toolNames.RectangleROI },
      // 2026-04-29 - 添加多边形测量和圆测量工具到passive数组
      { toolName: toolNames.PlanarFreehandROI },
      { toolName: toolNames.CircleROI },
      // [2026-06-26 新增] 球体测量工具 - 3D球体统计(SUV Max/Min/Mean, 面积, 体积)
      { toolName: toolNames.SphereROI },
      { toolName: toolNames.StackScroll },
      { toolName: toolNames.Angle },
      { toolName: toolNames.CobbAngle },
      { toolName: toolNames.Magnify },
      {
        toolName: 'CircularBrush',
        parentTool: 'Brush',
        configuration: {
          activeStrategy: 'FILL_INSIDE_CIRCLE',
          minRadius: MIN_SEGMENTATION_DRAWING_RADIUS,
          maxRadius: MAX_SEGMENTATION_DRAWING_RADIUS,
        },
      },
      {
        toolName: 'CircularEraser',
        parentTool: 'Brush',
        configuration: {
          activeStrategy: 'ERASE_INSIDE_CIRCLE',
          minRadius: MIN_SEGMENTATION_DRAWING_RADIUS,
          maxRadius: MAX_SEGMENTATION_DRAWING_RADIUS,
        },
      },
      {
        toolName: 'SphereBrush',
        parentTool: 'Brush',
        configuration: {
          activeStrategy: 'FILL_INSIDE_SPHERE',
          minRadius: MIN_SEGMENTATION_DRAWING_RADIUS,
          maxRadius: MAX_SEGMENTATION_DRAWING_RADIUS,
        },
      },
      {
        toolName: 'SphereEraser',
        parentTool: 'Brush',
        configuration: {
          activeStrategy: 'ERASE_INSIDE_SPHERE',
          minRadius: MIN_SEGMENTATION_DRAWING_RADIUS,
          maxRadius: MAX_SEGMENTATION_DRAWING_RADIUS,
        },
      },
      {
        toolName: 'ThresholdCircularBrush',
        parentTool: 'Brush',
        configuration: {
          activeStrategy: 'THRESHOLD_INSIDE_CIRCLE',
          minRadius: MIN_SEGMENTATION_DRAWING_RADIUS,
          maxRadius: MAX_SEGMENTATION_DRAWING_RADIUS,
        },
      },
      {
        toolName: 'ThresholdSphereBrush',
        parentTool: 'Brush',
        configuration: {
          activeStrategy: 'THRESHOLD_INSIDE_SPHERE',
          minRadius: MIN_SEGMENTATION_DRAWING_RADIUS,
          maxRadius: MAX_SEGMENTATION_DRAWING_RADIUS,
        },
      },
      {
        toolName: 'ThresholdCircularBrushDynamic',
        parentTool: 'Brush',
        configuration: {
          activeStrategy: 'THRESHOLD_INSIDE_CIRCLE',
          // preview: {
          //   enabled: true,
          // },
          threshold: {
            isDynamic: true,
            dynamicRadius: 3,
          },
          minRadius: MIN_SEGMENTATION_DRAWING_RADIUS,
          maxRadius: MAX_SEGMENTATION_DRAWING_RADIUS,
        },
      },
      // [2026-06-08 新增] 打点分割工具 - 一键点击自动分割病灶区域
      // 悬停显示预览（+号），点击即自动分割，无需手动涂抹
      {
        toolName: 'RegionSegmentPlus',
      },
      // [2026-05-22 新增] 融合图像微调工具 - 仅在fusionToolGroup中注册
      // 左键拖拽平移PET图像，不影响CT图像
      // 注意：此工具不放在共享tools对象中，避免被注册到CT/PT/default工具组
      // { toolName: toolNames.FusionAdjust },
    ],
    enabled: [],
    disabled: [
      {
        toolName: toolNames.Crosshairs,
        configuration: {
          disableOnPassive: true,
          autoPan: {
            enabled: false,
            panSize: 10,
          },
        },
      },
      // [2026-05-19 新增] 单切线旋转工具 - 与十字线配置相同
      // 但旋转时仅影响一条参考线对应的一个视口
      {
        toolName: toolNames.SingleSliceLine,
        configuration: {
          disableOnPassive: true,
          autoPan: {
            enabled: false,
            panSize: 10,
          },
        },
      },
    ],
  };

  toolGroupService.createToolGroupAndAddTools(toolGroupIds.CT, tools);
  toolGroupService.createToolGroupAndAddTools(toolGroupIds.PT, {
    active: tools.active,
    passive: [...tools.passive, { toolName: 'RectangleROIStartEndThreshold' }],
    enabled: tools.enabled,
    disabled: tools.disabled,
  });
  toolGroupService.createToolGroupAndAddTools(toolGroupIds.Fusion, {
    ...tools,
    passive: [...tools.passive, { toolName: 'RectangleROIStartEndThreshold' }, { toolName: toolNames.FusionAdjust }],
  });
  toolGroupService.createToolGroupAndAddTools(toolGroupIds.default, tools);

  // [2026-07-07 新增] 为Fusion工具组的测量工具添加SUV值显示
  // 原理：wrapGetTextLinesWithSUV会检查cachedStats中是否有PT volume的统计
  //       如果没有（CT/PT视口），则返回原始文本，不影响其他视口
  // 适用工具：椭圆(EllipticalROI)、多边形(PlanarFreehandROI)、圆(CircleROI)、球体(SphereROI)
  const fusionToolGroup = toolGroupService.getToolGroup(toolGroupIds.Fusion);
  if (fusionToolGroup) {
    const csToolGroup = fusionToolGroup._toolGroup || fusionToolGroup;
    const suvToolNames = [
      toolNames.EllipticalROI,
      toolNames.RectangleROI,
      toolNames.PlanarFreehandROI,
      toolNames.CircleROI,
      toolNames.SphereROI,
    ];
    for (const toolName of suvToolNames) {
      try {
        const tool = csToolGroup.getToolInstance(toolName);
        if (tool?.configuration?.getTextLines) {
          const originalGetTextLines = tool.configuration.getTextLines;
          tool.configuration.getTextLines = wrapGetTextLinesWithSUV(originalGetTextLines);
        }
      } catch (e) {
        console.warn(`initToolGroups: 包装${toolName}的getTextLines失败`, e);
      }
    }
  }

  // [2026-05-11 修改] MIP工具组添加passive工具（StackScroll/Zoom/Pan）
  // 和disabled工具（Crosshairs），确保MIP视口支持基本操作和十字线兼容
  // [2026-05-11 新增] 添加TrackballRotate工具到passive列表，支持3D旋转MIP图像
  const mipTools = {
    active: [
      {
        toolName: toolNames.VolumeRotate,
        bindings: [{ mouseButton: Enums.MouseBindings.Wheel }],
        configuration: {
          rotateIncrementDegrees: 5,
        },
      },
      {
        toolName: toolNames.MipJumpToClick,
        configuration: {
          toolGroupId: toolGroupIds.PT,
        },
        bindings: [{ mouseButton: Enums.MouseBindings.Primary }],
      },
    ],
    passive: [
      { toolName: toolNames.StackScroll },
      // [2026-06-24 修改] MIP视口Zoom同样启用 zoomToCenter: true
      { toolName: toolNames.Zoom, configuration: { zoomToCenter: true } },
      { toolName: toolNames.Pan },
      // [2026-05-11 新增] TrackballRotate工具 - 用于3D旋转MIP图像
      // 激活后替换MipJumpToClick的左键绑定，实现鼠标拖拽旋转
      { toolName: toolNames.TrackballRotateTool },
      // [2026-08-14 新增] 箭头标注工具 - MIP视口支持箭头标注
      // 原因：mipToolGroup未注册ArrowAnnotate，导致按钮在MIP视口被禁用
      // 配置与CT/PT/Fusion工具组保持一致，复用arrowTextCallback命令处理文本输入
      {
        toolName: toolNames.ArrowAnnotate,
        configuration: {
          getTextCallback: (callback, eventDetails) => {
            commandsManager.runCommand('arrowTextCallback', {
              callback,
              eventDetails,
            });
          },
          changeTextCallback: (data, eventDetails, callback) => {
            commandsManager.runCommand('arrowTextCallback', {
              callback,
              data,
              eventDetails,
            });
          },
        },
      },
    ],
    enabled: [],
    disabled: [
      // [2026-05-11 修复] Crosshairs必须注册到MIP工具组
      // 即使是disabled状态，工具实例也会被创建
      // 这样Crosshairs同步时不会因找不到实例而报错
      {
        toolName: toolNames.Crosshairs,
        configuration: {
          disableOnPassive: true,
          autoPan: {
            enabled: false,
            panSize: 10,
          },
        },
      },
      // [2026-05-19 新增] 单切线旋转工具 - 注册到MIP工具组
      {
        toolName: toolNames.SingleSliceLine,
        configuration: {
          disableOnPassive: true,
          autoPan: {
            enabled: false,
            panSize: 10,
          },
        },
      },
    ],
  };

  toolGroupService.createToolGroupAndAddTools(toolGroupIds.MIP, mipTools);

  // [2026-05-11 新增] 创建 volume3d 工具组
  // 原因：TMTV的三维布局(only3D)使用 toolGroupId: 'volume3d'，
  //       如果不创建此工具组，切换到三维布局时3D旋转按钮会被禁用
  // 参考：基础查看器 modes/basic/src/initToolGroups.ts 中的 initVolume3DToolGroup
  const volume3dTools = {
    active: [
      {
        toolName: toolNames.TrackballRotateTool,
        bindings: [{ mouseButton: Enums.MouseBindings.Primary }],
      },
      {
        // [2026-06-24 修改] zoomToCenter: true - 缩放以视口中心为基准
        // 默认 false 时以鼠标位置为中心，放大后缩小会导致图像位置偏移
        toolName: toolNames.Zoom,
        bindings: [{ mouseButton: Enums.MouseBindings.Secondary }, { numTouchPoints: 2 }],
        configuration: { zoomToCenter: true },
      },
      {
        toolName: toolNames.Pan,
        bindings: [{ mouseButton: Enums.MouseBindings.Auxiliary }, { numTouchPoints: 3 }],
      },
    ],
  };

  toolGroupService.createToolGroupAndAddTools('volume3d', volume3dTools);

  // [2026-05-11 修改] 移除了MPR工具组的创建
  // 原因：TMTV模式创建MPR工具组会覆盖基础查看器的同名工具组，导致基础查看器MPR黑屏
  // TMTV的MPR布局现在使用fusionToolGroup，不再需要独立的MPR工具组

  // ====================================================================
  // Patch PlanarFreehandROITool.renderAnnotationInstance
  // 修改时间：2026-04-29
  //
  // 解决问题：在TMTV模式下，使用多边形测量(PlanarFreehandROI)工具在CT视口绘制后，
  //          PT视口无法显示测量标签文字（只有轮廓线，没有Area/Max/Mean等数据）
  //
  // 根因分析：
  //   Cornerstone3D的PlanarFreehandROITool在renderAnnotationInstance方法中，
  //   通过 annotation.invalidated 标志来决定是否计算统计值(stats)：
  //     if (annotation.invalidated) {
  //       this._calculateStatsIfActive(...);  // 只有invalidated=true才计算
  //     }
  //   计算完成后会立即将 invalidated 设为 false（第198-199行原始代码）：
  //     annotation.invalidated = false;
  //
  // 竞态条件（Race Condition）：
  //   当OHIF触发全局渲染时（如切换布局、添加测量等），CT和PT视口在同一轮渲染循环中执行。
  //   ┌─ CT视口 renderAnnotationInstance 执行
  //   │   → annotation.invalidated = true ✅ → 进入stats计算
  //   │   → 计算 ctVolumeId 的 stats（面积、最大值、平均值等）
  //   │   → annotation.invalidated = false ❌ （关键！关闭了stats计算的"门"）
  //   │
  //   └─ PT视口 renderAnnotationInstance 执行
  //       → annotation.invalidated = false ❌ 被"门"挡住！
  //       → 跳过 _calculateStatsIfActive()
  //       → cachedStats[ptVolumeId] 不存在
  //       → _renderStats() → textLines=[] → 无标签显示 ❌
  //
  // 修复方案：
  //   覆盖renderAnnotationInstance原型方法，在调用_calculateStatsIfActive前
  //   强制将annotation.invalidated设为true，确保每个viewport都能独立计算stats。
  //   计算完成后恢复原值，不影响其他逻辑。
  //
  // 影响范围：
  //   - 仅影响 PlanarFreehandROITool（多边形/自由手绘ROI工具）
  //   - 不影响 CircleROI、EllipticalROI 等其他工具（它们有独立的stats计算逻辑）
  //   - 对所有使用 PlanarFreehandROITool 的布局生效（Default、2x3、2x4等）
  // ====================================================================
  if (PlanarFreehandROITool?.prototype?.renderAnnotationInstance) {
    const originalRender = PlanarFreehandROITool.prototype.renderAnnotationInstance;

    // [2026-04-29] 覆盖原型方法：替换为自定义的渲染函数
    PlanarFreehandROITool.prototype.renderAnnotationInstance = function (renderContext) {

      // === 第一步：解构渲染上下文 ===
      const { enabledElement, targetId, svgDrawingHelper } = renderContext;
      const annotation = renderContext.annotation;    // 当前要渲染的annotation对象
      const { viewport, renderingEngine } = enabledElement;
      const data = annotation.data;                   // annotation数据（包含contour、cachedStats等）

      let renderStatus = false;
      const isDrawing = this.isDrawing;               // 是否正在绘制中
      const isEditingOpen = this.isEditingOpen;       // 是否正在编辑开放轮廓
      const isEditingClosed = this.isEditingClosed;   // 是否正在编辑闭合轮廓

      // === 第二步：渲染轮廓线（与原始逻辑完全一致） ===
      // [2026-04-29] 说明：此部分保持Cornerstone3D原始行为不变
      // 三种状态的处理：
      //   1. 静态状态（非绘制、非编辑）→ 渲染完整轮廓
      //   2. 绘制/编辑当前annotation → 渲染动态轮廓（带交互点）
      //   3. 绘制/编辑其他annotation → 渲染静态轮廓（作为背景参考）
      if (!(isDrawing || isEditingOpen || isEditingClosed)) {
        // 状态1：静态渲染
        if (this.configuration.displayOnePointAsCrosshairs &&
            annotation.data.contour.polyline.length === 1) {
          // 单点标记模式：用十字线显示
          this.renderPointContourWithMarker(enabledElement, svgDrawingHelper, annotation);
        } else {
          // 正常模式：渲染多边形轮廓
          this.renderContour(enabledElement, svgDrawingHelper, annotation);
        }
      } else {
        // 状态2或3：动态渲染（正在绘制或编辑）
        const activeAnnotationUID = this.commonData.annotation.annotationUID;
        if (annotation.annotationUID === activeAnnotationUID) {
          // 状态2：正在操作当前annotation（显示交互点）
          if (isDrawing) {
            this.renderContourBeingDrawn(enabledElement, svgDrawingHelper, annotation);
          } else if (isEditingClosed) {
            this.renderClosedContourBeingEdited(enabledElement, svgDrawingHelper, annotation);
          } else if (isEditingOpen) {
            this.renderOpenContourBeingEdited(enabledElement, svgDrawingHelper, annotation);
          }
        } else {
          // 状态3：正在操作其他annotation（当前annotation作为背景）
          if (this.configuration.displayOnePointAsCrosshairs &&
              annotation.data.contour.polyline.length === 1) {
            this.renderPointContourWithMarker(enabledElement, svgDrawingHelper, annotation);
          } else {
            this.renderContour(enabledElement, svgDrawingHelper, annotation);
          }
        }
        renderStatus = true;  // 标记为正在交互（用于返回给调用方）
      }

      // === 第三步：检查是否需要计算并渲染统计数据（标签） ===
      if (!this.configuration.calculateStats) {
        return renderStatus;  // 配置禁用了stats计算，直接返回
      }

      // === 第四步：【核心修复】强制进入stats计算 ===
      // [2026-04-29] 修复说明：确保每个viewport都能独立计算自己的stats
      //
      // 原始问题流程：
      //   CT渲染: invalidated=true → 计算ctVolumeId stats → 设invalidated=false
      //   PT渲染: invalidated=false → 跳过计算 → 无标签 ❌
      //
      // 修复后流程：
      //   CT渲染: hasCachedStats=false → 强制invalidated=true → 计算ctVolumeId stats → 恢复
      //   PT渲染: hasCachedStats=false → 强制invalidated=true → 计算ptVolumeId stats → 恢复 ✅
      //   后续渲染: hasCachedStats=true → 跳过强制（已有数据）→ 正常走原始逻辑 ✅
      const savedInvalidated = annotation.invalidated;

      // [2026-04-29] 核心检查：该viewport对应的targetId是否已有缓存数据
      // 说明：
      //   - cachedStats 是一个以targetId为key的对象
      //   - CT视口的targetId类似 "volumeId:ctVolume"
      //   - PT视口的targetId类似 "volumeId:ptVolume"
      //   - 两者不同！所以CT有缓存不代表PT也有缓存
      const hasCachedStats = data.cachedStats && data.cachedStats[targetId];

      // 判断是否需要强制计算stats的条件：
      // 条件A: !hasCachedStats → 该viewport还没有自己的缓存数据（如PT首次渲染）
      // 条件B: savedInvalidated → 原始逻辑要求计算（正常刷新场景）
      // 满足任一条件就进入stats计算
      if (!hasCachedStats || savedInvalidated) {
        // [2026-04-29] 关键：临时将invalidated设为true，打开stats计算的"门"
        annotation.invalidated = true;
        try {
          // 调用原始的stats计算方法
          // 此方法内部会：
          //   1. 检查commonData（活动annotation拦截）→ 我们已绕过
          //   2. 调用_calculateCachedStats() → 实际计算面积、最大值等
          //   3. 将结果存入data.cachedStats[targetId]
          //   4. 设置annotation.invalidated = false（我们会在finally中恢复）
          this._calculateStatsIfActive(annotation, targetId, viewport, renderingEngine, enabledElement);
        } catch (e) {
          // [2026-04-29] 异常保护：忽略stats计算错误
          // 常见异常场景：
          //   - 切换布局时viewport的context pool还未初始化完成
          //   - Volume未加载完成时获取renderer失败
          // 处理策略：
          //   - 不抛出错误，避免影响轮廓线的正常渲染
          //   - 下次渲染时会重试（此时viewport应该已准备好）
        } finally {
          // [2026-04-29] 无论成功还是失败，都恢复原来的invalidated状态
          // 这很重要，因为后续可能有其他逻辑依赖这个标志位
          annotation.invalidated = savedInvalidated;
        }
      }

      // === 第五步：渲染统计信息文本框（标签） ===
      // [2026-04-29] 此时cachedStats[targetId]应该已经有数据了
      // _renderStats会从cachedStats中读取数据并生成文本标签：
      //   - Area: xxx mm²（面积）
      //   - Max: xxx SUVbw（最大值，PET图像）
      //   - Mean: xxx HU/SUVbw（平均值）
      //   - Min: xxx（最小值）
      //   - Std.Dev: xxx（标准差）
      this._renderStats(annotation, viewport, enabledElement, svgDrawingHelper);

      return renderStatus;
    };
  }

  // ====================================================================
  // Patch CrosshairsTool 实例的 mouseMoveCallback
  // 修改时间：2026-05-11
  //
  // 解决问题：在2x2布局（Axial/Sagittal/Coronal）中，每个toolGroup只有1个视口，
  //          CrosshairsTool的_computeToolCenter()因视口不足而提前返回，
  //          不初始化annotation数据，导致mouseMoveCallback收到undefined的
  //          filteredToolAnnotations参数，访问.length时报错：
  //          "Cannot read properties of undefined (reading 'length')"
  //
  // 关键发现：mouseMoveCallback 是在构造函数中定义的箭头函数实例属性：
  //     this.mouseMoveCallback = (evt, filteredToolAnnotations) => { ... }
  // 因此通过 CrosshairsTool.prototype 打补丁无效！
  // 必须在实例创建后，直接修改实例的 mouseMoveCallback 属性。
  //
  // 修复方案：通过 toolGroupService 获取所有工具组中的 CrosshairsTool 实例，
  //          直接在实例上包装 mouseMoveCallback，添加 undefined 检查。
  // ====================================================================
  try {
    const tgIds = toolGroupService.getToolGroupIds();
    if (tgIds && tgIds.length > 0) {
      tgIds.forEach(tgId => {
        try {
          const tg = toolGroupService.getToolGroup(tgId);
          if (!tg) return;

          // toolGroupService.getToolGroup 返回的是 OHIF 封装对象
          // 需要获取底层的 cornerstone ToolGroup 来访问工具实例
          const csToolGroup = tg._toolGroup || tg;

          // 尝试获取 Crosshairs 工具实例
          // 注意：不能使用 csToolGroup.getToolInstance('Crosshairs')，因为当工具
          // 未注册时它会 console.warn("'Crosshairs' is not registered...")，
          // 在遍历所有工具组(含volume3d)时会产生大量垃圾字符串对象。
          // 直接访问 _toolInstances 属性，未注册时返回 undefined，无副作用。
          const toolInstance = csToolGroup._toolInstances?.Crosshairs;

          if (toolInstance && typeof toolInstance.mouseMoveCallback === 'function') {
            const originalCallback = toolInstance.mouseMoveCallback.bind(toolInstance);
            toolInstance.mouseMoveCallback = function (evt, filteredToolAnnotations) {
              if (!filteredToolAnnotations) {
                return false;
              }
              return originalCallback(evt, filteredToolAnnotations);
            };
          }
        } catch (e) {
          // 单个工具组失败不影响其他
        }
      });
    }
  } catch (e) {
    // 补丁失败不影响主流程
  }

  // ====================================================================
  // [2026-05-11 新增] Patch CrosshairsTool._computeToolCenter - 消除视口不足警告
  // [2026-05-19 新增] 同时修补 SingleSliceLineTool 实例
  //
  // 问题：MIP toolGroup 只有1个视口(mipSAGITTAL)，
  //       CrosshairsTool._computeToolCenter() 检测到视口<2时打印警告：
  //       "For crosshairs to operate, at least two viewports must be given."
  //
  // 影响：控制台大量警告，干扰调试（功能本身不受影响）
  //
  // 修复：替换 _computeToolCenter，视口不足时静默返回
  // ====================================================================
  try {
    const tgIds = toolGroupService.getToolGroupIds();
    if (tgIds?.length > 0) {
      tgIds.forEach(tgId => {
        try {
          const tg = toolGroupService.getToolGroup(tgId);
          if (!tg) return;

          const csToolGroup = tg._toolGroup || tg;

          // 修补 Crosshairs 和 SingleSliceLine 两个工具
          // 注意：直接访问 _toolInstances，不调用 getToolInstance，
          // 否则未注册的工具(如volume3d中的Crosshairs)会触发console.warn，
          // 产生大量垃圾字符串对象。
          const toolNamesToPatch = ['Crosshairs', 'SingleSliceLine'];
          toolNamesToPatch.forEach(toolName => {
            const toolInstance = csToolGroup._toolInstances?.[toolName];

            if (toolInstance?._computeToolCenter) {
              const orig = toolInstance._computeToolCenter.bind(toolInstance);
              toolInstance._computeToolCenter = function(viewportsInfo) {
                if (!viewportsInfo?.length || viewportsInfo.length < 2) return;
                return orig(viewportsInfo);
              };
            }
          });
        } catch (_) {}
      });
    }
  } catch (_) {}

  // ====================================================================
  // [2026-05-20 新增] Patch CrosshairsTool/SingleSliceLineTool onSetToolActive
  // [2026-05-20 修改] 改用 setCameraNoEvent 精确重置旋转，避免位置偏移
  //
  // 解决两个问题：
  //
  // 问题1：十字线/单切线初始加载后，只有横截面(axial)显示正确的十字线，
  //        冠状位(coronal)和矢状位(sagittal)显示的不是十字线或位置不对
  //
  // 问题2：使用单切线旋转参考线后切换到十字线，十字线不正交
  //
  // 根因：CrosshairsTool 参考线方向 = cross(currentNormal, otherNormal)，
  //        如果 viewPlaneNormal 不是标准正交方向，参考线方向就会错误。
  //        SingleSliceLineTool 旋转只改变一个视口的相机，破坏正交关系。
  //
  // 修复方案：在 onSetToolActive 中，先重置所有视口相机的 viewPlaneNormal/viewUp
  //          到标准正交方向，同时保持 focalPoint 和观察距离不变，
  //          然后再重新计算十字线中心。
  //
  // 实现方式（精确重置，不使用 resetCamera）：
  //   1. 获取视口的标准方向向量（通过 _getOrientationVectors）
  //   2. 保持 focalPoint 不变（切片位置不变）
  //   3. 根据新法线重新计算 position（focalPoint + distance * newNormal）
  //   4. 使用 setCameraNoEvent 设置相机（不触发 CAMERA_MODIFIED 事件）
  //      避免同步组级联更新导致位置偏移
  //
  // 为什么不用 resetCamera：
  //   resetCamera 即使设置 resetPan:false/resetToCenter:false，
  //   仍会基于体积边界重新计算 position 的距离，导致相机距离变化，
  //   进而触发 CAMERA_MODIFIED 事件使同步组更新，造成图像位置偏移。
  // ====================================================================
  try {
    const tgIds = toolGroupService.getToolGroupIds();
    if (tgIds?.length > 0) {
      tgIds.forEach(tgId => {
        try {
          const tg = toolGroupService.getToolGroup(tgId);
          if (!tg) return;

          const csToolGroup = tg._toolGroup || tg;

          const toolNamesToPatch = ['Crosshairs', 'SingleSliceLine'];
          toolNamesToPatch.forEach(toolName => {
            // 直接访问 _toolInstances，不调用 getToolInstance，
            // 否则未注册的工具(如volume3d)会触发console.warn产生垃圾字符串。
            const toolInstance = csToolGroup._toolInstances?.[toolName];

            if (toolInstance && typeof toolInstance.onSetToolActive === 'function') {
              const originalOnSetToolActive = toolInstance.onSetToolActive.bind(toolInstance);

              toolInstance.onSetToolActive = function() {
                // 第一步：精确重置所有视口的相机旋转到标准正交方向
                // 仅改变 viewPlaneNormal/viewUp，保持 focalPoint 和观察距离不变
                try {
                  const viewportsInfo = toolInstance._getViewportsInfo
                    ? toolInstance._getViewportsInfo()
                    : [];

                  viewportsInfo.forEach(({ viewportId, renderingEngineId }) => {
                    try {
                      const renderingEngine = getRenderingEngine(renderingEngineId);
                      if (!renderingEngine) return;

                      const viewport = renderingEngine.getViewport(viewportId);
                      if (!viewport) return;

                      // 检查视口是否有 orientation 属性（VolumeViewport 才有）
                      const orientation = viewport.viewportProperties?.orientation;
                      if (!orientation) return;

                      // 检查是否有 _getOrientationVectors 方法
                      if (typeof viewport._getOrientationVectors !== 'function') return;

                      // 获取标准方向向量
                      const standardVectors = viewport._getOrientationVectors(orientation);
                      if (!standardVectors?.viewPlaneNormal || !standardVectors?.viewUp) return;

                      // 获取当前相机参数
                      const camera = viewport.getCamera();
                      const { focalPoint, position } = camera;

                      // 计算当前相机到焦点的距离
                      const dx = position[0] - focalPoint[0];
                      const dy = position[1] - focalPoint[1];
                      const dz = position[2] - focalPoint[2];
                      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

                      // 根据新法线方向重新计算 position
                      // 保持 focalPoint 不变，沿新法线方向偏移相同距离
                      const newViewPlaneNormal = standardVectors.viewPlaneNormal;
                      const newPosition = [
                        focalPoint[0] + distance * newViewPlaneNormal[0],
                        focalPoint[1] + distance * newViewPlaneNormal[1],
                        focalPoint[2] + distance * newViewPlaneNormal[2],
                      ];

                      // 使用 setCameraNoEvent 设置相机，不触发 CAMERA_MODIFIED 事件
                      // 这样同步组不会级联更新，避免位置偏移
                      if (typeof viewport.setCameraNoEvent === 'function') {
                        viewport.setCameraNoEvent({
                          viewPlaneNormal: newViewPlaneNormal,
                          viewUp: standardVectors.viewUp,
                          focalPoint: focalPoint,
                          position: newPosition,
                        });
                      }
                    } catch (_) {
                      // 单个视口重置失败不影响其他
                    }
                  });
                } catch (_) {
                  // 获取视口信息失败时仍继续初始化
                }

                // 第二步：调用原始的 onSetToolActive 重新初始化十字线
                // 此时所有视口相机已恢复到标准正交方向
                originalOnSetToolActive();
              };
            }
          });
        } catch (_) {}
      });
    }
  } catch (_) {}
}

function initToolGroups(toolNames, Enums, toolGroupService, commandsManager) {
  _initToolGroups(toolNames, Enums, toolGroupService, commandsManager);
}

export default initToolGroups;
