import { vec3 } from 'gl-matrix';
import { PubSubService } from '@ohif/core';
import { Types as OhifTypes } from '@ohif/core';
import {
  RenderingEngine,
  StackViewport,
  Types,
  getRenderingEngine,
  utilities as csUtils,
  VolumeViewport,
  VolumeViewport3D,
  ECGViewport,
  cache,
  Enums as csEnums,
  eventTarget,
  BaseVolumeViewport,
  imageLoadPoolManager,
  getWebWorkerManager,
} from '@cornerstonejs/core';

import { utilities as csToolsUtils, Enums as csToolsEnums } from '@cornerstonejs/tools';
import { IViewportService } from './IViewportService';
import { RENDERING_ENGINE_ID } from './constants';
import ViewportInfo, {
  DisplaySetOptions,
  PublicViewportOptions,
  ViewportOptions,
} from './Viewport';
import { StackViewportData, VolumeViewportData } from '../../types/CornerstoneCacheService';
import {
  LutPresentation,
  PositionPresentation,
  Presentations,
  SegmentationPresentation,
  SegmentationPresentationItem,
} from '../../types/Presentation';

import JumpPresets from '../../utils/JumpPresets';
import { ViewportProperties } from '@cornerstonejs/core/types';
import { useLutPresentationStore } from '../../stores/useLutPresentationStore';
import { usePositionPresentationStore } from '../../stores/usePositionPresentationStore';
import { useSynchronizersStore } from '../../stores/useSynchronizersStore';
import { useSegmentationPresentationStore } from '../../stores/useSegmentationPresentationStore';
import getClosestOrientationFromIOP from '../../utils/isReferenceViewable';
import { BlendModes } from '@cornerstonejs/core/enums';
import { reset as resetEnabledElementsState } from '../../state';

const EVENTS = {
  VIEWPORT_DATA_CHANGED: 'event::cornerstoneViewportService:viewportDataChanged',
  VIEWPORT_VOLUMES_CHANGED: 'event::cornerstoneViewportService:viewportVolumesChanged',
};

const MIN_STACK_VIEWPORTS_TO_ENQUEUE_RESIZE = 12;
const MIN_VOLUME_VIEWPORTS_TO_ENQUEUE_RESIZE = 6;

export const WITH_NAVIGATION = { withNavigation: true, withOrientation: false };
export const WITH_ORIENTATION = { withNavigation: true, withOrientation: true };

/**
 * Handles cornerstone viewport logic including enabling, disabling, and
 * updating the viewport.
 */
class CornerstoneViewportService extends PubSubService implements IViewportService {
  static REGISTRATION = {
    name: 'cornerstoneViewportService',
    altName: 'CornerstoneViewportService',
    create: ({
      servicesManager,
    }: OhifTypes.Extensions.ExtensionParams): CornerstoneViewportService => {
      return new CornerstoneViewportService(servicesManager);
    },
  };

  renderingEngine: Types.IRenderingEngine | null;
  viewportsById: Map<string, ViewportInfo> = new Map();
  viewportGridResizeObserver: ResizeObserver | null;
  viewportsDisplaySets: Map<string, string[]> = new Map();
  beforeResizePositionPresentations: Map<string, PositionPresentation> = new Map();

  // Some configs
  servicesManager: AppTypes.ServicesManager = null;

  resizeQueue = [];
  viewportResizeTimer = null;
  gridResizeDelay = 50;
  gridResizeTimeOut = null;

  constructor(servicesManager: AppTypes.ServicesManager) {
    super(EVENTS);
    this.renderingEngine = null;
    this.viewportGridResizeObserver = null;
    this.servicesManager = servicesManager;
  }
  hangingProtocolService: unknown;
  viewportsInfo: unknown;
  sceneVolumeInputs: unknown;
  viewportDivElements: unknown;
  ViewportPropertiesMap: unknown;
  volumeUIDs: unknown;
  displaySetsNeedRerendering: unknown;
  viewportDisplaySets: unknown;

  /**
   * Adds the HTML element to the viewportService
   * @param {*} viewportId
   * @param {*} elementRef
   */
  public enableViewport(viewportId: string, elementRef: HTMLDivElement): void {
    const viewportInfo = new ViewportInfo(viewportId);
    viewportInfo.setElement(elementRef);
    this.viewportsById.set(viewportId, viewportInfo);
  }

  public getViewportIds(): string[] {
    return Array.from(this.viewportsById.keys());
  }

  /**
   * It retrieves the renderingEngine if it does exist, or creates one otherwise
   * @returns {RenderingEngine} rendering engine
   */
  public getRenderingEngine() {
    // get renderingEngine from cache if it exists
    const renderingEngine = getRenderingEngine(RENDERING_ENGINE_ID);

    if (renderingEngine) {
      this.renderingEngine = renderingEngine;
      return this.renderingEngine;
    }

    if (!renderingEngine || renderingEngine.hasBeenDestroyed) {
      this.renderingEngine = new RenderingEngine(RENDERING_ENGINE_ID);
    }

    return this.renderingEngine;
  }

  /**
   * It triggers the resize on the rendering engine, and renders the viewports
   *
   */
  public resize() {
    // https://stackoverflow.com/a/26279685
    // This resize() call, among other things, rerenders the viewports. But when the entire viewer is
    // display: none'd, it makes the size of all hidden elements 0, including the viewport canvas and its containers.
    // Even if the viewer is later displayed again, trying to render when the size is 0 permanently "breaks" the
    // viewport, making it fully black even after the size is normal again. So just ignore resize events when hidden:
    const areViewportsHidden = Array.from(this.viewportsById.values()).every(viewportInfo => {
      const element = viewportInfo.getElement();

      return element.clientWidth === 0 && element.clientHeight === 0;
    });
    if (areViewportsHidden) {
      console.warn('Ignoring resize when viewports have size 0');
      return;
    }

    const numStackViewportsInViewportGrid = Array.from(this.viewportsById.values()).filter(
      viewportInfo => viewportInfo.getViewportType() === csEnums.ViewportType.STACK
    ).length;

    const numVolumeViewportsInViewportGrid = Array.from(this.viewportsById.values()).filter(
      viewportInfo => viewportInfo.getViewportType() === csEnums.ViewportType.ORTHOGRAPHIC
    ).length;

    const isEasyResize =
      numStackViewportsInViewportGrid <= MIN_STACK_VIEWPORTS_TO_ENQUEUE_RESIZE &&
      numVolumeViewportsInViewportGrid <= MIN_VOLUME_VIEWPORTS_TO_ENQUEUE_RESIZE;

    // if there is a grid resize happening, it means the viewport grid
    // has been manipulated (e.g., panels closed, added, etc.) and we need
    // to resize all viewports, so we will add a timeout here to make sure
    // we don't double resize the viewports when viewports in the grid are
    // resized individually
    if (isEasyResize) {
      this.performResize();
      this.resetGridResizeTimeout();
      this.resizeQueue = [];
      clearTimeout(this.viewportResizeTimer);
    } else {
      this.enqueueViewportResizeRequest();
    }
  }

  /**
   * Removes the viewport from cornerstone, and destroys the rendering engine
   */
  public destroy() {
    this._removeResizeObserver();
    this.viewportGridResizeObserver = null;

    // CRITICAL: Disable each viewport individually BEFORE releasing WebGL contexts.
    //
    // The previous order was: _releaseWebGLContexts() → renderingEngine.destroy().
    // After loseContext(), VTK.js objects are in a broken state. When
    // renderingEngine.destroy() calls _resetViewport(), viewport.removeWidgets()
    // throws (VTK objects invalid), which prevents triggerEvent(ELEMENT_DISABLED)
    // from firing. Without ELEMENT_DISABLED, removeEnabledElement never runs,
    // and ALL DOM event listeners (mouse/wheel/touch/keyboard) on viewport
    // elements are never removed. This is the root cause of Listeners staying
    // at 2,371 and DOM Nodes staying at 2,268 after mode exit.
    //
    // By disabling each viewport first (while the rendering engine is still
    // valid), ELEMENT_DISABLED fires properly, removeEnabledElement runs, and
    // all DOM listeners are removed. Each viewport is in its own try/catch so
    // one failure doesn't block the rest. If disableElement throws, we manually
    // dispatch ELEMENT_DISABLED as a fallback so removeEnabledElement still runs.
    const viewportIds = Array.from(this.viewportsById.keys());
    const renderingEngineId = (this.renderingEngine as any)?.id;

    viewportIds.forEach(vid => {
      const vpInfo = this.viewportsById.get(vid);
      const element = vpInfo?.getElement?.();

      // Release VTK.js ColorTransferFunction and PiecewiseFunction instances
      // from volume actors BEFORE disabling the viewport. VTK.js objects require
      // explicit delete() calls; without this, ColorTransferFunction instances
      // (which hold large RGB point arrays / lookup tables) leak across mode
      // switches, retaining MB of compiled code and lookup table data.
      try {
        const csViewport = this.renderingEngine?.getViewport?.(vid);
        const actorEntries = csViewport?.getActors?.();
        if (actorEntries?.length) {
          actorEntries.forEach(entry => {
            const actor = entry?.actor;
            if (!actor) return;
            try {
              const property = actor.getProperty?.();
              if (property) {
                // Release RGB Transfer Function (ColorTransferFunction)
                const rgbTF = property.getRGBTransferFunction?.(0);
                if (rgbTF && typeof rgbTF.delete === 'function') {
                  rgbTF.delete();
                }
                // Release Scalar Opacity (PiecewiseFunction)
                const opacityTF = property.getScalarOpacity?.(0);
                if (opacityTF && typeof opacityTF.delete === 'function') {
                  opacityTF.delete();
                }
                // Release Gradient Opacity (PiecewiseFunction)
                const gradTF = property.getGradientOpacity?.(0);
                if (gradTF && typeof gradTF.delete === 'function') {
                  gradTF.delete();
                }
              }
            } catch { /* actor already destroyed */ }
          });
        }
      } catch { /* viewport already gone */ }

      // Remove the named VIEWPORT_NEW_IMAGE_SET handler before disabling the element.
      // Without this, the listener (and its closure over viewport.element) persists on
      // the DOM element even after disableElement(), contributing to Listeners leak.
      const handler = (vpInfo as any)?._newImageSetHandler;
      if (handler && element) {
        try {
          element.removeEventListener(csEnums.Events.VIEWPORT_NEW_IMAGE_SET, handler);
          (vpInfo as any)._newImageSetHandler = null;
        } catch (e) {
          // Ignore
        }
      }
      try {
        this.renderingEngine?.disableElement(vid);
      } catch (e) {
        console.warn('[ViewportService] disableElement failed for', vid, '- using fallback', e);
        if (element) {
          try {
            const eventDetail = { element, viewportId: vid, renderingEngineId };
            eventTarget.dispatchEvent(new CustomEvent(csEnums.Events.ELEMENT_DISABLED, { detail: eventDetail }));
          } catch (e2) {
            console.warn('[ViewportService] Fallback also failed for', vid, e2);
          }
        }
      }
    });

    // Release WebGL contexts AFTER disabling viewports (DOM listeners already cleaned)
    this._releaseWebGLContexts();

    try {
      this.renderingEngine?.destroy?.();
    } catch (e) {
      console.warn('[ViewportService] renderingEngine.destroy() failed', e);
    }

    // Clear all viewport info to release DOM element references
    this.viewportsById.clear();
    this.viewportsDisplaySets.clear();
    this.beforeResizePositionPresentations.clear();
    this.renderingEngine = null;

    // Reset the global enabled elements state (holds DOM element references)
    resetEnabledElementsState();

    // Cancel all pending image load requests to release references from the
    // request pool to image load objects. Without this, pending requests keep
    // image pixel data alive even after cache.purgeCache().
    this._clearImageLoadPool();

    // Purge the cornerstone cache (volumes + images) with robust error handling
    this._purgeCacheRobust();

    // Clear pending resize timers. These setTimeout closures capture `this`
    // (the ViewportService instance), preventing it from being GC'd after
    // destroy(). Without this, the service instance leaks on every mode exit.
    clearTimeout(this.viewportResizeTimer);
    clearTimeout(this.gridResizeTimeOut);
    this.viewportResizeTimer = null;
    this.gridResizeTimeOut = null;
  }

  /**
   * Clears all pending image load requests from the imageLoadPoolManager.
   * Pending requests hold references to image load objects (and their pixel data),
   * preventing GC even after cache.purgeCache().
   */
  private _clearImageLoadPool() {
    try {
      const requestTypes = ['interaction', 'thumbnail', 'prefetch', 'compute'];
      requestTypes.forEach(type => {
        try {
          imageLoadPoolManager.clearRequestStack(type);
        } catch (e) {
          // Ignore if the type doesn't exist
        }
      });
      if ((imageLoadPoolManager as any).awake) {
        (imageLoadPoolManager as any).awake = false;
      }
    } catch (e) {
      console.warn('[ViewportService] Failed to clear image load pool', e);
    }
  }

  /**
   * Public cache purge entry point for external callers (e.g. return-to-study-list button).
   * Wraps _purgeCacheRobust with try/catch and clears the image load pool to release
   * pending request references. Safe to call before destroy(); destroy() will still
   * run its own cleanup, but calling this earlier releases memory sooner.
   */
  public purgeCache() {
    try {
      this._clearImageLoadPool();
      this._purgeCacheRobust();
    } catch (e) {
      console.warn('[ViewportService] purgeCache() failed', e);
    }
  }

  /**
   * [2026-07-28 内存诊断] 返回当前 cornerstone 内存状态快照。
   * 用于 ViewerHeader 在"返回查询界面"前后对比，验证清理是否真的执行。
   *
   * 关键指标：
   * - cacheSizeBytes: cache 中的字节总数（对应 JSArrayBufferData 主体）
   * - volumeCount / imageCount: 缓存条目数
   * - pendingRequests: imageLoadPool 中待处理的请求（持有 imageLoadObject 引用）
   * - renderingEngineViewports: 仍然存活的 viewport 数（actor 持有 scalarData 引用）
   * - workerCount: 存活的 web worker 类型数（持有解码 ArrayBuffer）
   */
  public getMemoryStats(): Record<string, number | string> {
    try {
      const cacheAny = cache as any;
      const stats: Record<string, number | string> = {
        cacheSizeBytes: cache.getCacheSize(),
        maxCacheSizeBytes: cache.getMaxCacheSize(),
        volumeCount: cacheAny._volumeCache?.size ?? 0,
        imageCount: cacheAny._imageCache?.size ?? 0,
        renderingEngineExists: this.renderingEngine ? 1 : 0,
        renderingEngineViewports: 0,
        viewportsByIdCount: this.viewportsById.size,
        workerCount: 0,
        pendingWorkerRequests: 0,
      };

      // 统计 imageLoadPoolManager 各类型的 pending 请求数
      let pendingPool = 0;
      try {
        const pool = (imageLoadPoolManager as any).getRequestPool?.() || {};
        Object.values(pool).forEach((prioMap: any) => {
          Object.values(prioMap || {}).forEach((arr: any) => {
            pendingPool += arr?.length || 0;
          });
        });
      } catch { /* ignore */ }
      stats.pendingPoolRequests = pendingPool;

      // 统计 renderingEngine 中存活的 viewport（这些 viewport 的 actor 持有 scalarData 引用）
      try {
        const re = this.renderingEngine as any;
        if (re && !re.hasBeenDestroyed) {
          stats.renderingEngineViewports = re.viewports?.size ?? 0;
        }
      } catch { /* ignore */ }

      // 统计 web worker 状态（直接 import getWebWorkerManager，生产环境也可用）
      try {
        const wwm = (getWebWorkerManager as any)?.();
        if (wwm) {
          stats.workerCount = Object.keys(wwm.workerRegistry || {}).length;
          let pendingWorker = 0;
          const wpmPool = wwm.workerPoolManager?.getRequestPool?.() || {};
          Object.values(wpmPool).forEach((prioMap: any) => {
            Object.values(prioMap || {}).forEach((arr: any) => {
              pendingWorker += arr?.length || 0;
            });
          });
          stats.pendingWorkerRequests = pendingWorker;
        }
      } catch { /* ignore */ }

      return stats;
    } catch (e) {
      return { error: String(e) };
    }
  }

  /**
   * Purges the cornerstone cache with per-entry error handling.
   * The built-in purgeCache() can fail on a single entry and stop cleanup,
   * leaving remaining volumes/images in memory.
   */
  private _purgeCacheRobust() {
    const cacheAny = cache as any;
    const volumeCache = cacheAny._volumeCache;
    const imageCache = cacheAny._imageCache;

    // Purge volume cache with per-entry error handling
    if (volumeCache) {
      const volumeIds = Array.from(volumeCache.keys());
      volumeIds.forEach(volumeId => {
        try {
          cache.removeVolumeLoadObject(volumeId);
        } catch (e) {
          // If removeVolumeLoadObject fails, force-remove from the Map
          try {
            const cachedVolume = volumeCache.get(volumeId);
            if (cachedVolume?.volume?.imageData) {
              cachedVolume.volume.imageData.delete?.();
            }
            volumeCache.delete(volumeId);
          } catch (e2) {
            console.warn('[ViewportService] Failed to remove volume', volumeId, e2);
          }
        }
      });
    }

    // Purge image cache with per-entry error handling
    if (imageCache) {
      const imageIds = Array.from(imageCache.keys());
      imageIds.forEach(imageId => {
        try {
          cache.removeImageLoadObject(imageId, { force: true });
        } catch (e) {
          // If removeImageLoadObject fails, force-remove from the Map
          try {
            const cachedImage = imageCache.get(imageId);
            if (cachedImage?.imageLoadObject?.cancelFn) {
              cachedImage.imageLoadObject.cancelFn();
            }
            if (cachedImage?.imageLoadObject?.decache) {
              cachedImage.imageLoadObject.decache();
            }
            imageCache.delete(imageId);
          } catch (e2) {
            console.warn('[ViewportService] Failed to remove image', imageId, e2);
          }
        }
      });
    }
  }

  /**
   * Explicitly releases WebGL contexts by calling loseContext() on each
   * WebGL context in the rendering engine's context pool.
   * VTK.js's delete() does not call loseContext(), causing GPU memory leaks.
   */
  private _releaseWebGLContexts() {
    try {
      const renderingEngine = this.renderingEngine as any;
      if (!renderingEngine) return;

      // Try multiple paths to find contextPool (wrapper._implementation.contextPool or direct)
      let contextPool = renderingEngine._implementation?.contextPool || renderingEngine.contextPool;

      if (!contextPool) {
        return;
      }

      const contexts = contextPool.contexts || contextPool.getAllContexts?.() || [];
      contexts.forEach((ctx, index) => {
        try {
          if (!ctx || ctx.isDeleted?.()) return;
          const glRenderWindow = ctx.getOpenGLRenderWindow?.();

          // 【关键修复 2026-07-27】必须在 loseContext() 之前调用 releaseGraphicsResources()！
          //
          // 原顺序（有内存泄漏）：
          //   loseContext() → renderingEngine.destroy() → releaseGraphicsResources()
          //   ↑ loseContext 后 WebGL 上下文失效，releaseGraphicsResources 中的
          //     gl.deleteTexture() / gl.deleteBuffer() 等调用全部无效，
          //     导致 CT(~246MB) + PT(~246MB) 的 3D 纹理无法释放！
          //
          // 新顺序（正确）：
          //   releaseGraphicsResources() → loseContext()
          //   ↑ 在 WebGL 上下文仍然有效时，先释放所有 GPU 资源：
          //     - shaderCache（编译的着色器程序，~27.5MB compiled code）
          //     - scalarTextures（CT+PT 的 3D 体素纹理，~492MB）
          //     - colorTexture / opacityTexture（颜色查找表）
          //     - VBO（顶点缓冲对象）
          //     - textureUnitManager（纹理单元管理器）
          //   释放完成后再 loseContext() 彻底关闭 WebGL 上下文。
          //
          // releaseGraphicsResources 内部调用链：
          //   openGLRenderWindow.releaseGraphicsResources()
          //   → 遍历 renderers → glRen.releaseGraphicsResources()
          //   → 遍历 viewProps (actors) → volume.releaseGraphicsResources()
          //   → mapper.releaseGraphicsResources() → scalarTextures[i].releaseGraphicsResources()
          //   → gl.deleteTexture(model.handle)  ← 真正释放 GPU 纹理
          if (glRenderWindow && typeof glRenderWindow.releaseGraphicsResources === 'function') {
            try {
              glRenderWindow.releaseGraphicsResources();
            } catch (e) {
              console.warn('[ViewportService] releaseGraphicsResources failed for', index, e);
            }
          }

          // 释放 GPU 资源后，再调用 loseContext() 彻底关闭 WebGL 上下文
          const gl = glRenderWindow?.get3DContext?.() ?? glRenderWindow?.getContext?.();
          if (gl?.getExtension) {
            const loseExt = gl.getExtension('WEBGL_lose_context');
            if (loseExt) { loseExt.loseContext(); }
          }

          // [2026-07-28 GPU 残留修复] 显式删除 VTK OpenGL 渲染窗口并清空 context/canvas 引用。
          //
          // 问题：loseContext() 只是标记上下文为 "lost"，不会立即释放 GPU 资源。
          // GPU 驱动会等到 WebGL 上下文对象被 GC 回收后才真正释放显存。
          // 但 VTK 的 vtkOpenGLRenderWindow 持有 model.context 和 model.canvas 引用，阻止 GC，
          // 导致 GPU 内存残留 ~300 MB（关闭标签页后才释放）。
          //
          // 修复：在 loseContext() 后立即调用 glRenderWindow.delete()，
          // 然后显式将 model.context 和 model.canvas 设为 null，解除引用链，
          // 让 GC 可以回收 WebGL 上下文。这样 GPU 驱动能在返回查询界面后立即释放显存，
          // 无需等标签页关闭。
          //
          // 验证：
          // - 修复前：返回后 GPU 进程 1.65 GB，关闭标签页后 224 MB（差 1.4 GB）
          // - 修复后（第1步）：返回后 GPU 进程 550 MB（Workers 终止后）
          // - 修复后（第2步）：返回后 GPU 进程应接近 224 MB 基线
          try {
            if (glRenderWindow && !glRenderWindow.isDeleted?.()) {
              glRenderWindow.delete();
              // 显式清空 context 和 canvas 引用，打破 WebGLContext → GPU 内存的引用链
              const glRWM = glRenderWindow as any;
              if (glRWM?.model) {
                glRWM.model.context = null;
                glRWM.model.canvas = null;
              }
            }
          } catch (e) {
            console.warn('[ViewportService] glRenderWindow.delete() failed for', index, e);
          }
        } catch (e) {
          console.warn('[ViewportService] WebGL context release failed for', index, e);
        }
      });

      // Clean up offscreen canvas containers
      const containers = contextPool.offScreenCanvasContainers;
      if (containers && Array.isArray(containers)) {
        containers.forEach(c => { try { c?.parentNode?.removeChild(c); } catch {} });
        containers.length = 0;
      }
    } catch (e) {
      console.warn('[ViewportService] _releaseWebGLContexts failed', e);
    }
  }

  /**
   * Disables the viewport inside the renderingEngine, if no viewport is left
   * it destroys the renderingEngine.
   *
   * This is called when the element goes away entirely - with new viewportId's
   * created for every new viewport, this will be called whenever the set of
   * viewports is changed, but NOT when the viewport position changes only.
   *
   * @param viewportId - The viewportId to disable
   */
  public disableElement(viewportId: string): void {
    this.renderingEngine?.disableElement(viewportId);

    // clean up
    this.viewportsById.delete(viewportId);
    this.viewportsDisplaySets.delete(viewportId);
  }

  /**
   * Sets the presentations for a given viewport. Presentations is an object
   * that can define the lut or position for a viewport.
   *
   * @param viewportId - The ID of the viewport.
   * @param presentations - The presentations to apply to the viewport.
   * @param viewportInfo - Contains a view reference for immediate application
   */
  public setPresentations(viewportId: string, presentations: Presentations): void {
    const viewport = this.getCornerstoneViewport(viewportId) as
      | Types.IStackViewport
      | Types.IVolumeViewport;

    if (!viewport || !presentations) {
      return;
    }

    const { lutPresentation, positionPresentation, segmentationPresentation } = presentations;

    // Always set the segmentation presentation first, since there might be some
    // lutpresentation states that need to be set on the segmentation
    // Todo: i think we should even await this
    this._setSegmentationPresentation(viewport, segmentationPresentation);

    this._setLutPresentation(viewport, lutPresentation);
    this._setPositionPresentation(viewport, { ...positionPresentation, viewportId });
  }

  /**
   * Stores the presentation state for a given viewport inside the
   * each store. This is used to persist the presentation state
   * across different scenarios e.g., when the viewport is changing the
   * display set, or when the viewport is moving to a different layout.
   *
   * @param viewportId The ID of the viewport.
   */
  public storePresentation({ viewportId }) {
    const presentationIds = this.getPresentationIds(viewportId);
    const { syncGroupService } = this.servicesManager.services;
    const synchronizers = syncGroupService.getSynchronizersForViewport(viewportId);

    if (!presentationIds || Object.keys(presentationIds).length === 0) {
      return null;
    }

    const { lutPresentationId, positionPresentationId, segmentationPresentationId } =
      presentationIds;

    const positionPresentation = this._getPositionPresentation(viewportId);
    const lutPresentation = this._getLutPresentation(viewportId);
    const segmentationPresentation = this._getSegmentationPresentation(viewportId);

    const { setLutPresentation } = useLutPresentationStore.getState();
    const { setPositionPresentation } = usePositionPresentationStore.getState();
    const { setSynchronizers } = useSynchronizersStore.getState();
    const { setSegmentationPresentation } = useSegmentationPresentationStore.getState();

    if (lutPresentationId) {
      setLutPresentation(lutPresentationId, lutPresentation);
    }

    if (positionPresentationId) {
      setPositionPresentation(positionPresentationId, positionPresentation);
    }

    if (segmentationPresentationId) {
      setSegmentationPresentation(segmentationPresentationId, segmentationPresentation);
    }

    if (synchronizers?.length) {
      setSynchronizers(
        viewportId,
        synchronizers.map(synchronizer => ({
          id: synchronizer.id,
          sourceViewports: [...synchronizer.getSourceViewports()],
          targetViewports: [...synchronizer.getTargetViewports()],
        }))
      );
    }
  }

  /**
   * Retrieves the presentations for a given viewport.
   * @param viewportId - The ID of the viewport.
   * @returns The presentations for the viewport.
   */
  public getPresentations(viewportId: string): Presentations {
    const positionPresentation = this._getPositionPresentation(viewportId);
    const lutPresentation = this._getLutPresentation(viewportId);
    const segmentationPresentation = this._getSegmentationPresentation(viewportId);

    return {
      positionPresentation,
      lutPresentation,
      segmentationPresentation,
    };
  }

  private getPresentationIds(viewportId: string): AppTypes.PresentationIds | null {
    const viewportInfo = this.viewportsById.get(viewportId);
    if (!viewportInfo) {
      return null;
    }

    return viewportInfo.getPresentationIds();
  }

  private _getPositionPresentation(viewportId: string): PositionPresentation {
    const csViewport = this.getCornerstoneViewport(viewportId);
    if (!csViewport) {
      return;
    }

    const viewportInfo = this.viewportsById.get(viewportId);

    return {
      viewportType: viewportInfo.getViewportType(),
      viewReference: csViewport instanceof VolumeViewport3D ? null : csViewport.getViewReference(),
      viewPresentation: csViewport.getViewPresentation({ pan: true, zoom: true }),
      viewportId,
    };
  }

  private _getLutPresentation(viewportId: string): LutPresentation {
    const csViewport = this.getCornerstoneViewport(viewportId) as
      | Types.IStackViewport
      | Types.IVolumeViewport;

    if (!csViewport) {
      return;
    }

    const cleanProperties = properties => {
      if (properties?.isComputedVOI) {
        delete properties?.voiRange;
        delete properties?.VOILUTFunction;
      }
      if (properties?.colormap) {
        if (properties.colormap?.opacity?.length === 0) {
          delete properties.colormap.opacity;
        }
      }
      return properties;
    };

    const properties =
      csViewport instanceof BaseVolumeViewport
        ? new Map()
        : cleanProperties(csViewport.getProperties());

    if (properties instanceof Map) {
      const volumeIds = (csViewport as Types.IBaseVolumeViewport).getAllVolumeIds();
      volumeIds?.forEach(volumeId => {
        const csProps = cleanProperties(csViewport.getProperties(volumeId));
        properties.set(volumeId, csProps);
      });
    }

    const viewportInfo = this.viewportsById.get(viewportId);

    return {
      viewportType: viewportInfo.getViewportType(),
      properties,
    };
  }

  private _getSegmentationPresentation(viewportId: string): SegmentationPresentation {
    const { segmentationService } = this.servicesManager.services;

    const presentation = segmentationService.getPresentation(viewportId);
    return presentation;
  }

  /**
   * Sets the viewport data for a viewport.
   * @param viewportId - The ID of the viewport to set the data for.
   * @param viewportData - The viewport data to set.
   * @param publicViewportOptions - The public viewport options.
   * @param publicDisplaySetOptions - The public display set options.
   * @param presentations - The presentations to set.
   */
  public setViewportData(
    viewportId: string,
    viewportData: StackViewportData | VolumeViewportData,
    publicViewportOptions: PublicViewportOptions,
    publicDisplaySetOptions: DisplaySetOptions[],
    presentations?: Presentations
  ): void {
    const renderingEngine = this.getRenderingEngine();

    // if not valid viewportData then return early
    if (viewportData.viewportType === csEnums.ViewportType.STACK) {
      // check if imageIds is valid
      if (!viewportData.data[0].imageIds?.length) {
        return;
      }
    }

    // This is the old viewportInfo, which may have old options but we might be
    // using its viewport (same viewportId as the new viewportInfo)
    const viewportInfo = this.viewportsById.get(viewportId);

    // We should store the presentation for the current viewport since we can't only
    // rely to store it WHEN the viewport is disabled since we might keep around the
    // same viewport/element and just change the viewportData for it (drag and drop etc.)
    // the disableElement storePresentation handle would not be called in this case
    // and we would lose the presentation.
    this.storePresentation({ viewportId: viewportInfo.getViewportId() });

    // Todo: i don't like this here, move it
    this.servicesManager.services.segmentationService.clearSegmentationRepresentations(
      viewportInfo.getViewportId()
    );

    if (!viewportInfo) {
      throw new Error('element is not enabled for the given viewportId');
    }

    // override the viewportOptions and displaySetOptions with the public ones
    // since those are the newly set ones, we set them here so that it handles defaults
    const displaySetOptions = viewportInfo.setPublicDisplaySetOptions(publicDisplaySetOptions);
    // Specify an over-ride for the viewport type, even though it is in the public
    // viewport options, because the one in the viewportData is a requirement based on the
    // type of data being displayed.
    const viewportOptions = viewportInfo.setPublicViewportOptions(
      publicViewportOptions,
      viewportData.viewportType
    );

    const element = viewportInfo.getElement();
    const type = viewportInfo.getViewportType();
    const background = viewportInfo.getBackground();
    const orientation = viewportInfo.getOrientation();
    const displayArea = viewportInfo.getDisplayArea();

    const viewportInput: Types.PublicViewportInput = {
      viewportId,
      element,
      type,
      defaultOptions: {
        background,
        orientation,
        displayArea,
      },
    };

    // Rendering Engine Id set should happen before enabling the element
    // since there are callbacks that depend on the renderingEngine id
    // Todo: however, this is a limitation which means that we can't change
    // the rendering engine id for a given viewport which might be a super edge
    // case
    viewportInfo.setRenderingEngineId(renderingEngine.id);

    // Todo: this is not optimal at all, we are re-enabling the already enabled
    // element which is not what we want. But enabledElement as part of the
    // renderingEngine is designed to be used like this. This will trigger
    // ENABLED_ELEMENT again and again, which will run onEnableElement callbacks
    renderingEngine.enableElement(viewportInput);

    viewportInfo.setViewportOptions(viewportOptions);
    viewportInfo.setDisplaySetOptions(displaySetOptions);
    viewportInfo.setViewportData(viewportData);
    viewportInfo.setViewportId(viewportId);

    this.viewportsById.set(viewportId, viewportInfo);

    const viewport = renderingEngine.getViewport(viewportId);
    const displaySetPromise = this._setDisplaySets(
      viewport,
      viewportData,
      viewportInfo,
      presentations
    );

    // The broadcast event here ensures that listeners have a valid, up to date
    // viewport to access.  Doing it too early can result in exceptions or
    // invalid data.
    displaySetPromise.then(() => {
      this._broadcastEvent(this.EVENTS.VIEWPORT_DATA_CHANGED, {
        viewportData,
        viewportId,
      });
    });
  }

  public getViewportOptions(viewportId: string): ViewportOptions {
    return this.viewportsById.get(viewportId).getViewportOptions();
  }

  /**
   * Retrieves the Cornerstone viewport with the specified ID.
   *
   * @param viewportId - The ID of the viewport.
   * @returns The Cornerstone viewport object if found, otherwise null.
   */
  public getCornerstoneViewport(viewportId: string): Types.IViewport | null {
    const viewportInfo = this.getViewportInfo(viewportId);

    if (!viewportInfo || !this.renderingEngine || this.renderingEngine.hasBeenDestroyed) {
      return null;
    }

    const viewport = this.renderingEngine.getViewport(viewportId);

    return viewport;
  }

  /**
   * Retrieves the viewport information for a given viewport ID. The viewport information
   * is the OHIF construct that holds different options and data for a given viewport and
   * is different from the cornerstone viewport.
   *
   * @param viewportId The ID of the viewport.
   * @returns The viewport information.
   */
  public getViewportInfo(viewportId: string): ViewportInfo {
    return this.viewportsById.get(viewportId);
  }

  public getOrientation(viewportId: string): string {
    const viewportInfo = this.getViewportInfo(viewportId);
    return viewportInfo.getOrientation();
  }

  /**
   * Looks through the viewports to see if the specified measurement can be
   * displayed in one of the viewports. This function tries to get a "best fit"
   * viewport to display the image in where it matches, in order:
   *   * Active viewport that can be navigated to the given image without orientation change
   *   * Other viewport that can be navigated to the given image without orientation change
   *   * Best-aligned viewport that can display the image with an orientation change
   *
   * It returns `null` otherwise, indicating that a viewport needs display set/type
   * changes in order to display the image.
   *
   * Notes:
   *   * If the display set is displayed in multiple viewports all needing orientation change,
   *     then the active one or first one listed will be modified.  This can create unexpected
   *     behaviour for MPR views.
   *   * If the image is contained in multiple display sets, then the first one
   *     found will be navigated (active first, followed by first found)
   *
   * @param measurement - The measurement that is desired to view.
   * @param activeViewportId - the index that was active at the time the jump
   *          was initiated.
   * @return the viewportId that the measurement should be displayed in.
   */
  public findNavigationCompatibleViewportId(activeViewportId: string, metadata): string {
    // First check if the active viewport can just be navigated to show the given item
    const activeViewport = this.getCornerstoneViewport(activeViewportId);
    if (!activeViewport) {
      console.warn('No active viewport found for', activeViewportId);
    }
    if (activeViewport?.isReferenceViewable(metadata, WITH_NAVIGATION)) {
      return activeViewportId;
    }

    // Next, see if any viewport could be navigated to show the given item,
    // without considering orientation changes.
    for (const id of this.viewportsById.keys()) {
      const viewport = this.getCornerstoneViewport(id);
      if (viewport?.isReferenceViewable(metadata, WITH_NAVIGATION)) {
        return id;
      }
    }

    // Compute view-plane alignment scores for all viewports to prefer the one
    // requiring the least orientation change when navigation-only is not possible.
    const viewportAlignmentData = this.getViewportAlignmentData(metadata);

    // See if any viewport could show this with an orientation change
    for (const { viewportId: id } of viewportAlignmentData) {
      const viewport = this.getCornerstoneViewport(id);
      if (viewport?.isReferenceViewable(metadata, WITH_ORIENTATION)) {
        return id;
      }
    }

    // No luck, need to update the viewport itself
    return null;
  }

  /**
   * Given a metadata instance containing a planeRestriction, returns the
   * ordered list of best orientation match viewport ids.
   *
   * This uses the planeRestriction preferentially as that one is more reliably
   * filled than the viewport normal since it is created from data points on
   * rehydration.
   */
  public getViewportAlignmentData(metadata) {
    const viewportAlignmentData = [];
    const { viewPlaneNormal: refViewPlaneNormal, planeRestriction } = metadata;
    const inPlaneVector1 = planeRestriction?.inPlaneVector1;
    const inPlaneVector2 = planeRestriction?.inPlaneVector2;

    for (const id of this.viewportsById.keys()) {
      const viewport = this.getCornerstoneViewport(id);
      const { viewPlaneNormal } = viewport.getCamera();

      if (!viewPlaneNormal) {
        continue;
      }
      let alignmentScore = 0;
      if (inPlaneVector1 || inPlaneVector2) {
        const inPlane1Score = inPlaneVector1
          ? -Math.abs(vec3.dot(viewPlaneNormal, inPlaneVector1))
          : 0;
        const inPlane2Score = inPlaneVector2
          ? -Math.abs(vec3.dot(viewPlaneNormal, inPlaneVector2))
          : 0;
        alignmentScore = inPlane1Score + inPlane2Score;
      } else if (refViewPlaneNormal) {
        alignmentScore = Math.abs(vec3.dot(viewPlaneNormal, refViewPlaneNormal));
      }
      viewportAlignmentData.push({ viewportId: id, alignmentScore });
    }

    // Try best-aligned viewports first
    viewportAlignmentData.sort((a, b) => b.alignmentScore - a.alignmentScore);
    return viewportAlignmentData;
  }

  /**
   * Figures out which viewport to update when the viewport type needs to change.
   * Orchestrates the search strategies in order of preference.
   */
  public findUpdateableViewportConfiguration(activeViewportId: string, measurement) {
    const { metadata, displaySetInstanceUID } = measurement;
    const { displaySetService } = this.servicesManager.services;
    const displaySet = displaySetService.getDisplaySetByUID(displaySetInstanceUID);

    // 1. Determine the target Viewport Type (Stack vs Volume)
    const viewportType = this.determineTargetViewportType(displaySet, metadata);

    // 2. Strategy: Find viewport already showing this volume
    const volumeMatch = this.findViewportShowingVolume(
      metadata,
      displaySetInstanceUID,
      viewportType
    );
    if (volumeMatch) {
      return volumeMatch;
    }

    // 3. Strategy: Find viewport with compatible orientation (even if different display set)
    const compatibleMatch = this.findViewportConvertibleToVolume(
      metadata,
      displaySetInstanceUID,
      viewportType
    );
    if (compatibleMatch) {
      return compatibleMatch;
    }

    // 4. Strategy: Find viewport with matching orientation via IOP
    const orientationMatch = this.findViewportWithMatchingOrientation(
      metadata,
      displaySetInstanceUID,
      viewportType
    );
    if (orientationMatch) {
      return orientationMatch;
    }

    // 5. Fallback: Use the active viewport
    return {
      viewportId: activeViewportId,
      displaySetInstanceUID,
      viewportOptions: { viewportType },
    };
  }

  /**
   * Determines if the viewport should be what is specified in
   * the viewportType of the display set, or stack if the display
   * set isn't reconstructable and there is a referenced image id, otherwise
   * volume.
   *
   * Expect there to be more rules in the future for different types of annotations/settings
   * such as 3d annotations.
   */
  public determineTargetViewportType(displaySet, metadata): string {
    let { viewportType } = displaySet;

    if (!viewportType) {
      if (metadata.referencedImageId && !displaySet.isReconstructable) {
        viewportType = csEnums.ViewportType.STACK;
      } else if (metadata.volumeId) {
        viewportType = 'volume';
      }
    }
    return viewportType;
  }

  /**
   * Find viewports that could be updated to be volumes to show this view.
   * Prefers a viewport already showing the right display set.
   */
  public findViewportShowingVolume(metadata, displaySetInstanceUID, viewportType) {
    if (!metadata.volumeId) {
      return null;
    }

    for (const id of this.viewportsById.keys()) {
      const viewport = this.getCornerstoneViewport(id);
      if (viewport?.isReferenceViewable(metadata, { asVolume: true, withNavigation: true })) {
        return {
          viewportId: id,
          displaySetInstanceUID,
          viewportOptions: { viewportType },
        };
      }
    }
    return null;
  }

  /**
   * Find a viewport that could be converted to a volume to show this annotation,
   * already showing the right display set.
   */
  public findViewportConvertibleToVolume(metadata, displaySetInstanceUID, viewportType) {
    const { viewportGridService } = this.servicesManager.services;
    const altMetadata = { ...metadata, volumeId: null, referencedImageId: null };

    for (const id of this.viewportsById.keys()) {
      const viewport = this.getCornerstoneViewport(id);
      const viewportDisplaySetUID = viewportGridService.getDisplaySetsUIDsForViewport(id)?.[0];

      if (!viewportDisplaySetUID || !viewport) {
        continue;
      }

      if (metadata.volumeId) {
        altMetadata.volumeId = viewportDisplaySetUID;
      }
      altMetadata.FrameOfReferenceUID = this._getFrameOfReferenceUID(viewportDisplaySetUID);

      if (viewport.isReferenceViewable(altMetadata, { asVolume: true, withNavigation: true })) {
        return {
          viewportId: id,
          displaySetInstanceUID,
          viewportOptions: { viewportType },
        };
      }
    }
    return null;
  }

  /**
   * Find a viewport with the closest orientation but on a different display set.
   */
  public findViewportWithMatchingOrientation(metadata, displaySetInstanceUID, viewportType) {
    const viewportAlignmentData = this.getViewportAlignmentData(metadata);
    if (viewportAlignmentData?.length) {
      return {
        ...viewportAlignmentData[0],
        displaySetInstanceUID,
        viewportOptions: { viewportType },
      };
    }
    return null;
  }

  /**
   * Sets the image data for the given viewport.
   */
  private async _setEcgViewport(
    viewport: Types.IECGViewport,
    viewportData: StackViewportData
  ): Promise<void> {
    const [displaySet] = viewportData.data;
    const imageId = displaySet.imageIds?.[0];
    if (!imageId) {
      console.error('[CornerstoneViewportService] ECG display set has no imageId');
      return;
    }
    return viewport.setEcg(imageId);
  }

  private async _setOtherViewport(
    viewport: Types.IStackViewport,
    viewportData: StackViewportData,
    viewportInfo: ViewportInfo,
    _presentations: Presentations = {}
  ): Promise<void> {
    const [displaySet] = viewportData.data;
    return viewport.setDataIds(displaySet.imageIds, {
      groupId: displaySet.displaySetInstanceUID,
      viewReference: viewportInfo.getViewReference(),
    });
  }

  private async _setStackViewport(
    viewport: Types.IStackViewport,
    viewportData: StackViewportData,
    viewportInfo: ViewportInfo,
    presentations: Presentations = {}
  ): Promise<void> {
    const displaySetOptions = viewportInfo.getDisplaySetOptions();

    const displaySetInstanceUIDs = viewportData.data.map(data => data.displaySetInstanceUID);

    // based on the cache service construct always the first one is the non-overlay
    // and the rest are overlays

    this.viewportsDisplaySets.set(viewport.id, [...displaySetInstanceUIDs]);

    const { initialImageIndex, imageIds } = viewportData.data[0];

    // Use the slice index from any provided view reference, as the view reference
    // is being used to navigate to the initial view position for measurement
    // navigation and other navigation forcing specific views.
    let initialImageIndexToUse =
      presentations?.positionPresentation?.initialImageIndex ?? (initialImageIndex as number);

    const { rotation, flipHorizontal, displayArea } = viewportInfo.getViewportOptions();

    const properties = { ...presentations.lutPresentation?.properties };
    if (!presentations.lutPresentation?.properties) {
      const { voi, voiInverted, colormap } = displaySetOptions[0];
      if (voi && (voi.windowWidth || voi.windowCenter)) {
        const { lower, upper } = csUtils.windowLevel.toLowHighRange(
          voi.windowWidth,
          voi.windowCenter
        );
        properties.voiRange = { lower, upper };
      }

      properties.invert = voiInverted ?? properties.invert;
      properties.colormap = colormap ?? properties.colormap;
    }

    // Use a named handler so we can remove it in destroy() to prevent listener leak.
    // The previous anonymous arrow function could never be removed via removeEventListener,
    // causing the listener (and its closure over `viewport.element`) to persist forever.
    const handleNewImageSet = (evt: any) => {
      const { element } = evt.detail;

      if (element !== viewport.element) {
        return;
      }

      csToolsUtils.stackContextPrefetch.enable(element);
    };
    viewport.element.addEventListener(csEnums.Events.VIEWPORT_NEW_IMAGE_SET, handleNewImageSet);
    // Store the handler on viewportInfo so destroy() can remove it
    (viewportInfo as any)._newImageSetHandler = handleNewImageSet;

    const overlayProcessingResults = this._processExtraDisplaySetsForViewport(viewport);

    const referencedImageId = presentations?.positionPresentation?.viewReference?.referencedImageId;
    if (referencedImageId) {
      initialImageIndexToUse = imageIds.indexOf(referencedImageId);
    }

    if (
      initialImageIndexToUse === undefined ||
      initialImageIndexToUse === null ||
      initialImageIndexToUse < 0
    ) {
      initialImageIndexToUse = this._getInitialImageIndexForViewport(viewportInfo, imageIds) || 0;
    }

    await viewport.setStack(imageIds, initialImageIndexToUse);
    viewport.setProperties({ ...properties });
    this.setPresentations(viewport.id, presentations, viewportInfo);

    await this._addOverlayRepresentations(overlayProcessingResults);

    if (displayArea) {
      viewport.setDisplayArea(displayArea);
    }
    if (rotation) {
      viewport.setProperties({ rotation });
    }
    if (flipHorizontal) {
      viewport.setCamera({ flipHorizontal: true });
    }
  }

  private _getInitialImageIndexForViewport(
    viewportInfo: ViewportInfo,
    imageIds?: string[]
  ): number {
    const initialImageOptions = viewportInfo.getInitialImageOptions();
    if (!initialImageOptions) {
      return;
    }
    const { index, preset } = initialImageOptions;
    const viewportType = viewportInfo.getViewportType();

    let numberOfSlices;
    if (viewportType === csEnums.ViewportType.STACK) {
      numberOfSlices = imageIds.length;
    } else if (viewportType === csEnums.ViewportType.ORTHOGRAPHIC) {
      const viewport = this.getCornerstoneViewport(viewportInfo.getViewportId());
      const imageSliceData = csUtils.getImageSliceDataForVolumeViewport(viewport);

      if (!imageSliceData) {
        return;
      }

      ({ numberOfSlices } = imageSliceData);
    } else {
      return;
    }

    return this._getInitialImageIndex(numberOfSlices, index, preset);
  }

  _getInitialImageIndex(numberOfSlices: number, imageIndex?: number, preset?: JumpPresets): number {
    const lastSliceIndex = numberOfSlices - 1;

    if (imageIndex !== undefined) {
      return csUtils.clip(imageIndex, 0, lastSliceIndex);
    }

    if (preset === JumpPresets.First) {
      return 0;
    }

    if (preset === JumpPresets.Last) {
      return lastSliceIndex;
    }

    if (preset === JumpPresets.Middle) {
      // Note: this is a simple but yet very important formula.
      // since viewport reset works with the middle slice
      // if the below formula is not correct, on a viewport reset
      // it will jump to a different slice than the middle one which
      // was the initial slice, and we have some tools such as Crosshairs
      // which rely on a relative camera modifications and those will break.
      return lastSliceIndex % 2 === 0 ? lastSliceIndex / 2 : (lastSliceIndex + 1) / 2;
    }

    return 0;
  }

  async _setVolumeViewport(
    viewport: Types.IVolumeViewport,
    viewportData: VolumeViewportData,
    viewportInfo: ViewportInfo,
    presentations: Presentations = {}
  ): Promise<void> {
    // TODO: We need to overhaul the way data sources work so requests can be made
    // async. I think we should follow the image loader pattern which is async and
    // has a cache behind it.
    // The problem is that to set this volume, we need the metadata, but the request is
    // already in-flight, and the promise is not cached, so we have no way to wait for
    // it and know when it has fully arrived.
    // loadStudyMetadata(StudyInstanceUID) => Promise([instances for study])
    // loadSeriesMetadata(StudyInstanceUID, SeriesInstanceUID) => Promise([instances for series])
    // If you call loadStudyMetadata and it's not in the DicomMetadataStore cache, it should fire
    // a request through the data source?
    // (This call may or may not create sub-requests for series metadata)
    const { displaySetService } = this.servicesManager.services;
    const volumeInputArray = [];
    const displaySetOptionsArray = viewportInfo.getDisplaySetOptions();
    const { hangingProtocolService } = this.servicesManager.services;

    const volumeToLoad = [];
    const displaySetInstanceUIDs = [];

    for (const [index, data] of viewportData.data.entries()) {
      const { imageIds, displaySetInstanceUID } = data;
      let volume = data.volume;

      const displaySet = displaySetService.getDisplaySetByUID(displaySetInstanceUID);
      if (!volume && displaySet.images) {
        volume = csToolsUtils.getOrCreateImageVolume(displaySet.images.map(image => image.imageId));
      }

      displaySetInstanceUIDs.push(displaySetInstanceUID);

      if (!volume) {
        console.log('Volume display set not found');
        continue;
      }

      volumeToLoad.push(volume);

      const displaySetOptions = displaySetOptionsArray[index];
      const { volumeId } = volume;
      volumeInputArray.push({
        imageIds,
        volumeId,
        modality: displaySet.Modality,
        displaySetInstanceUID,
        blendMode: displaySetOptions.blendMode,
        slabThickness: this._getSlabThickness(displaySetOptions, volumeId),
      });
    }

    this.viewportsDisplaySets.set(viewport.id, displaySetInstanceUIDs);

    const volumesNotLoaded = volumeToLoad.filter(volume => !volume.loadStatus?.loaded);
    if (volumesNotLoaded.length) {
      if (hangingProtocolService.getShouldPerformCustomImageLoad()) {
        // delegate the volume loading to the hanging protocol service if it has a custom image load strategy
        return hangingProtocolService.runImageLoadStrategy({
          viewportId: viewport.id,
          volumeInputArray,
        });
      }

      volumesNotLoaded.forEach(volume => {
        if (!volume.loadStatus?.loading && volume.load instanceof Function) {
          volume.load();
        }
      });
    }

    // It's crucial not to return here because the volume may be loaded,
    // but the viewport also needs to set the volume.
    // if (!volumesNotLoaded.length) {
    //   return;
    // }

    // This returns the async continuation only
    return this.setVolumesForViewport(viewport, volumeInputArray, presentations);
  }

  public async setVolumesForViewport(viewport, volumeInputArray, presentations) {
    const { displaySetService, viewportGridService } = this.servicesManager.services;

    const viewportInfo = this.getViewportInfo(viewport.id);
    const displaySetOptions = viewportInfo.getDisplaySetOptions();
    const displaySetUIDs = viewportGridService.getDisplaySetsUIDsForViewport(viewport.id);
    const displaySet = displaySetService.getDisplaySetByUID(displaySetUIDs[0]);
    const displaySetModality = displaySet?.Modality;

    // seems like a hack but we need the actor to be ready first before
    // we set the properties
    const timeoutViewportCallback = (callback: () => void) => setTimeout(callback, 0);

    // filter overlay display sets (e.g. segmentation) since they will get handled below via the segmentation service
    const filteredVolumeInputArray = volumeInputArray
      .map((volumeInput, index) => {
        return { volumeInput, displaySetOptions: displaySetOptions[index] };
      })
      .filter(({ volumeInput }) => {
        const displaySet = displaySetService.getDisplaySetByUID(volumeInput.displaySetInstanceUID);
        return !displaySet?.isOverlayDisplaySet;
      });

    // Todo: use presentations states
    const volumesProperties = filteredVolumeInputArray.map(({ volumeInput, displaySetOptions }) => {
      const { volumeId } = volumeInput;
      const { voi, voiInverted, colormap, displayPreset } = displaySetOptions;
      const properties = {} as ViewportProperties;

      if (voi && (voi.windowWidth || voi.windowCenter)) {
        const { lower, upper } = csUtils.windowLevel.toLowHighRange(
          voi.windowWidth,
          voi.windowCenter
        );
        properties.voiRange = { lower, upper };
      }

      if (voiInverted !== undefined) {
        properties.invert = voiInverted;
      }

      if (colormap !== undefined) {
        properties.colormap = colormap;
      }

      if (displayPreset !== undefined) {
        properties.preset = displayPreset[displaySetModality] || displayPreset.default;
      }

      return { properties, volumeId };
    });

    // For SEG and RT viewports
    const overlayProcessingResults = this._processExtraDisplaySetsForViewport(viewport) || [];
    if (!filteredVolumeInputArray.length && overlayProcessingResults?.length) {
      overlayProcessingResults.forEach(({ imageIds, addOverlayFn }) => {
        if (addOverlayFn) {
          // if there is no volume input array, and there is an addOverlayFn, means we need to take
          // care of the background overlay display set first then the addOverlayFn will add the
          // SEG displaySet
          const sampleImageId = imageIds[0];
          const backgroundDisplaySet = displaySetService.getDisplaySetsBy(
            displaySet =>
              !displaySet.isOverlayDisplaySet &&
              displaySet.images?.some(image => image.imageId === sampleImageId)
          );

          if (backgroundDisplaySet.length !== 1) {
            throw new Error('Background display set not found');
          }

          if (viewport.type === csEnums.ViewportType.VOLUME_3D) {
            timeoutViewportCallback(() => {
              viewportGridService.setDisplaySetsForViewport({
                viewportId: viewport.id,
                displaySetInstanceUIDs: [backgroundDisplaySet[0].displaySetInstanceUID],
              });
            });
          }
        }
      });
    }

    // [GPU内存优化] 切换序列前保存旧 actors，setVolumes 后释放其 GPU 纹理。
    // BaseVolumeViewport.setVolumes() 会替换旧 actor 但不释放 GPU 纹理，
    // 导致旧 CT/PT 纹理残留在 GPU 中，每次切换序列 GPU 内存累积。
    let oldActorEntries: any[] = [];
    try {
      oldActorEntries = viewport.getActors?.() || [];
    } catch { /* ignore */ }

    await viewport.setVolumes(volumeInputArray);
    await this._addOverlayRepresentations(overlayProcessingResults);
    viewport.render();

    // setVolumes 完成后，释放旧 actor 的 GPU 纹理
    // 纹理存储在 mapper.model 中：scalarTextures(数组)、colorTexture、opacityTexture
    try {
      const renderingEngine = this.renderingEngine;
      const glRenderWindow = renderingEngine?.getContexts?.()?.[0]?.getGLRenderWindow?.();

      oldActorEntries.forEach(entry => {
        const actor = entry?.actor;
        if (!actor) return;
        try {
          const mapper = actor.getMapper?.();
          if (mapper && mapper.model) {
            const m = mapper.model;
            // 释放 scalarTextures 数组中的每个纹理
            if (m.scalarTextures && Array.isArray(m.scalarTextures)) {
              m.scalarTextures.forEach(tex => {
                if (tex && glRenderWindow) {
                  try { tex.releaseGraphicsResources(glRenderWindow); } catch { /* ignore */ }
                }
              });
            }
            // 释放 colorTexture
            if (m.colorTexture && glRenderWindow) {
              try { m.colorTexture.releaseGraphicsResources(glRenderWindow); } catch { /* ignore */ }
            }
            // 释放 opacityTexture
            if (m.opacityTexture && glRenderWindow) {
              try { m.opacityTexture.releaseGraphicsResources(glRenderWindow); } catch { /* ignore */ }
            }
          }
        } catch { /* actor already destroyed */ }
      });
    } catch { /* cleanup failed */ }

    volumesProperties.forEach(({ properties, volumeId }) => {
      timeoutViewportCallback(() => {
        viewport.setProperties(properties, volumeId);
        viewport.render();
      });
    });

    this.setPresentations(viewport.id, presentations);

    if (!presentations.positionPresentation) {
      const imageIndex = this._getInitialImageIndexForViewport(viewportInfo);

      if (imageIndex !== undefined) {
        csUtils.jumpToSlice(viewport.element, {
          imageIndex,
        });
      }
    }

    this._broadcastEvent(this.EVENTS.VIEWPORT_VOLUMES_CHANGED, {
      viewportInfo,
    });
  }

  private _processExtraDisplaySetsForViewport(
    viewport: Types.IStackViewport | Types.IVolumeViewport
  ) {
    const { displaySetService } = this.servicesManager.services;

    // load any secondary displaySets
    const displaySetInstanceUIDs = this.viewportsDisplaySets.get(viewport.id);

    // Find overlay display sets (e.g. SEG, RTSTRUCT)
    const overlayDisplaySets = displaySetInstanceUIDs
      .map(displaySetService.getDisplaySetByUID)
      .filter(displaySet => displaySet?.isOverlayDisplaySet);

    // if it is only the overlay displaySet, then we need to get the reference
    // displaySet imageIds and set them as the imageIds for the viewport,
    // here we can do some logic if the reference is missing
    // then find the most similar match of displaySet instead
    if (!overlayDisplaySets?.length) {
      return;
    }

    return overlayDisplaySets.map(overlayDisplaySet => {
      let imageIds;
      if (overlayDisplaySet.referencedDisplaySetInstanceUID) {
        const referenceDisplaySet = displaySetService.getDisplaySetByUID(
          overlayDisplaySet.referencedDisplaySetInstanceUID
        );
        imageIds = referenceDisplaySet.images.map(image => image.imageId);
      }
      return {
        imageIds,
        addOverlayFn: () => this.addOverlayRepresentationForDisplaySet(overlayDisplaySet, viewport),
      };
    });
  }

  private addOverlayRepresentationForDisplaySet(
    displaySet: OhifTypes.DisplaySet,
    viewport: Types.IViewport
  ): Promise<void> {
    const { segmentationService } = this.servicesManager.services;
    const segmentationId = displaySet.displaySetInstanceUID;

    const representationType =
      displaySet.Modality === 'SEG'
        ? csToolsEnums.SegmentationRepresentations.Labelmap
        : csToolsEnums.SegmentationRepresentations.Contour;

    const { predecessorImageId } = displaySet;
    const segmentationRepresentationPromise = segmentationService.addSegmentationRepresentation(
      viewport.id,
      {
        segmentationId,
        predecessorImageId,
        type: representationType,
        config: {
          blendMode:
            viewport?.getBlendMode?.() === 1
              ? BlendModes.LABELMAP_EDGE_PROJECTION_BLEND
              : undefined,
        },
      }
    );
    // store the segmentation presentation id in the viewport info
    this.storePresentation({ viewportId: viewport.id });
    return segmentationRepresentationPromise;
  }

  private async _addOverlayRepresentations(
    overlayProcessingResults?: Array<{ addOverlayFn?: () => Promise<void> }>
  ): Promise<void> {
    if (!overlayProcessingResults?.length) {
      return;
    }
    for (const overlayProcessingResult of overlayProcessingResults) {
      if (overlayProcessingResult?.addOverlayFn) {
        await overlayProcessingResult.addOverlayFn();
      }
    }
  }

  // Todo: keepCamera is an interim solution until we have a better solution for
  // keeping the camera position when the viewport data is changed
  public updateViewport(viewportId: string, viewportData, keepCamera = false) {
    const viewportInfo = this.getViewportInfo(viewportId);
    const viewport = this.getCornerstoneViewport(viewportId);
    const viewportCamera = viewport.getCamera();

    let displaySetPromise;

    if (viewport instanceof VolumeViewport || viewport instanceof VolumeViewport3D) {
      displaySetPromise = this._setVolumeViewport(viewport, viewportData, viewportInfo).then(() => {
        if (keepCamera) {
          viewport.setCamera(viewportCamera);
          viewport.render();
        }
      });
    }

    if (viewport instanceof StackViewport) {
      displaySetPromise = this._setStackViewport(viewport, viewportData, viewportInfo);
    }

    displaySetPromise.then(() => {
      this._broadcastEvent(this.EVENTS.VIEWPORT_DATA_CHANGED, {
        viewportData,
        viewportId,
      });
    });
  }

  _setDisplaySets(
    viewport: Types.IViewport,
    viewportData: StackViewportData | VolumeViewportData,
    viewportInfo: ViewportInfo,
    presentations: Presentations = {}
  ): Promise<void> {
    if (viewport instanceof StackViewport) {
      return this._setStackViewport(
        viewport,
        viewportData as StackViewportData,
        viewportInfo,
        presentations
      );
    }

    if ([VolumeViewport, VolumeViewport3D].some(type => viewport instanceof type)) {
      return this._setVolumeViewport(
        viewport as Types.IVolumeViewport,
        viewportData as VolumeViewportData,
        viewportInfo,
        presentations
      );
    }

    if (viewport instanceof ECGViewport) {
      return this._setEcgViewport(
        viewport as unknown as Types.IECGViewport,
        viewportData as StackViewportData
      );
    }

    return this._setOtherViewport(
      viewport,
      viewportData as StackViewportData,
      viewportInfo,
      presentations
    );
  }

  /**
   * Removes the resize observer from the viewport element
   */
  _removeResizeObserver() {
    if (this.viewportGridResizeObserver) {
      this.viewportGridResizeObserver.disconnect();
    }
  }

  _getSlabThickness(displaySetOptions, volumeId) {
    const { blendMode } = displaySetOptions;
    if (blendMode === undefined || displaySetOptions.slabThickness === undefined) {
      return;
    }

    // if there is a slabThickness set as a number then use it
    if (typeof displaySetOptions.slabThickness === 'number') {
      return displaySetOptions.slabThickness;
    }

    if (displaySetOptions.slabThickness.toLowerCase() === 'fullvolume') {
      // calculate the slab thickness based on the volume dimensions
      const imageVolume = cache.getVolume(volumeId);

      const { dimensions, spacing } = imageVolume;
      const slabThickness = Math.sqrt(
        Math.pow(dimensions[0] * spacing[0], 2) +
          Math.pow(dimensions[1] * spacing[1], 2) +
          Math.pow(dimensions[2] * spacing[2], 2)
      );

      return slabThickness;
    }
  }

  _getFrameOfReferenceUID(displaySetInstanceUID) {
    const { displaySetService } = this.servicesManager.services;
    const displaySet = displaySetService.getDisplaySetByUID(displaySetInstanceUID);

    if (!displaySet) {
      return;
    }

    if (displaySet.FrameOfReferenceUID) {
      return displaySet.FrameOfReferenceUID;
    }

    if (displaySet.Modality === 'SEG') {
      const { instance } = displaySet;
      return instance.FrameOfReferenceUID;
    }

    if (displaySet.Modality === 'RTSTRUCT') {
      const { instance } = displaySet;
      return instance.ReferencedFrameOfReferenceSequence.FrameOfReferenceUID;
    }

    const { images } = displaySet;
    if (images && images.length) {
      return images[0].FrameOfReferenceUID;
    }
  }

  private enqueueViewportResizeRequest() {
    this.resizeQueue.push(false); // false indicates viewport resize

    clearTimeout(this.viewportResizeTimer);
    this.viewportResizeTimer = setTimeout(() => {
      this.processViewportResizeQueue();
    }, this.gridResizeDelay);
  }

  private processViewportResizeQueue() {
    const isGridResizeInQueue = this.resizeQueue.some(isGridResize => isGridResize);
    if (this.resizeQueue.length > 0 && !isGridResizeInQueue && !this.gridResizeTimeOut) {
      this.performResize();
    }

    // Clear the queue after processing viewport resizes
    this.resizeQueue = [];
  }

  private performResize() {
    const isImmediate = false;

    try {
      const viewports = this.getRenderingEngine().getViewports();

      // Store the current position presentations for each viewport.
      viewports.forEach(({ id: viewportId }) => {
        const presentation = this._getPositionPresentation(viewportId);

        // During a resize, the slice index should remain unchanged. This is a temporary fix for
        // a larger issue regarding the definition of slice index with slab thickness.
        // We need to revisit this to make it more robust and understandable.
        delete presentation.viewReference?.sliceIndex;
        this.beforeResizePositionPresentations.set(viewportId, presentation);
      });

      // Resize the rendering engine and render.
      const renderingEngine = this.renderingEngine;
      renderingEngine.resize(isImmediate);
      renderingEngine.render();

      // Reset the camera for all viewports using position presentation to maintain relative size/position
      // which means only those viewports that have a zoom level of 1.
      this.beforeResizePositionPresentations.forEach((positionPresentation, viewportId) => {
        this.setPresentations(viewportId, {
          positionPresentation,
        });
      });

      // Resize and render the rendering engine again.
      renderingEngine.resize(isImmediate);
      renderingEngine.render();
    } catch (e) {
      // This can happen if the resize is too close to navigation or shutdown
      console.warn('Caught resize exception', e);
    }
  }

  private resetGridResizeTimeout() {
    clearTimeout(this.gridResizeTimeOut);
    this.gridResizeTimeOut = setTimeout(() => {
      this.gridResizeTimeOut = null;
    }, this.gridResizeDelay);
  }

  private _setLutPresentation(
    viewport: Types.IStackViewport | Types.IVolumeViewport,
    lutPresentation: LutPresentation
  ): void {
    if (!lutPresentation) {
      return;
    }

    const { properties } = lutPresentation;
    if (viewport instanceof BaseVolumeViewport) {
      if (properties instanceof Map) {
        properties.forEach((propertiesEntry, volumeId) => {
          viewport.setProperties(propertiesEntry, volumeId);
        });
      } else {
        viewport.setProperties(properties);
      }
    } else {
      viewport.setProperties(properties);
    }
  }

  private _setPositionPresentation(
    viewport: Types.IStackViewport | Types.IVolumeViewport,
    positionPresentation: PositionPresentation
  ): void {
    const viewRef = positionPresentation?.viewReference;
    if (viewRef) {
      // The orientation can be updated here to navigate to the specified
      // measurement or previous item, but this will not switch to volume
      // or to stack from the other type
      if (viewport.isReferenceViewable(viewRef, WITH_ORIENTATION)) {
        viewport.setViewReference(viewRef);
      } else {
        console.warn('Unable to apply reference viewable', viewRef);
      }
    }

    const viewPresentation = positionPresentation?.viewPresentation;
    if (viewPresentation) {
      viewport.setViewPresentation(viewPresentation);
    }
  }

  private _setSegmentationPresentation(
    viewport: Types.IStackViewport | Types.IVolumeViewport,
    segmentationPresentation: SegmentationPresentation
  ): void {
    if (!segmentationPresentation) {
      return;
    }

    const { segmentationService } = this.servicesManager.services;

    segmentationPresentation.forEach((presentationItem: SegmentationPresentationItem) => {
      const { segmentationId, type, hydrated } = presentationItem;

      const { Labelmap, Surface } = csToolsEnums.SegmentationRepresentations;
      const isVolume3D = viewport.type === csEnums.ViewportType.VOLUME_3D;

      // Determine the appropriate segmentation representation for the viewport.
      // If the current type is Surface but the viewport is not 3D, fallback to Labelmap.
      // Otherwise, use the existing type.
      const representationType = type === Surface && !isVolume3D ? Labelmap : type;

      if (hydrated) {
        segmentationService.addSegmentationRepresentation(viewport.id, {
          segmentationId,
          type: representationType,
          config: {
            blendMode:
              viewport?.getBlendMode?.() === 1
                ? BlendModes.LABELMAP_EDGE_PROJECTION_BLEND
                : undefined,
          },
        });
      }
    });
  }

  /**
   * Gets the display sets for a given viewport
   * @param viewportId - The ID of the viewport to get display sets for
   * @returns Array of display sets for the viewport
   */
  public getViewportDisplaySets(viewportId: string): OhifTypes.DisplaySet[] {
    const { displaySetService } = this.servicesManager.services;
    const displaySetInstanceUIDs = this.viewportsDisplaySets.get(viewportId) || [];

    return displaySetInstanceUIDs
      .map(uid => displaySetService.getDisplaySetByUID(uid))
      .filter(Boolean);
  }
}

export default CornerstoneViewportService;
