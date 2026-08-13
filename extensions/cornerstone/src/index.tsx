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
import OverlayPlaneModuleProvider from './tools/OverlayPlaneModuleProvider';
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
// Module-level cache cleanup helpers. These loader utilities keep module-level
// Maps that hold volume ID and viewport input array references; without clearing
// them on mode exit, those references persist across mode switches.
import { clearLoaderCache as clearInterleaveCenterLoader } from './utils/interleaveCenterLoader';
import { clearLoaderCache as clearInterleaveTopToBottomLoader } from './utils/interleaveTopToBottom';
import { clearLoaderCache as clearNthLoader } from './utils/nthLoader';
import { clearViewportDimensionsCache } from './Viewport/OHIFCornerstoneViewport';
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
    initCornerstoneTools();

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

    // CRITICAL: Destroy CornerstoneViewportService to release rendering engine,
    // WebGL contexts, DOM element references, and purge volume/image cache.
    // Without this, ~20-30MB of JS heap leaks on every mode exit.
    try {
      const { cornerstoneViewportService } = servicesManager.services;
      cornerstoneViewportService?.destroy?.();
    } catch (e) {
      console.warn('[CS-Extension] ViewportService.destroy() failed', e);
    }

    // Manually clean up tool instances BEFORE destroy() - disconnect ResizeObservers,
    // release VTK widgets, call tool.cleanUpData() to remove document-level listeners
    try {
      const toolGroups = (cornerstoneTools as any).state?.toolGroups || [];
      let cleanedTools = 0;
      let cleanedUpDataTools = 0;
      const cleanedToolNames = [];
      const noCleanUpDataToolNames = [];
      toolGroups.forEach(tg => {
        const toolInstances = tg._toolInstances || {};
        Object.values(toolInstances).forEach((tool: any) => {
          const toolName = tool?.toolName || 'unknown';
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
          // Call cleanUpData() to remove document/window-level event listeners.
          // CRITICAL: FusionAdjustTool and AdvancedMagnifyTool add document.addEventListener
          // in their constructors. Without cleanUpData(), these listeners persist forever
          // (document is global, never GC'd), holding tool instance references → viewport →
          // vtkRenderer → backingStore (3.5MB frame buffer). This is the "stubborn tenant"
          // causing DOM Nodes and Listeners to not release after mode exit.
          if (typeof tool.cleanUpData === 'function') {
            try {
              tool.cleanUpData();
              cleanedUpDataTools++;
              cleanedToolNames.push(toolName);
            } catch (e) {
              console.warn('[CS-Extension] cleanUpData() failed for', toolName, e);
            }
          } else {
            noCleanUpDataToolNames.push(toolName);
          }
          // Also call dispose() for tools that use it instead of cleanUpData()
          // (e.g. AdvancedMagnifyTool has dispose() but not cleanUpData())
          if (typeof tool.dispose === 'function' && typeof tool.cleanUpData !== 'function') {
            try {
              tool.dispose();
              cleanedUpDataTools++;
              cleanedToolNames.push(toolName + ' (dispose)');
            } catch (e) {
              console.warn('[CS-Extension] dispose() failed for', toolName, e);
            }
          }
        });
        // CRITICAL: Clear _toolInstances after cleanup. destroyToolGroup() only removes
        // the toolGroup from state.toolGroups array; it does NOT clear _toolInstances.
        // This means tool instances (and their references to viewports, DOM elements,
        // vtkRenderer) would persist in memory even after destroy().
        tg._toolInstances = {};
        tg.toolOptions = {};
      });
    } catch (e) {
      console.warn('[CS-Extension] Tool cleanup failed', e);
    }

    // Before destroy(), dispatch ELEMENT_DISABLED for any remaining enabled elements
    // so removeEnabledElement removes their DOM listeners
    try {
      const csState = (cornerstoneTools as any).state;
      const remainingElements = csState?.enabledElements ? [...csState.enabledElements] : [];
      if (remainingElements.length > 0) {
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

    // Clear imageRetrieveMetadataProvider - holds volume/stack retrieve strategy
    // configurations that reference volume loader functions. Without this, the
    // strategies (and their bound volume loader references) persist across mode
    // switches and retain volume metadata references.
    try {
      imageRetrieveMetadataProvider.clear();
    } catch (e) {
      console.warn('[CS-Extension] onModeExit: imageRetrieveMetadataProvider clear failed', e);
    }

    // Clear module-level loader caches. These loader utilities (used by hanging
    // protocols) keep Maps of volumeId → SeriesInstanceUID and viewportId →
    // volumeInputArray at module scope. If mode exit happens mid-load, these
    // Maps retain references to volume IDs and volume input arrays (which
    // include imageId arrays and metadata references).
    try {
      clearInterleaveCenterLoader();
      clearInterleaveTopToBottomLoader();
      clearNthLoader();
    } catch (e) {
      console.warn('[CS-Extension] onModeExit: loader cache clear failed', e);
    }

    // Clear the module-level viewport dimensions cache in OHIFCornerstoneViewport.
    // This Map stores { width, height } per viewportId and persists across mode
    // switches, retaining viewport ID strings and dimension objects.
    try {
      clearViewportDimensionsCache();
    } catch (e) {
      console.warn('[CS-Extension] onModeExit: viewport dimensions cache clear failed', e);
    }

    // Clear the OverlayPlaneModuleProvider's cached metadata. This module-level
    // Map stores imageId → overlay metadata entries and is never cleared by
    // cornerstoneTools.destroy(), retaining DICOM metadata references.
    try {
      OverlayPlaneModuleProvider.clear();
    } catch (e) {
      console.warn('[CS-Extension] onModeExit: overlay metadata cache clear failed', e);
    }

    // Terminate Web Workers and clear pending worker request queue.
    // Without this:
    //  - blink::DedicatedWorkerMessagingProxy persists, retaining DOM refs via
    //    pending message queue entries and Comlink proxy callbacks ("Documents: 3"
    //    ghost pages in incognito mode).
    //  - webWorkerManager.workerPoolManager (SEPARATE from imageLoadPoolManager)
    //    holds pending requestFn closures capturing args = { imageFrame, pixelData,
    //    options, decodeConfig } which indirectly reference volumes → viewports →
    //    canvas (DOM), preventing detached divs from being GC'd.
    //  - idleCheckIntervalId setInterval leaks (upstream bug: terminate() doesn't
    //    clear it).
    // After terminate(), instances[] is [null, null, ...]. The next executeTask()
    // call auto-recreates the worker via workerFn() in getNextWorkerAPI(), so no
    // re-registration is needed on mode enter.
    try {
      const webWorkerManager = (cornerstone as any).getWebWorkerManager?.();
      if (webWorkerManager) {
        // 1) Clear pending worker requests FIRST (before terminating workers) to
        //    prevent in-flight requests from holding stale volume/DOM references.
        try {
          const wpm = webWorkerManager.workerPoolManager;
          if (wpm && typeof wpm.clearRequestStack === 'function') {
            Object.values(cs3DEnums.RequestType).forEach(type => {
              try { wpm.clearRequestStack(type); } catch {}
            });
          }
        } catch (e) {
          console.warn('[CS-Extension] onModeExit: workerPoolManager clear failed', e);
        }
        // 2) Terminate each registered worker (dicomImageLoader × 3, histogram-worker × 1)
        const registry = webWorkerManager.workerRegistry || {};
        Object.keys(registry).forEach(workerName => {
          try {
            const props = registry[workerName];
            // Clear the idle-check setInterval (upstream leak: terminate() doesn't clear it)
            if (props?.idleCheckIntervalId) {
              clearInterval(props.idleCheckIntervalId);
              props.idleCheckIntervalId = null;
            }
            // Terminate all native worker instances (releases DedicatedWorkerMessagingProxy
            // and Comlink proxies, calls nativeWorker.terminate())
            if (typeof webWorkerManager.terminate === 'function') {
              webWorkerManager.terminate(workerName);
            }
            // Clear nativeWorkers array (terminateWorkerInstance sets instances[i]=null
            // but does NOT clear nativeWorkers[i], leaving orphan Worker references)
            if (Array.isArray(props?.nativeWorkers)) {
              props.nativeWorkers.length = 0;
            }
          } catch (e) {
            console.warn('[CS-Extension] onModeExit: terminate worker failed for', workerName, e);
          }
        });
      }
    } catch (e) {
      console.warn('[CS-Extension] onModeExit: webWorkerManager cleanup failed', e);
    }
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
