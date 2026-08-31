import React, { useEffect, useState, useCallback } from 'react';
import PropTypes from 'prop-types';
import i18n from 'i18next';

import {
  InvestigationalUseDialog,
  Button,
  Icons,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  useModal,
} from '@ohif/ui-next';
import { HangingProtocolService, CommandsManager } from '@ohif/core';
import { useAppConfig } from '@state';
import ViewerHeader from './ViewerHeader';
import SidePanelWithServices from '../Components/SidePanelWithServices';
import HeaderPatientInfo from './HeaderPatientInfo';
import { PatientInfoVisibility } from './HeaderPatientInfo/HeaderPatientInfo';
import { Onboarding, ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@ohif/ui-next';
import useResizablePanels from './ResizablePanelsHook';
import usePatientInfo from '../hooks/usePatientInfo';

const resizableHandleClassName = 'mt-[1px] bg-background';

function ViewerLayout({
  // From Extension Module Params
  extensionManager,
  servicesManager,
  hotkeysManager,
  commandsManager,
  // From Modes
  viewports,
  ViewportGridComp,
  leftPanelClosed = false,
  rightPanelClosed = false,
  leftPanelResizable = false,
  rightPanelResizable = false,
  leftPanelInitialExpandedWidth,
  rightPanelInitialExpandedWidth,
  leftPanelMinimumExpandedWidth,
  rightPanelMinimumExpandedWidth,
}: withAppTypes): React.FunctionComponent {
  const [appConfig] = useAppConfig();

  const { panelService, hangingProtocolService, customizationService, displaySetService } =
    servicesManager.services;
  const TopBarComparisonSideSelector = customizationService.getCustomization(
    'tmtv.comparisonSideSelector'
  ) as React.ComponentType<{ servicesManager: any }> | null;
  const { patientInfo } = usePatientInfo();

  // 获取检查号(AccessionNumber)
  const [accessionNumber, setAccessionNumber] = useState('');
  useEffect(() => {
    const displaySets = displaySetService.getActiveDisplaySets();
    if (displaySets?.length > 0) {
      const instance = displaySets[0]?.instances?.[0] || displaySets[0]?.instance;
      if (instance?.AccessionNumber) {
        setAccessionNumber(instance.AccessionNumber);
      }
    }
    // 监听显示集变化
    const subscription = displaySetService.subscribe(
      displaySetService.EVENTS.DISPLAY_SETS_ADDED,
      ({ displaySetsAdded }) => {
        if (displaySetsAdded?.length > 0) {
          const instance = displaySetsAdded[0]?.instances?.[0] || displaySetsAdded[0]?.instance;
          if (instance?.AccessionNumber) {
            setAccessionNumber(instance.AccessionNumber);
          }
        }
      }
    );
    return () => subscription.unsubscribe();
  }, [displaySetService]);
  const [showLoadingIndicator, setShowLoadingIndicator] = useState(appConfig.showLoadingIndicator);

  const hasPanels = useCallback(
    (side): boolean => !!panelService.getPanels(side).length,
    [panelService]
  );

  const [hasRightPanels, setHasRightPanels] = useState(hasPanels('right'));
  const [hasLeftPanels, setHasLeftPanels] = useState(hasPanels('left'));
  const [leftPanelClosedState, setLeftPanelClosed] = useState(leftPanelClosed);
  const [rightPanelClosedState, setRightPanelClosed] = useState(rightPanelClosed);

  const [
    leftPanelProps,
    rightPanelProps,
    resizablePanelGroupProps,
    resizableLeftPanelProps,
    resizableViewportGridPanelProps,
    resizableRightPanelProps,
    onHandleDragging,
  ] = useResizablePanels(
    leftPanelClosed,
    setLeftPanelClosed,
    rightPanelClosed,
    setRightPanelClosed,
    hasLeftPanels,
    hasRightPanels,
    leftPanelInitialExpandedWidth,
    rightPanelInitialExpandedWidth,
    leftPanelMinimumExpandedWidth,
    rightPanelMinimumExpandedWidth
  );

  const handleMouseEnter = () => {
    (document.activeElement as HTMLElement)?.blur();
  };

  const LoadingIndicatorProgress = customizationService.getCustomization(
    'ui.loadingIndicatorProgress'
  );

  /**
   * Set body classes (tailwindcss) that don't allow vertical
   * or horizontal overflow (no scrolling). Also guarantee window
   * is sized to our viewport.
   */
  useEffect(() => {
    document.body.classList.add('bg-background');
    document.body.classList.add('overflow-hidden');

    return () => {
      document.body.classList.remove('bg-background');
      document.body.classList.remove('overflow-hidden');
    };
  }, []);

  const getComponent = id => {
    const entry = extensionManager.getModuleEntry(id);

    if (!entry || !entry.component) {
      throw new Error(
        `${id} is not valid for an extension module or no component found from extension ${id}. Please verify your configuration or ensure that the extension is properly registered. It's also possible that your mode is utilizing a module from an extension that hasn't been included in its dependencies (add the extension to the "extensionDependencies" array in your mode's index.js file). Check the reference string to the extension in your Mode configuration`
      );
    }

    return { entry };
  };

  useEffect(() => {
    const { unsubscribe } = hangingProtocolService.subscribe(
      HangingProtocolService.EVENTS.PROTOCOL_CHANGED,

      // Todo: right now to set the loading indicator to false, we need to wait for the
      // hangingProtocolService to finish applying the viewport matching to each viewport,
      // however, this might not be the only approach to set the loading indicator to false. we need to explore this further.
      () => {
        setShowLoadingIndicator(false);
      }
    );

    return () => {
      unsubscribe();
    };
  }, [hangingProtocolService]);

  const getViewportComponentData = viewportComponent => {
    const { entry } = getComponent(viewportComponent.namespace);

    return {
      component: entry.component,
      isReferenceViewable: entry.isReferenceViewable,
      displaySetsToDisplay: viewportComponent.displaySetsToDisplay,
    };
  };

  useEffect(() => {
    const { unsubscribe } = panelService.subscribe(
      panelService.EVENTS.PANELS_CHANGED,
      ({ options }) => {
        setHasLeftPanels(hasPanels('left'));
        setHasRightPanels(hasPanels('right'));
        if (options?.leftPanelClosed !== undefined) {
          setLeftPanelClosed(options.leftPanelClosed);
        }
        if (options?.rightPanelClosed !== undefined) {
          setRightPanelClosed(options.rightPanelClosed);
        }
      }
    );

    return () => {
      unsubscribe();
    };
  }, [panelService, hasPanels]);

  const viewportComponents = viewports.map(getViewportComponentData);

  return (
    <div>
      {/* 顶部患者信息导航栏 */}
      <div className="bg-topbar border-background flex h-[32px] items-center justify-between border-b px-4">
        <div className="flex items-center gap-6">
          {/* 东华医为 Logo */}
          <span
            className="font-bold text-white"
            style={{ fontSize: '18px' }}
          >
            东华医为
          </span>
          {/* 患者姓名 */}
          <span className="text-sm text-white">{patientInfo.PatientName || '-'}</span>
          {/* 性别/出生日期 */}
          <span className="text-sm text-gray-300">
            {patientInfo.PatientSex || '-'} / {patientInfo.PatientDOB || '-'}
          </span>
        </div>
        <div className="flex items-center gap-4">
          {/* 患者编号 */}
          <span className="text-sm text-gray-300">
            患者编号：<span className="text-white">{patientInfo.PatientID || '-'}</span>
          </span>
          {/* 检查号 */}
          <span className="text-sm text-gray-300">
            检查号：<span className="text-white">{accessionNumber || '-'}</span>
          </span>
          {/* 2026-08-31 功能说明：TMTV 对比模式当前检查切换插槽，普通模式不渲染。 */}
          {TopBarComparisonSideSelector && (
            <TopBarComparisonSideSelector servicesManager={servicesManager} />
          )}
          {/* 语言切换、患者信息、设置 - 从工具栏移至此处 */}
          <TopBarActions
            servicesManager={servicesManager}
            appConfig={appConfig}
          />
        </div>
      </div>
      <ViewerHeader
        hotkeysManager={hotkeysManager}
        extensionManager={extensionManager}
        servicesManager={servicesManager}
        appConfig={appConfig}
      />
      <div
        className="bg-background relative flex w-full flex-row flex-nowrap items-stretch overflow-hidden"
        style={{ height: 'calc(100vh - 88px)' }}
      >
        <React.Fragment>
          {showLoadingIndicator && (
            <LoadingIndicatorProgress className="bg-background h-full w-full" />
          )}
          <ResizablePanelGroup {...resizablePanelGroupProps}>
            {/* LEFT SIDEPANELS */}
            {hasLeftPanels ? (
              <>
                <ResizablePanel {...resizableLeftPanelProps}>
                  <SidePanelWithServices
                    side="left"
                    isExpanded={!leftPanelClosedState}
                    servicesManager={servicesManager}
                    {...leftPanelProps}
                  />
                </ResizablePanel>
                <ResizableHandle
                  onDragging={onHandleDragging}
                  disabled={!leftPanelResizable}
                  className={resizableHandleClassName}
                />
              </>
            ) : null}
            {/* TOOLBAR + GRID */}
            <ResizablePanel {...resizableViewportGridPanelProps}>
              <div className="flex h-full flex-1 flex-col">
                <div
                  className="bg-background relative flex h-full flex-1 items-center justify-center overflow-hidden"
                  onMouseEnter={handleMouseEnter}
                >
                  <ViewportGridComp
                    servicesManager={servicesManager}
                    viewportComponents={viewportComponents}
                    commandsManager={commandsManager}
                  />
                </div>
              </div>
            </ResizablePanel>
            {hasRightPanels ? (
              <>
                <ResizableHandle
                  onDragging={onHandleDragging}
                  disabled={!rightPanelResizable}
                  className={resizableHandleClassName}
                />
                <ResizablePanel {...resizableRightPanelProps}>
                  <SidePanelWithServices
                    side="right"
                    isExpanded={!rightPanelClosedState}
                    servicesManager={servicesManager}
                    {...rightPanelProps}
                  />
                </ResizablePanel>
              </>
            ) : null}
          </ResizablePanelGroup>
        </React.Fragment>
      </div>
      <Onboarding tours={customizationService.getCustomization('ohif.tours')} />
      <InvestigationalUseDialog dialogConfiguration={appConfig?.investigationalUseDialog} />
    </div>
  );
}

// 顶部导航栏右侧操作组件（语言切换、患者信息、设置）
function TopBarActions({
  servicesManager,
  appConfig,
  hideSettings = false,
}: {
  servicesManager: any;
  appConfig: any;
  hideSettings?: boolean;
}) {
  const { customizationService } = servicesManager.services;
  const { show } = useModal();
  const currentLanguage = i18n.language || 'en-US';

  const handleLanguageChange = (langValue: string) => {
    i18n.changeLanguage(langValue);
    window.location.reload();
  };

  return (
    <div className="flex items-center gap-3">
      {/* 语言切换 */}
      <div className="border-primary-light/30 flex items-center gap-1 rounded border px-2 py-0.5">
        <span className="text-primary-light text-xs">语</span>
        <button
          onClick={() => handleLanguageChange('zh')}
          className={`rounded px-1.5 py-0.5 text-xs font-medium transition-colors ${
            currentLanguage === 'zh' || currentLanguage.startsWith('zh')
              ? 'bg-primary-active text-white'
              : 'text-primary-light hover:text-white'
          }`}
        >
          中文
        </button>
        <button
          onClick={() => handleLanguageChange('en-US')}
          className={`rounded px-1.5 py-0.5 text-xs font-medium transition-colors ${
            currentLanguage === 'en-US'
              ? 'bg-primary-active text-white'
              : 'text-primary-light hover:text-white'
          }`}
        >
          English
        </button>
      </div>

      {/* 患者信息 */}
      {appConfig.showPatientInfo !== PatientInfoVisibility.DISABLED && (
        <HeaderPatientInfo
          servicesManager={servicesManager}
          appConfig={appConfig}
        />
      )}

      {/* 设置（可选隐藏） */}
      {!hideSettings && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="text-primary-light h-8 w-8 hover:text-white"
            >
              <Icons.GearSettings />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {/* 偏好 */}
            {(() => {
              const UserPreferencesModal = customizationService.getCustomization(
                'ohif.userPreferencesModal'
              );
              return UserPreferencesModal ? (
                <DropdownMenuItem
                  onSelect={() =>
                    show({
                      content: UserPreferencesModal,
                      title: '用户偏好',
                      containerClassName: 'flex max-w-4xl p-6 flex-col',
                    })
                  }
                  className="flex items-center gap-2 py-2"
                >
                  <Icons.ByName name="settings" />
                  <span>偏好</span>
                </DropdownMenuItem>
              ) : null;
            })()}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

ViewerLayout.propTypes = {
  // From extension module params
  extensionManager: PropTypes.shape({
    getModuleEntry: PropTypes.func.isRequired,
  }).isRequired,
  commandsManager: PropTypes.instanceOf(CommandsManager),
  servicesManager: PropTypes.object.isRequired,
  // From modes
  leftPanels: PropTypes.array,
  rightPanels: PropTypes.array,
  leftPanelClosed: PropTypes.bool.isRequired,
  rightPanelClosed: PropTypes.bool.isRequired,
  /** Responsible for rendering our grid of viewports; provided by consuming application */
  children: PropTypes.oneOfType([PropTypes.node, PropTypes.func]).isRequired,
  viewports: PropTypes.array,
};

export default ViewerLayout;
