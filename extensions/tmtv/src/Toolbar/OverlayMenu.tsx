// [2026-07-01 新增] TMTV覆盖层菜单组件
//
// 功能：通过下拉菜单控制视口覆盖层的显示/隐藏
// 下拉菜单包含：
//   1. 十字线 - 切换十字线参考线的可见性
//   2. 患者信息 - 切换视口四角患者信息的可见性
//
// [2026-07-30 修改] 集成 TMTVCrosshairService
// [2026-08-04 重构] 统一状态管理
//   - tmtvCrosshairService.visible 作为两套十字线系统的唯一状态源
//   - TMTV 布局（AXIAL/Sagittal/Coronal）使用 TMTVCrosshairService（SVG overlay）
//   - 非 TMTV 布局使用 Cornerstone CrosshairsTool（setToolActive/setToolDisabled）
//   - 布局切换时 visible 状态保持不变，自动恢复对应系统的十字线
//   - 所有切换逻辑统一委托给 toggleTMTVCrosshairs 命令

import React, { useState, useEffect, useCallback, useRef } from 'react';
import PropTypes from 'prop-types';
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  Button,
  Icons,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@ohif/ui-next';
import tmtvCrosshairService from '../services/TMTVCrosshairService';
import crosshairDisplayService from '../services/CrosshairDisplayService';

function OverlayMenu({ commandsManager, servicesManager, ...props }) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [showCrosshairs, setShowCrosshairs] = useState(true);
  const [showPatientInfo, setShowPatientInfo] = useState(true);
  // 使用 ref 保存 showCrosshairs 的最新值，避免 useEffect 闭包问题
  const showCrosshairsRef = useRef(true);
  const isMountedRef = useRef(true);
  // 保存 pending 的 setTimeout ID，用于组件卸载时清除
  const pendingTimeoutRef = useRef<number | null>(null);

  const {
    toolGroupService,
    cornerstoneViewportService,
    customizationService,
    viewportGridService,
    hangingProtocolService,
    toolbarService,
  } = servicesManager.services;

  // 同步 showCrosshairs 到 ref
  useEffect(() => {
    showCrosshairsRef.current = showCrosshairs;
  }, [showCrosshairs]);

  // [2026-07-30 新增] 获取当前布局的 stage ID
  const getCurrentStageId = useCallback(() => {
    try {
      const currentStage = hangingProtocolService?._getCurrentStageModel?.();
      return currentStage?.id || '';
    } catch (e) {
      return '';
    }
  }, [hangingProtocolService]);

  // [2026-07-30 新增] 判断当前是否为 TMTV 布局（AXIAL/Sagittal/Coronal）
  const checkIsTmtvLayout = useCallback(() => {
    const stageId = getCurrentStageId();
    return tmtvCrosshairService.isTmtvLayout(stageId);
  }, [getCurrentStageId]);

  // [2026-07-30 新增] 注册 TMTV 布局的 viewport 到 TMTVCrosshairService
  const registerTmtvViewports = useCallback(() => {
    const stageId = getCurrentStageId();
    const viewportIds = tmtvCrosshairService.getViewportIdsForStage(stageId);

    // 先清空旧的注册
    tmtvCrosshairService.clear();

    // [2026-08-10 修复布局切换后单切线旋转失效] 同步 currentStageId
    // 原因：clear() 不重置 currentStageId，而 setStageId 只在 CrosshairDisplayService._update()
    //       （即 enable/disable/toggle）时调用。若用户切换布局后未重新点击单切线按钮，
    //       currentStageId 仍是旧布局的值，_findTargetViewport 会用旧布局的 viewportId
    //       列表查找 target，导致找不到 target，旋转失效。
    tmtvCrosshairService.setStageId(stageId);

    if (viewportIds.length === 0) {
      return;
    }

    // 注册每个 viewport
    let registeredCount = 0;
    viewportIds.forEach(vpId => {
      try {
        const viewport = cornerstoneViewportService.getCornerstoneViewport(vpId);
        if (viewport) {
          tmtvCrosshairService.addViewport(vpId, viewport);
          registeredCount++;
        }
      } catch (e) {
        console.warn(`[OverlayMenu] 注册 viewport 失败 (${vpId})`, e);
      }
    });

    // [2026-08-04] 布局切换后恢复十字线显示
    // 检查 tmtvCrosshairService.getVisible() 而非 showCrosshairsRef.current，
    // 因为用户可能通过标准 Crosshairs 按钮激活（不经过 OverlayMenu 的 state）。
    // clear() 不再重置 visible，所以布局切换后 visible 状态被保留。
    if (registeredCount > 0) {
      const isVisible = tmtvCrosshairService.getVisible();
      if (isVisible) {
        // setVisible(true) 会调用 render()，在新 viewport 上绘制十字线
        tmtvCrosshairService.setVisible(true);
      }
      // 刷新工具栏，同步 Crosshairs 按钮的蓝色背景
      const { activeViewportId } = viewportGridService.getState();
      toolbarService.refreshToolbarState({ viewportId: activeViewportId });
      // 同步 OverlayMenu 的 showCrosshairs 状态
      if (showCrosshairsRef.current !== isVisible) {
        setShowCrosshairs(isVisible);
      }
    }
  }, [getCurrentStageId, cornerstoneViewportService, viewportGridService, toolbarService]);

  // [2026-08-04 简化] 检查十字线是否处于激活状态
  // 统一使用 tmtvCrosshairService.getVisible() 作为唯一状态源，
  // 不再区分 TMTV/非 TMTV 布局，因为 toggleTMTVCrosshairs 命令
  // 已统一管理两套十字线系统的状态。
  const checkCrosshairsActive = useCallback(() => {
    return tmtvCrosshairService.getVisible();
  }, []);

  // 检查患者信息是否可见
  const checkPatientInfoVisible = useCallback(() => {
    try {
      const viewportOverlay = customizationService.getCustomization('viewportOverlay');
      if (viewportOverlay && viewportOverlay.hideAll === true) return false;
      return true;
    } catch (e) {
      return true;
    }
  }, [customizationService]);

  // [2026-07-30 新增] 监听布局变化，自动注册/清理 viewport
  useEffect(() => {
    isMountedRef.current = true;

    // [2026-08-10 内存泄漏修复] 组件挂载时重新注入 servicesManager
    // 原因：组件卸载时 tmtvCrosshairService.reset() 和 crosshairDisplayService.reset()
    //   会释放 servicesManager 引用。再次进入 TMTV 模式时组件重新挂载，
    //   但 commandsModule 不会重新初始化，需要在此处重新注入。
    tmtvCrosshairService.setServicesManager(servicesManager);
    crosshairDisplayService.init(servicesManager);

    const handleLayoutChanged = () => {
      if (!isMountedRef.current) return;

      const tmtv = checkIsTmtvLayout();

      // [2026-08-10 修复布局切换后单切线旋转失效] 同步 currentStageId
      // 无论进入 TMTV 分支还是非 TMTV 分支，都先同步 stageId，确保
      // _findTargetViewport 用最新布局的 viewportId 列表查找 target。
      tmtvCrosshairService.setStageId(getCurrentStageId());

      if (tmtv) {
        // [内存排查] 立即清理旧的十字线 SVG 状态，释放对已销毁 viewport 的引用。
        // clear() 不重置 visible，保留状态以便切换布局后自动恢复十字线。
        tmtvCrosshairService.clear();

        // [2026-08-04] 停用原生 CrosshairsTool，避免两套十字线系统同时显示。
        // TMTV 布局使用 SVG overlay，不需要 Cornerstone CrosshairsTool。
        commandsManager.runCommand('setNativeCrosshairsVisibility', { visible: false });

        // 清除之前的 pending timeout，避免重复注册
        if (pendingTimeoutRef.current) {
          clearTimeout(pendingTimeoutRef.current);
        }
        // TMTV 布局：延迟注册 viewport，等待 viewport 渲染完成
        pendingTimeoutRef.current = window.setTimeout(() => {
          if (!isMountedRef.current) return;
          if (checkIsTmtvLayout()) {
            registerTmtvViewports();
          }
        }, 500);
      } else {
        // [2026-08-04] 非 TMTV 布局：清理 SVG 层但保留 visible 状态
        // 使用 clear() 而非 reset()，使 visible 状态在布局切换后保持，
        // 这样切换到非 TMTV 布局时原生工具能根据 visible 自动恢复。
        tmtvCrosshairService.clear();

        // [2026-08-06] 通过 CrosshairDisplayService 恢复显示
        // 会根据当前 mode 自动选择激活 CrosshairsTool 或 SingleSliceLineTool
        crosshairDisplayService.refresh();

        // 同步 OverlayMenu 的 showCrosshairs 状态
        const isVisible = tmtvCrosshairService.getVisible();
        if (showCrosshairsRef.current !== isVisible) {
          setShowCrosshairs(isVisible);
        }

        // 刷新工具栏，同步 Crosshairs 按钮的蓝色背景
        const { activeViewportId } = viewportGridService.getState();
        toolbarService.refreshToolbarState({ viewportId: activeViewportId });
      }
    };

    const handleViewportsReady = () => {
      if (!isMountedRef.current) return;
      if (checkIsTmtvLayout()) {
        registerTmtvViewports();
      }
    };

    // [2026-08-05 新增] 工具互斥：当激活非 Crosshairs 工具时，自动停用十字线
    // 监听 toolGroupService 的 PRIMARY_TOOL_ACTIVATED 事件，
    // 当任何非 Crosshairs 工具被激活为左键主工具时，停用十字线。
    // 这使得十字线按钮与其他工具按钮（WindowLevel/Pan/Zoom/Length 等）互斥。
    //
    // 事件流程：
    //   用户点击工具按钮 → setToolActiveToolbar → toolGroup.setToolActive
    //   → Cornerstone3D 触发 TOOL_ACTIVATED → toolGroupService 触发 PRIMARY_TOOL_ACTIVATED
    //   → 本处理器停用十字线 → recordInteraction 调用 refreshToolbarState
    //   → Crosshairs 按钮的 evaluate.tmtvCrosshair 返回 isActive: false
    //
    // 注意：Crosshairs 工具自身的激活不会触发停用（toolName === 'Crosshairs' 时跳过），
    // 这允许非 TMTV 布局通过 setNativeCrosshairsVisibility 激活原生 CrosshairsTool。
    const handlePrimaryToolActivated = (callbackProps: { toolName: string }) => {
      if (!isMountedRef.current) return;
      const { toolName } = callbackProps;
      // [2026-08-06] 排除 Crosshairs 和 SingleSliceLine，避免自我取消
      if (
        toolName !== 'Crosshairs' &&
        toolName !== 'SingleSliceLine' &&
        tmtvCrosshairService.getVisible()
      ) {
        // 停用十字线：setVisible(false) 会隐藏 SVG overlay（TMTV 布局）
        // 并设置 visible = false（统一状态）
        // 非 TMTV 布局下原生 CrosshairsTool 已被 setToolActive 自动停用
        tmtvCrosshairService.setVisible(false);

        // 同步 OverlayMenu 的 showCrosshairs 状态
        if (showCrosshairsRef.current) {
          setShowCrosshairs(false);
        }

        // 刷新工具栏，同步 Crosshairs 按钮的蓝色背景
        const { activeViewportId } = viewportGridService.getState();
        toolbarService.refreshToolbarState({ viewportId: activeViewportId });
      }
    };

    // 监听布局变化和 viewport 准备完成事件
    const subscriptionLayoutChanged = viewportGridService.subscribe(
      viewportGridService.EVENTS.LAYOUT_CHANGED,
      handleLayoutChanged
    );

    const subscriptionViewportsReady = viewportGridService.subscribe(
      viewportGridService.EVENTS.VIEWPORTS_READY,
      handleViewportsReady
    );

    // 监听工具激活事件（互斥逻辑）
    const subscriptionPrimaryToolActivated = toolGroupService.subscribe(
      toolGroupService.EVENTS.PRIMARY_TOOL_ACTIVATED,
      handlePrimaryToolActivated
    );

    // 初始检查
    handleLayoutChanged();

    return () => {
      isMountedRef.current = false;
      // 清除 pending 的 setTimeout，防止组件卸载后回调执行
      if (pendingTimeoutRef.current) {
        clearTimeout(pendingTimeoutRef.current);
        pendingTimeoutRef.current = null;
      }
      // subscribe() 返回 { unsubscribe: () => void } 对象
      if (subscriptionLayoutChanged?.unsubscribe) subscriptionLayoutChanged.unsubscribe();
      if (subscriptionViewportsReady?.unsubscribe) subscriptionViewportsReady.unsubscribe();
      if (subscriptionPrimaryToolActivated?.unsubscribe) subscriptionPrimaryToolActivated.unsubscribe();
      // 组件卸载时完全重置十字线服务（包括 visible 状态）
      tmtvCrosshairService.reset();
      // [2026-08-06 内存修复] 重置 CrosshairDisplayService，释放 servicesManager 引用
      crosshairDisplayService.reset();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 初始化时检查状态
  useEffect(() => {
    setShowCrosshairs(checkCrosshairsActive());
    setShowPatientInfo(checkPatientInfoVisible());
  }, [checkCrosshairsActive, checkPatientInfoVisible]);

  // [2026-08-04 新增] 订阅工具栏状态变化，同步 showCrosshairs
  // 当用户通过工具栏的 Crosshairs 按钮（非 OverlayMenu 下拉菜单）切换十字线时，
  // toggleTMTVCrosshairs 命令会刷新工具栏状态，触发 TOOL_BAR_STATE_MODIFIED 事件。
  // 此订阅确保 OverlayMenu 的 showCrosshairs 状态与统一状态源保持同步，
  // 使覆盖层按钮的蓝色背景和下拉菜单的勾选状态正确反映当前十字线状态。
  useEffect(() => {
    const subscription = toolbarService.subscribe(
      toolbarService.EVENTS.TOOL_BAR_STATE_MODIFIED,
      () => {
        if (!isMountedRef.current) return;
        const isVisible = tmtvCrosshairService.getVisible();
        if (showCrosshairsRef.current !== isVisible) {
          setShowCrosshairs(isVisible);
        }
      }
    );

    return () => {
      if (subscription?.unsubscribe) subscription.unsubscribe();
    };
  }, [toolbarService]);

  // [2026-08-04 简化] 切换十字线可见性
  // 统一委托给 toggleTMTVCrosshairs 命令处理，该命令内部会：
  //   1. 切换 tmtvCrosshairService.visible（统一状态源）
  //   2. TMTV 布局：重绘 SVG overlay + 停用原生 CrosshairsTool
  //   3. 非 TMTV 布局：激活/停用原生 CrosshairsTool
  //   4. 刷新工具栏按钮状态
  const handleToggleCrosshairs = () => {
    commandsManager.runCommand('toggleTMTVCrosshairs');

    // 同步 OverlayMenu 的 showCrosshairs 状态
    const isVisible = tmtvCrosshairService.getVisible();
    if (showCrosshairsRef.current !== isVisible) {
      setShowCrosshairs(isVisible);
    }
  };

  // 切换患者信息可见性
  const handleTogglePatientInfo = () => {
    const newState = !showPatientInfo;
    setShowPatientInfo(newState);

    try {
      if (newState) {
        customizationService.setCustomizations({
          viewportOverlay: {},
        });
      } else {
        customizationService.setCustomizations({
          viewportOverlay: { hideAll: true },
        });
      }

      const viewportIds = viewportGridService.getViewportIds();
      if (viewportIds) {
        viewportIds.forEach(vpId => {
          const viewport = cornerstoneViewportService.getCornerstoneViewport(vpId);
          if (viewport) viewport.render();
        });
      }
    } catch (e) {
      console.warn('OverlayMenu: 切换患者信息失败', e);
    }
  };

  return (
    <div id="OverlayMenu" data-cy="OverlayMenu">
      <Popover open={isMenuOpen} onOpenChange={setIsMenuOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <div className="flex h-[56px] flex-col items-center justify-between gap-0 py-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className={`inline-flex h-10 w-10 items-center justify-center rounded-lg ${
                    showCrosshairs
                      ? 'bg-highlight text-background hover:!bg-highlight/80'
                      : 'bg-transparent text-foreground/80 hover:bg-background hover:text-highlight'
                  }`}
                  aria-label="覆盖层"
                >
                  <Icons.ByName name="EyeVisible" className="h-7 w-7" />
                </Button>
                <span className="text-[12px] leading-tight text-white whitespace-nowrap">
                  覆盖层
                </span>
              </div>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <div>覆盖层</div>
          </TooltipContent>
        </Tooltip>
        <PopoverContent
          className="w-48 rounded-lg border-none p-1 shadow-lg"
          align="center"
          sideOffset={8}
          onPointerDown={e => e.stopPropagation()}
          onMouseDown={e => e.stopPropagation()}
          onClick={e => e.stopPropagation()}
        >
          <div className="flex flex-col gap-0.5">
            {/* 十字线 */}
            <Button
              variant="ghost"
              className={`flex h-8 w-full items-center justify-start px-2 py-1 text-sm hover:bg-primary-dark ${
                showCrosshairs ? 'text-highlight' : 'text-gray-400'
              }`}
              onClick={handleToggleCrosshairs}
              onPointerDown={e => e.stopPropagation()}
            >
              <span className="mr-2 inline-block w-4 text-center">
                {showCrosshairs ? '✓' : ''}
              </span>
              十字线
            </Button>

            {/* 患者信息 */}
            <Button
              variant="ghost"
              className={`flex h-8 w-full items-center justify-start px-2 py-1 text-sm hover:bg-primary-dark ${
                showPatientInfo ? 'text-highlight' : 'text-gray-400'
              }`}
              onClick={handleTogglePatientInfo}
              onPointerDown={e => e.stopPropagation()}
            >
              <span className="mr-2 inline-block w-4 text-center">
                {showPatientInfo ? '✓' : ''}
              </span>
              患者信息
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

OverlayMenu.propTypes = {
  commandsManager: PropTypes.object,
  servicesManager: PropTypes.object,
};

export default OverlayMenu;
