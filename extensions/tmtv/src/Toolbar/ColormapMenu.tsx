// [2026-07-06 新增] 伪彩色下拉菜单组件（带颜色预览条）
//
// 功能：通过下拉菜单切换当前选中视口中 PT volume 的伪彩色映射
// 下拉菜单包含所有可用的 colormap 选项，每个选项右侧显示颜色预览条
// 注意：仅对包含 PT 的视口（PET/Fusion）生效，CT 视口不变化

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
import { cache, BaseVolumeViewport } from '@cornerstonejs/core';

// 可用的 colormap 列表及其 CSS 渐变预览
const COLORMAPS = [
  { name: 'Grayscale', label: 'Grayscale', gradient: 'linear-gradient(to right, #000, #fff)' },
  { name: 'X Ray', label: 'X Ray', gradient: 'linear-gradient(to right, #fff, #000)' },
  {
    name: 'Isodose',
    label: 'Isodose',
    gradient: 'linear-gradient(to right, #00f, #5f0, #ff0, #f60, #f30, #f00)',
  },
  {
    name: 'hsv',
    label: 'HSV',
    gradient: 'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)',
  },
  {
    name: 'hot_iron',
    label: 'Hot Iron',
    gradient: 'linear-gradient(to right, #000, #800, #f00, #ff0, #fff)',
  },
  {
    name: 'red_hot',
    label: 'Red Hot',
    gradient: 'linear-gradient(to right, #000, #f00, #ff0, #fff)',
  },
  {
    name: 's_pet',
    label: 'PET',
    gradient: 'linear-gradient(to right, #000, #066, #0cc, #fc0, #f60, #f00)',
  },
  {
    name: 'perfusion',
    label: 'Perfusion',
    gradient: 'linear-gradient(to right, #00f, #0ff, #0f0, #ff0, #f00)',
  },
  {
    name: 'rainbow_2',
    label: 'Rainbow',
    gradient: 'linear-gradient(to right, #00f, #0ff, #0f0, #ff0, #f00)',
  },
  {
    name: 'suv',
    label: 'SUV',
    gradient: 'linear-gradient(to right, #000, #00f, #0ff, #0f0, #ff0, #f00)',
  },
  {
    name: 'ge_256',
    label: 'GE 256',
    gradient: 'linear-gradient(to right, #000, #00f, #0ff, #0f0, #ff0, #f00, #fff)',
  },
  {
    name: 'ge',
    label: 'GE',
    gradient: 'linear-gradient(to right, #000, #00f, #0ff, #0f0, #ff0, #f00)',
  },
  {
    name: 'siemens',
    label: 'Siemens',
    gradient: 'linear-gradient(to right, #000, #00f, #0ff, #0f0, #ff0, #f00, #fff)',
  },
];

function ColormapMenu({ commandsManager, servicesManager, ...props }) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [currentColormap, setCurrentColormap] = useState('hsv');

  const { cornerstoneViewportService, viewportGridService } = servicesManager.services;

  // 获取当前选中视口的 colormap
  const getCurrentColormap = useCallback(() => {
    try {
      const { activeViewportId } = viewportGridService.getState();
      if (!activeViewportId) return 'hsv';

      const viewport = cornerstoneViewportService.getCornerstoneViewport(activeViewportId);
      if (!viewport || !(viewport instanceof BaseVolumeViewport)) return 'hsv';

      const volumeIds = viewport.getAllVolumeIds();
      if (!volumeIds?.length) return 'hsv';

      // 查找 PT volume
      for (const volId of volumeIds) {
        const vol = cache.getVolume(volId);
        if (vol?.metadata?.Modality === 'PT') {
          const properties = viewport.getProperties?.(volId);
          const colormapName = properties?.colormap?.name;
          if (colormapName) {
            setCurrentColormap(colormapName);
            return colormapName;
          }
        }
      }
      return 'hsv';
    } catch (e) {
      return 'hsv';
    }
  }, [cornerstoneViewportService, viewportGridService]);

  // 初始化时获取当前 colormap
  useEffect(() => {
    getCurrentColormap();
  }, [getCurrentColormap]);

  // 2026-08-31 功能说明：对比模式切换 active viewport 后刷新当前伪彩色状态，避免菜单状态停留在上一侧。
  useEffect(() => {
    const eventName = viewportGridService?.EVENTS?.ACTIVE_VIEWPORT_ID_CHANGED;
    if (!eventName || !viewportGridService?.subscribe) {
      return;
    }

    const subscription = viewportGridService.subscribe(eventName, getCurrentColormap);
    return () => {
      try {
        subscription?.unsubscribe?.();
      } catch {
        // ignore cleanup errors
      }
    };
  }, [getCurrentColormap, viewportGridService]);

  // 切换 colormap
  const handleSelectColormap = colormapName => {
    setIsMenuOpen(false);

    try {
      const { activeViewportId } = viewportGridService.getState();
      if (!activeViewportId) return;

      const viewport = cornerstoneViewportService.getCornerstoneViewport(activeViewportId);
      if (!viewport || !(viewport instanceof BaseVolumeViewport)) return;

      const volumeIds = viewport.getAllVolumeIds();
      if (!volumeIds?.length) return;

      // 查找 PT volume 并设置 colormap
      let ptVolumeId = null;
      for (const volId of volumeIds) {
        const vol = cache.getVolume(volId);
        if (vol?.metadata?.Modality === 'PT') {
          ptVolumeId = volId;
          break;
        }
      }

      if (!ptVolumeId) {
        console.warn('ColormapMenu: 当前视口未找到 PT volume');
        return;
      }

      // 设置 PT volume 的 colormap
      viewport.setProperties(
        {
          colormap: {
            name: colormapName,
            opacity: [
              { value: 0, opacity: 0 },
              { value: 0.1, opacity: 0.8 },
              { value: 1, opacity: 0.9 },
            ],
          },
        },
        ptVolumeId
      );

      viewport.render();
      setCurrentColormap(colormapName);
    } catch (e) {
      console.warn('ColormapMenu: 切换伪彩色失败', e);
    }
  };

  return (
    <div
      id="ColormapMenu"
      data-cy="ColormapMenu"
    >
      <Popover
        open={isMenuOpen}
        onOpenChange={setIsMenuOpen}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <div className="flex h-[56px] flex-col items-center justify-between gap-0 py-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className={`text-foreground/80 hover:bg-background hover:text-highlight inline-flex h-10 w-10 items-center justify-center rounded-lg`}
                  aria-label="伪彩色"
                >
                  <Icons.ByName
                    name="IconColorLUT"
                    className="h-7 w-7"
                  />
                </Button>
                <span className="whitespace-nowrap text-[12px] leading-tight text-white">
                  伪彩色
                </span>
              </div>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <div>伪彩色</div>
          </TooltipContent>
        </Tooltip>
        <PopoverContent
          className="w-64 rounded-lg border-none p-1 shadow-lg"
          align="center"
          sideOffset={8}
          onPointerDown={e => e.stopPropagation()}
          onMouseDown={e => e.stopPropagation()}
          onClick={e => e.stopPropagation()}
        >
          <div className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
            {COLORMAPS.map(colormap => (
              <Button
                key={colormap.name}
                variant="ghost"
                className={`hover:bg-primary-dark flex h-9 w-full items-center justify-between px-3 py-1.5 text-sm ${
                  currentColormap === colormap.name
                    ? 'text-common-bright bg-primary/20'
                    : 'text-gray-400'
                }`}
                onClick={() => handleSelectColormap(colormap.name)}
                onPointerDown={e => e.stopPropagation()}
              >
                <span className="mr-3">{colormap.label}</span>
                <span
                  className="h-4 w-20 rounded-sm border border-white/10"
                  style={{ background: colormap.gradient }}
                />
              </Button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

ColormapMenu.propTypes = {
  commandsManager: PropTypes.object,
  servicesManager: PropTypes.object,
};

export default ColormapMenu;
