// [2026-08-06 新增] 单切线旋转 - 第一阶段：统一十字线显示管理
//
// 功能：作为十字线显示的统一入口，根据布局类型路由到不同实现：
//   - TMTV 布局（AXIAL/Sagittal/Coronal）→ TMTVCrosshairService（SVG overlay）
//   - 旧 MPR 布局 → Cornerstone CrosshairsTool
//
// 架构：
//   SingleLine Button
//         |
//         ↓
//   CrosshairDisplayService
//         |
//         +-----------------+
//         |                 |
//         ↓                 ↓
//   Legacy Crosshairs   TMTV Crosshair
//   (Cornerstone)       (SVG Overlay)
//
// 状态：
//   interface CrosshairState {
//     visible: boolean;
//     mode: 'normal' | 'singleLineRotate';
//   }
//
// 使用方式：
//   crosshairDisplayService.init(servicesManager);  // 初始化（在 commandsModule 中调用）
//   crosshairDisplayService.enable('singleLineRotate');  // 启用单切线模式
//   crosshairDisplayService.disable();  // 禁用
//   crosshairDisplayService.isVisible();  // 查询可见性
//   crosshairDisplayService.getMode();  // 查询当前模式

import tmtvCrosshairService from './TMTVCrosshairService';

type CrosshairMode = 'normal' | 'singleLineRotate';

interface CrosshairState {
  visible: boolean;
  mode: CrosshairMode;
}

class CrosshairDisplayService {
  private state: CrosshairState = {
    visible: false,
    mode: 'normal',
  };

  private servicesManager: any = null;
  private initialized = false;

  // 旧布局的 ToolGroup ID 列表（与 initToolGroups 中一致）
  // SingleSliceLineTool 需要在所有4个 toolGroup 上激活
  private static LEGACY_TOOLGROUP_IDS = [
    'ctToolGroup',
    'ptToolGroup',
    'fusionToolGroup',
    'mipToolGroup',
  ];

  /**
   * [2026-08-06] 初始化服务，注入依赖
   * 在 commandsModule 创建时调用
   */
  init(servicesManager: any): void {
    this.servicesManager = servicesManager;
    this.initialized = true;
  }

  /**
   * [2026-08-06] 启用十字线显示，指定模式
   *
   * @param mode - 'normal' 普通十字线 | 'singleLineRotate' 单切线旋转模式
   */
  enable(mode: CrosshairMode = 'normal'): void {
    this.state.visible = true;
    this.state.mode = mode;
    // [2026-08-06] 同步模式到 TMTVCrosshairService，使其知道当前是单切线还是双切线模式
    tmtvCrosshairService.setMode(mode);
    this._update();
  }

  /**
   * [2026-08-06] 禁用十字线显示
   */
  disable(): void {
    this.state.visible = false;
    // [2026-08-06] 重置 TMTVCrosshairService 模式为 normal
    tmtvCrosshairService.setMode('normal');
    this._update();
  }

  /**
   * [2026-08-06] 切换十字线显示状态
   * 如果当前可见则隐藏，否则用指定模式显示
   * 使用 isVisible()（委托 tmtvCrosshairService）确保状态同步
   */
  toggle(mode: CrosshairMode = 'normal'): void {
    if (this.isVisible()) {
      this.disable();
    } else {
      this.enable(mode);
    }
  }

  /**
   * [2026-08-06] 查询十字线是否可见
   * 委托给 tmtvCrosshairService，确保与 Crosshairs 按钮状态同步
   */
  isVisible(): boolean {
    return tmtvCrosshairService.getVisible();
  }

  /**
   * [2026-08-06] 查询当前模式
   */
  getMode(): CrosshairMode {
    return this.state.mode;
  }

  /**
   * [2026-08-06] 查询是否为单切线旋转模式
   */
  isSingleLineMode(): boolean {
    return this.state.mode === 'singleLineRotate';
  }

  /**
   * [2026-08-06] 设置模式（不改变可见性）
   * 用于 toggleTMTVCrosshairs 设置 mode='normal'，使 SingleSliceLine 按钮失活
   */
  setMode(mode: CrosshairMode): void {
    this.state.mode = mode;
    // [2026-08-06] 同步模式到 TMTVCrosshairService
    tmtvCrosshairService.setMode(mode);
  }

  /**
   * [2026-08-06] 根据当前布局类型，路由到对应的十字线实现
   *
   * 路由逻辑：
   *   - TMTV 布局 → tmtvCrosshairService.setVisible()（SVG overlay）
   *   - 旧 MPR 布局 → toolGroup.setToolActive/setToolDisabled（Cornerstone CrosshairsTool）
   *
   * 边界条件：
   *   - servicesManager 未初始化时不执行
   *   - 单个 viewport/toolGroup 操作失败不影响其他
   *   - 异常时打印警告日志
   */
  private _update(): void {
    if (!this.initialized || !this.servicesManager) {
      console.warn('[CrosshairDisplayService] 服务未初始化，请先调用 init()');
      return;
    }

    const services = this.servicesManager.services;
    if (!services) {
      console.warn('[CrosshairDisplayService] services 不可用');
      return;
    }

    const {
      hangingProtocolService,
      toolGroupService,
      cornerstoneViewportService,
      viewportGridService,
      toolbarService,
    } = services;

    try {
      // 判断当前布局类型（在 try-catch 内，防止 hangingProtocolService 内部状态未就绪时报错）
      const stageId = hangingProtocolService?._getCurrentStageModel?.()?.id || '';
      const isTmtv = tmtvCrosshairService.isTmtvLayout(stageId);

      // [2026-08-07 Step2] 同步当前 stageId 到 TMTVCrosshairService
      // 用于单切线旋转时判断是否为 2x3-layout（Axial 布局）以启用 target 旋转
      tmtvCrosshairService.setStageId(stageId);

      if (isTmtv) {
        // ========== TMTV 布局：使用 SVG overlay ==========
        this._updateTmtvCrosshair(stageId, cornerstoneViewportService);
        // 停用原生 CrosshairsTool，避免两套系统同时显示
        this._setLegacyCrosshairVisible(false, toolGroupService);
      } else {
        // ========== 旧 MPR 布局：使用 Cornerstone CrosshairsTool ==========
        // 设置统一状态（TMTV SVG 无 viewport 注册时 render 是 no-op）
        tmtvCrosshairService.setVisible(this.state.visible);
        this._setLegacyCrosshairVisible(this.state.visible, toolGroupService);
      }

      // 刷新工具栏，同步按钮 isActive 状态
      const { activeViewportId } = viewportGridService.getState();
      toolbarService.refreshToolbarState({ viewportId: activeViewportId });
    } catch (e) {
      console.warn('[CrosshairDisplayService] update 失败', e);
    }
  }

  /**
   * [2026-08-06] 更新 TMTV 布局的 SVG 十字线
   */
  private _updateTmtvCrosshair(
    stageId: string,
    cornerstoneViewportService: any
  ): void {
    const { visible } = this.state;

    if (visible) {
      // 显示前确保 viewport 已注册到 TMTVCrosshairService
      const viewportIds = tmtvCrosshairService.getViewportIdsForStage(stageId);
      viewportIds.forEach((vpId: string) => {
        try {
          const viewport = cornerstoneViewportService.getCornerstoneViewport(vpId);
          if (viewport && !tmtvCrosshairService.getViewport(vpId)) {
            tmtvCrosshairService.addViewport(vpId, viewport);
          }
        } catch (e) {
          console.warn(`[CrosshairDisplayService] 注册 viewport 失败 (${vpId})`, e);
        }
      });
    }

    tmtvCrosshairService.setVisible(visible);
  }

  /**
   * [2026-08-06] 控制 Cornerstone 工具的显示/隐藏
   * 根据当前模式选择激活的工具：
   *   - mode='singleLineRotate' → 激活 SingleSliceLineTool（单切线旋转）
   *   - mode='normal'           → 激活 CrosshairsTool（双切线旋转）
   *
   * @param visible - true=激活工具，false=停用工具
   *
   * [2026-08-10 修复] 激活目标工具前先禁用另一个工具，确保互斥。
   *   场景：3x4 布局下先激活 Crosshairs，再激活 SingleSliceLine 时，
   *   若不先禁用 Crosshairs，其 annotation 仍存在并响应旋转交互，
   *   导致"旋转时仍是十字线旋转"的问题。
   *   约束：CrosshairsTool 和 SingleSliceLineTool 在 MPR 布局下需互斥激活。
   */
  private _setLegacyCrosshairVisible(visible: boolean, toolGroupService: any): void {
    // 根据模式选择要激活的工具名称
    const toolName =
      this.state.mode === 'singleLineRotate' ? 'SingleSliceLine' : 'Crosshairs';
    // 另一个需要互斥禁用的工具名称
    const otherToolName =
      this.state.mode === 'singleLineRotate' ? 'Crosshairs' : 'SingleSliceLine';

    CrosshairDisplayService.LEGACY_TOOLGROUP_IDS.forEach(tgId => {
      try {
        const toolGroup = toolGroupService.getToolGroup(tgId);
        if (!toolGroup) return;
        const csToolGroup = toolGroup._toolGroup || toolGroup;

        if (visible) {
          // [2026-08-10 修复] 先禁用另一个工具，确保互斥
          csToolGroup.setToolDisabled(otherToolName);
          // [2026-08-12 修复] 激活工具时必须传入 Primary binding
          // 原因：不传 bindings 时工具进入 Active 模式但 isPrimary=false，
          // 鼠标点击十字线中心不触发 addNewAnnotation，导致十字线不能拖动。
          // 场景：从 TMTV 布局切换到 3x4 布局后，布局切换回调调用
          // crosshairDisplayService.refresh() → _setLegacyCrosshairVisible(true)，
          // 若不传 bindings，CrosshairsTool 无 Primary binding，十字线显示但不能拖动。
          csToolGroup.setToolActive(toolName, {
            bindings: [{ mouseButton: 1 }], // MouseBindings.Primary
          });
        } else {
          // 禁用时同时禁用两个工具，确保彻底清理
          csToolGroup.setToolDisabled('SingleSliceLine');
          csToolGroup.setToolDisabled('Crosshairs');
        }
      } catch (e) {
        // ignore - toolGroup 可能不存在
      }
    });
  }

  /**
   * [2026-08-06] 完全重置状态
   * 用于退出模式时清理，释放 servicesManager 引用
   */
  reset(): void {
    this.state.visible = false;
    this.state.mode = 'normal';
    // [2026-08-06 内存修复] 清除 servicesManager 引用，防止单例持有旧服务对象
    // 导致 CornerstoneViewportService、HangingProtocolService 等无法被 GC
    this.servicesManager = null;
    this.initialized = false;
  }

  /**
   * [2026-08-06] 刷新显示状态（用于布局切换后恢复）
   * 根据当前布局类型和状态，重新应用显示
   *
   * 先从 tmtvCrosshairService 同步 visible 状态，
   * 因为 toggleTMTVCrosshairs 可能直接修改了 tmtvCrosshairService.visible
   * 而未通过 CrosshairDisplayService 更新 this.state.visible
   */
  refresh(): void {
    this.state.visible = tmtvCrosshairService.getVisible();
    this._update();
  }
}

// 导出单例实例
const crosshairDisplayService = new CrosshairDisplayService();
export default crosshairDisplayService;
export { CrosshairDisplayService };
