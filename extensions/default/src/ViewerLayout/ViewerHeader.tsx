/**
 * ============================================================================
 * ViewerHeader.tsx - 图像查看器头部导航栏
 * 修改日期: 2026-06-17
 * 修改内容:
 *   - 移除 Header 组件的 UndoRedo prop（撤销/重做按钮已移至工具栏 SaveMenu 组件内）
 *   - 避免导航栏和工具栏同时显示两组撤销/重做按钮
 * ============================================================================
 */
import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { Button, Header, Icons, useModal } from '@ohif/ui-next';
import { useSystem } from '@ohif/core';
import { Toolbar } from '../Toolbar/Toolbar';
import HeaderPatientInfo from './HeaderPatientInfo';
import { PatientInfoVisibility } from './HeaderPatientInfo/HeaderPatientInfo';
import { preserveQueryParameters } from '@ohif/app';
import { Types } from '@ohif/core';

function ViewerHeader({ appConfig }: withAppTypes<{ appConfig: AppTypes.Config }>) {
  const { servicesManager, extensionManager, commandsManager } = useSystem();
  const { customizationService } = servicesManager.services;

  const navigate = useNavigate();
  const location = useLocation();

  const onClickReturnButton = () => {
    // [2026-07-28 内存诊断增强] 返回查询界面前后打印内存状态对比，
    // 验证 purgeCache 是否真的释放了 cache 字节、volume/image 条目、pending 请求。
    //
    // 如果 Console 显示 "BEFORE cacheSizeBytes=2500000000, AFTER cacheSizeBytes=0"，
    // 说明 cache 清理成功；此时若 Chrome DevTools 内存快照的 JSArrayBufferData 仍不下降，
    // 说明残留的 ArrayBuffer 被 cache 之外的对象持有（actor/woker/segmentation 等）。
    //
    // 如果 AFTER cacheSizeBytes 仍很大，说明 purgeCache 没真正执行或失败。
    const { cornerstoneViewportService } = servicesManager.services;

    const beforeStats = cornerstoneViewportService?.getMemoryStats?.();
    console.log('[ViewerHeader] Return: BEFORE purgeCache', beforeStats);

    try {
      cornerstoneViewportService?.purgeCache?.();
    } catch (e) {
      console.warn('[ViewerHeader] purgeCache on return failed', e);
    }

    const afterStats = cornerstoneViewportService?.getMemoryStats?.();
    const releasedBytes =
      (beforeStats?.cacheSizeBytes as number) - (afterStats?.cacheSizeBytes as number);
    console.log('[ViewerHeader] Return: AFTER purgeCache', afterStats);
    console.log(
      '[ViewerHeader] Return: RELEASED',
      releasedBytes,
      'bytes =',
      (releasedBytes / 1024 / 1024).toFixed(2),
      'MB | volumes:',
      beforeStats?.volumeCount,
      '→',
      afterStats?.volumeCount,
      '| images:',
      beforeStats?.imageCount,
      '→',
      afterStats?.imageCount,
      '| pendingPool:',
      beforeStats?.pendingPoolRequests,
      '→',
      afterStats?.pendingPoolRequests
    );

    // [关键提示] 此时 renderingEngine 仍存活，actor 仍持有 volume 的 scalarData 引用。
    // cache 已清空，但 actor.mapper.scalarTexture 和 actor.property 的 GPU 资源
    // 要等到 mode.onModeExit() → destroy() 才会释放。
    // 所以这里 cacheSizeBytes=0 不代表 JS Heap 立即下降，需要等 destroy() 完成。
    if (afterStats && (afterStats as any).renderingEngineViewports > 0) {
      console.warn(
        '[ViewerHeader] Return: renderingEngine still has',
        (afterStats as any).renderingEngineViewports,
        'viewports alive — actor scalarData/GPU textures will be released in onModeExit→destroy()'
      );
    }

    const { pathname } = location;
    const dataSourceIdx = pathname.indexOf('/', 1);

    const dataSourceName = pathname.substring(dataSourceIdx + 1);
    const existingDataSource = extensionManager.getDataSources(dataSourceName);

    const searchQuery = new URLSearchParams();
    if (dataSourceIdx !== -1 && existingDataSource) {
      searchQuery.append('datasources', pathname.substring(dataSourceIdx + 1));
    }
    preserveQueryParameters(searchQuery);

    navigate({
      pathname: '/',
      search: decodeURIComponent(searchQuery.toString()),
    });
  };

  const { t } = useTranslation();
  const { show } = useModal();

  const AboutModal = customizationService.getCustomization(
    'ohif.aboutModal'
  ) as Types.MenuComponentCustomization;

  const UserPreferencesModal = customizationService.getCustomization(
    'ohif.userPreferencesModal'
  ) as Types.MenuComponentCustomization;

  const menuOptions = [
    {
      title: AboutModal?.menuTitle ?? t('Header:About'),
      icon: 'info',
      onClick: () =>
        show({
          content: AboutModal,
          title: AboutModal?.title ?? t('AboutModal:About OHIF Viewer'),
          containerClassName: AboutModal?.containerClassName ?? 'max-w-md',
        }),
    },
    {
      title: UserPreferencesModal.menuTitle ?? t('Header:Preferences'),
      icon: 'settings',
      onClick: () =>
        show({
          content: UserPreferencesModal,
          title: UserPreferencesModal.title ?? t('UserPreferencesModal:User preferences'),
          containerClassName:
            UserPreferencesModal?.containerClassName ?? 'flex max-w-4xl p-6 flex-col',
        }),
    },
  ];

  if (appConfig.oidc) {
    menuOptions.push({
      title: t('Header:Logout'),
      icon: 'power-off',
      onClick: async () => {
        navigate(`/logout?redirect_uri=${encodeURIComponent(window.location.href)}`);
      },
    });
  }

  return (
    <Header
      menuOptions={[]}
      isReturnEnabled={!!appConfig.showStudyList}
      onClickReturnButton={onClickReturnButton}
      WhiteLabeling={appConfig.whiteLabeling}
      showLogoText={false}
      Secondary={<Toolbar buttonSection="secondary" />}
    >
      {/* 主工具栏：gap-[12px] 控制按钮组间距，按钮与文字作为整体不分离 */}
      <div className="relative flex justify-center gap-[12px]">
        <Toolbar buttonSection="primary" />
      </div>
    </Header>
  );
}

export default ViewerHeader;
