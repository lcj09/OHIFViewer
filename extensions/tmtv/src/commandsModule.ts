import OHIF from '@ohif/core';
import * as cs from '@cornerstonejs/core';
import { utilities as csUtils, BaseVolumeViewport } from '@cornerstonejs/core';
import * as csTools from '@cornerstonejs/tools';
import { classes } from '@ohif/core';
import i18n from '@ohif/i18n';
import getThresholdValues from './utils/getThresholdValue';
import createAndDownloadTMTVReport, {
  createAndDownloadTMTVReportExcel,
  openTMTVReportPrintWindow,
} from './utils/createAndDownloadTMTVReport';

import dicomRTAnnotationExport from './utils/dicomRTAnnotationExport/RTStructureSet';

import { Enums } from '@cornerstonejs/tools';
import { utils } from '@ohif/core';
import tmtvCrosshairService from './services/TMTVCrosshairService';
import crosshairDisplayService from './services/CrosshairDisplayService';
import resetComparisonViewports from './utils/resetComparisonViewports';
import resetTMTVCamera from './utils/resetTMTVCamera';
import {
  clearTMTVMeasurements,
  getAnnotationStudyUID,
  getViewportStudyUID,
} from './utils/comparisonMeasurements';
import tmtvLesionService from './services/TMTVLesionService';
import tmtvLesionHighlightService from './services/TMTVLesionHighlightService';
import tmtvSegmentMaskStorageService from './services/TMTVSegmentMaskStorageService';
import tmtvAutoSegmentationService from './services/TMTVAutoSegmentationService';
import { createTMTVReportSections } from './services/TMTVReportService';
import { getDimensions } from './services/TMTVStatisticsService';
import { toolGroupIds } from '../../../modes/tmtv/src/initToolGroups';
import tmtvComparisonService, { VIEWPORT_IDS_BY_SIDE } from './services/TMTVComparisonService';
import tmtvSessionService from './services/TMTVSessionService';
import {
  findModalityDisplaySetForSide,
  getExistingSessionSegmentationIds,
} from './utils/tmtvSegmentationScope';
import addSegmentationRepresentationPreservingCamera from './utils/addSegmentationRepresentationPreservingCamera';

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

  /** 2026-09-02 功能说明：统一使用 OHIF 支持的通知接口显示 TMTV 命令错误。 */
  function showTMTVError(message: string, title = 'TMTV') {
    uiNotificationService.show({ title, message, type: 'error' });
  }

  // [2026-08-06] 初始化 CrosshairDisplayService，注入 servicesManager
  crosshairDisplayService.init(servicesManager);
  // [2026-08-10 修复同步器干扰] 注入 servicesManager 到 TMTVCrosshairService
  // 旋转期间需通过 syncGroupService 临时禁用 cameraPosition 同步器
  tmtvCrosshairService.setServicesManager(servicesManager);
  // [2026-08-25 功能] 注入服务用于 lesion 选中高亮，保持高亮层与真实 Segment 1 分离
  tmtvLesionHighlightService.init(servicesManager);

  function _getActiveViewportsEnabledElement() {
    const { activeViewportId } = viewportGridService.getState();
    const { element } = getEnabledElement(activeViewportId) || {};
    const enabledElement = cs.getEnabledElement(element);
    return enabledElement;
  }

  function _getAnnotationsSelectedByToolNames(toolNames) {
    const selectedAnnotationUIDs = toolNames.reduce((allAnnotationUIDs, toolName) => {
      const annotationUIDs =
        csTools.annotation.selection.getAnnotationsSelectedByToolName(toolName);

      return allAnnotationUIDs.concat(annotationUIDs);
    }, []);

    if (!tmtvComparisonService.isComparisonProtocolActive(servicesManager)) {
      return selectedAnnotationUIDs;
    }

    // 2026-09-02 功能说明：对比模式只使用当前检查的 ROI，避免共享标注状态把另一侧范围带入阈值计算。
    const activeViewportId = viewportGridService.getActiveViewportId?.();
    const activeStudyUID = getViewportStudyUID(servicesManager, activeViewportId);
    if (!activeStudyUID) return [];

    return selectedAnnotationUIDs.filter(annotationUID => {
      const annotation = csTools.annotation.state.getAnnotation(annotationUID);
      return getAnnotationStudyUID(annotation, servicesManager) === activeStudyUID;
    });
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
      // [2026-08-14 修复] 与index.ts中getPTVOIRange初始加载值保持一致（WW=5, WC=2.5 → SUV 0~5）
      // 此前此处返回WW=10/WC=5，导致点击重置按钮后窗宽窗位被改变
      return { windowWidth: 5, windowCenter: 2.5 };
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
    const ptDisplaySet = findModalityDisplaySetForSide(
      displaySetMatchDetails,
      displaySetService,
      'PT',
      tmtvSessionService.getActiveSide()
    );
    if (!ptDisplaySet) return null;

    if (!(viewport instanceof BaseVolumeViewport)) return null;

    const volumeIds = viewport.getAllVolumeIds();
    return volumeIds.find(id => id.includes(ptDisplaySet.displaySetInstanceUID));
  }

  function getReferenceVolumeForSegmentationVolume(segmentationVolumeId) {
    // [2026-08-26 功能] 全身 SUV 阈值自动分割：从 Segment 1 派生 labelmap 反查 PT reference volume，失败时由调用方给出业务提示
    if (!segmentationVolumeId) {
      return null;
    }

    try {
      return csTools.utilities.segmentation.getReferenceVolumeForSegmentationVolume(
        segmentationVolumeId
      );
    } catch (error) {
      return null;
    }
  }

  function getPrimaryTMTVSegmentationId() {
    // [2026-08-26 功能] TMTV 分割编辑目标保护：优先使用当前视口的真实 Segment 1，避免 Brush/Eraser 误编辑高亮层
    const activeViewportId = viewportGridService.getActiveViewportId?.();
    const activeSegmentation = activeViewportId
      ? segmentationService.getActiveSegmentation?.(activeViewportId)
      : null;

    const activeSession = tmtvSessionService.getActiveSession();
    const comparisonActive = tmtvComparisonService.isComparisonProtocolActive(servicesManager);
    const scopedSegmentationIds = getExistingSessionSegmentationIds(
      activeSession,
      segmentationService,
      id => tmtvLesionHighlightService.isHighlightSegmentationId(id)
    );
    const isAllowed = segmentationId =>
      !!segmentationId &&
      !tmtvLesionHighlightService.isHighlightSegmentationId(segmentationId) &&
      (!comparisonActive || scopedSegmentationIds.includes(segmentationId));

    // 2026-09-02 功能说明：视口 representation 已先于面板就绪时，从当前侧视口补登记其真实分割。
    const registerCurrentViewportSegmentation = segmentationId => {
      if (!comparisonActive || !segmentationId || scopedSegmentationIds.length) return false;
      const viewportSide = tmtvComparisonService.getSideForViewportId(activeViewportId);
      if (viewportSide !== activeSession?.side) return false;
      tmtvSessionService.setSegmentationIds(viewportSide, [segmentationId], segmentationId);
      return true;
    };

    if (activeSegmentation?.segmentationId && isAllowed(activeSegmentation.segmentationId)) {
      return activeSegmentation.segmentationId;
    }

    if (
      activeSegmentation?.segmentationId &&
      !tmtvLesionHighlightService.isHighlightSegmentationId(activeSegmentation.segmentationId) &&
      registerCurrentViewportSegmentation(activeSegmentation.segmentationId)
    ) {
      return activeSegmentation.segmentationId;
    }

    if (activeViewportId) {
      const activeViewportRepresentations =
        segmentationService.getSegmentationRepresentations?.(activeViewportId) ?? [];
      const getRepresentationId = representation =>
        representation.segmentationId ?? representation.segmentation?.segmentationId;
      let activeViewportPrimary = activeViewportRepresentations.find(representation =>
        isAllowed(getRepresentationId(representation))
      );
      if (!activeViewportPrimary && comparisonActive && !scopedSegmentationIds.length) {
        activeViewportPrimary = activeViewportRepresentations.find(representation => {
          const segmentationId = getRepresentationId(representation);
          return (
            !tmtvLesionHighlightService.isHighlightSegmentationId(segmentationId) &&
            registerCurrentViewportSegmentation(segmentationId)
          );
        });
      }
      const activeViewportPrimaryId =
        activeViewportPrimary?.segmentationId ??
        activeViewportPrimary?.segmentation?.segmentationId;

      if (activeViewportPrimaryId) {
        return activeViewportPrimaryId;
      }
    }

    if (comparisonActive) return scopedSegmentationIds[0];

    return segmentationService
      .getSegmentations()
      .find(
        segmentation =>
          !tmtvLesionHighlightService.isHighlightSegmentationId(segmentation.segmentationId)
      )?.segmentationId;
  }

  /** 2026-09-02 功能说明：对比命令显式传递 Session；单检查返回空以保持原 lesion 持久化键。 */
  function getActiveLesionSessionId(): string | undefined {
    const session = tmtvSessionService.getActiveSession();
    return session?.side === 'baseline' || session?.side === 'followup'
      ? session.sessionId
      : undefined;
  }

  const actions = {
    // 2026-08-31 功能说明：对比模式的清除操作只作用于当前检查。
    clearTMTVMeasurements: () => clearTMTVMeasurements(servicesManager, commandsManager),
    getMatchingPTDisplaySet: ({
      viewportMatchDetails,
      side = tmtvSessionService.getActiveSide(),
    }) => {
      // Todo: this is assuming that the hanging protocol has successfully matched
      // the correct PT. For future, we should have a way to filter out the PTs
      // that are in the viewer layout (but then we have the problem of the attenuation
      // corrected PT vs the non-attenuation correct PT)

      return findModalityDisplaySetForSide(viewportMatchDetails, displaySetService, 'PT', side);
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
    getTMTVSegmentMaskReferenceContext: ({ segmentIndex = 1 } = {}) => {
      // [2026-08-27 功能] 本地存储管理 UI：从当前 PT displaySet/viewport 解析本地 mask 查询上下文，刷新初期 viewport volume 未就绪时使用 imageId cache 兜底
      const { viewportMatchDetails } = hangingProtocolService.getMatchDetails();
      const activeSide = tmtvSessionService.getActiveSide();
      const ptDisplaySet = actions.getMatchingPTDisplaySet({
        viewportMatchDetails,
        side: activeSide,
      });

      if (!ptDisplaySet) {
        return null;
      }

      let withPTViewportId =
        activeSide === 'single'
          ? null
          : VIEWPORT_IDS_BY_SIDE[activeSide]?.find(viewportId => viewportId.includes('PTAxial'));

      const preferredPTMatch = withPTViewportId
        ? viewportMatchDetails
            .get(withPTViewportId)
            ?.displaySetsInfo?.some(
              ({ displaySetInstanceUID }) =>
                displaySetInstanceUID === ptDisplaySet.displaySetInstanceUID
            )
        : false;
      if (!preferredPTMatch) withPTViewportId = null;

      for (const [viewportId, { displaySetsInfo }] of viewportMatchDetails.entries()) {
        if (withPTViewportId) break;
        if (activeSide !== 'single' && !String(viewportId).toLowerCase().startsWith(activeSide)) {
          continue;
        }
        const isPT = displaySetsInfo.some(
          ({ displaySetInstanceUID }) =>
            displaySetInstanceUID === ptDisplaySet.displaySetInstanceUID
        );

        if (isPT) {
          withPTViewportId = viewportId;
          break;
        }
      }

      let referenceVolume = null;

      if (withPTViewportId) {
        const ptViewport = cornerstoneViewportService.getCornerstoneViewport(withPTViewportId);
        const ptVolumeId = _getPTVolumeId(ptViewport);
        referenceVolume = ptVolumeId ? cs.cache.getVolume(ptVolumeId) : null;
      }

      if (!referenceVolume) {
        const dataSource = extensionManager.getDataSources()?.[0];
        const imageIds =
          ptDisplaySet.imageIds ?? dataSource?.getImageIdsForDisplaySet?.(ptDisplaySet) ?? [];
        const firstImageId = imageIds[0];
        const ptVolumeInfo = firstImageId
          ? cs.cache.getVolumeContainingImageId(firstImageId)
          : null;

        referenceVolume = ptVolumeInfo?.volume ?? null;
      }

      const dimensions = getDimensions(referenceVolume);

      if (!referenceVolume || !dimensions) {
        return null;
      }

      return {
        referenceVolume,
        segmentIndex,
        dimensions,
      };
    },
    hasPersistedTMTVSegmentMask: async () => {
      // [2026-08-26 功能] 本地分割恢复：只检测当前 PT volume 是否存在可恢复 mask，不创建 segmentation、不影响 viewport
      const referenceContext = actions.getTMTVSegmentMaskReferenceContext({
        segmentIndex: 1,
      });

      if (!referenceContext) {
        return false;
      }

      return await tmtvSegmentMaskStorageService.hasSegmentMaskForReferenceVolume(referenceContext);
    },
    getTMTVSegmentMaskStorageInfo: async ({ segmentIndex = 1 } = {}) => {
      // [2026-08-27 功能] 本地存储管理 UI：查询当前病例浏览器本地保存摘要，供右侧面板显示保存状态/时间/体素数
      const referenceContext = actions.getTMTVSegmentMaskReferenceContext({
        segmentIndex,
      });

      if (!referenceContext) {
        return null;
      }

      return await tmtvSegmentMaskStorageService.getSegmentMaskInfoForReferenceVolume(
        referenceContext
      );
    },
    clearTMTVSegmentMaskStorage: async ({ segmentIndex = 1 } = {}) => {
      // [2026-08-27 功能] 本地存储管理 UI：只清除当前病例本地 IndexedDB mask，不修改当前内存中的 Segment 1 分割
      const referenceContext = actions.getTMTVSegmentMaskReferenceContext({
        segmentIndex,
      });

      if (!referenceContext) {
        return false;
      }

      const didDelete =
        await tmtvSegmentMaskStorageService.deleteSegmentMaskForReferenceVolume(referenceContext);

      uiNotificationService.show({
        title: 'TMTV Local Segmentation',
        message: didDelete ? 'Local segmentation was cleared.' : 'No local segmentation found.',
        type: didDelete ? 'success' : 'warning',
      });

      return didDelete;
    },
    createNewLabelmapFromPT: async ({
      label = undefined,
      restoreOnlyIfPersistedMask = false,
    } = {}) => {
      // 2026-09-02 功能说明：按当前 Session 的 PET 创建 labelmap，对比模式不回退到另一检查。

      const { viewportMatchDetails } = hangingProtocolService.getMatchDetails();
      const activeSide = tmtvSessionService.getActiveSide();

      const ptDisplaySet = actions.getMatchingPTDisplaySet({
        viewportMatchDetails,
        side: activeSide,
      });

      if (!ptDisplaySet) {
        showTMTVError('No matching PT display set found');
        return;
      }

      let withPTViewportId =
        activeSide === 'single'
          ? null
          : VIEWPORT_IDS_BY_SIDE[activeSide]?.find(viewportId => viewportId.includes('PTAxial'));

      const preferredPTMatch = withPTViewportId
        ? viewportMatchDetails
            .get(withPTViewportId)
            ?.displaySetsInfo?.some(
              ({ displaySetInstanceUID }) =>
                displaySetInstanceUID === ptDisplaySet.displaySetInstanceUID
            )
        : false;
      if (!preferredPTMatch) withPTViewportId = null;

      for (const [viewportId, { displaySetsInfo }] of viewportMatchDetails.entries()) {
        if (withPTViewportId) break;
        if (activeSide !== 'single' && !String(viewportId).toLowerCase().startsWith(activeSide)) {
          continue;
        }
        const isPT = displaySetsInfo.some(
          ({ displaySetInstanceUID }) =>
            displaySetInstanceUID === ptDisplaySet.displaySetInstanceUID
        );

        if (isPT) {
          withPTViewportId = viewportId;
          break;
        }
      }

      if (!withPTViewportId) {
        showTMTVError('No viewport showing matching PT display set found');
        return;
      }

      if (restoreOnlyIfPersistedMask) {
        const ptViewport = cornerstoneViewportService.getCornerstoneViewport(withPTViewportId);
        const ptVolumeId = _getPTVolumeId(ptViewport);
        const ptVolume = ptVolumeId ? cs.cache.getVolume(ptVolumeId) : null;
        const dimensions = getDimensions(ptVolume);
        const hasPersistedMask =
          !!ptVolume &&
          !!dimensions &&
          (await tmtvSegmentMaskStorageService.hasSegmentMaskForReferenceVolume({
            referenceVolume: ptVolume,
            segmentIndex: 1,
            dimensions,
          }));

        if (!hasPersistedMask) {
          return;
        }
      }

      const currentSegmentations =
        segmentationService.getSegmentationRepresentations(withPTViewportId);

      const displaySet = displaySetService.getDisplaySetByUID(ptDisplaySet.displaySetInstanceUID);

      const segmentationId = await segmentationService.createLabelmapForDisplaySet(displaySet, {
        label: label ?? `Segmentation ${currentSegmentations.length + 1}`,
        segments: { 1: { label: `${i18n.t('Segment')} 1`, active: true } },
      });

      // [2026-08-26 功能] IndexedDB 稀疏保存/恢复 Segment 1 mask：等待空 labelmap representation 建立后再返回，保证后续可立即写回恢复 mask
      if (activeSide === 'single') {
        await segmentationService.addSegmentationRepresentation(withPTViewportId, {
          segmentationId,
        });
      } else {
        await addSegmentationRepresentationPreservingCamera(
          servicesManager,
          withPTViewportId,
          segmentationId
        );
      }

      if (activeSide !== 'single') {
        const fusionViewportId = VIEWPORT_IDS_BY_SIDE[activeSide]?.find(viewportId =>
          viewportId.includes('Fusion')
        );
        if (fusionViewportId && fusionViewportId !== withPTViewportId) {
          try {
            await addSegmentationRepresentationPreservingCamera(
              servicesManager,
              fusionViewportId,
              segmentationId
            );
          } catch (error) {
            console.warn('createNewLabelmapFromPT: add fusion representation failed', error);
          }
        }
      }

      const currentSession = tmtvSessionService.getSession(activeSide);
      tmtvSessionService.setSegmentationIds(
        activeSide,
        [...(currentSession?.segmentationIds || []), segmentationId],
        segmentationId
      );

      return segmentationId;
    },
    thresholdSegmentationByRectangleROITool: ({ segmentationId, config, segmentIndex }) => {
      const segmentation = csTools.segmentation.state.getSegmentation(segmentationId);

      if (!segmentation) {
        showTMTVError('No segmentation found for current examination');
        return;
      }

      const { representationData } = segmentation;
      const { viewportMatchDetails } = hangingProtocolService.getMatchDetails();
      const activeSide = tmtvSessionService.getActiveSide();
      const ctDisplaySet = findModalityDisplaySetForSide(
        viewportMatchDetails,
        displaySetService,
        'CT',
        activeSide
      );
      const ptDisplaySet = findModalityDisplaySetForSide(
        viewportMatchDetails,
        displaySetService,
        'PT',
        activeSide
      );

      if (!ctDisplaySet || !ptDisplaySet) {
        showTMTVError('No matching CT/PT display set found for current examination');
        return;
      }

      const labelmapData = representationData?.[SegmentationRepresentations.Labelmap] as
        | csTools.Types.LabelmapToolOperationDataVolume
        | undefined;
      const segVolumeId = labelmapData?.volumeId;

      const labelmapVolume = segVolumeId ? cs.cache.getVolume(segVolumeId) : null;
      if (!labelmapVolume) {
        showTMTVError('No labelmap volume found for current segmentation');
        return;
      }

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
        showTMTVError('No PT volume found');
        return;
      }

      const { imageIds: ctImageIds } = ctDisplaySet;
      const ctVolumeInfo = cs.cache.getVolumeContainingImageId(ctImageIds[0]);

      if (!ctVolumeInfo) {
        showTMTVError('No CT volume found');
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
    autoSegmentTMTVBySUVThreshold: async ({
      segmentationId,
      threshold = 2.5,
      minVolumeML = 0.1,
      writeMode = 'overwrite',
      segmentIndex = 1,
    } = {}) => {
      // [2026-08-26 功能] 全身 SUV 阈值自动分割：统一写入 Segment 1，后续 Lesion candidate/统计/报告复用已有刷新链路
      const operationSide = tmtvSessionService.getActiveSide();
      let targetSegmentationId = segmentationId;

      if (!targetSegmentationId) {
        const activeSession = tmtvSessionService.getActiveSession();
        const scopedSegmentationIds = getExistingSessionSegmentationIds(
          activeSession,
          segmentationService,
          id => tmtvLesionHighlightService.isHighlightSegmentationId(id)
        );
        targetSegmentationId = scopedSegmentationIds[0];

        if (!targetSegmentationId && activeSession?.side === 'single') {
          targetSegmentationId = segmentationService
            .getSegmentations()
            .find(
              segmentation =>
                !tmtvLesionHighlightService.isHighlightSegmentationId(segmentation.segmentationId)
            )?.segmentationId;
        }
      }

      if (!targetSegmentationId) {
        targetSegmentationId = await actions.createNewLabelmapFromPT({
          label: 'TMTV Segmentation',
        });
      }

      if (tmtvSessionService.getActiveSide() !== operationSide) {
        // 2026-09-02 功能说明：创建 labelmap 期间发生切侧时终止旧请求，避免写入新侧 Session。
        return null;
      }

      const segmentation = targetSegmentationId
        ? segmentationService.getSegmentation(targetSegmentationId)
        : null;
      const labelmapData =
        segmentation?.representationData?.[SegmentationRepresentations.Labelmap] ??
        segmentation?.representationData?.Labelmap;
      const segmentationVolumeId = labelmapData?.volumeId;
      const segmentationVolume = segmentationVolumeId
        ? cs.cache.getVolume(segmentationVolumeId)
        : null;
      const referenceVolume = getReferenceVolumeForSegmentationVolume(segmentationVolumeId);

      if (!segmentation || !segmentationVolume || !referenceVolume) {
        uiNotificationService.show({
          title: 'TMTV Auto Segmentation',
          message: 'Create Segment 1 from the PT volume before running auto segmentation.',
          type: 'error',
        });
        return null;
      }

      try {
        const result = tmtvAutoSegmentationService.runSUVThresholdSegmentation({
          segmentationId: targetSegmentationId,
          segmentationVolume,
          referenceVolume,
          segmentIndex,
          threshold,
          minVolumeML,
          writeMode: writeMode === 'append' ? 'append' : 'overwrite',
        });

        segmentationService.setActiveSegment?.(targetSegmentationId, segmentIndex);
        const currentSession = tmtvSessionService.getSession(operationSide);
        tmtvSessionService.setSegmentationIds(
          operationSide,
          [...(currentSession?.segmentationIds || []), targetSegmentationId],
          targetSegmentationId
        );
        uiNotificationService.show({
          title: 'TMTV Auto Segmentation',
          message: `Generated ${result.keptComponentCount} candidates, filtered ${result.filteredComponentCount} small components.`,
          type: result.voxelCount ? 'success' : 'warning',
        });

        return result;
      } catch (error) {
        console.error('autoSegmentTMTVBySUVThreshold failed', error);
        uiNotificationService.show({
          title: 'TMTV Auto Segmentation',
          message: error instanceof Error ? error.message : 'Auto segmentation failed.',
          type: 'error',
        });
        return null;
      }
    },
    ensurePrimaryTMTVSegmentationActive: ({ clearSelection = false } = {}) => {
      // [2026-08-26 功能] TMTV Brush/Eraser 前恢复真实 Segment 1 为 active，避免擦除高亮层后 lesion 列表不刷新
      const primarySegmentationId = getPrimaryTMTVSegmentationId();

      if (!primarySegmentationId) {
        return null;
      }

      const activeSide = tmtvSessionService.getActiveSide();
      const activeSession = tmtvSessionService.getSession(activeSide);
      const segmentationIds = tmtvComparisonService.isComparisonProtocolActive(servicesManager)
        ? getExistingSessionSegmentationIds(activeSession, segmentationService, id =>
            tmtvLesionHighlightService.isHighlightSegmentationId(id)
          )
        : segmentationService
            .getSegmentations()
            .map(segmentation => segmentation?.segmentationId)
            .filter(
              segmentationId =>
                segmentationId &&
                !tmtvLesionHighlightService.isHighlightSegmentationId(segmentationId)
            );
      const viewportIds =
        cornerstoneViewportService?.getViewportIds?.() ??
        viewportGridService?.getViewportIds?.() ??
        Array.from(viewportGridService?.getState?.()?.viewports?.keys?.() ?? []);

      segmentationService.setActiveSegment?.(primarySegmentationId, 1);

      viewportIds.forEach(viewportId => {
        const representations = segmentationService.getSegmentationRepresentations?.(viewportId, {
          segmentationId: primarySegmentationId,
          type: SegmentationRepresentations.Labelmap,
        });

        if (!representations?.length) {
          return;
        }

        segmentationService.setActiveSegmentation?.(viewportId, primarySegmentationId);
      });

      if (clearSelection) {
        tmtvLesionService.selectLesion(segmentationIds, null, getActiveLesionSessionId());
        tmtvLesionHighlightService.clearHighlight(segmentationIds);
      }

      return primarySegmentationId;
    },
    calculateTMTV: async ({ segmentations }) => {
      // 2026-09-02 功能说明：只计算 Cornerstone 状态中已完整注册的 labelmap，兼容新建分割事件先于面板渲染。
      const segmentationIds = (segmentations || [])
        .map(segmentation => segmentation?.segmentationId)
        .filter(segmentationId => {
          if (!segmentationId) return false;
          const cornerstoneSegmentation =
            csTools.segmentation.state.getSegmentation(segmentationId);
          return !!cornerstoneSegmentation?.representationData?.[
            SegmentationRepresentations.Labelmap
          ];
        });

      if (!segmentationIds.length) {
        return null;
      }

      const stats = await csTools.utilities.segmentation.computeMetabolicStats({
        segmentationIds,
        segmentIndex: 1,
      });

      segmentationService.setSegmentationGroupStats(segmentationIds, stats);
      return stats;
    },
    selectTMTVLesion: async ({ segmentationIds, lesionId }) => {
      // [2026-08-27 功能] 单击 lesion 时同步定位到病灶中心层，避免小病灶只在列表高亮但图像页不可见
      const lesion = tmtvLesionService.selectLesion(
        segmentationIds,
        lesionId,
        getActiveLesionSessionId()
      );

      await tmtvLesionHighlightService.highlightLesion(segmentationIds, lesion);

      if (lesion?.centroid?.length === 3) {
        const lesionCentroid = lesion.centroid as [number, number, number];

        if (crosshairDisplayService.isVisible?.()) {
          tmtvCrosshairService.setPosition(lesionCentroid);
        }

        const viewportIds =
          segmentationService.getViewportIdsWithSegmentation?.(lesion.segmentationId) ??
          viewportGridService?.getViewportIds?.() ??
          [];

        viewportIds.forEach(viewportId => {
          try {
            const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);

            if (!viewport?.jumpToWorld) {
              return;
            }

            viewport.jumpToWorld(lesionCentroid);
            viewport.render?.();
          } catch (error) {
            console.warn('selectTMTVLesion: jump to lesion failed', viewportId, error);
          }
        });
      }

      const activeViewportId = viewportGridService.getActiveViewportId?.();
      if (activeViewportId) {
        toolbarService.refreshToolbarState?.({ viewportId: activeViewportId });
      }
    },
    deleteTMTVLesion: ({ segmentationIds = [], lesionId }) => {
      // [2026-08-24 功能] 删除病灶后使用增量 totals，避免立即触发全量 TMTV/lesion 重算造成卡顿
      const sessionId = getActiveLesionSessionId();
      const previousLesionState = tmtvLesionService.getState(segmentationIds, sessionId);
      const shouldClearHighlight = previousLesionState.selectedLesionId === lesionId;
      const lesionState = tmtvLesionService.deleteLesion(lesionId, 1, sessionId);

      if (lesionState) {
        if (shouldClearHighlight) {
          // [2026-08-25 功能] 删除当前选中的 lesion 时同步清空独立高亮 mask，避免残留视觉层
          tmtvLesionHighlightService.clearHighlight(lesionState.segmentationIds);
        }

        segmentationService.setSegmentationGroupStats(lesionState.segmentationIds, {
          tmtv: lesionState.totals.tmtv,
          tlg: lesionState.totals.tlg,
        });
      }
    },
    deleteTMTVLesions: ({ segmentationIds = [], lesionIds = [] }) => {
      // [2026-08-27 功能] 批量 Delete rejected 病灶：真实清空 Segment 1 连通域，替代逐层橡皮擦清除
      const sessionId = getActiveLesionSessionId();
      const previousLesionState = tmtvLesionService.getState(segmentationIds, sessionId);
      const targetLesionIds = new Set((lesionIds ?? []).filter(Boolean));
      const shouldClearHighlight =
        !!previousLesionState.selectedLesionId &&
        targetLesionIds.has(previousLesionState.selectedLesionId);
      const lesionState = tmtvLesionService.deleteLesions(segmentationIds, lesionIds, 1, sessionId);

      if (lesionState) {
        if (shouldClearHighlight) {
          tmtvLesionHighlightService.clearHighlight(lesionState.segmentationIds);
        }

        segmentationService.setSegmentationGroupStats(lesionState.segmentationIds, {
          tmtv: lesionState.totals.tmtv,
          tlg: lesionState.totals.tlg,
        });
      }
    },
    setTMTVLesionStatus: ({ segmentationIds = [], lesionId, status }) => {
      // 2026-09-02 功能说明：更新当前 Session 状态并返回快照，供面板立即刷新病灶列表。
      const lesionState = tmtvLesionService.setLesionStatus(
        segmentationIds,
        lesionId,
        status,
        true,
        getActiveLesionSessionId()
      );

      if (lesionState) {
        segmentationService.setSegmentationGroupStats(lesionState.segmentationIds, {
          tmtv: lesionState.totals.tmtv,
          tlg: lesionState.totals.tlg,
        });
      }

      return lesionState;
    },
    setTMTVLesionStatuses: ({ segmentationIds = [], lesionIds = [], status }) => {
      // 2026-09-02 功能说明：批量审核返回当前 Session 快照，避免面板等待异步重渲染。
      const lesionState = tmtvLesionService.setLesionStatuses(
        segmentationIds,
        lesionIds,
        status,
        true,
        getActiveLesionSessionId()
      );

      if (lesionState) {
        segmentationService.setSegmentationGroupStats(lesionState.segmentationIds, {
          tmtv: lesionState.totals.tmtv,
          tlg: lesionState.totals.tlg,
        });
      }

      return lesionState;
    },
    mergeTMTVLesions: ({ segmentationIds = [], lesionIds = [] }) => {
      // [2026-08-26 功能] Merge Lesions：业务层合并多个 lesion/finding，不创建新 Segment、不修改 Segment 1 voxel
      const lesionState = tmtvLesionService.mergeLesions(
        segmentationIds,
        lesionIds,
        getActiveLesionSessionId()
      );

      if (lesionState) {
        segmentationService.setSegmentationGroupStats(lesionState.segmentationIds, {
          tmtv: lesionState.totals.tmtv,
          tlg: lesionState.totals.tlg,
        });
      }
    },
    undoTMTVLesionEdit: () => {
      // [2026-08-26 功能] TMTV 专用撤销命令，避免覆盖测量/标注等全局 undo 行为
      const sessionId = getActiveLesionSessionId();
      const historyEntry = tmtvLesionService.undo(sessionId);

      if (historyEntry?.type === 'STATUS' || historyEntry?.type === 'BATCH_STATUS') {
        const lesionState = tmtvLesionService.getState(
          historyEntry.segmentationIds,
          historyEntry.sessionId
        );
        segmentationService.setSegmentationGroupStats(lesionState.segmentationIds, {
          tmtv: lesionState.totals.tmtv,
          tlg: lesionState.totals.tlg,
        });
      }
    },
    redoTMTVLesionEdit: () => {
      // [2026-08-26 功能] TMTV 专用重做命令，避免覆盖测量/标注等全局 redo 行为
      const sessionId = getActiveLesionSessionId();
      const historyEntry = tmtvLesionService.redo(sessionId);

      if (historyEntry?.type === 'STATUS' || historyEntry?.type === 'BATCH_STATUS') {
        const lesionState = tmtvLesionService.getState(
          historyEntry.segmentationIds,
          historyEntry.sessionId
        );
        segmentationService.setSegmentationGroupStats(lesionState.segmentationIds, {
          tmtv: lesionState.totals.tmtv,
          tlg: lesionState.totals.tlg,
        });
      }
    },
    exportTMTVReportCSV: async ({
      segmentations,
      tmtv,
      lesions,
      lesionTotals,
      config,
      options,
    }) => {
      const segReport = commandsManager.runCommand('getSegmentationCSVReport', {
        segmentations,
      });

      const segmentationIds = segmentations.map(segmentation => segmentation.segmentationId);
      const lesionState = tmtvLesionService.getState(segmentationIds, getActiveLesionSessionId());
      // [2026-08-25 功能] 第四阶段 CSV 导出使用 TMTVReportService 生成正式报告结构，避免报告逻辑散落在 commandsModule
      const reportLesions = lesions ?? lesionState.lesions;
      const reportLesionTotals = lesionTotals ?? lesionState.totals;

      createAndDownloadTMTVReport(
        segReport,
        createTMTVReportSections({
          segReport,
          lesions: reportLesions,
          lesionTotals: {
            ...reportLesionTotals,
            tmtv: tmtv ?? reportLesionTotals?.tmtv ?? 0,
          },
          config,
        }),
        options
      );
    },
    exportTMTVReportExcel: async ({
      segmentations,
      tmtv,
      lesions,
      lesionTotals,
      config,
      options,
    }) => {
      const segReport = commandsManager.runCommand('getSegmentationCSVReport', {
        segmentations,
      });

      const segmentationIds = segmentations.map(segmentation => segmentation.segmentationId);
      const lesionState = tmtvLesionService.getState(segmentationIds, getActiveLesionSessionId());
      const reportLesions = lesions ?? lesionState.lesions;
      const reportLesionTotals = lesionTotals ?? lesionState.totals;

      // [2026-08-26 功能] 本地 Excel 报告：复用同一份 TMTVReportService 数据，保证 Excel 与 CSV 统计口径一致
      createAndDownloadTMTVReportExcel(
        segReport,
        createTMTVReportSections({
          segReport,
          lesions: reportLesions,
          lesionTotals: {
            ...reportLesionTotals,
            tmtv: tmtv ?? reportLesionTotals?.tmtv ?? 0,
          },
          config,
        }),
        options
      );
    },
    exportTMTVReportPDF: async ({
      segmentations,
      tmtv,
      lesions,
      lesionTotals,
      config,
      options,
    }) => {
      const segReport = commandsManager.runCommand('getSegmentationCSVReport', {
        segmentations,
      });

      const segmentationIds = segmentations.map(segmentation => segmentation.segmentationId);
      const lesionState = tmtvLesionService.getState(segmentationIds, getActiveLesionSessionId());
      const reportLesions = lesions ?? lesionState.lesions;
      const reportLesionTotals = lesionTotals ?? lesionState.totals;

      // [2026-08-26 功能] 本地 PDF 报告：打开打印窗口并由浏览器另存为 PDF，不依赖服务端
      openTMTVReportPrintWindow(
        segReport,
        createTMTVReportSections({
          segReport,
          lesions: reportLesions,
          lesionTotals: {
            ...reportLesionTotals,
            tmtv: tmtv ?? reportLesionTotals?.tmtv ?? 0,
          },
          config,
        }),
        options
      );
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
      // 2026-08-31 功能说明：对比检查按各自 Volume 重置，期间隔离相机和调窗同步。
      if (resetComparisonViewports(servicesManager, metadataProvider)) return;
      const enabledElement = _getActiveViewportsEnabledElement();
      if (!enabledElement) return;

      const { viewport } = enabledElement;
      const { activeViewportId } = viewportGridService.getState();
      const viewportInfo = cornerstoneViewportService.getViewportInfo(activeViewportId);
      if (!viewportInfo) return;

      const toolGroupId = viewportInfo.getToolGroupId();
      const ptVOI = _getPTVOIRange();

      // ── PT视口重置 ──
      // 只重置相机，不调用resetProperties（避免VOI被重置为错误的默认值）
      // 手动恢复自定义SUV窗宽窗位和反色状态
      if (toolGroupId === 'ptToolGroup') {
        // 2026-09-01 功能说明：重置必须回到加载初始视野，不能恢复操作前的旧缩放。
        resetTMTVCamera(viewport);
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
        resetTMTVCamera(viewport);
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
        resetTMTVCamera(viewport);
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
        resetTMTVCamera(viewport);
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
          if (
            activeToolName &&
            activeToolName !== 'Crosshairs' &&
            activeToolName !== 'SingleSliceLine'
          ) {
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
      // 2026-08-31 功能说明：点击时同步布局，保证对比视口的自定义十字线使用当前检查组。
      tmtvCrosshairService.setStageId(stageId);
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
    clearTMTVMeasurements: { commandFn: actions.clearTMTVMeasurements },
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
    hasPersistedTMTVSegmentMask: {
      commandFn: actions.hasPersistedTMTVSegmentMask,
    },
    getTMTVSegmentMaskStorageInfo: {
      commandFn: actions.getTMTVSegmentMaskStorageInfo,
    },
    clearTMTVSegmentMaskStorage: {
      commandFn: actions.clearTMTVSegmentMaskStorage,
    },
    thresholdSegmentationByRectangleROITool: {
      commandFn: actions.thresholdSegmentationByRectangleROITool,
    },
    autoSegmentTMTVBySUVThreshold: {
      commandFn: actions.autoSegmentTMTVBySUVThreshold,
    },
    ensurePrimaryTMTVSegmentationActive: {
      commandFn: actions.ensurePrimaryTMTVSegmentationActive,
    },
    calculateTMTV: {
      commandFn: actions.calculateTMTV,
    },
    selectTMTVLesion: {
      commandFn: actions.selectTMTVLesion,
    },
    deleteTMTVLesion: {
      commandFn: actions.deleteTMTVLesion,
    },
    deleteTMTVLesions: {
      commandFn: actions.deleteTMTVLesions,
    },
    setTMTVLesionStatus: {
      commandFn: actions.setTMTVLesionStatus,
    },
    setTMTVLesionStatuses: {
      commandFn: actions.setTMTVLesionStatuses,
    },
    mergeTMTVLesions: {
      commandFn: actions.mergeTMTVLesions,
    },
    undoTMTVLesionEdit: {
      commandFn: actions.undoTMTVLesionEdit,
    },
    redoTMTVLesionEdit: {
      commandFn: actions.redoTMTVLesionEdit,
    },
    exportTMTVReportCSV: {
      commandFn: actions.exportTMTVReportCSV,
    },
    exportTMTVReportExcel: {
      commandFn: actions.exportTMTVReportExcel,
    },
    exportTMTVReportPDF: {
      commandFn: actions.exportTMTVReportPDF,
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
