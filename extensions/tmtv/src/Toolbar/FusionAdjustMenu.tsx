// [2026-05-22 新增] TMTV手动微调菜单组件
//
// 功能：提供融合图像的手动位置微调功能
// 按钮点击：激活/停用FusionAdjustTool（左键平移PET图像）
// 下拉菜单包含：
//   1. 重置微调 - 重置PET图像偏移到原始位置
//   2. 微调操作说明 - 点击弹出操作说明对话框

import React, { useState, useEffect, useCallback, useRef } from 'react';
import PropTypes from 'prop-types';
import { Popover, PopoverTrigger, PopoverContent, Button, Icons, Tooltip, TooltipTrigger, TooltipContent } from '@ohif/ui-next';

// [2026-08-21] 与 FusionAdjustTool 中 FUSION_ADJUST_DEACTIVATE_EVENT 保持同步
// 不直接 import 避免跨扩展源码路径依赖
const FUSION_ADJUST_DEACTIVATE_EVENT = 'fusionadjust:deactivate';

function FusionAdjustMenu({ commandsManager, servicesManager, ...props }) {
  const [showDialog, setShowDialog] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isToolActive, setIsToolActive] = useState(false);

  const { toolGroupService, cornerstoneViewportService } = servicesManager.services;

  // 检查FusionAdjustTool是否在fusionToolGroup中处于active状态
  const checkToolActive = useCallback(() => {
    try {
      const toolGroup = toolGroupService.getToolGroup('fusionToolGroup');
      if (!toolGroup) return false;
      const csToolGroup = toolGroup._toolGroup || toolGroup;
      const activeTool = csToolGroup.getActivePrimaryMouseButtonTool();
      return activeTool === 'FusionAdjust';
    } catch (e) {
      return false;
    }
  }, [toolGroupService]);

  // 初始化时检查工具状态
  useEffect(() => {
    setIsToolActive(checkToolActive());
  }, [checkToolActive]);

  // [2026-08-21 新增] 停用微调工具（抽取为独立函数，供 handleToggleTool 和右键双击事件复用）
  const deactivateTool = useCallback(() => {
    try {
      const toolGroup = toolGroupService.getToolGroup('fusionToolGroup');
      if (toolGroup) {
        const csToolGroup = toolGroup._toolGroup || toolGroup;
        // 先将FusionAdjust设为passive释放所有绑定
        csToolGroup.setToolPassive('FusionAdjust');
      }
    } catch (e) {
      // 忽略
    }

    // 恢复WindowLevel（左键）
    commandsManager.runCommand('setToolActiveToolbar', {
      toolName: 'WindowLevel',
      toolGroupIds: ['fusionToolGroup'],
    });
    // 恢复Zoom（右键）
    commandsManager.runCommand('setToolActiveToolbar', {
      toolName: 'Zoom',
      toolGroupIds: ['fusionToolGroup'],
      bindings: [{ mouseButton: 2 }], // Secondary(右键)
    });

    setIsToolActive(false);
  }, [toolGroupService, commandsManager]);

  // [2026-08-21 新增] 监听右键双击退出微调模式事件
  // FusionAdjustTool 检测到右键双击时派发 FUSION_ADJUST_DEACTIVATE_EVENT
  useEffect(() => {
    const handler = () => {
      if (checkToolActive()) {
        deactivateTool();
      }
    };
    document.addEventListener(FUSION_ADJUST_DEACTIVATE_EVENT, handler);
    return () => {
      document.removeEventListener(FUSION_ADJUST_DEACTIVATE_EVENT, handler);
    };
  }, [checkToolActive, deactivateTool]);

  // 激活/停用微调工具
  const handleToggleTool = () => {
    setIsMenuOpen(false);

    const currentlyActive = checkToolActive();

    if (currentlyActive) {
      deactivateTool();
    } else {
      // 激活FusionAdjustTool前，必须先禁用Zoom释放右键绑定
      // setToolPassive只移除Primary绑定，Zoom绑定的是Secondary，所以必须用setToolDisabled
      try {
        const toolGroup = toolGroupService.getToolGroup('fusionToolGroup');
        if (toolGroup) {
          const csToolGroup = toolGroup._toolGroup || toolGroup;
          csToolGroup.setToolDisabled('Zoom');
        }
      } catch (e) {
        // 忽略
      }

      // 激活FusionAdjustTool，同时绑定左键和右键
      // 左键→平移PET, 右键→旋转PET
      commandsManager.runCommand('setToolActiveToolbar', {
        toolName: 'FusionAdjust',
        toolGroupIds: ['fusionToolGroup'],
        bindings: [
          { mouseButton: 1 }, // Primary(左键)
          { mouseButton: 2 }, // Secondary(右键)
        ],
      });
    }

    setIsToolActive(!currentlyActive);
  };

  // 显示操作说明弹框
  const handleShowInstructions = () => {
    setIsMenuOpen(false);
    setShowDialog(true);
  };

  // 关闭弹框
  const handleCloseDialog = () => {
    setShowDialog(false);
  };

  // 重置微调 - 重置所有融合视口的PET偏移
  const handleReset = () => {
    setIsMenuOpen(false);

    try {
      const toolGroup = toolGroupService.getToolGroup('fusionToolGroup');
      if (!toolGroup) return;

      const csToolGroup = toolGroup._toolGroup || toolGroup;
      const toolInstance = csToolGroup.getToolInstance
        ? csToolGroup.getToolInstance('FusionAdjust')
        : csToolGroup._toolInstances?.FusionAdjust;

      if (!toolInstance) return;

      // 获取所有融合视口并重置偏移
      const fusionViewportIds = toolGroup.getViewportIds();
      if (fusionViewportIds) {
        fusionViewportIds.forEach(viewportId => {
          const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);
          if (viewport) {
            toolInstance.resetOffset(viewport);
          }
        });
      }
    } catch (e) {
      console.warn('FusionAdjustMenu: 重置微调失败', e);
    }
  };

  return (
    <div id="FusionAdjustMenu" data-cy="FusionAdjustMenu">
      {/* 下拉菜单按钮 */}
      <Popover open={isMenuOpen} onOpenChange={setIsMenuOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <div className="flex h-[56px] flex-col items-center justify-between gap-0 py-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className={`inline-flex h-10 w-10 items-center justify-center rounded-lg text-foreground/80 hover:bg-background hover:text-highlight ${
                    isToolActive ? 'bg-primary/20 text-highlight' : ''
                  }`}
                  aria-label="微调"
                  onClick={handleToggleTool}
                >
                  <Icons.ByName name="tool-fusion-adjust" className="h-7 w-7" />
                </Button>
                <span className="text-[12px] leading-tight text-white whitespace-nowrap">微调</span>
              </div>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <div>微调</div>
          </TooltipContent>
        </Tooltip>
        <PopoverContent
          className="w-48 rounded-lg border-none p-1 shadow-lg"
          align="center"
          sideOffset={8}
        >
          <div className="flex flex-col gap-0.5">
            {/* 重置微调 */}
            <Button
              variant="ghost"
              className="flex h-8 w-full items-center justify-start px-2 py-1 text-sm text-common-bright hover:bg-primary-dark"
              onClick={handleReset}
            >
              重置微调
            </Button>

            {/* 微调操作说明 */}
            <Button
              variant="ghost"
              className="flex h-8 w-full items-center justify-start px-2 py-1 text-sm text-common-bright hover:bg-primary-dark"
              onClick={handleShowInstructions}
            >
              微调操作说明
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      {/* 操作说明弹框 */}
      {showDialog && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center">
          {/* 背景遮罩 */}
          <div
            className="absolute inset-0 bg-black/50"
            onClick={handleCloseDialog}
          />

          {/* 弹框主体 */}
          <div className="relative z-10 w-[420px] bg-[#1a1a1a] rounded shadow-xl border border-[#333]">
            {/* 标题栏 */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-[#333]">
              <h3 className="text-base font-medium text-white">微调操作说明</h3>
              {/* 关闭按钮 */}
              <button
                onClick={handleCloseDialog}
                className="text-gray-400 hover:text-white transition-colors"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M6 6l12 12M6 18L18 6" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            {/* 内容区域 */}
            <div className="px-4 py-4">
              <div className="text-sm text-gray-200 leading-relaxed space-y-2">
                <p>手动微调用于对图像位置进行微调，操作方法如下：</p>
                <p>鼠标左键：平移PET图像</p>
                <p>鼠标右键：旋转PET图像</p>
                <p>双击右键：退出手动微调模式</p>
              </div>
            </div>

            {/* 底部确定按钮 */}
            <div className="px-4 pb-4 pt-2 flex justify-end">
              <button
                onClick={handleCloseDialog}
                className="px-6 py-1.5 rounded bg-[#3a3a4a] hover:bg-[#4a4a5a] text-white text-sm font-medium border border-[#555] transition-colors"
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

FusionAdjustMenu.propTypes = {
  commandsManager: PropTypes.object,
  servicesManager: PropTypes.object,
};

export default FusionAdjustMenu;
