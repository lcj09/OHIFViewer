# TMTV 十字线功能修复计划

## 摘要

用户提出 5 个问题，经调查确认 3 个为代码 bug（需修改 2 个文件），1 个为 UI 样式改进（需修改 1 个文件），1 个为内存排查（结论：十字线服务无泄漏，内存飙升来自图像加载本身）。

## 问题分析

### 问题 1：只修改了一个文件吗？

**回答**：上一轮只修改了 `TMTVCrosshairService.ts`（应用 3 个 Lessons Learned 修复）。本轮需要修改 **2 个文件**：

- `extensions/TMTV/src/services/TMTVCrosshairService.ts` — 修复 viewport ID 大小写不匹配
- `extensions/TMTV/src/Toolbar/OverlayMenu.tsx` — 修复按钮激活态蓝色显示

### 问题 2 & 3：矢状位/冠状位 MIP 和冠状位 Fusion 不显示十字线

**根因**：`TMTVCrosshairService.ts` 中硬编码的 viewport ID 与 `hpViewports.ts` 中实际的 `viewportId` 字符串大小写不匹配。

对比表（`hpViewports.ts` 实际值 vs `TMTVCrosshairService.ts` 期望值）：

| 布局 | viewport | hpViewports.ts 实际值 | TMTVCrosshairService 期望值 | 匹配？ |
|------|----------|----------------------|---------------------------|--------|
| AXIAL | mipSAGITTAL | `'mipSagittal'` (L433) | `'mipSagittal'` | ✅ |
| Sagittal | mipSAGITTAL | `'mipSagittal'` (L433) | `'mipSAGITTAL'` | ❌ |
| Coronal | mipCORONAL | `'mipCoronal'` (L559) | `'mipCORONAL'` | ❌ |
| Coronal | fusionCORONAL | `'fusionCoronal'` (L370) | `'fusionCORONAL'` | ❌ |

由于 `cornerstoneViewportService.getCornerstoneViewport(vpId)` 按精确字符串匹配，大小写不一致时返回 `null`，导致该 viewport 未注册到十字线服务，SVG 层未创建，十字线不显示。

### 问题 4：十字线按钮激活没有蓝色显示

**现状**：
- OverlayMenu 的菜单触发按钮（EyeVisible 图标）无任何激活态样式（`OverlayMenu.tsx:284-291`）
- 下拉菜单内的「十字线」菜单项激活时用 `text-common-bright`（白色），非蓝色（`OverlayMenu.tsx:312-324`）
- 标准 OHIF 工具按钮用 `data-active` 属性 + CSS 实现蓝色高亮（`ToolButtonListWrapper.tsx:45,66`）

**修复**：将激活态文字颜色改为 `text-highlight`（OHIF 蓝色强调色），菜单触发按钮图标在十字线激活时也变蓝。

### 问题 5：内存飙升 — 对象未释放？

**结论**：十字线服务**无内存泄漏**（上一轮已修复 3 个泄漏点）。

已验证的清理路径：
- ResizeObserver：`_removeSvgLayer` 中 `disconnect()` + `delete` ✅
- CAMERA_MODIFIED 监听器：用 `elements` Map 存储的原始 element 引用移除 ✅
- SVG 元素：`parentNode.removeChild()` ✅
- 所有 Map（viewports/svgLayers/elements/hLines/vLines/resizeObservers/cameraModifiedHandlers）：`clear()` 中全部清空 ✅
- 订阅（viewportGridService.subscribe）：`useEffect` cleanup 中 `unsubscribe()` ✅
- setTimeout（pendingTimeoutRef）：cleanup 中 `clearTimeout()` ✅
- 退出 TMTV 布局时：`handleLayoutChanged` else 分支调用 `tmtvCrosshairService.clear()` ✅
- 组件卸载时：`useEffect` cleanup 调用 `tmtvCrosshairService.clear()` ✅
- 布局切换时：`registerTmtvViewports` 开头调用 `tmtvCrosshairService.clear()` ✅

**内存飙升的真正来源**：图像加载本身（volume 像素数据加载到内存、GPU 纹理分配、prefetch 预取），与十字线服务无关。`ViewerHeader.tsx` 的 `purgeCache()` 在返回查询界面时清理 cache。

## 修改方案

### 文件 1：`extensions/TMTV/src/services/TMTVCrosshairService.ts`

**修改点**：`TMTV_VIEWPORT_IDS_BY_STAGE` 常量（约 L46-L50），修正 3 个大小写不匹配的 viewport ID：

```typescript
// 修改前
const TMTV_VIEWPORT_IDS_BY_STAGE: Record<string, string[]> = {
  '2x3-layout': ['ctAXIAL', 'ptAXIAL', 'fusionAXIAL', 'mipSagittal'],
  '2x4-layout': ['ctSAGITTAL', 'ptSAGITTAL', 'fusionSAGITTAL', 'mipSAGITTAL'],       // ← mipSAGITTAL 错误
  'coronal-mip-layout': ['ctCORONAL', 'ptCORONAL', 'fusionCORONAL', 'mipCORONAL'],   // ← fusionCORONAL, mipCORONAL 错误
};

// 修改后（与 hpViewports.ts 中实际 viewportId 字符串一致）
const TMTV_VIEWPORT_IDS_BY_STAGE: Record<string, string[]> = {
  '2x3-layout': ['ctAXIAL', 'ptAXIAL', 'fusionAXIAL', 'mipSagittal'],
  '2x4-layout': ['ctSAGITTAL', 'ptSAGITTAL', 'fusionSAGITTAL', 'mipSagittal'],        // ← mipSagittal
  'coronal-mip-layout': ['ctCORONAL', 'ptCORONAL', 'fusionCoronal', 'mipCoronal'],    // ← fusionCoronal, mipCoronal
};
```

修正的 3 个 ID：
1. `'mipSAGITTAL'` → `'mipSagittal'`（Sagittal 布局的 MIP）
2. `'mipCORONAL'` → `'mipCoronal'`（Coronal 布局的 MIP）
3. `'fusionCORONAL'` → `'fusionCoronal'`（Coronal 布局的 Fusion）

### 文件 2：`extensions/TMTV/src/Toolbar/OverlayMenu.tsx`

**修改点 A**：菜单触发按钮（约 L284-291）— 十字线激活时图标变蓝

```tsx
// 修改前
<Button
  variant="ghost"
  size="icon"
  className={`inline-flex h-10 w-10 items-center justify-center rounded-lg text-foreground/80 hover:bg-background hover:text-highlight`}
  aria-label="覆盖层"
>

// 修改后 — 十字线激活时 text-highlight（蓝色），否则 text-foreground/80
<Button
  variant="ghost"
  size="icon"
  className={`inline-flex h-10 w-10 items-center justify-center rounded-lg hover:bg-background hover:text-highlight ${
    showCrosshairs ? 'text-highlight' : 'text-foreground/80'
  }`}
  aria-label="覆盖层"
>
```

**修改点 B**：十字线菜单项（约 L312-324）— 激活时蓝色文字

```tsx
// 修改前 — 激活时 text-common-bright（白色）
className={`flex h-8 w-full items-center justify-start px-2 py-1 text-sm hover:bg-primary-dark ${
  showCrosshairs ? 'text-common-bright' : 'text-gray-400'
}`}

// 修改后 — 激活时 text-highlight（蓝色）
className={`flex h-8 w-full items-center justify-start px-2 py-1 text-sm hover:bg-primary-dark ${
  showCrosshairs ? 'text-highlight' : 'text-gray-400'
}`}
```

**修改点 C**：患者信息菜单项（约 L327-333）— 同样改为蓝色以保持一致

```tsx
// 修改前
className={`flex h-8 w-full items-center justify-start px-2 py-1 text-sm hover:bg-primary-dark ${
  showPatientInfo ? 'text-common-bright' : 'text-gray-400'
}`}

// 修改后
className={`flex h-8 w-full items-center justify-start px-2 py-1 text-sm hover:bg-primary-dark ${
  showPatientInfo ? 'text-highlight' : 'text-gray-400'
}`}
```

## 不修改的部分

- **hpViewports.ts**：不修改实际 viewportId 字符串（这些是已有定义，其他代码依赖它们）
- **getHangingProtocolModule.ts**：不修改（使用常量导入，无问题）
- **initToolGroups.js**：不修改（ToolGroup 架构保持独立）
- **ViewerHeader.tsx**：不修改（purgeCache 已正确调用）

## 假设与决策

1. **viewport ID 修正方向**：修改 `TMTVCrosshairService.ts` 中的硬编码字符串以匹配 `hpViewports.ts` 中的实际值，而非反过来。原因：`hpViewports.ts` 是源定义，被 hanging protocol 和其他模块引用，改动风险大。
2. **蓝色样式**：使用 `text-highlight` 类（OHIF 设计系统的蓝色强调色），与工具栏其他按钮的 hover 色一致。
3. **内存问题**：不额外修改代码。十字线服务已无泄漏，内存飙升来自图像加载（正常行为）。

## 验证步骤

1. 构建：`yarn build`（开发模式 `yarn dev:dev`）
2. 进入 TMTV 模式，切换到 **AXIAL 布局**：4 个视口（ctAXIAL/ptAXIAL/fusionAXIAL/mipSagittal）都应显示绿色十字线
3. 切换到 **Sagittal 布局**：4 个视口（ctSAGITTAL/ptSAGITTAL/fusionSAGITTAL/mipSagittal）都应显示十字线 — 验证 MIP 修复
4. 切换到 **Coronal 布局**：4 个视口（ctCORONAL/ptCORONAL/fusionCoronal/mipCoronal）都应显示十字线 — 验证 MIP + Fusion 修复
5. 点击工具栏「覆盖层」按钮：下拉菜单中「十字线」激活时文字应为蓝色，菜单触发按钮图标也应变蓝
6. 切换布局时观察内存：不应因十字线服务导致持续增长（GC 后应回落）
