// [2026-07-30 新增] TMTV 十字线服务
//
// 独立于 Cornerstone CrosshairsTool，使用 SVG overlay 绘制十字线。
// 不依赖任何 ToolGroup，直接管理 viewport 上的 SVG 层。
//
// 第一版功能（仅显示）：
//   - visible: 控制十字线显隐
//   - worldPosition: 十字线在世界坐标系中的位置
//   - viewports: 注册的 viewport 列表
//   - SVG overlay 绘制横竖两条参考线
//
// 暂不实现：
//   ❌ 鼠标拖动
//   ❌ slice 同步
//   ❌ rotation
//   ❌ reference line
//   ❌ annotation
//
// 架构：
//   TMTVCrosshairService
//     |
//     +-- ctAXIAL (SVG overlay)
//     +-- ptAXIAL (SVG overlay)
//     +-- fusionAXIAL (SVG overlay)
//     +-- mipSagittal (SVG overlay)
//
// 每个 viewport.element 上添加一个绝对定位的 SVG 层：
//   viewport.element
//     |-- canvas (Cornerstone 渲染)
//     +-- svg (十字线 overlay, pointer-events: none)

const SVG_NS = 'http://www.w3.org/2000/svg';
const CROSSHAIR_COLOR = 'rgb(0, 200, 0)';
const CROSSHAIR_LINE_WIDTH = 1;
// cornerstone3D 相机变化事件常量（对应 Enums.Events.CAMERA_MODIFIED）
const CAMERA_MODIFIED_EVENT = 'CORNERSTONE_CAMERA_MODIFIED';

// 支持的 TMTV 布局 stage ID
const TMTV_STAGE_IDS = new Set([
  '2x3-layout', // AXIAL
  '2x4-layout', // Sagittal
  'coronal-mip-layout', // Coronal
]);

// 每个 TMTV 布局对应的 viewportId 列表
// 注意：viewportId 字符串必须与 hpViewports.ts 中的实际值完全一致（区分大小写）
//   - mipSAGITTAL 常量的 viewportId 为 'mipSagittal'（非 'mipSAGITTAL'）
//   - mipCORONAL 常量的 viewportId 为 'mipCoronal'（非 'mipCORONAL'）
//   - fusionCORONAL 常量的 viewportId 为 'fusionCoronal'（非 'fusionCORONAL'）
const TMTV_VIEWPORT_IDS_BY_STAGE: Record<string, string[]> = {
  '2x3-layout': ['ctAXIAL', 'ptAXIAL', 'fusionAXIAL', 'mipSagittal'],
  '2x4-layout': ['ctSAGITTAL', 'ptSAGITTAL', 'fusionSAGITTAL', 'mipSagittal'],
  'coronal-mip-layout': ['ctCORONAL', 'ptCORONAL', 'fusionCoronal', 'mipCoronal'],
};

class TMTVCrosshairService {
  private visible = false;
  private worldPosition: [number, number, number] | null = null;
  private viewports = new Map<string, any>(); // viewportId -> viewport instance
  private svgLayers = new Map<string, SVGSVGElement>(); // viewportId -> SVG element
  // [Lessons Learned] 保存创建时的 element 引用，用于准确移除 CAMERA_MODIFIED 监听器。
  // Cornerstone 可能在后续替换 viewport.element，若用当前 element 移除监听器会失败，导致内存泄漏。
  private elements = new Map<string, HTMLElement>(); // viewportId -> 创建时的 element 引用
  // [Lessons Learned] 横竖线元素一次性创建并复用，后续重绘仅更新 x1/y1/x2/y2 属性，
  // 避免每次 render 频繁创建/销毁 DOM 节点。
  private hLines = new Map<string, SVGLineElement>(); // viewportId -> 横线元素
  private vLines = new Map<string, SVGLineElement>(); // viewportId -> 竖线元素
  private resizeObservers = new Map<string, ResizeObserver>();
  private cameraModifiedHandlers = new Map<string, (evt: any) => void>();

  /**
   * 判断指定的 stage ID 是否为 TMTV 布局
   */
  isTmtvLayout(stageId: string): boolean {
    return TMTV_STAGE_IDS.has(stageId);
  }

  /**
   * 获取指定 TMTV 布局的 viewportId 列表
   */
  getViewportIdsForStage(stageId: string): string[] {
    return TMTV_VIEWPORT_IDS_BY_STAGE[stageId] || [];
  }

  /**
   * 注册 viewport
   * 在 viewport.element 上创建 SVG overlay 层
   */
  addViewport(viewportId: string, viewport: any): void {
    if (!viewport) {
      console.warn(`[TMTVCrosshairService] addViewport: viewport 为空 (${viewportId})`);
      return;
    }

    // 如果已存在，先移除旧的
    if (this.viewports.has(viewportId)) {
      this.removeViewport(viewportId);
    }

    this.viewports.set(viewportId, viewport);

    try {
      this._createSvgLayer(viewportId, viewport);
    } catch (e) {
      console.warn(`[TMTVCrosshairService] 创建 SVG 层失败 (${viewportId})`, e);
    }

    // 初始化世界坐标位置（使用第一个 viewport 的 focalPoint）
    if (!this.worldPosition && viewport.getCamera) {
      try {
        const camera = viewport.getCamera();
        if (camera?.focalPoint) {
          this.worldPosition = [
            camera.focalPoint[0],
            camera.focalPoint[1],
            camera.focalPoint[2],
          ];
        }
      } catch (e) {
        // ignore
      }
    }

    this.render();
  }

  /**
   * 移除 viewport，清理 SVG 层和事件监听
   */
  removeViewport(viewportId: string): void {
    this._removeSvgLayer(viewportId);
    this.viewports.delete(viewportId);
  }

  /**
   * 移除所有 viewport，清理所有资源
   * 确保所有 Map 被清空，防止残留引用导致内存泄漏
   *
   * [2026-08-04] 不重置 visible 和 worldPosition：
   * 布局切换时需保留这些状态，使十字线在切换后自动恢复显示，
   * 与原生 CrosshairsTool 在布局切换时保持激活状态的行为一致。
   * 退出模式时请调用 reset() 完全重置状态。
   */
  clear(): void {
    Array.from(this.viewports.keys()).forEach(viewportId => {
      this.removeViewport(viewportId);
    });
    // 确保所有 Map 被清空（removeViewport 已逐个 delete，但兜底清空）
    this.viewports.clear();
    this.svgLayers.clear();
    this.elements.clear();
    this.hLines.clear();
    this.vLines.clear();
    this.resizeObservers.clear();
    this.cameraModifiedHandlers.clear();
  }

  /**
   * 完全重置状态（包括 visible 和 worldPosition）
   * 用于退出 TMTV 模式时清理，确保下次进入时为初始状态
   */
  reset(): void {
    this.clear();
    this.worldPosition = null;
    this.visible = false;
  }

  /**
   * 设置十字线可见性
   */
  setVisible(value: boolean): void {
    this.visible = value;
    this.render();
  }

  /**
   * 获取当前可见性
   */
  getVisible(): boolean {
    return this.visible;
  }

  /**
   * 设置十字线世界坐标位置
   */
  setPosition(worldPoint: [number, number, number]): void {
    this.worldPosition = [
      worldPoint[0],
      worldPoint[1],
      worldPoint[2],
    ];
    this.render();
  }

  /**
   * 获取当前世界坐标位置
   */
  getPosition(): [number, number, number] | null {
    return this.worldPosition;
  }

  /**
   * 获取已注册的 viewport 实例
   */
  getViewport(viewportId: string): any {
    return this.viewports.get(viewportId);
  }

  /**
   * 渲染十字线到所有注册的 viewport
   */
  render(): void {
    if (!this.visible || !this.worldPosition) {
      // 隐藏所有 SVG 层
      this.svgLayers.forEach(svg => {
        svg.style.display = 'none';
      });
      return;
    }

    this.viewports.forEach((viewport, viewportId) => {
      const svg = this.svgLayers.get(viewportId);
      if (!svg) {
        return;
      }

      try {
        const canvas = viewport.canvas;
        if (!canvas) {
          return;
        }

        const width = canvas.clientWidth;
        const height = canvas.clientHeight;

        // 世界坐标转 canvas 坐标
        const canvasPoint = viewport.worldToCanvas(this.worldPosition);
        if (!canvasPoint || !Number.isFinite(canvasPoint[0]) || !Number.isFinite(canvasPoint[1])) {
          svg.style.display = 'none';
          return;
        }

        svg.style.display = '';
        this._drawCrosshair(viewportId, svg, canvasPoint, width, height);
      } catch (e) {
        // viewport 可能已销毁，静默忽略
        svg.style.display = 'none';
      }
    });
  }

  /**
   * 在 viewport.element 上创建 SVG overlay 层
   */
  private _createSvgLayer(viewportId: string, viewport: any): void {
    const element = viewport.element;
    if (!element) {
      console.warn(`[TMTVCrosshairService] viewport.element 为空 (${viewportId})`);
      return;
    }

    // 创建 SVG 元素
    const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
    svg.style.position = 'absolute';
    svg.style.top = '0';
    svg.style.left = '0';
    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.style.pointerEvents = 'none';
    svg.style.zIndex = '100';
    svg.style.display = 'none'; // 默认隐藏

    element.appendChild(svg);
    this.svgLayers.set(viewportId, svg);
    // [Lessons Learned] 保存创建时的 element 引用。
    // Cornerstone 可能在后续替换 viewport.element，移除监听器时必须用此引用。
    this.elements.set(viewportId, element);

    // [Lessons Learned] 一次性创建横竖线元素，后续重绘仅更新 x1/y1/x2/y2 属性，
    // 避免每次 render 频繁创建/销毁 DOM 节点。
    const hLine = document.createElementNS(SVG_NS, 'line') as SVGLineElement;
    hLine.setAttribute('stroke', CROSSHAIR_COLOR);
    hLine.setAttribute('stroke-width', String(CROSSHAIR_LINE_WIDTH));
    svg.appendChild(hLine);
    this.hLines.set(viewportId, hLine);

    const vLine = document.createElementNS(SVG_NS, 'line') as SVGLineElement;
    vLine.setAttribute('stroke', CROSSHAIR_COLOR);
    vLine.setAttribute('stroke-width', String(CROSSHAIR_LINE_WIDTH));
    svg.appendChild(vLine);
    this.vLines.set(viewportId, vLine);

    // 监听 canvas 尺寸变化，重绘十字线
    const resizeObserver = new ResizeObserver(() => {
      this.render();
    });
    resizeObserver.observe(element);
    this.resizeObservers.set(viewportId, resizeObserver);

    // 监听相机变化（滚动、缩放、平移时重绘十字线）
    try {
      const handler = () => {
        this.render();
      };
      element.addEventListener(CAMERA_MODIFIED_EVENT, handler);
      this.cameraModifiedHandlers.set(viewportId, handler);
    } catch (e) {
      // 如果无法监听相机事件，十字线仍可显示，只是不会跟随相机移动
      console.debug(`[TMTVCrosshairService] 无法监听 CAMERA_MODIFIED (${viewportId})`, e);
    }
  }

  /**
   * 移除 SVG overlay 层和相关监听
   */
  private _removeSvgLayer(viewportId: string): void {
    // [Lessons Learned] 每个清理步骤独立 try-catch，避免单步异常中断后续清理。
    // 清理顺序：ResizeObserver → CAMERA_MODIFIED 监听 → SVG 元素 → Map 引用

    // 1. 移除 ResizeObserver
    try {
      const observer = this.resizeObservers.get(viewportId);
      if (observer) {
        observer.disconnect();
        this.resizeObservers.delete(viewportId);
      }
    } catch (e) {
      // ignore
    }

    // 2. 移除 CAMERA_MODIFIED 监听
    //    [Lessons Learned] 必须使用创建时的 element 引用（this.elements），
    //    而非当前 viewport.element。Cornerstone 可能在后续替换 viewport.element，
    //    用新引用调用 removeEventListener 会失败，导致旧监听器残留引发内存泄漏。
    try {
      const handler = this.cameraModifiedHandlers.get(viewportId);
      const element = this.elements.get(viewportId);
      if (handler && element) {
        element.removeEventListener(CAMERA_MODIFIED_EVENT, handler);
      }
      this.cameraModifiedHandlers.delete(viewportId);
    } catch (e) {
      // ignore
    }

    // 3. 移除 SVG 元素（连同其中的横竖线子节点）
    try {
      const svg = this.svgLayers.get(viewportId);
      if (svg && svg.parentNode) {
        svg.parentNode.removeChild(svg);
      }
    } catch (e) {
      // ignore
    }

    // 4. 清理所有相关 Map 引用，防止内存泄漏
    this.svgLayers.delete(viewportId);
    this.elements.delete(viewportId);
    this.hLines.delete(viewportId);
    this.vLines.delete(viewportId);
  }

  /**
   * 在 SVG 上绘制十字线（横线 + 竖线）
   * [Lessons Learned] 复用 _createSvgLayer 中一次性创建的横竖线元素，
   * 此处仅更新 x1/y1/x2/y2 属性，避免频繁 DOM 节点创建/销毁。
   */
  private _drawCrosshair(
    viewportId: string,
    svg: SVGSVGElement,
    canvasPoint: [number, number],
    width: number,
    height: number
  ): void {
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

    const x = canvasPoint[0];
    const y = canvasPoint[1];

    // 横线（贯穿整个视口宽度）—— 复用已创建元素，仅更新坐标
    const hLine = this.hLines.get(viewportId);
    if (hLine) {
      hLine.setAttribute('x1', '0');
      hLine.setAttribute('y1', String(y));
      hLine.setAttribute('x2', String(width));
      hLine.setAttribute('y2', String(y));
    }

    // 竖线（贯穿整个视口高度）—— 复用已创建元素，仅更新坐标
    const vLine = this.vLines.get(viewportId);
    if (vLine) {
      vLine.setAttribute('x1', String(x));
      vLine.setAttribute('y1', '0');
      vLine.setAttribute('x2', String(x));
      vLine.setAttribute('y2', String(height));
    }
  }
}

// 导出单例实例
const tmtvCrosshairService = new TMTVCrosshairService();
export default tmtvCrosshairService;
export { TMTVCrosshairService };
