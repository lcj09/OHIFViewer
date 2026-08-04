// [2026-07-01 新增] TMTV覆盖层菜单组件
//
// 功能：通过下拉菜单控制视口覆盖层的显示/隐藏
// 下拉菜单包含：
//   1. 十字线 - 切换十字线参考线的可见性
//   2. 患者信息 - 切换视口四角患者信息的可见性
//
// [2026-07-30 修改] 集成 TMTVCrosshairService
//   - TMTV 布局（AXIAL/Sagittal/Coronal）使用 TMTVCrosshairService（SVG overlay）
//   - 其他布局使用原始逻辑（Cornerstone CrosshairsTool，仅 fusion + mip toolGroup）

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

    // 如果有注册成功的 viewport，恢复十字线显示状态
    if (registeredCount > 0 && showCrosshairsRef.current) {
      tmtvCrosshairService.setVisible(true);
    }
  }, [getCurrentStageId, cornerstoneViewportService]);

  // 检查十字线工具是否处于 active 状态（非 TMTV 布局使用）
  const checkCrosshairsActive = useCallback(() => {
    // TMTV 布局使用 TMTVCrosshairService 的状态
    if (checkIsTmtvLayout()) {
      return tmtvCrosshairService.getVisible();
    }

    // 其他布局使用 Cornerstone CrosshairsTool 的状态
    try {
      const toolGroupIds = ['fusionToolGroup', 'mipToolGroup'];
      for (const tgId of toolGroupIds) {
        const toolGroup = toolGroupService.getToolGroup(tgId);
        if (!toolGroup) continue;
        const csToolGroup = toolGroup._toolGroup || toolGroup;
        const activeTool = csToolGroup.getActivePrimaryMouseButtonTool();
        if (activeTool === 'Crosshairs') return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }, [toolGroupService, checkIsTmtvLayout]);

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

    const handleLayoutChanged = () => {
      if (!isMountedRef.current) return;

      const tmtv = checkIsTmtvLayout();

      if (tmtv) {
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
        // 非 TMTV 布局：清理 TMTVCrosshairService
        tmtvCrosshairService.clear();
      }
    };

    const handleViewportsReady = () => {
      if (!isMountedRef.current) return;
      if (checkIsTmtvLayout()) {
        registerTmtvViewports();
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
      // 组件卸载时清理十字线服务
      tmtvCrosshairService.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 初始化时检查状态
  useEffect(() => {
    setShowCrosshairs(checkCrosshairsActive());
    setShowPatientInfo(checkPatientInfoVisible());
  }, [checkCrosshairsActive, checkPatientInfoVisible]);

  // [2026-07-30 修改] 切换十字线可见性
  // TMTV 布局使用 TMTVCrosshairService（SVG overlay）
  // 其他布局使用原始逻辑（Cornerstone CrosshairsTool）
  const handleToggleCrosshairs = () => {
    const newState = !showCrosshairs;
    setShowCrosshairs(newState);

    const tmtv = checkIsTmtvLayout();

    if (tmtv) {
      // TMTV 布局：使用 TMTVCrosshairService
      tmtvCrosshairService.setVisible(newState);
      return;
    }

    // 其他布局：使用原始逻辑（Cornerstone CrosshairsTool）
    const toolGroupIds = ['fusionToolGroup', 'mipToolGroup'];
    toolGroupIds.forEach(tgId => {
      try {
        const toolGroup = toolGroupService.getToolGroup(tgId);
        if (!toolGroup) return;
        const csToolGroup = toolGroup._toolGroup || toolGroup;

        if (newState) {
          commandsManager.runCommand('setToolActiveToolbar', {
            toolName: 'Crosshairs',
            toolGroupIds: [tgId],
          });
        } else {
          csToolGroup.setToolPassive('Crosshairs');
        }
      } catch (e) {
        console.warn(`OverlayMenu: 切换十字线失败 (${tgId})`, e);
      }
    });

    // 触发所有视口重新渲染
    try {
      const viewportIds = viewportGridService.getViewportIds();
      if (viewportIds) {
        viewportIds.forEach(vpId => {
          const viewport = cornerstoneViewportService.getCornerstoneViewport(vpId);
          if (viewport) viewport.render();
        });
      }
    } catch (e) {}
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
                  className={`inline-flex h-10 w-10 items-center justify-center rounded-lg text-foreground/80 hover:bg-background hover:text-highlight`}
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
                showCrosshairs ? 'text-common-bright' : 'text-gray-400'
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
                showPatientInfo ? 'text-common-bright' : 'text-gray-400'
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
