import React from 'react';
import { PanelPetSUV, PanelROIThresholdExport } from './Panels';
import { Toolbox } from '@ohif/extension-default';
import PanelTMTV from './Panels/PanelTMTV';
import i18n from '@ohif/i18n';

function getPanelModule({ commandsManager, extensionManager, servicesManager }) {
  const { toolbarService } = servicesManager.services;

  const wrappedPanelPetSuv = () => {
    return <PanelPetSUV />;
  };

  const wrappedROIThresholdToolbox = () => {
    return (
      <>
        {/* [2026-08-26 功能] TMTV 右侧面板使用紧凑 toolbox，减少工具区占用高度 */}
        <Toolbox
          buttonSectionId={toolbarService.sections.roiThresholdToolbox}
          title={i18n.t('ROIThresholdConfiguration:Threshold Tools')}
          compact
          defaultOpen={false}
        />
      </>
    );
  };

  const wrappedROIThresholdExport = () => {
    return <PanelROIThresholdExport />;
  };

  const wrappedPanelTMTV = () => {
    return (
      // [2026-08-26 功能] 商业软件式右侧布局：工具区、Lesion 主区、高级数据区共享同一个 flex 高度，避免折叠栏悬浮/重叠
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        {/* [2026-08-26 功能] TMTV 右侧面板使用紧凑 toolbox，减少工具区占用高度 */}
        <Toolbox
          buttonSectionId={toolbarService.sections.roiThresholdToolbox}
          title={i18n.t('ROIThresholdConfiguration:Threshold Tools')}
          compact
          defaultOpen={false}
        />
        <PanelTMTV
          commandsManager={commandsManager}
          servicesManager={servicesManager}
        />
      </div>
    );
  };

  return [
    {
      name: 'petSUV',
      iconName: 'tab-patient-info',
      iconLabel: 'Patient Info',
      label: 'Patient Info',
      component: wrappedPanelPetSuv,
    },
    {
      name: 'tmtv',
      iconName: 'tab-segmentation',
      iconLabel: 'Segmentation',
      component: wrappedPanelTMTV,
    },
    {
      name: 'tmtvBox',
      iconName: 'tab-segmentation',
      iconLabel: 'Segmentation',
      label: 'Segmentation Toolbox',
      component: wrappedROIThresholdToolbox,
    },
    {
      name: 'tmtvExport',
      iconName: 'tab-segmentation',
      iconLabel: 'Segmentation',
      label: 'Segmentation Export',
      component: wrappedROIThresholdExport,
    },
  ];
}

export default getPanelModule;
