// [2026-07-30 新增] TMTV 十字线服务
// [2026-08-05 新增] 第二阶段：点击定位（位置同步）
// [2026-08-05 新增] 第三阶段：十字线拖动（Crosshair Drag）
// [2026-08-05 新增] 第四阶段：双切线旋转（Crosshair Rotation）
//
// 独立于 Cornerstone CrosshairsTool，使用 SVG overlay 绘制十字线。
// 不依赖任何 ToolGroup，直接管理 viewport 上的 SVG 层。
//
// 已实现功能：
//   - visible: 控制十字线显隐
//   - worldPosition: 十字线在世界坐标系中的位置
//   - viewports: 注册的 viewport 列表
//   - SVG overlay 绘制横竖两条参考线（中心空心）
//   - 点击定位：点击任意 viewport，四个 viewport 的十字线同步移动到同一解剖位置
//   - 十字线拖动：按住十字线中心拖动，所有 viewport 同步移动
//   - 双切线旋转：旋转十字线方向，CT/PET/Fusion 同步旋转，MIP 不参与
//
// 十字线状态（TMTVCrosshairState）：
//   - visible: 可见性
//   - worldPosition: 世界坐标位置（点击/拖动改变）
//   - viewPlaneNormal: 当前平面法向量
//   - viewUp: 平面内上方向（旋转改变）
//   - rotationAngle: 累计旋转角度（度，用于 SVG 绘制）
//
// 旋转设计：
//   - 只旋转 CT/PET/Fusion，MIP 保持自己的投影规则
//   - 旋转只改变 viewUp（绕 viewPlaneNormal 旋转），不改变 worldPosition
//   - 旋转通过 viewport.setCamera({ viewUp }) 应用到非 MIP viewport
//   - SVG 十字线方向随旋转角度同步绘制
//
// 架构：
//   TMTVCrosshairService
//     |
//     +-- ctAXIAL (SVG overlay + mousedown handler + camera sync)
//     +-- ptAXIAL (SVG overlay + mousedown handler + camera sync)
//     +-- fusionAXIAL (SVG overlay + mousedown handler + camera sync)
//     +-- mipSagittal (SVG overlay + mousedown handler, NO rotation)
//
// 每个 viewport.element 上添加一个绝对定位的 SVG 层：
//   viewport.element
//     |-- canvas (Cornerstone 渲染)
//     +-- svg (十字线 overlay, pointer-events: none)

const SVG_NS = 'http://www.w3.org/2000/svg';
const CROSSHAIR_COLOR = 'rgb(0, 200, 0)';
const CROSSHAIR_LINE_WIDTH = 1;
// [2026-08-05] 十字线中心空白半径（像素）：中心两侧各留此长度的间隙，形成空心中心
const CROSSHAIR_CENTER_GAP = 12;
// [2026-08-05 第四阶段] 旋转相关常量
const ROTATION_LINE_HIT_THRESHOLD = 8; // 鼠标到十字线的距离阈值（像素），在此范围内可触发旋转
const HANDLE_DISTANCE = 50; // 旋转手柄距十字线中心的距离（像素）
const HANDLE_RADIUS = 4; // 旋转手柄圆点半径（像素）
// cornerstone3D 相机变化事件常量（对应 Enums.Events.CAMERA_MODIFIED）
const CAMERA_MODIFIED_EVENT = 'CORNERSTONE_CAMERA_MODIFIED';
// cornerstone3D 图像渲染完成事件常量（对应 Enums.Events.IMAGE_RENDERED）
// [2026-08-05] 作为 CAMERA_MODIFIED 的补充保障：任何渲染完成后重绘十字线，
// 防止边缘场景（如 volume 加载完成、方向切换重建）下 CAMERA_MODIFIED 未触发导致十字线丢失
const IMAGE_RENDERED_EVENT = 'CORNERSTONE_IMAGE_RENDERED';
// [2026-08-05 第三阶段] 拖动命中阈值（像素）：鼠标距十字线中心小于此值时认为抓到了十字线
const DRAG_HIT_THRESHOLD = 10;

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
  // [2026-08-05 第四阶段] 旋转状态：只改变方向，不改变位置
  private viewPlaneNormal: [number, number, number] | null = null;
  private viewUp: [number, number, number] | null = null;
  private rotationAngle = 0; // 累计旋转角度（度），用于 SVG 十字线方向绘制
  private viewports = new Map<string, any>(); // viewportId -> viewport instance
  private svgLayers = new Map<string, SVGSVGElement>(); // viewportId -> SVG element
  // [Lessons Learned] 保存创建时的 element 引用，用于准确移除 CAMERA_MODIFIED 监听器。
  // Cornerstone 可能在后续替换 viewport.element，若用当前 element 移除监听器会失败，导致内存泄漏。
  private elements = new Map<string, HTMLElement>(); // viewportId -> 创建时的 element 引用
  // [Lessons Learned] 线段元素一次性创建并复用，后续重绘仅更新 x1/y1/x2/y2 属性，
  // 避免每次 render 频繁创建/销毁 DOM 节点。
  // [2026-08-05] 十字线中心为空心，每条线拆成两段，共4段
  private hLineLefts = new Map<string, SVGLineElement>(); // viewportId -> 横线左段
  private hLineRights = new Map<string, SVGLineElement>(); // viewportId -> 横线右段
  private vLineTops = new Map<string, SVGLineElement>(); // viewportId -> 竖线上段
  private vLineBottoms = new Map<string, SVGLineElement>(); // viewportId -> 竖线下段
  private resizeObservers = new Map<string, ResizeObserver>();
  // [2026-08-05] 存储 CAMERA_MODIFIED + IMAGE_RENDERED 事件的 handler（共用同一个 handler）
  private renderEventHandlers = new Map<string, (evt: any) => void>();
  // [2026-08-05 新增] 存储 mousedown 事件处理器，用于点击定位和清理
  private mouseDownHandlers = new Map<string, (evt: MouseEvent) => void>();

  // [2026-08-05 第三阶段] 拖动状态
  // 拖动期间 mousemove/mouseup 监听在 document 上，确保鼠标移出 viewport 仍能跟踪
  private dragging = false;
  private activeViewport: string | null = null;
  private documentMouseMoveHandler: ((evt: MouseEvent) => void) | null = null;
  private documentMouseUpHandler: ((evt: MouseEvent) => void) | null = null;

  // [2026-08-05 第四阶段] 旋转状态
  // 旋转与拖动共用 documentMouseMoveHandler/documentMouseUpHandler（互斥，不会同时进行）
  private rotating = false;
  private rotationStartAngle = 0;
  private rotationActiveViewport: string | null = null;
  // 旋转手柄 SVG 圆点（每个 viewport 4个，位于线段两端）
  private handles = new Map<string, SVGCircleElement[]>();

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
   * [2026-08-05 第四阶段] 判断 viewport 是否为 MIP（不参与旋转）
   * MIP viewportId 以 'mip' 开头（mipSagittal / mipCoronal）
   */
  private _isMipViewport(viewportId: string): boolean {
    return viewportId.startsWith('mip');
  }

  /**
   * [2026-08-05 第四阶段] 从 viewport camera 初始化方向状态
   * 仅在 viewPlaneNormal/viewUp 未初始化时执行（取第一个非 MIP viewport 的方向）
   */
  private _initOrientationFromViewport(viewport: any): void {
    if (this.viewPlaneNormal && this.viewUp) return;
    try {
      const camera = viewport.getCamera?.();
      if (camera?.viewPlaneNormal && camera?.viewUp) {
        this.viewPlaneNormal = [
          camera.viewPlaneNormal[0],
          camera.viewPlaneNormal[1],
          camera.viewPlaneNormal[2],
        ];
        this.viewUp = [
          camera.viewUp[0],
          camera.viewUp[1],
          camera.viewUp[2],
        ];
        this.rotationAngle = 0;
      }
    } catch (e) {
      // ignore
    }
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

    // [2026-08-05 第四阶段] 初始化方向状态（从第一个非 MIP viewport）
    if (!this._isMipViewport(viewportId)) {
      this._initOrientationFromViewport(viewport);
      // [2026-08-05] 同方位图像不改变 camera，不需要应用 viewUp 到新 viewport
      // 旋转只改变 SVG 十字线方向，图像本身不旋转
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
   *
   * [2026-08-05 第三阶段] 清理前先结束拖动，移除 document 上的 mousemove/mouseup 监听
   *
   * [2026-08-05 第四阶段] 重置方向状态（viewPlaneNormal/viewUp/rotationAngle）：
   * 布局切换时 viewPlaneNormal 会变化（AXIAL→Sagittal→Coronal），
   * 旧的 viewUp 和 rotationAngle 不适用于新布局，必须重置后由
   * addViewport 重新从新 viewport 的 camera 初始化。
   */
  clear(): void {
    // [第三阶段] 先结束拖动，移除 document 监听，防止清理后回调执行引发错误
    this._endDrag();
    // [第四阶段] 结束旋转，移除 document 监听
    this._endRotation();

    Array.from(this.viewports.keys()).forEach(viewportId => {
      this.removeViewport(viewportId);
    });
    // 确保所有 Map 被清空（removeViewport 已逐个 delete，但兜底清空）
    this.viewports.clear();
    this.svgLayers.clear();
    this.elements.clear();
    this.hLineLefts.clear();
    this.hLineRights.clear();
    this.vLineTops.clear();
    this.vLineBottoms.clear();
    this.resizeObservers.clear();
    this.renderEventHandlers.clear();
    this.mouseDownHandlers.clear();
    this.handles.clear();
    // [第四阶段] 重置方向状态，布局切换后由 addViewport 重新初始化
    this.viewPlaneNormal = null;
    this.viewUp = null;
    this.rotationAngle = 0;
  }

  /**
   * 完全重置状态（包括 visible、worldPosition 和旋转状态）
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
   * [2026-08-05 第四阶段] 获取累计旋转角度（度）
   * 用于调试和测试
   */
  getRotationAngle(): number {
    return this.rotationAngle;
  }

  /**
   * [2026-08-05 第四阶段 Phase 4.1] 旋转十字线（测试函数）
   *
   * 功能：将十字线旋转指定角度，CT/PET/Fusion 同步旋转，MIP 不参与
   *
   * 参数：
   *   deltaDegrees - 旋转角度增量（度），正数逆时针，负数顺时针
   *
   * 流程：
   *   1. 将 viewUp 绕 viewPlaneNormal 旋转 deltaDegrees（Rodrigues 公式）
   *   2. 累加 rotationAngle（用于 SVG 十字线方向绘制）
   *   3. [2026-08-05 修改] 同方位图像不改变 camera，只旋转 SVG 十字线
   *   4. 重绘十字线（render 中根据 rotationAngle 旋转线段）
   *
   * 边界条件：
   *   - viewPlaneNormal/viewUp 未初始化时不执行
   *   - 异常时打印警告日志
   *
   * 设计说明：
   *   同方位图像（如 AXIAL 布局下 CT/PET/Fusion 均为轴向）旋转时，
   *   只旋转十字线 SVG 线条作为参考方向，不调用 setCamera 改变图像方向。
   *   相当于同步一个参考线位置，图像本身不旋转。
   */
  rotateCrosshair(deltaDegrees: number): void {
    if (!this.viewPlaneNormal || !this.viewUp) {
      console.warn('[TMTVCrosshairService] rotateCrosshair: 方向状态未初始化');
      return;
    }

    try {
      const deltaRad = (deltaDegrees * Math.PI) / 180;

      // 更新 viewUp（绕 viewPlaneNormal 旋转，保留状态供后续阶段使用）
      this.viewUp = this._rotateVectorAroundAxis(
        this.viewUp,
        this.viewPlaneNormal,
        deltaRad
      );

      // 累加旋转角度（用于 SVG 绘制）
      this.rotationAngle += deltaDegrees;

      // [2026-08-05] 同方位图像：只旋转十字线 SVG，不改变 camera
      // CT/PET/Fusion 在同一平面时，旋转只改变十字线方向，
      // 不需要 setCamera，图像本身不旋转
      // this._applyOrientationToViewports();

      // 重绘十字线（SVG 线段方向随 rotationAngle 旋转）
      this.render();
    } catch (e) {
      console.warn('[TMTVCrosshairService] rotateCrosshair 失败', e);
    }
  }

  /**
   * [2026-08-05 第四阶段] Rodrigues 旋转公式
   * 将向量 v 绕单位轴 axis 旋转 angleRad 弧度
   *
   * 公式: v' = v*cos(θ) + (k × v)*sin(θ) + k*(k·v)*(1-cos(θ))
   *   其中 k 为归一化的 axis
   */
  private _rotateVectorAroundAxis(
    v: [number, number, number],
    axis: [number, number, number],
    angleRad: number
  ): [number, number, number] {
    // 归一化轴向量
    const len = Math.sqrt(
      axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]
    );
    if (len === 0) return [v[0], v[1], v[2]];
    const k = [axis[0] / len, axis[1] / len, axis[2] / len];

    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);

    // k × v (叉积)
    const cross = [
      k[1] * v[2] - k[2] * v[1],
      k[2] * v[0] - k[0] * v[2],
      k[0] * v[1] - k[1] * v[0],
    ];

    // k · v (点积)
    const dot = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];

    // Rodrigues 公式
    return [
      v[0] * cos + cross[0] * sin + k[0] * dot * (1 - cos),
      v[1] * cos + cross[1] * sin + k[1] * dot * (1 - cos),
      v[2] * cos + cross[2] * sin + k[2] * dot * (1 - cos),
    ];
  }

  /**
   * [2026-08-05 第四阶段] 应用当前方向状态到所有非 MIP viewport
   *
   * 功能：将 viewUp（和 viewPlaneNormal）应用到 CT/PET/Fusion viewport
   *       MIP viewport 跳过，保持自己的投影规则
   *
   * 边界条件：
   *   - viewUp/viewPlaneNormal 为空时跳过
   *   - 单个 viewport 失败不影响其他
   *   - viewport 可能已销毁，try-catch 静默处理
   */
  private _applyOrientationToViewports(): void {
    if (!this.viewUp) return;

    this.viewports.forEach((viewport, viewportId) => {
      // MIP 不参与旋转
      if (this._isMipViewport(viewportId)) return;

      try {
        viewport.setCamera({ viewUp: this.viewUp! });
      } catch (e) {
        // viewport 可能已销毁，静默忽略
      }
    });
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
   * [2026-08-05 新增, 第三/四阶段更新] 处理鼠标按下事件
   *
   * 功能：根据点击位置决定行为
   *   - 点击十字线中心附近（距离 < DRAG_HIT_THRESHOLD）→ 进入拖动模式（Phase 3）
   *   - 点击十字线线段（距离线 < ROTATION_LINE_HIT_THRESHOLD，非 MIP）→ 进入旋转模式（Phase 4）
   *   - 点击其他位置 → Phase 2 点击定位，十字线跳到点击位置
   *
   * 边界条件处理：
   *   - 十字线未显示时不处理
   *   - 仅处理左键 (evt.button === 0)
   *   - 上一次拖动/旋转的 mouseup 丢失时自动恢复（避免状态卡死）
   *   - viewport 或 canvas 为空时跳过
   *   - 异常时打印警告日志，不中断后续处理
   */
  private handleMouseDown(viewportId: string, viewport: any, evt: MouseEvent): void {
    // 十字线未显示时不处理
    if (!this.visible) return;

    // 仅处理左键
    if (evt.button !== 0) return;

    // [边界处理] 如果 dragging/rotating 仍为 true，说明上一次 mouseup 丢失
    // （如鼠标移出浏览器窗口），先结束上一次操作，避免状态卡死
    if (this.dragging) {
      this._endDrag();
    }
    if (this.rotating) {
      this._endRotation();
    }

    try {
      const canvas = viewport.canvas;
      if (!canvas) return;

      // 获取鼠标在 canvas 中的坐标
      const rect = canvas.getBoundingClientRect();
      const canvasPoint: [number, number] = [
        evt.clientX - rect.left,
        evt.clientY - rect.top,
      ];

      // [第三阶段] 判断是否点中十字线中心
      if (this.worldPosition) {
        try {
          const crosshairCanvas = viewport.worldToCanvas(this.worldPosition);
          if (crosshairCanvas &&
            Number.isFinite(crosshairCanvas[0]) &&
            Number.isFinite(crosshairCanvas[1])) {
            const dx = canvasPoint[0] - crosshairCanvas[0];
            const dy = canvasPoint[1] - crosshairCanvas[1];
            const distance = Math.sqrt(dx * dx + dy * dy);

            if (distance <= DRAG_HIT_THRESHOLD) {
              // 命中十字线中心 → 进入拖动模式
              this._startDrag(viewportId, evt);
              return;
            }

            // [第四阶段] 检查是否点中十字线线段 → 进入旋转模式
            // MIP viewport 不支持旋转
            if (!this._isMipViewport(viewportId)) {
              const isOnLine = this._isPointOnCrosshairLine(
                canvasPoint,
                crosshairCanvas
              );
              if (isOnLine) {
                this._startRotation(viewportId, canvasPoint, crosshairCanvas);
                return;
              }
            }
          }
        } catch (e) {
          // worldToCanvas 失败时退化为点击定位
        }
      }

      // 未命中十字线中心 → Phase 2 点击定位
      const worldPoint = viewport.canvasToWorld(canvasPoint);
      if (!worldPoint ||
        !Number.isFinite(worldPoint[0]) ||
        !Number.isFinite(worldPoint[1]) ||
        !Number.isFinite(worldPoint[2])) {
        return;
      }

      this.setPosition(worldPoint);
    } catch (e) {
      console.warn(`[TMTVCrosshairService] handleMouseDown 失败 (${viewportId})`, e);
    }
  }

  /**
   * [2026-08-05 第三阶段新增] 开始拖动
   *
   * 功能：设置拖动状态，在 document 上注册 mousemove/mouseup 监听
   *
   * 设计要点：
   *   - mousemove/mouseup 监听在 document 而非 element 上，
   *     确保鼠标移出 viewport 后拖动仍能继续
   *   - evt.preventDefault() 阻止默认行为（文本选中等）
   *   - 处理器引用保存在实例字段，供 _endDrag 移除
   */
  private _startDrag(viewportId: string, evt: MouseEvent): void {
    this.dragging = true;
    this.activeViewport = viewportId;

    // 阻止默认行为，防止拖动时选中文本或触发其他浏览器行为
    try {
      evt.preventDefault();
    } catch (e) {
      // ignore
    }

    // 在 document 上注册 mousemove/mouseup，确保拖动跟踪不中断
    this.documentMouseMoveHandler = (moveEvt: MouseEvent) => {
      this._handleDragMove(moveEvt);
    };
    this.documentMouseUpHandler = (upEvt: MouseEvent) => {
      this._handleDragEnd(upEvt);
    };

    document.addEventListener('mousemove', this.documentMouseMoveHandler);
    document.addEventListener('mouseup', this.documentMouseUpHandler);
  }

  /**
   * [2026-08-05 第三阶段新增] 处理拖动中的鼠标移动
   *
   * 功能：将鼠标 canvas 坐标转为世界坐标，更新十字线位置
   *
   * 边界条件处理：
   *   - 非拖动状态或无 activeViewport 时跳过
   *   - viewport 已被销毁时结束拖动
   *   - canvas 为空时跳过
   *   - 世界坐标非有限数时跳过（不更新位置）
   *   - 异常时打印警告日志
   */
  private _handleDragMove(evt: MouseEvent): void {
    if (!this.dragging || !this.activeViewport) return;

    const viewport = this.viewports.get(this.activeViewport);
    if (!viewport) {
      // activeViewport 已被销毁，结束拖动
      this._endDrag();
      return;
    }

    try {
      const canvas = viewport.canvas;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const canvasPoint: [number, number] = [
        evt.clientX - rect.left,
        evt.clientY - rect.top,
      ];

      // canvas 坐标转世界坐标
      const worldPoint = viewport.canvasToWorld(canvasPoint);
      if (!worldPoint ||
        !Number.isFinite(worldPoint[0]) ||
        !Number.isFinite(worldPoint[1]) ||
        !Number.isFinite(worldPoint[2])) {
        return;
      }

      // 更新全局位置并重绘所有 viewport
      this.setPosition(worldPoint);
    } catch (e) {
      console.warn(`[TMTVCrosshairService] _handleDragMove 失败 (${this.activeViewport})`, e);
    }
  }

  /**
   * [2026-08-05 第三阶段新增] 处理拖动结束（mouseup）
   *
   * 功能：重置拖动状态，移除 document 上的 mousemove/mouseup 监听
   */
  private _handleDragEnd(_evt: MouseEvent): void {
    this._endDrag();
  }

  /**
   * [2026-08-05 第三阶段新增] 结束拖动，清理 document 监听
   *
   * 功能：重置 dragging/activeViewport，移除 document 事件监听
   *
   * 调用场景：
   *   1. 正常 mouseup 结束拖动
   *   2. activeViewport 被销毁时中断拖动
   *   3. clear()/reset() 清理时
   *   4. _removeSvgLayer 移除 active viewport 时
   *
   * 内存安全：
   *   - 移除 document 监听后立即置 null，释放闭包引用
   *   - 即使多次调用也安全（检查 null）
   */
  private _endDrag(): void {
    this.dragging = false;
    this.activeViewport = null;

    if (this.documentMouseMoveHandler) {
      document.removeEventListener('mousemove', this.documentMouseMoveHandler);
      this.documentMouseMoveHandler = null;
    }
    if (this.documentMouseUpHandler) {
      document.removeEventListener('mouseup', this.documentMouseUpHandler);
      this.documentMouseUpHandler = null;
    }
  }

  // ============ [2026-08-05 第四阶段 Phase 4.2] 旋转交互 ============

  /**
   * [2026-08-05 第四阶段] 判断鼠标是否在十字线线段上（用于旋转命中检测）
   *
   * 计算鼠标到两条十字线的距离，任一距离 ≤ ROTATION_LINE_HIT_THRESHOLD 即命中
   * 排除中心空白区域（CROSSHAIR_CENTER_GAP 内），该区域由拖动处理
   *
   * 距离公式（点到直线）：对于过中心 C、方向 d 的直线，距离 = |(P-C) × d|
   */
  private _isPointOnCrosshairLine(
    canvasPoint: [number, number],
    crosshairCenter: [number, number]
  ): boolean {
    const px = canvasPoint[0] - crosshairCenter[0];
    const py = canvasPoint[1] - crosshairCenter[1];

    // 排除中心空白区域
    const distToCenter = Math.sqrt(px * px + py * py);
    if (distToCenter < CROSSHAIR_CENTER_GAP) return false;

    const angleRad = (this.rotationAngle * Math.PI) / 180;
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);

    // 线段1方向 d1 = (cos, sin)，距离 = |px*sin - py*cos|
    const dist1 = Math.abs(px * sin - py * cos);
    // 线段2方向 d2 = (-sin, cos)，距离 = |px*cos + py*sin|
    const dist2 = Math.abs(px * cos + py * sin);

    return (
      dist1 <= ROTATION_LINE_HIT_THRESHOLD ||
      dist2 <= ROTATION_LINE_HIT_THRESHOLD
    );
  }

  /**
   * [2026-08-05 第四阶段] 开始旋转
   *
   * 功能：记录起始角度，在 document 上注册 mousemove/mouseup 监听
   * 与拖动共用 documentMouseMoveHandler/documentMouseUpHandler（互斥）
   */
  private _startRotation(
    viewportId: string,
    canvasPoint: [number, number],
    crosshairCenter: [number, number]
  ): void {
    this.rotating = true;
    this.rotationActiveViewport = viewportId;

    // [2026-08-05] 旋转开始时手柄变为实心圆
    this._setHandlesSolid(viewportId, true);

    // 记录鼠标相对十字线中心的角度作为起始角度
    this.rotationStartAngle = Math.atan2(
      canvasPoint[1] - crosshairCenter[1],
      canvasPoint[0] - crosshairCenter[0]
    );

    // 在 document 上注册 mousemove/mouseup（与拖动共用 handler 字段）
    this.documentMouseMoveHandler = (moveEvt: MouseEvent) => {
      this._handleRotateMove(moveEvt);
    };
    this.documentMouseUpHandler = (upEvt: MouseEvent) => {
      this._handleRotateEnd(upEvt);
    };

    document.addEventListener('mousemove', this.documentMouseMoveHandler);
    document.addEventListener('mouseup', this.documentMouseUpHandler);
  }

  /**
   * [2026-08-05 第四阶段] 处理旋转中的鼠标移动
   *
   * 功能：计算鼠标角度变化量 delta，调用 rotateCrosshair 旋转十字线
   *
   * 角度计算：
   *   currentAngle = atan2(mouse.y - center.y, mouse.x - center.x)
   *   delta = currentAngle - startAngle（处理 ±π 跳变）
   *   rotateCrosshair(delta * 180/π)
   *   startAngle = currentAngle（为下次移动准备）
   */
  private _handleRotateMove(evt: MouseEvent): void {
    if (!this.rotating || !this.rotationActiveViewport) return;

    const viewport = this.viewports.get(this.rotationActiveViewport);
    if (!viewport || !this.worldPosition) {
      this._endRotation();
      return;
    }

    try {
      const canvas = viewport.canvas;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const mx = evt.clientX - rect.left;
      const my = evt.clientY - rect.top;

      const center = viewport.worldToCanvas(this.worldPosition);
      if (!center || !Number.isFinite(center[0]) || !Number.isFinite(center[1])) {
        return;
      }

      const currentAngle = Math.atan2(my - center[1], mx - center[0]);
      let delta = currentAngle - this.rotationStartAngle;

      // 处理角度跳变（如从 -π 到 π）
      if (delta > Math.PI) delta -= 2 * Math.PI;
      if (delta < -Math.PI) delta += 2 * Math.PI;

      // 转为度数并旋转
      const deltaDegrees = (delta * 180) / Math.PI;
      this.rotateCrosshair(deltaDegrees);

      // 更新起始角度
      this.rotationStartAngle = currentAngle;
    } catch (e) {
      // viewport 可能已销毁
      this._endRotation();
    }
  }

  /**
   * [2026-08-05 第四阶段] 处理旋转结束（mouseup）
   */
  private _handleRotateEnd(_evt: MouseEvent): void {
    this._endRotation();
  }

  /**
   * [2026-08-05 第四阶段] 结束旋转，清理 document 监听
   *
   * 调用场景：
   *   1. 正常 mouseup 结束旋转
   *   2. activeViewport 被销毁时中断旋转
   *   3. clear()/reset() 清理时
   *   4. handleMouseDown 卡死恢复
   */
  private _endRotation(): void {
    // [2026-08-05] 旋转结束时手柄恢复空心圆
    if (this.rotationActiveViewport) {
      this._setHandlesSolid(this.rotationActiveViewport, false);
    }

    this.rotating = false;
    this.rotationActiveViewport = null;
    this.rotationStartAngle = 0;

    // 移除 document 监听（与拖动共用 handler 字段，null 检查确保安全）
    if (this.documentMouseMoveHandler) {
      document.removeEventListener('mousemove', this.documentMouseMoveHandler);
      this.documentMouseMoveHandler = null;
    }
    if (this.documentMouseUpHandler) {
      document.removeEventListener('mouseup', this.documentMouseUpHandler);
      this.documentMouseUpHandler = null;
    }
  }

  /**
   * [2026-08-05 第四阶段] 设置手柄样式：空心圆 / 实心圆
   *
   * @param viewportId - viewport ID
   * @param solid - true=实心圆（旋转中），false=空心圆（默认）
   */
  private _setHandlesSolid(viewportId: string, solid: boolean): void {
    const handleArr = this.handles.get(viewportId);
    if (!handleArr) return;
    const fill = solid ? CROSSHAIR_COLOR : 'none';
    handleArr.forEach(h => {
      try {
        h.setAttribute('fill', fill);
      } catch (e) {
        // ignore
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

    // [Lessons Learned] 一次性创建线段元素，后续重绘仅更新 x1/y1/x2/y2 属性，
    // 避免每次 render 频繁创建/销毁 DOM 节点。
    // [2026-08-05] 十字线中心空心，每条线拆成两段，共4段
    const createLine = (): SVGLineElement => {
      const line = document.createElementNS(SVG_NS, 'line') as SVGLineElement;
      line.setAttribute('stroke', CROSSHAIR_COLOR);
      line.setAttribute('stroke-width', String(CROSSHAIR_LINE_WIDTH));
      svg.appendChild(line);
      return line;
    };
    this.hLineLefts.set(viewportId, createLine());
    this.hLineRights.set(viewportId, createLine());
    this.vLineTops.set(viewportId, createLine());
    this.vLineBottoms.set(viewportId, createLine());

    // [2026-08-05 第四阶段] 创建旋转手柄（4个圆点，位于线段上距中心 HANDLE_DISTANCE 处）
    // 仅非 MIP viewport 显示（MIP 不支持旋转）
    // [2026-08-05] 默认空心圆，旋转时变为实心圆（与原系统 CrosshairsTool 一致）
    const createHandle = (): SVGCircleElement => {
      const circle = document.createElementNS(SVG_NS, 'circle') as SVGCircleElement;
      circle.setAttribute('r', String(HANDLE_RADIUS));
      circle.setAttribute('fill', 'none'); // 空心
      circle.setAttribute('stroke', CROSSHAIR_COLOR); // 绿色边框
      circle.setAttribute('stroke-width', '1.5');
      circle.style.display = 'none'; // 默认隐藏，在 _drawCrosshair 中根据 viewport 类型显示
      svg.appendChild(circle);
      return circle;
    };
    this.handles.set(viewportId, [
      createHandle(), // 线段1 正方向端
      createHandle(), // 线段1 负方向端
      createHandle(), // 线段2 正方向端
      createHandle(), // 线段2 负方向端
    ]);

    // 监听 canvas 尺寸变化，重绘十字线
    const resizeObserver = new ResizeObserver(() => {
      this.render();
    });
    resizeObserver.observe(element);
    this.resizeObservers.set(viewportId, resizeObserver);

    // [2026-08-05] 监听相机变化 + 图像渲染完成，重绘十字线
    // - CAMERA_MODIFIED: 滚轮切片变化、缩放、平移时触发
    // - IMAGE_RENDERED: 任何渲染完成后触发（volume 加载、方向切换重建等边缘场景的补充保障）
    // 两个事件共用同一个 handler，render() 是幂等的，重复调用无副作用
    try {
      const handler = () => {
        this.render();
      };
      element.addEventListener(CAMERA_MODIFIED_EVENT, handler);
      element.addEventListener(IMAGE_RENDERED_EVENT, handler);
      this.renderEventHandlers.set(viewportId, handler);
    } catch (e) {
      // 如果无法监听事件，十字线仍可显示，只是不会跟随相机/渲染变化
      console.debug(`[TMTVCrosshairService] 无法监听渲染事件 (${viewportId})`, e);
    }

    // [2026-08-05 新增] 注册 mousedown 事件，实现点击定位
    // 点击任意 viewport 时，十字线同步移动到点击位置对应的世界坐标
    // 使用 this.viewports.get(viewportId) 获取当前 viewport 实例，
    // 而非闭包捕获的 viewport 参数，防止 viewport 被替换后使用过期引用
    try {
      const mouseDownHandler = (evt: MouseEvent) => {
        const vp = this.viewports.get(viewportId);
        if (vp) {
          this.handleMouseDown(viewportId, vp, evt);
        }
      };
      element.addEventListener('mousedown', mouseDownHandler);
      this.mouseDownHandlers.set(viewportId, mouseDownHandler);
    } catch (e) {
      console.debug(`[TMTVCrosshairService] 无法注册 mousedown 事件 (${viewportId})`, e);
    }
  }

  /**
   * 移除 SVG overlay 层和相关监听
   */
  private _removeSvgLayer(viewportId: string): void {
    // [Lessons Learned] 每个清理步骤独立 try-catch，避免单步异常中断后续清理。
    // 清理顺序：结束拖动/旋转(若active) → ResizeObserver → CAMERA_MODIFIED 监听 → mousedown 监听 → SVG 元素 → Map 引用

    // 0. [第三阶段] 如果正在拖动此 viewport，先结束拖动
    //    防止 document 上的 mousemove/mouseup 回调访问已销毁的 viewport
    if (this.dragging && this.activeViewport === viewportId) {
      this._endDrag();
    }
    // [第四阶段] 如果正在旋转此 viewport，先结束旋转
    if (this.rotating && this.rotationActiveViewport === viewportId) {
      this._endRotation();
    }

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

    // 2. 移除 CAMERA_MODIFIED + IMAGE_RENDERED 监听
    //    [Lessons Learned] 必须使用创建时的 element 引用（this.elements），
    //    而非当前 viewport.element。Cornerstone 可能在后续替换 viewport.element，
    //    用新引用调用 removeEventListener 会失败，导致旧监听器残留引发内存泄漏。
    //    两个事件共用同一个 handler，需分别 removeEventListener
    try {
      const handler = this.renderEventHandlers.get(viewportId);
      const element = this.elements.get(viewportId);
      if (handler && element) {
        element.removeEventListener(CAMERA_MODIFIED_EVENT, handler);
        element.removeEventListener(IMAGE_RENDERED_EVENT, handler);
      }
      this.renderEventHandlers.delete(viewportId);
    } catch (e) {
      // ignore
    }

    // 3. [2026-08-05 新增] 移除 mousedown 监听
    //    同样使用 this.elements 中的创建时引用，与 CAMERA_MODIFIED 清理保持一致
    try {
      const handler = this.mouseDownHandlers.get(viewportId);
      const element = this.elements.get(viewportId);
      if (handler && element) {
        element.removeEventListener('mousedown', handler);
      }
      this.mouseDownHandlers.delete(viewportId);
    } catch (e) {
      // ignore
    }

    // 4. 移除 SVG 元素（连同其中的横竖线子节点）
    try {
      const svg = this.svgLayers.get(viewportId);
      if (svg && svg.parentNode) {
        svg.parentNode.removeChild(svg);
      }
    } catch (e) {
      // ignore
    }

    // 5. 清理所有相关 Map 引用，防止内存泄漏
    this.svgLayers.delete(viewportId);
    this.elements.delete(viewportId);
    this.hLineLefts.delete(viewportId);
    this.hLineRights.delete(viewportId);
    this.vLineTops.delete(viewportId);
    this.vLineBottoms.delete(viewportId);
    this.handles.delete(viewportId);
  }

  /**
   * [2026-08-05 修改, 第四阶段更新] 在 SVG 上绘制十字线（4段，中心空心，支持旋转）
   *
   * 线段布局（中心留 CROSSHAIR_CENTER_GAP 间隙，方向随 rotationAngle 旋转）：
   *   旋转角度 θ 时，方向向量：
   *     d1 = (cos θ, sin θ)     — 第一条线方向
   *     d2 = (-sin θ, cos θ)    — 第二条线方向（垂直于 d1）
   *
   *   线段1左段: center - L*d1  →  center - gap*d1
   *   线段1右段: center + gap*d1 →  center + L*d1
   *   线段2上段: center - L*d2  →  center - gap*d2
   *   线段2下段: center + gap*d2 →  center + L*d2
   *
   *   其中 L = 半对角线长度，确保任意旋转角度下线段都能贯穿视口
   *
   * MIP viewport 不旋转（angle = 0），保持水平/垂直
   *
   * [Lessons Learned] 复用 _createSvgLayer 中一次性创建的线段元素，
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

    const cx = canvasPoint[0];
    const cy = canvasPoint[1];
    const gap = CROSSHAIR_CENTER_GAP;

    // 旋转角度：非 MIP viewport 使用累计旋转角度，MIP 保持 0
    const angleDeg = this._isMipViewport(viewportId) ? 0 : this.rotationAngle;
    const angleRad = (angleDeg * Math.PI) / 180;
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);

    // 半对角线长度：确保任意旋转角度下线段都能贯穿视口
    const L = Math.sqrt(width * width + height * height);

    // 方向向量
    // d1 = (cos, sin)  — 第一条线方向
    // d2 = (-sin, cos) — 第二条线方向（垂直于 d1）
    // 线段1 左段: center - L*d1 → center - gap*d1
    const hLeft = this.hLineLefts.get(viewportId);
    if (hLeft) {
      hLeft.setAttribute('x1', String(cx - L * cos));
      hLeft.setAttribute('y1', String(cy - L * sin));
      hLeft.setAttribute('x2', String(cx - gap * cos));
      hLeft.setAttribute('y2', String(cy - gap * sin));
    }

    // 线段1 右段: center + gap*d1 → center + L*d1
    const hRight = this.hLineRights.get(viewportId);
    if (hRight) {
      hRight.setAttribute('x1', String(cx + gap * cos));
      hRight.setAttribute('y1', String(cy + gap * sin));
      hRight.setAttribute('x2', String(cx + L * cos));
      hRight.setAttribute('y2', String(cy + L * sin));
    }

    // 线段2 上段: center - L*d2 → center - gap*d2
    // d2 = (-sin, cos)，所以 -L*d2 = (L*sin, -L*cos)
    const vTop = this.vLineTops.get(viewportId);
    if (vTop) {
      vTop.setAttribute('x1', String(cx + L * sin));
      vTop.setAttribute('y1', String(cy - L * cos));
      vTop.setAttribute('x2', String(cx + gap * sin));
      vTop.setAttribute('y2', String(cy - gap * cos));
    }

    // 线段2 下段: center + gap*d2 → center + L*d2
    // d2 = (-sin, cos)，所以 +L*d2 = (-L*sin, L*cos)
    const vBottom = this.vLineBottoms.get(viewportId);
    if (vBottom) {
      vBottom.setAttribute('x1', String(cx - gap * sin));
      vBottom.setAttribute('y1', String(cy + gap * cos));
      vBottom.setAttribute('x2', String(cx - L * sin));
      vBottom.setAttribute('y2', String(cy + L * cos));
    }

    // [2026-08-05 第四阶段] 定位旋转手柄（4个圆点）
    // 仅非 MIP viewport 显示手柄（MIP 不支持旋转）
    const handleArr = this.handles.get(viewportId);
    if (handleArr && handleArr.length === 4) {
      const showHandles = !this._isMipViewport(viewportId);
      const hd = HANDLE_DISTANCE;
      const display = showHandles ? '' : 'none';

      // 手柄0: 线段1 正方向端 (center + hd*d1)
      handleArr[0].setAttribute('cx', String(cx + hd * cos));
      handleArr[0].setAttribute('cy', String(cy + hd * sin));
      handleArr[0].style.display = display;

      // 手柄1: 线段1 负方向端 (center - hd*d1)
      handleArr[1].setAttribute('cx', String(cx - hd * cos));
      handleArr[1].setAttribute('cy', String(cy - hd * sin));
      handleArr[1].style.display = display;

      // 手柄2: 线段2 正方向端 (center + hd*d2 = center + hd*(-sin, cos))
      handleArr[2].setAttribute('cx', String(cx - hd * sin));
      handleArr[2].setAttribute('cy', String(cy + hd * cos));
      handleArr[2].style.display = display;

      // 手柄3: 线段2 负方向端 (center - hd*d2 = center + hd*(sin, -cos))
      handleArr[3].setAttribute('cx', String(cx + hd * sin));
      handleArr[3].setAttribute('cy', String(cy - hd * cos));
      handleArr[3].style.display = display;
    }
  }
}

// 导出单例实例
const tmtvCrosshairService = new TMTVCrosshairService();
export default tmtvCrosshairService;
export { TMTVCrosshairService };

// [2026-08-05 第四阶段测试] 暴露到 window 方便控制台调试
// 测试方法：
//   window.__tmtvCrosshairService.rotateCrosshair(15)  // 旋转 15°
//   window.__tmtvCrosshairService.rotateCrosshair(-15) // 反向旋转 15°
//   window.__tmtvCrosshairService.getRotationAngle()   // 查看当前角度
if (typeof window !== 'undefined') {
  (window as any).__tmtvCrosshairService = tmtvCrosshairService;
}
