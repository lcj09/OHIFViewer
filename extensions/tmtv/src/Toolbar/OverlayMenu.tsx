// [2026-07-01 新增] TMTV覆盖层菜单组件
//
// 功能：通过下拉菜单控制视口覆盖层的显示/隐藏
// 下拉菜单包含：
//   1. 十字线 - 切换十字线参考线的可见性
//   2. 患者信息 - 切换视口四角患者信息的可见性

import React, { useState, useEffect, useCallback } from 'react';
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

function OverlayMenu({ commandsManager, servicesManager, ...props }) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [showCrosshairs, setShowCrosshairs] = useState(true);
  const [showPatientInfo, setShowPatientInfo] = useState(true);

  const {
    toolGroupService,
    cornerstoneViewportService,
    customizationService,
    viewportGridService,
  } = servicesManager.services;

  // 检查十字线工具是否在所有工具组中处于active状态
  const checkCrosshairsActive = useCallback(() => {
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
  }, [toolGroupService]);

  // 检查患者信息是否可见（通过 customizationService 的 viewportOverlay 配置）
  const checkPatientInfoVisible = useCallback(() => {
    try {
      const viewportOverlay = customizationService.getCustomization('viewportOverlay');
      // 如果 viewportOverlay 存在且未设置 hideAll，则认为可见
      if (viewportOverlay && viewportOverlay.hideAll === true) return false;
      return true;
    } catch (e) {
      return true;
    }
  }, [customizationService]);

  // 初始化时检查状态
  useEffect(() => {
    setShowCrosshairs(checkCrosshairsActive());
    setShowPatientInfo(checkPatientInfoVisible());
  }, [checkCrosshairsActive, checkPatientInfoVisible]);

  // 切换十字线可见性
  const handleToggleCrosshairs = () => {
    const newState = !showCrosshairs;
    setShowCrosshairs(newState);

    const toolGroupIds = ['fusionToolGroup', 'mipToolGroup'];
    toolGroupIds.forEach(tgId => {
      try {
        const toolGroup = toolGroupService.getToolGroup(tgId);
        if (!toolGroup) return;
        const csToolGroup = toolGroup._toolGroup || toolGroup;

        if (newState) {
          // 激活十字线
          commandsManager.runCommand('setToolActiveToolbar', {
            toolName: 'Crosshairs',
            toolGroupIds: [tgId],
          });
        } else {
          // 停用十字线（设为 passive）
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
        // 显示患者信息：移除 hideAll 设置
        customizationService.setCustomizations({
          viewportOverlay: {},
        });
      } else {
        // 隐藏患者信息：设置 hideAll
        customizationService.setCustomizations({
          viewportOverlay: { hideAll: true },
        });
      }

      // 触发所有视口重新渲染
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
