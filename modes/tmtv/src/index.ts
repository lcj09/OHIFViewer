import { classes } from '@ohif/core';
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
      const { unsubscribe: protocolUnsubscribe } = hangingProtocolService.subscribe(
        hangingProtocolService.EVENTS.PROTOCOL_CHANGED,
        () => {
          setTimeout(() => {
            cornerstoneViewportService.resize();
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
        'TrackballRotate',    // [2026-05-11 新增] 3D旋转（仅MIP视口可用）
        'TmtvLayout',         // [2026-04-28] TMTV布局选择器 (2x1/1x2/MPR等)
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

      // [2026-05-15 修改] 更新MeasurementTools部分，添加角度和Cobb角测量工具
      toolbarService.updateSection('MeasurementTools', [
        'Length',
        'Bidirectional',
        'ArrowAnnotate',
        'EllipticalROI',
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
    onModeExit: ({ servicesManager }: withAppTypes) => {
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
      toolGroupService.destroy();
      syncGroupService.destroy();
      segmentationService.destroy();
      cornerstoneViewportService.destroy();
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
