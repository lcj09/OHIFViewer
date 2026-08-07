// [2026-08-06 新增] 同步设置菜单组件
//
// 功能：通过下拉菜单控制视口间的同步行为
// 下拉菜单包含：
//   1. 同步方位切换 - 控制方位切换时是否同步到同组其他视口
//
// 状态存储：使用 customizationService 的 'syncSettings' 存储
//   { orientationSync: true }  → 同步（默认）
//   { orientationSync: false } → 不同步（只切换当前视口）

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

function SyncMenu({ servicesManager, ...props }) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [orientationSync, setOrientationSync] = useState(true);

  const { customizationService } = servicesManager.services;

  // [2026-08-06] 初始化：从 customizationService 读取同步状态
  useEffect(() => {
    try {
      const syncSettings = customizationService.getCustomization('syncSettings');
      if (syncSettings && typeof syncSettings.orientationSync === 'boolean') {
        setOrientationSync(syncSettings.orientationSync);
      } else {
        // 默认同步
        customizationService.setCustomizations({
          syncSettings: { orientationSync: true },
        });
      }
    } catch (e) {
      console.warn('[SyncMenu] 初始化同步状态失败', e);
    }
  }, [customizationService]);

  // [2026-08-06, 2026-08-07 修改] 切换方位同步开关
  // 开启时：恢复所有被禁用的 cameraPosition 同步器
  //   setViewportOrientation 在同步关闭时会禁用同步器且不恢复，
  //   用户重新开启同步时在此统一恢复。
  const handleToggleOrientationSync = useCallback(() => {
    const newState = !orientationSync;
    setOrientationSync(newState);
    try {
      customizationService.setCustomizations({
        syncSettings: { orientationSync: newState },
      });

      // [2026-08-07] 重新开启同步时，恢复所有 cameraPosition 同步器
      if (newState) {
        const { syncGroupService, cornerstoneViewportService } =
          servicesManager.services;
        try {
          const vpIds = cornerstoneViewportService.getViewportIds() || [];
          const seen = new Set();
          vpIds.forEach(vpId => {
            try {
              const syncs = syncGroupService.getSynchronizersForViewport(vpId);
              syncs.forEach(s => {
                if (seen.has(s)) return;
                seen.add(s);
                const type = syncGroupService.getSynchronizerType(s);
                if (type && type.toLowerCase() === 'cameraposition') {
                  s.setEnabled(true);
                }
              });
            } catch {
              /* ignore */
            }
          });
        } catch (e) {
          console.warn('[SyncMenu] 恢复同步器失败', e);
        }
      }
    } catch (e) {
      console.warn('[SyncMenu] 保存同步状态失败', e);
    }
  }, [orientationSync, customizationService, servicesManager]);

  return (
    <div id="SyncMenu" data-cy="SyncMenu">
      <Popover open={isMenuOpen} onOpenChange={setIsMenuOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <div className="flex h-[56px] flex-col items-center justify-between gap-0 py-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-transparent text-foreground/80 hover:bg-background hover:text-highlight"
                  aria-label="同步设置"
                >
                  <Icons.ByName name="icon-sync" className="h-7 w-7" />
                </Button>
                <span className="text-[12px] leading-tight text-white whitespace-nowrap">
                  同步
                </span>
              </div>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <div>同步设置</div>
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
            {/* 同步方位切换 */}
            <Button
              variant="ghost"
              className={`flex h-8 w-full items-center justify-start px-2 py-1 text-sm hover:bg-primary-dark ${
                orientationSync ? 'text-highlight' : 'text-gray-400'
              }`}
              onClick={handleToggleOrientationSync}
              onPointerDown={e => e.stopPropagation()}
            >
              <span className="mr-2 inline-block w-4 text-center">
                {orientationSync ? '✓' : ''}
              </span>
              同步方位切换
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

SyncMenu.propTypes = {
  servicesManager: PropTypes.object,
};

export default SyncMenu;
