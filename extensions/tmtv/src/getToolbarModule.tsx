import RectangleROIOptions from './Panels/RectangleROIOptions';
import TmtvLayoutSelector from './Toolbar/TmtvLayoutSelector';
import FusionAdjustMenu from './Toolbar/FusionAdjustMenu';
import SaveMenu from './Toolbar/SaveMenu';
import OverlayMenu from './Toolbar/OverlayMenu';
import SyncMenu from './Toolbar/SyncMenu';
import ColormapMenu from './Toolbar/ColormapMenu';
import SuvThresholdMenu from './Toolbar/SuvThresholdMenu';
import WindowLevelMenu from './Toolbar/WindowLevelMenu';
import tmtvCrosshairService from './services/TMTVCrosshairService';
import crosshairDisplayService from './services/CrosshairDisplayService';

// 2026-04-28 - TMTV专用toolbar模块
// 注意：必须使用工厂函数模式，接收 commandsManager 和 servicesManager
export default function getToolbarModule({ commandsManager, servicesManager }) {

  return [
    {
      name: 'tmtv.RectangleROIThresholdOptions',
      defaultComponent: RectangleROIOptions,
    },
    // 2026-04-28 - TMTV专用布局选择器：仅显示融合相关布局和三维布局
    {
      name: 'ohif.tmtvLayoutSelector',
      defaultComponent: props =>
        TmtvLayoutSelector({ ...props, commandsManager, servicesManager }),
    },
    // 2026-05-22 - TMTV手动微调菜单组件
    {
      name: 'ohif.fusionAdjustMenu',
      defaultComponent: props =>
        FusionAdjustMenu({ ...props, commandsManager, servicesManager }),
    },
    {
      name: 'ohif.saveMenu',
      defaultComponent: props =>
        SaveMenu({ ...props, commandsManager, servicesManager }),
    },
    // [2026-07-01 新增] 覆盖层菜单 - 控制十字线和患者信息显示
    {
      name: 'ohif.overlayMenu',
      defaultComponent: props =>
        OverlayMenu({ ...props, commandsManager, servicesManager }),
    },
    // [2026-08-06 新增] 同步设置菜单 - 控制方位切换是否同步
    {
      name: 'ohif.syncMenu',
      defaultComponent: props =>
        SyncMenu({ ...props, servicesManager }),
    },
    // [2026-07-06 新增] 伪彩色菜单 - 切换PT volume的colormap
    {
      name: 'ohif.colormapMenu',
      defaultComponent: props =>
        ColormapMenu({ ...props, commandsManager, servicesManager }),
    },
    // [2026-07-08 新增] SUV阈值菜单 - 快速设置PET窗位(体部SUV=6/头部SUV=10)
    {
      name: 'ohif.suvThresholdMenu',
      defaultComponent: props =>
        SuvThresholdMenu({ ...props, commandsManager, servicesManager }),
    },
    // [2026-08-20 新增] 调窗下拉菜单 - 含手动调窗与CT预设
    {
      name: 'ohif.tmtvWindowLevelMenu',
      defaultComponent: props =>
        WindowLevelMenu({ ...props, commandsManager, servicesManager }),
    },
    // [2026-08-04 新增, 2026-08-04 简化] TMTV十字线按钮的 evaluate 函数
    // 统一使用 tmtvCrosshairService.getVisible() 作为唯一状态源，
    // 不再区分 TMTV/非 TMTV 布局，因为 toggleTMTVCrosshairs 命令
    // 已统一管理两套十字线系统的状态：
    //   - TMTV 布局：visible 控制 SVG overlay
    //   - 非 TMTV 布局：visible 控制 Cornerstone CrosshairsTool
    {
      name: 'evaluate.tmtvCrosshair',
      evaluate: () => {
        try {
          // [2026-08-06] 当单切线模式激活时，Crosshairs 按钮不显示激活状态（互斥）
          const isActive =
            tmtvCrosshairService.getVisible() &&
            !crosshairDisplayService.isSingleLineMode();
          return {
            disabled: false,
            isActive,
          };
        } catch (e) {
          return { disabled: false };
        }
      },
    },
    // [2026-08-06 新增] 单切线按钮的 evaluate 函数
    // 基于 CrosshairDisplayService 的状态决定按钮 isActive（蓝色背景）
    // 当 visible=true 且 mode='singleLineRotate' 时显示激活状态
    {
      name: 'evaluate.singleLine',
      evaluate: () => {
        try {
          return {
            disabled: false,
            isActive:
              crosshairDisplayService.isVisible() &&
              crosshairDisplayService.isSingleLineMode(),
          };
        } catch (e) {
          return { disabled: false };
        }
      },
    },
  ];
}
