# GPU占用优化：重新应用 CT/PT 差异化加载策略

## Context

用户已将之前排查 GPU 占用过高的所有诊断代码还原。当前 `_setVolumeViewport` 方法对 CT/PT volume 一视同仁地调用 `volume.load()`，导致两个 volume 同时加载、每加载 2% 帧各触发一次 `renderingEngine.renderViewports()`，总渲染回调约 100 次，与 XHR/Worker 消息竞争主线程，引发 GPU 上下文频繁切换和显存压力。

项目记忆中已验证的核心瓶颈分析：
- 真正瓶颈不是 GPU 渲染或解码，而是**主线程被碎片化回调淹没**（Animation frame 16.4%、XHR load 回调、Web Worker 消息）
- `autoLoad(volumeId)` 在每加载 2% 帧时触发 `renderingEngine.renderViewports()`，两个 volume 共约 100 次渲染回调
- `reRenderFraction` 绝对不能调高（4%/8% 会触发 `loseContext`，GPU 显存溢出），2% 是唯一验证过的安全值
- 必须在 `volume.load()` 之后设置 `reRenderFraction`，因为 `load()` 内部调用的 `_prefetchImageIds()` 会重置为 `totalNumFrames * 0.02`

## 优化策略

**核心思路：错峰加载 + 减少渲染回调**

1. **CT volume 立即加载 + 保留默认渐进式渲染（2%）**
   - CT 是主要观察对象，用户期望立即看到
   - 2% 是验证过的安全值，保留默认即可

2. **PT volume 延迟 1.5s 加载 + 禁用渐进式渲染**
   - 等 CT 开始下载/解码后再启动 PT，避免两个 volume 的渲染回调重叠
   - 设置 `reRenderFraction = totalNumFrames`，仅在全部加载完成时触发一次渲染
   - 渲染回调从 ~100 次降到 ~50 次（CT 一半 + PT 完成 1 次）

3. **保持其他配置不变**
   - `webGlContextCount: 4`（已优化，3D 旋转需要）
   - `maxNumRequests.prefetch: 6`（已匹配 3 worker 解码能力）
   - `maxCacheSize: 4GB`
   - 不动纹理过滤配置（LINEAR 已验证必需）

## 关键文件与修改点

### 修改文件：`extensions/cornerstone/src/services/ViewportService/CornerstoneViewportService.ts`

**修改位置**：`_setVolumeViewport` 方法（第 1287-1292 行）

当前代码：
```typescript
volumesNotLoaded.forEach(volume => {
  if (!volume.loadStatus?.loading && volume.load instanceof Function) {
    volume.load();
  }
});
```

修改为基于 modality 的差异化加载策略：
- 通过 `volumeInputArray.find(vi => vi.volumeId === volume.volumeId)` 查找 modality（**不能用 index**，因为 `volumesNotLoaded` 是过滤后的数组）
- CT（非 PT）volume：立即调用 `volume.load()`，保持默认 2% 渐进式渲染
- PT volume：`setTimeout(startLoad, 1500)` 延迟 1.5s 加载；在 `volume.load()` 之后设置 `volume.reRenderFraction = totalNumFrames` 和 `volume.reRenderTarget = totalNumFrames`，禁用渐进式渲染

`startLoad` 内部需做双重检查：`if (volume.loadStatus?.loading || volume.loadStatus?.loaded) return;` 防止 1.5s 内 viewport 已被销毁或 volume 已被其他流程加载导致重复触发。

参考实现：`backup_20260715/CornerstoneViewportService.ts:1228-1267`（之前已验证过的实现）。

### 不修改的文件

- `platform/app/public/config/default.js` — `webGlContextCount`、`maxNumRequests`、`maxCacheSize` 等已优化到位
- `extensions/cornerstone/src/init.tsx` — `imageLoadPoolManager.maxNumRequests` 已配置正确
- `node_modules/@cornerstonejs/core/*` — 不修改第三方库源码

## 关键约束（来自项目记忆）

- `reRenderFraction` 必须在 `volume.load()` **之后**设置，否则会被 `_prefetchImageIds()` 重置为 2%
- `reRenderFraction` 绝对不能调高（4%/8% 触发 `loseContext`）
- 通过 `volumeId` 查找 `volumeInputArray` 获取 modality，不能用 `volumesNotLoaded` 的 index
- 不在生产模式暴露 `window.xxx` 全局引用
- 不打印大型对象到 console

## 验证方法

1. **构建前清理缓存**（必需，开发/生产模式 webpack 缓存格式不兼容）：
   ```powershell
   Remove-Item -Recurse -Force D:\OHIF\node_modules\.cache
   Remove-Item -Recurse -Force D:\OHIF\platform\app\node_modules\.cache
   ```

2. **生产构建并部署**：
   ```powershell
   yarn build
   ```
   将 `platform/app/dist` 部署到 nginx

3. **功能验证**（打开 TMTV 模式，加载全身 PET/CT）：
   - CT 视口应立即开始渐进式显示（约 1-2s 内出现低分辨率图像）
   - PT/Fusion/MIP 视口在约 1.5s 后开始加载，加载完成时一次性显示
   - 加载过程中浏览器不卡死、不黑屏、不触发 `loseContext`

4. **性能验证**（Chrome DevTools Performance 面板）：
   - 录制从打开 study 到加载完成的全过程
   - 对比优化前后：
     - 主线程 Scripting 时间应下降（回调错峰）
     - `loseContext` 事件应不出现
     - GPU 内存峰值应下降（PT 不再渐进式上传纹理）
   - 加载总时长可能略增（PT 延迟 1.5s），但用户感知更平滑

5. **回归验证**：
   - 3X4 布局等其他模式加载正常
   - 切换序列、重置、十字线等功能不受影响（修改仅影响加载时序，不影响渲染逻辑）
