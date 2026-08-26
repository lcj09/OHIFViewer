import React from 'react';
import { PanelSegmentation } from '@ohif/extension-cornerstone';
import { PanelSection } from '@ohif/ui-next';
import { useTranslation } from 'react-i18next';
import PanelROIThresholdExport from './PanelROIThresholdSegmentation/PanelROIThresholdExport';

export default function PanelTMTV({ configuration }: withAppTypes) {
  const { t } = useTranslation('ROIThresholdConfiguration');

  return (
    // [2026-08-26 功能] 商业软件式 TMTV 布局：Lesion 管理独立作为主区域，底层 Segmentation 表默认折叠为高级数据区
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden pr-1">
      <PanelROIThresholdExport />
      <PanelSection
        defaultOpen={false}
        className="flex-shrink-0"
      >
        <PanelSection.Header>
          <span>{t('Segment 1 advanced data', { defaultValue: 'Segment 1 / Advanced Data' })}</span>
        </PanelSection.Header>
        <PanelSection.Content>
          <PanelSegmentation configuration={configuration} />
        </PanelSection.Content>
      </PanelSection>
    </div>
  );
}
