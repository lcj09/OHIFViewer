# TMTV 模式功能架构、图像加载与 SUV 计算说明

> 文档日期：2026-08-26  
> 适用范围：本仓库 OHIF TMTV 二次开发模式  
> 主要代码范围：`modes/tmtv/src`、`extensions/tmtv/src`

## 1. 文档定位

本文整理本项目当前 TMTV 模式的三条主线：

- TMTV 模式的功能架构：Mode、Extension、工具组、挂片协议、面板、命令和服务之间如何协作。
- 图像加载过程：用户进入 TMTV 模式后，PT、CT、Fusion、MIP 视口如何由挂片协议匹配和加载。
- SUV 值计算过程：DICOM PET 数据如何在 Cornerstone/OHIF 链路中变成 SUV 数据，以及本项目 TMTV/TLG 统计如何使用这些 SUV 值。

如果本文与源码行为不一致，以当前源码为准，并同步更新本文。

## 2. TMTV 模式整体架构

TMTV 模式由两层组成：

- `modes/tmtv/src`：负责模式生命周期、路由、布局模板、工具栏注册、工具组初始化、模式退出清理。
- `extensions/tmtv/src`：负责 TMTV 专用业务功能，包括挂片协议、视口定义、命令、面板、病灶服务、统计服务、报告导出和工具栏扩展。

核心入口如下：

| 模块 | 文件 | 作用 |
| --- | --- | --- |
| Mode 入口 | `modes/tmtv/src/index.ts` | 定义 `tmtv` 路由、进入/退出生命周期、右侧面板、工具栏、定制项和挂片协议 |
| 工具组初始化 | `modes/tmtv/src/initToolGroups.js` | 创建 CT、PT、Fusion、MIP、volume3d 工具组并注册测量、分割、十字线、融合微调工具 |
| 工具栏配置 | `modes/tmtv/src/toolbarButtons.ts` | 定义 TMTV 顶部工具栏和按钮状态 |
| 挂片协议 | `extensions/tmtv/src/getHangingProtocolModule.ts` | 匹配 PT/CT DisplaySet，并定义多种 TMTV 布局 stage |
| 视口定义 | `extensions/tmtv/src/utils/hpViewports.ts` | 定义 CT、PT、Fusion、MIP 视口的 displaySets、同步组、初始 VOI 和 MIP 属性 |
| 命令中心 | `extensions/tmtv/src/commandsModule.ts` | 编排分割、统计、病灶操作、CSV/RT 导出、重置、十字线和融合微调 |
| TMTV 面板 | `extensions/tmtv/src/Panels/PanelTMTV.tsx` | 包装 OHIF 分割面板，并挂载 TMTV 阈值/病灶/导出 UI |
| 阈值与病灶面板 | `extensions/tmtv/src/Panels/PanelROIThresholdSegmentation/PanelROIThresholdExport.tsx` | 刷新 TMTV/TLG、提取 lesion、确认/拒绝/删除/合并 lesion、导出 CSV |
| 病灶服务 | `extensions/tmtv/src/services/TMTVLesionService.ts` | 从 labelmap 提取连通域，维护 lesion 状态、稳定 ID、撤销/重做、合并和患者级 totals |
| 统计服务 | `extensions/tmtv/src/services/TMTVStatisticsService.ts` | 计算 lesion 级 volume、SUVmin、SUVmax、SUVmean、TLG、质心和 IJK 包围盒 |

### 2.1 模式进入流程

用户进入 TMTV 模式时，`modes/tmtv/src/index.ts` 的 `onModeEnter` 执行初始化：

1. 取消上一次延迟清理 metadata 的 timer，避免快速重新进入时把新 study 的 metadata 清掉。
2. 取消可能残留的 viewport resize timer。
3. 获取 OHIF services：`toolbarService`、`toolGroupService`、`customizationService`、`hangingProtocolService`、`displaySetService`、`viewportGridService`、`cornerstoneViewportService`。
4. 调用 `initToolGroups` 创建 TMTV 所需工具组。
5. 订阅 `VIEWPORT_ADDED`，在视口加入工具组后设置十字线配置和 Fusion active volume。
6. 订阅 `PROTOCOL_CHANGED`，布局切换后延迟调用 `cornerstoneViewportService.resize()`，避免视口尺寸不正确导致图像变形。
7. 注册并更新顶部工具栏、视口菜单和分割工具栏。
8. 设置 TMTV 模式级 customizations，例如右侧分割面板行为、上传地址、覆盖层字号、患者信息叠加。
9. 注册 `getPTVOIRange` 自定义属性，用于 PT/PET 视口根据 SUV 缩放能力设置初始窗宽窗位。

### 2.2 模式退出流程

`onModeExit` 的重点是释放资源，避免反复进入/退出 TMTV 模式后残留对象：

1. 取消所有 service 订阅。
2. 关闭 dialog 和 modal。
3. 在 `toolGroupService.destroy()` 前主动清理 OrientationMarkerTool 等工具实例中的 ResizeObserver、VTK actor/widget 和 `_toolInstances` 引用。
4. 销毁 toolGroup、syncGroup、segmentation、cornerstoneViewport service。
5. 清除 pending 的 resize timer。
6. 延迟 10 秒清理 `DicomMetadataStore` 和数据源的 study metadata Promise cache，避免无法取消的图像加载请求在回调中读取不到 metadata。

这个退出流程对 TMTV 很关键，因为 TMTV 会创建多个 volume viewport、融合 actor、MIP、分割 labelmap、订阅和异步统计任务，内存残留风险高于普通单视口查看。

## 3. TMTV 主要功能分层

### 3.1 布局与视口

TMTV 使用 `@ohif/extension-tmtv.hangingProtocolModule.ptCT` 挂片协议。当前协议要求 study 中包含 CT 和 PT，并优先匹配可重建的 CT、可重建且非 Uncorrected 的 PT。

当前主要布局 stage 包括：

| Stage ID | 说明 | 视口组成 |
| --- | --- | --- |
| `2x3-layout` | 默认 Axial 2x2 | CT axial、PT axial、Fusion axial、MIP sagittal |
| `default` | 3x4 全布局 | CT 三视图、PT 三视图、Fusion 三视图、MIP sagittal |
| `Fusion-2x2` | Fusion 2x2 | CT axial、Fusion axial、PT axial、MIP sagittal |
| `2x4-layout` | Sagittal 2x2 | CT sagittal、PT sagittal、Fusion sagittal、MIP sagittal |
| `coronal-mip-layout` | Coronal 2x2 | CT coronal、PT coronal、Fusion coronal、MIP coronal |
| `2x3-original-layout` | 原始 CT/PT 三视图 | CT 三视图、PT 三视图 |
| `2x4-original-layout` | PT/Fusion/MIP 布局 | PT 三视图、Fusion 三视图、MIP |
| `tmtv-mpr-layout` | TMTV Fusion MPR | Fusion axial、Fusion sagittal、Fusion coronal |

视口定义位于 `extensions/tmtv/src/utils/hpViewports.ts`：

- CT 视口只加载 `ctDisplaySet`，使用 `ctToolGroup`。
- PT 视口只加载 `ptDisplaySet`，使用 `ptToolGroup`，背景为白色，初始 VOI 通过 `getPTVOIRange` 获取，并设置 `voiInverted: true`。
- Fusion 视口同时加载 `ctDisplaySet` 和 `ptDisplaySet`，使用 `fusionToolGroup`。CT 是底层，PT 是上层，并给 PT 设置 `hsv` colormap 与透明度曲线。
- MIP 视口加载 `ptDisplaySet`，设置 `blendMode: 'MIP'` 和 `slabThickness: 500`，用于整体代谢分布查看。

### 3.2 工具组

`modes/tmtv/src/initToolGroups.js` 创建的工具组包括：

| 工具组 | 用途 |
| --- | --- |
| `ctToolGroup` | CT 视口的窗宽窗位、测量、平移、缩放、十字线等 |
| `ptToolGroup` | PT 视口的测量、SUV 显示、ROI 阈值分割入口 |
| `fusionToolGroup` | Fusion 视口的测量、ROI 阈值分割、融合微调 |
| `mipToolGroup` | MIP 视口的 MIP jump、旋转、缩放、平移 |
| `volume3d` | 三维布局工具组，支持 3D trackball rotate |

TMTV 对部分工具做了项目级兼容处理，例如：

- Fusion 测量工具通过 `wrapGetTextLinesWithSUV` 补充 SUV 值显示。
- PlanarFreehandROI 的统计缓存按 viewport targetId 补算，避免 CT 算完后 PT 因 `invalidated=false` 不显示统计文本。
- Crosshairs/SingleSliceLine 对单视口布局做空值和视口数量保护，避免工具内部崩溃或产生大量警告。

### 3.3 分割、病灶和统计

TMTV 分割和统计链路分为两层：

- Cornerstone segmentation：底层真实 labelmap，当前核心 segment 是 `Segment 1`。
- TMTV lesion state：业务层病灶列表，由 Segment 1 中的 3D 连通域提取得到，维护 candidate、confirmed、rejected 状态。

关键流程：

1. 用户创建或选择 TMTV labelmap。
2. 用户用 ROI 阈值工具、打点分割或 Brush/Eraser 修改 Segment 1。
3. `SEGMENTATION_DATA_MODIFIED` 事件触发右侧面板刷新。
4. `handleROIThresholding` 调用 `calculateTMTV` 命令，先计算 segmentation group stats。
5. `TMTVLesionService.extractLesionsForSegmentations` 从 Segment 1 提取 3D connected components。
6. 每个 connected component 调用 `TMTVStatisticsService.computeLesionStatisticsForComponent` 计算 volume、SUVmin、SUVmax、SUVmean、TLG、质心和包围盒。
7. 患者级 TMTV/TLG 只汇总 `confirmed` lesions。
8. UI 显示 lesion 列表、TMTV、TLG，并支持确认、拒绝、恢复、删除、合并和 CSV 导出。

## 4. 图像加载过程

### 4.1 从 Study 到 DisplaySet

TMTV 模式的有效性判断位于 `modes/tmtv/src/index.ts`：

- study modalities 必须包含 `CT` 和 `PT`。
- 排除 `SM`。
- 排除项目中指定的 4D study UID。

进入模式后，OHIF 先根据数据源和 SOP Class Handler 生成 displaySets。TMTV 使用默认 stack SOP Class Handler，但通过挂片协议要求 displaySet 可重建为 volume。

挂片协议 `extensions/tmtv/src/getHangingProtocolModule.ts` 的 displaySet selector：

- `ctDisplaySet`：`Modality = CT` 且 `isReconstructable = true`，可按 SeriesDescription 加权匹配 CT/CT WB。
- `ptDisplaySet`：`Modality = PT` 且 `isReconstructable = true`，优先匹配 Corrected，并对不包含 Uncorrected 的序列加权。

### 4.2 挂片协议生成视口

匹配到 CT/PT displaySet 后，hanging protocol 当前 stage 决定 viewport grid 和每个 viewport 加载哪些 displaySet。

加载关系可以概括为：

```text
Study
  └─ DisplaySetService
      ├─ ctDisplaySet  -> CT Volume
      └─ ptDisplaySet  -> PT Volume
          └─ scalingModule.suvbw 决定 PT 是否可按 SUV 显示

HangingProtocol ptCT
  ├─ CT viewport     -> ctDisplaySet
  ├─ PT viewport     -> ptDisplaySet
  ├─ Fusion viewport -> ctDisplaySet + ptDisplaySet
  └─ MIP viewport    -> ptDisplaySet + MIP blendMode
```

### 4.3 Volume 创建与缓存

本项目直接调用或间接依赖 Cornerstone/OHIF 的 volume 加载能力：

- CT/PT displaySet 在 volume viewport 中加载为 Cornerstone volume。
- Fusion 视口同时持有 CT 和 PT 两个 volume actor。
- MIP 视口使用 PT volume，并通过 `blendMode: 'MIP'`、`slabThickness: 500` 做最大密度投影。
- 新建 TMTV 分割时，`commandsModule.ts` 的 `createNewLabelmapFromPT` 使用 `segmentationService.createLabelmapForDisplaySet(displaySet, ...)`，创建与 PT displaySet 同空间分辨率的 labelmap。
- `segmentationService.addSegmentationRepresentation(withPTViewportId, { segmentationId })` 将 labelmap representation 加入对应视口。

注意：分割 labelmap 以 PT 为参考创建，因此后续 TMTV/SUV 统计默认按 PT volume 的空间和 scalarData 对齐。

### 4.4 PT 初始 SUV 窗宽窗位

TMTV 注册了 `getPTVOIRange` 自定义属性。逻辑如下：

1. 找到 PT displaySet。
2. 读取第一张 PT imageId 的 `scalingModule`。
3. 如果存在 `suvbw`，说明该 PET 数据可按 SUVbw 缩放显示。
4. 返回 `windowWidth: 5`、`windowCenter: 2.5`，即显示范围约为 SUV 0 到 5。
5. 如果没有 SUV 缩放信息，则不返回自定义 VOI，交给默认策略处理。

同样逻辑也在 `commandsModule.ts` 的 `_getPTVOIRange` 中用于 TMTV 视口重置。Fusion 视口重置时要通过 PT volumeId 单独恢复 PT 的 VOI 和 colormap，避免影响 CT volume。

### 4.5 图像加载策略

挂片协议设置了：

```ts
imageLoadStrategy: 'interleaveTopToBottom'
```

这表示图像加载会按视口从上到下交错推进，让多视口布局尽快都有可见图像，而不是把一个 viewport 全部加载完再加载下一个。源码注释中也提醒过 `nth` 策略可能导致布局切换时 VOI 同步异常。

## 5. SUV 值计算过程

### 5.1 SUV 的临床公式

SUVbw 的基础定义是：

```text
SUVbw = 组织放射性浓度 / (注射活度 / 患者体重)
```

常见元数据来源：

| 数据 | DICOM 来源 |
| --- | --- |
| 患者体重 | `PatientWeight` |
| 注射活度 | `RadiopharmaceuticalInformationSequence.RadionuclideTotalDose` |
| 半衰期 | `RadiopharmaceuticalInformationSequence.RadionuclideHalfLife` |
| 注射时间 | `RadiopharmaceuticalInformationSequence.RadiopharmaceuticalStartTime` 或 `RadiopharmaceuticalStartDateTime` |
| 采集/序列时间 | `SeriesTime` 等时间字段 |
| 像素物理缩放 | `RescaleSlope`、`RescaleIntercept` |

完整 PET SUV 计算通常包括 raw pixel rescale、衰变校正、剂量/体重归一化等步骤。这个过程主要由 Cornerstone/OHIF 的 PET metadata 和 scaling 体系处理。

### 5.2 本项目如何判断 PT 是否已有 SUV 缩放

项目中用于显示和重置的判断点是：

```ts
const imageIdScalingFactor = MetadataProvider.get('scalingModule', imageId);
const isSUVAvailable = imageIdScalingFactor && imageIdScalingFactor.suvbw;
```

也就是说，TMTV 自身不是在 `commandsModule.ts` 或 `TMTVStatisticsService.ts` 中手动从 DICOM 标签重新计算 suvbw，而是依赖上游 image loader / metadata provider 解析出的 `scalingModule.suvbw`。

### 5.3 SUV scalarData 的来源

当前 lesion 级统计在 `extensions/tmtv/src/services/TMTVStatisticsService.ts` 中完成：

1. 根据 `segmentationVolumeId` 调用 `csTools.utilities.segmentation.getReferenceVolumeForSegmentationVolume(segmentationVolumeId)`。
2. 取 reference volume 的 scalarData：

```ts
volume?.voxelManager?.getCompleteScalarDataArray?.()
  ?? volume?.voxelManager?.getScalarData?.()
  ?? volume?.scalarData
```

3. 对病灶 voxelIndices 中的每个 voxelIndex 读取 `suvScalarData[voxelIndex]`。
4. 跳过非 number 或 `NaN`。
5. 计算 `suvMin`、`suvMax`、`suvMean`。

因此，TMTV 统计里使用的 SUV 值，是 PT reference volume 中已经可读取的 scalarData 值。若上游 volume 已经完成 SUV 缩放，这里的值就是 SUV；若上游缺少 SUV 缩放，则统计结果也不会自动补算 SUV。

### 5.4 TMTV 和 TLG 计算

每个 lesion 的体积计算：

```text
voxelVolumeML = abs(spacingX * spacingY * spacingZ) / 1000
lesionVolumeML = voxelCount * voxelVolumeML
```

其中 spacing 优先取 reference PT volume，取不到时回退到 segmentation volume。

每个 lesion 的 SUV 与 TLG：

```text
SUVmin  = min(lesion voxels SUV)
SUVmax  = max(lesion voxels SUV)
SUVmean = sum(lesion voxels SUV) / validSUVVoxelCount
TLG     = SUVmean * lesionVolumeML
```

如果 reference scalarData 不存在，或 lesion 内没有有效 SUV 数值：

- `suvMin = null`
- `suvMax = null`
- `suvMean = null`
- `tlg = null`

患者级汇总由 `computePatientTotals` 完成：

```text
includedLesions = lesions.filter(status === 'confirmed')
patientTMTV = sum(includedLesions.volume)
patientTLG  = sum(includedLesions.tlg)
```

当前规则是只汇总 `confirmed` lesions。`candidate` 和 `rejected` 不进入患者级 TMTV/TLG。

### 5.5 连通域与 lesion 的关系

`extensions/tmtv/src/utils/extractConnectedComponents.ts` 使用 26 邻域在 3D labelmap 中提取 connected components：

- 遍历整个 labelmap。
- 只处理值等于 `segmentIndex` 的体素，当前 TMTV 默认为 `segmentIndex = 1`。
- 每遇到一个未访问的前景体素，就用队列扩展 26 邻域。
- 输出每个 component 的 `voxelIndices`。

`TMTVLesionService` 将每个 connected component 转成一个业务 lesion，并为它附加：

- 稳定 lesion id。
- UI 显示编号。
- voxel 数量和 IJK 包围盒。
- volume、SUVmin、SUVmax、SUVmean、TLG。
- world centroid 和 IJK centroid。
- 状态：`candidate`、`confirmed`、`rejected`。
- 来源：`threshold`、`brush`、`manual`。

### 5.6 分割修改后的重新计算

右侧面板订阅 `segmentationService.EVENTS.SEGMENTATION_DATA_MODIFIED`。当真实 TMTV Segment 1 变化时：

1. 忽略 lesion 高亮层的 segmentationId，避免高亮 mask 混入 TMTV/TLG。
2. 如果事件 segmentationId 不属于当前 TMTV segmentation group，则忽略。
3. 对事件做 100ms debounce，减少 Brush/Eraser 连续修改时的重复计算。
4. 调用 `refreshTMTVAndLesions`。
5. 先通过 `handleROIThresholding` / `calculateTMTV` 更新 segmentation group stats。
6. 再通过 `TMTVLesionService.extractLesionsForSegmentations` 重建 lesion state。
7. 将 confirmed totals 写回 `segmentationService.setSegmentationGroupStats`。
8. 如果有选中 lesion，刷新独立高亮层。

删除 rejected lesion 时，`TMTVLesionService.deleteLesion` 会真实把该 lesion 的 Segment 1 voxel 写回 0，并记录 labelmap diff 用于撤销/重做。删除后会消费一次 `skipNextFullRefresh`，避免刚刚做过的增量更新又立刻触发全量扫描。

## 6. 开发注意事项

### 6.1 不要混淆三类 SUV 相关逻辑

| 类型 | 位置 | 作用 |
| --- | --- | --- |
| SUV 缩放 | Cornerstone/OHIF image loader 与 metadata provider | 把 PET 原始数据按 `suvbw` 缩放为可用 SUV 值 |
| SUV 显示窗宽窗位 | `getPTVOIRange`、`SuvThresholdMenu`、`resetTMTVViewport` | 控制 PET/Fusion/MIP 的显示范围，例如 SUV 0 到 5 |
| SUV 统计 | `TMTVStatisticsService.ts` | 从 reference volume scalarData 读取 lesion 内 SUV 值，计算 min/max/mean/TLG |

显示窗宽窗位不会改变真实 scalarData；它只影响渲染显示。TMTV/TLG 定量要看 reference volume 的 scalarData 和 spacing。

### 6.2 二开公式时优先检查的文件

- `extensions/tmtv/src/services/TMTVStatisticsService.ts`
- `extensions/tmtv/src/services/TMTVLesionService.ts`
- `extensions/tmtv/src/utils/extractConnectedComponents.ts`
- `extensions/tmtv/src/utils/handleROIThresholding.ts`
- `extensions/tmtv/src/commandsModule.ts`
- `extensions/tmtv/src/Panels/PanelROIThresholdSegmentation/PanelROIThresholdExport.tsx`
- `SUV-TMTV-TLG-Calculation.md`

### 6.3 必须自检的边界条件

- PT/CT displaySet 缺失。
- `scalingModule.suvbw` 缺失。
- reference volume 取不到。
- scalarData 为空或长度不足。
- spacing 缺失、为 0 或方向为负。
- 空分割、零体素 connected component。
- voxelIndex 越界。
- SUV 值为 `NaN`、`Infinity` 或非 number。
- candidate/rejected lesion 是否被误计入患者级 totals。
- Brush/Eraser 连续修改时旧异步计算是否覆盖新结果。
- 模式退出后 debounce、timer、订阅、highlight segmentation、volume 引用是否释放。

## 7. 一句话总结

本项目 TMTV 的主链路是：进入 TMTV Mode 后由挂片协议匹配 PT/CT DisplaySet，加载 CT、PT、Fusion、MIP volume viewport；分割基于 PT 创建 labelmap 并在 Segment 1 标记病灶；右侧面板监听分割变化，把 Segment 1 拆成 3D 连通病灶；统计服务从 PT reference volume 的 scalarData 读取 SUV 值，并按 voxel spacing 计算 lesion volume、SUVmean、TMTV 和 TLG；最终患者级 TMTV/TLG 只汇总 confirmed lesions。
