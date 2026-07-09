import RectangleROIOptions from './Panels/RectangleROIOptions';
import TmtvLayoutSelector from './Toolbar/TmtvLayoutSelector';
import FusionAdjustMenu from './Toolbar/FusionAdjustMenu';
import SaveMenu from './Toolbar/SaveMenu';
import OverlayMenu from './Toolbar/OverlayMenu';
import ColormapMenu from './Toolbar/ColormapMenu';
import SuvThresholdMenu from './Toolbar/SuvThresholdMenu';

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
  ];
}
