// [2026-07-08 新增] SUV阈值下拉菜单组件
//
// 功能：通过下拉菜单快速设置PET/Fusion视口的SUV窗位
// 选项：体部 (SUV=6)、头部 (SUV=10)、自定义（弹框输入）
// 点击后以所选SUV值为窗位(L)，窗宽(W = 2 × SUV值)，调整图像显示

import React, { useState, useEffect, useCallback, useRef } from 'react';
import PropTypes from 'prop-types';
import { Popover, PopoverTrigger, PopoverContent, Button, Icons } from '@ohif/ui-next';
import { cache, BaseVolumeViewport, utilities as csUtils } from '@cornerstonejs/core';

// SUV阈值预设列表（窗宽W = 2 × SUV值，显示范围从0开始）
const SUV_PRESETS = [
  { id: 'body', label: 'Body', suvValue: 6, windowWidth: 12 },
  { id: 'head', label: 'Head', suvValue: 10, windowWidth: 20 },
];

// 应用SUV阈值到所有包含PT volume的视口（PET、Fusion、MIP）
function applySuvThresholdToAll(
  suvValue,
  windowWidth,
  cornerstoneViewportService,
  viewportGridService,
  toolGroupService
) {
  const { lower, upper } = csUtils.windowLevel.toLowHighRange(windowWidth, suvValue);

  // 获取所有相关的 toolGroup
  const toolGroupNames = ['ctToolGroup', 'ptToolGroup', 'fusionToolGroup', 'mipToolGroup'];

  for (const toolGroupName of toolGroupNames) {
    try {
      const toolGroup = toolGroupService.getToolGroup(toolGroupName);
      if (!toolGroup) continue;

      const viewportIds = toolGroup.getViewportIds();

      for (const viewportId of viewportIds) {
        try {
          const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);
          if (!viewport || !(viewport instanceof BaseVolumeViewport)) continue;

          const volumeIds = viewport.getAllVolumeIds();
          if (!volumeIds?.length) continue;

          for (const volId of volumeIds) {
            const vol = cache.getVolume(volId);
            if (vol?.metadata?.Modality === 'PT') {
              viewport.setProperties(
                {
                  voiRange: { lower, upper },
                },
                volId
              );
              viewport.render();
              break;
            }
          }
        } catch (e) {
          // 忽略无效视口
        }
      }
    } catch (e) {
      // 忽略无效 toolGroup
    }
  }
}

// 获取当前视口的PT volume信息
function getPTVolumeInfo(viewport) {
  const volumeIds = viewport.getAllVolumeIds();
  if (!volumeIds?.length) return null;

  for (const volId of volumeIds) {
    const vol = cache.getVolume(volId);
    if (vol?.metadata?.Modality === 'PT') {
      return { ptVolumeId: volId, volumeIds };
    }
  }
  return null;
}

function SuvThresholdMenu({ commandsManager, servicesManager, ...props }) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [currentPreset, setCurrentPreset] = useState(null);
  const [customSuvValue, setCustomSuvValue] = useState('');
  const [showCustomInput, setShowCustomInput] = useState(false);
  const inputRef = useRef(null);

  const { cornerstoneViewportService, viewportGridService, toolGroupService } =
    servicesManager.services;

  // 获取当前视口的窗位，判断是否匹配某个预设
  const getCurrentPreset = useCallback(() => {
    try {
      const { activeViewportId } = viewportGridService.getState();
      if (!activeViewportId) return null;

      const viewport = cornerstoneViewportService.getCornerstoneViewport(activeViewportId);
      if (!viewport || !(viewport instanceof BaseVolumeViewport)) return null;

      const volumeIds = viewport.getAllVolumeIds();
      if (!volumeIds?.length) return null;

      for (const volId of volumeIds) {
        const vol = cache.getVolume(volId);
        if (vol?.metadata?.Modality === 'PT') {
          const properties = viewport.getProperties?.(volId);
          const voiRange = properties?.voiRange;
          if (voiRange) {
            const windowWidth = voiRange.upper - voiRange.lower;
            const windowCenter = (voiRange.upper + voiRange.lower) / 2;
            // 检查是否匹配某个预设（窗位和窗宽都匹配）
            const matched = SUV_PRESETS.find(
              p =>
                Math.abs(windowCenter - p.suvValue) < 0.1 &&
                Math.abs(windowWidth - p.windowWidth) < 0.5
            );
            if (matched) {
              setCurrentPreset(matched);
            } else if (Math.abs(windowWidth - 2 * windowCenter) < 0.5 && windowCenter > 0) {
              // 匹配自定义模式（W ≈ 2 × L）
              setCurrentPreset({
                id: 'custom',
                label: 'Custom',
                suvValue: Math.round(windowCenter * 10) / 10,
                windowWidth: Math.round(windowWidth * 10) / 10,
              });
            } else {
              setCurrentPreset(null);
            }
            return matched;
          }
        }
      }
      return null;
    } catch (e) {
      return null;
    }
  }, [cornerstoneViewportService, viewportGridService]);

  useEffect(() => {
    getCurrentPreset();
  }, [getCurrentPreset]);

  // 2026-08-31 功能说明：对比模式切换 active viewport 后刷新 SUV 阈值菜单状态。
  useEffect(() => {
    const eventName = viewportGridService?.EVENTS?.ACTIVE_VIEWPORT_ID_CHANGED;
    if (!eventName || !viewportGridService?.subscribe) {
      return;
    }

    const subscription = viewportGridService.subscribe(eventName, getCurrentPreset);
    return () => {
      try {
        subscription?.unsubscribe?.();
      } catch {
        // ignore cleanup errors
      }
    };
  }, [getCurrentPreset, viewportGridService]);

  // 点击自定义时展开输入框
  const handleCustomClick = () => {
    setShowCustomInput(true);
    setCustomSuvValue('');
    setTimeout(() => {
      inputRef.current?.focus();
    }, 50);
  };

  // 确认自定义SUV值
  const handleCustomConfirm = () => {
    const suvValue = parseFloat(customSuvValue);
    if (isNaN(suvValue) || suvValue <= 0) {
      return;
    }

    try {
      const windowWidth = suvValue * 2;
      applySuvThresholdToAll(
        suvValue,
        windowWidth,
        cornerstoneViewportService,
        viewportGridService,
        toolGroupService
      );
      setCurrentPreset({ id: 'custom', label: 'Custom', suvValue, windowWidth });
    } catch (e) {
      console.warn('SuvThresholdMenu: 设置SUV阈值失败', e);
    }

    setShowCustomInput(false);
    setIsMenuOpen(false);
  };

  // 选择预设SUV阈值
  const handleSelectPreset = preset => {
    setShowCustomInput(false);

    try {
      applySuvThresholdToAll(
        preset.suvValue,
        preset.windowWidth,
        cornerstoneViewportService,
        viewportGridService,
        toolGroupService
      );
      setCurrentPreset(preset);
    } catch (e) {
      console.warn('SuvThresholdMenu: 设置SUV阈值失败', e);
    }

    setIsMenuOpen(false);
  };

  // 关闭菜单时重置自定义输入状态
  const handleOpenChange = open => {
    setIsMenuOpen(open);
    if (!open) {
      setShowCustomInput(false);
      setCustomSuvValue('');
    }
  };

  return (
    <div
      id="SuvThresholdMenu"
      data-cy="SuvThresholdMenu"
    >
      <Popover
        open={isMenuOpen}
        onOpenChange={handleOpenChange}
      >
        <PopoverTrigger asChild>
          <div className="flex h-[56px] flex-col items-center justify-between gap-0 py-1">
            <Button
              variant="ghost"
              size="icon"
              className={`text-foreground/80 hover:bg-background hover:text-highlight inline-flex h-10 w-10 items-center justify-center rounded-lg`}
              aria-label="SUV Threshold"
            >
              <Icons.ByName
                name="Threshold"
                className="h-7 w-7"
              />
            </Button>
            <span className="whitespace-nowrap text-[12px] leading-tight text-white">SUV阈值</span>
          </div>
        </PopoverTrigger>
        <PopoverContent
          className="w-48 rounded-lg border-none p-1 shadow-lg"
          align="center"
          sideOffset={8}
          onPointerDown={e => e.stopPropagation()}
          onMouseDown={e => e.stopPropagation()}
          onClick={e => e.stopPropagation()}
        >
          <div className="flex flex-col gap-0.5">
            {SUV_PRESETS.map(preset => (
              <Button
                key={preset.id}
                variant="ghost"
                className={`hover:bg-primary-dark flex h-9 w-full items-center justify-between px-3 py-1.5 text-sm ${
                  currentPreset?.id === preset.id
                    ? 'text-common-bright bg-primary/20'
                    : 'text-gray-400'
                }`}
                onClick={() => handleSelectPreset(preset)}
                onPointerDown={e => e.stopPropagation()}
              >
                <span>{preset.label}</span>
                <span className="text-xs text-gray-500">SUV={preset.suvValue}</span>
              </Button>
            ))}
            {/* 自定义选项 */}
            {!showCustomInput ? (
              <Button
                variant="ghost"
                className={`hover:bg-primary-dark flex h-9 w-full items-center justify-between px-3 py-1.5 text-sm ${
                  currentPreset?.id === 'custom'
                    ? 'text-common-bright bg-primary/20'
                    : 'text-gray-400'
                }`}
                onClick={handleCustomClick}
                onPointerDown={e => e.stopPropagation()}
              >
                <span>Custom</span>
                <span className="text-xs text-gray-500">
                  {currentPreset?.id === 'custom' ? `SUV=${currentPreset.suvValue}` : ''}
                </span>
              </Button>
            ) : (
              <div className="flex items-center gap-1 px-2 py-1.5">
                <span className="whitespace-nowrap text-xs text-gray-400">SUV</span>
                <input
                  ref={inputRef}
                  type="number"
                  min="0.1"
                  step="0.5"
                  value={customSuvValue}
                  onChange={e => setCustomSuvValue(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleCustomConfirm();
                    } else if (e.key === 'Escape') {
                      setShowCustomInput(false);
                      setCustomSuvValue('');
                    }
                  }}
                  className="focus:border-highlight h-7 w-16 rounded border border-white/20 bg-black/30 px-1.5 text-xs text-white outline-none"
                  placeholder="0.0"
                />
                <button
                  type="button"
                  className="text-highlight hover:bg-primary-dark h-7 min-w-[44px] shrink-0 rounded px-2 text-xs"
                  onClick={e => {
                    e.stopPropagation();
                    e.preventDefault();
                    handleCustomConfirm();
                  }}
                  onPointerDown={e => e.stopPropagation()}
                  onMouseDown={e => e.stopPropagation()}
                >
                  确定
                </button>
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

SuvThresholdMenu.propTypes = {
  commandsManager: PropTypes.object,
  servicesManager: PropTypes.object,
};

export default SuvThresholdMenu;
