# 十字线相关代码备份

**备份日期**: 2026-08-04
**备份原因**: 记录这几天新增/修改的 TMTV 十字线功能代码，避免后续修改时丢失

## 备份文件清单

### 一、新增文件（完全新建）

#### 1. `extensions/tmtv/src/services/TMTVCrosshairService.ts`
- **标记**: [2026-07-30 新增]
- **功能**: TMTV 十字线服务，独立于 Cornerstone CrosshairsTool，使用 SVG overlay 绘制十字线
- **架构**: 不依赖任何 ToolGroup，直接管理 viewport 上的 SVG 层
- **支持布局**: AXIAL (2x3-layout)、Sagittal (2x4-layout)、Coronal (coronal-mip-layout)
- **核心方法**:
  - `addViewport(viewportId, viewport)` — 注册 viewport，创建 SVG overlay
  - `removeViewport(viewportId)` — 移除 viewport，清理 SVG 层和事件监听
  - `clear()` — 移除所有 viewport，清理所有资源
  - `setVisible(value)` — 设置十字线可见性
  - `setPosition(worldPoint)` — 设置十字线世界坐标位置
  - `render()` — 渲染十字线到所有注册的 viewport
- **事件监听**: ResizeObserver（尺寸变化重绘）、CAMERA_MODIFIED（相机变化重绘）
- **清理**: 所有 Map 在 clear() 中被清空，防止残留引用导致内存泄漏

#### 2. `extensions/tmtv/src/Toolbar/OverlayMenu.tsx`
- **标记**: [2026-07-01 新增] / [2026-07-30 修改]
- **功能**: TMTV 覆盖层菜单组件，通过下拉菜单控制十字线和患者信息的显示/隐藏
- **UI**: 使用 Popover 容器，包含"十字线"和"患者信息"两个选项，使用"眼睛"图标
- **十字线切换逻辑**:
  - TMTV 布局（AXIAL/Sagittal/Coronal）使用 TMTVCrosshairService（SVG overlay）
  - 其他布局使用原始逻辑（Cornerstone CrosshairsTool，fusion + mip toolGroup）
- **患者信息切换**: 通过 customizationService 控制 viewportOverlay.hideAll 标志
- **布局监听**: 监听 LAYOUT_CHANGED 和 VIEWPORTS_READY 事件，自动注册/清理 viewport
- **清理**: 组件卸载时清理 TMTVCrosshairService、清除 pending setTimeout、取消订阅

### 二、修改的已有文件（包含十字线相关新增/修改代码）

#### 3. `modes/tmtv/src/initToolGroups.js`
- **十字线相关修改**:
  - **工具组定义**: fusionToolGroup 和 mipToolGroup 中注册 Crosshairs 工具（disabled 状态）
  - **[2026-05-11] Patch mouseMoveCallback**: 修复 2x2 布局中 filteredToolAnnotations 为 undefined 的崩溃
  - **[2026-05-11] Patch _computeToolCenter**: 消除视口不足时的警告日志
  - **[2026-05-20] Patch onSetToolActive**: 十字线激活时重置所有视口相机到标准正交方向
    - 使用 setCameraNoEvent 避免同步组级联更新导致位置偏移
    - 保持 focalPoint 不变，仅改变 viewPlaneNormal/viewUp
  - **SingleSliceLine 工具**: 与 Crosshairs 相同的补丁逻辑

#### 4. `modes/tmtv/src/utils/setCrosshairsConfiguration.js`
- **功能**: 配置 Crosshairs 工具的 filterActorUIDsToSetSlabThickness
- **目的**: 在 Fusion 视口中修改 slab 厚度时，仅影响 CT 体积，不影响 PT 体积
- **[2026-05-19 新增]**: SingleSliceLine 工具也需要相同的配置

#### 5. `modes/tmtv/src/index.ts`
- **十字线相关代码**:
  - 初始化时调用 setCrosshairsConfiguration
  - onModeExit 中清理工具实例和服务

#### 6. `modes/tmtv/src/toolbarButtons.ts`
- **十字线相关代码**:
  - Crosshairs 按钮（ID: "Crosshairs"，命令: toggleTMTVCrosshairs）
  - Overlay 按钮（ID: "Overlay"，组件: ohif.overlayMenu）

#### 7. `extensions/tmtv/src/getToolbarModule.tsx`
- **十字线相关代码**:
  - 注册 ohif.overlayMenu 工具栏组件，映射到 OverlayMenu 组件

#### 8. `extensions/tmtv/src/commandsModule.ts`
- **十字线相关代码**:
  - `toggleTMTVCrosshairs` 命令（约 L700-L749）
  - TMTV 布局使用 TMTVCrosshairService
  - 其他布局回退到标准 CrosshairsTool
  - 导入 tmtvCrosshairService

#### 9. `extensions/tmtv/src/index.tsx`
- **十字线相关代码**:
  - 导出 getToolbarModule（包含 OverlayMenu 注册）

#### 10. `node_modules/@cornerstonejs/tools/dist/esm/tools/CrosshairsTool.js`
- **修改内容**:
  - `renderAnnotation`: 优先使用 `_getAnnotations`（同 toolGroup），不足时回退到跨 toolGroup `getAnnotations`
  - `MAX_REFERENCE_LINES`: 同方向视口时条件限制为 2
  - `viewUp fallback`: 当 cross product 为零时使用 camera.viewUp 作为回退方向
  - `canvasToWorld([width/2, height/2])`: 十字线交点居中在视口中心
- **注意**: 此文件在 node_modules 中，如需持久化请创建 patch 文件

## 恢复方法

如需恢复备份，将备份目录中的文件复制回原位置即可：

```powershell
# 恢复新增文件
Copy-Item "D:\OHIF\backup\crosshairs-20260804\extensions\tmtv\src\services\TMTVCrosshairService.ts" "D:\OHIF\extensions\tmtv\src\services\TMTVCrosshairService.ts" -Force
Copy-Item "D:\OHIF\backup\crosshairs-20260804\extensions\tmtv\src\Toolbar\OverlayMenu.tsx" "D:\OHIF\extensions\tmtv\src\Toolbar\OverlayMenu.tsx" -Force

# 恢复修改的已有文件
Copy-Item "D:\OHIF\backup\crosshairs-20260804\modes\tmtv\src\initToolGroups.js" "D:\OHIF\modes\tmtv\src\initToolGroups.js" -Force
Copy-Item "D:\OHIF\backup\crosshairs-20260804\modes\tmtv\src\utils\setCrosshairsConfiguration.js" "D:\OHIF\modes\tmtv\src\utils\setCrosshairsConfiguration.js" -Force
Copy-Item "D:\OHIF\backup\crosshairs-20260804\modes\tmtv\src\index.ts" "D:\OHIF\modes\tmtv\src\index.ts" -Force
Copy-Item "D:\OHIF\backup\crosshairs-20260804\modes\tmtv\src\toolbarButtons.ts" "D:\OHIF\modes\tmtv\src\toolbarButtons.ts" -Force
Copy-Item "D:\OHIF\backup\crosshairs-20260804\extensions\tmtv\src\getToolbarModule.tsx" "D:\OHIF\extensions\tmtv\src\getToolbarModule.tsx" -Force
Copy-Item "D:\OHIF\backup\crosshairs-20260804\extensions\tmtv\src\commandsModule.ts" "D:\OHIF\extensions\tmtv\src\commandsModule.ts" -Force
Copy-Item "D:\OHIF\backup\crosshairs-20260804\extensions\tmtv\src\index.tsx" "D:\OHIF\extensions\tmtv\src\index.tsx" -Force

# 恢复 node_modules 中的 CrosshairsTool.js
Copy-Item "D:\OHIF\backup\crosshairs-20260804\node_modules\@cornerstonejs\tools\dist\esm\tools\CrosshairsTool.js" "D:\OHIF\node_modules\@cornerstonejs\tools\dist\esm\tools\CrosshairsTool.js" -Force
```

## 注意事项

1. **node_modules 文件**: `CrosshairsTool.js` 位于 node_modules 中，执行 `yarn install` 后会被覆盖。
   建议创建 patch 文件持久化：`npx patch-package @cornerstonejs/tools`
2. **以前的十字线功能**: 本备份只包含这几天新增/修改的代码，不影响以前的十字线功能
3. **TMTVCrosshairService 与 CrosshairsTool 的关系**:
   - TMTV 布局（AXIAL/Sagittal/Coronal）使用 TMTVCrosshairService（SVG overlay）
   - 其他布局（如 3X4）使用原始 Cornerstone CrosshairsTool
   - 两者互不影响
