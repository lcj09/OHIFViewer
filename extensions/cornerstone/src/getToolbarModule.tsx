import { Enums } from '@cornerstonejs/tools';
import i18n from '@ohif/i18n';
import { utils } from '@ohif/ui-next';
import { ViewportDataOverlayMenuWrapper } from './components/ViewportDataOverlaySettingMenu/ViewportDataOverlayMenuWrapper';
import { ViewportOrientationMenuWrapper } from './components/ViewportOrientationMenu/ViewportOrientationMenuWrapper';
import { WindowLevelActionMenuWrapper } from './components/WindowLevelActionMenu/WindowLevelActionMenuWrapper';
import { VOIManualControlMenuWrapper } from './components/VOIManualControlMenu';
import { ThresholdMenuWrapper } from './components/ThresholdMenu/ThresholdMenuWrapper';
import { OpacityMenuWrapper } from './components/OpacityMenu/OpacityMenuWrapper';
import ModalityLoadBadge from './components/ModalityLoadBadge/ModalityLoadBadge';
import NavigationComponent from './components/NavigationComponent/NavigationComponent';
import TrackingStatus from './components/TrackingStatus/TrackingStatus';
import ViewportColorbarsContainer from './components/ViewportColorbar';
import AdvancedRenderingControls from './components/AdvancedRenderingControls';

const getDisabledState = (disabledText?: string) => ({
  disabled: true,
  disabledText: disabledText ?? i18n.t('Buttons:Not available on the current viewport'),
});

export default function getToolbarModule({ servicesManager, extensionManager }: withAppTypes) {
  const {
    toolGroupService,
    toolbarService,
    syncGroupService,
    cornerstoneViewportService,
    colorbarService,
    displaySetService,
    viewportGridService,
    segmentationService,
  } = servicesManager.services;

  return [
    {
      name: 'ohif.advancedRenderingControls',
      defaultComponent: AdvancedRenderingControls,
    },
    {
      name: 'evaluate.advancedRenderingControls',
      evaluate: ({ viewportId }) => {
        const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);

        if (!viewport) {
          return {
            disabled: true,
          };
        }

        const hasColorbar = colorbarService?.hasColorbar(viewportId) || false;
        return {
          disabled: !hasColorbar,
        };
      },
    },
    {
      name: 'ohif.colorbar',
      defaultComponent: ViewportColorbarsContainer,
    },
    {
      name: 'ohif.trackingStatus',
      defaultComponent: TrackingStatus,
    },
    {
      name: 'evaluate.trackingStatus',
      evaluate: ({ viewportId }) => {
        const displaySetUIDs = viewportGridService.getDisplaySetsUIDsForViewport(viewportId);

        if (!displaySetUIDs?.length) {
          return {
            disabled: true,
          };
        }

        return {
          disabled: false,
        };
      },
    },
    // ModalityLoadBadge
    {
      name: 'ohif.modalityLoadBadge',
      defaultComponent: ModalityLoadBadge,
    },
    {
      name: 'evaluate.modalityLoadBadge',
      evaluate: ({ viewportId }) => {
        // We can't use useViewportDisplaySets hook here since we're in a non-React context,
        // but we'll follow the same pattern by getting only the display sets for this viewport
        const displaySetUIDs = viewportGridService.getDisplaySetsUIDsForViewport(viewportId);

        if (!displaySetUIDs?.length) {
          return {
            disabled: true,
          };
        }

        // Get the display sets that are specifically in this viewport
        const viewportDisplaySets = displaySetUIDs.map(uid =>
          displaySetService.getDisplaySetByUID(uid)
        );

        // Only show status for supported types like SR, SEG, RTSTRUCT
        const isSupportedType = viewportDisplaySets.some(
          displaySet =>
            displaySet?.Modality === 'SR' ||
            displaySet?.Modality === 'SEG' ||
            displaySet?.Modality === 'RTSTRUCT'
        );

        return {
          disabled: !isSupportedType,
        };
      },
    },
    // NavigationComponent
    {
      name: 'ohif.navigationComponent',
      defaultComponent: NavigationComponent,
    },
    {
      name: 'evaluate.navigationComponent',
      evaluate: ({ viewportId }) => {
        const { trackedMeasurementsService } = servicesManager.services;
        // Same logic as statusComponent - only show for SR, SEG, RTSTRUCT
        const displaySetUIDs = viewportGridService.getDisplaySetsUIDsForViewport(viewportId);

        if (!displaySetUIDs?.length) {
          return {
            disabled: true,
          };
        }

        // Get the display sets that are specifically in this viewport
        const viewportDisplaySets = displaySetUIDs.map(uid =>
          displaySetService.getDisplaySetByUID(uid)
        );

        // Check if there's a need for navigation:
        // 1. Segmentations are present (for SEG/RTSTRUCT navigation)
        // 2. There are tracked measurements in the viewport (for SR navigation)

        // Check for SEG/RTSTRUCT navigation
        const hasSegmentation =
          segmentationService.getSegmentationRepresentations(viewportId).length > 0;

        if (!trackedMeasurementsService) {
          return {
            disabled: !hasSegmentation,
          };
        }

        // Check if any of the viewport's series are being tracked
        const hasTrackedInViewport = viewportDisplaySets.some(
          displaySet =>
            displaySet?.SeriesInstanceUID &&
            trackedMeasurementsService.isSeriesTracked(displaySet.SeriesInstanceUID)
        );

        const isSRDisplaySet = viewportDisplaySets.some(
          displaySet => displaySet?.Modality === 'SR'
        );

        // Enable navigation if:
        // - There's a segmentation to navigate (SEG/RTSTRUCT)
        // - OR there are tracked measurements in the viewport (SR/etc.)
        const needsNavigation = hasSegmentation || hasTrackedInViewport || isSRDisplaySet;

        return {
          disabled: !needsNavigation,
        };
      },
    },
    {
      name: 'ohif.dataOverlayMenu',
      defaultComponent: ViewportDataOverlayMenuWrapper,
    },
    {
      name: 'evaluate.dataOverlayMenu',
      evaluate: ({ viewportId }) => {
        const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);

        if (!viewport) {
          return {
            disabled: true,
          };
        }

        // Example: Show data overlay menu only for certain modalities
        const displaySetUIDs = viewportGridService.getDisplaySetsUIDsForViewport(viewportId);
        if (!displaySetUIDs?.length) {
          return {
            disabled: true,
          };
        }

        return {
          disabled: false,
        };
      },
    },
    {
      name: 'ohif.orientationMenu',
      defaultComponent: ViewportOrientationMenuWrapper,
    },
    {
      name: 'evaluate.orientationMenu',
      evaluate: ({ viewportId }) => {
        const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);

        if (!viewport) {
          return {
            disabled: true,
          };
        }

        // Only show orientation menu for 3D capable viewports
        const displaySetUIDs = viewportGridService.getDisplaySetsUIDsForViewport(viewportId) || [];
        const displaySets = displaySetUIDs
          .map(uid => displaySetService.getDisplaySetByUID(uid))
          .filter(Boolean);

        // [2026-08-21 修复] PT/MIP 等体积视口的 displaySet 在部分场景下无法通过 UID 解析，
        // 原逻辑 `some(!isReconstructable)` 会把未解析（undefined）的 displaySet 当作不可重建，
        // 导致 evaluate 返回 disabled=true，配合 hideWhenDisabled 使按钮在视口选中时被隐藏、
        // 仅悬停时可见。改为：仅当存在已解析的 displaySet 且均不可重建时才禁用
        // （只要任一 displaySet 可重建，方位切换即可用）。
        const isNotReconstructable =
          displaySets.length > 0 && displaySets.every(displaySet => !displaySet.isReconstructable);

        return {
          disabled: isNotReconstructable,
        };
      },
    },
    {
      name: 'ohif.windowLevelMenu',
      defaultComponent: WindowLevelActionMenuWrapper,
    },
    {
      name: 'ohif.voiManualControlMenu',
      defaultComponent: VOIManualControlMenuWrapper,
    },
    {
      name: 'ohif.windowLevelMenuEmbedded',
      defaultComponent: WindowLevelActionMenuWrapper,
    },
    {
      name: 'evaluate.windowLevelMenuEmbedded',
      evaluate: () => {
        return {
          isEmbedded: true,
        };
      },
    },
    {
      name: 'ohif.thresholdMenu',
      defaultComponent: ThresholdMenuWrapper,
    },
    {
      name: 'ohif.opacityMenu',
      defaultComponent: OpacityMenuWrapper,
    },
    {
      name: 'evaluate.windowLevelMenu',
      evaluate: ({ viewportId }) => {
        const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);

        if (!viewport) {
          return {
            disabled: true,
          };
        }

        const displaySetUIDs = viewportGridService.getDisplaySetsUIDsForViewport(viewportId) || [];
        const displaySets = displaySetUIDs
          .map(uid => displaySetService.getDisplaySetByUID(uid))
          .filter(Boolean);

        // [2026-08-21 修复] 同 orientationMenu：displaySet 未解析（undefined/空）时不再禁用按钮，
        // 避免 PT/MIP 视口因 displaySet 暂时无法解析导致按钮被 hideWhenDisabled 隐藏。
        // 仅当存在已解析的 displaySet 且均不支持窗宽窗位时才禁用。
        const supportWindowLevel =
          displaySets.length === 0 ||
          displaySets.some(displaySet => displaySet.supportsWindowLevel);

        const isInAnySection = toolbarService.isInAnySection('windowLevelMenuEmbedded');

        return {
          disabled: !supportWindowLevel,
          hasEmbeddedVariantToUse: !!isInAnySection,
        };
      },
    },
    {
      name: 'evaluate.voiManualControlMenu',
      evaluate: ({ viewportId }) => {
        const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);

        if (!viewport) {
          return {
            disabled: true,
          };
        }

        const displaySetUIDs = viewportGridService.getDisplaySetsUIDsForViewport(viewportId);
        const displaySets = displaySetUIDs.map(displaySetService.getDisplaySetByUID);

        const supportWindowLevel = displaySets.some(displaySet => displaySet?.supportsWindowLevel);

        return {
          disabled: !supportWindowLevel,
        };
      },
    },
    {
      name: 'evaluate.thresholdMenu',
      evaluate: ({ viewportId }) => {
        const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);

        if (!viewport) {
          return {
            disabled: true,
          };
        }

        if (viewport.type !== 'orthographic') {
          return {
            disabled: true,
          };
        }

        const displaySetUIDs = viewportGridService.getDisplaySetsUIDsForViewport(viewportId);
        if (!displaySetUIDs.length) {
          return {
            disabled: true,
          };
        }

        return {
          disabled: false,
        };
      },
    },
    {
      name: 'evaluate.opacityMenu',
      evaluate: ({ viewportId }) => {
        const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);

        if (!viewport || viewport.type !== 'orthographic') {
          return {
            disabled: true,
          };
        }

        const displaySetUIDs = viewportGridService.getDisplaySetsUIDsForViewport(viewportId);

        if (displaySetUIDs.length <= 1) {
          return {
            disabled: true,
          };
        }

        const displaySets = displaySetUIDs.map(displaySetService.getDisplaySetByUID);
        const hasOverlayable = displaySets.some(displaySet => displaySet?.isOverlayDisplaySet);

        return {
          disabled: hasOverlayable,
        };
      },
    },
    // functions/helpers to be used by the toolbar buttons to decide if they should
    // enabled or not
    {
      name: 'evaluate.viewport.supported',
      evaluate: ({ viewportId, unsupportedViewportTypes, disabledText }) => {
        const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);

        if (viewport && unsupportedViewportTypes?.includes(viewport.type)) {
          return getDisabledState(disabledText);
        }

        return undefined;
      },
    },
    {
      name: 'evaluate.modality.supported',
      evaluate: ({ viewportId, unsupportedModalities, supportedModalities, disabledText }) => {
        const displaySetUIDs = viewportGridService.getDisplaySetsUIDsForViewport(viewportId);

        if (!displaySetUIDs?.length) {
          return;
        }

        const displaySets = displaySetUIDs.map(displaySetService.getDisplaySetByUID);

        // Check for unsupported modalities (exclusion)
        if (unsupportedModalities?.length) {
          const hasUnsupportedModality = displaySets.some(displaySet =>
            unsupportedModalities.includes(displaySet?.Modality)
          );

          if (hasUnsupportedModality) {
            return getDisabledState(disabledText);
          }
        }

        // Check for supported modalities (inclusion)
        if (supportedModalities?.length) {
          const hasAnySupportedModality = displaySets.some(displaySet =>
            supportedModalities.includes(displaySet?.Modality)
          );

          if (!hasAnySupportedModality) {
            return getDisabledState(
              disabledText || i18n.t('Buttons:Tool not available for this modality')
            );
          }
        }
      },
    },
    {
      name: 'evaluate.cornerstoneTool',
      evaluate: ({ viewportId, button, toolNames, disabledText }) => {
        const toolGroup = toolGroupService.getToolGroupForViewport(viewportId);

        if (!toolGroup) {
          return;
        }

        const toolName = toolbarService.getToolNameForButton(button);

        if (!toolGroup || (!toolGroup.hasTool(toolName) && !toolNames)) {
          return getDisabledState(disabledText);
        }

        const isPrimaryActive = toolNames
          ? toolNames.includes(toolGroup.getActivePrimaryMouseButtonTool())
          : toolGroup.getActivePrimaryMouseButtonTool() === toolName;

        return {
          disabled: false,
          isActive: isPrimaryActive,
        };
      },
    },
    {
      name: 'evaluate.action',
      evaluate: () => {
        return {
          disabled: false,
        };
      },
    },
    {
      name: 'evaluate.cornerstoneTool.toggle.ifStrictlyDisabled',
      evaluate: ({ viewportId, button, disabledText }) =>
        _evaluateToggle({
          viewportId,
          button,
          toolbarService,
          disabledText,
          offModes: [Enums.ToolModes.Disabled],
          toolGroupService,
        }),
    },
    {
      name: 'evaluate.cornerstoneTool.toggle',
      evaluate: ({ viewportId, button, disabledText }) =>
        _evaluateToggle({
          viewportId,
          button,
          toolbarService,
          disabledText,
          offModes: [Enums.ToolModes.Disabled, Enums.ToolModes.Passive],
          toolGroupService,
        }),
    },
    {
      name: 'evaluate.cornerstone.synchronizer',
      evaluate: ({ viewportId, button }) => {
        let synchronizers = syncGroupService.getSynchronizersForViewport(viewportId);

        if (!synchronizers?.length || synchronizers.length <= 1) {
          return {
            className: utils.getToggledClassName(false),
          };
        }

        const isArray = Array.isArray(button.props?.commands);

        const synchronizerType = isArray
          ? button.props?.commands?.[0].commandOptions.type
          : button.props?.commands?.commandOptions.type;

        synchronizers = syncGroupService.getSynchronizersOfType(synchronizerType);

        if (!synchronizers?.length) {
          return {
            className: utils.getToggledClassName(false),
          };
        }

        // Todo: we need a better way to find the synchronizers based on their
        // type, but for now we just check the first one and see if it is
        // enabled
        const synchronizer = synchronizers[0];

        const isEnabled = synchronizer?._enabled;

        return {
          className: utils.getToggledClassName(isEnabled),
        };
      },
    },
    {
      name: 'evaluate.viewportProperties.toggle',
      evaluate: ({ viewportId, button }) => {
        const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);

        if (!viewport || viewport.isDisabled) {
          return;
        }

        const propId = button.id;

        const properties = viewport.getProperties();
        const camera = viewport.getCamera();

        const prop = camera?.[propId] || properties?.[propId];

        if (!prop) {
          return {
            disabled: false,
          };
        }

        const isToggled = prop;

        return {
          className: utils.getToggledClassName(isToggled),
        };
      },
    },
    {
      name: 'evaluate.displaySetIsReconstructable',
      evaluate: ({ viewportId, disabledText = 'Selected viewport is not reconstructable' }) => {
        const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);

        if (!viewport) {
          return;
        }

        const displaySetUIDs = viewportGridService.getDisplaySetsUIDsForViewport(viewportId);

        const displaySets = displaySetUIDs.map(displaySetService.getDisplaySetByUID);

        const areReconstructable = displaySets.every(displaySet => {
          return displaySet?.isReconstructable;
        });

        if (!areReconstructable) {
          return getDisabledState(disabledText);
        }

        return {
          disabled: false,
        };
      },
    },

    {
      name: 'evaluate.pixelInfoActive',

      /**
       * TMTV模式探针功能按钮状态评估函数
       *
       * 功能说明:
       *   读取探针功能的当前全局状态，返回按钮的视觉状态配置。
       *   用于控制[🔬探针]按钮是否显示高亮(active)状态。
       *
       * 调用时机:
       *   OHIF框架在渲染工具栏按钮时自动调用此函数
       *
       * 返回值格式 (与 evaluate.cornerstoneTool 保持一致):
       *   {
       *     disabled: boolean,  // 是否禁用按钮 (false=始终可用)
       *     isActive: boolean,  // 是否激活/高亮 (true=显示active样式)
       *   }
       *
       * 数据源:
       *   window.__pixelInfoEnabled - 全局状态变量
       *   由 PixelInfoOverlay.tsx 中的 PixelInfoManager 维护
       *   用户点击探针按钮时通过 togglePixelInfo 命令更新此值
       *
       * 工作原理:
       *   OHIF框架渲染周期 → 调用本函数 → 读取 window.__pixelInfoEnabled
     *   → 返回 { isActive: true/false } → 按钮组件根据isActive更新CSS类名
     *   → 高亮/取消高亮视觉效果
       *
       * 使用场景:
       *   场景1: 页面初始加载 → window.__pixelInfoEnabled = false → 按钮不高亮
       *   场景2: 用户点击启用探针 → window.__pixelInfoEnabled = true → 按钮高亮
       *   场景3: 用户再次点击禁用 → window.__pixelInfoEnabled = false → 按钮取消高亮
       */
      evaluate: () => {
        try {
          const isEnabled = (window as any).__pixelInfoEnabled === true;

          return {
            disabled: false,
            isActive: isEnabled,
          };
        } catch (e) {
          console.error('[PixelInfo evaluate] Error:', e);

          return {
            disabled: false,
            isActive: false,
          };
        }
      },
    },
  ];
}

function _evaluateToggle({
  viewportId,
  toolbarService,
  button,
  disabledText,
  offModes,
  toolGroupService,
}) {
  const toolGroup = toolGroupService.getToolGroupForViewport(viewportId);

  if (!toolGroup) {
    return;
  }
  const toolName = toolbarService.getToolNameForButton(button);

  if (!toolGroup?.hasTool(toolName)) {
    return getDisabledState(disabledText);
  }

  const isOff = offModes.includes(toolGroup.getToolOptions(toolName).mode);

  return {
    className: utils.getToggledClassName(!isOff),
  };
}
