// The following are the default window level presets and can be further
// configured via the customization service.
// [2026-08-20 修改] CT预设名称改为中文（软组织窗/肺窗/肝窗/骨窗/脑窗），
// 与 zh/Buttons.json 中的既有翻译保持一致，工具栏调窗下拉菜单和图像框
// 模态窗口预设均显示中文名称。
const defaultWindowLevelPresets = {
  CT: [
    { id: 'ct-soft-tissue', description: '软组织窗', window: '400', level: '40' },
    { id: 'ct-lung', description: '肺窗', window: '1500', level: '-600' },
    { id: 'ct-liver', description: '肝窗', window: '150', level: '90' },
    { id: 'ct-bone', description: '骨窗', window: '2500', level: '480' },
    { id: 'ct-brain', description: '脑窗', window: '80', level: '40' },
  ],

  PT: [
    { id: 'pt-default', description: 'Default', window: '5', level: '2.5' },
    { id: 'pt-suv-3', description: 'SUV', window: '0', level: '3' },
    { id: 'pt-suv-5', description: 'SUV', window: '0', level: '5' },
    { id: 'pt-suv-7', description: 'SUV', window: '0', level: '7' },
    { id: 'pt-suv-8', description: 'SUV', window: '0', level: '8' },
    { id: 'pt-suv-10', description: 'SUV', window: '0', level: '10' },
    { id: 'pt-suv-15', description: 'SUV', window: '0', level: '15' },
  ],
};

export default defaultWindowLevelPresets;
