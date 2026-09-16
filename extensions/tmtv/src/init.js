import {
  addTool,
  RectangleROIStartEndThresholdTool,
  CircleROIStartEndThresholdTool,
} from '@cornerstonejs/tools';
import { utilities as csUtilities } from '@cornerstonejs/core';
import { Enums as CSExtensionEnums } from '@ohif/extension-cornerstone';

import measurementServiceMappingsFactory from './utils/measurementServiceMappings/measurementServiceMappingsFactory';

const { CORNERSTONE_3D_TOOLS_SOURCE_NAME, CORNERSTONE_3D_TOOLS_SOURCE_VERSION } = CSExtensionEnums;
const { registerColormap } = csUtilities.colormap;
let hasRegisteredTMTVColormaps = false;

const AW_RED_HOT_COLORMAP = {
  ColorSpace: 'RGB',
  Name: 'aw_red_hot',
  // 2026-09-16 功能说明：近似 AW 核医学工作站 red-hot 观感，保留红色底并让高摄取过渡到黄白。
  RGBPoints: [
    0, 0, 0, 0, 0.06, 0.12, 0, 0, 0.16, 0.42, 0.02, 0, 0.32, 0.88, 0.08, 0, 0.55, 1, 0.32, 0, 0.72,
    1, 0.72, 0.06, 0.88, 1, 0.94, 0.38, 1, 1, 1, 0.85,
  ],
  description: 'AW Red Hot',
};

function registerTMTVColormaps() {
  if (hasRegisteredTMTVColormaps) {
    return;
  }

  try {
    registerColormap(AW_RED_HOT_COLORMAP);
    hasRegisteredTMTVColormaps = true;
  } catch (error) {
    console.warn('TMTV: register aw_red_hot colormap failed', error);
  }
}

/**
 *
 * @param {Object} servicesManager
 * @param {Object} configuration
 * @param {Object|Array} configuration.csToolsConfig
 */
export default function init({ servicesManager }) {
  const { measurementService, displaySetService, cornerstoneViewportService } =
    servicesManager.services;

  registerTMTVColormaps();

  addTool(RectangleROIStartEndThresholdTool);
  addTool(CircleROIStartEndThresholdTool);

  const { RectangleROIStartEndThreshold, CircleROIStartEndThreshold } =
    measurementServiceMappingsFactory(
      measurementService,
      displaySetService,
      cornerstoneViewportService
    );

  const csTools3DVer1MeasurementSource = measurementService.getSource(
    CORNERSTONE_3D_TOOLS_SOURCE_NAME,
    CORNERSTONE_3D_TOOLS_SOURCE_VERSION
  );

  measurementService.addMapping(
    csTools3DVer1MeasurementSource,
    'RectangleROIStartEndThreshold',
    RectangleROIStartEndThreshold.matchingCriteria,
    RectangleROIStartEndThreshold.toAnnotation,
    RectangleROIStartEndThreshold.toMeasurement
  );

  measurementService.addMapping(
    csTools3DVer1MeasurementSource,
    'CircleROIStartEndThreshold',
    CircleROIStartEndThreshold.matchingCriteria,
    CircleROIStartEndThreshold.toAnnotation,
    CircleROIStartEndThreshold.toMeasurement
  );
}
