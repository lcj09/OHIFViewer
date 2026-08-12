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

// [2026-08-07 Step1] 方向识别输出类型
type ViewportOrientation = 'AXIAL' | 'SAGITTAL' | 'CORONAL';

// [2026-08-07 Step1] 方向识别相关常量
// 标准正交平面的 viewPlaneNormal 参考向量（与 getClosestOrientationFromIOP 一致）
//   AXIAL    → (0, 0, 1)
//   CORONAL  → (0, 1, 0)
//   SAGITTAL → (1, 0, 0)
// 通过点积绝对值判断当前 viewport 方向与哪个标准平面最接近
const ORIENTATION_REFERENCE_VECTORS: Record<ViewportOrientation, [number, number, number]> = {
  AXIAL: [0, 0, 1],
  CORONAL: [0, 1, 0],
  SAGITTAL: [1, 0, 0],
};
// 方向对齐阈值：点积绝对值大于此值才认为是该方向。
// 旋转过程中可能出现非正交方向（reformat），此时返回 null 不误判。
// 0.95 ≈ cos(18.2°)，即偏离标准方向不超过 ~18° 仍识别为该方向
const ORIENTATION_ALIGNMENT_THRESHOLD = 0.95;

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

  // [2026-08-10 双切线旋转支持混合方位] 多 target camera 旋转状态
  // 行为：
  //   - 纯同方位布局（所有非 MIP 视口方位一致）→ 只转 SVG，不旋转 camera
  //   - 混合方位布局（部分视口被切换方位）→ 旋转所有与 source 方位不同的非 MIP target 的 camera
  //   - rotationAppliedAngle: 本次旋转已应用的累计角度（基于 initialCamera 旋转，避免浮点误差累积）
  private rotationSourceViewportId: string | null = null;
  private rotationTargetViewportIds: string[] = [];
  private rotationTargetInitialCameras = new Map<string, any>();
  private rotationAppliedAngle = 0;
  // [2026-08-10 修复同步器干扰] 双切线旋转期间被禁用的同步器
  private rotationDisabledSyncs: any[] = [];

  // [2026-08-06 第五阶段] 单切线旋转状态
  // 与双切线旋转（rotationAngle）独立，每根线可单独旋转
  private mode: 'normal' | 'singleLineRotate' = 'normal';
  private singleLineHorizontalAngle = 0; // 横线累计旋转角度（度，SVG 显示用）
  private singleLineVerticalAngle = 0;   // 竖线累计旋转角度（度，SVG 显示用）
  private singleLineRotating = false;
  private singleLineActiveLine: 'horizontal' | 'vertical' | null = null;
  private singleLineActiveViewport: string | null = null;
  // [2026-08-10 修复变形] 拖动起始状态：记录起始鼠标绝对角度和起始线条累计角度
  // 用于在 _handleSingleLineRotateMove 中计算增量角度（相对起始位置的偏移）
  // 原因：原系统 CrosshairsTool 用 vec2.angle(prevDir, currDir) 计算增量角度，
  //       而本实现此前误用 atan2 绝对角度作为旋转角度，导致鼠标位置变化时
  //       旋转角度跳变，target camera 被过度旋转，造成图像变形。
  private singleLineRotateStartMouseAngle = 0; // 拖动开始时鼠标相对中心的 atan2 角度（度）
  private singleLineRotateStartLineAngle = 0;  // 拖动开始时线条累计角度（度）

  // [2026-08-07 Step1] 方向识别缓存：viewportId -> 上次识别到的方向
  // 仅在方向发生变化时打印日志，避免 CAMERA_MODIFIED 高频触发导致日志刷屏
  private lastOrientationMap = new Map<string, ViewportOrientation | null>();

  // [2026-08-07 Step2] 当前布局 stage ID（由 CrosshairDisplayService 在 _update 时设置）
  // 用于判断当前是否为 2x3-layout（Axial 布局），决定是否启用 Step2 的 target 旋转
  private currentStageId: string | null = null;

  // [2026-08-10 修复同步器干扰] servicesManager 引用
  // 旋转期间需要临时禁用 cameraPosition 同步器，防止 setCamera 触发同步器
  // 把 target 的 camera（含方位）同步到同组其他视口（包括 source）。
  private servicesManager: any = null;

  /**
   * [2026-08-10 修复同步器干扰] 注入 servicesManager
   * 在 commandsModule 创建时调用（与 CrosshairDisplayService.init 同时机）
   */
  setServicesManager(servicesManager: any): void {
    this.servicesManager = servicesManager;
  }

  /**
   * [2026-08-10 修复同步器干扰] 临时禁用所有 cameraPosition 同步器
   *
   * 修改日期：2026-08-10
   * 功能说明：在旋转开始前调用，禁用当前布局所有 viewport 的 cameraPosition 同步器。
   *           防止旋转 target 的 setCamera 触发同步器，把 target 的 camera
   *           （含方位）同步到同组其他视口（包括 source 和同方位视口）。
   *           保存被禁用的同步器引用，供 _restoreSynchronizers 恢复。
   *
   * 返回：被禁用的同步器数组（传给 _restoreSynchronizers）
   */
  private _disableSynchronizers(): any[] {
    if (!this.servicesManager || !this.currentStageId) return [];

    try {
      const { syncGroupService } = this.servicesManager.services;
      if (!syncGroupService) return [];

      const disabledSyncs: any[] = [];
      const viewportIds = TMTV_VIEWPORT_IDS_BY_STAGE[this.currentStageId];
      if (!viewportIds) return [];

      const seen = new Set<any>(); // 去重（同一同步器可能被多个 viewport 共享）
      for (const vpId of viewportIds) {
        let syncs: any[] = [];
        try {
          syncs = syncGroupService.getSynchronizersForViewport(vpId) || [];
        } catch (e) {
          continue;
        }
        for (const s of syncs) {
          if (seen.has(s)) continue;
          let type = '';
          try {
            type = syncGroupService.getSynchronizerType(s) || '';
          } catch (e) {
            continue;
          }
          if (type.toLowerCase() === 'cameraposition') {
            seen.add(s);
            try {
              s.setEnabled(false);
              disabledSyncs.push(s);
            } catch (e) {
              // 忽略单个同步器禁用失败
            }
          }
        }
      }
      return disabledSyncs;
    } catch (e) {
      console.warn('[TMTVCrosshairService] _disableSynchronizers 失败', e);
      return [];
    }
  }

  /**
   * [2026-08-10 修复同步器干扰] 恢复被禁用的同步器
   *
   * 修改日期：2026-08-10
   * 功能说明：在旋转结束后调用，恢复 _disableSynchronizers 禁用的同步器。
   *           用 try-catch 保护，确保单个同步器恢复失败不影响其他。
   */
  private _restoreSynchronizers(disabledSyncs: any[]): void {
    if (!disabledSyncs || disabledSyncs.length === 0) return;
    for (const s of disabledSyncs) {
      try {
        s.setEnabled(true);
      } catch (e) {
        // 忽略单个同步器恢复失败
      }
    }
  }

  // [2026-08-07 Step2] 单切线旋转的 target viewport 状态
  // source = 用户操作的 viewport（即 singleLineActiveViewport）
  // targets = 同布局中所有匹配目标方位的非 source 非 MIP viewport
  // [2026-08-10 修复多 target] 从单 target 改为 Map 存储多 target
  // 原因：用户场景下可能存在多个同方位 viewport（如 AXIAL 布局中一个视口被切为矢状位，
  //       另两个仍是横断面），旋转时应同时旋转所有匹配方位的 target。
  private singleLineTargetViewportIds: string[] = [];
  // 各 target viewport 旋转前的初始 camera 状态（松手吸附失败时恢复用，防异常）
  private singleLineTargetInitialCameras = new Map<string, any>();
  // [Phase 2.1] 上次旋转角度（增量旋转用）
  private singleLineLastRotateAngle: number = 0;
  // [2026-08-10 修复同步器干扰] 单切线旋转期间被禁用的同步器
  private singleLineDisabledSyncs: any[] = [];

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
   * [2026-08-07 Step1] 从 viewport camera 识别方向（AXIAL / SAGITTAL / CORONAL）
   *
   * 修改日期：2026-08-07
   * 功能说明：根据 viewport 的 viewPlaneNormal 与三个标准正交平面的参考向量
   *           计算点积绝对值，取最大者作为方向。当最大点积低于阈值时返回 null
   *           （表示当前为 reformat 或旋转中的非正交方向，不属于三标准方位）。
   *
   * 输入：viewport（Cornerstone VolumeViewport 实例）
   * 输出：'AXIAL' | 'SAGITTAL' | 'CORONAL' | null
   *
   * 实现要点：
   *   - 参考向量与 getClosestOrientationFromIOP 保持一致
   *     AXIAL → (0,0,1), CORONAL → (0,1,0), SAGITTAL → (1,0,0)
   *   - 用绝对值：viewPlaneNormal 可能是反向（如 (0,0,-1) 仍是 AXIAL）
   *   - 阈值 ORIENTATION_ALIGNMENT_THRESHOLD = 0.95，偏离标准方向超过 ~18° 返回 null
   *
   * 边界条件：
   *   - viewport 为空或无 getCamera 方法 → 返回 null
   *   - camera.viewPlaneNormal 缺失或非有限数 → 返回 null
   *   - 零向量（理论上不会出现）→ 返回 null
   */
  private _getOrientationFromCamera(viewport: any): ViewportOrientation | null {
    if (!viewport || typeof viewport.getCamera !== 'function') {
      return null;
    }

    let camera: any;
    try {
      camera = viewport.getCamera();
    } catch (e) {
      return null;
    }

    const vpn = camera?.viewPlaneNormal;
    if (!vpn || !Number.isFinite(vpn[0]) || !Number.isFinite(vpn[1]) || !Number.isFinite(vpn[2])) {
      return null;
    }

    // 归一化 viewPlaneNormal（理论上 camera 的 normal 已归一化，但兜底处理）
    const len = Math.sqrt(vpn[0] * vpn[0] + vpn[1] * vpn[1] + vpn[2] * vpn[2]);
    if (len === 0) return null;
    const n = [vpn[0] / len, vpn[1] / len, vpn[2] / len];

    let maxDot = 0;
    let maxOrientation: ViewportOrientation | null = null;
    for (const key of Object.keys(ORIENTATION_REFERENCE_VECTORS) as ViewportOrientation[]) {
      const ref = ORIENTATION_REFERENCE_VECTORS[key];
      const dot = Math.abs(n[0] * ref[0] + n[1] * ref[1] + n[2] * ref[2]);
      if (dot > maxDot) {
        maxDot = dot;
        maxOrientation = key;
      }
    }

    // 低于阈值说明是非正交方向（reformat），不属于三标准方位
    if (maxDot < ORIENTATION_ALIGNMENT_THRESHOLD) {
      return null;
    }
    return maxOrientation;
  }

  /**
   * [2026-08-07 Step1] 获取指定 viewport 的当前方向（公开 API）
   *
   * 修改日期：2026-08-07
   * 功能说明：供外部（如 commandsModule / 工具栏 / 测试代码）查询 viewport 方向。
   *           内部调用 _getOrientationFromCamera，不触发日志。
   *
   * 参数：viewportId - 已注册的 viewport ID
   * 返回：'AXIAL' | 'SAGITTAL' | 'CORONAL' | null
   *       - viewport 未注册或方向无法识别时返回 null
   */
  getViewportOrientation(viewportId: string): ViewportOrientation | null {
    const viewport = this.viewports.get(viewportId);
    if (!viewport) return null;
    return this._getOrientationFromCamera(viewport);
  }

  /**
   * [2026-08-07 Step2] 设置当前布局 stage ID
   *
   * 修改日期：2026-08-07
   * 功能说明：由 CrosshairDisplayService 在 _update 时调用，通知当前布局类型。
   *           [2026-08-10 扩展] 所有 TMTV 布局（2x3/2x4/coronal-mip）均启用 target 旋转。
   *
   * 参数：stageId - 当前 hanging protocol stage ID
   */
  setStageId(stageId: string): void {
    this.currentStageId = stageId;
  }

  /**
   * [2026-08-07 Step2] 查找单切线旋转的 target viewport
   *
   * 修改日期：2026-08-07
   * 功能说明：在当前布局的 viewport 列表中，找到第一个非 source 且非 MIP 的 viewport
   *           作为 target。target 的 camera 将在旋转过程中被实时修改。
   *
   * 选择规则：
   *   1. 排除 source viewport（singleLineActiveViewport）
   *   2. 排除 MIP viewport（_isMipViewport）
   *   3. 排除未注册到本服务的 viewport（viewports Map 中不存在）
   *   4. 返回第一个满足条件的 viewport ID
   *
   * 参数：sourceViewportId - source viewport ID
   * 返回：target viewport ID，未找到时返回 null
   */
  /**
   * [Phase 2.1] 根据线类型计算目标方位
   *
   * 修改日期：2026-08-07
   * 功能说明：根据 source 方位和线类型，计算应该旋转的目标方位。
   *           用户需求：旋转哪根线就对应改变哪个方位的 target 切面。
   *
   * 映射规则（用户最新需求）：
   *   - AXIAL + 横线 → SAGITTAL
   *   - AXIAL + 竖线 → CORONAL
   *   - SAGITTAL + 横线 → AXIAL
   *   - SAGITTAL + 竖线 → CORONAL
   *   - CORONAL + 横线 → AXIAL
   *   - CORONAL + 竖线 → SAGITTAL
   *
   * 规律：横线 → source 的"上一个"方位（绕 Z→Y→X 循环）
   *       竖线 → source 的"下一个"方位
   *       （AXIAL=Z, SAGITTAL=X, CORONAL=Y，按 X→Y→Z 循环）
   *
   * @param sourceOrientation source 方位
   * @param lineType 线类型
   * @returns 目标方位，或 null（source 方位未知时不映射）
   */
  private _getTargetOrientation(
    sourceOrientation: ViewportOrientation | null,
    lineType: 'horizontal' | 'vertical'
  ): ViewportOrientation | null {
    if (!sourceOrientation) return null;

    // 按规律映射
    const horizontalMap: Record<ViewportOrientation, ViewportOrientation> = {
      AXIAL: 'SAGITTAL',
      SAGITTAL: 'AXIAL',
      CORONAL: 'AXIAL',
    };
    const verticalMap: Record<ViewportOrientation, ViewportOrientation> = {
      AXIAL: 'CORONAL',
      SAGITTAL: 'CORONAL',
      CORONAL: 'SAGITTAL',
    };

    return lineType === 'horizontal'
      ? horizontalMap[sourceOrientation]
      : verticalMap[sourceOrientation];
  }

  /**
   * [Phase 2.1] 查找指定方位的 target viewport
   *
   * 修改日期：2026-08-07
   * 功能说明：按线类型查找对应方位的 target viewport。
   *           - 横线 → 查找 SAGITTAL（或按映射规则的目标方位）
   *           - 竖线 → 查找 CORONAL（或按映射规则的目标方位）
   *           无对应方位 viewport 时返回空数组（仅旋转 SVG 线条）。
   *
   * [2026-08-10 修复多 target] 返回所有匹配方位的 target viewport（数组）。
   * 原因：用户场景下可能存在多个同方位 viewport（如 AXIAL 布局中一个视口被切为矢状位，
   *       另两个仍是横断面），旋转时应同时旋转所有匹配方位的 target。
   *
   * 方位识别 fallback（关键）：
   *   - 首选：实时 camera 方位识别
   *   - Fallback：lastOrientationMap 缓存的方位
   *   - 原因：单切线旋转松手后 target camera 处于 oblique 状态，实时识别返回 null，
   *     导致下次拖动找不到 target。用缓存的方位（旋转前的标准方位）作为 fallback，
   *     保证 oblique 状态下仍能找到原 target。
   *
   * @param sourceViewportId source viewport ID
   * @param sourceOrientation source 方位
   * @param lineType 线类型
   * @returns 所有匹配方位的 target viewport ID 数组（可能为空）
   */
  private _findTargetViewport(
    sourceViewportId: string,
    sourceOrientation: ViewportOrientation | null,
    lineType: 'horizontal' | 'vertical'
  ): string[] {
    if (!this.currentStageId) return [];
    const viewportIds = TMTV_VIEWPORT_IDS_BY_STAGE[this.currentStageId];
    if (!viewportIds) return [];

    // 计算目标方位
    const targetOrientation = this._getTargetOrientation(sourceOrientation, lineType);
    if (!targetOrientation) return [];

    // [2026-08-10 修复多 target] 查找所有匹配目标方位的 viewport（排除 source 和 MIP）
    // 原因：用户场景下可能存在多个同方位 viewport（如 AXIAL 布局中一个视口被切为矢状位，
    //       另两个仍是横断面），旋转时应同时旋转所有匹配方位的 target。
    // 方位识别：实时识别失败时用 lastOrientationMap 缓存作为 fallback
    const result: string[] = [];
    for (const vpId of viewportIds) {
      if (vpId === sourceViewportId) continue;
      if (this._isMipViewport(vpId)) continue;
      const vp = this.viewports.get(vpId);
      if (!vp) continue;
      const vpOrientation = this._getOrientationFromCamera(vp);
      // Fallback：实时识别为 null 时用缓存方位
      const effectiveOrientation =
        vpOrientation || this.lastOrientationMap.get(vpId) || null;
      if (effectiveOrientation === targetOrientation) {
        result.push(vpId);
      }
    }
    return result;
  }

  /**
   * [2026-08-07 Step1] 检测 viewport 方向变化并打印日志
   *
   * 修改日期：2026-08-07
   * 功能说明：比对 lastOrientationMap 中缓存的上次方向，仅在方向变化时打印日志。
   *           用于满足"医生任意切换方向：日志正确"的测试需求。
   *
   * 触发场景：
   *   - addViewport：初次注册时识别并记录方向
   *   - CAMERA_MODIFIED / IMAGE_RENDERED：医生通过 ViewportOrientationMenu 切换方向后触发
   *   - removeViewport：清理缓存
   *
   * 日志格式：[TMTVCrosshairService] 方向变化 viewportId=ctAXIAL AXIAL → SAGITTAL
   *          [TMTVCrosshairService] 方向识别 viewportId=ctAXIAL orientation=AXIAL（初次）
   *          [TMTVCrosshairService] 方向丢失 viewportId=ctAXIAL SAGITTAL → null（旋转中）
   *
   * 边界条件：
   *   - viewport 未注册或已销毁时跳过
   *   - 与缓存值相同时不打印（避免高频日志）
   *   - null 也作为有效状态参与比较（AXIAL → null → SAGITTAL 的中间过程会打印两次）
   */
  private _detectAndLogOrientationChange(viewportId: string): void {
    const viewport = this.viewports.get(viewportId);
    if (!viewport) return;

    const current = this._getOrientationFromCamera(viewport);
    const last = this.lastOrientationMap.get(viewportId);

    // 方向未变化（包括初次识别为 null 后再次 null 的情况）
    if (current === last) return;

    // 方向发生变化，打印日志（已注释）
    // if (last === undefined) {
    //   // 初次识别
    //   console.log(
    //     `[TMTVCrosshairService] 方向识别 viewportId=${viewportId} orientation=${current}`
    //   );
    // } else if (current === null) {
    //   // 从已知方向变为 null（可能是旋转中或 reformat）
    //   console.log(
    //     `[TMTVCrosshairService] 方向丢失 viewportId=${viewportId} ${last} → null`
    //   );
    // } else if (last === null) {
    //   // 从 null 变为已知方向（旋转结束）
    //   console.log(
    //     `[TMTVCrosshairService] 方向恢复 viewportId=${viewportId} null → ${current}`
    //   );
    // } else {
    //   // 从一个已知方向切换到另一个已知方向（医生切换方向）
    //   console.log(
    //     `[TMTVCrosshairService] 方向变化 viewportId=${viewportId} ${last} → ${current}`
    //   );
    // }

    // [Phase 2.1] 方向丢失（null）时不更新缓存，保留最后一次有效方位
    // 原因：单切线旋转松手后 target camera 处于 oblique 状态，实时识别返回 null，
    //       _findTargetViewport 需要用缓存的方位作为 fallback 才能找到原 target。
    //       如果 null 覆盖缓存，下次拖动就找不到 target 了。
    if (current !== null) {
      this.lastOrientationMap.set(viewportId, current);
    }
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

    // [2026-08-07 Step1] 初次注册时识别并记录方向，打印"方向识别"日志
    this._detectAndLogOrientationChange(viewportId);

    this.render();
  }

  /**
   * 移除 viewport，清理 SVG 层和事件监听
   *
   * [2026-08-07 Step1] 同时清理 lastOrientationMap 中的方向缓存，
   * 防止 Map 持有已销毁 viewport 的 ID 字符串导致内存泄漏（虽然字符串开销极小，但保持一致性）。
   */
  removeViewport(viewportId: string): void {
    this._removeSvgLayer(viewportId);
    this.viewports.delete(viewportId);
    this.lastOrientationMap.delete(viewportId);
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
    // [第四阶段] 结束双切线旋转
    this._endRotation();
    // [第五阶段] 结束单切线旋转
    this._endSingleLineRotation();

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
    // [2026-08-07 Step1] 清空方向识别缓存，布局切换后由 addViewport 重新识别
    this.lastOrientationMap.clear();
    // [第四阶段] 重置方向状态，布局切换后由 addViewport 重新初始化
    this.viewPlaneNormal = null;
    this.viewUp = null;
    this.rotationAngle = 0;
  }

  /**
   * 完全重置状态（包括 visible、worldPosition 和旋转状态）
   * 用于退出 TMTV 模式时清理，确保下次进入时为初始状态
   *
   * [2026-08-10 内存泄漏修复] 释放 servicesManager 引用，防止单例持有旧服务对象
   *   导致 HangingProtocolService、CornerstoneViewportService 等无法被 GC。
   *   下次进入 TMTV 模式时由 commandsModule 重新注入。
   */
  reset(): void {
    this.clear();
    this.worldPosition = null;
    this.visible = false;
    // [第五阶段] 重置单切线状态
    this.mode = 'normal';
    this.singleLineHorizontalAngle = 0;
    this.singleLineVerticalAngle = 0;
    // [2026-08-10 修复变形] 重置拖动起始状态
    this.singleLineRotateStartMouseAngle = 0;
    this.singleLineRotateStartLineAngle = 0;
    // [2026-08-10 内存泄漏修复] 释放 servicesManager 引用
    this.servicesManager = null;
  }

  /**
   * [2026-08-11 新增] 重置十字线/单切线旋转角度和位置
   *
   * 功能说明：重置所有旋转角度到初始状态（0度），重置十字线位置到 viewport 中心
   *           （camera focalPoint）。从第一个非 MIP viewport 的 camera 重新初始化
   *           viewPlaneNormal 和 viewUp，确保旋转功能可继续使用。
   *           不清除 viewport 注册、SVG 层、不改变 visible 状态，
   *           适合在"重置视图"按钮调用。
   *
   * 与 reset() 的区别：
   *   - reset()：完全重置 + 清理所有资源（退出 TMTV 模式时用）
   *   - resetRotationAngles()：重置旋转角度和位置（重置视图按钮用）
   *
   * 边界条件：
   *   - 可见性保持不变
   *   - servicesManager 引用保持不变
   */
  resetRotationAngles(): void {
    // 双切线旋转角度
    this.rotationAngle = 0;
    // 单切线旋转角度
    this.singleLineHorizontalAngle = 0;
    this.singleLineVerticalAngle = 0;
    this.singleLineRotateStartMouseAngle = 0;
    this.singleLineRotateStartLineAngle = 0;

    // 从第一个非MIP viewport的camera重新初始化方向状态和位置
    // 不能设为null，否则rotateCrosshair会因null检查失败而无法旋转
    // 同时重置worldPosition到viewports中心（camera focalPoint）
    for (const [viewportId, viewport] of this.viewports) {
      if (this._isMipViewport(viewportId)) continue;
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
        }
        if (camera?.focalPoint) {
          this.worldPosition = [
            camera.focalPoint[0],
            camera.focalPoint[1],
            camera.focalPoint[2],
          ];
        }
        break; // 只取第一个非MIP viewport
      } catch (e) {
        continue;
      }
    }

    // 更新 SVG 绘制
    this.render();
  }

  /**
   * 设置十字线可见性
   */
  setVisible(value: boolean): void {
    this.visible = value;
    this.render();
  }

  /**
   * [2026-08-06 第五阶段] 设置十字线模式
   * 'normal' → 双切线旋转（两根线一起旋转）
   * 'singleLineRotate' → 单切线旋转（每根线独立旋转）
   */
  setMode(mode: 'normal' | 'singleLineRotate'): void {
    this.mode = mode;
    // 切换到非单切线模式时重置单切线角度
    if (mode !== 'singleLineRotate') {
      this.singleLineHorizontalAngle = 0;
      this.singleLineVerticalAngle = 0;
    }
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
   * [2026-08-05 第四阶段 Phase 4.1] 旋转十字线（双切线旋转）
   *
   * 功能：将十字线旋转指定角度，CT/PET/Fusion 同步旋转，MIP 不参与
   *
   * 参数：
   *   deltaDegrees - 旋转角度增量（度），正数逆时针，负数顺时针
   *
   * 流程：
   *   1. 将 viewUp 绕 viewPlaneNormal 旋转 deltaDegrees（Rodrigues 公式）
   *   2. 累加 rotationAngle（用于 SVG 十字线方向绘制）
   *   3. [2026-08-10] 混合方位布局下旋转所有与 source 方位不同的 target 的 camera
   *   4. 重绘十字线（render 中根据 rotationAngle 旋转线段）
   *
   * 边界条件：
   *   - viewPlaneNormal/viewUp 未初始化时不执行
   *   - 异常时打印警告日志
   *
   * 设计说明：
   *   - 纯同方位布局（所有非 MIP 视口方位一致）→ 只转 SVG，不转 camera
   *     （_startRotation 中 rotationTargetViewportIds 为空）
   *   - 混合方位布局（部分视口被切换方位）→ 旋转所有与 source 方位不同的 target 的 camera
   *     （与原系统 CrosshairsTool 行为一致，旋转轴 = source.viewPlaneNormal）
   *   旋转方式：基于各 target 的 initialCamera 旋转累计角度，避免浮点误差累积
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

      // [2026-08-10 双切线旋转支持混合方位] 旋转所有 target 的 camera
      // rotationTargetViewportIds 非空 = 混合方位布局，需要旋转 camera
      // 为空 = 纯同方位布局，只转 SVG（保留原行为）
      if (
        this.rotationSourceViewportId &&
        this.rotationTargetViewportIds.length > 0 &&
        this.rotationTargetInitialCameras.size > 0 &&
        this.worldPosition
      ) {
        this.rotationAppliedAngle += deltaDegrees;
        const totalRad = (this.rotationAppliedAngle * Math.PI) / 180;
        const sourceViewport = this.viewports.get(this.rotationSourceViewportId);
        const worldPos: [number, number, number] = [
          this.worldPosition[0],
          this.worldPosition[1],
          this.worldPosition[2],
        ];

        if (sourceViewport) {
          const failedIds: string[] = [];
          for (const targetId of this.rotationTargetViewportIds) {
            const initialCam = this.rotationTargetInitialCameras.get(targetId);
            if (!initialCam) {
              failedIds.push(targetId);
              continue;
            }
            const targetViewport = this.viewports.get(targetId);
            if (!targetViewport || typeof targetViewport.setCamera !== 'function') {
              failedIds.push(targetId);
              continue;
            }
            // 复用单切线旋转的 Cornerstone 风格旋转（不传 viewPlaneNormal）
            this._applyCrosshairRotation(
              targetViewport,
              sourceViewport,
              worldPos,
              totalRad,
              initialCam
            );
          }
          // 清理已销毁的 target
          for (const fid of failedIds) {
            const idx = this.rotationTargetViewportIds.indexOf(fid);
            if (idx >= 0) this.rotationTargetViewportIds.splice(idx, 1);
            this.rotationTargetInitialCameras.delete(fid);
          }
        }
      }

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
   * [Phase 2.1] 绕点旋转一个向量
   *
   * 修改日期：2026-08-07
   * 功能说明：把向量 v 绕旋转轴 axis 旋转 angleRad 弧度，旋转中心为 center。
   *           公式：v' = R(v - center) + center
   *           用于旋转 camera 的 position/focalPoint（带旋转中心）。
   */
  private _rotateVectorAroundPoint(
    v: [number, number, number],
    axis: [number, number, number],
    angleRad: number,
    center: [number, number, number]
  ): [number, number, number] {
    // v - center
    const relative: [number, number, number] = [
      v[0] - center[0],
      v[1] - center[1],
      v[2] - center[2],
    ];
    // R(relative)
    const rotated = this._rotateVectorAroundAxis(relative, axis, angleRad);
    // R(relative) + center
    return [
      rotated[0] + center[0],
      rotated[1] + center[1],
      rotated[2] + center[2],
    ];
  }

  /**
   * [Phase 2.1] 应用 Cornerstone 风格的 Crosshair 旋转到 target viewport
   *
   * 修改日期：2026-08-07
   * 功能说明：复刻 Cornerstone CrosshairsTool.js L1041-L1070 的旋转逻辑。
   *           旋转轴 = source.viewPlaneNormal（source 视线方向，原系统方式）
   *           旋转中心 = worldPosition（十字线交点）
   *           同时旋转 target 的 position/focalPoint/viewPlaneNormal/viewUp 四个向量。
   *
   * 旋转轴选择：
   *   - 统一用 source.viewPlaneNormal（不区分横竖线）
   *   - 原因：与原系统行为一致。横竖线只是用户交互方式不同，
   *           旋转 target 的几何变换应该相同（绕 source 视线方向旋转）。
   *           target 该转到哪个方位由 target 自身初始方向决定，不由线类型决定。
   *
   * viewUp 处理（复刻原系统，避免退化）：
   *   - 原系统：viewUp += position → 旋转 → viewUp -= newPosition
   *     这样保证 viewUp 与新 position 保持正确关系，避免 viewUp 与 viewPlaneNormal 共线
   *
   * 输入：
   *   - targetViewport: 要旋转的 viewport
   *   - sourceViewport: 触发旋转的 viewport（用于取旋转轴）
   *   - worldPosition: 十字线交点世界坐标（旋转中心）
   *   - angleRad: 旋转角度（弧度）
   *   - baseCamera?: 旋转基准 camera（默认取 target 当前 camera）
   *
   * 输出：
   *   - 更新 target viewport 的 camera（position/focalPoint/viewPlaneNormal/viewUp）
   *   - 触发 target.render()
   *
   * 边界条件：
   *   - source/target camera 缺失字段：静默跳过
   *   - setCamera 异常：静默忽略
   */
  private _applyCrosshairRotation(
    targetViewport: any,
    sourceViewport: any,
    worldPosition: [number, number, number],
    angleRad: number,
    baseCamera?: any
  ): void {
    try {
      const sourceCamera = sourceViewport.getCamera();
      const targetCamera = baseCamera || targetViewport.getCamera();
      if (!sourceCamera?.viewPlaneNormal || !targetCamera) return;

      // 旋转轴 = source.viewPlaneNormal（Cornerstone 原版逻辑，不区分横竖线）
      const rotationAxis: [number, number, number] = [
        sourceCamera.viewPlaneNormal[0],
        sourceCamera.viewPlaneNormal[1],
        sourceCamera.viewPlaneNormal[2],
      ];
      // console.log(
      //   `[TMTVCrosshairService] _applyCrosshairRotation axis=[${rotationAxis.map(n => n.toFixed(2)).join(',')}] angleRad=${angleRad.toFixed(4)} (${(angleRad * 180 / Math.PI).toFixed(1)}°)`
      // );
      // console.log(
      //   `[TMTVCrosshairService] baseCamera.pos=[${targetCamera.position?.map((n: number) => n.toFixed(2)).join(',')}] fp=[${targetCamera.focalPoint?.map((n: number) => n.toFixed(2)).join(',')}] viewUp=[${targetCamera.viewUp?.map((n: number) => n.toFixed(2)).join(',')}]`
      // );

      const oldPosition = targetCamera.position;
      const oldFocalPoint = targetCamera.focalPoint;
      const oldViewUp = targetCamera.viewUp;
      const oldViewPlaneNormal = targetCamera.viewPlaneNormal;
      if (!oldPosition || !oldFocalPoint || !oldViewUp || !oldViewPlaneNormal) return;

      // 旋转中心 = worldPosition（十字线交点）
      const center: [number, number, number] = [
        worldPosition[0],
        worldPosition[1],
        worldPosition[2],
      ];

      // 旋转 position/focalPoint（世界点，带旋转中心）
      const newPosition = this._rotateVectorAroundPoint(
        [oldPosition[0], oldPosition[1], oldPosition[2]],
        rotationAxis,
        angleRad,
        center
      );
      const newFocalPoint = this._rotateVectorAroundPoint(
        [oldFocalPoint[0], oldFocalPoint[1], oldFocalPoint[2]],
        rotationAxis,
        angleRad,
        center
      );

      // viewUp 处理复刻原系统：先加 position 变世界点，旋转后减 newPosition
      // 保证 viewUp 与新 position 保持正确关系，避免 viewUp 与 viewPlaneNormal 共线退化
      const viewUpAsWorld: [number, number, number] = [
        oldViewUp[0] + oldPosition[0],
        oldViewUp[1] + oldPosition[1],
        oldViewUp[2] + oldPosition[2],
      ];
      const rotatedViewUpWorld = this._rotateVectorAroundPoint(
        viewUpAsWorld,
        rotationAxis,
        angleRad,
        center
      );
      const newViewUp: [number, number, number] = [
        rotatedViewUpWorld[0] - newPosition[0],
        rotatedViewUpWorld[1] - newPosition[1],
        rotatedViewUpWorld[2] - newPosition[2],
      ];

      // viewPlaneNormal 不传入 setCamera（与原系统一致）
      // 原因：viewPlaneNormal 应由 position-focalPoint 派生，显式传入可能与派生值冲突导致图像变形

      targetViewport.setCamera({
        position: newPosition,
        focalPoint: newFocalPoint,
        viewUp: newViewUp,
      });
      if (typeof targetViewport.render === 'function') {
        targetViewport.render();
      }
    } catch (e) {
      // setCamera 失败时静默忽略，SVG 线条仍旋转
    }
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
    if (this.singleLineRotating) {
      this._endSingleLineRotation();
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

            // [第四/五阶段] 检查是否点中十字线线段 → 进入旋转模式
            // MIP viewport 不支持旋转
            if (!this._isMipViewport(viewportId)) {
              if (this.mode === 'singleLineRotate') {
                // [第五阶段] 单切线模式：判断点击了哪根线，独立旋转
                const line = this._hitTestSingleLine(canvasPoint, crosshairCanvas);
                if (line) {
                  this._startSingleLineRotation(viewportId, crosshairCanvas, line, evt);
                  return;
                }
              } else {
                // [第四阶段] 双切线模式：点击任意线段都旋转两根线
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

    // [2026-08-10 双切线旋转支持混合方位] 初始化多 target camera 旋转状态
    // 规则：
    //   1. 识别 source 方位
    //   2. 遍历当前布局的所有 viewport
    //   3. 跳过 source 和 MIP
    //   4. 仅当 target 方位与 source 不同时，保存 initialCamera（旋转时转 camera）
    //      同方位的 target 不保存（只转 SVG，不转 camera）
    //   → 纯同方位布局：所有 target 都跳过 → 只转 SVG
    //   → 混合方位布局：与 source 不同方位的 target 保存 → 转 camera
    this.rotationSourceViewportId = viewportId;
    this.rotationTargetViewportIds = [];
    this.rotationTargetInitialCameras.clear();
    this.rotationAppliedAngle = 0;

    const sourceViewport = this.viewports.get(viewportId);
    const sourceOrientation = sourceViewport
      ? (this._getOrientationFromCamera(sourceViewport) ||
         this.lastOrientationMap.get(viewportId) || null)
      : null;

    if (sourceOrientation && this.currentStageId) {
      const viewportIds = TMTV_VIEWPORT_IDS_BY_STAGE[this.currentStageId];
      if (viewportIds) {
        for (const vpId of viewportIds) {
          if (vpId === viewportId) continue;          // 跳过 source
          if (this._isMipViewport(vpId)) continue;    // 跳过 MIP
          const vp = this.viewports.get(vpId);
          if (!vp) continue;
          const vpOrientation =
            this._getOrientationFromCamera(vp) ||
            this.lastOrientationMap.get(vpId) ||
            null;
          // 仅保存与 source 方位不同的 target
          if (vpOrientation && vpOrientation !== sourceOrientation) {
            try {
              const initialCam = vp.getCamera?.();
              if (initialCam) {
                this.rotationTargetViewportIds.push(vpId);
                this.rotationTargetInitialCameras.set(vpId, initialCam);
              }
            } catch (e) {
              // viewport 可能已销毁，跳过
            }
          }
        }
      }
    }

    // [2026-08-10 修复同步器干扰] 旋转开始前禁用 cameraPosition 同步器
    // 防止 target.setCamera 触发同步器把 target 的 camera（含方位）同步到 source 和同方位视口
    this.rotationDisabledSyncs = this._disableSynchronizers();

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

    // [2026-08-10 双切线旋转支持混合方位] 清理多 target 状态
    this.rotationSourceViewportId = null;
    this.rotationTargetViewportIds = [];
    this.rotationTargetInitialCameras.clear();
    this.rotationAppliedAngle = 0;

    // [2026-08-10 修复同步器干扰] 旋转结束后恢复同步器
    this._restoreSynchronizers(this.rotationDisabledSyncs);
    this.rotationDisabledSyncs = [];

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

  // ============ [2026-08-06 第五阶段] 单切线旋转 ============

  /**
   * [2026-08-06 第五阶段] 单切线模式：判断点击了哪根线
   *
   * 计算鼠标到横线和竖线的距离，返回较近且在阈值内的线
   * 排除中心空白区域（由拖动处理）
   *
   * 横线方向 d1 = (cos(hAngle), sin(hAngle))
   * 竖线方向 d2 = (-sin(vAngle), cos(vAngle))
   */
  private _hitTestSingleLine(
    canvasPoint: [number, number],
    crosshairCenter: [number, number]
  ): 'horizontal' | 'vertical' | null {
    const px = canvasPoint[0] - crosshairCenter[0];
    const py = canvasPoint[1] - crosshairCenter[1];

    // 排除中心空白区域
    if (Math.sqrt(px * px + py * py) < CROSSHAIR_CENTER_GAP) return null;

    // 横线距离：d1 = (cos(h), sin(h))，距离 = |px*sin(h) - py*cos(h)|
    const hRad = (this.singleLineHorizontalAngle * Math.PI) / 180;
    const distH = Math.abs(px * Math.sin(hRad) - py * Math.cos(hRad));

    // 竖线距离：d2 = (-sin(v), cos(v))，距离 = |px*cos(v) + py*sin(v)|
    const vRad = (this.singleLineVerticalAngle * Math.PI) / 180;
    const distV = Math.abs(px * Math.cos(vRad) + py * Math.sin(vRad));

    if (distH <= ROTATION_LINE_HIT_THRESHOLD && distH <= distV) return 'horizontal';
    if (distV <= ROTATION_LINE_HIT_THRESHOLD) return 'vertical';
    return null;
  }

  /**
   * [2026-08-06 第五阶段 / 2026-08-07 Step2-4 更新] 开始单切线旋转
   *
   * [Step2-4] 在 2x3-layout 中，任意方向的 source viewport 旋转时初始化 target：
   *   - source = viewportId（用户操作的 viewport，可为 AXIAL/SAGITTAL/CORONAL）
   *   - target = _findTargetViewport 找到的第一个非 source 非 MIP viewport
   *   - 保存 target 旋转前的初始 camera（松手吸附失败时恢复用）
   *   - 横线/竖线均启用 target 旋转
   *
   * 说明：旋转轴和吸附逻辑完全基于 source/target 的实际 camera 向量计算，
   *       不依赖 source 的具体方向，因此天然支持任意方向作为 source。
   *
   * 边界条件：
   *   - 非 2x3-layout 布局：不初始化 target，仅旋转 SVG 线条（保持原行为）
   *   - 2x3-layout 但找不到 target：不初始化 target，仅旋转 SVG 线条
   *   - target viewport 已销毁：getCamera 失败时不初始化 target
   *   - [Step5] source 为 MIP：不初始化 target，仅旋转 SVG 线条
   *     （MIP 不参与单切线旋转，但仍显示十字线和定位同步）
   *   - [同方位规则] source 和 target 同方向：不初始化 target，仅旋转 SVG 线条
   *     （同方位布局单切线旋转只是线在转，不应改变 target 切面）
   */
  private _startSingleLineRotation(
    viewportId: string,
    crosshairCenter: [number, number],
    line: 'horizontal' | 'vertical',
    evt: MouseEvent
  ): void {
    this.singleLineRotating = true;
    this.singleLineActiveViewport = viewportId;
    this.singleLineActiveLine = line;

    // 手柄变实心
    this._setHandlesSolid(viewportId, true);

    // [2026-08-10 修复变形] 记录拖动起始状态：
    //   - 起始鼠标绝对角度：用于在 mousemove 中计算增量角度
    //   - 起始线条累计角度：用于推算新的累计角度（起始 + 增量）
    // 原因：原系统 CrosshairsTool 用 vec2.angle(prevDir, currDir) 计算增量角度，
    //       本实现改为"起始基准 + 增量"模式，避免绝对角度跳变导致 target 过度旋转。
    try {
      const viewport = this.viewports.get(viewportId);
      if (viewport?.canvas) {
        const rect = viewport.canvas.getBoundingClientRect();
        const mx = evt.clientX - rect.left;
        const my = evt.clientY - rect.top;
        const startMouseAngleRad = Math.atan2(
          my - crosshairCenter[1],
          mx - crosshairCenter[0]
        );
        this.singleLineRotateStartMouseAngle =
          (startMouseAngleRad * 180) / Math.PI;
        this.singleLineRotateStartLineAngle =
          line === 'horizontal'
            ? this.singleLineHorizontalAngle
            : this.singleLineVerticalAngle;
      }
    } catch (e) {
      // 计算起始角度失败时使用 0 作为基准（退化为原行为）
      this.singleLineRotateStartMouseAngle = 0;
      this.singleLineRotateStartLineAngle = 0;
    }

    // [Phase 2.1] 初始化 target viewport（仅 2x3-layout）
    // - 横线旋转：source AXIAL → target SAGITTAL
    // - 竖线旋转：source AXIAL → target CORONAL
    this.singleLineTargetViewportIds = [];
    this.singleLineTargetInitialCameras.clear();
    // [Step5] MIP viewport 不参与单切线旋转（仍显示十字线和定位同步）
    // MIP 作为 source 时跳过 target 初始化，仅旋转 SVG 线条（不旋转 target camera）
    //
    // [Phase 2.1] target 选择按线类型查找对应方位：
    //   - 横线 → 查找 SAGITTAL（或按映射规则的目标方位）
    //   - 竖线 → 查找 CORONAL（或按映射规则的目标方位）
    //   - 无对应方位 target → 仅旋转 SVG 线条（不旋转 camera）
    //   原因：旋转哪根线就对应改变哪个方位的 target 切面。
    //         例如 source=AXIAL，PET 是 SAGITTAL，旋转横线时改 PET 切面；
    //         旋转竖线时如果没有 CORONAL viewport，就只有竖线在转，图像不变。
    //
    // [2026-08-10 修复多 target] 查找所有匹配方位的 target，逐一保存 initialCamera。
    //   场景：AXIAL 布局中一个视口被切为矢状位，另两个仍是横断面，
    //         旋转矢状位横线（SAGITTAL + 横线 → AXIAL）时应同时旋转两个 AXIAL target。
    //
    // [2026-08-10 扩展] 支持所有 TMTV 布局（2x3-layout / 2x4-layout / coronal-mip-layout）。
    //   矢状位/冠状位布局下同样支持多 target 旋转：若个别视口方位被切换，
    //   旋转时应同时影响所有匹配目标方位的 viewport。
    if (
      this.currentStageId &&
      TMTV_STAGE_IDS.has(this.currentStageId) &&
      !this._isMipViewport(viewportId)
    ) {
      const sourceViewport = this.viewports.get(viewportId);
      // source 方位识别：实时识别失败时用 lastOrientationMap 缓存作为 fallback
      const sourceOrientationRaw = sourceViewport
        ? this._getOrientationFromCamera(sourceViewport)
        : null;
      const sourceOrientation =
        sourceOrientationRaw || this.lastOrientationMap.get(viewportId) || null;
      const targetOrientation = this._getTargetOrientation(sourceOrientation, line);
      const targetIds = this._findTargetViewport(viewportId, sourceOrientation, line);
      //console.log(
        //`[TMTVCrosshairService] 单切线查找 target source=${viewportId}(${sourceOrientation}${sourceOrientationRaw ? '' : '[缓存]'}) line=${line} 期望target=${targetOrientation} 实际targets=[${targetIds.join(',') || '未找到'}]`
      //20260812);
      if (targetIds.length > 0) {
        // 逐一保存每个 target 的 initialCamera
        for (const tid of targetIds) {
          const tViewport = this.viewports.get(tid);
          if (tViewport && typeof tViewport.getCamera === 'function') {
            try {
              const initialCam = tViewport.getCamera();
              if (initialCam) {
                this.singleLineTargetViewportIds.push(tid);
                this.singleLineTargetInitialCameras.set(tid, initialCam);
              }
            } catch (e) {
              // target viewport 可能已销毁，静默跳过
            }
          }
        }
        this.singleLineLastRotateAngle = 0; // 初始化增量旋转基准
        // console.log(
        //   `[TMTVCrosshairService] 单切线旋转 source=${viewportId}(${sourceOrientation}) targets=[${this.singleLineTargetViewportIds.join(',')}] line=${line}`
        // );
      } else {
        // 无对应方位 target：仅旋转 SVG 线条
        // console.log(
        //   `[TMTVCrosshairService] 单切线旋转（仅SVG）source=${viewportId}(${sourceOrientation}) line=${line} 无对应方位 target`
        // );
      }
    }

    // [2026-08-10 修复同步器干扰] 单切线旋转开始前禁用 cameraPosition 同步器
    // 防止 target.setCamera 触发同步器把 target 的 camera（含方位）同步到 source 和同方位视口
    this.singleLineDisabledSyncs = this._disableSynchronizers();

    // 在 document 上注册 mousemove/mouseup
    this.documentMouseMoveHandler = (evt: MouseEvent) => {
      this._handleSingleLineRotateMove(evt, crosshairCenter);
    };
    this.documentMouseUpHandler = (evt: MouseEvent) => {
      this._handleSingleLineRotateEnd(evt);
    };

    document.addEventListener('mousemove', this.documentMouseMoveHandler);
    document.addEventListener('mouseup', this.documentMouseUpHandler);
  }

  /**
   * [2026-08-06 第五阶段 / 2026-08-07 Step2 更新] 处理单切线旋转中的鼠标移动
   *
   * 角度计算：
   *   angle = atan2(mouse.y - center.y, mouse.x - center.x)
   *   横线（默认水平 = 0°）：horizontalAngle = angle（度）
   *   竖线（默认垂直 = 90°）：verticalAngle = angle - 90°（度）
   *
   * [Step2 新增] 当 singleLineTargetViewportIds 非空时，实时旋转所有 target viewport 的 camera：
   *   - 旋转轴：source viewport 的 viewUp（AXIAL 布局下 = (0,1,0) 即 Y 轴）
   *   - 旋转角度：竖线的角度变化量（相对初始垂直位置的偏移）
   *   - 旋转对象：target 的 viewPlaneNormal 和 viewUp（绕同一轴旋转保持正交）
   *   - 保持 target 的 focalPoint 和 position 不变（只改方向，不改位置）
   *
   * 几何说明（AXIAL 布局，竖线旋转）：
   *   - source（AXIAL）：viewPlaneNormal=(0,0,1), viewUp=(0,1,0)
   *   - 竖线初始垂直（90°），对应 target 初始 AXIAL：viewPlaneNormal=(0,0,1)
   *   - 竖线旋转到 0°（变水平）：target viewPlaneNormal 绕 Y 轴旋转 90° → (1,0,0) = SAGITTAL
   *   - 竖线旋转到 180°（变水平反向）：target viewPlaneNormal 绕 Y 轴旋转 90° → (-1,0,0) = SAGITTAL
   *   - 竖线旋转到 90°（保持垂直）：target viewPlaneNormal 不变 = AXIAL
   *
   * 边界条件：
   *   - target viewport 已销毁：静默跳过 camera 旋转，SVG 线条仍旋转
   *   - setCamera 异常：静默跳过，不中断 SVG 旋转
   */
  private _handleSingleLineRotateMove(
    evt: MouseEvent,
    crosshairCenter: [number, number]
  ): void {
    if (!this.singleLineRotating || !this.singleLineActiveViewport) return;

    const viewport = this.viewports.get(this.singleLineActiveViewport);
    if (!viewport || !this.worldPosition) {
      this._endSingleLineRotation();
      return;
    }

    try {
      const canvas = viewport.canvas;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const mx = evt.clientX - rect.left;
      const my = evt.clientY - rect.top;

      // 使用当前的 worldToCanvas 结果（viewport 可能滚动/缩放）
      const center = viewport.worldToCanvas(this.worldPosition);
      if (!center || !Number.isFinite(center[0]) || !Number.isFinite(center[1])) {
        return;
      }

      // [2026-08-10 修复变形] 使用增量角度（相对拖动起始位置的偏移）
      // 原系统 CrosshairsTool 用 vec2.angle(prevDir, currDir) 计算增量角度，
      // 本实现用"当前鼠标角度 - 起始鼠标角度"得到增量，再叠加到起始线条累计角度上。
      // 这样无论鼠标在中心哪个方位，旋转量都等于鼠标扫过的角度，与原系统行为一致。
      const currentMouseAngleRad = Math.atan2(my - center[1], mx - center[0]);
      const currentMouseAngleDeg = (currentMouseAngleRad * 180) / Math.PI;

      // 增量角度 = 当前鼠标角度 - 起始鼠标角度
      // 注意：atan2 返回 [-180, 180]，跨过 ±180° 时会有跳变，需要归一化到 [-180, 180]
      let deltaAngle = currentMouseAngleDeg - this.singleLineRotateStartMouseAngle;
      while (deltaAngle > 180) deltaAngle -= 360;
      while (deltaAngle < -180) deltaAngle += 360;

      // 新累计角度 = 起始线条角度 + 增量角度（SVG 显示用）
      const newLineAngle = this.singleLineRotateStartLineAngle + deltaAngle;
      if (this.singleLineActiveLine === 'horizontal') {
        this.singleLineHorizontalAngle = newLineAngle;
      } else {
        this.singleLineVerticalAngle = newLineAngle;
      }

      // [Step2] 实时旋转 target viewport 的 camera
      if (
        this.singleLineTargetViewportIds.length > 0 &&
        this.singleLineTargetInitialCameras.size > 0
      ) {
        this._rotateTargetCamera();
      }

      this.render();
    } catch (e) {
      this._endSingleLineRotation();
    }
  }

  /**
   * [Phase 2.1] 实时旋转 target viewport 的 camera（Cornerstone 风格，增量旋转）
   *
   * 修改日期：2026-08-10
   * 功能说明：复刻 Cornerstone CrosshairsTool 旋转逻辑。
   *           旋转轴 = source.viewPlaneNormal（source 视线方向）
   *           旋转中心 = worldPosition（十字线交点）
   *           基于 initialCamera 旋转本次拖动的增量角度（相对起始线条角度的偏移）
   *
   * [2026-08-10 修复变形] 关键变更：
   *   此前误用累计角度作为旋转角度，但 initialCamera 是本次拖动起始时的 camera，
   *   导致拖动开始时 target 被瞬间旋转一个大的累计角度，position 远离 focalPoint，
   *   造成图像变形。现在改为：旋转角度 = 当前线条累计角度 - 起始线条累计角度。
   *
   * viewPlaneNormal 处理（关键修复）：
   *   - 原系统：不传 viewPlaneNormal 给 setCamera，由 position-focalPoint 派生
   *   - 本实现：同样不传 viewPlaneNormal，避免与 position-focalPoint 派生值冲突
   *   - 原因：传入 viewPlaneNormal 可能与 position-focalPoint 派生值不一致，导致图像变形
   *
   * 边界条件：
   *   - target viewport 已销毁：清理状态，跳过
   *   - worldPosition 缺失：跳过（无旋转中心）
   *   - source/target camera 缺失字段：跳过
   */
  private _rotateTargetCamera(): void {
    if (this.singleLineTargetViewportIds.length === 0) return;
    if (this.singleLineTargetInitialCameras.size === 0) return;

    const sourceViewport = this.viewports.get(this.singleLineActiveViewport!);
    if (!sourceViewport) return;

    // [Phase 2.1] 旋转中心 = worldPosition（十字线交点）
    if (!this.worldPosition) return;
    const worldPos: [number, number, number] = [
      this.worldPosition[0],
      this.worldPosition[1],
      this.worldPosition[2],
    ];

    // [2026-08-10 修复变形] 旋转角度 = 本次拖动的增量角度（相对起始线条角度的偏移）
    // 原因：initialCamera 是本次拖动起始时的 target camera，旋转角度必须对应同一起点。
    //       此前误用累计角度，导致拖动开始时 target 被瞬间旋转一个大的累计角度，
    //       position 远离 focalPoint，造成图像变形。
    //       增量角度 = 当前线条累计角度 - 起始线条累计角度
    const currentLineAngle =
      this.singleLineActiveLine === 'vertical'
        ? this.singleLineVerticalAngle
        : this.singleLineHorizontalAngle;
    const rotateDeg = currentLineAngle - this.singleLineRotateStartLineAngle;
    const rotateRad = (rotateDeg * Math.PI) / 180;

    // [2026-08-10 修复多 target] 遍历所有 target，逐一旋转
    // 每个 target 使用各自的 initialCamera 作为旋转基准，相同增量角度
    const failedTargetIds: string[] = [];
    for (const targetId of this.singleLineTargetViewportIds) {
      const initialCamera = this.singleLineTargetInitialCameras.get(targetId);
      if (!initialCamera) {
        failedTargetIds.push(targetId);
        continue;
      }

      const targetViewport = this.viewports.get(targetId);
      if (!targetViewport || typeof targetViewport.setCamera !== 'function') {
        // target 已销毁，标记清理
        failedTargetIds.push(targetId);
        continue;
      }

      // 调用 Cornerstone 风格旋转（基于 initialCamera 旋转增量角度，不传 viewPlaneNormal）
      const beforeCam = targetViewport.getCamera();
      // console.log(
      //   `[TMTVCrosshairService] 旋转前 target=${targetId} fp=[${beforeCam?.focalPoint?.map((n: number) => n.toFixed(2)).join(',')}] worldPos=[${worldPos.map(n => n.toFixed(2)).join(',')}] fp==world? ${beforeCam?.focalPoint?.[0] === worldPos[0] && beforeCam?.focalPoint?.[1] === worldPos[1] && beforeCam?.focalPoint?.[2] === worldPos[2]}`
      // );
      this._applyCrosshairRotation(
        targetViewport,
        sourceViewport,
        worldPos,
        rotateRad,
        initialCamera
      );
      const afterCam = targetViewport.getCamera();
      const newVpnDerived = [
        afterCam.position[0] - afterCam.focalPoint[0],
        afterCam.position[1] - afterCam.focalPoint[1],
        afterCam.position[2] - afterCam.focalPoint[2],
      ];
      const newVpnLen = Math.sqrt(newVpnDerived.reduce((s: number, v: number) => s + v * v, 0));
      // console.log(
      //   `[TMTVCrosshairService] 旋转后 target=${targetId} pos=[${afterCam?.position?.map((n: number) => n.toFixed(2)).join(',')}] fp=[${afterCam?.focalPoint?.map((n: number) => n.toFixed(2)).join(',')}] viewUp=[${afterCam?.viewUp?.map((n: number) => n.toFixed(2)).join(',')}] derivedVpn=[${newVpnDerived.map((n: number) => (n / newVpnLen).toFixed(2)).join(',')}]`
      // );
    }

    // 清理已销毁的 target
    if (failedTargetIds.length > 0) {
      for (const fid of failedTargetIds) {
        const idx = this.singleLineTargetViewportIds.indexOf(fid);
        if (idx >= 0) this.singleLineTargetViewportIds.splice(idx, 1);
        this.singleLineTargetInitialCameras.delete(fid);
      }
    }
  }

  /**
   * [2026-08-06 第五阶段 / 2026-08-07 Step2 更新] 处理单切线旋转结束
   *
   * [Step2 新增] 松手时对 target viewport 进行标准方向吸附：
   *   - 检测 target 当前 viewPlaneNormal 最接近哪个标准方向（AXIAL/SAGITTAL/CORONAL）
   *   - 将 target camera 的 viewPlaneNormal/viewUp 设置为该标准方向的精确值
   *   - 同时更新 SVG 竖线角度到对应的精确值（0/90/180/270 等）
   *   - 吸附失败时恢复 target 到旋转前初始状态
   *
   * 吸附后的 SVG 竖线角度计算：
   *   - target 吸附到 AXIAL：竖线应垂直 = 0°（相对初始垂直位置）
   *   - target 吸附到 SAGITTAL：竖线应水平 = ±90°
   *   - target 吸附到 CORONAL：理论上不会出现（AXIAL 布局竖线旋转不会产生 CORONAL）
   */
  private _handleSingleLineRotateEnd(_evt: MouseEvent): void {
    // [Phase 2.1] 松手不吸附，保持松手时的角度和 target camera 状态
    // 用户需求：线旋转到哪就停到哪，不回到原始状态
    // target camera 已在 _rotateTargetCamera 中实时更新，无需额外处理
    this._endSingleLineRotation();
  }

  /**
   * [2026-08-07 Step2-4] 将 target viewport 吸附到最近的标准方向
   *
   * 修改日期：2026-08-07
   * 功能说明：旋转结束后，检测 target 当前的 viewPlaneNormal 最接近哪个标准方向，
   *           将 target camera 设置为该方向的精确标准向量。
   *           同时更新 SVG 角度到对应的精确值。
   *           支持任意方向的 source（AXIAL/SAGITTAL/CORONAL）。
   *
   * 标准方向向量（与 _getOrientationFromCamera 一致）：
   *   AXIAL    → viewPlaneNormal=(0,0,1),  viewUp=(0,1,0)
   *   SAGITTAL → viewPlaneNormal=(1,0,0),  viewUp=(0,0,1)
   *   CORONAL  → viewPlaneNormal=(0,1,0),  viewUp=(0,0,1)
   *
   * SVG 角度映射（相对初始位置的偏移，用于更新 SVG 显示）：
   *   竖线：AXIAL=0°，SAGITTAL=±90°
   *   横线：AXIAL=0°，CORONAL=±90°
   *   其他方向（如 source=SAGITTAL 时旋转产生 AXIAL）：角度保持当前值，
   *   因为 SVG 角度仅用于显示旋转量，不影响 target 实际方向。
   *
   * 边界条件：
   *   - target viewport 已销毁：跳过
   *   - 无法识别方向（reformat）：恢复到旋转前初始状态
   *   - setCamera 异常：恢复到旋转前初始状态
   */
  private _snapTargetToStandardOrientation(): void {
    if (this.singleLineTargetViewportIds.length === 0) return;
    if (this.singleLineTargetInitialCameras.size === 0) return;

    // [2026-08-10 修复多 target] 遍历所有 target 逐一吸附
    for (const targetId of this.singleLineTargetViewportIds) {
      const initialCamera = this.singleLineTargetInitialCameras.get(targetId);
      if (!initialCamera) continue;

      const targetViewport = this.viewports.get(targetId);
      if (!targetViewport) {
        // target 已销毁，跳过
        continue;
      }

      try {
        // 识别 target 当前最接近的标准方向
        const orientation = this._getOrientationFromCamera(targetViewport);
        // console.log(
        //   `[TMTVCrosshairService] 松手吸附 target=${targetId} 当前方向=${orientation}`
        // );

        if (!orientation) {
          // 无法识别方向（reformat），恢复到旋转前初始状态
          this._restoreTargetCamera();
          return;
        }

        // 标准方向向量（每组提供正向和负向两个候选）
        // 注意：viewPlaneNormal 的正负决定观察方向，翻转会导致图像颠倒。
        //       因此吸附时必须选择与 target 当前 vpn 同向的那个候选，
        //       并相应调整 viewUp 以保持右手坐标系（viewUp 也可能需要翻转）。
        const standardVectors: Record<
          ViewportOrientation,
          { vpn: [number, number, number]; viewUp: [number, number, number] }
        > = {
          AXIAL: { vpn: [0, 0, 1], viewUp: [0, 1, 0] },
          SAGITTAL: { vpn: [1, 0, 0], viewUp: [0, 0, 1] },
          CORONAL: { vpn: [0, 1, 0], viewUp: [0, 0, 1] },
        };
        const std = standardVectors[orientation];

        // 读取 target 当前实际 vpn，选择同向的标准向量
        const currentCamera = targetViewport.getCamera();
        const currentVpn = currentCamera?.viewPlaneNormal;
        let finalViewUp: [number, number, number] = [std.viewUp[0], std.viewUp[1], std.viewUp[2]];
        if (currentVpn) {
          const dot =
            currentVpn[0] * std.vpn[0] +
            currentVpn[1] * std.vpn[1] +
            currentVpn[2] * std.vpn[2];
          if (dot < 0) {
            // 当前 vpn 与标准正向反向，翻转 viewUp 以保持图像方向
            finalViewUp = [-std.viewUp[0], -std.viewUp[1], -std.viewUp[2]];
          }
        }

        // [Phase 2.1] 应用标准方向到 target
        // 采用 Cornerstone 风格：基于 initialCamera 用标准角度（0/±90）重新旋转
        // 这样 position/focalPoint/viewPlaneNormal/viewUp 四个向量同步更新，与实时旋转一致
        //
        // 角度计算：target 当前方向相对初始方向的旋转量
        //   - 初始方向 = initialCamera 的方向（旋转前）
        //   - 当前方向 = 识别出的 orientation
        //   - 同方向 → 0°
        //   - 不同方向 → ±90°（取当前累计角度的符号）
        const initialOrientation = this._getOrientationFromCamera({
          getCamera: () => initialCamera,
        } as any);
        let snappedAngle = 0;
        if (orientation === initialOrientation) {
          snappedAngle = 0;
        } else {
          // 不同方向：吸附到 ±90°，符号取当前累计角度
          const currentAngle =
            this.singleLineActiveLine === 'vertical'
              ? this.singleLineVerticalAngle
              : this.singleLineHorizontalAngle;
          snappedAngle = currentAngle >= 0 ? 90 : -90;
        }
        if (this.singleLineActiveLine === 'vertical') {
          this.singleLineVerticalAngle = snappedAngle;
        } else {
          this.singleLineHorizontalAngle = snappedAngle;
        }

        // 用标准角度重新做 Cornerstone 风格旋转（基于 initialCamera）
        const sourceViewport = this.viewports.get(this.singleLineActiveViewport!);
        if (sourceViewport && this.worldPosition) {
          const worldPos: [number, number, number] = [
            this.worldPosition[0],
            this.worldPosition[1],
            this.worldPosition[2],
          ];
          this._applyCrosshairRotation(
            targetViewport,
            sourceViewport,
            worldPos,
            (snappedAngle * Math.PI) / 180,
            initialCamera
          );
        } else {
          // worldPosition 或 source 缺失，降级为只改方向（保持旧行为）
          targetViewport.setCamera({
            viewUp: finalViewUp,
            focalPoint: initialCamera.focalPoint,
            position: initialCamera.position,
          });
        }

        // console.log(
        //   `[TMTVCrosshairService] 吸附完成 target=${targetId} → ${orientation}, ${this.singleLineActiveLine}角度=${snappedAngle}°`
        // );
      } catch (e) {
        // 吸附失败，恢复到旋转前初始状态
        console.warn(`[TMTVCrosshairService] 吸附失败 target=${targetId}，恢复初始状态`, e);
        this._restoreTargetCamera();
        return;
      }
    }
  }

  /**
   * [2026-08-07 Step2] 恢复 target viewport 到旋转前初始状态
   *
   * 修改日期：2026-08-07
   * 功能说明：吸附失败或方向无法识别时，将 target camera 恢复到旋转前的初始值。
   *           同时重置 SVG 竖线角度为 0（垂直）。
   */
  private _restoreTargetCamera(): void {
    if (this.singleLineTargetViewportIds.length === 0) return;

    // [2026-08-10 修复多 target] 遍历所有 target 逐一恢复
    for (const targetId of this.singleLineTargetViewportIds) {
      const initialCamera = this.singleLineTargetInitialCameras.get(targetId);
      if (!initialCamera) continue;

      const targetViewport = this.viewports.get(targetId);
      if (!targetViewport) continue;

      try {
        targetViewport.setCamera({
          viewUp: initialCamera.viewUp,
          focalPoint: initialCamera.focalPoint,
          position: initialCamera.position,
        });
        // [Phase 2.1] 显式触发渲染
        if (typeof (targetViewport as any).render === 'function') {
          (targetViewport as any).render();
        }
      } catch (e) {
        // 恢复失败时静默忽略
      }
    }

    // [Step2/Step3] 按线类型重置 SVG 角度为 0（初始位置）
    if (this.singleLineActiveLine === 'vertical') {
      this.singleLineVerticalAngle = 0;
    } else if (this.singleLineActiveLine === 'horizontal') {
      this.singleLineHorizontalAngle = 0;
    }
  }

  /**
   * [2026-08-06 第五阶段 / 2026-08-07 Step2 更新] 结束单切线旋转，清理 document 监听
   *
   * [Step2 新增] 清理 target viewport 相关状态
   */
  private _endSingleLineRotation(): void {
    if (this.singleLineActiveViewport) {
      this._setHandlesSolid(this.singleLineActiveViewport, false);
    }

    this.singleLineRotating = false;
    this.singleLineActiveViewport = null;
    this.singleLineActiveLine = null;
    // [Step2] 清理 target 状态（多 target）
    this.singleLineTargetViewportIds = [];
    this.singleLineTargetInitialCameras.clear();
    // [2026-08-10 修复变形] 清理拖动起始状态
    this.singleLineRotateStartMouseAngle = 0;
    this.singleLineRotateStartLineAngle = 0;

    // [2026-08-10 修复同步器干扰] 单切线旋转结束后恢复同步器
    this._restoreSynchronizers(this.singleLineDisabledSyncs);
    this.singleLineDisabledSyncs = [];

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
    //
    // [2026-08-07 Step1] handler 中同时调用 _detectAndLogOrientationChange
    // 检测方向变化。该函数内部有 lastOrientationMap 缓存，方向不变时不打印日志，
    // 因此 CAMERA_MODIFIED 高频触发不会导致日志刷屏，性能开销可忽略（一次点积计算）。
    // 这样无论十字线是否可见（visible=false 时 render early return），
    // 方向变化都能被检测到，满足"医生任意切换方向：日志正确"的测试需求。
    try {
      const handler = () => {
        // [Step1] 先检测方向变化（不依赖 visible 状态）
        this._detectAndLogOrientationChange(viewportId);
        // [2026-08-11 修复] 滚轮切片切换时同步更新 worldPosition
        // 非 MIP viewport 滚轮切换切片时，focalPoint 沿该 viewport 的法向轴移动，
        // 需将该轴分量同步到 worldPosition，否则其他视口（含 MIP）的十字线不会跟随移动。
        // MIP viewport 的 CAMERA_MODIFIED 由 VolumeRotate 触发，不应更新 worldPosition。
        // 旋转/拖动期间 focalPoint 会因 setCamera 变化，但此时位置由交互逻辑控制，
        // 不能用 focalPoint 覆盖 worldPosition，否则会导致十字线和图像乱跑。
        if (
          this.visible &&
          !this._isMipViewport(viewportId) &&
          this.worldPosition &&
          !this.dragging &&
          !this.rotating &&
          !this.singleLineRotating
        ) {
          const vp = this.viewports.get(viewportId);
          if (vp && typeof vp.getCamera === 'function') {
            try {
              const camera = vp.getCamera();
              const fp = camera?.focalPoint;
              const vpn = camera?.viewPlaneNormal;
              if (fp && vpn && Number.isFinite(fp[0]) && Number.isFinite(fp[1]) && Number.isFinite(fp[2])) {
                // 找到最大分量的轴（即该 viewport 的法向轴），只更新该轴
                const ax = Math.abs(vpn[0]);
                const ay = Math.abs(vpn[1]);
                const az = Math.abs(vpn[2]);
                if (ax >= ay && ax >= az) {
                  this.worldPosition[0] = fp[0];
                } else if (ay >= az) {
                  this.worldPosition[1] = fp[1];
                } else {
                  this.worldPosition[2] = fp[2];
                }
              }
            } catch {
              // getCamera 失败时忽略，仅重绘
            }
          }
        }
        // 再重绘十字线
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
    // [第四阶段] 如果正在双切线旋转此 viewport，先结束旋转
    if (this.rotating && this.rotationActiveViewport === viewportId) {
      this._endRotation();
    }
    // [第五阶段] 如果正在单切线旋转此 viewport，先结束旋转
    if (this.singleLineRotating && this.singleLineActiveViewport === viewportId) {
      this._endSingleLineRotation();
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
   * [2026-08-05 修改, 第四/五阶段更新] 在 SVG 上绘制十字线（4段，中心空心，支持旋转）
   *
   * [第四阶段] 双切线模式：两根线一起旋转（rotationAngle）
   *   d1 = (cos θ, sin θ)     — 横线方向
   *   d2 = (-sin θ, cos θ)    — 竖线方向（垂直于 d1）
   *
   * [第五阶段] 单切线模式：两根线各自独立旋转
   *   d1 = (cos(hAngle), sin(hAngle))       — 横线方向
   *   d2 = (-sin(vAngle), cos(vAngle))      — 竖线方向（独立于横线）
   *
   * 线段布局（中心留 CROSSHAIR_CENTER_GAP 间隙）：
   *   线段1左段: center - L*d1  →  center - gap*d1
   *   线段1右段: center + gap*d1 →  center + L*d1
   *   线段2上段: center - L*d2  →  center - gap*d2
   *   线段2下段: center + gap*d2 →  center + L*d2
   *
   * MIP viewport 不旋转（angle = 0），保持水平/垂直
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

    // 方向向量计算
    // d1 = (d1Cos, d1Sin) — 横线方向
    // d2 = (-d2Sin, d2Cos) — 竖线方向
    const isMip = this._isMipViewport(viewportId);
    let d1Cos: number, d1Sin: number, d2Sin: number, d2Cos: number;

    if (this.mode === 'singleLineRotate' && !isMip) {
      // [第五阶段] 单切线模式：横线和竖线各自独立旋转
      const hRad = (this.singleLineHorizontalAngle * Math.PI) / 180;
      const vRad = (this.singleLineVerticalAngle * Math.PI) / 180;
      d1Cos = Math.cos(hRad); d1Sin = Math.sin(hRad);
      d2Sin = Math.sin(vRad); d2Cos = Math.cos(vRad);
    } else {
      // [第四阶段] 双切线模式或 MIP：两根线一起旋转（MIP 不旋转）
      const angleDeg = isMip ? 0 : this.rotationAngle;
      const angleRad = (angleDeg * Math.PI) / 180;
      d1Cos = Math.cos(angleRad); d1Sin = Math.sin(angleRad);
      d2Sin = Math.sin(angleRad); d2Cos = Math.cos(angleRad);
    }

    // 半对角线长度：确保任意旋转角度下线段都能贯穿视口
    const L = Math.sqrt(width * width + height * height);

    // 横线 左段: center - L*d1 → center - gap*d1
    const hLeft = this.hLineLefts.get(viewportId);
    if (hLeft) {
      hLeft.setAttribute('x1', String(cx - L * d1Cos));
      hLeft.setAttribute('y1', String(cy - L * d1Sin));
      hLeft.setAttribute('x2', String(cx - gap * d1Cos));
      hLeft.setAttribute('y2', String(cy - gap * d1Sin));
    }

    // 横线 右段: center + gap*d1 → center + L*d1
    const hRight = this.hLineRights.get(viewportId);
    if (hRight) {
      hRight.setAttribute('x1', String(cx + gap * d1Cos));
      hRight.setAttribute('y1', String(cy + gap * d1Sin));
      hRight.setAttribute('x2', String(cx + L * d1Cos));
      hRight.setAttribute('y2', String(cy + L * d1Sin));
    }

    // 竖线 上段: center - L*d2 → center - gap*d2
    // d2 = (-d2Sin, d2Cos)，所以 -L*d2 = (L*d2Sin, -L*d2Cos)
    const vTop = this.vLineTops.get(viewportId);
    if (vTop) {
      vTop.setAttribute('x1', String(cx + L * d2Sin));
      vTop.setAttribute('y1', String(cy - L * d2Cos));
      vTop.setAttribute('x2', String(cx + gap * d2Sin));
      vTop.setAttribute('y2', String(cy - gap * d2Cos));
    }

    // 竖线 下段: center + gap*d2 → center + L*d2
    // d2 = (-d2Sin, d2Cos)，所以 +L*d2 = (-L*d2Sin, L*d2Cos)
    const vBottom = this.vLineBottoms.get(viewportId);
    if (vBottom) {
      vBottom.setAttribute('x1', String(cx - gap * d2Sin));
      vBottom.setAttribute('y1', String(cy + gap * d2Cos));
      vBottom.setAttribute('x2', String(cx - L * d2Sin));
      vBottom.setAttribute('y2', String(cy + L * d2Cos));
    }

    // 定位旋转手柄（4个圆点）
    // 仅非 MIP viewport 显示手柄（MIP 不支持旋转）
    const handleArr = this.handles.get(viewportId);
    if (handleArr && handleArr.length === 4) {
      const showHandles = !isMip;
      const hd = HANDLE_DISTANCE;
      const display = showHandles ? '' : 'none';

      // 手柄0: 横线 正方向端 (center + hd*d1)
      handleArr[0].setAttribute('cx', String(cx + hd * d1Cos));
      handleArr[0].setAttribute('cy', String(cy + hd * d1Sin));
      handleArr[0].style.display = display;

      // 手柄1: 横线 负方向端 (center - hd*d1)
      handleArr[1].setAttribute('cx', String(cx - hd * d1Cos));
      handleArr[1].setAttribute('cy', String(cy - hd * d1Sin));
      handleArr[1].style.display = display;

      // 手柄2: 竖线 正方向端 (center + hd*d2 = center + hd*(-d2Sin, d2Cos))
      handleArr[2].setAttribute('cx', String(cx - hd * d2Sin));
      handleArr[2].setAttribute('cy', String(cy + hd * d2Cos));
      handleArr[2].style.display = display;

      // 手柄3: 竖线 负方向端 (center - hd*d2 = center + hd*(d2Sin, -d2Cos))
      handleArr[3].setAttribute('cx', String(cx + hd * d2Sin));
      handleArr[3].setAttribute('cy', String(cy - hd * d2Cos));
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
