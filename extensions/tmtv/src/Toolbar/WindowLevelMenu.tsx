// [2026-08-20 新增, 2026-08-20 修改] 调窗按钮组件（下拉菜单样式，与"微调"按钮一致）
//
// 功能：将调窗按钮改为下拉菜单按钮（样式与微调按钮一致）。
//   - 点击按钮：激活 WindowLevel 工具（手动调窗），与其他工具按钮互斥；
//     同时通过 PopoverTrigger 弹出 CT 预设下拉菜单。
//   - 下拉菜单：CT 预设列表（应用 cornerstone.windowLevelPresets 中的 CT 预设
//     到 ctToolGroup 下的视口，不影响 PET/Fusion/MIP）。
//   - 激活高亮：与微调按钮一致使用 bg-primary/20 text-highlight。
//
// 互斥实现：通过 toolbarService.recordInteraction 直接执行 setToolActiveToolbar
// 命令并触发工具栏状态刷新，保证：
//   1. 与其他工具互斥（激活 WindowLevel 时自动取消 Pan/Zoom 等工具的激活态）
//   2. 无论当前激活的是移动还是其他工具，点击后都能正常切换到 WindowLevel
//   3. 不因 evaluate 的 disabled 而失效，按钮始终可点击

import React, { useState } from 'react';
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
import i18n from 'i18next';

// [2026-08-20] TMTV模式调窗工具默认作用的工具组（与 toolbarButtons.setToolActiveToolbar 保持一致）
const WINDOW_LEVEL_TOOL_GROUP_IDS = [
  'ctToolGroup',
  'ptToolGroup',
  'fusionToolGroup',
  'mipToolGroup',
];

function WindowLevelMenu({ commandsManager, servicesManager, ...props }) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  const { toolGroupService, customizationService, toolbarService, viewportGridService } =
    servicesManager.services;

  // [2026-08-20 修改] 点击按钮：激活 WindowLevel 工具（手动调窗，与其他工具互斥）
  // 不依赖 onInteraction / props.commands 的透传，直接通过 toolbarService.recordInteraction
  // 执行 setToolActiveToolbar 命令并刷新工具栏状态，确保互斥和始终可点击。
  // 菜单开合由 PopoverTrigger 控制，此处不干预 isMenuOpen。
  const handleLeftClick = () => {
    try {
      const viewportId = viewportGridService?.getActiveViewportId?.();
      const command = props.commands || {
        commandName: 'setToolActiveToolbar',
        commandOptions: { toolGroupIds: WINDOW_LEVEL_TOOL_GROUP_IDS },
      };
      toolbarService.recordInteraction(
        {
          itemId: props.id,
          commands: command,
        },
        { refreshProps: { viewportId } }
      );
    } catch (e) {
      console.warn('WindowLevelMenu: 激活WindowLevel工具失败', e);
    }
  };

  // [2026-08-20] 应用CT预设到CT视口（仅ctToolGroup下的视口，不影响PET/Fusion/MIP）
  const handleApplyCTPreset = preset => {
    setIsMenuOpen(false);
    try {
      const ctToolGroup = toolGroupService.getToolGroup('ctToolGroup');
      const ctViewportIds = ctToolGroup?.getViewportIds?.() || [];
      for (const viewportId of ctViewportIds) {
        commandsManager.runCommand('setViewportWindowLevel', {
          viewportId,
          windowWidth: Number(preset.window),
          windowCenter: Number(preset.level),
        });
      }
    } catch (e) {
      console.warn('WindowLevelMenu: 应用CT预设失败', e);
    }
  };

  // [2026-08-20] 读取CT预设（与图像框"模态窗口预设"同源，可被customization覆盖）
  let ctPresets = [];
  try {
    const presets = customizationService.getCustomization('cornerstone.windowLevelPresets');
    ctPresets = presets?.CT || [];
  } catch (e) {
    ctPresets = [];
  }

  const isActive = props.isActive;
  const label = props.label || i18n.t('Buttons:Window Level');

  return (
    <div id="WindowLevelMenu" data-cy="WindowLevelMenu">
      {/* 下拉菜单按钮（样式与微调按钮一致） */}
      <Popover open={isMenuOpen} onOpenChange={setIsMenuOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <div className="flex h-[56px] flex-col items-center justify-between gap-0 py-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className={`inline-flex h-10 w-10 items-center justify-center rounded-lg text-foreground/80 hover:bg-background hover:text-highlight ${
                    isActive ? 'bg-primary/20 text-highlight' : ''
                  }`}
                  aria-label={label}
                  onClick={handleLeftClick}
                >
                  <Icons.ByName name="tool-window-level" className="h-7 w-7" />
                </Button>
                <span className="text-[12px] leading-tight text-white whitespace-nowrap">
                  {label}
                </span>
              </div>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <div>{label}</div>
          </TooltipContent>
        </Tooltip>
        <PopoverContent
          className="w-56 rounded-lg border-none p-1 shadow-lg"
          align="center"
          sideOffset={8}
          onPointerDown={e => e.stopPropagation()}
          onMouseDown={e => e.stopPropagation()}
          onClick={e => e.stopPropagation()}
        >
          <div className="flex flex-col gap-0.5">
            {/* 标题 */}
            <div className="px-3 py-1 text-xs text-gray-500">CT预设</div>

            {/* CT预设列表 */}
            {ctPresets.map(preset => (
              <Button
                key={preset.id || preset.description}
                variant="ghost"
                className="flex h-9 w-full items-center justify-between px-3 py-1.5 text-sm text-gray-400 hover:bg-primary-dark"
                onClick={() => handleApplyCTPreset(preset)}
                onPointerDown={e => e.stopPropagation()}
              >
                <span>{i18n.t(preset.description)}</span>
                <span className="text-xs text-gray-500">
                  {preset.window} / {preset.level}
                </span>
              </Button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

WindowLevelMenu.propTypes = {
  commandsManager: PropTypes.object,
  servicesManager: PropTypes.object,
  isActive: PropTypes.bool,
};

export default WindowLevelMenu;
