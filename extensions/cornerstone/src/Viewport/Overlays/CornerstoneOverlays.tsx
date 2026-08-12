import React, { useEffect, useState } from 'react';

import ViewportImageScrollbar from './ViewportImageScrollbar';
import CustomizableViewportOverlay from './CustomizableViewportOverlay';
import ViewportOrientationMarkers from './ViewportOrientationMarkers';
import ViewportImageSliceLoadingIndicator from './ViewportImageSliceLoadingIndicator';
// [2026-04-29] 导入实时像素信息显示组件 - 自动探针功能
import PixelInfoOverlay from './PixelInfoOverlay';

function CornerstoneOverlays(props: withAppTypes) {
  const { viewportId, element, scrollbarHeight, servicesManager } = props;
  const { cornerstoneViewportService } = servicesManager.services;
  const [imageSliceData, setImageSliceData] = useState({
    imageIndex: 0,
    numberOfSlices: 0,
  });
  const [viewportData, setViewportData] = useState(null);

  useEffect(() => {
    const { unsubscribe } = cornerstoneViewportService.subscribe(
      cornerstoneViewportService.EVENTS.VIEWPORT_DATA_CHANGED,
      props => {
        if (props.viewportId !== viewportId) {
          return;
        }

        setViewportData(props.viewportData);
      }
    );

    return () => {
      unsubscribe();
    };
  }, [viewportId]);

  if (!element) {
    return null;
  }

  if (viewportData) {
    const viewportInfo = cornerstoneViewportService.getViewportInfo(viewportId);

    if (viewportInfo?.viewportOptions?.customViewportProps?.hideOverlays) {
      // [2026-08-12 修复] 当 hideOverlays 为 true 时，仍渲染方位标记，
      // 但隐藏其他叠加层（滚动条、文字叠加、切片加载指示器、像素信息）。
      // 解决 MIP 视口在 3x4 布局中窄高尺寸下 VTK OrientationMarkerTool 渲染变形的问题。
      return (
        <div className="noselect">
          <ViewportOrientationMarkers
            imageSliceData={imageSliceData}
            element={element}
            viewportData={viewportData}
            servicesManager={servicesManager}
            viewportId={viewportId}
          />
        </div>
      );
    }
  }

  return (
    <div className="noselect">
      <ViewportImageScrollbar
        viewportId={viewportId}
        viewportData={viewportData}
        element={element}
        imageSliceData={imageSliceData}
        setImageSliceData={setImageSliceData}
        scrollbarHeight={scrollbarHeight}
        servicesManager={servicesManager}
      />

      <CustomizableViewportOverlay
        imageSliceData={imageSliceData}
        viewportData={viewportData}
        viewportId={viewportId}
        servicesManager={servicesManager}
        element={element}
      />

      <ViewportImageSliceLoadingIndicator
        viewportData={viewportData}
        element={element}
      />

      <ViewportOrientationMarkers
        imageSliceData={imageSliceData}
        element={element}
        viewportData={viewportData}
        servicesManager={servicesManager}
        viewportId={viewportId}
      />

      {/* [2026-04-29] 自动探针功能 - 鼠标移动自动显示+点击固定标注 */}
      <PixelInfoOverlay
        viewportId={viewportId}
        element={element}
        servicesManager={servicesManager}
      />
    </div>
  );
}

export default CornerstoneOverlays;
