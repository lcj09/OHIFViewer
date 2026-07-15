import React from 'react';
import * as cornerstone from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
import {
  Enums as cs3DEnums,
  imageLoadPoolManager,
  imageRetrievalPoolManager,
} from '@cornerstonejs/core';
import { Enums as cs3DToolsEnums } from '@cornerstonejs/tools';
// Internal singletons not exposed via the public API. These hold DOM element
// references and requestAnimationFrame loops that cornerstoneTools.destroy()
// does NOT clean up, causing memory leaks on mode exit.
import { annotationRenderingEngine } from '@cornerstonejs/tools/annotation/AnnotationRenderingEngine';
import { segmentationRenderingEngine } from '@cornerstonejs/tools/segmentation/SegmentationRenderingEngine';
import { Types } from '@ohif/core';
import Enums from './enums';

import init from './init';
import getCustomizationModule from './getCustomizationModule';
import getCommandsModule from './commandsModule';
import getHangingProtocolModule from './getHangingProtocolModule';
import getToolbarModule from './getToolbarModule';
import ToolGroupService from './services/ToolGroupService';
import SyncGroupService from './services/SyncGroupService';
import SegmentationService from './services/SegmentationService';
import CornerstoneCacheService from './services/CornerstoneCacheService';
import CornerstoneViewportService from './services/ViewportService/CornerstoneViewportService';
import ColorbarService from './services/ColorbarService';
import * as CornerstoneExtensionTypes from './types';

import initCornerstoneTools, { toolNames } from './initCornerstoneTools';
import { getEnabledElement, reset as enabledElementReset, setEnabledElement } from './state';
import dicomLoaderService from './utils/dicomLoaderService';
import getActiveViewportEnabledElement from './utils/getActiveViewportEnabledElement';

import { id } from './id';
import { measurementMappingUtils } from './utils/measurementServiceMappings';
import PlanarFreehandROI from './utils/measurementServiceMappings/PlanarFreehandROI';
import RectangleROI from './utils/measurementServiceMappings/RectangleROI';
import type { PublicViewportOptions } from './services/ViewportService/Viewport';
import ImageOverlayViewerTool from './tools/ImageOverlayViewerTool';
import getSOPInstanceAttributes from './utils/measurementServiceMappings/utils/getSOPInstanceAttributes';
import { findNearbyToolData } from './utils/findNearbyToolData';
import { createFrameViewSynchronizer } from './synchronizers/frameViewSynchronizer';
import { getSopClassHandlerModule } from './getSopClassHandlerModule';
import { getDynamicVolumeInfo } from '@cornerstonejs/core/utilities';
import {
  useLutPresentationStore,
  usePositionPresentationStore,
  useSegmentationPresentationStore,
  useSynchronizersStore,
  useSelectedSegmentationsForViewportStore,
} from './stores';
import { useToggleOneUpViewportGridStore } from '@ohif/extension-default';
import { useActiveViewportSegmentationRepresentations } from './hooks/useActiveViewportSegmentationRepresentations';
import { useMeasurements } from './hooks/useMeasurements';
import getPanelModule from './getPanelModule';
import PanelSegmentation from './panels/PanelSegmentation';
import PanelMeasurement from './panels/PanelMeasurement';
import { useSegmentations } from './hooks/useSegmentations';
import { StudySummaryFromMetadata } from './components/StudySummaryFromMetadata';
import CornerstoneViewportDownloadForm from './utils/CornerstoneViewportDownloadForm';
import utils from './utils';
import { useMeasurementTracking } from './hooks/useMeasurementTracking';
import { setUpSegmentationEventHandlers } from './utils/setUpSegmentationEventHandlers';
import { setUpAnnotationEventHandlers } from './utils/setUpAnnotationEventHandlers';
import update from 'immutability-helper';
export * from './components';

const { imageRetrieveMetadataProvider } = cornerstone.utilities;

const Component = React.lazy(() => {
  return import(/* webpackPrefetch: true */ './Viewport/OHIFCornerstoneViewport');
});

const OHIFCornerstoneViewport = props => {
  return (
    <React.Suspense fallback={<div>Loading...</div>}>
      <Component {...props} />
    </React.Suspense>
  );
};

const DEFAULT_STACK_RETRIEVE_OPTIONS = {
  retrieveOptions: {
    single: {
      streaming: true,
      decodeLevel: 1,
    },
  },
};

/** Normalize to immutability-helper spec: plain object → $merge, otherwise use as-is. */
const toUpdateSpec = (obj: object) =>
  obj != null && typeof obj === 'object' && Object.keys(obj).some(k => k.startsWith('$'))
    ? obj
    : { $merge: (obj ?? {}) as object };

const unsubscriptions = [];
/**
 *
 */
const cornerstoneExtension: Types.Extensions.Extension = {
  /**
   * Only required property. Should be a unique value across all extensions.
   */
  id,

  onModeEnter: ({
    servicesManager,
    commandsManager,
    extensionManager,
  }: withAppTypes): void => {
    // Re-initialize cornerstone tools after a potential destroy() in onModeExit.
    // init() is idempotent (checks csToolsInitialized flag), and addTool() skips
    // duplicates, so this is safe to call on every mode enter.
    console.log('[CS-Extension] onModeEnter: calling initCornerstoneTools()');
    initCornerstoneTools();
    console.log('[CS-Extension] onModeEnter: initCornerstoneTools() done, registered tools:', Object.keys((cornerstoneTools as any).state?.tools || {}).length);

    const { cornerstoneViewportService, toolbarService, segmentationService } =
      servicesManager.services;

    const { unsubscriptions: segmentationUnsubscriptions } = setUpSegmentationEventHandlers({
      servicesManager,
      commandsManager,
    });
    unsubscriptions.push(...segmentationUnsubscriptions);

    const annotationUnsubscriptions = setUpAnnotationEventHandlers();
    unsubscriptions.push(...annotationUnsubscriptions);

    toolbarService.registerEventForToolbarUpdate(cornerstoneViewportService, [
      cornerstoneViewportService.EVENTS.VIEWPORT_DATA_CHANGED,
    ]);

    toolbarService.registerEventForToolbarUpdate(segmentationService, [
      segmentationService.EVENTS.SEGMENTATION_REMOVED,
      segmentationService.EVENTS.SEGMENTATION_MODIFIED,
      segmentationService.EVENTS.SEGMENTATION_ANNOTATION_CUT_MERGE_PROCESS_COMPLETED,
    ]);

    toolbarService.registerEventForToolbarUpdate(cornerstone.eventTarget, [
      cornerstoneTools.Enums.Events.TOOL_ACTIVATED,
    ]);

    // Configure the interleaved/HTJ2K loader
    imageRetrieveMetadataProvider.clear();
    // The default volume interleaved options are to interleave the
    // image retrieve, but don't perform progressive loading per image
    // This interleaves images and replicates them for low-resolution depth volume
    // reconstruction, which progressively improves
    imageRetrieveMetadataProvider.add(
      'volume',
      cornerstone.ProgressiveRetrieveImages.interleavedRetrieveStages
    );

    /**
     * Stack retrieve options: read from active data source configuration.
     * Pass an immutability-helper spec (e.g. { $merge: {...} } or { $set: {...} }) in
     * stackRetrieveOptions to customize. Plain object is treated as $merge for backward compat.
     * Set streaming: false for uncompressed DICOM that requires full file before decode.
     */
    const sourceConfig = extensionManager?.getActiveDataSource?.()?.[0]?.getConfig?.() ?? {};
    const config = sourceConfig.stackRetrieveOptions ?? {};
    const stackOptions = update(DEFAULT_STACK_RETRIEVE_OPTIONS, toUpdateSpec(config)) as typeof DEFAULT_STACK_RETRIEVE_OPTIONS;
    imageRetrieveMetadataProvider.add('stack', stackOptions);
  },
  getPanelModule,
  onModeExit: ({ servicesManager }: withAppTypes): void => {
    console.log('[CS-Extension] onModeExit: STARTED');

    unsubscriptions.forEach(unsubscribe => unsubscribe());
    unsubscriptions.length = 0;

    const { cineService, segmentationService } = servicesManager.services;
    Object.values(cs3DEnums.RequestType).forEach(type => {
      imageLoadPoolManager.clearRequestStack(type);
      imageRetrievalPoolManager.clearRequestStack(type);
    });

    cineService.setIsCineEnabled(false);
    enabledElementReset();

    useLutPresentationStore.getState().clearLutPresentationStore();
    usePositionPresentationStore.getState().clearPositionPresentationStore();
    useSynchronizersStore.getState().clearSynchronizersStore();
    useToggleOneUpViewportGridStore.getState().clearToggleOneUpViewportGridStore();
    useSegmentationPresentationStore.getState().clearSegmentationPresentationStore();
    useSelectedSegmentationsForViewportStore
      .getState()
      .clearSelectedSegmentationsForViewportStore();
    segmentationService.removeAllSegmentations();

    // Manually clean up tool instances BEFORE destroy() - disconnect ResizeObservers,
    // release VTK widgets, call tool.cleanUpData() to remove document-level listeners
    try {
      const toolGroups = (cornerstoneTools as any).state?.toolGroups || [];
      let cleanedTools = 0;
      toolGroups.forEach(tg => {
        const toolInstances = tg._toolInstances || {};
        Object.values(toolInstances).forEach((tool: any) => {
          if (tool._resizeObservers && tool._resizeObservers.size > 0) {
            tool._resizeObservers.forEach((ro: any) => { try { ro.disconnect(); } catch {} });
            tool._resizeObservers.clear();
            cleanedTools++;
          }
          if (tool.orientationMarkers) {
            Object.values(tool.orientationMarkers).forEach((om: any) => {
              try {
                om?.orientationWidget?.setEnabled(false);
                om?.orientationWidget?.delete?.();
                om?.actor?.delete?.();
              } catch {}
            });
            tool.orientationMarkers = {};
          }
          if (tool.updatingOrientationMarker) tool.updatingOrientationMarker = {};
          try { tool.cleanUpData?.(); } catch {}
        });
      });
      if (cleanedTools > 0) console.log('[CS-Extension] Cleaned', cleanedTools, 'tool ResizeObserver sets');
    } catch (e) {
      console.warn('[CS-Extension] Tool cleanup failed', e);
    }

    // Before destroy(), dispatch ELEMENT_DISABLED for any remaining enabled elements
    // so removeEnabledElement removes their DOM listeners
    try {
      const csState = (cornerstoneTools as any).state;
      const remainingElements = csState?.enabledElements ? [...csState.enabledElements] : [];
      if (remainingElements.length > 0) {
        console.log('[CS-Extension] Fallback ELEMENT_DISABLED for', remainingElements.length, 'elements');
        remainingElements.forEach((element: any) => {
          try {
            const viewportId = element?.dataset?.viewportUid;
            const renderingEngineId = element?.dataset?.renderingEngineUid;
            if (viewportId && element) {
              cornerstone.eventTarget.dispatchEvent(
                new CustomEvent(cornerstone.Enums.Events.ELEMENT_DISABLED,
                  { detail: { element, viewportId, renderingEngineId } })
              );
            }
          } catch (e) {
            console.warn('[CS-Extension] Fallback ELEMENT_DISABLED failed', e);
          }
        });
      }
    } catch (e) {
      console.warn('[CS-Extension] Fallback cleanup failed', e);
    }

    try {
      if (typeof cornerstoneTools.destroy === 'function') {
        cornerstoneTools.destroy();
      }
    } catch (e) {
      console.error('[CS-Extension] cornerstoneTools.destroy() failed', e);
    }

    // Clean up singleton rendering engines (hold DOM refs + requestAnimationFrame loops)
    try {
      const are = annotationRenderingEngine as any;
      const sre = segmentationRenderingEngine as any;

      if (are._animationFrameHandle != null) window.cancelAnimationFrame(are._animationFrameHandle);
      if (sre._animationFrameHandle != null) window.cancelAnimationFrame(sre._animationFrameHandle);

      are._viewportElements?.clear?.();
      are._needsRender?.clear?.();
      sre._needsRender?.clear?.();
      if (Array.isArray(sre._pendingRenderQueue)) sre._pendingRenderQueue.length = 0;

      are._animationFrameSet = false;
      are._animationFrameHandle = null;
      sre._animationFrameSet = false;
      sre._animationFrameHandle = null;
    } catch (e) {
      console.warn('[CS-Extension] Singleton rendering engine cleanup failed', e);
    }

    // Reset eventTarget to remove all remaining listeners (incl. anonymous ones from tools)
    try {
      const et = (cornerstone as any).eventTarget;
      if (et && typeof et.reset === 'function') {
        et.reset();
      }
    } catch (e) {
      console.warn('[CS-Extension] eventTarget.reset() failed', e);
    }

    // Clear CornerstoneCacheService Maps (stackImageIds, volumeImageIds) that hold
    // arrays of imageId strings and prevent GC of display set references
    try {
      const { cornerstoneCacheService } = servicesManager.services;
      cornerstoneCacheService?.stackImageIds?.clear?.();
      cornerstoneCacheService?.volumeImageIds?.clear?.();
    } catch (e) {
      console.warn('[CS-Extension] onModeExit: CornerstoneCacheService clear failed', e);
    }

    // Brief diagnostic: verify cleanup succeeded
    try {
      const { getRenderingEngines, cache } = cornerstone;
      const csToolsState = (cornerstoneTools as any).state;
      const are = annotationRenderingEngine as any;
      const sre = segmentationRenderingEngine as any;
      console.log('[CS-Extension] onModeExit: cleanup summary:', {
        renderingEngines: getRenderingEngines?.().length || 0,
        volumes: (cache as any)?._volumeCache?.size || 0,
        images: (cache as any)?._imageCache?.size || 0,
        enabledElements: csToolsState?.enabledElements?.length || 0,
        toolGroups: csToolsState?.toolGroups?.length || 0,
        areViewportElements: are._viewportElements?.size || 0,
        sreNeedsRender: sre._needsRender?.size || 0,
        domViewportEls: document.querySelectorAll('[data-viewport-uid]').length,
      });
    } catch (e) {
      console.warn('[CS-Extension] onModeExit: diagnostics failed', e);
    }

    console.log('[CS-Extension] onModeExit: DONE');
  },

  /**
   * Register the Cornerstone 3D services and set them up for use.
   *
   * @param configuration.csToolsConfig - Passed directly to `initCornerstoneTools`
   */
  preRegistration: async function (props: Types.Extensions.ExtensionParams): Promise<void> {
    const { servicesManager } = props;
    servicesManager.registerService(CornerstoneViewportService.REGISTRATION);
    servicesManager.registerService(ToolGroupService.REGISTRATION);
    servicesManager.registerService(SyncGroupService.REGISTRATION);
    servicesManager.registerService(SegmentationService.REGISTRATION);
    servicesManager.registerService(CornerstoneCacheService.REGISTRATION);
    servicesManager.registerService(ColorbarService.REGISTRATION);

    const { syncGroupService } = servicesManager.services;
    syncGroupService.registerCustomSynchronizer('frameview', createFrameViewSynchronizer);

    await init.call(this, props);
  },
  getToolbarModule,
  getHangingProtocolModule,
  getViewportModule({ servicesManager, commandsManager }) {
    const ExtendedOHIFCornerstoneViewport = props => {
      const { toolbarService } = servicesManager.services;

      return (
        <OHIFCornerstoneViewport
          {...props}
          toolbarService={toolbarService}
          servicesManager={servicesManager}
          commandsManager={commandsManager}
        />
      );
    };

    return [
      {
        name: 'cornerstone',
        component: ExtendedOHIFCornerstoneViewport,
        isReferenceViewable: utils.isReferenceViewable.bind(null, servicesManager),
      },
    ];
  },
  getCommandsModule,
  getCustomizationModule,
  getUtilityModule({ servicesManager }) {
    return [
      {
        name: 'common',
        exports: {
          getCornerstoneLibraries: () => {
            return { cornerstone, cornerstoneTools };
          },
          getEnabledElement,
          dicomLoaderService,
        },
      },
      {
        name: 'core',
        exports: {
          Enums: cs3DEnums,
        },
      },
      {
        name: 'tools',
        exports: {
          toolNames,
          Enums: cs3DToolsEnums,
        },
      },
      {
        name: 'volumeLoader',
        exports: {
          getDynamicVolumeInfo,
        },
      },
    ];
  },
  getSopClassHandlerModule,
};

export type { PublicViewportOptions };
export {
  measurementMappingUtils,
  PlanarFreehandROI,
  RectangleROI,
  CornerstoneExtensionTypes as Types,
  toolNames,
  getActiveViewportEnabledElement,
  setEnabledElement,
  findNearbyToolData,
  getEnabledElement,
  ImageOverlayViewerTool,
  getSOPInstanceAttributes,
  dicomLoaderService,
  // Export all stores
  useLutPresentationStore,
  usePositionPresentationStore,
  useSegmentationPresentationStore,
  useSynchronizersStore,
  useSelectedSegmentationsForViewportStore,
  Enums,
  useMeasurements,
  useActiveViewportSegmentationRepresentations,
  useSegmentations,
  PanelSegmentation,
  PanelMeasurement,
  StudySummaryFromMetadata,
  CornerstoneViewportDownloadForm,
  utils,
  OHIFCornerstoneViewport,
  useMeasurementTracking,
};

// Export constants
export { VOLUME_LOADER_SCHEME, DYNAMIC_VOLUME_LOADER_SCHEME } from './constants';
export default cornerstoneExtension;
