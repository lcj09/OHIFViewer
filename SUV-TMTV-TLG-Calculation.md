# SUV / TMTV / TLG 计算逻辑详解

> 文档版本：2026-06-08
> 适用系统：OHIF TMTV 模式（基于 cornerstone3D）

---

## 一、SUV（Standardized Uptake Value）标准化摄取值

### 1.1 定义

SUV 是 PET 图像中**组织对显像剂（FDG）摄取程度的标准化指标**，消除了注射剂量和患者体型差异的影响，使不同患者/不同时间点的扫描结果具有可比性。

### 1.2 核心公式

```
                    组织放射性浓度 (μCi/mL)
SUVbw = ─────────────────────────────────────
          注射放射性剂量 (mCi) / 患者体重 (kg)
```

| 符号 | 含义 | 单位 | 来源 |
|------|------|------|------|
| 组织浓度 | 单位体积内的 FDG 摄取量 | μCi/mL | 由像素值 × RescaleSlope + RescaleIntercept 转换 |
| 注射剂量 | 注射入体内的 FDG 总活度 | mCi | DICOM `(0018,1074)` Radiopharmaceutical Information Sequence → RadionuclideTotalDose |
| 患者体重 | 患者体重 | kg | DICOM `(0010,1030)` PatientWeight |

### 1.3 完整计算链路

```
┌─────────────────────────────────────────────────────────────────┐
│                     第 1 步：原始数据采集                          │
│                                                                 │
│   PET 扫描仪探测 γ 光子 → 重建算法处理 → DICOM Pixel Data        │
│   （存储的是"计数值" counts，不是物理量）                         │
│                                                                 │
│   例：某个像素原始值 = 24690                                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   第 2 步：Rescale 转换                            │
│                                                                 │
│   物理浓度 = RawPixel × RescaleSlope + RescaleIntercept           │
│                                                                 │
│   DICOM 标签：                                                   │
│     (0028,1053) Rescale Slope    例: 0.0005                      │
│     (0028,1052) Rescale Intercept 例: 0                          │
│                                                                 │
│   计算：24690 × 0.0005 + 0 = 12.345 μCi/mL                       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                  第 3 步：半衰期校正                               │
│                                                                 │
│   FDG 半衰期 = 109.8 分钟（约 6588 秒）                           │
│                                                                 │
│   校正后浓度 = 物理浓度 × exp(ln(2) × 经过时间 / 半衰期)          │
│                                                                 │
│   例：注射后 60 分钟扫描                                          │
│       12.345 × exp(0.693 × 60 / 109.8) = 12.345 × 1.407         │
│       = 17.37 μCi/mL                                             │
│                                                                 │
│   DICOM 标签：(0018,1075) RadionuclideHalfLife                    │
│              (0018,1073) RadiopharmaceuticalStartTime             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    第 4 步：除以本底                                │
│                                                                 │
│   本底浓度 = 注射剂量 / 患者体重                                   │
│                                                                 │
│   例：注射 10 mCi，体重 70 kg                                     │
│       本底 = 10 / 70 = 0.1429 μCi/mL                             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    第 5 步：得到 SUV                                │
│                                                                 │
│   SUVbw = 校正后浓度 / 本底                                       │
│        = 17.37 / 0.1429                                         │
│        = **121.6** ← 这就是该像素的 SUV 值                       │
│                                                                 │
│   ★ 注意：实际临床中 SUV 通常在 0~30 范围                        │
│     上例数字偏大仅为演示计算过程                                    │
└─────────────────────────────────────────────────────────────────┘
```

### 1.4 在 OHIF/cornerstone3D 中的实现

**关键设计：预转换（Pre-scaling），图像加载时一次性完成。**

#### 缩放因子计算位置

cornerstone3D 在 Volume 加载时从 DICOM 元数据解析并计算 `scaling.PT`：

```javascript
// cornerstone3D 内部逻辑（简化）
const suvbwFactor = (rescaleSlope * decayCorrection)
                 / (radionuclideTotalDose / patientWeight);

volume.scaling = {
  PT: suvbwFactor    // 一个浮点数，例: 0.00493
};
```

之后每个像素值的读取自动乘以这个因子：
```javascript
// 读取像素时（内部自动执行）
suvValue = rawPixelValue * volume.scaling.PT;
// 例: 24690 * 0.00493 = 121.7 ≈ 121.6（与手算一致）
```

#### 判断是否为 SUV 数据

源码 [AnnotationTool.js 第165-173行](node_modules/@cornerstonejs/tools/dist/esm/tools/base/AnnotationTool.js#L165)：

```javascript
static isSuvScaled(viewport, targetId, imageId) {
  if (viewport instanceof BaseVolumeViewport) {
    const volume = cache.getVolume(volumeId);
    return volume?.scaling?.PT !== undefined;  // 有 PT 缩放因子 → 已是 SUV
  }
  // Stack 视口
  const scalingModule = metaData.get('scalingModule', imageId);
  return typeof scalingModule?.suvbw === 'number';
}
```

#### 单位确定

源码 [getPixelValueUnits.js](node_modules/@cornerstonejs/tools/dist/esm/utilities/getPixelValueUnits.js)：

| 条件 | 返回单位 | 说明 |
|------|---------|------|
| Modality = `CT` | `HU` | Hounsfield Units |
| Modality = `PT` + isSuvScaled=true | `SUV`（显示为 g/ml） | 已转换为 SUVbw |
| Modality = `PT` + 未缩放 | `raw` | 原始计数值 |

### 1.5 不同类型的 SUV

| 类型 | 公式 | 适用场景 |
|------|------|---------|
| **SUVbw**（最常用） | 浓度 ÷ (剂量/**体重**) | 临床默认标准，OHIF TMTV 使用此类型 |
| **SUVlbm** | 浓度 ÷ (剂量/**瘦体重**) | 肥胖患者更准确（James 公式或 Hume 公式计算瘦体重） |
| **SUVbsa** | 浓度 ÷ (剂量/**体表面积**) | 儿科常用（Du Bois 公式计算体表面积） |
| **SUVmax** | ROI 内**最大** SUV 像素值 | 反映恶性程度高峰 |
| **SUVmean** | ROI 内所有体素 SUV **平均值** | 反映整体代谢水平 |
| **SUVpeak** | 以 SUVmax 为中心 1cm³ 球内的均值 | 比 SUVmax 更稳定，受噪声影响小 |

### 1.6 SUV 的临床意义参考值

| SUV 范围 | 可能含义 | 注意事项 |
|---------|---------|---------|
| 0 ~ 1.0 | 正常组织/背景 | 脑、膀胱、心脏可更高（正常生理性摄取） |
| 1.0 ~ 2.5 | 低代谢区域 | 可能是良性病变或低恶性肿瘤 |
| **> 2.5** | 高度可疑恶性 | 经验阈值，非绝对标准（见下方说明） |
| > 10 | 明显高代谢 | 大概率恶性（但炎症也可能很高） |

> **重要提示**：SUV > 2.5 是经验法则，不是判决书。
> - 假阳性：炎症、感染、术后改变 SUV 可 > 10
> - 假阴性：类癌、黏液腺癌、支气管肺泡癌 SUV 可 < 2.5
> - 器官差异：肝脏正常 SUV 2~3，脑皮质 SUV 4~8，均为正常

---

## 二、TMTV（Total Metabolic Tumor Volume）肿瘤代谢总体积

### 2.1 定义

TMTV 是指全身或特定区域内**所有 FDG 高摄取病灶的总体积**，单位为 mL（毫升）。它是淋巴瘤分期、疗效评估和预后判断的重要定量指标。

### 2.2 核心计算公式

源码 [computeWorker.js 第141行](node_modules/@cornerstonejs/tools/dist/esm/workers/computeWorker.js#L141)：

```
TMTV = 1e-3 × numVoxels × spacing[X] × spacing[Y] × spacing[Z]
```

| 符号 | 含义 | 单位 | 来源 |
|------|------|------|------|
| **numVoxels** | 分割区域内被标记为病灶的体素总数 | 个（无量纲） | Labelmap 中 label ≠ 0 的体素计数 |
| **spacing[0]** | 体素在 X 方向的物理尺寸 | mm | DICOM `(0028,0030)` PixelSpacing 第一值 |
| **spacing[1]** | 体素在 Y 方向的物理尺寸 | mm | DICOM `(0028,0030)` PixelSpacing 第二值 |
| **spacing[2]** | 体素在 Z 方向的物理尺寸（层厚） | mm | DICOM `(0018,0050)` SliceThickness |
| **1e-3** | 单位转换系数 | mm³ → mL | 1 mm³ = 0.001 mL |

**最终单位：mL（毫升）**

### 2.3 计算示例

假设一个淋巴结病灶分割结果：

| 参数 | 值 |
|------|-----|
| 分割区域内体素数 (numVoxels) | 5,200 个 |
| X 方向间距 (spacing[0]) | 4.0 mm |
| Y 方向间距 (spacing[1]) | 4.0 mm |
| Z 方向间距 (spacing[2]) | 3.0 mm |

```
TMTV = 0.001 × 5200 × 4.0 × 4.0 × 3.0
     = 0.001 × 249,600 mm³
     = **249.600 mL**
```

UI 显示格式（[PanelROIThresholdExport.tsx 第77行](extensions/tmtv/src/Panels/PanelROIThresholdSegmentation/PanelROIThresholdExport.tsx#L77)）：
```
"TMTV：249.600 mL"
```

### 2.4 完整计算流程

```
┌──────────────────────────────────────────────────────────────┐
│  阶段 A：分割（标记哪些体素属于病灶）                          │
│                                                              │
│  用户操作：画矩形 ROI → 设起止切片 → 设 CT/PT 阈值            │
│                                                              │
│  算法执行：rectangleROIThresholdVolumeByRange()               │
│    │                                                          │
│    ├─ 获取 ROI 边界框 (boundsIJK)                             │
│    ├─ 遍历 ROI 范围内每个体素                                 │
│    ├─ 判断 PT 值是否在 [lower, upper] 阈值范围内                │
│    ├─ 判断 CT 值是否在 [CT_lower, CT_upper] 范围内（可选过滤）   │
│    └─ 满足条件 → 标记为 segmentIndex=1（前景/病灶）            │
│       不满足 → 保持为 0（背景）                               │
│                                                              │
│  结果：Labelmap Volume（一个 3D 数组，0=背景，1=病灶）          │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  阶段 B：统计（遍历体素计算 TMTV 和 TLG）                      │
│                                                              │
│  触发：handleROIThresholding() → calculateTMTV 命令           │
│        ↓                                                     │
│  computeMetabolicStats() → Web Worker 异步执行                 │
│        ↓                                                     │
│  computeWorker.computeMetabolicStats():                       │
│    │                                                          │
│    │  for each voxel in entire volume:                        │
│    │    if label ≠ 0:          ← 属于分割区域                  │
│    │      numVoxels++         ← 体素计数 +1                   │
│    │      suv += pixelValue   ← 累加 SUV 值                  │
│    │                                                          │
│    ├─ TMTV = 1e-3 × numVoxels × spacing[X] × spacing[Y]      │
│    │       × spacing[Z]                                      │
│    │                                                          │
│    ├─ SUVmean = Σsuv / numVoxels                             │
│    │                                                          │
│    └─ TLG = SUVmean × TMTV                                   │
│                                                              │
│  结果：{ tmtv: 249.6, tlg: 1234.5 }                          │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  阶段 C：存储与显示                                            │
│                                                              │
│  segmentationService.setSegmentationGroupStats(segmentationIds, stats) │
│        ↓                                                     │
│  PanelROIThresholdExport.tsx                                  │
│    → getSegmentationGroupStats() 读取 stats.tmtv              │
│    → UI 显示："TMTV：249.600 mL"                              │
└──────────────────────────────────────────────────────────────┘
```

### 2.5 Web Worker 中的核心代码

源码 [computeWorker.js 第127-153行](node_modules/@cornerstonejs/tools/dist/esm/workers/computeWorker.js#L127)：

```javascript
computeMetabolicStats({ segmentationInfo, imageInfo }) {
  // 创建体素管理器
  const segVoxelManager = createVoxelManager(segmentationInfo.dimensions,
                                             segmentationInfo.scalarData);
  const refVoxelManager = createVoxelManager(imageDimensions, imageScalarData);

  let suv = 0;           // SUV 累加和
  let numVoxels = 0;     // 体素计数
  const scalarDataLength = segVoxelManager.getScalarDataLength();

  // 遍历所有体素
  for (let i = 0; i < scalarDataLength; i++) {
    if (segVoxelManager.getAtIndex(i) !== 0) {  // 属于分割区域
      suv += refVoxelManager.getAtIndex(i);     // 累加 SUV 值
      numVoxels++;                               // 计数
    }
  }

  // ★ TMTV 计算 ★
  const tmtv = 1e-3 * numVoxels * spacing[0] * spacing[1] * spacing[2];

  // 平均 SUV
  const averageSuv = numVoxels > 0 ? suv / numVoxels : 0;

  // TLG 计算
  const tlg = averageSuv * numVoxels
                    * imageSpacing[0] * imageSpacing[1] * imageSpacing[2]
                    * 1e-3;

  return { tmtv, tlg };
}
```

### 2.6 TMTV 的临床意义

| 应用场景 | 说明 |
|---------|------|
| **淋巴瘤分期** | TMTV > 292 mL 或 > 550 mL（不同标准）提示晚期，预后较差 |
| **疗效评估** | 治疗前后 TMTV 变化率是比 RECIST 更敏感的指标 |
| **预后预测** | 治疗前高 TMTV 与无进展生存期(PFS)、总生存期(OS)缩短相关 |
| **治疗监测** | 新辅助化疗后 TMTV 下降 > 66% 提示病理完全缓解 |

---

## 三、TLG（Total Lesion Glycolysis）总病灶糖酵解量

### 3.1 定义

TLG 综合了**病灶体积**和**代谢强度**两个维度，反映整个病灶的总代谢活动量。它是目前被认为预后价值最高的 PET 定量指标之一。

### 3.2 核心公式

```
TLG = SUVmean × TMTV肿瘤代谢总体积
```

等价展开形式（源码中实际使用的计算方式）：

```
TLG = (ΣSUV / numVoxels) × numVoxels × voxelVolume × 1e-3
    = ΣSUV × voxelVolume × 1e-3
```

| 符号 | 含义 | 单位 |
|------|------|------|
| **ΣSUV** | 分割区域内所有体素 SUV 值之和 | SUV（无量纲） |
| **numVoxels** | 分割区域内体素总数 | 个 |
| **voxelVolume** | 单个体素体积 = spacing[X]×spacing[Y]×spacing[Z] | mm³ |
| **1e-3** | mm³ → mL 转换系数 | - |
| **SUVmean** | ΣSUV / numVoxels | SUV |

**最终单位：SUV·mL（或写作 g，因 SUV 本身是无量纲比值）**

### 3.3 计算示例

使用与 TMTV 相同的数据：

| 参数 | 值 |
|------|-----|
| 所有体素 SUV 之和 (ΣSUV) | 18,720 |
| 体素数 (numVoxels) | 5,200 |
| 单个体素体积 | 4×4×3 = 48 mm³ |

```
SUVmean = 18720 / 5200 = 3.60 SUV

TLG = 3.60 × 249.6 mL
    = **898.6 SUV·mL**
```

### 3.4 TLG 为什么比单独用 TMTV 或 SUVmax 更好？

```
场景对比：

  患者 A：大而暗的肿瘤          患者 B：小而亮的肿瘤
  ┌─────────┐                   ┌───┐
  │  ████   │  TMTV=300 mL      │████│  TMTV=50 mL
  │ ██████  │  SUVmean=2.0      │████│  SUVmean=12.0
  │  ████   │  TLG=600          │████│  TLG=600
  └─────────┘                   └───┘

  如果只看 TMTV：A(300) >> B(50) → A 更严重？
  如果只看 SUVmax：A(~4) << B(~15) → B 更严重？
  
  但 TLG 相同(600) → 两者的总代谢负担其实一样！
  
  → TLG 能区分"大而淡" vs "小而浓"这两种不同生物学行为
```

### 3.5 TLG 的临床意义

| 对比维度 | TMTV | SUVmax | TLG |
|---------|------|--------|-----|
| 反映什么 | 肿瘤**大小/范围** | 肿瘤**最活跃点** | **整体代谢负荷** |
| 局限性 | 忽略了代谢强度差异 | 只看一个点，忽略体积 | **综合两者** |
| 预后价值 | 中等 | 中等 | **最高** |
| 受噪声影响 | 小 | **大**（单个极端值） | 小（平均值平滑） |
| 临床推荐 | ✅ 推荐常规使用 | ⚠️ 仅作参考 | ✅ 强烈推荐 |

---

## 四、三者关系总结

### 4.1 依赖关系图

```
DICOM 原始数据（counts）
        │
        ├──→ SUV 转换（图像加载时，一次性的）
        │      │
        │      └──→ 每个像素值变为 SUVbw
        │
        ├──→ 测量工具（椭圆/圆）
        │      │
        │      └──→ SUVmax, SUVmean, SUVmin, SUVstd, Area
        │
        └──→ 分割工具（ROI 阈值 / 打点 / 画笔）
               │
               ├──→ TMTV = 体素数 × 体素体积 (mL)
               │
               ├──→ SUVmean = ΣSUV / 体素数
               │
               └──→ TLG = SUVmean × TMTV (SUV·mL)
```

### 4.2 对比速查表

| 指标 | 全称 | 公式 | 单位 | 计算时机 | 用途 |
|------|------|------|------|---------|------|
| **SUV** | Standardized Uptake Value | 浓度÷(剂量/体重) | 无量纲（显示为 SUV/g·ml⁻¹） | 图像加载时（预转换） | 基础度量，所有计算的输入 |
| **SUVmax** | Maximum SUV | max(ROI内所有像素) | SUV | 测量时 | 反映恶性程度峰值 |
| **SUVmean** | Mean SUV | ΣSUV / N | SUV | 测量/分割时 | 反映整体代谢水平 |
| **TMTV** | Total Metabolic Tumor Volume | N × VoxelVol × 10⁻³ | **mL** | 分割后 | 反映肿瘤负荷范围 |
| **TLG** | Total Lesion Glycolysis | SUVmean × TMTV | SUV·mL | 分割后 | **最佳预后指标** |

### 4.3 代码文件索引

| 文件 | 功能 |
|------|------|
| [computeWorker.js](node_modules/@cornerstonejs/tools/dist/esm/workers/computeWorker.js#L127-L153) | **TMTV/TLG 核心计算**（Web Worker 异步执行） |
| [computeMetabolicStats.js](node_modules/@cornerstonejs/tools/dist/esm/utilities/segmentation/computeMetabolicStats.js) | computeMetabolicStats 主函数入口 |
| [BasicStatsCalculator.js](node_modules/@cornerstonejs/tools/dist/esm/utilities/math/basic/BasicStatsCalculator.js) | 测量工具的 SUV 统计（Welford 在线算法） |
| [AnnotationTool.js](node_modules/@cornerstonejs/tools/dist/esm/tools/base/AnnotationTool.js#L165) | isSuvScaled() — 判断是否为 SUV 数据 |
| [getPixelValueUnits.js](node_modules/@cornerstonejs/tools/dist/esm/utilities/getPixelValueUnits.js) | 根据模态和缩放状态确定单位 |
| [rectangleROIThresholdVolumeByRange.js](node_modules/@cornerstonejs/tools/dist/esm/utilities/segmentation/rectangleROIThresholdVolumeByRange.js) | ROI 阈值分割入口 |
| [thresholdVolumeByRange.js](node_modules/@cornerstonejs/tools/dist/esm/utilities/segmentation/thresholdVolumeByRange.js) | 阈值分割核心逻辑 |
| [PanelROIThresholdExport.tsx](extensions/tmtv/src/Panels/PanelROIThresholdSegmentation/PanelROIThresholdExport.tsx#L77) | TMTV UI 显示（mL 单位） |
| [commandsModule.ts](extensions/tmtv/src/commandsModule.ts#L306-L316) | calculateTMTV 命令定义 |
