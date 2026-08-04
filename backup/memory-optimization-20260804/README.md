# 图像加载内存优化代码备份

**备份日期**: 2026-08-04
**备份原因**: 记录所有内存优化相关代码，防止被意外注释或覆盖

## 备份文件清单

### 一、核心清理逻辑（返回查询界面 / 模式退出）

#### 1. `extensions/default/src/ViewerLayout/ViewerHeader.tsx`
- **优化项**: `purgeCache()` 调用
- **作用**: 返回查询界面前同步清理 cornerstone cache，释放 volume/image 像素数据
- **关键**: 必须在 `navigate()` 之前执行，因为 bfcache 可能冻结页面导致 onModeExit 不执行
- **教训**: 2026-08-03 曾被注释掉，导致内存飙升

#### 2. `extensions/cornerstone/src/services/ViewportService/CornerstoneViewportService.ts`
- **优化项**: 5 个关键方法
  - `destroy()` (L187-L329): 完整的 viewport 清理流程
    - 释放 VTK ColorTransferFunction/PiecewiseFunction
    - 移除 VIEWPORT_NEW_IMAGE_SET handler
    - disableElement 每个 viewport
    - `_releaseWebGLContexts()` 释放 GPU 资源
    - `renderingEngine.destroy()` 
    - `_clearImageLoadPool()` 清理 pending 请求
    - `_purgeCacheRobust()` 清理 cache
  - `_releaseWebGLContexts()` (L506-L609): WebGL 上下文释放
    - **关键顺序**: releaseGraphicsResources() → loseContext()
    - glRenderWindow.delete() 强制 dereference
    - model.context = null, model.canvas = null
  - `_purgeCacheRobust()` (L442-L499): 健壮的 cache 清理
    - 每个 volume/image 条目单独 try/catch
  - `_clearImageLoadPool()` (L336-L352): 清理 pending 请求
  - `getMemoryStats()` (L380-L435): 内存诊断

#### 3. `extensions/cornerstone/src/index.tsx`
- **优化项**: onModeExit 中的 Web Worker 清理 (L420-L464)
  - `workerPoolManager.emptyRequestStack()` 清空请求队列
  - 遍历 `workerRegistry` 终止所有 worker
  - 清除 `idleCheckIntervalId`
  - 清空 `nativeWorkers` 数组
  - `cornerstoneTools.destroy()` 清理工具实例
  - `cornerstone.eventTarget.reset()` 清除匿名事件监听器

#### 4. `extensions/cornerstone/src/Viewport/OHIFCornerstoneViewport.tsx`
- **优化项**: useEffect cleanup 中的 VTK 对象清理 (L243-L343)
  - 释放 RGBTransferFunction / ScalarOpacity / GradientOpacity
  - `elementRef.current = null` 断开闭包引用
  - 在 disableElement() 之前执行（actor 仍可访问时）

#### 5. `modes/tmtv/src/index.ts`
- **优化项**: onModeExit 完整清理流程 (L273-L362)
  - 手动清理 toolGroup 的 _toolInstances
  - 断开 ResizeObserver
  - 销毁 VTK orientation widget 和 actor
  - 延迟 10 秒执行 DicomMetadataStore.clear()
  - imageRetrieveMetadataProvider.clear()
  - 清理模块级 Maps（interleaveCenterLoader、interleaveTopToBottom、nthLoader）
  - 清理 Web Worker
  - 清理 annotationRenderingEngine 和 segmentationRenderingEngine

#### 6. `platform/core/src/extensions/ExtensionManager.ts`
- **优化项**: onModeExit 中统一清理 service listeners (L182-L274)
  - 检测 `service?.listeners`
  - 对 PubSubService 实例调用 `PubSubService.prototype.reset.call(service)`
  - 对混合对象手动清理 listeners
  - 跳过已正确调用 super.reset() 的服务
  - 记录日志："Cleared N leaked listeners across M service instances"

### 二、GPU 显存优化

#### 7. `platform/app/public/config/default.js`
- **优化项**:
  - `webGlContextCount: 1` (L32) — 从 4 降到 1，所有 viewport 共享一个 WebGL 上下文
  - `maxCacheSize` 动态分配 (L36-L42) — ≤8GB→512MB, ≤16GB→1.5GB, >16GB→2.5GB
  - `maxNumRequests.prefetch: 6` (L52) — 从 25 降到 6，匹配 3 个 worker 解码能力
  - `maxNumRequests.thumbnail: 25` (L48) — 从 75 降到 25
  - `maxNumberOfWebWorkers: 3` (L21) — 保持 3 不变

#### 8. `node_modules/@cornerstonejs/core/.../vtkOffscreenMultiRenderWindow.js`
- **优化项**: destroy() 5 步清理
  1. `interactor.delete()` — 停止 RAF + 解绑 DOM 事件
  2. `releaseGraphicsResources()` — 释放 shader/texture/VBO
  3. 删除 renderers — VTK C++ 对象显式 delete
  4. `renderWindow.delete()` — 删除渲染窗口
  5. `model.openGLRenderWindow.model.canvas = null` — 打破 canvas→WebGLContext→GPU内存 引用链
- **持久化**: 通过 `patches/@cornerstonejs+core+4.21.2.patch` 持久化

#### 9. `patches/@cornerstonejs+core+4.21.2.patch`
- VTK 内存泄漏修复的 patch 文件
- `package.json` 中 `postinstall: patch-package` 自动应用

### 三、Bundle 体积优化（查询页面内存）

#### 10. `.webpack/webpack.base.js`
- **优化项**:
  - `splitChunks` 禁用 (L73-L75) — 让 webpack 通过动态 import() 自然拆分
  - `runtimeChunk` 禁用 (L76)
  - `sideEffects: false` (L78)
  - `usedExports: true` (L81) — dev 模式也支持 tree-shaking
  - `concatenateModules: true` (L82)

#### 11. `platform/i18n/src/index.js`
- **优化项**: 语言资源按需加载
  - 仅 en-US 静态导入
  - 其余 12 种语言通过动态 import() 按需加载
  - `SUPPORTED_LANGUAGES` 数组定义支持语言

#### 12. `platform/core/src/utils/dayjsConfig.ts`
- **优化项**: dayjs 替换 moment.js（7KB vs 300KB+）
  - 启用 customParseFormat、localizedFormat、advancedFormat、localeData 插件
  - 预加载 12 种 locale

#### 13. `platform/app/src/routes/buildModeRoutes.tsx`
- **优化项**: React.lazy + Suspense 懒加载 ModeRoute
  - 查询页面不加载查看器相关组件

#### 14. `platform/ui-next/package.json` / `platform/ui/package.json`
- **优化项**: sideEffects 声明
  - `"sideEffects": ["*.css", "*.module.css"]` — 让 webpack 对组件库 tree-shaking

#### 15. `platform/core/src/DicomMetadataStore.ts`
- **优化项**: dcmjs 延迟加载（1.8MB DICOM 字典）
  - 改为 `getDcmjs()` 动态 import
  - 仅处理本地文件加载时才加载 dcmjs

#### 16. `extensions/cornerstone/src/services/CornerstoneCacheService.ts`
- **优化项**: clear() 方法清理 stackImageIds 和 volumeImageIds Maps

## 恢复方法

```powershell
$src = "D:\OHIF\backup\memory-optimization-20260804"
$dst = "D:\OHIF"

Copy-Item "$src\platform\app\public\config\default.js" "$dst\platform\app\public\config\default.js" -Force
Copy-Item "$src\.webpack\webpack.base.js" "$dst\.webpack\webpack.base.js" -Force
Copy-Item "$src\extensions\cornerstone\src\services\ViewportService\CornerstoneViewportService.ts" "$dst\extensions\cornerstone\src\services\ViewportService\CornerstoneViewportService.ts" -Force
Copy-Item "$src\extensions\cornerstone\src\Viewport\OHIFCornerstoneViewport.tsx" "$dst\extensions\cornerstone\src\Viewport\OHIFCornerstoneViewport.tsx" -Force
Copy-Item "$src\extensions\cornerstone\src\index.tsx" "$dst\extensions\cornerstone\src\index.tsx" -Force
Copy-Item "$src\extensions\default\src\ViewerLayout\ViewerHeader.tsx" "$dst\extensions\default\src\ViewerLayout\ViewerHeader.tsx" -Force
Copy-Item "$src\platform\core\src\extensions\ExtensionManager.ts" "$dst\platform\core\src\extensions\ExtensionManager.ts" -Force
Copy-Item "$src\modes\tmtv\src\index.ts" "$dst\modes\tmtv\src\index.ts" -Force
Copy-Item "$src\patches\@cornerstonejs+core+4.21.2.patch" "$dst\patches\@cornerstonejs+core+4.21.2.patch" -Force
Copy-Item "$src\platform\i18n\src\index.js" "$dst\platform\i18n\src\index.js" -Force
Copy-Item "$src\platform\core\src\utils\dayjsConfig.ts" "$dst\platform\core\src\utils\dayjsConfig.ts" -Force
Copy-Item "$src\platform\app\src\routes\buildModeRoutes.tsx" "$dst\platform\app\src\routes\buildModeRoutes.tsx" -Force
Copy-Item "$src\platform\ui-next\package.json" "$dst\platform\ui-next\package.json" -Force
Copy-Item "$src\platform\ui\package.json" "$dst\platform\ui\package.json" -Force
```

## 优化效果

| 指标 | 优化前 | 优化后 | 改善 |
|------|--------|--------|------|
| GPU 显存 | ~8 GB | ~128 MB | -98% |
| GPU 进程 RSS | ~8.4 GB | ~600 MB | -93% |
| OHIF 标签页 JS Heap | ~400 MB | ~98 MB | -75% |
| 查询页面 JS Heap | ~800 MB | ~300 MB | -62% |
