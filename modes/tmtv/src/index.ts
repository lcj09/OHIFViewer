import { classes, DicomMetadataStore } from '@ohif/core';
import toolbarButtons from './toolbarButtons';
import { id } from './id.js';
import initToolGroups from './initToolGroups.js';
import setCrosshairsConfiguration from './utils/setCrosshairsConfiguration.js';
import setFusionActiveVolume from './utils/setFusionActiveVolume.js';
import i18n from 'i18next';

const { MetadataProvider } = classes;

const ohif = {
  layout: '@ohif/extension-default.layoutTemplateModule.viewerLayout',
  sopClassHandler: '@ohif/extension-default.sopClassHandlerModule.stack',
  thumbnailList: '@ohif/extension-default.panelModule.seriesList',
};

const cs3d = {
  viewport: '@ohif/extension-cornerstone.viewportModule.cornerstone',
  segPanel: '@ohif/extension-cornerstone.panelModule.panelSegmentationNoHeader',
  measurements: '@ohif/extension-cornerstone.panelModule.measurements',
};

const tmtv = {
  hangingProtocol: '@ohif/extension-tmtv.hangingProtocolModule.ptCT',
  petSUV: '@ohif/extension-tmtv.panelModule.petSUV',
  tmtv: '@ohif/extension-tmtv.panelModule.tmtv',
};

const extensionDependencies = {
  // Can derive the versions at least process.env.from npm_package_version
  '@ohif/extension-default': '^3.0.0',
  '@ohif/extension-cornerstone': '^3.0.0',
  '@ohif/extension-cornerstone-dicom-seg': '^3.0.0',
  '@ohif/extension-tmtv': '^3.0.0',
};

const unsubscriptions = [];
// Timer for delayed DicomMetadataStore.clear() on mode exit.
// In-flight image load requests (wadors/wadouri) have cancelFn=undefined and cannot
// be cancelled. They call createImage -> getImageFrame -> metaData.get('imagePixelModule'),
// which requires DicomMetadataStore to still have the metadata. Clearing immediately
// causes "Cannot read properties of undefined (reading 'samplesPerPixel')" errors.
// Delay the clear so in-flight requests can complete. Cancelled in onModeEnter.
let metadataClearTimer: ReturnType<typeof setTimeout> | null = null;
// [内存排查] 跟踪 PROTOCOL_CHANGED 回调中的 resize setTimeout。
// 原代码未跟踪此 timer，mode exit 后 200ms 内回调可能在已销毁的 service 上执行。
let resizeTimer: ReturnType<typeof setTimeout> | null = null;

function modeFactory({ modeConfiguration }) {
  return {
    // TODO: We're using this as a route segment
    // We should not be.
    id,
    routeName: 'tmtv',
    displayName: i18n.t('Modes:Total Metabolic Tumor Volume'),
    /**
     * Lifecycle hooks
     */
    //点击按钮，启动TMTV模式
    onModeEnter: ({ servicesManager, extensionManager, commandsManager }: withAppTypes) => {
      // Cancel any pending delayed metadata clear from a previous mode exit.
      // This prevents wiping the new study's metadata if the user re-enters quickly.
      if (metadataClearTimer) {
        clearTimeout(metadataClearTimer);
        metadataClearTimer = null;
      }
      // [内存排查] 取消上一次 mode exit 前可能 pending 的 resize timer
      if (resizeTimer) {
        clearTimeout(resizeTimer);
        resizeTimer = null;
      }

      const {
        toolbarService,
        toolGroupService,
        customizationService,
        hangingProtocolService,
        displaySetService,
        viewportGridService,
        cornerstoneViewportService,
      } = servicesManager.services;

      const utilityModule = extensionManager.getModuleEntry(
        '@ohif/extension-cornerstone.utilityModule.tools'
      );

      const { toolNames, Enums } = utilityModule.exports;

      // Init Default and SR ToolGroups  1初始化工作组（PT  CT FUSION MIP）
      initToolGroups(toolNames, Enums, toolGroupService, commandsManager);
//监听视口添加事件，2设置十字线配置和Fusion视口的活动体积
      const { unsubscribe } = toolGroupService.subscribe(
        toolGroupService.EVENTS.VIEWPORT_ADDED,
        () => {
          // For fusion toolGroup we need to add the volumeIds for the crosshairs
          // since in the fusion viewport we don't want both PT and CT to render MIP
          // when slabThickness is modified
          const { displaySetMatchDetails } = hangingProtocolService.getMatchDetails();
         //配置十字线工具（仅对CT体积生效）
          setCrosshairsConfiguration(
            displaySetMatchDetails,
            toolNames,
            toolGroupService,
            displaySetService
          );
           //配置融合活动体积（窗宽窗位控制CT，椭圆ROI控制PT）
          setFusionActiveVolume(
            displaySetMatchDetails,
            toolNames,
            toolGroupService,
            displaySetService
          );
        }
      );

      unsubscriptions.push(unsubscribe);

      // [2026-07-06] 监听布局切换事件，延迟resize确保视口尺寸正确更新，避免图像变形
      // [内存排查] 跟踪 resize timer，在 onModeExit 中清除，避免回调在 service 销毁后执行
      const { unsubscribe: protocolUnsubscribe } = hangingProtocolService.subscribe(
        hangingProtocolService.EVENTS.PROTOCOL_CHANGED,
        () => {
          if (resizeTimer) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => {
            cornerstoneViewportService.resize();
            resizeTimer = null;
          }, 200);
        }
      );
      unsubscriptions.push(protocolUnsubscribe);

    // 3. 注册工具栏按钮
      toolbarService.register(toolbarButtons);

      // [2026-04-29] TMTV模式主工具栏布局配置
      //
      // 工具栏section: primary (主工具栏 - 顶部水平排列)
      // 布局顺序 (从左到右):
      //   1. MeasurementTools - 测量工具下拉菜单 (长度/椭圆/多边形等)
      //   2. Zoom - 缩放工具
      //   3. Pan - 平移工具
      //   4. WindowLevel - 窗宽窗位调节工具
      //   5. Crosshairs - 十字线定位工具
      //   6. TmtvLayout - TMTV专用布局选择器 (2x1/1x2/MPR等)
      //   7. Probe - [2026-04-29 新增] 探针功能按钮 (独立显示)
      //
      // 设计说明:
      //   Probe按钮放在主工具栏而非MeasurementTools下拉菜单中，
      //   原因: 探针是高频使用功能，需要快速访问，不应隐藏在菜单里
      //
      toolbarService.updateSection(toolbarService.sections.primary, [
        'ResetTMTV',          // [2026-05-08 新增] 完全重置按钮 (最前面)
        'Rotate90',           // [2026-08-17 新增] 顺时针旋转90°
        'FlipHorizontal',     // [2026-08-18 修改] 水平翻转（原系统的Flip Horizontal功能，替代180°旋转）
        'Save',               // 保存下拉菜单（图像/序列）
        'MeasurementTools',   // 测量工具组 (下拉菜单)
        'Zoom',               // 缩放工具
        'Pan',                // 平移工具
        'WindowLevel',        // 窗宽窗位调节
        'Crosshairs',         // 十字线定位
        'SingleSliceLine',    // [2026-05-19 新增] 单切线旋转（仅影响一条参考线对应视口）
        'FusionAdjust',       // [2026-05-22 新增] 手动微调菜单（融合图像位置调整）
        'Overlay',            // [2026-07-01 新增] 覆盖层菜单（十字线/患者信息显示切换）
        'Colormap',           // [2026-07-06 新增] 伪彩色菜单（切换PT伪彩色映射）
        'SuvThreshold',       // [2026-07-08 新增] SUV阈值菜单（设置PET窗位）
        'TrackballRotate',    // [2026-05-11 新增] 3D旋转（仅MIP视口可用）
        'TmtvLayout',         // [2026-04-28] TMTV布局选择器 (2x1/1x2/MPR等)
        'SyncMenu',           // [2026-08-06 新增] 同步设置菜单（控制方位切换是否同步到其他视口）
        'Probe',              // [2026-04-29] 探针功能 (独立于测量区域)
      ]);

      toolbarService.updateSection(toolbarService.sections.viewportActionMenu.topLeft, [
        'orientationMenu'
        //'dataOverlayMenu',// [2026-07-06] TMTV模式下默认屏蔽视口叠加数据
      ]);

      toolbarService.updateSection(toolbarService.sections.viewportActionMenu.bottomMiddle, [
        'AdvancedRenderingControls',
      ]);

      toolbarService.updateSection('AdvancedRenderingControls', [
        'windowLevelMenuEmbedded',
        'voiManualControlMenu',
        'Colorbar',
        'opacityMenu',
        'thresholdMenu',
      ]);

      toolbarService.updateSection(toolbarService.sections.viewportActionMenu.topRight, [
        'modalityLoadBadge',
        'trackingStatus',
        'navigationComponent',
      ]);

      toolbarService.updateSection(toolbarService.sections.viewportActionMenu.bottomLeft, [
        'windowLevelMenu',
      ]);

      // [2026-08-17 修改] 更新MeasurementTools部分，添加矩形测量工具
      // 矩形测量（RectangleROI）已在TMTV工具组中注册，这里仅补充工具栏下拉入口
      toolbarService.updateSection('MeasurementTools', [
        'Length',
        'Bidirectional',
        'ArrowAnnotate',
        'EllipticalROI',
        'RectangleROI',  // [2026-08-17 新增] 矩形测量工具 - 用于规则矩形ROI测量
        'PlanarFreehandROI',
        'CircleROI',
        'SphereROI',     // [2026-06-26 新增] 球体测量工具 - SUV Max/Min/Mean + 面积 + 体积
        'Angle',        // [2026-05-15 新增] 角度测量工具 - 通过三点绘制角度
        'CobbAngle',    // [2026-05-15 新增] Cobb角测量工具 - 通过四点绘制Cobb角，用于脊柱侧弯测量
        'ClearMeasurements',
      ]);

      toolbarService.updateSection('ROIThresholdToolbox', ['SegmentationTools']);
      toolbarService.updateSection('SegmentationTools', [
        'RectangleROIStartEndThreshold',
        'RegionSegmentPlus',   // [2026-06-08 新增] 打点分割（一键点击分割）
        'BrushTools',
      ]);

      toolbarService.updateSection('BrushTools', ['Brush', 'Eraser', 'Threshold']);

      customizationService.setCustomizations({
        'panelSegmentation.tableMode': {
          $set: 'expanded',
        },
        'panelSegmentation.onSegmentationAdd': {
          $set: () => {
            commandsManager.run('createNewLabelmapFromPT');
          },
        },
        'tmtv.imageUpload': {
          // 从 default.js 配置文件读取上传地址，部署时只需修改配置文件
          apiUrl: (window.config?.customizationService?.['tmtv.imageUpload'] as { apiUrl?: string })?.apiUrl || 'http://localhost:8028/api/fileUpload',
        },
        // [2026-07-06] TMTV模式下屏蔽 orientationMenu 下拉框中的 Reformat 选项
        orientationMenu: {
          hideReformat: true,
        },
        // [2026-08-20 新增] TMTV模式四角标注缩小字号（16px → 12px）
        // 独立键 'viewportOverlay.fontSize'，与 OverlayMenu 使用的 'viewportOverlay'(hideAll) 互不冲突
        'viewportOverlay.fontSize': 'text-xs leading-4',
        // [2026-08-20 新增] TMTV模式右上角叠加患者信息
        // 模式级定制覆盖默认的 viewportOverlay.topRight（默认为空数组），
        // 显示：姓名、性别-年龄、登记号
        'viewportOverlay.topRight': [
          {
            id: 'TMTVPatientName',
            inheritsFrom: 'ohif.overlayItem',
            // [2026-08-20 修改] 不显示"姓名"标签，仅显示值
            title: 'Patient Name',
            condition: ({ referenceInstance }) => referenceInstance?.PatientName,
            // [2026-08-20 修复] PatientName 为 DICOM PN 类型（对象 {Alphabetic}），
            // 必须用 formatPN 转字符串，直接返回对象会导致 React 渲染报错
            contentF: ({ referenceInstance, formatters: { formatPN } }) =>
              formatPN(referenceInstance.PatientName),
          },
          {
            id: 'TMTVPatientSexAge',
            inheritsFrom: 'ohif.overlayItem',
            // [2026-08-20 修改] 不显示"性别"标签，仅显示值
            title: 'Sex Age',
            condition: ({ referenceInstance }) =>
              referenceInstance &&
              (referenceInstance.PatientSex || referenceInstance.PatientAge),
            contentF: ({ referenceInstance }) =>
              [referenceInstance.PatientSex, referenceInstance.PatientAge]
                .filter(Boolean)
                .join(' '),
          },
          {
            id: 'TMTVPatientID',
            inheritsFrom: 'ohif.overlayItem',
            // [2026-08-20 修改] 不显示"登记号"标签，仅显示值
            title: 'Patient ID',
            condition: ({ referenceInstance }) => referenceInstance?.PatientID,
            contentF: ({ referenceInstance }) => referenceInstance.PatientID,
          },
        ],
      });

      // For the hanging protocol we need to decide on the window level
      // based on whether the SUV is corrected or not, hence we can't hard
      // code the window level in the hanging protocol but we add a custom
      // attribute to the hanging protocol that will be used to get the
      // window level based on the metadata
      hangingProtocolService.addCustomAttribute(//PT voi 范围自定义属性，窗宽窗位计算
        'getPTVOIRange',
        'get PT VOI based on corrected or not',
        props => {
          const ptDisplaySet = props.find(imageSet => imageSet.Modality === 'PT');

          if (!ptDisplaySet) {
            return;
          }

          const { imageId } = ptDisplaySet.images[0];
          const imageIdScalingFactor = MetadataProvider.get('scalingModule', imageId);

          const isSUVAvailable = imageIdScalingFactor && imageIdScalingFactor.suvbw;

          if (isSUVAvailable) {
            return {
              windowWidth: 5,
              windowCenter: 2.5,
            };
          }

          return;
        }
      );
    },
    onModeExit: ({ servicesManager, extensionManager }: withAppTypes) => {
      const {
        toolGroupService,
        syncGroupService,
        segmentationService,
        cornerstoneViewportService,
        uiDialogService,
        uiModalService,
      } = servicesManager.services;

      unsubscriptions.forEach(unsubscribe => unsubscribe());
      uiDialogService.hideAll();
      uiModalService.hide();

      // CRITICAL: Manually clean up tool instances BEFORE toolGroupService.destroy().
      // OrientationMarkerTool creates ResizeObservers and event listeners that are NOT
      // cleaned up by toolGroupService.destroy() or cornerstoneTools.destroy().
      // If we don't disconnect them here, the tool instances become orphaned (toolGroups=0)
      // but stay alive via ResizeObserver callbacks and event listener closures, preventing GC.
      // This MUST run while toolGroups still exist. Access toolGroups via toolGroupService
      // (NOT direct import of @cornerstonejs/tools, which may resolve to a different module instance).
      try {
        const toolGroupIds = toolGroupService.getToolGroupIds();
        toolGroupIds.forEach(tgId => {
          const tg = toolGroupService.getToolGroup(tgId);
          if (!tg) return;
          const toolInstances = (tg as any)._toolInstances || {};
          const toolNames = Object.keys(toolInstances);
          toolNames.forEach(name => {
            const tool = toolInstances[name];
            // Disconnect all ResizeObservers (OrientationMarkerTool creates one per viewport)
            if (tool._resizeObservers && tool._resizeObservers.size > 0) {
              tool._resizeObservers.forEach((ro: any) => {
                try { ro.disconnect(); } catch {}
              });
              tool._resizeObservers.clear();
            }
            // Clean up orientation marker widgets (VTK actors/widgets)
            if (tool.orientationMarkers) {
              const markerIds = Object.keys(tool.orientationMarkers);
              markerIds.forEach(vid => {
                const om = tool.orientationMarkers[vid];
                try {
                  om?.orientationWidget?.setEnabled(false);
                  om?.orientationWidget?.delete?.();
                  om?.actor?.delete?.();
                } catch {}
              });
              tool.orientationMarkers = {};
            }
            if (tool.updatingOrientationMarker) {
              tool.updatingOrientationMarker = {};
            }
            // Call the tool's own cleanup method if available
            try { tool.cleanUpData?.(); } catch {}
          });
          // CRITICAL: Clear _toolInstances and toolOptions AFTER cleanup.
          // toolGroupService.destroy() only removes toolGroups from state.toolGroups
          // array (sets it to []); it does NOT clear _toolInstances. Without this,
          // the extension's onModeExit (which runs AFTER mode's onModeExit) tries to
          // iterate state.toolGroups to clear _toolInstances, but finds an empty array,
          // leaving tool instance references stuck in memory.
          (tg as any)._toolInstances = {};
          (tg as any).toolOptions = {};
        });
      } catch (e) {
        console.warn('[tmtv-mode] Tool instance cleanup failed', e);
      }

      toolGroupService.destroy();
      syncGroupService.destroy();
      segmentationService.destroy();
      cornerstoneViewportService.destroy();
      // [内存排查] 清除 pending 的 resize timer，避免回调在 cornerstoneViewportService 销毁后执行
      if (resizeTimer) {
        clearTimeout(resizeTimer);
        resizeTimer = null;
      }
      // Delay DicomMetadataStore.clear() to allow in-flight image load requests to complete.
      // wadors/wadouri loaders have cancelFn=undefined, so HTTP requests already sent cannot
      // be cancelled. They need metadata available when createImage calls getImageFrame.
      // 10s is enough for most in-flight requests; cancelled in onModeEnter if user re-enters.
      if (metadataClearTimer) clearTimeout(metadataClearTimer);
      metadataClearTimer = setTimeout(() => {
        try { DicomMetadataStore.clear(); } catch {}
        // Also clear the StudyMetaDataPromises cache in the DicomWebDataSource.
        // This Map caches retrieval Promises whose resolved results (DICOM tag
        // data: {Value, vr} objects, ~89,000+ per study) are retained via
        // Promise.reactions_or_result and never GC'd. Without this, switching
        // studies or exiting the viewer leaves DICOM metadata stuck in memory.
        try {
          // getActiveDataSource() returns an array of data sources
          const dataSources = extensionManager?.getActiveDataSource?.() || [];
          dataSources.forEach(ds => {
            try { ds?.clearStudyMetadataPromises?.(); } catch {}
          });
        } catch {}
        metadataClearTimer = null;
      }, 10000);
    },
    validationTags: {
      study: [],
      series: [],
    },
    isValidMode: ({ modalities, study }) => {
      const modalities_list = modalities.split('\\');
      const invalidModalities = ['SM'];

      const isValid =
        modalities_list.includes('CT') &&
        study.mrn !== 'M1' &&
        modalities_list.includes('PT') &&
        !invalidModalities.some(modality => modalities_list.includes(modality)) &&
        // This is study is a 4D study with PT and CT and not a 3D study for the tmtv
        // mode, until we have a better way to identify 4D studies we will use the
        // StudyInstanceUID to identify the study
        // Todo: when we add the 4D mode which comes with a mechanism to identify
        // 4D studies we can use that
        study.studyInstanceUid !== '1.3.6.1.4.1.12842.1.1.14.3.20220915.105557.468.2963630849';

      // there should be both CT and PT modalities and the modality should not be SM
      return {
        valid: isValid,
        description: 'The mode requires both PT and CT series in the study',
      };
    },
    routes: [
      {
        path: 'tmtv',
        /*init: ({ servicesManager, extensionManager }) => {
          //defaultViewerRouteInit
        },*/
        layoutTemplate: () => {
          return {
            id: ohif.layout,
            props: {
              leftPanels: [ohif.thumbnailList],
              leftPanelResizable: true,
              leftPanelClosed: true,
              rightPanels: [tmtv.tmtv, tmtv.petSUV],
              rightPanelResizable: true,
              // [2026-06-23 新增] 右侧面板默认折叠，用户点击后可展开
              rightPanelClosed: true,
              viewports: [
                {
                  namespace: cs3d.viewport,
                  displaySetsToDisplay: [ohif.sopClassHandler],
                },
              ],
            },
          };
        },
      },
    ],
    extensions: extensionDependencies,
    hangingProtocol: tmtv.hangingProtocol,
    sopClassHandlers: [ohif.sopClassHandler],
    ...modeConfiguration,
  };
}

const mode = {
  id,
  modeFactory,
  extensionDependencies,
};

export default mode;
