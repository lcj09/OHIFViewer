import OHIF from '@ohif/core';
import * as cs from '@cornerstonejs/core';
import {
  utilities as csUtils,
  BaseVolumeViewport,
} from '@cornerstonejs/core';
import * as csTools from '@cornerstonejs/tools';
import { classes } from '@ohif/core';
import i18n from '@ohif/i18n';
import getThresholdValues from './utils/getThresholdValue';
import createAndDownloadTMTVReport from './utils/createAndDownloadTMTVReport';

import dicomRTAnnotationExport from './utils/dicomRTAnnotationExport/RTStructureSet';

import { Enums } from '@cornerstonejs/tools';
import { utils } from '@ohif/core';
import tmtvCrosshairService from './services/TMTVCrosshairService';
import crosshairDisplayService from './services/CrosshairDisplayService';
import { toolGroupIds } from '../../../modes/tmtv/src/initToolGroups';

const { SegmentationRepresentations } = Enums;
const { formatPN } = utils;

const metadataProvider = classes.MetadataProvider;
const ROI_THRESHOLD_MANUAL_TOOL_IDS = [
  'RectangleROIStartEndThreshold',
  'RectangleROIThreshold',
  'CircleROIStartEndThreshold',
];

const commandsModule = ({ servicesManager, commandsManager, extensionManager }: withAppTypes) => {
  const {
    viewportGridService,
    uiNotificationService,
    displaySetService,
    hangingProtocolService,
    toolGroupService,
    cornerstoneViewportService,
    segmentationService,
    toolbarService,
  } = servicesManager.services;

  const utilityModule = extensionManager.getModuleEntry(
    '@ohif/extension-cornerstone.utilityModule.common'
  );

  const { getEnabledElement } = utilityModule.exports;

  // [2026-08-06] 初始化 CrosshairDisplayService，注入 servicesManager
  crosshairDisplayService.init(servicesManager);
  // [2026-08-10 修复同步器干扰] 注入 servicesManager 到 TMTVCrosshairService
  // 旋转期间需通过 syncGroupService 临时禁用 cameraPosition 同步器
  tmtvCrosshairService.setServicesManager(servicesManager);

  function _getActiveViewportsEnabledElement() {
    const { activeViewportId } = viewportGridService.getState();
    const { element } = getEnabledElement(activeViewportId) || {};
    const enabledElement = cs.getEnabledElement(element);
    return enabledElement;
  }

  function _getAnnotationsSelectedByToolNames(toolNames) {
    return toolNames.reduce((allAnnotationUIDs, toolName) => {
      const annotationUIDs =
        csTools.annotation.selection.getAnnotationsSelectedByToolName(toolName);

      return allAnnotationUIDs.concat(annotationUIDs);
    }, []);
  }

  // ============================================================================
  // [2026-05-12 新增] 获取PET图像的自定义SUV窗宽窗位
  // ============================================================================
  //
  // 功能：根据PT DisplaySet的元数据判断SUV是否可用，返回对应的VOI范围
  //
  // 返回值：
  //   - SUV可用时：{ windowWidth: 5, windowCenter: 2.5 }
  //     对应SUV值范围 0~5（临床常用PET显示范围）
  //   - SUV不可用时：null（由调用方决定回退策略）
  //
  // 数据来源：
  //   - 从hangingProtocolService获取ptDisplaySet的匹配详情
  //   - 通过MetadataProvider读取DICOM scalingModule元数据
  //   - 检查suvbw（SUV body weight）缩放因子是否存在
  //
  // 与hpViewports.ts中getPTVOIRange自定义属性的关系：
  //   两者逻辑完全一致，hpViewports.ts中的版本用于初始加载，
  //   本函数用于重置时恢复初始值
  //
  // ============================================================================
  function _getPTVOIRange() {
    const { displaySetMatchDetails } = hangingProtocolService.getMatchDetails();
    const ptDisplaySetMatch = displaySetMatchDetails.get('ptDisplaySet');
    if (!ptDisplaySetMatch) return null;

    const ptDisplaySet = displaySetService.getDisplaySetByUID(
      ptDisplaySetMatch.displaySetInstanceUID
    );
    if (!ptDisplaySet) return null;

    const { imageId } = ptDisplaySet.images[0];
    const imageIdScalingFactor = metadataProvider.get('scalingModule', imageId);
    const isSUVAvailable = imageIdScalingFactor && imageIdScalingFactor.suvbw;

    if (isSUVAvailable) {
      return { windowWidth: 10, windowCenter: 5 };
    }
    return null;
  }

  // ============================================================================
  // [2026-05-12 新增] 获取Fusion视口中PT volume对应的volumeId
  // ============================================================================
  //
  // 功能：在Fusion视口中，CT和PT分别作为不同的volume加载，
  //       需要通过volumeId来单独设置PT volume的属性（VOI、colormap等）
  //
  // 参数：
  //   viewport - Cornerstone3D的Viewport实例
  //
  // 返回值：
  //   - 成功：PT volume的volumeId字符串（包含ptDisplaySetInstanceUID）
  //   - 失败：null（非VolumeViewport或找不到PT volume）
  //
  // 实现原理：
  //   viewport.getAllVolumeIds() 返回类似 ["ctVolumeId_XXX", "ptVolumeId_YYY"]
  //   其中ptVolumeId包含ptDisplaySet的displaySetInstanceUID
  //   通过字符串匹配找到PT对应的volumeId
  //
  // ============================================================================
  function _getPTVolumeId(viewport) {
    const { displaySetMatchDetails } = hangingProtocolService.getMatchDetails();
    const ptDisplaySetMatch = displaySetMatchDetails.get('ptDisplaySet');
    if (!ptDisplaySetMatch) return null;

    if (!(viewport instanceof BaseVolumeViewport)) return null;

    const volumeIds = viewport.getAllVolumeIds();
    return volumeIds.find(id => id.includes(ptDisplaySetMatch.displaySetInstanceUID));
  }

  const actions = {
    getMatchingPTDisplaySet: ({ viewportMatchDetails }) => {
      // Todo: this is assuming that the hanging protocol has successfully matched
      // the correct PT. For future, we should have a way to filter out the PTs
      // that are in the viewer layout (but then we have the problem of the attenuation
      // corrected PT vs the non-attenuation correct PT)

      let ptDisplaySet = null;
      for (const [, viewportDetails] of viewportMatchDetails) {
        const { displaySetsInfo } = viewportDetails;
        const displaySets = displaySetsInfo.map(({ displaySetInstanceUID }) =>
          displaySetService.getDisplaySetByUID(displaySetInstanceUID)
        );

        if (!displaySets || displaySets.length === 0) {
          continue;
        }

        ptDisplaySet = displaySets.find(displaySet => displaySet.Modality === 'PT');
        if (ptDisplaySet) {
          break;
        }
      }

      return ptDisplaySet;
    },
    getPTMetadata: ({ ptDisplaySet }) => {
      const dataSource = extensionManager.getDataSources()[0];
      const imageIds = dataSource.getImageIdsForDisplaySet(ptDisplaySet);

      const firstImageId = imageIds[0];
      const instance = metadataProvider.get('instance', firstImageId);
      if (instance.Modality !== 'PT') {
        return;
      }

      const metadata = {
        SeriesTime: instance.SeriesTime,
        Modality: instance.Modality,
        PatientSex: instance.PatientSex,
        PatientWeight: instance.PatientWeight,
        RadiopharmaceuticalInformationSequence: {
          RadionuclideTotalDose:
            instance.RadiopharmaceuticalInformationSequence[0].RadionuclideTotalDose,
          RadionuclideHalfLife:
            instance.RadiopharmaceuticalInformationSequence[0].RadionuclideHalfLife,
          RadiopharmaceuticalStartTime:
            instance.RadiopharmaceuticalInformationSequence[0].RadiopharmaceuticalStartTime,
          RadiopharmaceuticalStartDateTime:
            instance.RadiopharmaceuticalInformationSequence[0].RadiopharmaceuticalStartDateTime,
        },
      };

      return metadata;
    },
    createNewLabelmapFromPT: async ({ label }) => {
      // Create a segmentation of the same resolution as the source data
      // using volumeLoader.createAndCacheDerivedVolume.

      const { viewportMatchDetails } = hangingProtocolService.getMatchDetails();

      const ptDisplaySet = actions.getMatchingPTDisplaySet({
        viewportMatchDetails,
      });

      let withPTViewportId = null;

      for (const [viewportId, { displaySetsInfo }] of viewportMatchDetails.entries()) {
        const isPT = displaySetsInfo.some(
          ({ displaySetInstanceUID }) =>
            displaySetInstanceUID === ptDisplaySet.displaySetInstanceUID
        );

        if (isPT) {
          withPTViewportId = viewportId;
          break;
        }
      }

      if (!ptDisplaySet) {
        uiNotificationService.error('No matching PT display set found');
        return;
      }

      const currentSegmentations =
        segmentationService.getSegmentationRepresentations(withPTViewportId);

      const displaySet = displaySetService.getDisplaySetByUID(ptDisplaySet.displaySetInstanceUID);

      const segmentationId = await segmentationService.createLabelmapForDisplaySet(displaySet, {
        label: `Segmentation ${currentSegmentations.length + 1}`,
        segments: { 1: { label: `${i18n.t('Segment')} 1`, active: true } },
      });

      segmentationService.addSegmentationRepresentation(withPTViewportId, {
        segmentationId,
      });

      return segmentationId;
    },
    thresholdSegmentationByRectangleROITool: ({ segmentationId, config, segmentIndex }) => {
      const segmentation = csTools.segmentation.state.getSegmentation(segmentationId);

      const { representationData } = segmentation;
      const { displaySetMatchDetails: matchDetails } = hangingProtocolService.getMatchDetails();
      const ctDisplaySetMatch = matchDetails.get('ctDisplaySet');
      const ptDisplaySetMatch = matchDetails.get('ptDisplaySet');

      const ctDisplaySet = displaySetService.getDisplaySetByUID(
        ctDisplaySetMatch.displaySetInstanceUID
      );
      const ptDisplaySet = displaySetService.getDisplaySetByUID(
        ptDisplaySetMatch.displaySetInstanceUID
      );

      const { volumeId: segVolumeId } = representationData[
        SegmentationRepresentations.Labelmap
      ] as csTools.Types.LabelmapToolOperationDataVolume;

      const labelmapVolume = cs.cache.getVolume(segVolumeId);

      const annotationUIDs = _getAnnotationsSelectedByToolNames(ROI_THRESHOLD_MANUAL_TOOL_IDS);

      if (annotationUIDs.length === 0) {
        uiNotificationService.show({
          title: 'Commands Module',
          message: 'No ROIThreshold Tool is Selected',
          type: 'error',
        });
        return;
      }

      const { ptLower, ptUpper, ctLower, ctUpper } = getThresholdValues(
        annotationUIDs,
        ptDisplaySet,
        config
      );

      const { imageIds: ptImageIds } = ptDisplaySet;

      const ptVolumeInfo = cs.cache.getVolumeContainingImageId(ptImageIds[0]);

      if (!ptVolumeInfo) {
        uiNotificationService.error('No PT volume found');
        return;
      }

      const { imageIds: ctImageIds } = ctDisplaySet;
      const ctVolumeInfo = cs.cache.getVolumeContainingImageId(ctImageIds[0]);

      if (!ctVolumeInfo) {
        uiNotificationService.error('No CT volume found');
        return;
      }

      const ptVolume = ptVolumeInfo.volume;
      const ctVolume = ctVolumeInfo.volume;

      return csTools.utilities.segmentation.rectangleROIThresholdVolumeByRange(
        annotationUIDs,
        labelmapVolume,
        [
          { volume: ptVolume, lower: ptLower, upper: ptUpper },
          { volume: ctVolume, lower: ctLower, upper: ctUpper },
        ],
        { overwrite: true, segmentIndex, segmentationId }
      );
    },
    calculateTMTV: async ({ segmentations }) => {
      const segmentationIds = segmentations.map(segmentation => segmentation.segmentationId);

      const stats = await csTools.utilities.segmentation.computeMetabolicStats({
        segmentationIds,
        segmentIndex: 1,
      });

      segmentationService.setSegmentationGroupStats(segmentationIds, stats);
      return stats;
    },
    exportTMTVReportCSV: async ({ segmentations, tmtv, config, options }) => {
      const segReport = commandsManager.runCommand('getSegmentationCSVReport', {
        segmentations,
      });

      let total_tlg = 0;
      for (const segmentationId in segReport) {
        const report = segReport[segmentationId];
        const tlg = report['namedStats_lesionGlycolysis'];
        total_tlg += tlg.value;
      }
      const additionalReportRows = [
        { key: 'Total Lesion Glycolysis', value: { tlg: total_tlg.toFixed(4) } },
        { key: 'Threshold Configuration', value: { ...config } },
      ];

      if (tmtv !== undefined) {
        additionalReportRows.unshift({
          key: 'Total Metabolic Tumor Volume',
          value: { tmtv },
        });
      }

      createAndDownloadTMTVReport(segReport, additionalReportRows, options);
    },

    setStartSliceForROIThresholdTool: () => {
      const { viewport } = _getActiveViewportsEnabledElement();
      const { focalPoint } = viewport.getCamera();

      const selectedAnnotationUIDs = _getAnnotationsSelectedByToolNames(
        ROI_THRESHOLD_MANUAL_TOOL_IDS
      );

      const annotationUID = selectedAnnotationUIDs[0];

      const annotation = csTools.annotation.state.getAnnotation(annotationUID);

      // set the current focal point
      annotation.data.startCoordinate = focalPoint;
      // IMPORTANT: invalidate the toolData for the cached stat to get updated
      // and re-calculate the projection points
      annotation.invalidated = true;
      viewport.render();
    },
    setEndSliceForROIThresholdTool: () => {
      const { viewport } = _getActiveViewportsEnabledElement();

      const selectedAnnotationUIDs = _getAnnotationsSelectedByToolNames(
        ROI_THRESHOLD_MANUAL_TOOL_IDS
      );

      const annotationUID = selectedAnnotationUIDs[0];

      const annotation = csTools.annotation.state.getAnnotation(annotationUID);

      // get the current focal point
      const focalPointToEnd = viewport.getCamera().focalPoint;
      annotation.data.endCoordinate = focalPointToEnd;

      // IMPORTANT: invalidate the toolData for the cached stat to get updated
      // and re-calculate the projection points
      annotation.invalidated = true;

      viewport.render();
    },
    createTMTVRTReport: () => {
      // get all Rectangle ROI annotation
      const stateManager = csTools.annotation.state.getAnnotationManager();

      const annotations = [];

      Object.keys(stateManager.annotations).forEach(frameOfReferenceUID => {
        const forAnnotations = stateManager.annotations[frameOfReferenceUID];
        const ROIAnnotations = ROI_THRESHOLD_MANUAL_TOOL_IDS.reduce(
          (annotations, toolName) => [...annotations, ...(forAnnotations[toolName] ?? [])],
          []
        );

        annotations.push(...ROIAnnotations);
      });

      commandsManager.runCommand('exportRTReportForAnnotations', {
        annotations,
      });
    },
    getSegmentationCSVReport: ({ segmentations }) => {
      if (!segmentations || !segmentations.length) {
        segmentations = segmentationService.getSegmentations();
      }

      const report = {};

      for (const segmentation of segmentations) {
        const { label, segmentationId, representationData } =
          segmentation as csTools.Types.Segmentation;
        const id = segmentationId;

        const segReport = { id, label };

        if (!representationData) {
          report[id] = segReport;
          continue;
        }

        const { cachedStats } = segmentation.segments[1] || {}; // Assuming we want stats from the first segment

        if (cachedStats) {
          Object.entries(cachedStats).forEach(([key, value]) => {
            if (typeof value !== 'object') {
              segReport[key] = value;
            } else {
              Object.entries(value).forEach(([subKey, subValue]) => {
                const newKey = `${key}_${subKey}`;
                segReport[newKey] = subValue;
              });
            }
          });
        }

        const labelmapVolume =
          segmentation.representationData[SegmentationRepresentations.Labelmap];

        if (!labelmapVolume) {
          report[id] = segReport;
          continue;
        }

        const referencedVolume =
          csTools.utilities.segmentation.getReferenceVolumeForSegmentationVolume(
            labelmapVolume.volumeId
          );

        if (!referencedVolume) {
          report[id] = segReport;
          continue;
        }

        if (!referencedVolume.imageIds || !referencedVolume.imageIds.length) {
          report[id] = segReport;
          continue;
        }

        const firstImageId = referencedVolume.imageIds[0];
        const instance = OHIF.classes.MetadataProvider.get('instance', firstImageId);

        if (!instance) {
          report[id] = segReport;
          continue;
        }

        report[id] = {
          ...segReport,
          PatientID: instance.PatientID ?? '000000',
          PatientName: formatPN(instance.PatientName),
          StudyInstanceUID: instance.StudyInstanceUID,
          SeriesInstanceUID: instance.SeriesInstanceUID,
          StudyDate: instance.StudyDate,
        };
      }

      return report;
    },
    exportRTReportForAnnotations: ({ annotations }) => {
      dicomRTAnnotationExport(annotations);
    },
    setFusionPTColormap: ({ toolGroupId, colormap }) => {
      const toolGroup = toolGroupService.getToolGroup(toolGroupId);

      if (!toolGroup) {
        return;
      }

      const { viewportMatchDetails } = hangingProtocolService.getMatchDetails();

      const ptDisplaySet = actions.getMatchingPTDisplaySet({
        viewportMatchDetails,
      });

      if (!ptDisplaySet) {
        return;
      }

      const fusionViewportIds = toolGroup.getViewportIds();

      const viewports = [];
      fusionViewportIds.forEach(viewportId => {
        commandsManager.runCommand('setViewportColormap', {
          viewportId,
          displaySetInstanceUID: ptDisplaySet.displaySetInstanceUID,
          colormap: {
            name: colormap,
          },
        });

        viewports.push(cornerstoneViewportService.getCornerstoneViewport(viewportId));
      });

      viewports.forEach(viewport => {
        viewport.render();
      });
    },
    // ============================================================================
    // [2026-05-12 新增] TMTV模式专用视口重置命令
    // ============================================================================
    //
    // 解决问题：
    //   在TMTV模式下调窗PET图像后，点击重置按钮，PET图像和MIP图像黑屏
    //
    // 根因分析：
    //   基础resetViewport命令调用viewport.resetProperties()，
    //   该方法将VOI（窗宽窗位）重置为图像默认值（来自DICOM元数据），
    //   而非TMTV模式使用的自定义SUV值（WW:5, WC:2.5）。
    //   对于SUV缩放的PET数据，默认VOI范围完全错误，导致黑屏。
    //   同时ptWLSync同步组会将错误的VOI传播到MIP视口，导致MIP也黑屏。
    //
    // 修复方案：
    //   根据视口所属的toolGroupId分别处理，对PT/MIP/Fusion视口
    //   在重置后恢复自定义SUV窗宽窗位和其他TMTV特有属性
    //
    // 各视口类型的重置策略：
    // ┌───────────────┬──────────────────┬──────────────────────────────────────┐
    // │ 视口类型      │ toolGroupId      │ 重置策略                             │
    // ├───────────────┼──────────────────┼──────────────────────────────────────┤
    // │ CT视口        │ ctToolGroup      │ resetProperties + resetCamera        │
    // │               │                  │ （CT使用标准HU值，默认重置即可）      │
    // ├───────────────┼──────────────────┼──────────────────────────────────────┤
    // │ PT视口        │ ptToolGroup      │ resetCamera + 恢复SUV VOI + invert  │
    // │               │                  │ （不调用resetProperties，避免VOI错误）│
    // ├───────────────┼──────────────────┼──────────────────────────────────────┤
    // │ MIP视口       │ mipToolGroup     │ resetCamera + 恢复slabThickness      │
    // │               │                  │ + 恢复SUV VOI + invert               │
    // ├───────────────┼──────────────────┼──────────────────────────────────────┤
    // │ Fusion视口    │ fusionToolGroup  │ resetProperties + resetCamera        │
    // │               │                  │ + 恢复PT VOI + 恢复HSV色彩映射       │
    // ├───────────────┼──────────────────┼──────────────────────────────────────┤
    // │ 其他视口      │ (其他)           │ resetProperties + resetCamera        │
    // │               │                  │ （默认行为）                         │
    // └───────────────┴──────────────────┴──────────────────────────────────────┘
    //
    // SUV VOI恢复逻辑：
    //   - SUV可用时：WW=5, WC=2.5 → lower=0, upper=5（SUV范围0~5）
    //   - SUV不可用时：使用resetProperties默认值，但仍设置invert=true
    //
    // Fusion视口的特殊处理：
    //   Fusion视口同时加载CT和PT两个volume，resetProperties会重置所有volume的属性。
    //   因此需要在resetProperties之后，单独恢复PT volume的VOI和HSV色彩映射。
    //   通过_getPTVolumeId()获取PT volume的volumeId，然后使用
    //   viewport.setProperties(properties, volumeId)单独设置PT的属性。
    //
    // ============================================================================
    resetTMTVViewport: () => {
      const enabledElement = _getActiveViewportsEnabledElement();
      if (!enabledElement) return;

      const { viewport } = enabledElement;
      const { activeViewportId } = viewportGridService.getState();
      const viewportInfo = cornerstoneViewportService.getViewportInfo(activeViewportId);
      if (!viewportInfo) return;

      const toolGroupId = viewportInfo.getToolGroupId();
      const ptVOI = _getPTVOIRange();

      // [2026-07-06] 保存当前缩放，resetCamera后恢复，避免图像整体变小
      const currentZoom = viewport.getZoom();

      // ── PT视口重置 ──
      // 只重置相机，不调用resetProperties（避免VOI被重置为错误的默认值）
      // 手动恢复自定义SUV窗宽窗位和反色状态
      if (toolGroupId === 'ptToolGroup') {
        viewport.resetCamera();
        viewport.setZoom(currentZoom);
        if (ptVOI) {
          const { lower, upper } = csUtils.windowLevel.toLowHighRange(
            ptVOI.windowWidth,
            ptVOI.windowCenter
          );
          viewport.setProperties({
            voiRange: { lower, upper },
            invert: true,
          });
        } else {
          viewport.resetProperties?.();
          viewport.setProperties({ invert: true });
        }
        viewport.render();
      // ── MIP视口重置 ──
      // 重置相机 + 恢复slabThickness（resetCamera不会恢复slabThickness）
      // 同时恢复自定义SUV窗宽窗位和反色状态
      } else if (toolGroupId === 'mipToolGroup') {
        viewport.resetCamera();
        viewport.setZoom(currentZoom);
        viewport.setProperties({
          slabThickness: 500,
        });
        if (ptVOI) {
          const { lower, upper } = csUtils.windowLevel.toLowHighRange(
            ptVOI.windowWidth,
            ptVOI.windowCenter
          );
          viewport.setProperties({
            voiRange: { lower, upper },
            invert: true,
          });
        } else {
          viewport.setProperties({ invert: true });
        }
        viewport.render();
      // ── Fusion视口重置 ──
      // 先调用resetProperties重置CT和PT的所有属性
      // 然后单独恢复PT volume的VOI和hot_iron色彩映射
      // 注意：setProperties必须指定volumeId，否则会影响CT volume
      } else if (toolGroupId === 'fusionToolGroup') {
        viewport.resetProperties?.();
        viewport.resetCamera();
        viewport.setZoom(currentZoom);
        if (ptVOI) {
          const ptVolumeId = _getPTVolumeId(viewport);
          if (ptVolumeId) {
            const { lower, upper } = csUtils.windowLevel.toLowHighRange(
              ptVOI.windowWidth,
              ptVOI.windowCenter
            );
            viewport.setProperties(
              {
                voiRange: { lower, upper },
                colormap: {
                  name: 'hsv',
                  opacity: [
                    { value: 0, opacity: 0 },
                    { value: 0.1, opacity: 0.8 },
                    { value: 1, opacity: 0.9 },
                  ],
                },
              },
              ptVolumeId
            );
          }
        }
        viewport.render();
      // ── 其他视口（CT等）──
      // 使用默认重置行为
      } else {
        viewport.resetProperties?.();
        viewport.resetCamera();
        viewport.setZoom(currentZoom);
        viewport.render();
      }

      // [2026-08-11 新增] 重置十字线/单切线旋转角度
      // 在视口重置完成后，调用 TMTVCrosshairService 重置所有旋转角度，
      // 确保十字线和单切线回到初始状态（0度，不旋转）
      tmtvCrosshairService.resetRotationAngles();
    },
    // ============================================================================
    // [2026-05-22 新增] 重置融合微调偏移
    // ============================================================================
    //
    // 功能：重置所有融合视口中PET图像的微调偏移，恢复到原始位置
    //
    // 实现原理：
    //   通过toolGroupService获取fusionToolGroup中的FusionAdjustTool实例，
    //   调用其resetOffset方法逐个视口重置PET actor的position偏移
    //
    // ============================================================================
    resetFusionAdjust: () => {
      try {
        const toolGroup = toolGroupService.getToolGroup('fusionToolGroup');
        if (!toolGroup) return;

        const csToolGroup = (toolGroup as any)._toolGroup || toolGroup;
        const toolInstance = (csToolGroup as any).getToolInstance
          ? (csToolGroup as any).getToolInstance('FusionAdjust')
          : (csToolGroup as any)._toolInstances?.FusionAdjust;

        if (!toolInstance) return;

        // 获取所有融合视口并重置偏移
        const fusionViewportIds = toolGroup.getViewportIds();
        if (fusionViewportIds) {
          fusionViewportIds.forEach(viewportId => {
            const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);
            if (viewport) {
              (toolInstance as any).resetOffset(viewport);
            }
          });
        }
      } catch (e) {
        console.warn('resetFusionAdjust: 重置微调失败', e);
      }
    },
    // ============================================================================
    // [2026-08-04 新增] 设置原生 CrosshairsTool 的可见性
    // ============================================================================
    //
    // 功能：在所有 TMTV 工具组中激活/停用 Cornerstone CrosshairsTool
    //
    // 参数：
    //   visible - true: 激活 CrosshairsTool（setToolActive，显示十字线）
    //             false: 停用 CrosshairsTool（setToolDisabled，隐藏十字线）
    //
    // 使用场景：
    //   1. toggleTMTVCrosshairs 命令在非 TMTV 布局中切换原生十字线
    //   2. handleLayoutChanged 在布局切换时恢复/停用原生十字线
    //
    // 注意：
    //   - 使用 setToolDisabled 而非 setToolPassive，确保十字线完全隐藏
    //     （Passive 模式下十字线 annotation 仍会渲染）
    //   - 覆盖所有四个工具组（CT/PT/Fusion/MIP），确保切换布局后一致
    //
    // ============================================================================
    setNativeCrosshairsVisibility: ({ visible }: { visible: boolean }) => {
      const tgIds = [toolGroupIds.CT, toolGroupIds.PT, toolGroupIds.Fusion, toolGroupIds.MIP];
      tgIds.forEach(tgId => {
        try {
          const toolGroup = toolGroupService.getToolGroup(tgId);
          if (!toolGroup) return;
          const csToolGroup = (toolGroup as any)._toolGroup || toolGroup;
          if (visible) {
            // [2026-08-06] 激活 Crosshairs 前先禁用 SingleSliceLine，避免冲突
            csToolGroup.setToolDisabled('SingleSliceLine');
            commandsManager.runCommand('setToolActiveToolbar', {
              toolName: 'Crosshairs',
              toolGroupIds: [tgId],
            });
          } else {
            // [2026-08-06] 禁用时同时禁用 SingleSliceLine 和 Crosshairs，确保彻底清理
            csToolGroup.setToolDisabled('Crosshairs');
            csToolGroup.setToolDisabled('SingleSliceLine');
          }
        } catch (e) {
          console.warn(`setNativeCrosshairsVisibility: 切换失败 (${tgId})`, e);
        }
      });

      // 触发所有视口重新渲染，确保十字线立即显示/隐藏
      try {
        const vpIds = viewportGridService.getViewportIds();
        if (vpIds) {
          vpIds.forEach(vpId => {
            const vp = cornerstoneViewportService.getCornerstoneViewport(vpId);
            if (vp) vp.render();
          });
        }
      } catch (e) {
        // ignore
      }
    },
    // ============================================================================
    // [2026-08-05 新增] 停用所有工具组中当前激活的主工具
    // ============================================================================
    //
    // 功能：遍历所有 TMTV 工具组，将当前激活的左键主工具设为 Passive 或 Disabled
    //
    // 使用场景：
    //   toggleTMTVCrosshairs 在 TMTV 布局下激活十字线时调用，
    //   确保十字线按钮与其他工具按钮双向互斥：
    //   - 激活十字线 → 停用其他工具（本函数）
    //   - 激活其他工具 → 停用十字线（handlePrimaryToolActivated）
    //
    // 注意：
    //   - 仅停用非 Crosshairs 工具（Crosshairs 由 setNativeCrosshairsVisibility 单独管理）
    //   - 根据 disableOnPassive 配置决定使用 setToolDisabled 或 setToolPassive
    //   - setToolPassive/setToolDisabled 不触发 TOOL_ACTIVATED 事件，
    //     不会引发 handlePrimaryToolActivated 的级联调用
    //
    // ============================================================================
    deactivateActivePrimaryTools: () => {
      const tgIds = [toolGroupIds.CT, toolGroupIds.PT, toolGroupIds.Fusion, toolGroupIds.MIP];
      tgIds.forEach(tgId => {
        try {
          const toolGroup = toolGroupService.getToolGroup(tgId);
          if (!toolGroup) return;
          const csToolGroup = (toolGroup as any)._toolGroup || toolGroup;
          const activeToolName = csToolGroup.getActivePrimaryMouseButtonTool();
          // [2026-08-06] 排除 Crosshairs 和 SingleSliceLine，避免误停用十字线工具
          if (activeToolName && activeToolName !== 'Crosshairs' && activeToolName !== 'SingleSliceLine') {
            const activeToolOptions = csToolGroup.getToolConfiguration(activeToolName);
            if (activeToolOptions?.disableOnPassive) {
              csToolGroup.setToolDisabled(activeToolName);
            } else {
              csToolGroup.setToolPassive(activeToolName);
            }
          }
        } catch (e) {
          console.warn(`deactivateActivePrimaryTools: 停用失败 (${tgId})`, e);
        }
      });
    },
    // ============================================================================
    // [2026-07-30 新增, 2026-08-04 重写, 2026-08-05 双向互斥] TMTV 十字线切换命令
    // ============================================================================
    //
    // 功能：切换十字线显示/隐藏，TMTV 和非 TMTV 布局统一使用
    //       tmtvCrosshairService.visible 作为唯一状态源
    //
    // 核心设计：
    //   tmtvCrosshairService.visible 是两套十字线系统的统一状态：
    //   - TMTV 布局：visible 控制 SVG overlay 的显隐
    //   - 非 TMTV 布局：visible 控制 Cornerstone CrosshairsTool 的激活/停用
    //
    // 双向互斥（2026-08-05 新增）：
    //   - 激活十字线时停用其他工具（TMTV: deactivateActivePrimaryTools; 非TMTV: setToolActiveToolbar 自动停用）
    //   - 激活其他工具时停用十字线（OverlayMenu 的 handlePrimaryToolActivated）
    //
    // 切换逻辑：
    //   1. 取反 visible 状态
    //   2. 根据当前布局类型应用到对应的十字线系统：
    //      - TMTV：setVisible 触发 SVG 重绘 + 停用原生 CrosshairsTool + 停用其他工具
    //      - 非 TMTV：setNativeCrosshairsVisibility 激活/停用 CrosshairsTool（自动停用/恢复其他工具）
    //   3. 刷新工具栏按钮状态
    //
    // ============================================================================
    toggleTMTVCrosshairs: () => {
      const stageId = hangingProtocolService?._getCurrentStageModel?.()?.id || '';
      const isTmtv = tmtvCrosshairService.isTmtvLayout(stageId);

      // [2026-08-06] 如果当前是单切线模式，切换到十字线时应保持可见（不 toggle off）
      // 只有在 normal 模式下才执行 toggle 显隐
      const wasSingleLineMode = crosshairDisplayService.isSingleLineMode();

      // [2026-08-06] 设置模式为 normal，使 SingleSliceLine 按钮失活（互斥）
      crosshairDisplayService.setMode('normal');

      // 统一状态：切换 visible
      // 从单切线切换过来时保持可见，否则 toggle
      const newVisible = wasSingleLineMode ? true : !tmtvCrosshairService.getVisible();

      if (isTmtv) {
        // TMTV 布局：确保 viewport 已注册到 TMTVCrosshairService
        const viewportIds = tmtvCrosshairService.getViewportIdsForStage(stageId);
        viewportIds.forEach(vpId => {
          try {
            const viewport = cornerstoneViewportService.getCornerstoneViewport(vpId);
            if (viewport && !tmtvCrosshairService.getViewport(vpId)) {
              tmtvCrosshairService.addViewport(vpId, viewport);
            }
          } catch (e) {
            console.warn(`toggleTMTVCrosshairs: 注册 viewport 失败 (${vpId})`, e);
          }
        });

        // setVisible 设置 visible 状态并触发 SVG 重绘
        tmtvCrosshairService.setVisible(newVisible);

        // 停用原生 CrosshairsTool，避免两套十字线系统同时显示
        actions.setNativeCrosshairsVisibility({ visible: false });

        if (newVisible) {
          // [2026-08-05 双向互斥] 激活十字线时停用其他工具，
          // 使其他工具按钮（WindowLevel/Pan/Zoom 等）显示为非激活状态。
          // 非 TMTV 布局不需要此步骤，因为 setToolActiveToolbar 会自动停用前一个工具。
          actions.deactivateActivePrimaryTools();
        }
      } else {
        // 非 TMTV 布局：设置统一状态（render 是 no-op，因为无 SVG viewport 注册）
        tmtvCrosshairService.setVisible(newVisible);

        // 根据新状态激活/停用原生 CrosshairsTool
        // setToolActiveToolbar 会自动停用前一个激活的工具，实现互斥
        actions.setNativeCrosshairsVisibility({ visible: newVisible });
      }

      // 刷新工具栏状态，使 Crosshairs 按钮的 isActive 更新（蓝色背景）
      // evaluate.tmtvCrosshair 依赖 tmtvCrosshairService.getVisible()
      // 必须传 viewportId，否则其他按钮（如 WindowLevel）的 evaluator 会丢失 isActive
      const { activeViewportId: activeVpId } = viewportGridService.getState();
      toolbarService.refreshToolbarState({ viewportId: activeVpId });
    },

    // [2026-08-05 第四阶段 Phase 4.1] 旋转十字线（测试函数）
    // 调用 tmtvCrosshairService.rotateCrosshair 旋转指定角度
    // CT/PET/Fusion 同步旋转，MIP 不参与
    rotateCrosshair: ({ degrees }: { degrees: number }) => {
      tmtvCrosshairService.rotateCrosshair(degrees);
    },

    // [2026-08-06 单切线旋转第一阶段] 启用单切线模式
    // 通过 CrosshairDisplayService 统一管理，根据布局类型自动路由：
    //   - TMTV 布局 → SVG overlay 显示十字线
    //   - 旧 MPR 布局 → SingleSliceLineTool 显示十字线（单切线旋转）
    enableSingleLine: () => {
      // 如果已可见且为单切线模式，则切换为关闭（toggle 行为）
      if (crosshairDisplayService.isVisible() && crosshairDisplayService.isSingleLineMode()) {
        crosshairDisplayService.disable();
      } else {
        crosshairDisplayService.enable('singleLineRotate');
        // [2026-08-06] TMTV 布局下激活十字线时停用其他工具（互斥）
        // 非 TMTV 布局下 setToolActive 会自动停用前一个工具，不需要此步骤
        const stageId = hangingProtocolService?._getCurrentStageModel?.()?.id || '';
        if (tmtvCrosshairService.isTmtvLayout(stageId)) {
          actions.deactivateActivePrimaryTools();
        }
      }
    },

    // [2026-08-06 单切线旋转第一阶段] 禁用单切线模式
    disableSingleLine: () => {
      crosshairDisplayService.disable();
    },
  };

  const definitions = {
    setEndSliceForROIThresholdTool: {
      commandFn: actions.setEndSliceForROIThresholdTool,
    },
    setStartSliceForROIThresholdTool: {
      commandFn: actions.setStartSliceForROIThresholdTool,
    },
    getMatchingPTDisplaySet: {
      commandFn: actions.getMatchingPTDisplaySet,
    },
    getPTMetadata: {
      commandFn: actions.getPTMetadata,
    },
    createNewLabelmapFromPT: {
      commandFn: actions.createNewLabelmapFromPT,
    },
    thresholdSegmentationByRectangleROITool: {
      commandFn: actions.thresholdSegmentationByRectangleROITool,
    },
    calculateTMTV: {
      commandFn: actions.calculateTMTV,
    },
    exportTMTVReportCSV: {
      commandFn: actions.exportTMTVReportCSV,
    },
    createTMTVRTReport: {
      commandFn: actions.createTMTVRTReport,
    },
    getSegmentationCSVReport: {
      commandFn: actions.getSegmentationCSVReport,
    },
    exportRTReportForAnnotations: {
      commandFn: actions.exportRTReportForAnnotations,
    },
    setFusionPTColormap: {
      commandFn: actions.setFusionPTColormap,
    },
    resetTMTVViewport: {
      commandFn: actions.resetTMTVViewport,
    },
    resetFusionAdjust: {
      commandFn: actions.resetFusionAdjust,
    },
    toggleTMTVCrosshairs: {
      commandFn: actions.toggleTMTVCrosshairs,
    },
    setNativeCrosshairsVisibility: {
      commandFn: actions.setNativeCrosshairsVisibility,
    },
    rotateCrosshair: {
      commandFn: actions.rotateCrosshair,
    },
    enableSingleLine: {
      commandFn: actions.enableSingleLine,
    },
    disableSingleLine: {
      commandFn: actions.disableSingleLine,
    },
  };

  return {
    actions,
    definitions,
    defaultContext: 'TMTV:CORNERSTONE',
  };
};

export default commandsModule;
