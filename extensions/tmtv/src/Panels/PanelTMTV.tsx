import React from 'react';
import { PanelSegmentation } from '@ohif/extension-cornerstone';
import PanelROIThresholdExport from './PanelROIThresholdSegmentation/PanelROIThresholdExport';

export default function PanelTMTV({ configuration }: withAppTypes) {
  return (
    // [2026-08-25 功能] TMTV 右侧面板增加外层滚动容器，避免 lesion 列表展开后遮挡分割工具区
    <div className="ohif-scrollbar ohif-scrollbar-stable-gutter flex h-full min-h-0 flex-col overflow-y-auto overflow-x-hidden pr-1">
      <PanelSegmentation configuration={configuration}>
        <PanelROIThresholdExport />
      </PanelSegmentation>
    </div>
  );
}
