# 新增两个布局：CT+PT 横断面 & 纯 Fusion

## Context

用户需要新增两个布局用于诊断目的：
1. **CT+PT 横断面**：只显示 CT 轴位和 PT 轴位（1行2列）
2. **纯 Fusion**：只显示 CT+PT 融合后的图像（1行1列）

## 修改文件

### 1. `d:\OHIF\extensions\tmtv\src\utils\hpViewports.ts`
- 无需修改，已有的 `ctAXIAL`、`ptAXIAL`、`fusionAXIAL` 可直接复用

### 2. `d:\OHIF\extensions\tmtv\src\getHangingProtocolModule.ts`

新增两个 stage：

**stage9 - CT+PT 横断面 (1x2)**：
```
┌─────────────┬─────────────┐
│  CT 轴位    │  PET 轴位   │
─────────────┴─────────────┘
```
- id: `ct-pt-axial-layout`
- viewports: `[ctAXIAL, ptAXIAL]`
- 1 行 2 列

**stage10 - 纯 Fusion (1x1)**：
```
┌───────────────────────────┐
│      Fusion 轴位           │
└───────────────────────────┘
```
- id: `fusion-only-layout`
- viewports: `[fusionAXIAL]`
- 1 行 1 列

将两个新 stage 添加到 `stages` 数组末尾：
```ts
stages: [stage3, stage1, stage2, stage4, stage5, stage6, stage7, stage8, stage9, stage10],
```

### 3. `d:\OHIF\extensions\tmtv\src\Toolbar\TmtvLayoutSelector.tsx`

在 `tmtvPresets` 数组中添加两个新预设按钮：

**CT+PT 横断面**：
```tsx
{
  title: 'CT+PT',
  icon: 'layout-common-2x2',
  commandOptions: {
    protocolId: '@ohif/extension-tmtv.hangingProtocolModule.ptCT',
    stageId: 'ct-pt-axial-layout',
  },
  disabled: false,
  isPreset: true,
  isActive: activeProtocolId === '...' && activeStageId === 'ct-pt-axial-layout',
},
```

**纯 Fusion**：
```tsx
{
  title: 'Fusion',
  icon: 'layout-common-1x1',
  commandOptions: {
    protocolId: '@ohif/extension-tmtv.hangingProtocolModule.ptCT',
    stageId: 'fusion-only-layout',
  },
  disabled: false,
  isPreset: true,
  isActive: activeProtocolId === '...' && activeStageId === 'fusion-only-layout',
},
```

## 验证

1. 刷新页面加载病例
2. 点击工具栏"布局"按钮
3. 确认新增的 "CT+PT" 和 "Fusion" 按钮出现在列表中
4. 点击 "CT+PT"：应显示 1x2 布局，左侧 CT 轴位，右侧 PET 轴位
5. 点击 "Fusion"：应显示 1x1 布局，全屏显示 Fusion 融合图像
6. 切换回其他布局（如 Axial）确认正常
