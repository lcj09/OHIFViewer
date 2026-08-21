// [2026-08-06 新增, 2026-08-20 修改] 同步设置菜单组件
//
// 功能：通过下拉菜单控制视口间的同步行为
// 下拉菜单包含：
//   1. 同步方位切换 - 控制方位切换是否同步到同组其他视口（cameraPosition 同步器）
//   2. 同步调窗变化 - 控制窗宽窗位变化是否同步（voi 同步器）
//   3. 同步缩放     - 控制缩放是否同步（zoomSync 同步器，懒创建）
//
// 状态存储：使用 customizationService 的 'syncSettings' 存储
//   { orientationSync: true, voiSync: true, zoomSync: false }
//
// [2026-08-20 修复] 缩放同步必须"懒创建"，不能静态注册到 hangingProtocol：
//   之前把 zoompan 同步组静态加入 hpViewports 的 syncGroups，视口创建即挂接
//   CAMERA_MODIFIED 监听。体积流式加载期间每次相机变化都会强制 setZoom/setPan
//   + render()，而此阶段 initialCamera 可能未就绪，getZoom() 会返回非法值（NaN），
//   污染相机导致 WebGL uniformMatrix3fv: no array 及图像加载失败。
//   改为：仅当用户手动打开"同步缩放"开关时才创建并挂接所有视口
//   （此时视口已加载完成），未开启时不创建任何 zoompan 同步器。
//   [2026-08-20 更新] 应产品要求移除"同步移动"选项，不再支持 pan 同步。
//
// [2026-08-20 注意] customizationService.setCustomizations 对不含 $ 指令的对象是整体替换，
//   因此每次切换任一开关时都必须写入完整的 syncSettings 对象，避免覆盖其他开关状态。

import React, { useState, useEffect, useCallback } from 'react';
import PropTypes from 'prop-types';
import { getRenderingEngines } from '@cornerstonejs/core';
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
  const [voiSync, setVoiSync] = useState(true);
  const [zoomSync, setZoomSync] = useState(false);

  const { customizationService } = servicesManager.services;

  // [2026-08-20 新增] 启用/禁用指定同步器
  // type 按类型获取（如 'voi'），id 按 id 获取（如 'zoomSync'）
  const applySyncEnabled = useCallback(
    (type, id, enabled) => {
      const { syncGroupService } = servicesManager.services;
      try {
        let syncs = [];
        if (type) {
          syncs = syncGroupService.getSynchronizersOfType(type) || [];
        } else if (id) {
          const s = syncGroupService.getSynchronizer(id);
          if (s) syncs = [s];
        }
        syncs.forEach(s => {
          try {
            s.setEnabled(enabled);
          } catch { /* ignore */ }
        });
      } catch (e) {
        console.warn('[SyncMenu] 设置同步器状态失败', e);
      }
    },
    [servicesManager]
  );

  // [2026-08-20 新增] 懒创建 zoompan 同步器并挂接当前所有视口
  // 仅在用户开启"同步缩放"或布局切换后需要重新应用时调用（此时视口已加载完成）。
  // 通过公开 API addViewportToSyncGroup 创建/复用同步器，幂等：已存在的视口不会被重复添加。
  const ensureZoomPanSync = useCallback(
    (syncId, options) => {
      const { syncGroupService, cornerstoneViewportService } = servicesManager.services;
      try {
        const vpIds = cornerstoneViewportService.getViewportIds() || [];
        vpIds.forEach(vpId => {
          const renderingEngine = getRenderingEngines().find(re =>
            re.getViewports().some(vp => vp.id === vpId)
          );
          if (!renderingEngine) return;
          try {
            syncGroupService.addViewportToSyncGroup(vpId, renderingEngine.id, [
              {
                type: 'zoompan',
                id: syncId,
                source: true,
                target: true,
                options,
              },
            ]);
          } catch { /* ignore */ }
        });
      } catch (e) {
        console.warn(`[SyncMenu] 创建同步器 ${syncId} 失败`, e);
      }
    },
    [servicesManager]
  );

  // [2026-08-20 新增] 将持久化的同步设置应用到同步器
  // 在组件挂载和视口（重新）创建后调用，确保开关状态与同步器实际状态一致。
  // 缩放仅在开启时创建同步器（懒创建），关闭时禁用；开启时需确保同步器被启用
  // （因为布局切换重建同步器后，新建的同步器默认启用，但上次关闭时被禁用的需恢复）。
  const applyCurrentSyncSettings = useCallback(() => {
    try {
      const syncSettings = customizationService.getCustomization('syncSettings') || {};
      const voiOn = syncSettings.voiSync !== false;
      const zoomOn = syncSettings.zoomSync === true;

      applySyncEnabled('voi', null, voiOn);

      if (zoomOn) {
        ensureZoomPanSync('zoomSync', { syncPan: false });
        applySyncEnabled(null, 'zoomSync', true);
      } else {
        applySyncEnabled(null, 'zoomSync', false);
      }
    } catch (e) {
      console.warn('[SyncMenu] 应用同步设置失败', e);
    }
  }, [applySyncEnabled, ensureZoomPanSync, customizationService]);

  // [2026-08-20 新增] 持久化同步设置（必须写完整对象，见文件头注释）
  const persistSyncSettings = useCallback(
    next => {
      try {
        customizationService.setCustomizations({
          syncSettings: {
            orientationSync,
            voiSync,
            zoomSync,
            ...next,
          },
        });
      } catch (e) {
        console.warn('[SyncMenu] 保存同步状态失败', e);
      }
    },
    [orientationSync, voiSync, zoomSync, customizationService]
  );

  // [2026-08-06, 2026-08-20 修改] 初始化：从 customizationService 读取同步状态并应用到同步器
  useEffect(() => {
    try {
      const syncSettings = customizationService.getCustomization('syncSettings');
      if (syncSettings) {
        if (typeof syncSettings.orientationSync === 'boolean') {
          setOrientationSync(syncSettings.orientationSync);
        }
        if (typeof syncSettings.voiSync === 'boolean') {
          setVoiSync(syncSettings.voiSync);
        }
        if (typeof syncSettings.zoomSync === 'boolean') {
          setZoomSync(syncSettings.zoomSync);
        }
      } else {
        customizationService.setCustomizations({
          syncSettings: {
            orientationSync: true,
            voiSync: true,
            zoomSync: false,
          },
        });
      }
      // 挂载时尝试应用同步器状态（此时同步器/视口可能尚未创建，视口创建后由 PROTOCOL_CHANGED 再应用一次）
      applyCurrentSyncSettings();
    } catch (e) {
      console.warn('[SyncMenu] 初始化同步状态失败', e);
    }
  }, [customizationService, applyCurrentSyncSettings]);

  // [2026-08-20 新增] 布局切换（PROTOCOL_CHANGED）后视口重新创建，重新应用同步器开关状态
  useEffect(() => {
    const { hangingProtocolService } = servicesManager.services;
    if (!hangingProtocolService) {
      return;
    }
    let timer = null;
    let unsub = null;
    try {
      const subscription = hangingProtocolService.subscribe(
        hangingProtocolService.EVENTS.PROTOCOL_CHANGED,
        () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            timer = null;
            applyCurrentSyncSettings();
          }, 300);
        }
      );
      unsub = subscription.unsubscribe;
    } catch (e) {
      console.warn('[SyncMenu] 订阅 PROTOCOL_CHANGED 失败', e);
    }
    return () => {
      // [内存排查] 组件卸载前清理定时器和订阅，避免异步回调在卸载后执行
      if (timer) clearTimeout(timer);
      try {
        unsub?.();
      } catch { /* ignore */ }
    };
  }, [servicesManager, applyCurrentSyncSettings]);

  // [2026-08-06, 2026-08-10 修改, 2026-08-11 修改] 切换方位同步开关
  // 开启时：恢复所有 cameraPosition 同步器（幂等，setViewportOrientation 已恢复）
  //   [2026-08-10] setViewportOrientation 已改为切换方位期间临时禁用、
  //   切换完成后立即恢复同步器，不再永久禁用。此处的恢复逻辑保留作为兜底，
  //   确保用户重新开启同步时所有同步器都处于启用状态。
  //   [2026-08-11] setViewportOrientation 在 orientationSync=false 时会从同步器中
  //   移除该视口的 source 角色（保留 target）。此处重新开启同步时需要把 source
  //   加回去，否则滚轮滚动该视口不会触发同步。
  const handleToggleOrientationSync = useCallback(() => {
    const newState = !orientationSync;
    setOrientationSync(newState);
    try {
      persistSyncSettings({ orientationSync: newState });

      // [2026-08-07] 重新开启同步时，恢复所有 cameraPosition 同步器
      // [2026-08-11] setViewportOrientation 在 orientationSync=false 时会从同步组中
      //   完全移除该视口（remove source 和 target）。此处重新开启同步时需要把
      //   source 和 target 都加回去，否则滚轮滚动该视口不会触发同步，
      //   且其他视口滚动时该视口也不会接收同步。
      //   注意：必须用 getSynchronizersOfType 获取所有 cameraPosition 同步器，
      //   而非 getSynchronizersForViewport（后者只返回视口当前所在的同步器，
      //   已被 remove 的视口会返回空数组）。
      if (newState) {
        const { syncGroupService, cornerstoneViewportService } =
          servicesManager.services;
        try {
          const vpIds = cornerstoneViewportService.getViewportIds() || [];
          // 获取所有 cameraPosition 同步器
          const camSyncs = syncGroupService.getSynchronizersOfType('cameraPosition') || [];
          camSyncs.forEach(s => {
            // 启用同步器
            try { s.setEnabled(true); } catch { /* ignore */ }
            // 遍历所有视口，把被移除的加回去
            vpIds.forEach(vpId => {
              const renderingEngine =
                getRenderingEngines().find(re =>
                  re.getViewports().some(vp => vp.id === vpId)
                );
              if (!renderingEngine) return;
              const viewportInfo = { renderingEngineId: renderingEngine.id, viewportId: vpId };
              // 如果该视口既不在 source 也不在 target，重新加回去
              if (!s.hasSourceViewport(renderingEngine.id, vpId) &&
                  !s.hasTargetViewport(renderingEngine.id, vpId)) {
                try { s.add(viewportInfo); } catch { /* ignore */ }
              }
            });
          });
        } catch (e) {
          console.warn('[SyncMenu] 恢复同步器失败', e);
        }
      }
    } catch (e) {
      console.warn('[SyncMenu] 保存同步状态失败', e);
    }
  }, [orientationSync, persistSyncSettings, servicesManager]);

  // [2026-08-20 新增] 切换调窗同步开关（作用于已注册的 voi 同步器，安全）
  const handleToggleVoiSync = useCallback(() => {
    const newState = !voiSync;
    setVoiSync(newState);
    try {
      persistSyncSettings({ voiSync: newState });
      applySyncEnabled('voi', null, newState);
    } catch (e) {
      console.warn('[SyncMenu] 切换调窗同步失败', e);
    }
  }, [voiSync, persistSyncSettings, applySyncEnabled]);

  // [2026-08-20 新增] 切换缩放同步开关（懒创建 zoompan 同步器，避免影响图像加载）
  const handleToggleZoomSync = useCallback(() => {
    const newState = !zoomSync;
    setZoomSync(newState);
    try {
      persistSyncSettings({ zoomSync: newState });
      if (newState) {
        ensureZoomPanSync('zoomSync', { syncPan: false });
        applySyncEnabled(null, 'zoomSync', true);
      } else {
        applySyncEnabled(null, 'zoomSync', false);
      }
    } catch (e) {
      console.warn('[SyncMenu] 切换缩放同步失败', e);
    }
  }, [zoomSync, persistSyncSettings, ensureZoomPanSync, applySyncEnabled]);

  // [2026-08-20 新增] 渲染单个同步开关项，保持菜单项样式统一
  const renderToggleItem = (checked, label, onClick) => (
    <Button
      variant="ghost"
      className={`flex h-8 w-full items-center justify-start px-2 py-1 text-sm hover:bg-primary-dark ${
        checked ? 'text-highlight' : 'text-gray-400'
      }`}
      onClick={onClick}
      onPointerDown={e => e.stopPropagation()}
    >
      <span className="mr-2 inline-block w-4 text-center">{checked ? '✓' : ''}</span>
      {label}
    </Button>
  );

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
            {renderToggleItem(orientationSync, '同步方位切换', handleToggleOrientationSync)}
            {/* [2026-08-20 新增] 同步调窗变化 */}
            {renderToggleItem(voiSync, '同步调窗变化', handleToggleVoiSync)}
            {/* [2026-08-20 新增] 同步缩放 */}
            {renderToggleItem(zoomSync, '同步缩放', handleToggleZoomSync)}
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
