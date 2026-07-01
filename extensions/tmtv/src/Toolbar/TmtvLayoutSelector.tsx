// 2026-04-29 - TMTV布局选择器组件：仅显示融合相关布局和三维布局
import React, { useCallback, useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import { CommandsManager } from '@ohif/core';
import { LayoutSelector } from '@ohif/ui-next';
import { useTranslation } from 'react-i18next';

/**
 * TMTV 模式专用布局选择器组件
 * 功能：仅显示融合相关布局按钮及三维布局按钮
 * 日期：2026-04-29
 */
function TmtvLayoutSelectorWithServices({
  commandsManager,
  servicesManager,
  ...props
}) {
  const { t } = useTranslation('ToolbarLayoutSelector');
  const [activeProtocolId, setActiveProtocolId] = useState('');
  const [activeStageId, setActiveStageId] = useState('');

  // 2026-04-29 - 获取当前活动的hanging protocol信息
  useEffect(() => {
    if (servicesManager) {
      const { hangingProtocolService } = servicesManager.services;
      if (hangingProtocolService) {
        const protocol = hangingProtocolService.getProtocol?.();
        if (protocol) {
          setActiveProtocolId(protocol.id);
          const currentStage = hangingProtocolService._getCurrentStageModel?.();
          setActiveStageId(currentStage?.id || '');
        }
      }
    }
  }, [servicesManager]);

  // 2026-05-11 - TMTV专用布局预设
  // 2x2布局（Axial/Sagittal/Coronal）：十字线不崩溃但不会画参考线
  // 2x3/2x4布局：十字线正常工作
  const tmtvPresets = [
    {
      title: '3x4',
      icon: 'layout-common-2x3',
      commandOptions: {
        protocolId: '@ohif/extension-tmtv.hangingProtocolModule.ptCT',
        stageId: 'default',
      },
      disabled: false,
      isPreset: true,
      isActive: activeProtocolId === '@ohif/extension-tmtv.hangingProtocolModule.ptCT' && activeStageId === 'default',
    },
    // [2026-05-11] 轴位 2x2: CT轴位 + PET轴位 + Fusion轴位 + MIP
    {
      title: 'Axial',
      icon: 'layout-common-2x2',
      commandOptions: {
        protocolId: '@ohif/extension-tmtv.hangingProtocolModule.ptCT',
        stageId: '2x3-layout',
      },
      disabled: false,
      isPreset: true,
      isActive: activeProtocolId === '@ohif/extension-tmtv.hangingProtocolModule.ptCT' && activeStageId === '2x3-layout',
    },
    // [2026-05-11] 矢状位 2x2: CT矢状位 + PET矢状位 + Fusion矢状位 + MIP
    {
      title: 'Sagittal',
      icon: 'layout-common-2x2',
      commandOptions: {
        protocolId: '@ohif/extension-tmtv.hangingProtocolModule.ptCT',
        stageId: '2x4-layout',
      },
      disabled: false,
      isPreset: true,
      isActive: activeProtocolId === '@ohif/extension-tmtv.hangingProtocolModule.ptCT' && activeStageId === '2x4-layout',
    },
    // [2026-05-11 新增] 冠状位 2x2: CT冠状位 + PET冠状位 + Fusion冠状位 + MIP
    {
      title: 'Coronal',
      icon: 'layout-common-2x2',
      commandOptions: {
        protocolId: '@ohif/extension-tmtv.hangingProtocolModule.ptCT',
        stageId: 'coronal-mip-layout',
      },
      disabled: false,
      isPreset: true,
      isActive: activeProtocolId === '@ohif/extension-tmtv.hangingProtocolModule.ptCT' && activeStageId === 'coronal-mip-layout',
    },
    // [2026-05-11 恢复] 原始2x3布局（CT+PT三视图，十字线正常）
    {
      title: '2x3',
      icon: 'layout-advanced-3d-four-up',
      commandOptions: {
        protocolId: '@ohif/extension-tmtv.hangingProtocolModule.ptCT',
        stageId: '2x3-original-layout',
      },
      disabled: false,
      isPreset: true,
      isActive: activeProtocolId === '@ohif/extension-tmtv.hangingProtocolModule.ptCT' && activeStageId === '2x3-original-layout',
    },
    // [2026-05-11 恢复] 原始2x4布局（PT+MIP+Fusion，十字线正常）
    {
      title: '2x4',
      icon: 'layout-common-2x3',
      commandOptions: {
        protocolId: '@ohif/extension-tmtv.hangingProtocolModule.ptCT',
        stageId: '2x4-original-layout',
      },
      disabled: false,
      isPreset: true,
      isActive: activeProtocolId === '@ohif/extension-tmtv.hangingProtocolModule.ptCT' && activeStageId === '2x4-original-layout',
    },
    // [2026-05-11 修改] TMTV专用MPR布局（Fusion三视图+十字线）
    // 使用 TMTV 专用的 tmtv-mpr-layout，所有视口加载 Fusion 图像
    // 不使用基础查看器的 'mpr' 协议（只加载单个 displaySet）
    {
      title: 'MPR',
      icon: 'layout-advanced-mpr',
      commandOptions: {
        protocolId: '@ohif/extension-tmtv.hangingProtocolModule.ptCT',
        stageId: 'tmtv-mpr-layout',
      },
      disabled: false,
      isPreset: true,
      isActive: activeProtocolId === '@ohif/extension-tmtv.hangingProtocolModule.ptCT' && activeStageId === 'tmtv-mpr-layout',
    },
    // 2026-04-29 - 三维布局：使用 only3D protocol 确保真正的3D视图
    {
      title: t('3D Volume'),
      icon: 'layout-advanced-3d-only',
      commandOptions: {
        protocolId: 'only3D',
      },
      disabled: false,
      isPreset: true,
      isActive: activeProtocolId === 'only3D',
    },
  ];

  // 2026-04-28 - 布局选择处理函数
  const handleSelectionChange = useCallback(
    (commandOptions, isPreset) => {
      console.log('TMTV Layout selection:', commandOptions, 'isPreset:', isPreset);

      if (!commandsManager) {
        console.error('CommandsManager is undefined');
        return;
      }

      try {
        if (isPreset && commandOptions.protocolId) {
          // 预设布局选择 - 切换hanging protocol阶段
          commandsManager.run('setHangingProtocol', {
            protocolId: commandOptions.protocolId,
            stageId: commandOptions.stageId,
          });
        } else {
          // 自定义布局选择 - 设置视图网格
          commandsManager.run('setViewportGridLayout', {
            numRows: commandOptions.numRows,
            numCols: commandOptions.numCols,
          });
        }
      } catch (error) {
        console.error('Error executing layout command:', error);
      }
    },
    [commandsManager]
  );

  return (
    <div id="TmtvLayout" data-cy="TmtvLayout">
      <LayoutSelector
        onSelectionChange={handleSelectionChange}
        {...props}
      >
        <LayoutSelector.Trigger tooltip={t('Change layout')} label="布局" />
        <LayoutSelector.Content>
          {/* TMTV专用布局预设区域 */}
          <div className="bg-popover flex flex-col gap-2.5 rounded-lg p-2 w-48">
            <LayoutSelector.PresetSection title={t('PET/CT Layouts')}>
              {tmtvPresets.map((preset, index) => (
                <LayoutSelector.Preset
                  key={`tmtv-preset-${index}`}
                  title={preset.title}
                  icon={preset.icon}
                  commandOptions={preset.commandOptions}
                  disabled={preset.disabled}
                  isPreset={preset.isPreset}
                  className={preset.isActive ? 'bg-accent' : ''}
                />
              ))}
            </LayoutSelector.PresetSection>
          </div>
        </LayoutSelector.Content>
      </LayoutSelector>
    </div>
  );
}

TmtvLayoutSelectorWithServices.propTypes = {
  commandsManager: PropTypes.instanceOf(CommandsManager),
  servicesManager: PropTypes.object,
};

export default TmtvLayoutSelectorWithServices;
